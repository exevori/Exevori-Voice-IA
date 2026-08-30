import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  FIREWORKS_EMBEDDINGS_URL,
  RagError,
  createRagService,
} from "./rag.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CHUNK_ID = "33333333-3333-4333-8333-333333333333";

function vector(value = 0.25) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

function response({ status = 200, body, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

test("Fireworks is the only fixed embedding endpoint and receives 1536 dimensions", async () => {
  let request;
  const service = createRagService({
    apiKey: "fw_test_key",
    maxRetries: 0,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        body: { data: [{ index: 0, embedding: vector() }] },
      });
    },
  });

  const result = await service.embedText("Quels sont vos horaires?");
  assert.equal(result.length, EMBEDDING_DIMENSIONS);
  assert.equal(request.url, FIREWORKS_EMBEDDINGS_URL);
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer fw_test_key");
  assert.deepEqual(JSON.parse(request.options.body), {
    model: DEFAULT_EMBEDDING_MODEL,
    input: ["Quels sont vos horaires?"],
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const source = await readFile(new URL("./rag.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /api\.openai\.com|OPENAI_API_KEY/i);
});

test("retryable Fireworks errors honor Retry-After before succeeding", async () => {
  const sleeps = [];
  let attempts = 0;
  const service = createRagService({
    apiKey: "fw_test_key",
    maxRetries: 1,
    sleep: async ms => sleeps.push(ms),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return response({
          status: 429,
          headers: { "retry-after": "0.01" },
          body: { error: { message: "rate limited" } },
        });
      }
      return response({ body: { data: [{ index: 0, embedding: vector() }] } });
    },
  });

  await service.embedText("question");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10]);
});

test("Fireworks timeout remains active while the response body is read", async () => {
  const service = createRagService({
    apiKey: "fw_test_key",
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    }),
  });

  await assert.rejects(
    () => service.embedText("question"),
    error => error instanceof RagError && error.code === "embedding_timeout"
  );
});

test("an excessive provider Retry-After is capped", async () => {
  const sleeps = [];
  let attempts = 0;
  const service = createRagService({
    apiKey: "fw_test_key",
    maxRetries: 1,
    sleep: async ms => sleeps.push(ms),
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? response({ status: 429, headers: { "retry-after": "3600" }, body: { error: "busy" } })
        : response({ body: { data: [{ index: 0, embedding: vector() }] } });
    },
  });

  await service.embedText("question");
  assert.deepEqual(sleeps, [30_000]);
});

test("invalid provider vectors and placeholder keys fail closed", async () => {
  const invalid = createRagService({
    apiKey: "fw_test_key",
    maxRetries: 0,
    fetchImpl: async () => response({
      body: { data: [{ index: 0, embedding: [1, 2, 3] }] },
    }),
  });
  await assert.rejects(
    () => invalid.embedText("question"),
    error => error instanceof RagError && error.code === "embedding_invalid_response"
  );

  const missingKey = createRagService({
    apiKey: "fw_xxxxxxxxxxxx",
    maxRetries: 0,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    () => missingKey.embedText("question"),
    error => error instanceof RagError && error.code === "embedding_configuration_error"
  );
});

test("semantic search delegates to the tenant-scoped SQL RPC and returns traceability", async () => {
  let rpcCall;
  const supabase = {
    from() {},
    async rpc(name, params) {
      rpcCall = { name, params };
      return {
        data: [{
          chunk_id: CHUNK_ID,
          source_id: SOURCE_ID,
          source_name: "FAQ horaires",
          source_type: "learning",
          source_question: "Quand êtes-vous ouverts?",
          source_category: "FAQ",
          chunk_index: 0,
          content: "Question : ... Réponse : ...",
          similarity: 0.91,
        }],
        error: null,
      };
    },
  };
  const service = createRagService({
    supabase,
    apiKey: "fw_test_key",
    maxRetries: 0,
    fetchImpl: async () => response({
      body: { data: [{ index: 0, embedding: vector() }] },
    }),
  });

  const matches = await service.searchSimilarChunks({
    company_id: COMPANY_ID,
    query: "horaires",
    topK: 4,
    minSimilarity: 0.5,
  });
  assert.equal(rpcCall.name, "match_kb_chunks");
  assert.equal(rpcCall.params.p_company_id, COMPANY_ID);
  assert.equal(rpcCall.params.p_query_embed.length, EMBEDDING_DIMENSIONS);
  assert.equal(rpcCall.params.p_match_count, 4);
  assert.equal(rpcCall.params.p_min_similarity, 0.5);
  assert.deepEqual(matches[0], {
    chunk_id: CHUNK_ID,
    source_id: SOURCE_ID,
    source_name: "FAQ horaires",
    source_type: "learning",
    source_question: "Quand êtes-vous ouverts?",
    source_category: "FAQ",
    chunk_index: 0,
    content: "Question : ... Réponse : ...",
    similarity: 0.91,
  });
});

test("chunk embedding updates always include source and tenant filters", async () => {
  const operations = [];
  const chunks = [
    { id: CHUNK_ID, content: "premier contenu" },
    { id: "44444444-4444-4444-8444-444444444444", content: "second contenu" },
  ];

  function awaitedQuery(result, filters = []) {
    return {
      eq(column, value) {
        filters.push([column, value]);
        return this;
      },
      order() {
        return Promise.resolve(result);
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  const supabase = {
    rpc() {},
    from(table) {
      return {
        select() {
          const filters = [];
          operations.push({ kind: "select", table, filters });
          return awaitedQuery({ data: chunks, error: null }, filters);
        },
        update(payload) {
          const filters = [];
          operations.push({ kind: "update", table, payload, filters });
          return awaitedQuery({ data: null, error: null }, filters);
        },
      };
    },
  };
  const service = createRagService({
    supabase,
    apiKey: "fw_test_key",
    maxRetries: 0,
    fetchImpl: async (_url, options) => {
      const count = JSON.parse(options.body).input.length;
      return response({
        body: {
          data: Array.from({ length: count }, (_, index) => ({
            index,
            embedding: vector(index + 0.1),
          })),
        },
      });
    },
  });

  const result = await service.embedChunksOfSource({
    source_id: SOURCE_ID,
    company_id: COMPANY_ID,
  });
  assert.equal(result.embedded_count, 2);

  const chunkUpdates = operations.filter(
    operation => operation.kind === "update" && operation.table === "knowledge_chunks"
  );
  assert.equal(chunkUpdates.length, 2);
  for (const operation of chunkUpdates) {
    assert.equal(operation.payload.embedding.length, EMBEDDING_DIMENSIONS);
    assert.equal(operation.payload.embedding_model, DEFAULT_EMBEDDING_MODEL);
    assert.ok(operation.filters.some(([column, value]) => column === "source_id" && value === SOURCE_ID));
    assert.ok(operation.filters.some(([column, value]) => column === "company_id" && value === COMPANY_ID));
  }
});
