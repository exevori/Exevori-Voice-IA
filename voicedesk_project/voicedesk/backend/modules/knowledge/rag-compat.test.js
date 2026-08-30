import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.js", import.meta.url), "utf8");

test("legacy knowledge API is a RAG compatibility adapter, not a second database", () => {
  assert.doesNotMatch(source, /\.from\(["']knowledge_base["']\)/);
  assert.match(source, /\.from\("knowledge_sources"\)/);
  assert.match(source, /knowledge\.createQaSource/);
  assert.match(source, /rag\.searchSimilarChunks/);
});

test("legacy mutation routes require a tenant administrator", () => {
  assert.match(source, /requireRole\("company_admin", "super_admin"\)/);
  assert.match(source, /router\.post\("\/", REVIEW_ROLES/);
  assert.match(source, /router\.patch\("\/:id", REVIEW_ROLES/);
  assert.match(source, /router\.delete\("\/:id", REVIEW_ROLES/);
});
