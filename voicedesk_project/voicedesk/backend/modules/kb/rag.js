import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

export const FIREWORKS_EMBEDDINGS_URL =
  "https://api.fireworks.ai/inference/v1/embeddings";
export const DEFAULT_EMBEDDING_MODEL = "fireworks/qwen3-embedding-8b";
export const EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_BATCH_SIZE = 96;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_INPUTS_PER_REQUEST = 2048;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let defaultSupabase;
let defaultRagService;

export class RagError extends Error {
  constructor(message, { code = "rag_error", status = null, retryable = false, retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RagError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanSingleLine(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function providerMessage(payload, rawText) {
  return cleanSingleLine(
    payload?.error?.message
      || payload?.error
      || payload?.message
      || rawText
      || "réponse fournisseur vide"
  );
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(String(value));
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new TypeError(`${field} doit être un UUID valide`);
  }
  return value;
}

function requireText(value, field, { maxLength = 100_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} doit être une chaîne non vide`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${field} dépasse ${maxLength} caractères`);
  }
  return normalized;
}

function requireModel(value) {
  const model = requireText(value, "model", { maxLength: 255 });
  if (/[\u0000-\u001f\u007f]/.test(model)) {
    throw new TypeError("model contient des caractères invalides");
  }
  return model;
}

function requireApiKey(value) {
  const apiKey = typeof value === "string" ? value.trim() : "";
  if (
    !apiKey
    || /^placeholder/i.test(apiKey)
    || /^fw-placeholder/i.test(apiKey)
    || apiKey === "fw_xxxxxxxxxxxx"
  ) {
    throw new RagError("FIREWORKS_API_KEY manquante ou factice", {
      code: "embedding_configuration_error",
    });
  }
  return apiKey;
}

function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError("inputs doit être un tableau non vide");
  }
  if (inputs.length > MAX_INPUTS_PER_REQUEST) {
    throw new RangeError(`inputs dépasse la limite de ${MAX_INPUTS_PER_REQUEST}`);
  }
  return inputs.map((input, index) =>
    requireText(input, `inputs[${index}]`, { maxLength: 200_000 })
  );
}

function validateEmbedding(vector, index) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new RagError(
      `Fireworks a retourné un embedding invalide à l'index ${index} (dimension attendue: ${EMBEDDING_DIMENSIONS})`,
      { code: "embedding_invalid_response" }
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RagError(
        `Fireworks a retourné un embedding non numérique à l'index ${index}`,
        { code: "embedding_invalid_response" }
      );
    }
  }
  return vector;
}

function validateEmbeddingPayload(payload, expectedCount) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new RagError(
      `Fireworks a retourné ${payload?.data?.length ?? 0} embedding(s), ${expectedCount} attendu(s)`,
      { code: "embedding_invalid_response" }
    );
  }

  const ordered = new Array(expectedCount);
  for (const item of payload.data) {
    if (
      !Number.isInteger(item?.index)
      || item.index < 0
      || item.index >= expectedCount
      || ordered[item.index]
    ) {
      throw new RagError("Fireworks a retourné des index d'embedding invalides", {
        code: "embedding_invalid_response",
      });
    }
    ordered[item.index] = validateEmbedding(item.embedding, item.index);
  }

  if (ordered.some((vector) => !vector)) {
    throw new RagError("Fireworks a omis un embedding dans sa réponse", {
      code: "embedding_invalid_response",
    });
  }
  return ordered;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function defaultDatabase() {
  if (defaultSupabase) return defaultSupabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new RagError("Configuration Supabase manquante", {
      code: "rag_database_configuration_error",
    });
  }
  defaultSupabase = createClient(url, key);
  return defaultSupabase;
}

function requireDatabase(database) {
  if (!database || typeof database.from !== "function" || typeof database.rpc !== "function") {
    throw new TypeError("supabase doit exposer from() et rpc()");
  }
  return database;
}

function safeResultRow(row) {
  if (!row || typeof row !== "object") {
    throw new RagError("match_kb_chunks a retourné une ligne invalide", {
      code: "kb_search_invalid_response",
    });
  }
  const similarity = Number(row.similarity);
  if (!Number.isFinite(similarity)) {
    throw new RagError("match_kb_chunks a retourné une similarité invalide", {
      code: "kb_search_invalid_response",
    });
  }
  return {
    chunk_id: row.chunk_id,
    source_id: row.source_id,
    source_name: row.source_name ?? null,
    source_type: row.source_type ?? null,
    source_question: row.source_question ?? null,
    source_category: row.source_category ?? null,
    chunk_index: row.chunk_index,
    content: row.content,
    similarity,
  };
}

/**
 * Client RAG injectable. L'URL Fireworks est volontairement constante: aucune
 * variable d'environnement ni donnée locataire ne peut rediriger les requêtes
 * d'embedding vers une adresse interne.
 */
export function createRagService({
  supabase,
  fetchImpl = globalThis.fetch,
  apiKey = process.env.FIREWORKS_API_KEY,
  model = process.env.FIREWORKS_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  timeoutMs = positiveInteger(process.env.FIREWORKS_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  maxRetries = nonNegativeInteger(process.env.FIREWORKS_EMBEDDING_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  retryBaseDelayMs = positiveInteger(
    process.env.FIREWORKS_EMBEDDING_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_DELAY_MS
  ),
  batchSize = DEFAULT_BATCH_SIZE,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl doit être une fonction");
  if (typeof sleep !== "function") throw new TypeError("sleep doit être une fonction");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("setTimer et clearTimer doivent être des fonctions");
  }

  const configuredModel = requireModel(model);
  const configuredTimeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  const configuredMaxRetries = nonNegativeInteger(maxRetries, DEFAULT_MAX_RETRIES);
  const configuredRetryBaseDelayMs = positiveInteger(
    retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS
  );
  const configuredBatchSize = Math.min(
    positiveInteger(batchSize, DEFAULT_BATCH_SIZE),
    MAX_INPUTS_PER_REQUEST
  );
  const database = () => requireDatabase(supabase || defaultDatabase());

  async function requestEmbeddingsOnce(inputs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, configuredTimeoutMs);
    timer?.unref?.();

    let response;
    try {
      response = await fetchImpl(FIREWORKS_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireApiKey(apiKey)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: configuredModel,
          input: inputs,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      clearTimer(timer);
      if (error instanceof RagError) throw error;
      throw new RagError(
        timedOut || error?.name === "AbortError"
          ? `Délai Fireworks dépassé (${configuredTimeoutMs} ms)`
          : "Échec réseau vers Fireworks",
        {
          code: timedOut || error?.name === "AbortError"
            ? "embedding_timeout"
            : "embedding_network_error",
          retryable: true,
          cause: error,
        }
      );
    }

    let rawText;
    try {
      rawText = await response.text();
    } catch (error) {
      const responseTimedOut = timedOut || error?.name === "AbortError";
      throw new RagError(responseTimedOut
        ? `Délai Fireworks dépassé (${configuredTimeoutMs} ms)`
        : "Impossible de lire la réponse Fireworks", {
        code: responseTimedOut ? "embedding_timeout" : "embedding_response_read_error",
        status: response.status || null,
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimer(timer);
    }

    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        if (response.ok) {
          throw new RagError("Fireworks a retourné un JSON invalide", {
            code: "embedding_invalid_response",
            status: response.status || null,
          });
        }
      }
    }

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      throw new RagError(
        `Fireworks HTTP ${response.status}: ${providerMessage(payload, rawText)}`,
        {
          code: "embedding_provider_error",
          status: response.status,
          retryable,
          retryAfterMs: retryable
            ? parseRetryAfter(response.headers?.get?.("retry-after"), now())
            : null,
        }
      );
    }

    return validateEmbeddingPayload(payload, inputs.length);
  }

  async function embedRaw(rawInputs) {
    const inputs = validateInputs(rawInputs);
    let lastError;

    for (let attempt = 0; attempt <= configuredMaxRetries; attempt += 1) {
      try {
        return await requestEmbeddingsOnce(inputs);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RagError) || !error.retryable || attempt >= configuredMaxRetries) {
          throw error;
        }
        const exponentialDelay = configuredRetryBaseDelayMs * (2 ** attempt);
        await sleep(Math.min(error.retryAfterMs ?? exponentialDelay, 30_000));
      }
    }

    throw lastError || new RagError("Génération d'embeddings échouée");
  }

  async function embedText(text) {
    const [embedding] = await embedRaw([requireText(text, "text", { maxLength: 200_000 })]);
    return embedding;
  }

  async function embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const normalized = texts.map((text, index) =>
      requireText(text, `texts[${index}]`, { maxLength: 200_000 })
    );
    const embeddings = [];
    for (let index = 0; index < normalized.length; index += configuredBatchSize) {
      embeddings.push(...await embedRaw(normalized.slice(index, index + configuredBatchSize)));
    }
    return embeddings;
  }

  async function searchSimilarChunks({
    company_id,
    query,
    topK = 3,
    minSimilarity = 0,
  } = {}) {
    const companyId = requireUuid(company_id, "company_id");
    const normalizedQuery = requireText(query, "query", { maxLength: 20_000 });
    if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
      throw new RangeError("topK doit être un entier entre 1 et 50");
    }
    if (
      typeof minSimilarity !== "number"
      || !Number.isFinite(minSimilarity)
      || minSimilarity < 0
      || minSimilarity > 1
    ) {
      throw new RangeError("minSimilarity doit être compris entre 0 et 1");
    }

    const queryEmbedding = await embedText(normalizedQuery);
    const { data, error } = await database().rpc("match_kb_chunks", {
      p_company_id: companyId,
      p_query_embed: queryEmbedding,
      p_match_count: topK,
      p_min_similarity: minSimilarity,
    });
    if (error) {
      throw new RagError(`match_kb_chunks: ${cleanSingleLine(error.message || error)}`, {
        code: "kb_search_failed",
      });
    }
    if (data === null || data === undefined) return [];
    if (!Array.isArray(data)) {
      throw new RagError("match_kb_chunks a retourné une réponse invalide", {
        code: "kb_search_invalid_response",
      });
    }
    return data.map(safeResultRow);
  }

  async function embedChunksOfSource({ source_id, company_id } = {}) {
    const sourceId = requireUuid(source_id, "source_id");
    const companyId = requireUuid(company_id, "company_id");
    const db = database();

    const { data: chunks, error: chunksError } = await db
      .from("knowledge_chunks")
      .select("id, content")
      .eq("source_id", sourceId)
      .eq("company_id", companyId)
      .order("chunk_index", { ascending: true });
    if (chunksError) {
      throw new RagError(`Chargement des chunks: ${cleanSingleLine(chunksError.message)}`, {
        code: "kb_chunks_read_failed",
      });
    }
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { embedded_count: 0, total_chunks: 0, embeddings_ready_at: null };
    }

    const vectors = await embedBatch(chunks.map((chunk, index) =>
      requireText(chunk?.content, `chunk[${index}].content`, { maxLength: 200_000 })
    ));
    if (vectors.length !== chunks.length) {
      throw new RagError("Le nombre d'embeddings ne correspond pas au nombre de chunks", {
        code: "embedding_count_mismatch",
      });
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const { error } = await db
        .from("knowledge_chunks")
        .update({
          embedding: vectors[index],
          embedding_model: configuredModel,
        })
        .eq("id", chunks[index].id)
        .eq("source_id", sourceId)
        .eq("company_id", companyId);
      if (error) {
        throw new RagError(
          `Mise à jour du chunk ${chunks[index].id}: ${cleanSingleLine(error.message)}`,
          { code: "kb_chunk_embedding_update_failed" }
        );
      }
    }

    const embeddingsReadyAt = new Date().toISOString();
    const { error: sourceError } = await db
      .from("knowledge_sources")
      .update({ embeddings_ready_at: embeddingsReadyAt })
      .eq("id", sourceId)
      .eq("company_id", companyId);
    if (sourceError) {
      throw new RagError(
        `Mise à jour de la source: ${cleanSingleLine(sourceError.message)}`,
        { code: "kb_source_embedding_update_failed" }
      );
    }

    return {
      embedded_count: chunks.length,
      total_chunks: chunks.length,
      embeddings_ready_at: embeddingsReadyAt,
    };
  }

  return {
    model: configuredModel,
    dimensions: EMBEDDING_DIMENSIONS,
    embedRaw,
    embedText,
    embedBatch,
    searchSimilarChunks,
    embedChunksOfSource,
  };
}

export function getDefaultRagService() {
  if (!defaultRagService) defaultRagService = createRagService();
  return defaultRagService;
}

// Exports historiques conservés pour les routeurs existants.
export function embedText(text) {
  return getDefaultRagService().embedText(text);
}

export function embedBatch(texts) {
  return getDefaultRagService().embedBatch(texts);
}

export function searchSimilarChunks(options) {
  return getDefaultRagService().searchSimilarChunks(options);
}

export function embedChunksOfSource(options) {
  return getDefaultRagService().embedChunksOfSource(options);
}

export default createRagService;
