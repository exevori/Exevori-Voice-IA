import test from "node:test";
import assert from "node:assert/strict";
import { createProviderProbes, PROVIDERS } from "./providerProbes.js";
import { createProviderAlertSender } from "./providerMonitor.js";

const env = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_AUTH_TOKEN: "test-token",
  ELEVENLABS_API_KEY: "test-eleven", GROQ_API_KEY: "test-groq",
  SUPABASE_URL: "https://qa-example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-supabase",
  STRIPE_SECRET_KEY: "test-stripe", RESEND_API_KEY: "test-resend",
};
const goodResponse = url => url.includes("twilio") ? { sid: env.TWILIO_ACCOUNT_SID, status: "active" }
  : url.includes("elevenlabs") ? { user_id: "qa-user" }
    : url.includes("groq") ? { data: [{ id: "model" }] }
      : url.includes("supabase") ? [] : url.includes("stripe") ? { object: "balance" } : { data: [] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("six read-only probes measure latency, use fixed destinations and never return secrets", async () => {
  const calls = [];
  const probes = createProviderProbes({ env, monotonicNow: (() => { let tick = 0; return () => tick += 10; })(),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return json(goodResponse(url)); } });
  const rows = await probes.probeAll();
  assert.deepEqual(rows.map(row => row.provider), PROVIDERS);
  assert.ok(rows.every(row => row.status === "ok" && row.latency_ms > 0));
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.options.method === "GET" && call.options.redirect === "error" && call.options.signal));
  assert.ok(calls.find(call => call.url.includes("supabase")).url.endsWith("limit=0"));
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(rows).includes(secret));
});

test("missing configuration never causes a request or a fake success", async () => {
  const probes = createProviderProbes({ env: {}, fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.ok((await probes.probeAll()).every(row => row.status === "not_configured" && row.latency_ms === null));
});

test("invalid Supabase URL and Twilio SID cannot receive credentials", async () => {
  let fetched = false;
  const probes = createProviderProbes({ env: { ...env, SUPABASE_URL: "https://attacker.example/", TWILIO_ACCOUNT_SID: "../bad" },
    fetchImpl: () => { fetched = true; throw new Error(); } });
  assert.equal((await probes.probe("supabase")).detail, "invalid_configuration");
  assert.equal((await probes.probe("twilio")).detail, "invalid_configuration");
  assert.equal(fetched, false);
});

test("401/403, rate limits, server errors and malformed successes are never OK", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const probes = createProviderProbes({ env, fetchImpl: async () => json({ error: "private raw error" }, status) });
    const sample = await probes.probe("resend");
    assert.equal(sample.status, [401, 403].includes(status) ? "unauthorized" : "down");
    assert.equal(sample.detail, `http_${status}`);
    assert.ok(!JSON.stringify(sample).includes("private"));
  }
  for (const body of [{ status: "active" }, { data: "bad" }, null]) {
    const probes = createProviderProbes({ env, fetchImpl: async () => json(body) });
    assert.equal((await probes.probe("twilio")).status, "down");
  }
});

test("suspended Twilio account and mismatched SID are not healthy", async () => {
  for (const data of [{ sid: env.TWILIO_ACCOUNT_SID, status: "suspended" }, { sid: "wrong", status: "active" }]) {
    assert.equal((await createProviderProbes({ env, fetchImpl: async () => json(data) }).probe("twilio")).status, "down");
  }
});

test("timeout aborts the actual request without exposing its raw error", async () => {
  let aborted = false;
  const probes = createProviderProbes({ env, timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("secret raw error")); }, { once: true });
  }) });
  const row = await probes.probe("groq");
  assert.equal(row.status, "down"); assert.equal(row.detail, "timeout"); assert.equal(aborted, true);
});

test("Resend monitoring can use a separate read-capable key", async () => {
  let authorization;
  const probes = createProviderProbes({ env: { ...env, RESEND_MONITORING_API_KEY: "read-test" },
    fetchImpl: async (_url, options) => { authorization = options.headers.Authorization; return json({ data: [] }); } });
  await probes.probe("resend"); assert.equal(authorization, "Bearer read-test");
});

test("alert sender validates recipients, preserves idempotency and requires acknowledgement", async () => {
  for (const recipient of ["", "bad address", "qa@example.com\nBcc:x@example.com"]) {
    assert.equal(createProviderAlertSender({ env: { ...env, EMAIL_FROM: "qa@example.com", MONITORING_ALERT_EMAIL: recipient } }).configured, false);
  }
  let observed;
  const sender = createProviderAlertSender({ env: { ...env, EMAIL_FROM: "qa@example.com", MONITORING_ALERT_EMAIL: "admin@example.com" },
    fetchImpl: async (url, options) => { observed = { url, options }; return json({ id: "mail-1" }); } });
  const message = { provider: "groq", downSince: "2026-09-09T12:00:00Z", key: "test-key" };
  assert.equal(await sender.send(message), "mail-1");
  assert.equal(observed.url, "https://api.resend.com/emails");
  assert.equal(observed.options.headers["Idempotency-Key"], "test-key");
  assert.equal(observed.options.headers.Authorization, "Bearer test-resend");
  assert.deepEqual(JSON.parse(observed.options.body).to, ["admin@example.com"]);
  assert.match(JSON.parse(observed.options.body).text, /après le rétablissement/);
  for (const response of [() => json({ error: "raw" }, 429), () => json({})]) {
    const failing = createProviderAlertSender({ env: { ...env, EMAIL_FROM: "qa@example.com", MONITORING_ALERT_EMAIL: "admin@example.com" }, fetchImpl: async () => response() });
    await assert.rejects(() => failing.send(message), /monitoring_email_send_failed/);
  }
});
