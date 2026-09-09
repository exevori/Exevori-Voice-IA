import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createProvisioningHealthService } from "./provisioningHealth.js";
import { createAdminCompanyRouter } from "./companies.js";
import { createProvisioningStore } from "./provisioningStore.js";
import { createClient } from "@supabase/supabase-js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const ACTOR = { id: "33333333-3333-4333-8333-333333333333", requestId: "44444444-4444-4444-8444-444444444444" };
const ACCOUNT = `AC${"a".repeat(32)}`;
const SID = `PN${"b".repeat(32)}`;
const NUMBER = "+14185550101";
const NOW = new Date("2026-09-09T20:00:00Z");

function fixture() {
  const state = {
    snapshot: {
      company: { id: COMPANY, status: "active" },
      phones: [{ id: "phone-row", company_id: COMPANY, phone_number: NUMBER, status: "active", twilio_phone_sid: SID,
        elevenlabs_agent_id: "agent_alpha", elevenlabs_phone_number_id: "phone_alpha", updated_at: NOW.toISOString() }],
      assistant: { company_id: COMPANY, twilio_number: NUMBER, elevenlabs_agent_id: "agent_alpha" },
      twilio: { company_id: COMPANY, phone_number: NUMBER, phone_number_sid: SID, account_sid: ACCOUNT, status: "active" },
      onboarding: { provisioning_status: "done" },
    },
    twilio: { state: "ok", data: { sid: SID, account_sid: ACCOUNT, phone_number: NUMBER, status: "in-use", voice: true } },
    agent: { state: "ok", data: { agent_id: "agent_alpha" } },
    phone: { state: "ok", data: { provider: "twilio", phone_number_id: "phone_alpha", phone_number: NUMBER, assigned_agent: { agent_id: "agent_alpha" } } },
    events: [], conflict: false, reads: 0, assigned: 0, fills: 0,
  };
  const store = {
    async read(id) { assert.equal(id, COMPANY); state.reads++; state.beforeRead?.(state.reads); return structuredClone(state.snapshot); },
    async hasOtherOwner(id) { assert.equal(id, COMPANY); return state.conflict; },
    async audit(_id, actor, action, details) { assert.deepEqual(actor, ACTOR); state.events.push({ action, details }); if (state.auditFailure) throw new Error("audit unavailable"); },
    async acquire() { state.events.push({ action: "acquire" }); if (state.busy) throw Object.assign(new Error(), { code: "provisioning_in_progress", status: 409 }); return "token1"; },
    async renew(_id, token) { state.events.push({ action: "renew" }); if (state.lockLost) throw Object.assign(new Error(), { code: "provisioning_lock_lost", status: 409 }); return token; },
    async finish(_id, _token, success) { state.events.push({ action: "finish", success }); },
    async fillAssistant(_id, _before, phone) { state.fills++; state.snapshot.assistant.twilio_number = phone.phone_number; state.snapshot.assistant.elevenlabs_agent_id = phone.elevenlabs_agent_id; },
  };
  const providers = {
    masterAccount: ACCOUNT,
    async twilioNumber() { return structuredClone(state.twilio); },
    async agent() { return structuredClone(state.agent); },
    async phone() { state.beforePhone?.(); return structuredClone(state.phone); },
    async assignPhone(id, agentId) { assert.equal(id, "phone_alpha"); assert.equal(agentId, "agent_alpha"); state.assigned++;
      if (state.assignFailure) return { state: "timeout" };
      if (!state.unconfirmed) state.phone.data.assigned_agent = { agent_id: agentId };
      return { state: "ok" }; },
  };
  const service = createProvisioningHealthService({ store, providers, now: () => NOW,
    authorizeRepair: async id => { assert.equal(id, COMPANY); state.events.push({ action: "authorize" }); if (state.paymentFailure) throw Object.assign(new Error(), { code: "subscription_inactive" }); } });
  return { state, service };
}

test("healthy provisioning checks all four resources with no external or business mutation", async () => {
  const { state, service } = fixture();
  const result = await service.getHealth(COMPANY, ACTOR);
  assert.equal(result.status, "healthy"); assert.equal(result.checks.length, 4);
  assert.deepEqual(result.repair.actions, []); assert.equal(state.assigned, 0); assert.equal(state.fills, 0);
  assert.equal(result.checked_at, NOW.toISOString());
  assert.deepEqual(state.events.map(e => e.action), ["admin_provisioning_health_viewed"]);
  assert.equal(JSON.stringify(result).includes("agent_alpha"), false);
});

test("missing or multiple registered numbers require manual review", async () => {
  for (const count of [0, 2]) {
    const { state, service } = fixture();
    state.snapshot.phones = Array.from({ length: count }, () => state.snapshot.phones[0]);
    const result = await service.getHealth(COMPANY, ACTOR);
    assert.equal(result.status, "unhealthy"); assert.equal(result.repair.available, false);
    assert.equal(result.checks.filter(c => c.state === "unknown").length, 3);
  }
});

test("missing providers, permission errors, timeouts and absent resources cannot be green or repairable", async () => {
  for (const provider of ["twilio", "agent", "phone"]) {
    for (const stateName of ["missing", "unauthorized", "not_configured", "timeout", "unavailable", "invalid_id"]) {
      const { state, service } = fixture(); state[provider] = { state: stateName };
      const report = await service.getHealth(COMPANY, ACTOR);
      assert.notEqual(report.status, "healthy"); assert.equal(report.repair.available, false);
    }
  }
});

test("Twilio ownership, identity, active status and voice capability are independently verified", async () => {
  for (const [key, value] of [["account_sid", `AC${"c".repeat(32)}`], ["sid", `PN${"d".repeat(32)}`], ["phone_number", "+14185550202"], ["status", "released"], ["voice", false]]) {
    const { state, service } = fixture(); state.twilio.data[key] = value;
    const report = await service.getHealth(COMPANY, ACTOR);
    assert.equal(report.checks.find(c => c.key === "twilio").state, "error"); assert.equal(report.repair.available, false);
  }
});

test("provider identity mismatches and an agent already assigned elsewhere are never overwritten", async () => {
  for (const change of [s => { s.agent.data.agent_id = "foreign_agent"; }, s => { s.phone.data.phone_number = "+14185550202"; },
    s => { s.phone.data.provider = "sip_trunk"; }, s => { s.phone.data.phone_number_id = "foreign_phone"; },
    s => { s.phone.data.assigned_agent = { agent_id: "foreign_agent" }; }, s => { delete s.phone.data.assigned_agent; }]) {
    const { state, service } = fixture(); change(state);
    await assert.rejects(service.repair(COMPANY, ACTOR, "Support"), { code: "provisioning_repair_blocked" });
    assert.equal(state.assigned, 0); assert.equal(state.events.length, 0);
  }
});

test("local identity conflicts, missing metadata and cross-tenant aliases block repair", async () => {
  for (const change of [s => { s.conflict = true; }, s => { s.snapshot.assistant.elevenlabs_agent_id = "foreign_agent"; },
    s => { s.snapshot.twilio.phone_number_sid = "foreign_sid"; }, s => { s.snapshot.phones[0].company_id = FOREIGN; },
    s => { s.snapshot.phones[0].elevenlabs_phone_number_id = null; }, s => { s.snapshot.phones[0].status = "suspended"; },
    s => { s.snapshot.onboarding = null; }, s => { s.snapshot.onboarding.provisioning_status = "in_progress"; }]) {
    const { state, service } = fixture(); state.phone.data.assigned_agent = null; change(state);
    await assert.rejects(service.repair(COMPANY, ACTOR, "Support"), { code: "provisioning_repair_blocked" });
    assert.equal(state.assigned, 0);
  }
});

test("all local inconsistencies are reported, not only the first failure", async () => {
  const { state, service } = fixture(); state.conflict = true; state.snapshot.twilio = null; state.snapshot.assistant = null;
  const result = await service.getHealth(COMPANY, ACTOR);
  assert.deepEqual(result.checks[0].issues, ["twilio_config_mismatch", "assistant_config_missing", "resource_ownership_conflict"]);
});

test("safe repair links only an unassigned number, restores NULL assistant references and verifies the result", async () => {
  const { state, service } = fixture(); state.phone.data.assigned_agent = null;
  state.snapshot.assistant.twilio_number = null; state.snapshot.assistant.elevenlabs_agent_id = null;
  const result = await service.repair(COMPANY, ACTOR, "Rétablir la configuration");
  assert.equal(result.success, true); assert.equal(result.health.status, "healthy");
  assert.equal(state.assigned, 1); assert.equal(state.fills, 1);
  assert.equal(state.events[0].action, "authorize");
  assert.equal(state.events[1].action, "admin_provisioning_repair_requested");
  assert.equal(state.events[2].action, "acquire");
  assert.equal(state.events.at(-1).action, "admin_provisioning_repair_completed");
  assert.equal(state.events.filter(e => e.action === "authorize").length, 2);
  assert.equal(state.events.find(e => e.action === "finish").success, true);
  const again = await service.repair(COMPANY, ACTOR, "Même demande");
  assert.equal(again.changed, false); assert.equal(state.assigned, 1); assert.equal(state.fills, 1);
});

test("inactive clients or subscriptions and failed audit prevent all repair side effects", async () => {
  for (const kind of ["company", "payment", "audit"]) {
    const { state, service } = fixture(); state.phone.data.assigned_agent = null;
    if (kind === "company") state.snapshot.company.status = "suspended";
    if (kind === "payment") state.paymentFailure = true;
    if (kind === "audit") state.auditFailure = true;
    await assert.rejects(service.repair(COMPANY, ACTOR, "Support"));
    assert.equal(state.assigned, 0); assert.equal(state.events.some(e => e.action === "acquire"), false);
  }
});

test("concurrent provisioning, lost leases and changed phone records prevent mutation", async () => {
  for (const kind of ["busy", "lockLost", "changed"]) {
    const { state, service } = fixture(); state.phone.data.assigned_agent = null;
    if (kind === "changed") state.beforeRead = n => { if (n === 2) state.snapshot.phones[0].updated_at = "new-version"; };
    else state[kind] = true;
    await assert.rejects(service.repair(COMPANY, ACTOR, "Support"));
    assert.equal(state.assigned, 0); assert.equal(state.fills, 0);
  }
});

test("last-moment provider assignment prevents overwriting another agent", async () => {
  const { state, service } = fixture(); state.phone.data.assigned_agent = null;
  let reads = 0; state.beforePhone = () => { if (++reads === 3) state.phone.data.assigned_agent = { agent_id: "another" }; };
  await assert.rejects(service.repair(COMPANY, ACTOR, "Support"), { code: "provisioning_changed_retry" });
  assert.equal(state.assigned, 0);
});

test("a timeout or successful PATCH without effective assignment is never reported as repaired", async () => {
  const { state, service } = fixture(); state.phone.data.assigned_agent = null; state.assignFailure = true;
  await assert.rejects(service.repair(COMPANY, ACTOR, "Support"), { code: "provisioning_repair_unconfirmed" });
  assert.equal(state.events.find(e => e.action === "finish").success, false);
  state.assignFailure = false; state.unconfirmed = true;
  const result = await service.repair(COMPANY, ACTOR, "Support");
  assert.equal(result.success, false); assert.equal(result.health.status, "unhealthy");
});

test("invalid company IDs are rejected before any read or provider request", async () => {
  const { state, service } = fixture();
  await assert.rejects(service.getHealth("bad,id", ACTOR), { code: "invalid_company_id" });
  assert.equal(state.reads, 0);
});

test("verified resources allow reconciliation of failed provisioning or an expired lease without buying or assigning anything", async () => {
  for (const onboarding of [{ provisioning_status: "failed" }, { provisioning_status: "in_progress", provisioning_started_at: "2026-09-09T19:54:59Z" }]) {
    const { state, service } = fixture(); state.snapshot.onboarding = onboarding;
    const health = await service.getHealth(COMPANY, ACTOR);
    assert.deepEqual(health.repair.actions, ["reconcile_provisioning_status"]);
    const result = await service.repair(COMPANY, ACTOR, "Reprise après interruption");
    assert.equal(result.success, true); assert.equal(result.changed, true);
    assert.equal(state.assigned, 0); assert.equal(state.fills, 0);
    assert.equal(state.events.find(e => e.action === "finish").success, true);
  }
});

test("unexpired, future-dated and unknown-age provisioning leases remain blocked", async () => {
  for (const started of ["2026-09-09T19:55:00Z", "2026-09-09T20:01:00Z", null, "invalid"]) {
    const { state, service } = fixture(); state.snapshot.onboarding = { provisioning_status: "in_progress", provisioning_started_at: started };
    const health = await service.getHealth(COMPANY, ACTOR);
    assert.equal(health.repair.available, false);
    await assert.rejects(service.repair(COMPANY, ACTOR, "Support"), { code: "provisioning_repair_blocked" });
    assert.equal(state.events.some(e => e.action === "acquire"), false);
  }
});

test("health and repair HTTP routes enforce super-admin, confirmation, reason, no-store and server-owned target", async () => {
  const calls = []; const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get("x-role")) req.user = { id: ACTOR.id, role: req.get("x-role") }; next(); });
  app.use("/admin", createAdminCompanyRouter({ service: {}, provisioningHealth: {
    getHealth: async id => { calls.push({ id }); return { status: "healthy" }; },
    repair: async (id, actor, reason) => { calls.push({ id, actor, reason }); return { success: true }; },
  }, logger: { error() {} } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/companies/${COMPANY}`;
  try {
    for (const [role, expected] of [[null, 401], ["company_admin", 403], ["company_user", 403]]) {
      for (const [suffix, method] of [["provisioning-health", "GET"], ["provisioning-repair", "POST"]]) {
        const r = await fetch(`${url}/${suffix}`, { method, headers: role ? { "x-role": role } : {} }); assert.equal(r.status, expected);
      }
    }
    assert.equal(calls.length, 0);
    const headers = { "x-role": "super_admin", "Content-Type": "application/json", "X-Request-Id": ACTOR.requestId };
    const health = await fetch(`${url}/provisioning-health`, { headers }); assert.equal(health.status, 200); assert.equal(health.headers.get("cache-control"), "no-store");
    for (const body of [{}, { confirm_company_id: FOREIGN, reason: "Support" }, { confirm_company_id: COMPANY, reason: "x" }]) {
      const result = await fetch(`${url}/provisioning-repair`, { method: "POST", headers, body: JSON.stringify(body) }); assert.equal(result.status, 400);
    }
    const result = await fetch(`${url}/provisioning-repair`, { method: "POST", headers, body: JSON.stringify({ confirm_company_id: COMPANY, reason: "Support", company_id: FOREIGN, agent_id: "foreign" }) });
    assert.equal(result.status, 200); assert.deepEqual(calls.at(-1), { id: COMPANY, actor: ACTOR, reason: "Support" });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function recordingDb(responses = []) {
  const calls = [];
  return { calls, from(table) {
    const entry = { table, steps: [] }; calls.push(entry);
    const q = {};
    for (const name of ["select", "eq", "in", "order", "limit", "maybeSingle", "or", "update", "is", "insert", "abortSignal"]) {
      q[name] = (...args) => { entry.steps.push([name, ...args]); return q; };
    }
    q.then = (resolve, reject) => Promise.resolve(responses.shift() || { data: [], error: null }).then(resolve, reject);
    return q;
  } };
}

test("store reads are tenant scoped, bounded, and exclude secrets", async () => {
  const db = recordingDb([{ data: { id: COMPANY } }]); await createProvisioningStore(db).read(COMPANY);
  assert.equal(db.calls.length, 5);
  for (const call of db.calls) {
    assert.ok(call.steps.some(step => step[0] === "eq" && step[1] === (call.table === "companies" ? "id" : "company_id") && step[2] === COMPANY));
    assert.ok(call.steps.some(step => step[0] === "abortSignal"));
    assert.equal(JSON.stringify(call.steps).includes("auth_token"), false);
  }
  assert.ok(db.calls.find(c => c.table === "phone_numbers").steps.some(s => s[0] === "limit" && s[1] === 2));
});

test("ownership checks include other tenants and NULL orphan ownership, including historical aliases", async () => {
  const db = recordingDb(); const { state } = fixture();
  assert.equal(await createProvisioningStore(db).hasOtherOwner(COMPANY, state.snapshot.phones[0]), false);
  assert.equal(db.calls.length, 8);
  for (const call of db.calls) assert.ok(call.steps.some(s => s[0] === "or" && s[1] === `company_id.neq.${COMPANY},company_id.is.null`));
});

test("lease renew and finish compare tenant, state and ownership token; lost leases fail closed", async () => {
  for (const method of ["renew", "finish"]) {
    const db = recordingDb([{ data: null }]); const store = createProvisioningStore(db);
    await assert.rejects(store[method](COMPANY, "token", true), { code: "provisioning_lock_lost" });
    for (const [key, value] of [["company_id", COMPANY], ["provisioning_status", "in_progress"], ["provisioning_started_at", "token"]]) {
      assert.ok(db.calls[0].steps.some(s => s[0] === "eq" && s[1] === key && s[2] === value));
    }
  }
});

test("lease acquisition shares onboarding's atomic five-minute reclaim protocol", async () => {
  const db = recordingDb([{ data: { provisioning_started_at: NOW.toISOString() } }]);
  assert.equal(await createProvisioningStore(db, { now: () => NOW }).acquire(COMPANY), NOW.toISOString());
  assert.ok(db.calls[0].steps.some(s => s[0] === "or" && s[1].includes("provisioning_started_at.lt.2026-09-09T19:55:00.000Z")));
});

test("restoring assistant references is compare-and-set and never changes a different non-null assignment", async () => {
  const db = recordingDb([{ data: { company_id: COMPANY } }]); const { state } = fixture();
  await createProvisioningStore(db).fillAssistant(COMPANY, { twilio_number: null, elevenlabs_agent_id: "agent_alpha" }, state.snapshot.phones[0]);
  const steps = db.calls[0].steps;
  assert.ok(steps.some(s => s[0] === "is" && s[1] === "twilio_number" && s[2] === null));
  assert.ok(steps.some(s => s[0] === "eq" && s[1] === "elevenlabs_agent_id" && s[2] === "agent_alpha"));
  assert.deepEqual(Object.keys(steps.find(s => s[0] === "update")[1]).sort(), ["twilio_number", "updated_at"]);
});

test("database errors are sanitized and never interpreted as a missing resource", async () => {
  const db = recordingDb([{ error: { message: "secret SQL URL" }, data: null }]);
  await assert.rejects(createProvisioningStore(db).read(COMPANY), error => error.code === "provisioning_database_unavailable" && !error.message.includes("secret"));
});

test("real Supabase query builder sends tenant-scoped CAS filters and handles empty update results", async () => {
  const calls = []; let empty = false;
  const supabase = createClient("https://example.supabase.co", "fake-test-service-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, options) => {
      calls.push({ url: new URL(input), options });
      return new Response(JSON.stringify(empty ? [] : [{ company_id: COMPANY }]), { status: 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  const store = createProvisioningStore(supabase);
  const { state } = fixture();
  await store.fillAssistant(COMPANY, { twilio_number: null, elevenlabs_agent_id: "agent_alpha" }, state.snapshot.phones[0]);
  assert.equal(calls[0].url.searchParams.get("company_id"), `eq.${COMPANY}`);
  assert.equal(calls[0].url.searchParams.get("twilio_number"), "is.null");
  assert.equal(calls[0].url.searchParams.get("elevenlabs_agent_id"), "eq.agent_alpha");
  assert.equal(calls[0].options.method, "PATCH");
  empty = true;
  await assert.rejects(store.renew(COMPANY, NOW.toISOString()), { code: "provisioning_lock_lost" });
  assert.equal(calls[1].url.searchParams.get("provisioning_started_at"), `eq.${NOW.toISOString()}`);
});
