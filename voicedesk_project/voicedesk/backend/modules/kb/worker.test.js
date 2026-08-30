import assert from "node:assert/strict";
import test from "node:test";

import { createKnowledgeWorker, processKnowledgeJob } from "./worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

function sourceQuery(source, updates = []) {
  const filters = [];
  return {
    select() { return this; },
    update(payload) {
      this.payload = payload;
      return this;
    },
    eq(column, value) {
      filters.push([column, value]);
      return this;
    },
    async maybeSingle() {
      return { data: source, error: null };
    },
    then(resolve, reject) {
      updates.push({ payload: this.payload, filters });
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    },
  };
}

test("URL jobs use the bounded scraper then hand clean text to the RAG service", async () => {
  const source = {
    id: SOURCE_ID,
    company_id: COMPANY_ID,
    url: "https://docs.example.com/faq",
    metadata: { owner: "client" },
  };
  const calls = [];
  const result = await processKnowledgeJob({
    job: {
      id: JOB_ID,
      company_id: COMPANY_ID,
      source_id: SOURCE_ID,
      job_type: "scrape_url",
    },
    supabase: {
      from(table) {
        assert.equal(table, "knowledge_sources");
        return sourceQuery(source);
      },
    },
    knowledgeService: {
      async replaceSourceContent(input) {
        calls.push(input);
        return { chunks_count: 1 };
      },
    },
    ragService: { embedChunksOfSource() {} },
    safeFetcher: async url => ({
      ok: true,
      status: 200,
      async text() {
        assert.equal(url, source.url);
        return `<html><body><nav>Navigation privée</nav><main>${"Contenu utile ".repeat(12)}</main><script>bad()</script></body></html>`;
      },
    }),
  });

  assert.equal(result.chunks_count, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, COMPANY_ID);
  assert.equal(calls[0].sourceId, SOURCE_ID);
  assert.match(calls[0].content, /Contenu utile/);
  assert.doesNotMatch(calls[0].content, /Navigation privée|bad\(\)/);
  assert.equal(calls[0].chunkMetadata.ingestion_job_id, JOB_ID);
});

test("legacy embed jobs mark their source ready only after embeddings exist", async () => {
  const updates = [];
  const source = { id: SOURCE_ID, company_id: COMPANY_ID };
  const result = await processKnowledgeJob({
    job: {
      id: JOB_ID,
      company_id: COMPANY_ID,
      source_id: SOURCE_ID,
      job_type: "embed_source",
    },
    supabase: {
      from() { return sourceQuery(source, updates); },
    },
    knowledgeService: { replaceSourceContent() {} },
    ragService: {
      async embedChunksOfSource(input) {
        assert.deepEqual(input, { source_id: SOURCE_ID, company_id: COMPANY_ID });
        return { embedded_count: 2, embeddings_ready_at: "2026-08-30T00:00:00.000Z" };
      },
    },
    safeFetcher() {},
  });

  assert.equal(result.embedded_count, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.status, "ready");
  assert.ok(updates[0].filters.some(([field, value]) => field === "company_id" && value === COMPANY_ID));
});

test("worker claims atomically, completes successful jobs and exposes health", async () => {
  const calls = [];
  const job = {
    id: JOB_ID,
    company_id: COMPANY_ID,
    source_id: SOURCE_ID,
    job_type: "scrape_url",
    attempts: 1,
  };
  const source = {
    id: SOURCE_ID,
    company_id: COMPANY_ID,
    url: "https://docs.example.com",
    metadata: {},
  };
  const supabase = {
    from() { return sourceQuery(source); },
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === "claim_kb_processing_jobs") return { data: [job], error: null };
      if (name === "complete_kb_processing_job") return { data: true, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  const worker = createKnowledgeWorker({
    supabase,
    workerId: "kb-test",
    knowledgeService: { replaceSourceContent: async () => ({ chunks_count: 1 }) },
    ragService: { embedChunksOfSource() {} },
    safeFetcher: async () => ({
      ok: true,
      status: 200,
      text: async () => `<main>${"FAQ utile ".repeat(15)}</main>`,
    }),
  });

  const cycle = await worker.runOnce();
  assert.equal(cycle.claimed, 1);
  assert.deepEqual(calls.map(call => call.name), [
    "claim_kb_processing_jobs",
    "complete_kb_processing_job",
  ]);
  assert.equal(worker.status().ready, true);
  assert.equal(worker.status().processed_jobs, 1);
  assert.equal(worker.status().failed_jobs, 0);
});

test("worker failures are durably retried and source status mirrors queue state", async () => {
  const updates = [];
  const calls = [];
  const job = {
    id: JOB_ID,
    company_id: COMPANY_ID,
    source_id: SOURCE_ID,
    job_type: "scrape_url",
    attempts: 1,
  };
  const source = { id: SOURCE_ID, company_id: COMPANY_ID, url: "https://docs.example.com" };
  const supabase = {
    from() { return sourceQuery(source, updates); },
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === "claim_kb_processing_jobs") return { data: [job], error: null };
      if (name === "fail_kb_processing_job") return { data: "retry", error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  const worker = createKnowledgeWorker({
    supabase,
    workerId: "kb-test",
    logger: { warn() {}, error() {} },
    knowledgeService: { replaceSourceContent: async () => ({}) },
    ragService: { embedChunksOfSource() {} },
    safeFetcher: async () => {
      throw new Error("network down");
    },
  });

  await worker.runOnce();
  assert.ok(calls.some(call => call.name === "fail_kb_processing_job"));
  assert.equal(worker.status().failed_jobs, 1);
  assert.equal(updates.at(-1).payload.status, "pending");
  assert.match(updates.at(-1).payload.error_message, /network down/);
});
