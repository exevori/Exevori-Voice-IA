import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const importMappingSource = fs.readFileSync(
  new URL("./importMapping.js", import.meta.url),
  "utf8"
);

function routeSource(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `${startMarker} doit précéder ${endMarker}`);
  return source.slice(start, end);
}

test("l'ancien moteur téléphonique direct est entièrement absent", () => {
  for (const forbidden of [
    "ConversationRelay",
    "twilioClient.calls.create",
    "processOutboundCalls",
    "/webhooks/twiml",
    "/webhooks/call-status",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(
    fs.existsSync(new URL("../../voice/outbound.js", import.meta.url)),
    false,
    "le serveur public legacy ne doit jamais être restauré"
  );
  const compose = fs.readFileSync(
    new URL("../../../infra/docker-compose.yml", import.meta.url),
    "utf8"
  );
  const onboarding = fs.readFileSync(
    new URL("../onboarding/index.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(compose, /voice-outbound|outbound\.js/);
  assert.doesNotMatch(onboarding, /VOICE_OUTBOUND_URL|\/outbound\/call/);
});

test("launch et resume passent exclusivement par la file durable", () => {
  const launch = routeSource(
    'router.post("/campaigns/:id/launch"',
    'router.post("/campaigns/:id/pause"'
  );
  const resume = routeSource(
    'router.post("/campaigns/:id/resume"',
    "// DNC LIST — CRUD"
  );
  for (const handler of [launch, resume]) {
    assert.match(handler, /enqueueOutboundCampaign/);
    assert.match(handler, /campaignLookup|resumeLookup/);
    assert.match(handler, /companyId|resumeCompanyId/);
    assert.doesNotMatch(handler, /calls\.create|setTimeout/);
  }
});

test("les horaires sont configurables uniquement dans le tenant", () => {
  const settings = routeSource(
    'router.get("/settings"',
    "// CAMPAIGNS — CRUD"
  );
  assert.match(settings, /hasTenantMismatch/);
  assert.match(settings, /getTargetCompanyId/);
  assert.match(settings, /canonicalizeBusinessHours/);
  assert.match(settings, /invalid_business_timezone/);
  assert.match(settings, /outbound_business_hours_never_open/);
  assert.match(settings, /onConflict: "company_id"/);
});

test("une campagne avec appel actif ou ambigu ne peut pas être supprimée", () => {
  const deletion = routeSource(
    'router.delete("/campaigns/:id"',
    "// CONTACTS — Ajout manuel"
  );
  assert.match(deletion, /\.from\("outbound_call_queue"\)/);
  assert.match(deletion, /"dispatch_unknown"/);
  assert.match(deletion, /outbound_queue_unavailable/);
  assert.ok(deletion.indexOf("activeQueue") < deletion.indexOf(".delete()"));
});

test("toutes les mutations sortantes exigent un responsable d'entreprise", () => {
  const definitions = [...source.matchAll(
    /router\.(?:post|patch|delete)\(("[^"\n]+"),([^\n]*)/g
  )];
  assert.ok(definitions.length >= 12, "les routes de mutation attendues doivent etre presentes");
  for (const [, route, middleware] of definitions) {
    assert.match(
      middleware,
      /requireOutboundManager/,
      `${route} doit refuser company_user`
    );
  }
  assert.match(source, /\["super_admin", "company_admin"\]\.includes\(req\.user\?\.role\)/);
  assert.match(source, /status\(403\)\.json\(\{ error: "forbidden" \}\)/);
});

test("les imports CSV respectent les guillemets et le format xls est refusé", () => {
  assert.match(source, /parseCsv\(text,/);
  assert.match(source, /Format accepté : CSV ou Excel \.xlsx/);
  assert.doesNotMatch(source, /lines\[i\]\.split\(","\)/);
  assert.match(source, /mapImportField/);
  assert.match(importMappingSource, /candidate\.normalized === normalizedKey/);
  assert.match(importMappingSource, /\["name", "notes"\]\.includes\(normalizedKey\)/);
  assert.ok(
    importMappingSource.indexOf("candidate.normalized === normalizedKey")
      < importMappingSource.indexOf("candidate.tokens.includes(normalizedKey)")
  );
});

test("launch et resume exigent du travail actif et un worker prêt", () => {
  for (const handler of [
    routeSource('router.post("/campaigns/:id/launch"', 'router.post("/campaigns/:id/pause"'),
    routeSource('router.post("/campaigns/:id/resume"', "// DNC LIST — CRUD"),
  ]) {
    assert.match(handler, /requireReadyOutboundWorker/);
    assert.match(handler, /!queued\.hasActiveWork/);
    assert.match(handler, /active: queued\.activeTotal/);
  }
});

test("la quarantaine ambiguë ne peut être résolue que par un super administrateur", () => {
  const start = source.indexOf('"/manual-review/:queueId/resolve"');
  const end = source.indexOf('router.get("/dnc"', start);
  assert.ok(start > 0 && end > start);
  const resolution = source.slice(start, end);
  assert.match(resolution, /requireOutboundManager/);
  assert.match(resolution, /requireSuperAdmin/);
  assert.match(resolution, /company_id/);
  assert.match(resolution, /resolve_outbound_manual_review/);
  assert.match(resolution, /p_actor_user_id: req\.user\.id/);
  assert.match(resolution, /confirmed_not_dispatched/);
  assert.match(resolution, /confirmed_completed/);
  assert.match(resolution, /confirmed_failed/);
});

test("les quarantaines sont listées dans le tenant actif sans exposer de secret", () => {
  const start = source.indexOf('router.get("/manual-reviews"');
  const end = source.indexOf('router.post(\n  "/manual-review/:queueId/resolve"', start);
  assert.ok(start > 0 && end > start);
  const listing = source.slice(start, end);
  assert.match(listing, /requireSuperAdmin/);
  assert.match(listing, /\.eq\("company_id", companyId\)/);
  assert.match(listing, /\.eq\("status", "manual_review"\)/);
  assert.match(listing, /elevenlabs_conversation_id/);
  assert.match(listing, /twilio_call_sid/);
  assert.doesNotMatch(listing, /api[_-]?key|auth[_-]?token|secret/i);
});

test("la recherche d'une ressource filtre le tenant avant la lecture", () => {
  const start = source.indexOf("async function findTenantResource");
  const end = source.indexOf("function normalizePhone", start);
  const helper = source.slice(start, end);
  assert.match(helper, /\.eq\("id", id\)\s*\.eq\("company_id", tenantCompanyId\)/);
  assert.ok(helper.indexOf("tenantCompanyId") < helper.indexOf(".maybeSingle()"));
});
