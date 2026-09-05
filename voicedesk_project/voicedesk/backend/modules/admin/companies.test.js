import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import { createAdminCompanyRouter } from "./companies.js";
import { createAdminCompanyService, monthlySubscriptionAmount, utcMonth } from "./companyService.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-05T12:00:00Z");
const actor = { id: ADMIN, requestId: REQUEST };

class Query {
  constructor(db, table) { Object.assign(this, { db, table, filters: [], action: "select", columns: "*", bounds: null }); }
  select(columns = "*") { this.columns = columns; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); this.db.filters.push({ table: this.table, key, value }); return this; }
  in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
  gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
  lt(key, value) { this.filters.push(row => row[key] < value); return this; }
  order() { return this; }
  range(start, end) { this.bounds = [start, end]; return this; }
  update(payload) { this.action = "update"; this.payload = payload; return this; }
  insert(payload) { this.action = "insert"; this.payload = payload; return this; }
  maybeSingle() { return this.run(true); }
  then(resolve, reject) { return this.run(false).then(resolve, reject); }
  async run(single) {
    this.db.queries.push({ table: this.table, action: this.action, columns: this.columns, payload: this.payload, bounds: this.bounds });
    if (this.db.error?.(this)) return { data: null, error: { message: "private SQL details" } };
    const source = this.db.tables[this.table] ||= [];
    let rows = source.filter(row => this.filters.every(predicate => predicate(row)));
    if (this.action === "update") rows.forEach(row => Object.assign(row, this.payload));
    if (this.action === "insert") { source.push(structuredClone(this.payload)); rows = [this.payload]; }
    if (this.bounds) rows = rows.slice(this.bounds[0], this.bounds[1] + 1);
    return { data: structuredClone(single ? rows[0] || null : rows), error: null };
  }
}

function database(overrides = {}) {
  return {
    tables: {
      companies: [{ id: A, name: "Alpha <script>", contact_name: "Karim <img>", contact_email: "alpha@example.test", status: "active", updated_at: NOW.toISOString() }, { id: B, name: "Beta", status: "active" }],
      subscriptions: [{ company_id: A, plan_name: "essentiel", payment_status: "active_paid", stripe_customer_id: "cus_alpha", stripe_subscription_id: "sub_alpha" }],
      assistant_configs: [{ company_id: A, assistant_name: "Léa", elevenlabs_agent_id: "agent_alpha", twilio_number: "+14185550101", system_prompt_voice_fr: "Prompt privé" }],
      phone_numbers: [{ id: "phone-a", company_id: A, phone_number: "+14185550101", status: "active", elevenlabs_agent_id: "agent_alpha", twilio_phone_sid: "PN_alpha" }],
      twilio_configs: [{ company_id: A, phone_number: "+14185550101", auth_token_encrypted: "secret" }],
      onboarding_progress: [{ company_id: A, provisioning_status: "done" }],
      calls: [{ id: "call-a", company_id: A, direction: "inbound", duration_seconds: 120, created_at: "2026-09-02T12:00:00Z" }, { id: "foreign", company_id: B, duration_seconds: 99999, created_at: "2026-09-02T12:00:00Z" }],
      outbound_calls: [{ id: "out-a", company_id: A, duration_seconds: 60, called_at: "2026-09-02T12:00:00Z", created_at: "2026-08-01T00:00:00Z" }],
      usage_records: [{ id: "usage-a", company_id: A, period_start: "2026-09-01", resource_type: "voice_minutes", quantity: 3, total_cost_usd: "1.25" }],
      ...overrides,
    }, queries: [], filters: [], error: null,
    from(table) { return new Query(this, table); },
  };
}

function createService(db, options = {}) {
  return createAdminCompanyService({
    supabase: db, stripe: { subscriptions: { retrieve: async () => ({ id: "sub_alpha", customer: "cus_alpha", status: "active", metadata: { company_id: A } }) } },
    now: () => NOW, frontendUrl: "https://app.example.test", emailFrom: "VoiceDesk <support@example.test>", logger: { error() {} }, ...options,
  });
}

async function withServer(service, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get("x-role")) req.user = { id: ADMIN, role: req.get("x-role"), company_id: B };
    next();
  });
  app.use("/admin", createAdminCompanyRouter({ service, logger: { error() {} } }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}/admin`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("all company endpoints reject non-admins before accessing data or providers", async () => {
  const db = database();
  await withServer(createService(db), async url => {
    assert.equal((await fetch(`${url}/companies/${A}`)).status, 401);
    for (const role of ["company_user", "company_admin"]) {
      for (const suffix of ["", "/suspend", "/reactivate", "/impersonate", "/resend-welcome", "/resync-provisioning"]) {
        const result = await fetch(`${url}/companies/${A}${suffix}`, { method: suffix ? "POST" : "GET", headers: { "x-role": role } });
        assert.equal(result.status, 403);
      }
    }
  });
  assert.equal(db.queries.length, 0);
});

test("admin detail returns tenant-only data, verified Stripe and no credentials", async () => {
  const db = database();
  const detail = await createService(db).getCompanyDetail(A, actor);
  assert.equal(detail.stripe.state, "verified");
  assert.equal(detail.usage.total_calls, 2);
  assert.equal(detail.usage.minutes, 3);
  assert.equal(detail.usage.infrastructure_cost_usd, 1.25);
  const raw = JSON.stringify(detail);
  for (const secret of ["auth_token_encrypted", "Prompt privé", "private SQL", "secret"]) assert.equal(raw.includes(secret), false);
  assert.equal(db.tables.audit_log[0].actor_user_id, ADMIN);
  for (const table of ["calls", "outbound_calls", "usage_records", "phone_numbers", "assistant_configs", "subscriptions"]) {
    assert.ok(db.filters.some(filter => filter.table === table && filter.key === "company_id" && filter.value === A));
  }
});

test("monthly usage paginates beyond 1000 rows and excludes outbound mirrors", async () => {
  const db = database({ calls: [
    ...Array.from({ length: 1001 }, (_, id) => ({ id, company_id: A, direction: "inbound", duration_seconds: 60, created_at: "2026-09-02T00:00:00Z" })),
    { id: "mirror", company_id: A, direction: "outbound", duration_seconds: 60, created_at: "2026-09-02T00:00:00Z" },
  ] });
  const detail = await createService(db).getCompanyDetail(A, actor);
  assert.equal(detail.usage.total_calls, 1002);
  assert.equal(detail.usage.minutes, 1002);
  assert.ok(db.queries.some(query => query.table === "calls" && query.bounds?.[0] === 1000));
  assert.deepEqual(utcMonth(new Date("2026-12-31T23:59:59Z")), { start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" });
});

test("recurring revenue normalizes SQL decimals and annual prices without counting canceled subscriptions", () => {
  assert.equal(monthlySubscriptionAmount({ payment_status: "active", monthly_price: "159.00" }), 159);
  assert.equal(monthlySubscriptionAmount({ payment_status: "active_paid", billing_cycle: "annual", annual_price: "1200.00", monthly_price: "159.00" }), 100);
  assert.equal(monthlySubscriptionAmount({ payment_status: "cancelled", monthly_price: "159.00" }), 0);
});

test("missing costs and unavailable Stripe are explicit, never a fabricated zero or active state", async () => {
  const db = database({ usage_records: [] });
  const detail = await createService(db, { stripe: { subscriptions: { retrieve: async () => { throw new Error("secret provider error"); } } } }).getCompanyDetail(A, actor);
  assert.equal(detail.stripe.state, "unavailable");
  assert.equal(detail.stripe.subscription_status, null);
  assert.equal(detail.usage.infrastructure_cost_usd, null);
  assert.equal(detail.usage.cost_state, "not_available");
});

test("a Stripe subscription owned by another customer cannot authorize reactivation", async () => {
  const db = database(); db.tables.companies[0].status = "suspended";
  const service = createService(db, { stripe: { subscriptions: { retrieve: async () => ({ id: "sub_alpha", customer: "cus_foreign", status: "active" }) } } });
  assert.equal((await service.getCompanyDetail(A, actor)).stripe.state, "mismatch");
  await assert.rejects(service.changeAccess(A, "reactivate", actor, "Support"), { code: "stripe_verification_required" });
  assert.equal(db.tables.companies[0].status, "suspended");
});

test("suspension is conditional, audited, clears auth cache and does not change billing", async () => {
  const db = database(); let cleared = null;
  const result = await createService(db, { clearCompanyCache: async id => { cleared = id; } }).changeAccess(A, "suspend", actor, "Demande support");
  assert.equal(result.company.status, "suspended");
  assert.equal(result.billing_unchanged, true);
  assert.equal(db.tables.subscriptions[0].payment_status, "active_paid");
  assert.equal(cleared, A);
  assert.ok(db.filters.some(filter => filter.table === "companies" && filter.key === "status" && filter.value === "active"));
  const writes = db.queries.filter(query => query.action !== "select");
  assert.deepEqual(writes.map(query => query.table), ["audit_log", "companies", "audit_log"]);
});

test("failure of the mandatory audit prevents a suspension", async () => {
  const db = database(); db.error = query => query.table === "audit_log";
  await assert.rejects(createService(db).changeAccess(A, "suspend", actor, "Support"), { code: "admin_audit_failed" });
  assert.equal(db.tables.companies[0].status, "active");
  assert.equal(db.queries.some(query => query.table === "companies" && query.action === "update"), false);
});

test("reactivation requires actual paid/trial eligibility and preserves payment state", async () => {
  const db = database(); db.tables.companies[0].status = "suspended";
  const result = await createService(db).changeAccess(A, "reactivate", actor, "Incident résolu");
  assert.equal(result.company.status, "active");
  assert.equal(db.tables.subscriptions[0].payment_status, "active_paid");
  db.tables.companies[0].status = "suspended";
  const service = createService(db, { stripe: { subscriptions: { retrieve: async () => ({ id: "sub_alpha", customer: "cus_alpha", status: "past_due" }) } } });
  await assert.rejects(service.changeAccess(A, "reactivate", actor, "Support"), { code: "subscription_inactive" });
  assert.equal(db.tables.companies[0].status, "suspended");
});

test("expired and malformed local trials cannot reactivate or provision", async () => {
  for (const expires of [null, "invalid", "2026-09-01T00:00:00Z"]) {
    const db = database({ subscriptions: [{ company_id: A, payment_status: "trial", trial_ends_at: expires }] });
    db.tables.companies[0].status = "suspended";
    await assert.rejects(createService(db).changeAccess(A, "reactivate", actor, "Support"), { code: "trial_expired" });
  }
});

test("an incomplete Stripe linkage cannot fall back to a cached paid status for reactivation", async () => {
  const db = database();
  db.tables.companies[0].status = "suspended";
  db.tables.subscriptions[0].stripe_subscription_id = null;
  await assert.rejects(createService(db).changeAccess(A, "reactivate", actor, "Support"), { code: "stripe_verification_required" });
  assert.equal(db.tables.companies[0].status, "suspended");
});

test("welcome resend uses the stored recipient, escapes HTML and reuses request idempotency", async () => {
  const db = database(); const sends = [];
  const service = createService(db, { resend: { emails: { send: async (...args) => { sends.push(args); return { data: { id: "mail-id" }, error: null }; } } } });
  const result = await service.resendWelcome(A, actor);
  assert.equal(result.recipient, "alpha@example.test");
  assert.equal(sends[0][0].to, "alpha@example.test");
  assert.equal(sends[0][0].html.includes("<script>"), false);
  assert.equal(sends[0][0].html.includes("<img>"), false);
  assert.match(sends[0][0].html, /&lt;script&gt;/);
  assert.equal(sends[0][1].idempotencyKey, `admin-welcome/${A}/${REQUEST}`);
});

test("structured Resend errors never report a welcome email as sent", async () => {
  const db = database();
  const service = createService(db, { resend: { emails: { send: async () => ({ error: { message: "provider refused" } }) } } });
  await assert.rejects(service.resendWelcome(A, actor), { code: "welcome_email_send_failed" });
  assert.equal(db.tables.audit_log.some(row => row.action === "admin_welcome_email_sent"), false);
});

test("provisioning relaunch derives configuration from the company and preserves existing guards", async () => {
  const db = database(); const calls = [];
  const result = await createService(db, { provisionClient: async input => { calls.push(input); return { success: true, existing: true, log: ["secret"] }; } }).resyncProvisioning(A, actor, "Reprise support");
  assert.equal(calls[0].companyId, A);
  assert.equal(calls[0].systemPrompt, "Prompt privé");
  assert.equal(result.reused_existing, true);
  assert.equal("log" in result, false);
  assert.equal(db.queries.some(query => query.action === "update" && query.table === "onboarding_progress"), false);
});

test("provisioning busy and suspended access block the admin relaunch", async () => {
  const db = database(); let attempts = 0;
  const service = createService(db, { provisionClient: async () => { attempts += 1; return { success: false, code: "provisioning_in_progress" }; } });
  await assert.rejects(service.resyncProvisioning(A, actor, "Support"), { code: "provisioning_in_progress", status: 409 });
  db.tables.companies[0].status = "suspended";
  await assert.rejects(service.resyncProvisioning(A, actor, "Support"), { code: "company_access_inactive" });
  assert.equal(attempts, 1);
});

test("HTTP actions require confirmation and record the authenticated admin, ignoring spoofed actor", async () => {
  const db = database();
  const headers = { "x-role": "super_admin", "content-type": "application/json", "X-Request-Id": REQUEST };
  await withServer(createService(db), async url => {
    assert.equal((await fetch(`${url}/companies/${A}/suspend`, { method: "POST", headers, body: JSON.stringify({ reason: "Support" }) })).status, 400);
    const result = await fetch(`${url}/companies/${A}/impersonate`, { method: "POST", headers, body: JSON.stringify({ confirm_company_id: A, reason: "Diagnostic", actor_id: B }) });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal((await result.json()).company.id, A);
  });
  assert.equal(db.tables.audit_log[0].actor_user_id, ADMIN);
});

test("database failure cannot produce a successful empty company detail or expose SQL errors", async () => {
  const db = database(); db.error = query => query.table === "calls";
  await withServer(createService(db), async url => {
    const result = await fetch(`${url}/companies/${A}`, { headers: { "x-role": "super_admin" } });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "calls_read_failed" });
  });
});
