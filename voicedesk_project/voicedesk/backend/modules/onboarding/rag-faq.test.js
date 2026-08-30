import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.js", import.meta.url), "utf8");

test("onboarding step 3 writes FAQ only through the canonical RAG service", () => {
  const stepStart = source.indexOf('router.post("/step/3"');
  const stepEnd = source.indexOf('router.post("/step/4"', stepStart);
  const step = source.slice(stepStart, stepEnd);
  assert.ok(stepStart > 0 && stepEnd > stepStart);
  assert.match(step, /onboardingKnowledge\.createQaSource/);
  assert.match(step, /type: "onboarding"/);
  assert.match(step, /qaOriginKey\("onboarding", entry\.question\)/);
  assert.doesNotMatch(step, /knowledge_base/);
});

test("onboarding FAQ completion is tenant-bound and happens only after embeddings", () => {
  const stepStart = source.indexOf('router.post("/step/3"');
  const stepEnd = source.indexOf('router.post("/step/4"', stepStart);
  const step = source.slice(stepStart, stepEnd);
  assert.match(step, /company_id !== req\.user\?\.company_id/);
  assert.match(step, /await onboardingKnowledge\.createQaSource/);
  assert.ok(
    step.indexOf("await onboardingKnowledge.createQaSource")
      < step.indexOf("await markStepComplete"),
    "step must complete only after every RAG source is ready"
  );
});
