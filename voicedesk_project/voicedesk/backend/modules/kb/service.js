import { createHash } from "node:crypto";

import { getDefaultRagService } from "./rag.js";
import { buildQaContent, chunkText } from "./processing.js";

const SOURCE_TYPES = new Set([
  "upload",
  "url",
  "manual",
  "qa",
  "onboarding",
  "learning",
  "legacy",
]);
const JOB_TYPES = new Set(["extract_upload", "scrape_url", "embed_source"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class KnowledgeServiceError extends Error {
  constructor(message, { code = "knowledge_service_error", status = 500, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "KnowledgeServiceError";
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new KnowledgeServiceError(`${field}_required`, {
      code: `${field}_required`,
      status: 400,
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new KnowledgeServiceError(`${field}_too_long`, {
      code: `${field}_too_long`,
      status: 400,
    });
  }
  return normalized;
}

function uuid(value, field) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new KnowledgeServiceError(`${field}_invalid`, {
      code: `${field}_invalid`,
      status: 400,
    });
  }
  return value;
}

function databaseError(error, operation) {
  return new KnowledgeServiceError(`${operation}: ${error?.message || error}`, {
    code: operation,
    status: 500,
    cause: error,
  });
}

export function knowledgeContentHash(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

export function qaOriginKey(prefix, question) {
  const hash = createHash("sha256")
    .update(String(question).trim().toLocaleLowerCase("fr-CA"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${hash}`;
}

export function createKnowledgeService({ supabase, ragService } = {}) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new TypeError("supabase.from est requis");
  }
  const rag = ragService || getDefaultRagService();
  if (!rag || typeof rag.embedBatch !== "function") {
    throw new TypeError("ragService.embedBatch est requis");
  }

  async function markSourceError(sourceId, companyId, error) {
    await supabase
      .from("knowledge_sources")
      .update({
        status: "error",
        error_message: String(error?.message || error || "processing_failed").slice(0, 2000),
        processing_started_at: null,
      })
      .eq("id", sourceId)
      .eq("company_id", companyId);
  }

  async function replaceSourceContent({
    sourceId,
    companyId,
    content,
    chunkMetadata = {},
    sourceMetadata = {},
  }) {
    const normalizedSourceId = uuid(sourceId, "source_id");
    const normalizedCompanyId = uuid(companyId, "company_id");
    const normalizedContent = cleanText(content, "content", 15_000_000);
    const chunks = chunkText(normalizedContent);
    if (chunks.length === 0) {
      throw new KnowledgeServiceError("empty_knowledge_source", {
        code: "empty_knowledge_source",
        status: 422,
      });
    }
    if (chunks.length > 5_000) {
      throw new KnowledgeServiceError("too_many_knowledge_chunks", {
        code: "too_many_knowledge_chunks",
        status: 413,
      });
    }

    const startedAt = new Date().toISOString();
    const { error: processingError } = await supabase
      .from("knowledge_sources")
      .update({
        status: "processing",
        error_message: null,
        processing_started_at: startedAt,
      })
      .eq("id", normalizedSourceId)
      .eq("company_id", normalizedCompanyId);
    if (processingError) throw databaseError(processingError, "kb_source_processing_failed");

    try {
      const embeddings = await rag.embedBatch(chunks.map(chunk => chunk.content));
      if (embeddings.length !== chunks.length) {
        throw new KnowledgeServiceError("embedding_count_mismatch", {
          code: "embedding_count_mismatch",
        });
      }

      const { error: deleteError } = await supabase
        .from("knowledge_chunks")
        .delete()
        .eq("source_id", normalizedSourceId)
        .eq("company_id", normalizedCompanyId);
      if (deleteError) throw databaseError(deleteError, "kb_chunks_replace_failed");

      const rows = chunks.map((chunk, index) => ({
        company_id: normalizedCompanyId,
        source_id: normalizedSourceId,
        chunk_index: index,
        content: chunk.content,
        token_count: chunk.token_count,
        embedding: embeddings[index],
        embedding_model: rag.model || null,
        metadata: chunkMetadata,
      }));

      for (let offset = 0; offset < rows.length; offset += 100) {
        const { error: insertError } = await supabase
          .from("knowledge_chunks")
          .insert(rows.slice(offset, offset + 100));
        if (insertError) throw databaseError(insertError, "kb_chunks_insert_failed");
      }

      const readyAt = new Date().toISOString();
      const { data: source, error: sourceError } = await supabase
        .from("knowledge_sources")
        .update({
          status: "ready",
          error_message: null,
          chunks_count: rows.length,
          size_bytes: Buffer.byteLength(normalizedContent, "utf8"),
          embeddings_ready_at: readyAt,
          processing_started_at: null,
          metadata: {
            ...(sourceMetadata || {}),
            content_sha256: knowledgeContentHash(normalizedContent),
          },
        })
        .eq("id", normalizedSourceId)
        .eq("company_id", normalizedCompanyId)
        .select()
        .single();
      if (sourceError) throw databaseError(sourceError, "kb_source_ready_failed");

      return {
        source,
        chunks_count: rows.length,
        embeddings_ready_at: readyAt,
      };
    } catch (error) {
      await markSourceError(normalizedSourceId, normalizedCompanyId, error);
      throw error;
    }
  }

  async function findSourceByOrigin(companyId, originKey) {
    if (!originKey) return null;
    const { data, error } = await supabase
      .from("knowledge_sources")
      .select("*")
      .eq("company_id", companyId)
      .eq("origin_key", originKey)
      .maybeSingle();
    if (error) throw databaseError(error, "kb_origin_lookup_failed");
    return data || null;
  }

  async function createRagSource({
    companyId,
    type,
    name,
    content,
    question = null,
    answer = null,
    category = "FAQ",
    originKey = null,
    createdBy = null,
    metadata = {},
  }) {
    const normalizedCompanyId = uuid(companyId, "company_id");
    if (!SOURCE_TYPES.has(type)) {
      throw new KnowledgeServiceError("source_type_invalid", {
        code: "source_type_invalid",
        status: 400,
      });
    }
    const normalizedName = cleanText(name, "name", 200);
    const normalizedContent = cleanText(content, "content", 15_000_000);
    const normalizedOrigin = originKey
      ? cleanText(originKey, "origin_key", 300)
      : null;
    const contentHash = knowledgeContentHash(normalizedContent);

    let source = await findSourceByOrigin(normalizedCompanyId, normalizedOrigin);
    if (
      source?.status === "ready"
      && source?.metadata?.content_sha256 === contentHash
      && source?.embeddings_ready_at
    ) {
      return {
        source,
        chunks_count: source.chunks_count || 0,
        embeddings_ready_at: source.embeddings_ready_at,
        reused: true,
      };
    }

    const sourceValues = {
      company_id: normalizedCompanyId,
      type,
      name: normalizedName,
      question: question ? String(question).trim().slice(0, 20_000) : null,
      answer: answer ? String(answer).trim().slice(0, 100_000) : null,
      category: String(category || "FAQ").trim().slice(0, 100) || "FAQ",
      origin_key: normalizedOrigin,
      metadata: { ...(metadata || {}), content_sha256: contentHash },
      status: "processing",
      error_message: null,
      size_bytes: Buffer.byteLength(normalizedContent, "utf8"),
      created_by: createdBy || null,
      processing_started_at: new Date().toISOString(),
    };

    if (source) {
      const { data, error } = await supabase
        .from("knowledge_sources")
        .update(sourceValues)
        .eq("id", source.id)
        .eq("company_id", normalizedCompanyId)
        .select()
        .single();
      if (error) throw databaseError(error, "kb_source_update_failed");
      source = data;
    } else {
      const { data, error } = await supabase
        .from("knowledge_sources")
        .insert(sourceValues)
        .select()
        .single();
      if (error) throw databaseError(error, "kb_source_create_failed");
      source = data;
    }

    const result = await replaceSourceContent({
      sourceId: source.id,
      companyId: normalizedCompanyId,
      content: normalizedContent,
      chunkMetadata: metadata,
      sourceMetadata: sourceValues.metadata,
    });
    return { ...result, reused: false };
  }

  async function createQaSource({
    companyId,
    question,
    answer,
    type = "qa",
    category = "FAQ",
    originKey,
    createdBy,
    metadata,
  }) {
    const normalizedQuestion = cleanText(question, "question", 20_000);
    const normalizedAnswer = cleanText(answer, "answer", 100_000);
    return createRagSource({
      companyId,
      type,
      name: normalizedQuestion.slice(0, 200),
      content: buildQaContent(normalizedQuestion, normalizedAnswer),
      question: normalizedQuestion,
      answer: normalizedAnswer,
      category,
      originKey,
      createdBy,
      metadata: { ...(metadata || {}), kind: "qa" },
    });
  }

  async function enqueueKnowledgeJob({
    companyId,
    sourceId,
    jobType,
    idempotencyKey,
    payload = {},
  }) {
    const normalizedCompanyId = uuid(companyId, "company_id");
    const normalizedSourceId = uuid(sourceId, "source_id");
    if (!JOB_TYPES.has(jobType)) {
      throw new KnowledgeServiceError("job_type_invalid", {
        code: "job_type_invalid",
        status: 400,
      });
    }
    const normalizedKey = cleanText(idempotencyKey, "idempotency_key", 300);
    const values = {
      company_id: normalizedCompanyId,
      source_id: normalizedSourceId,
      job_type: jobType,
      idempotency_key: normalizedKey,
      payload: payload && typeof payload === "object" ? payload : {},
      status: "pending",
      next_attempt_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("knowledge_processing_jobs")
      .insert(values)
      .select()
      .single();
    if (!error) return { job: data, reused: false };
    if (error.code !== "23505") {
      throw databaseError(error, "kb_job_enqueue_failed");
    }

    const { data: existing, error: existingError } = await supabase
      .from("knowledge_processing_jobs")
      .select("*")
      .eq("company_id", normalizedCompanyId)
      .eq("idempotency_key", normalizedKey)
      .single();
    if (existingError) throw databaseError(existingError, "kb_job_lookup_failed");
    if (["completed", "failed"].includes(existing.status)) {
      const { data: restarted, error: restartError } = await supabase
        .from("knowledge_processing_jobs")
        .update({
          status: "pending",
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
          error_message: null,
          completed_at: null,
          payload: values.payload,
        })
        .eq("id", existing.id)
        .eq("company_id", normalizedCompanyId)
        .select()
        .single();
      if (restartError) throw databaseError(restartError, "kb_job_restart_failed");
      return { job: restarted, reused: true, restarted: true };
    }
    return { job: existing, reused: true, restarted: false };
  }

  return {
    createQaSource,
    createRagSource,
    enqueueKnowledgeJob,
    findSourceByOrigin,
    markSourceError,
    replaceSourceContent,
  };
}

export default createKnowledgeService;
