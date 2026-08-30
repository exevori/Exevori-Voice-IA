import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routerSource = await readFile(new URL("./index.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../../index.js", import.meta.url), "utf8");

test("large documents, URLs and re-embedding return 202 through the durable queue", () => {
  for (const route of [
    'router.post("/sources/upload"',
    'router.post("/sources/scrape"',
    'router.post("/sources/:id/reembed"',
  ]) {
    const start = routerSource.indexOf(route);
    assert.ok(start > 0, `missing ${route}`);
    const nextRoute = routerSource.indexOf("\n  router.", start + route.length);
    const block = routerSource.slice(start, nextRoute > 0 ? nextRoute : undefined);
    assert.match(block, /enqueueKnowledgeJob/);
    assert.match(block, /status\(202\)/);
  }
});

test("URL ingestion validates the allowlist before persisting or queueing", () => {
  const start = routerSource.indexOf('router.post("/sources/scrape"');
  const end = routerSource.indexOf('router.post("/sources/manual"', start);
  const block = routerSource.slice(start, end);
  assert.ok(block.indexOf("validateSafeUrl") < block.indexOf('.from("knowledge_sources")'));
  assert.doesNotMatch(routerSource, /playwright|chromium|--no-sandbox/i);
});

test("every knowledge entry point is mounted with tenant ownership enforcement", () => {
  for (const mount of [
    'app.use("/api/v1/kb",             requireAuth, enforceTenantOwnership, kbRouter)',
    'app.use("/api/v1/learning",       requireAuth, enforceTenantOwnership, learningRouter)',
    'app.use("/api/v1/knowledge",      requireAuth, enforceTenantOwnership, knowledgeRouter)',
    'app.use("/api/v1/onboarding",     requireAuth, enforceTenantOwnership, onboardingRouter)',
  ]) {
    assert.ok(serverSource.includes(mount), `unprotected mount: ${mount}`);
  }
});

test("search responses expose source traceability", () => {
  assert.match(routerSource, /source_trace: results\.map/);
  assert.match(routerSource, /source_id: result\.source_id/);
  assert.match(routerSource, /source_name: result\.source_name/);
  assert.match(routerSource, /similarity: result\.similarity/);
});
