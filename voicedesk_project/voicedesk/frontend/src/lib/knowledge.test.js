import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildKnowledgeSearchPayload,
  getKnowledgeChunkNumber,
  hasKnowledgeWorkInProgress,
  normalizeKnowledgeQuestion,
} from "./knowledge.js";

test("knowledge question URLs and payloads are normalized", () => {
  assert.equal(normalizeKnowledgeQuestion("  Mes horaires ?  "), "Mes horaires ?");
  assert.deepEqual(buildKnowledgeSearchPayload({
    companyId: "company-id",
    question: "  Mes horaires ? ",
    topK: 5,
  }), {
    company_id: "company-id",
    query: "Mes horaires ?",
    topK: 5,
  });
});

test("zero-based chunks are rendered for humans and invalid indexes are hidden", () => {
  assert.equal(getKnowledgeChunkNumber(0), 1);
  assert.equal(getKnowledgeChunkNumber("4"), 5);
  assert.equal(getKnowledgeChunkNumber(-1), null);
});

test("polling remains active only while a durable job can still advance", () => {
  assert.equal(hasKnowledgeWorkInProgress([{ status: "pending" }]), true);
  assert.equal(hasKnowledgeWorkInProgress([{ status: "processing" }]), true);
  assert.equal(hasKnowledgeWorkInProgress([{ status: "ready" }, { status: "error" }]), false);
});

test("the test-question button invokes search without forwarding the React event", async () => {
  const source = await readFile(
    new URL("../components/kb/SearchWidget.jsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /onClick=\{\(\) => runSearch\(\)\}/);
  assert.doesNotMatch(source, /onClick=\{runSearch\}/);
});
