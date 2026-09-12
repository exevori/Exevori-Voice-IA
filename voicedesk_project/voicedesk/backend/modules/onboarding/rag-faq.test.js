import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./service.js", import.meta.url), "utf8");

test("onboarding step 3 writes FAQ only through the canonical RAG service", () => {
  assert.match(source, /knowledge\.createQaSource/);
  assert.match(source, /type:'onboarding'/);
  assert.match(source, /qaOriginKey\('onboarding',entry\.question\)/);
  assert.doesNotMatch(source, /knowledge_base/);
});

test("onboarding FAQ completion is tenant-bound and happens only after embeddings", () => {
  assert.match(source, /companyScope\(req\.user/);
  assert.match(source, /await knowledge\.createQaSource/);
  assert.ok(
    source.indexOf("await knowledge.createQaSource")
      < source.indexOf("'finish_onboarding_knowledge'"),
    "step must complete only after every RAG source is ready"
  );
});
