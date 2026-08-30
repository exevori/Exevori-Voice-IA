import assert from "node:assert/strict";
import test from "node:test";

import {
  createKnowledgeService,
  knowledgeContentHash,
  qaOriginKey,
} from "./service.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";

function fakeSupabase(initial = {}) {
  const tables = new Map(
    Object.entries(initial).map(([name, rows]) => [name, structuredClone(rows)])
  );
  let sequence = 10;

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.values = null;
      this.filters = [];
      this.returning = false;
    }

    select() {
      if (this.operation !== "select") this.returning = true;
      return this;
    }

    insert(values) {
      this.operation = "insert";
      this.values = values;
      return this;
    }

    update(values) {
      this.operation = "update";
      this.values = values;
      return this;
    }

    delete() {
      this.operation = "delete";
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    matches(row) {
      return this.filters.every(([column, value]) => row[column] === value);
    }

    async execute({ maybeSingle = false, single = false } = {}) {
      const rows = tables.get(this.table) || [];
      if (this.operation === "select") {
        const found = rows.filter(row => this.matches(row));
        return {
          data: maybeSingle || single ? (found[0] || null) : found,
          error: single && found.length === 0 ? { message: "not found" } : null,
        };
      }

      if (this.operation === "insert") {
        const values = Array.isArray(this.values) ? this.values : [this.values];
        if (this.table === "knowledge_processing_jobs") {
          const duplicate = values.find(value => rows.some(row => (
            row.company_id === value.company_id
            && row.idempotency_key === value.idempotency_key
          )));
          if (duplicate) return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        const inserted = values.map(value => ({
          id: value.id || `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
          ...structuredClone(value),
        }));
        rows.push(...inserted);
        tables.set(this.table, rows);
        return {
          data: single ? inserted[0] : inserted,
          error: null,
        };
      }

      if (this.operation === "update") {
        const updated = [];
        for (const row of rows) {
          if (!this.matches(row)) continue;
          Object.assign(row, structuredClone(this.values));
          updated.push(row);
        }
        return {
          data: single ? (updated[0] || null) : this.returning ? updated : null,
          error: single && updated.length === 0 ? { message: "not found" } : null,
        };
      }

      if (this.operation === "delete") {
        const kept = rows.filter(row => !this.matches(row));
        tables.set(this.table, kept);
        return { data: null, error: null };
      }

      throw new Error(`unsupported ${this.operation}`);
    }

    maybeSingle() {
      return this.execute({ maybeSingle: true });
    }

    single() {
      return this.execute({ single: true });
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
  }

  return {
    tables,
    from(table) {
      if (!tables.has(table)) tables.set(table, []);
      return new Query(table);
    },
  };
}

test("approved Q&A becomes one ready RAG source with embedded traceable chunks", async () => {
  const supabase = fakeSupabase();
  let embedded = 0;
  const service = createKnowledgeService({
    supabase,
    ragService: {
      model: "fireworks/qwen3-embedding-8b",
      async embedBatch(texts) {
        embedded += texts.length;
        return texts.map((_, index) => [index, 0.5]);
      },
    },
  });

  const originKey = qaOriginKey("learning:suggestion-1", "Quels sont vos horaires?");
  const result = await service.createQaSource({
    companyId: COMPANY_ID,
    question: "Quels sont vos horaires?",
    answer: "Du lundi au vendredi, de 8 h à 17 h.",
    type: "learning",
    category: "hours",
    originKey,
    createdBy: PROFILE_ID,
    metadata: { suggestion_id: "suggestion-1" },
  });

  assert.equal(result.reused, false);
  assert.equal(result.source.status, "ready");
  assert.equal(result.source.company_id, COMPANY_ID);
  assert.equal(result.source.question, "Quels sont vos horaires?");
  assert.equal(result.source.answer, "Du lundi au vendredi, de 8 h à 17 h.");
  assert.equal(result.source.origin_key, originKey);
  assert.equal(result.source.metadata.suggestion_id, "suggestion-1");
  assert.equal(
    result.source.metadata.content_sha256,
    knowledgeContentHash("Question : Quels sont vos horaires?\nRéponse : Du lundi au vendredi, de 8 h à 17 h.")
  );
  assert.equal(embedded, result.chunks_count);

  const chunks = supabase.tables.get("knowledge_chunks");
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every(chunk => chunk.company_id === COMPANY_ID));
  assert.ok(chunks.every(chunk => chunk.source_id === result.source.id));
  assert.ok(chunks.every(chunk => chunk.embedding_model === "fireworks/qwen3-embedding-8b"));
});

test("same origin and content is idempotently reused without a second embedding call", async () => {
  const supabase = fakeSupabase();
  let calls = 0;
  const service = createKnowledgeService({
    supabase,
    ragService: {
      model: "model",
      async embedBatch(texts) {
        calls += 1;
        return texts.map(() => [0.1]);
      },
    },
  });
  const input = {
    companyId: COMPANY_ID,
    question: "Question stable?",
    answer: "Réponse stable.",
    type: "onboarding",
    originKey: "onboarding:faq:stable",
  };

  const first = await service.createQaSource(input);
  const second = await service.createQaSource(input);
  assert.equal(calls, 1);
  assert.equal(second.reused, true);
  assert.equal(second.source.id, first.source.id);
  assert.equal(supabase.tables.get("knowledge_sources").length, 1);
});

test("embedding failure leaves the source in an explicit error state", async () => {
  const supabase = fakeSupabase();
  const service = createKnowledgeService({
    supabase,
    ragService: {
      async embedBatch() {
        throw new Error("provider unavailable");
      },
    },
  });

  await assert.rejects(
    () => service.createQaSource({
      companyId: COMPANY_ID,
      question: "Une question?",
      answer: "Une réponse.",
      type: "qa",
    }),
    /provider unavailable/
  );
  const [source] = supabase.tables.get("knowledge_sources");
  assert.equal(source.status, "error");
  assert.match(source.error_message, /provider unavailable/);
  assert.equal((supabase.tables.get("knowledge_chunks") || []).length, 0);
});

test("queue insertion is durable and duplicate idempotency keys return the existing job", async () => {
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const supabase = fakeSupabase();
  const service = createKnowledgeService({
    supabase,
    ragService: { embedBatch: async () => [] },
  });
  const input = {
    companyId: COMPANY_ID,
    sourceId,
    jobType: "extract_upload",
    idempotencyKey: `extract:${sourceId}`,
  };

  const first = await service.enqueueKnowledgeJob(input);
  const second = await service.enqueueKnowledgeJob(input);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(supabase.tables.get("knowledge_processing_jobs").length, 1);
});

test("Q&A origin keys are deterministic but scoped by their prefix", () => {
  assert.equal(
    qaOriginKey("onboarding", "  MES HORAIRES ? "),
    qaOriginKey("onboarding", "mes horaires ?")
  );
  assert.notEqual(
    qaOriginKey("onboarding", "mes horaires ?"),
    qaOriginKey("learning", "mes horaires ?")
  );
});
