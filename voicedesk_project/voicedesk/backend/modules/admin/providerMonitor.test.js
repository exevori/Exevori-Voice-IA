import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import { PROVIDERS } from "./providerProbes.js";
import { createProviderMonitor, createProviderMonitorRouter } from "./providerMonitor.js";
import { createProviderStore } from "./providerStore.js";

const baseTime = Date.parse("2026-09-09T12:00:00Z");
function fixture(overrides = {}) {
  let time = baseTime;
  const calls = { claim: 0, record: [], sent: [], finish: [], fallback: 0, probe: 0, purge: 0 };
  const samples = () => PROVIDERS.map(provider => ({ provider, status: "ok", latency_ms: 5, checked_at: new Date(time).toISOString() }));
  const store = {
    claimChecks: async () => { calls.claim++; return PROVIDERS.map(provider => ({ provider, check_token: `token-${provider}` })); },
    record: async (claim, sample) => { calls.record.push({ claim, sample }); return true; },
    states: async () => samples(), claimAlerts: async () => [],
    finishAlert: async (...args) => { calls.finish.push(args); return true; },
    purge: async () => { calls.purge++; }, history: async () => [], alerts: async () => [],
    ...overrides.store,
  };
  const probes = {
    probe: async provider => { calls.probe++; return samples().find(row => row.provider === provider); },
    probeAll: async () => { calls.fallback++; return samples(); }, ...overrides.probes,
  };
  const sender = { configured: true, send: async input => { calls.sent.push(input); return "mail-qa"; }, ...overrides.sender };
  return { monitor: createProviderMonitor({ store, probes, sender, now: () => new Date(time), logger: { error() {} } }),
    calls, store, probes, sender, advance(ms = 60_000) { time += ms; } };
}

test("concurrent refreshes share probes and preserve database fencing tokens", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.monitor.snapshot(), f.monitor.snapshot()]);
  assert.equal(f.calls.claim, 1); assert.equal(f.calls.probe, 6); assert.equal(f.calls.record.length, 6);
  assert.deepEqual(a.providers, b.providers);
  assert.ok(f.calls.record.every(row => row.claim.check_token === `token-${row.sample.provider}`));
  await f.monitor.snapshot(); assert.equal(f.calls.probe, 6);
  f.advance(); await f.monitor.snapshot(); assert.equal(f.calls.probe, 12);
});

test("unclaimed checks do not contact providers", async () => {
  const f = fixture({ store: { claimChecks: async () => [] } });
  await f.monitor.snapshot(); assert.equal(f.calls.probe, 0); assert.equal(f.calls.fallback, 0);
});

test("durable alerts use stable incident keys and acknowledge only confirmed delivery", async () => {
  const job = { id: "job-1", provider: "twilio", down_since: new Date(baseTime).toISOString(), claim_token: "lease-1" };
  const f = fixture({ store: { claimAlerts: async () => [job] } });
  await f.monitor.runOnce();
  assert.equal(f.calls.sent[0].key, "monitoring/incident/job-1");
  assert.deepEqual(f.calls.finish[0], [job, "mail-qa", null]);
  f.sender.send = async () => { throw new Error("raw failure"); };
  f.advance(); const snapshot = await f.monitor.snapshot();
  assert.deepEqual(f.calls.finish[1], [job, null, "monitoring_email_send_failed"]);
  assert.equal(snapshot.email_alerts.delivery_error, "monitoring_email_send_failed");
});

test("unconfigured alerts do not claim or send queued messages", async () => {
  const f = fixture({ sender: { configured: false }, store: { claimAlerts: async () => { throw new Error("must not claim"); } } });
  const snapshot = await f.monitor.snapshot();
  assert.equal(snapshot.email_alerts.configured, false); assert.equal(snapshot.maintenance_error, null);
  assert.equal(f.calls.sent.length, 0);
});

test("storage/history failures are explicit without hiding live failures", async () => {
  const f = fixture({ store: { claimChecks: async () => { throw new Error("raw SQL private error"); } },
    probes: { probeAll: async () => PROVIDERS.map(provider => ({ provider, status: "down", checked_at: new Date(baseTime).toISOString() })) } });
  const result = await f.monitor.snapshot();
  assert.equal(result.storage, "unavailable"); assert.equal(result.history_state, "unavailable");
  assert.ok(result.providers.every(row => row.status === "down"));
  assert.ok(!JSON.stringify(result).includes("private"));
  const h = fixture({ store: { history: async () => { throw new Error(); } } });
  assert.equal((await h.monitor.snapshot()).history_state, "unavailable");
});

test("Supabase emergency alert waits beyond five continuous minutes and sends once", async () => {
  const f = fixture({ store: { claimChecks: async () => { throw new Error(); } } });
  f.probes.probeAll = async () => [{ provider: "supabase", status: "down" }];
  for (let minute = 0; minute <= 5; minute++) { await f.monitor.runOnce(); f.advance(); }
  assert.equal(f.calls.sent.length, 0);
  await f.monitor.runOnce(); assert.equal(f.calls.sent.length, 1);
  assert.equal(f.calls.sent[0].downSince, new Date(baseTime).toISOString());
  f.advance(); await f.monitor.runOnce(); assert.equal(f.calls.sent.length, 1);
  assert.equal((await f.monitor.snapshot()).email_alerts.emergency_sent, true);
});

test("monitoring gap or recovery resets emergency continuity; missing configuration is not an outage", async () => {
  for (const transition of ["gap", "ok", "not_configured"]) {
    const f = fixture({ store: { claimChecks: async () => { throw new Error(); } } });
    let status = "down"; f.probes.probeAll = async () => [{ provider: "supabase", status }];
    for (let minute = 0; minute < 4; minute++) { await f.monitor.runOnce(); f.advance(); }
    if (transition === "gap") f.advance(200_000);
    else { status = transition; await f.monitor.runOnce(); f.advance(); status = "down"; }
    await f.monitor.runOnce(); f.advance(); await f.monitor.runOnce();
    assert.equal(f.calls.sent.length, 0);
  }
});

test("emergency retries reuse key and body and expire within the idempotency window", async () => {
  const f = fixture({ store: { claimChecks: async () => { throw new Error(); } } });
  f.probes.probeAll = async () => [{ provider: "supabase", status: "down" }];
  const sends = [];
  f.sender.send = async input => { sends.push(input); throw new Error(); };
  for (let i = 0; i < 8; i++) { await f.monitor.runOnce(); f.advance(); }
  assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]);
  for (let i = 0; i < 24 * 60; i++) { await f.monitor.runOnce(); f.advance(); }
  assert.equal((await f.monitor.snapshot()).email_alerts.delivery_error, "emergency_delivery_window_expired");
  const attempts = sends.length;
  f.advance(); await f.monitor.runOnce(); assert.equal(sends.length, attempts);
});

test("worker start is idempotent and stop disables continuous checks", async () => {
  const f = fixture();
  try {
    assert.equal(f.monitor.start(), true); assert.equal(f.monitor.start(), false);
    assert.equal((await f.monitor.snapshot()).email_alerts.worker_started, true);
  } finally { f.monitor.stop(); }
  assert.equal((await f.monitor.snapshot()).email_alerts.worker_started, false);
});

test("monitoring endpoint enforces super_admin before probes and disables caching", async t => {
  let reads = 0;
  const app = express();
  app.use((req, _res, next) => { const role = req.get("test-role"); if (role) req.user = { role }; next(); });
  app.use(createProviderMonitorRouter({ snapshot: async () => { reads++; return { providers: [] }; } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/provider-status`;
  assert.equal((await fetch(url)).status, 401);
  for (const role of ["owner", "admin", "member"]) assert.equal((await fetch(url, { headers: { "test-role": role } })).status, 403);
  assert.equal(reads, 0);
  const response = await fetch(url, { headers: { "test-role": "super_admin" } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(reads, 1);
});

test("store uses bounded requests and explicit safe projections", async () => {
  const calls = [];
  const query = { abortSignal(signal) { assert.ok(signal); return Promise.resolve({ data: [], error: null }); },
    select(columns) { calls.push(columns); return this; }, order() { return this; }, limit() { return this; } };
  const store = createProviderStore({ rpc(name, args) { calls.push({ name, args }); return query; }, from() { return query; } });
  await store.states(); await store.alerts(); await store.record({ provider: "groq", check_token: "fence" }, { status: "down", latency_ms: 20, detail: "timeout" });
  assert.ok(calls.filter(value => typeof value === "string").every(value => !value.includes("*") && !value.includes("token")));
  assert.equal(calls.at(-1).args.p_token, "fence");
});

test("migration contract: least privilege, fencing, durable alerts after recovery and bounded retention", async () => {
  const sql = await readFile(new URL("../../../migrations/016_provider_monitoring.sql", import.meta.url), "utf8");
  assert.match(sql, /BEGIN;/); assert.match(sql, /COMMIT;\s*$/); assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  for (const table of ["state", "checks", "alerts"]) assert.ok(sql.includes(`ALTER TABLE public.provider_monitor_${table} FORCE ROW LEVEL SECURITY`));
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  for (const fn of ["claim_provider_checks", "record_provider_check", "claim_provider_alerts", "finish_provider_alert", "provider_monitor_history", "purge_provider_monitoring"]) {
    assert.ok(sql.includes(`FUNCTION public.${fn}(`));
    assert.ok(sql.includes(`public.${fn}(`, sql.indexOf("GRANT EXECUTE")));
  }
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /check_token = p_token AND lease_expires_at > observed_at/);
  assert.match(sql, /state\.down_since < observed_at - interval '5 minutes'/);
  assert.match(sql, /interval '150 seconds'/); assert.match(sql, /ON CONFLICT \(incident_id\) DO NOTHING/);
  for (const interval of ["23 hours", "24 hours", "48 hours"]) assert.ok(sql.includes(`interval '${interval}'`));
  const claim = sql.slice(sql.indexOf("FUNCTION public.claim_provider_alerts"), sql.indexOf("FUNCTION public.finish_provider_alert"));
  assert.doesNotMatch(claim, /SET status = 'suppressed'|JOIN public\.provider_monitor_state/);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM|ALTER TABLE) public\.(companies|subscriptions|profiles)\b/);
});
