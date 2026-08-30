import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { createRagService } from "./rag.js";
import { validateSafeUrl } from "./safeFetch.js";
import { createKnowledgeService } from "./service.js";
import { countTokens, sanitizeFilename } from "./processing.js";

dotenv.config();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_UPLOAD_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function resolveCompanyId(req, requestedCompanyId) {
  if (isSuperAdmin(req)) return requestedCompanyId || null;
  if (requestedCompanyId && requestedCompanyId !== req.user?.company_id) return false;
  return req.user?.company_id || null;
}

function requestProfileId(req) {
  return req.user?.profile?.id || null;
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function sendServiceError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({
    error: error?.code || "knowledge_error",
    message: status >= 500 ? "Traitement de la base de connaissances échoué" : error.message,
  });
}

async function respondTenantMiss({ supabase, req, res, table, id, label }) {
  if (!isSuperAdmin(req)) {
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: "tenant_lookup_failed" });
    if (data) return res.status(403).json({ error: "forbidden_cross_tenant" });
  }
  return res.status(404).json({ error: `${label}_not_found` });
}

export function createKbRouter({ supabase, ragService, knowledgeService } = {}) {
  if (!supabase?.from || !supabase?.storage) throw new TypeError("supabase incomplet");
  const rag = ragService || createRagService({ supabase });
  const knowledge = knowledgeService || createKnowledgeService({ supabase, ragService: rag });
  const router = express.Router();

  router.post("/sources/upload", upload.single("file"), async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId || !req.file) {
      return res.status(400).json({ error: "company_id_and_file_required" });
    }
    if (!ALLOWED_UPLOAD_MIMES.has(req.file.mimetype)) {
      return res.status(415).json({ error: "unsupported_file_type" });
    }

    let source;
    let storagePath;
    try {
      const { data, error } = await supabase
        .from("knowledge_sources")
        .insert({
          company_id: companyId,
          type: "upload",
          name: String(req.file.originalname || "document").slice(0, 200),
          mime_type: req.file.mimetype,
          size_bytes: req.file.size,
          status: "pending",
          created_by: requestProfileId(req),
          metadata: { original_filename: String(req.file.originalname || "document").slice(0, 255) },
        })
        .select()
        .single();
      if (error) throw error;
      source = data;

      storagePath = `${companyId}/${source.id}/${sanitizeFilename(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("kb-uploads")
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });
      if (uploadError) throw uploadError;

      const { error: sourceUpdateError } = await supabase
        .from("knowledge_sources")
        .update({ storage_path: storagePath })
        .eq("id", source.id)
        .eq("company_id", companyId);
      if (sourceUpdateError) throw sourceUpdateError;

      const queued = await knowledge.enqueueKnowledgeJob({
        companyId,
        sourceId: source.id,
        jobType: "extract_upload",
        idempotencyKey: `extract:${source.id}`,
      });

      return res.status(202).json({
        success: true,
        queued: true,
        source: { ...source, storage_path: storagePath, status: "pending" },
        job: { id: queued.job.id, status: queued.job.status },
      });
    } catch (error) {
      if (source) {
        await knowledge.markSourceError(source.id, companyId, error).catch(() => {});
      }
      if (storagePath) {
        await supabase.storage.from("kb-uploads").remove([storagePath]).catch(() => {});
      }
      return sendServiceError(res, error);
    }
  });

  router.post("/sources/scrape", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId || !req.body?.url) {
      return res.status(400).json({ error: "company_id_and_url_required" });
    }

    let safeUrl;
    try {
      safeUrl = validateSafeUrl(req.body.url);
    } catch (error) {
      return res.status(400).json({
        error: error.code || "unsafe_scrape_url",
        message: error.message,
      });
    }

    let source;
    try {
      const parsed = new URL(safeUrl);
      const { data, error } = await supabase
        .from("knowledge_sources")
        .insert({
          company_id: companyId,
          type: "url",
          name: `${parsed.hostname}${parsed.pathname}`.slice(0, 200),
          url: safeUrl,
          status: "pending",
          created_by: requestProfileId(req),
        })
        .select()
        .single();
      if (error) throw error;
      source = data;

      const queued = await knowledge.enqueueKnowledgeJob({
        companyId,
        sourceId: source.id,
        jobType: "scrape_url",
        idempotencyKey: `scrape:${source.id}`,
      });
      return res.status(202).json({
        success: true,
        queued: true,
        source,
        job: { id: queued.job.id, status: queued.job.status },
      });
    } catch (error) {
      if (source) {
        await knowledge.markSourceError(source.id, companyId, error).catch(() => {});
      }
      return sendServiceError(res, error);
    }
  });

  router.post("/sources/manual", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId || !req.body?.name || !req.body?.content) {
      return res.status(400).json({ error: "company_id_name_content_required" });
    }
    try {
      const result = await knowledge.createRagSource({
        companyId,
        type: "manual",
        name: req.body.name,
        content: req.body.content,
        createdBy: requestProfileId(req),
        metadata: { created_via: "kb_manual" },
      });
      return res.status(result.reused ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

  router.post("/sources/qa", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId || !req.body?.question || !req.body?.answer) {
      return res.status(400).json({ error: "company_id_question_answer_required" });
    }
    try {
      const result = await knowledge.createQaSource({
        companyId,
        question: req.body.question,
        answer: req.body.answer,
        category: req.body.category || "FAQ",
        type: "qa",
        createdBy: requestProfileId(req),
        metadata: { created_via: "kb_qa" },
      });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

  router.patch("/chunks/:id", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    const content = String(req.body?.content || "").trim();
    if (!companyId || content.length < 10 || content.length > 50_000) {
      return res.status(400).json({ error: "invalid_company_or_content" });
    }

    let query = supabase
      .from("knowledge_chunks")
      .select("id, company_id, source_id")
      .eq("id", req.params.id);
    if (!isSuperAdmin(req)) query = query.eq("company_id", companyId);
    const { data: chunk, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ error: "chunk_read_failed" });
    if (!chunk) {
      return respondTenantMiss({
        supabase,
        req,
        res,
        table: "knowledge_chunks",
        id: req.params.id,
        label: "chunk",
      });
    }
    if (isSuperAdmin(req) && chunk.company_id !== companyId) {
      return res.status(403).json({ error: "forbidden_cross_tenant" });
    }

    try {
      const embedding = await rag.embedText(content);
      const { data: updated, error: updateError } = await supabase
        .from("knowledge_chunks")
        .update({
          content,
          token_count: countTokens(content),
          embedding,
          embedding_model: rag.model || null,
        })
        .eq("id", chunk.id)
        .eq("source_id", chunk.source_id)
        .eq("company_id", chunk.company_id)
        .select("id, chunk_index, content, token_count")
        .single();
      if (updateError) throw updateError;
      const { error: sourceEmbeddingError } = await supabase
        .from("knowledge_sources")
        .update({ embeddings_ready_at: new Date().toISOString() })
        .eq("id", chunk.source_id)
        .eq("company_id", chunk.company_id);
      if (sourceEmbeddingError) throw sourceEmbeddingError;
      return res.json({ success: true, chunk: updated });
    } catch (embeddingError) {
      return sendServiceError(res, embeddingError);
    }
  });

  router.get("/sources", async (req, res) => {
    const companyId = resolveCompanyId(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    const limit = integer(req.query.limit, 100, 1, 200);
    const offset = integer(req.query.offset, 0, 0, 100_000);
    let query = supabase
      .from("knowledge_sources")
      .select("*", { count: "exact" })
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq("status", req.query.status);
    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: "sources_read_failed" });
    return res.json({ sources: data || [], total: count || 0 });
  });

  router.get("/sources/:id", async (req, res) => {
    const requestedCompanyId = req.query.company_id;
    const companyId = resolveCompanyId(req, requestedCompanyId);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (isSuperAdmin(req) && !companyId) {
      return res.status(400).json({ error: "company_id_required_for_super_admin" });
    }
    let query = supabase.from("knowledge_sources").select("*").eq("id", req.params.id);
    if (companyId) query = query.eq("company_id", companyId);
    const { data: source, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ error: "source_read_failed" });
    if (!source) {
      return respondTenantMiss({
        supabase,
        req,
        res,
        table: "knowledge_sources",
        id: req.params.id,
        label: "source",
      });
    }
    const { data: chunks, error: chunksError } = await supabase
      .from("knowledge_chunks")
      .select("id, chunk_index, content, token_count, metadata, embedding_model")
      .eq("source_id", source.id)
      .eq("company_id", source.company_id)
      .order("chunk_index", { ascending: true })
      .limit(100);
    if (chunksError) return res.status(500).json({ error: "chunks_read_failed" });
    return res.json({ source, chunks: chunks || [] });
  });

  router.delete("/sources/:id", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id || req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (isSuperAdmin(req) && !companyId) {
      return res.status(400).json({ error: "company_id_required_for_super_admin" });
    }
    let lookup = supabase
      .from("knowledge_sources")
      .select("id, company_id, storage_path")
      .eq("id", req.params.id);
    if (companyId) lookup = lookup.eq("company_id", companyId);
    const { data: source, error } = await lookup.maybeSingle();
    if (error) return res.status(500).json({ error: "source_read_failed" });
    if (!source) {
      return respondTenantMiss({
        supabase,
        req,
        res,
        table: "knowledge_sources",
        id: req.params.id,
        label: "source",
      });
    }
    const { error: deleteError } = await supabase
      .from("knowledge_sources")
      .delete()
      .eq("id", source.id)
      .eq("company_id", source.company_id);
    if (deleteError) return res.status(500).json({ error: "source_delete_failed" });
    if (source.storage_path) {
      await supabase.storage.from("kb-uploads").remove([source.storage_path]).catch(() => {});
    }
    return res.json({ success: true });
  });

  router.post("/sources/search", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    const query = String(req.body?.query || "").trim();
    if (!companyId || query.length < 2 || query.length > 20_000) {
      return res.status(400).json({ error: "invalid_company_or_query" });
    }
    const topK = integer(req.body.topK, 3, 1, 20);
    const minSimilarity = Number(req.body.minSimilarity ?? 0);
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      return res.status(400).json({ error: "invalid_min_similarity" });
    }
    try {
      const started = Date.now();
      const results = await rag.searchSimilarChunks({
        company_id: companyId,
        query,
        topK,
        minSimilarity,
      });
      return res.json({
        success: true,
        query,
        results,
        source_trace: results.map(result => ({
          source_id: result.source_id,
          source_name: result.source_name,
          source_type: result.source_type,
          similarity: result.similarity,
        })),
        latency_ms: Date.now() - started,
      });
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

  router.post("/sources/:id/reembed", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    const { data: source, error } = await supabase
      .from("knowledge_sources")
      .select("id, company_id, status, metadata, embeddings_ready_at")
      .eq("id", req.params.id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: "source_read_failed" });
    if (!source) {
      return respondTenantMiss({
        supabase,
        req,
        res,
        table: "knowledge_sources",
        id: req.params.id,
        label: "source",
      });
    }
    try {
      const version = source.metadata?.content_sha256 || source.embeddings_ready_at || "initial";
      const queued = await knowledge.enqueueKnowledgeJob({
        companyId,
        sourceId: source.id,
        jobType: "embed_source",
        idempotencyKey: `embed:${source.id}:${rag.model || "default"}:${version}`,
      });
      const { error: sourcePendingError } = await supabase
        .from("knowledge_sources")
        .update({ status: "pending", error_message: null })
        .eq("id", source.id)
        .eq("company_id", companyId);
      if (sourcePendingError) throw sourcePendingError;
      return res.status(202).json({
        success: true,
        queued: true,
        restarted: queued.restarted || false,
        job: { id: queued.job.id, status: queued.job.status },
      });
    } catch (queueError) {
      return sendServiceError(res, queueError);
    }
  });

  return router;
}

let defaultRouter;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const ragService = createRagService({ supabase });
  const knowledgeService = createKnowledgeService({ supabase, ragService });
  defaultRouter = createKbRouter({ supabase, ragService, knowledgeService });
} else {
  defaultRouter = express.Router();
  defaultRouter.use((_req, res) => res.status(503).json({ error: "kb_not_configured" }));
}

export default defaultRouter;
