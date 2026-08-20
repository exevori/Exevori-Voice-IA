import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

test("DNC lookups fail closed when Supabase cannot confirm consent", () => {
  const helperStart = source.indexOf("async function checkDNC");
  const helperEnd = source.indexOf("async function callsMadeToday", helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.ok(helperStart > 0 && helperEnd > helperStart);
  assert.match(helper, /const \{ data, error \} = await supabase/);
  assert.match(helper, /if \(error\) return \{ blocked: true, error: error\.message \}/);
  assert.doesNotMatch(helper, /return !!data/);
  assert.equal(
    (source.match(/Vérification DNC indisponible/g) || []).length,
    3
  );
});

test("the worker revalidates DNC and explicit CRM consent immediately before Twilio", () => {
  const workerStart = source.indexOf("async function processOutboundCalls");
  const workerEnd = source.indexOf('router.post("/webhooks/twiml"', workerStart);
  const worker = source.slice(workerStart, workerEnd);
  const dncIndex = worker.indexOf("await checkDNC(company_id, contact.phone)");
  const consentIndex = worker.indexOf("await checkOutboundConsent(company_id, contact.phone)");
  const callingIndex = worker.indexOf('status: "calling"');
  const twilioIndex = worker.indexOf("twilioClient.calls.create");

  assert.ok(workerStart > 0 && workerEnd > workerStart);
  assert.ok(dncIndex > 0);
  assert.ok(consentIndex > dncIndex);
  assert.ok(callingIndex > consentIndex);
  assert.ok(twilioIndex > callingIndex);
  assert.match(worker, /status: dncCheck\.blocked && !dncCheck\.error \? "dnc" : "error"/);
  assert.match(worker, /Consentement explicite aux appels requis/);
  assert.match(worker, /\.eq\("status", "pending"\)[\s\S]*?\.select\("id"\)[\s\S]*?\.maybeSingle\(\)/);
  assert.match(worker, /if \(!claimedContact\) continue/);

  const consentStart = source.indexOf("async function checkOutboundConsent");
  const consentEnd = source.indexOf("async function callsMadeToday", consentStart);
  const consent = source.slice(consentStart, consentEnd);
  assert.match(consent, /\.eq\("company_id", company_id\)/);
  assert.match(consent, /\.eq\("phone", normalized\)/);
  assert.match(consent, /\.eq\("call_consent", true\)/);
  assert.match(consent, /\.is\("merged_into_contact_id", null\)/);
  assert.match(consent, /if \(error\) return \{ allowed: false, error: error\.message \}/);
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
