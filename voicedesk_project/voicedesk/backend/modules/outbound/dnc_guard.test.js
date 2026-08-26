import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(
  new URL("./worker.js", import.meta.url),
  "utf8"
);
const migrationSource = fs.readFileSync(
  new URL("../../../migrations/012_outbound_rebuild.sql", import.meta.url),
  "utf8"
);

test("DNC lookups fail closed when Supabase cannot confirm consent", () => {
  const helperStart = source.indexOf("async function checkDNC");
  const helperEnd = source.indexOf("function normalizeTimeZone", helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.ok(helperStart > 0 && helperEnd > helperStart);
  assert.match(helper, /const \{ data, error \} = await supabase/);
  assert.match(helper, /if \(error\) return \{ blocked: true, error: error\.message \}/);
  assert.doesNotMatch(helper, /return !!data/);
  assert.ok((source.match(/Vérification DNC indisponible/g) || []).length >= 2);
});

test("le worker revalide DNC et consentement avant l'appel ElevenLabs", () => {
  const contactIndex = workerSource.indexOf('.from("contacts")');
  const dncIndex = workerSource.indexOf('.from("dnc_list")', contactIndex);
  const beginIndex = workerSource.indexOf("queue.beginAttempt", dncIndex);
  const providerIndex = workerSource.indexOf("client.initiateOutboundCall", beginIndex);

  assert.ok(contactIndex > 0);
  assert.ok(dncIndex > contactIndex);
  assert.ok(beginIndex > dncIndex);
  assert.ok(providerIndex > beginIndex);
  assert.match(workerSource, /\.eq\("company_id", job\.company_id\)/);
  assert.match(workerSource, /\.eq\("call_consent", true\)/);
  assert.match(workerSource, /\.is\("merged_into_contact_id", null\)/);
  assert.match(workerSource, /"dnc_lookup_failed"/);

  const gateStart = migrationSource.indexOf(
    "CREATE OR REPLACE FUNCTION public.begin_outbound_call_attempt"
  );
  const gateEnd = migrationSource.indexOf(
    "CREATE OR REPLACE FUNCTION public.mark_outbound_call_dispatched",
    gateStart
  );
  const gate = migrationSource.slice(gateStart, gateEnd);
  assert.match(gate, /c\.call_consent IS TRUE/);
  assert.match(gate, /FROM public\.dnc_list AS d/);
  assert.match(gate, /d\.company_id = v_queue\.company_id/);
  assert.equal(source.includes("ConversationRelay"), false);
  assert.equal(source.includes("twilioClient.calls.create"), false);
});

test("a DNC row cannot be removed while an explicit CRM refusal is active", () => {
  const routeStart = source.indexOf('router.delete("/dnc/:id"');
  const routeEnd = source.indexOf("export default router", routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart > 0 && routeEnd > routeStart);
  assert.match(route, /\.from\("contacts"\)/);
  assert.match(route, /\.eq\("company_id", lookup\.data\.company_id\)/);
  assert.match(route, /\.eq\("phone", lookup\.data\.phone\)/);
  assert.match(route, /\.eq\("call_consent", false\)/);
  assert.match(route, /\.neq\("status", "anonymized"\)/);
  assert.match(route, /\.is\("merged_into_contact_id", null\)/);
  assert.match(route, /status\(503\)/);
  assert.match(route, /status\(409\)/);
  assert.ok(route.indexOf('.from("contacts")') < route.indexOf(".delete()"));
});

test("a manual DNC upsert always preserves manual provenance", () => {
  const routeStart = source.indexOf('router.post("/dnc"');
  const routeEnd = source.indexOf('router.delete("/dnc/:id"', routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart > 0 && routeEnd > routeStart);
  assert.match(route, /source: "manual"/);
  assert.match(route, /onConflict: "company_id,phone"/);
});
