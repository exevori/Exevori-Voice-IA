import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.SUPABASE_URL ||= "https://unit-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "unit-test-service-role-key";

const { approveLearningSuggestion } = await import("./index.js");

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SUGGESTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

function approvalDatabase() {
  const updates = [];
  return {
    updates,
    from(table) {
      assert.equal(table, "learning_suggestions");
      const query = {
        payload: null,
        filters: [],
        update(payload) {
          this.payload = payload;
          return this;
        },
        eq(field, value) {
          this.filters.push([field, value]);
          return this;
        },
        select() { return this; },
        async single() {
          updates.push({ payload: this.payload, filters: this.filters });
          return { data: { id: SUGGESTION_ID, ...this.payload }, error: null };
        },
        then(resolve, reject) {
          updates.push({ payload: this.payload, filters: this.filters });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("human approval creates RAG knowledge, tests the question and stores its source trace", async () => {
  const supabase = approvalDatabase();
  const result = await approveLearningSuggestion({
    supabase,
    suggestion: {
      id: SUGGESTION_ID,
      company_id: COMPANY_ID,
      question_detected: "Quels sont vos horaires?",
      suggested_answer: "Du lundi au vendredi.",
    },
    approvedBy: "auth-user-id",
    createdBy: "profile-id",
    knowledgeService: {
      async createQaSource(input) {
        assert.equal(input.companyId, COMPANY_ID);
        assert.equal(input.type, "learning");
        assert.equal(input.originKey, `learning:${SUGGESTION_ID}`);
        return { source: { id: SOURCE_ID, name: input.question, type: "learning" } };
      },
    },
    ragService: {
      async searchSimilarChunks(input) {
        assert.equal(input.company_id, COMPANY_ID);
        return [{
          source_id: SOURCE_ID,
          source_name: "Quels sont vos horaires?",
          source_type: "learning",
          chunk_id: "chunk-id",
          similarity: 0.96,
        }];
      },
    },
  });

  assert.equal(result.rag_test.passed, true);
  assert.equal(result.rag_test.source_id, SOURCE_ID);
  const update = supabase.updates.at(-1).payload;
  assert.equal(update.status, "approved");
  assert.equal(update.rag_status, "ready");
  assert.equal(update.knowledge_source_id, SOURCE_ID);
  assert.equal(update.rag_test_source_id, SOURCE_ID);
  assert.equal(update.rag_test_similarity, 0.96);
});

test("approval stays visibly failed when the automatic RAG test cannot retrieve its source", async () => {
  const supabase = approvalDatabase();
  await assert.rejects(
    () => approveLearningSuggestion({
      supabase,
      suggestion: {
        id: SUGGESTION_ID,
        company_id: COMPANY_ID,
        question_detected: "Question?",
        suggested_answer: "Réponse.",
      },
      approvedBy: "auth-user-id",
      knowledgeService: {
        async createQaSource() {
          return { source: { id: SOURCE_ID } };
        },
      },
      ragService: {
        async searchSimilarChunks() {
          return [{ source_id: "44444444-4444-4444-8444-444444444444", similarity: 0.9 }];
        },
      },
    }),
    /learning_rag_test_did_not_find_approved_source/
  );
  const failure = supabase.updates.at(-1).payload;
  assert.equal(failure.rag_status, "error");
  assert.match(failure.rag_error, /did_not_find/);
  assert.equal(failure.status, undefined);
});

test("learning runtime no longer writes or counts the legacy knowledge_base table", async () => {
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.from\(["']knowledge_base["']\)/);
  assert.match(source, /\.from\("knowledge_sources"\)/);
  assert.match(source, /requireRole\("company_admin", "super_admin"\)/);
});
