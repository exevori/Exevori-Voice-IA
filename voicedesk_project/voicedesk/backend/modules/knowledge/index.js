// Compatibility API for historical /api/v1/knowledge consumers.
// Since migration 014 every operation targets the canonical RAG tables.

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import { requireRole } from "../../middleware/auth.js";
import { buildQaContent } from "../kb/processing.js";
import { createRagService } from "../kb/rag.js";
import { createKnowledgeService } from "../kb/service.js";

dotenv.config();

const REVIEW_ROLES = requireRole("company_admin", "super_admin");

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function companyFor(req, requested) {
  if (isSuperAdmin(req)) return requested || null;
  if (requested && requested !== req.user?.company_id) return false;
  return req.user?.company_id || null;
}

function legacyEntry(source) {
  return {
    id: source.id,
    knowledge_source_id: source.id,
    company_id: source.company_id,
    question: source.question,
    answer: source.answer,
    category: source.category || "FAQ",
    status: source.status === "ready" ? "active" : source.status,
    source: source.type,
    created_at: source.created_at,
    updated_at: source.updated_at,
    embeddings_ready_at: source.embeddings_ready_at,
  };
}

export function createKnowledgeCompatibilityRouter({
  supabase,
  ragService,
  knowledgeService,
} = {}) {
  const rag = ragService || createRagService({ supabase });
  const knowledge = knowledgeService || createKnowledgeService({ supabase, ragService: rag });
  const router = express.Router();

  async function missingEntry(req, res) {
    if (!isSuperAdmin(req)) {
      const { data, error } = await supabase
        .from("knowledge_sources")
        .select("id")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) return res.status(500).json({ error: "knowledge_lookup_failed" });
      if (data) return res.status(403).json({ error: "forbidden_cross_tenant" });
    }
    return res.status(404).json({ error: "knowledge_not_found" });
  }

  router.get("/search/semantic", async (req, res) => {
    const companyId = companyFor(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    const query = String(req.query.query || "").trim();
    if (!companyId || !query) return res.status(400).json({ error: "company_id_and_query_required" });
    try {
      const results = await rag.searchSimilarChunks({
        company_id: companyId,
        query,
        topK: Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 5, 20)),
        minSimilarity: 0,
      });
      return res.json({
        query,
        matches: results.map(result => ({
          id: result.source_id,
          knowledge_source_id: result.source_id,
          question: result.source_question,
          answer: result.content,
          category: result.source_category || "FAQ",
          similarity: result.similarity,
          source_name: result.source_name,
          source_type: result.source_type,
        })),
        source_trace: results,
      });
    } catch (error) {
      return res.status(500).json({ error: error.code || "knowledge_search_failed" });
    }
  });

  router.get("/stats/overview", async (req, res) => {
    const companyId = companyFor(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    const { data, error } = await supabase
      .from("knowledge_sources")
      .select("category, type, status")
      .eq("company_id", companyId)
      .not("question", "is", null);
    if (error) return res.status(500).json({ error: "knowledge_stats_failed" });
    const stats = {
      total_active: 0,
      total_error: 0,
      by_category: {},
      by_source: {},
    };
    for (const row of data || []) {
      if (row.status === "ready") stats.total_active += 1;
      if (row.status === "error") stats.total_error += 1;
      stats.by_category[row.category || "FAQ"] = (stats.by_category[row.category || "FAQ"] || 0) + 1;
      stats.by_source[row.type] = (stats.by_source[row.type] || 0) + 1;
    }
    return res.json(stats);
  });

  router.post("/bulk-import", REVIEW_ROLES, async (req, res) => {
    const companyId = companyFor(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId || !Array.isArray(req.body?.entries)) {
      return res.status(400).json({ error: "company_id_and_entries_required" });
    }
    const imported = [];
    try {
      for (const entry of req.body.entries.filter(item => item?.question && item?.answer)) {
        const result = await knowledge.createQaSource({
          companyId,
          type: "manual",
          question: entry.question,
          answer: entry.answer,
          category: entry.category || "FAQ",
          createdBy: req.user?.profile?.id || null,
          metadata: { created_via: "legacy_bulk_import" },
        });
        imported.push(legacyEntry(result.source));
      }
      return res.status(201).json({ success: true, imported: imported.length, entries: imported });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.code || "knowledge_import_failed" });
    }
  });

  router.get("/", async (req, res) => {
    const companyId = companyFor(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    let query = supabase
      .from("knowledge_sources")
      .select("*", { count: "exact" })
      .eq("company_id", companyId)
      .not("question", "is", null);
    if (req.query.category) query = query.eq("category", req.query.category);
    if (req.query.status && req.query.status !== "all") {
      query = query.eq("status", req.query.status === "active" ? "ready" : req.query.status);
    }
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 200));
    const { data, error, count } = await query
      .order("category")
      .order("question")
      .limit(limit);
    if (error) return res.status(500).json({ error: "knowledge_read_failed" });
    const entries = (data || []).map(legacyEntry);
    const grouped = Object.groupBy
      ? Object.groupBy(entries, entry => entry.category || "Autres")
      : entries.reduce((acc, entry) => {
          (acc[entry.category || "Autres"] ||= []).push(entry);
          return acc;
        }, {});
    return res.json({ entries, grouped, total: count || entries.length });
  });

  router.post("/", REVIEW_ROLES, async (req, res) => {
    const companyId = companyFor(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    try {
      const result = await knowledge.createQaSource({
        companyId,
        type: "manual",
        question: req.body?.question,
        answer: req.body?.answer,
        category: req.body?.category || "FAQ",
        createdBy: req.user?.profile?.id || null,
        metadata: { created_via: "legacy_knowledge_api" },
      });
      return res.status(201).json({ success: true, entry: legacyEntry(result.source) });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.code || "knowledge_create_failed" });
    }
  });

  router.get("/:id", async (req, res) => {
    const companyId = companyFor(req, req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    let query = supabase.from("knowledge_sources").select("*").eq("id", req.params.id);
    if (!isSuperAdmin(req)) query = query.eq("company_id", companyId);
    else if (companyId) query = query.eq("company_id", companyId);
    const { data, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ error: "knowledge_read_failed" });
    if (!data) return missingEntry(req, res);
    return res.json({ entry: legacyEntry(data) });
  });

  router.patch("/:id", REVIEW_ROLES, async (req, res) => {
    const companyId = companyFor(req, req.body?.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    let query = supabase.from("knowledge_sources").select("*").eq("id", req.params.id);
    if (companyId) query = query.eq("company_id", companyId);
    const { data: source, error } = await query.maybeSingle();
    if (error) return res.status(500).json({ error: "knowledge_read_failed" });
    if (!source) return missingEntry(req, res);
    const question = String(req.body?.question ?? source.question ?? "").trim();
    const answer = String(req.body?.answer ?? source.answer ?? "").trim();
    if (!question || !answer) return res.status(400).json({ error: "question_and_answer_required" });
    try {
      const { error: sourceError } = await supabase
        .from("knowledge_sources")
        .update({
          question,
          answer,
          category: req.body?.category || source.category || "FAQ",
          name: question.slice(0, 200),
          type: source.type === "legacy" ? "manual" : source.type,
        })
        .eq("id", source.id)
        .eq("company_id", source.company_id);
      if (sourceError) throw sourceError;
      const result = await knowledge.replaceSourceContent({
        sourceId: source.id,
        companyId: source.company_id,
        content: buildQaContent(question, answer),
        sourceMetadata: source.metadata || {},
        chunkMetadata: { kind: "qa", updated_via: "legacy_knowledge_api" },
      });
      return res.json({ success: true, entry: legacyEntry({
        ...result.source,
        question,
        answer,
        category: req.body?.category || source.category || "FAQ",
      }) });
    } catch (updateError) {
      return res.status(500).json({ error: updateError.code || "knowledge_update_failed" });
    }
  });

  router.delete("/:id", REVIEW_ROLES, async (req, res) => {
    const companyId = companyFor(req, req.body?.company_id || req.query.company_id);
    if (companyId === false) return res.status(403).json({ error: "forbidden_cross_tenant" });
    let lookup = supabase.from("knowledge_sources").select("id, company_id").eq("id", req.params.id);
    if (companyId) lookup = lookup.eq("company_id", companyId);
    const { data: source, error: lookupError } = await lookup.maybeSingle();
    if (lookupError) return res.status(500).json({ error: "knowledge_read_failed" });
    if (!source) return missingEntry(req, res);
    const { error } = await supabase
      .from("knowledge_sources")
      .delete()
      .eq("id", source.id)
      .eq("company_id", source.company_id);
    if (error) return res.status(500).json({ error: "knowledge_delete_failed" });
    return res.json({ success: true });
  });

  return router;
}

let router;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const ragService = createRagService({ supabase });
  const knowledgeService = createKnowledgeService({ supabase, ragService });
  router = createKnowledgeCompatibilityRouter({ supabase, ragService, knowledgeService });
} else {
  router = express.Router();
  router.use((_req, res) => res.status(503).json({ error: "knowledge_not_configured" }));
}

export default router;
