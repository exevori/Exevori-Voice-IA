import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL("../../../migrations/014_kb_learning_unification.sql", import.meta.url),
  "utf8"
);

test("migration 014 is transactional and preserves the legacy table", () => {
  assert.match(sql, /^--[\s\S]*?\nBEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /DROP TABLE\s+(?:IF EXISTS\s+)?public\.knowledge_base/i);
  assert.match(sql, /'legacy:' \|\| legacy\.id::text/);
  assert.match(sql, /ON CONFLICT \(company_id, origin_key\)/);
});

test("RAG sources cover onboarding, learning and historical knowledge", () => {
  for (const sourceType of ["qa", "onboarding", "learning", "legacy"]) {
    assert.ok(sql.includes(`'${sourceType}'`), `missing source type ${sourceType}`);
  }
  for (const column of [
    "question text",
    "answer text",
    "origin_key text",
    "metadata jsonb",
    "embedding_model text",
  ]) {
    assert.ok(sql.includes(column), `missing RAG column ${column}`);
  }
  assert.match(sql, /knowledge_chunks_source_company_fk/);
  assert.match(sql, /FOREIGN KEY \(source_id, company_id\)/);
});

test("large-source processing uses a private durable leased queue", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.knowledge_processing_jobs/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_kb_processing_jobs/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.complete_kb_processing_job/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fail_kb_processing_job/);
  assert.match(sql, /payload = '\{\}'::jsonb/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(
    sql,
    /REVOKE ALL ON TABLE public\.knowledge_processing_jobs FROM PUBLIC, anon, authenticated/
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.knowledge_processing_jobs TO service_role/
  );
});

test("vector search is tenant-scoped and callable only by service_role", () => {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.match_kb_chunks");
  const end = sql.indexOf("-- --------------------------------------------------------------------------\n-- 4.", start);
  const fn = sql.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(fn, /p_company_id uuid/);
  assert.match(fn, /p_query_embed vector\(1536\)/);
  assert.match(fn, /chunk\.company_id = p_company_id/);
  assert.match(fn, /source\.status = 'ready'/);
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SET search_path = ''/);
  assert.match(fn, /FROM PUBLIC, anon, authenticated/);
  assert.match(fn, /TO service_role/);
});

test("approved suggestions can trace their RAG source and automatic test", () => {
  for (const column of [
    "knowledge_source_id",
    "rag_status",
    "rag_test_source_id",
    "rag_test_similarity",
    "rag_error",
  ]) {
    assert.ok(sql.includes(column), `missing learning trace column ${column}`);
  }
});
