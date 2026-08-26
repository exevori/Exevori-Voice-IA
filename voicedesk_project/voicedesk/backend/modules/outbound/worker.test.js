import assert from "node:assert/strict";
import { test } from "node:test";

import { RECORDING_CONSENT_NOTICE_FR } from "../privacy/consent.js";
import {
  buildConversationInitiationData,
  computeBackoffMs,
  createOutboundPreflight,
  createOutboundWorker,
  evaluateOutboundBusinessHours,
  findNextOutboundOpening,
  stopOutboundWorker,
} from "./worker.js";

const fixedNow = new Date("2026-08-17T14:00:00.000Z"); // Monday 10:00 Toronto

const job = {
  id: "queue-1",
  company_id: "company-1",
  campaign_id: "campaign-1",
  outbound_contact_id: "outbound-contact-1",
  contact_id: "contact-1",
  contact_phone_e164: "+15145550123",
  attempt_count: 0,
  max_attempts: 3,
  reserved_minutes: 1,
};

const attempt = {
  id: "attempt-1",
  company_id: "company-1",
  queue_id: "queue-1",
  attempt_no: 1,
};

const validation = {
  action: "dispatch",
  localCallDate: "2026-08-17",
  company: {
    id: "company-1",
    name: "Clinique Exemple",
  },
  campaign: {
    id: "campaign-1",
    name: "Relance été",
    mission_type: "follow_up",
    script: "Demander si le client souhaite confirmer son rendez-vous.",
  },
  contact: {
    id: "contact-1",
    full_name: "Nom CRM",
  },
  outboundContact: {
    id: "outbound-contact-1",
    full_name: "Alice Exemple",
    language: "fr-CA",
  },
  outboundPhone: {
    id: "phone-1",
    elevenlabs_agent_id: "agent-1",
    elevenlabs_phone_number_id: "provider-phone-1",
  },
};

function silentLogger() {
  const events = [];
  return {
    events,
    debug(message, context) { events.push({ message, context }); },
    info(message, context) { events.push({ message, context }); },
    warn(message, context) { events.push({ message, context }); },
    error(message, context) { events.push({ message, context }); },
  };
}

function createQueue(overrides = {}) {
  const calls = [];
  const state = { providerAttemptCount: 1 };
  return {
    calls,
    state,
    async claimNext() { calls.push(["claimNext"]); return job; },
    async recoverStale() { calls.push(["recoverStale"]); },
    async beginAttempt(_job, localCallDate) {
      calls.push(["beginAttempt", localCallDate]);
      return attempt;
    },
    async markDispatched(_attempt, result) {
      calls.push(["markDispatched", result]);
    },
    async markRetryable(_attempt, options) {
      calls.push(["markRetryable", options]);
    },
    async markPermanentFailure(_attempt, code) {
      calls.push(["markPermanentFailure", code]);
    },
    async markConfigurationFailure(_attempt, options) {
      calls.push(["markConfigurationFailure", options]);
      state.providerAttemptCount = Math.max(state.providerAttemptCount - 1, 0);
    },
    async markDispatchUnknown(_attempt, code, providerHints) {
      calls.push(["markDispatchUnknown", code, providerHints]);
    },
    async defer(_job, options) { calls.push(["defer", options]); },
    async block(_job, code) { calls.push(["block", code]); },
    ...overrides,
  };
}

test("accepted call follows the mission and persists provider IDs", async () => {
  const queue = createQueue();
  const requests = [];
  const logger = silentLogger();
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: {
      async initiateOutboundCall(request) {
        requests.push(request);
        return {
          kind: "accepted",
          conversationId: "conv-1",
          callSid: "CA1",
        };
      },
    },
    now: () => fixedNow,
    logger,
  });

  assert.deepEqual(await worker.runOnce(), { kind: "accepted" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agentId, "agent-1");
  assert.equal(requests[0].agentPhoneNumberId, "provider-phone-1");
  assert.equal(requests[0].toNumber, "+15145550123");
  assert.equal(requests[0].callRecordingEnabled, true);
  const initiation = requests[0].conversationInitiationClientData;
  assert.equal(initiation.dynamic_variables.voicedesk_direction, "outbound");
  assert.equal(initiation.custom_llm_extra_body.voicedesk_direction, "outbound");
  assert.equal(initiation.custom_llm_extra_body.outbound_attempt_id, "attempt-1");
  assert.equal("outbound_script" in initiation.dynamic_variables, false);
  assert.equal("contact_name" in initiation.dynamic_variables, false);
  assert.equal("company_name" in initiation.dynamic_variables, false);
  assert.match(
    initiation.conversation_config_override.agent.first_message,
    new RegExp(`^${RECORDING_CONSENT_NOTICE_FR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    initiation.conversation_config_override.agent.first_message,
    /au nom de Clinique Exemple/
  );
  assert.ok(queue.calls.some(([name]) => name === "markDispatched"));

  const logText = JSON.stringify(logger.events);
  assert.equal(logText.includes("+15145550123"), false);
  assert.equal(logText.includes("Alice Exemple"), false);
  assert.equal(logText.includes(validation.campaign.script), false);
});

test("provider metadata contains only correlation identifiers", () => {
  const value = buildConversationInitiationData(job, attempt, {
    ...validation,
    campaign: {
      ...validation.campaign,
      name: "x".repeat(500),
      mission_type: "y".repeat(100),
      script: "z".repeat(7_000),
    },
    outboundContact: {
      full_name: `Alice\n${"n".repeat(200)}`,
      language: "en-CA",
    },
  });
  assert.deepEqual(value.dynamic_variables, value.custom_llm_extra_body);
  assert.deepEqual(Object.keys(value.dynamic_variables).sort(), [
    "campaign_id",
    "company_id",
    "contact_id",
    "outbound_attempt_id",
    "outbound_contact_id",
    "outbound_queue_id",
    "voicedesk_direction",
  ]);
  assert.match(
    value.conversation_config_override.agent.first_message,
    /^Hello\. You are speaking with a virtual assistant/
  );
});

test("429 schedules one retry using the greater provider or exponential delay", async () => {
  const queue = createQueue();
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: {
      async initiateOutboundCall() {
        return { kind: "retryable", code: "rate_limited", retryAfterMs: 20_000 };
      },
    },
    now: () => fixedNow,
    random: () => 0.5,
    errorBackoffMs: 5_000,
    logger: silentLogger(),
  });

  assert.deepEqual(await worker.runOnce(), { kind: "retry_scheduled" });
  const transition = queue.calls.find(([name]) => name === "markRetryable");
  assert.equal(transition[1].code, "rate_limited");
  assert.equal(transition[1].retryAt.toISOString(), "2026-08-17T14:00:20.000Z");
});

test("definite rejection fails permanently and ambiguous dispatch never retries", async () => {
  for (const [providerResult, transition, expected] of [
    [
      { kind: "permanent_failure", code: "unprocessable_entity" },
      "markPermanentFailure",
      { kind: "failed" },
    ],
    [
      { kind: "dispatch_unknown", code: "request_timeout" },
      "markDispatchUnknown",
      { kind: "dispatch_unknown" },
    ],
  ]) {
    const queue = createQueue();
    const worker = createOutboundWorker({
      queue,
      preflight: async () => validation,
      client: { async initiateOutboundCall() { return providerResult; } },
      now: () => fixedNow,
      logger: silentLogger(),
    });
    assert.deepEqual(await worker.runOnce(), expected);
    assert.ok(queue.calls.some(([name]) => name === transition));
    assert.equal(queue.calls.some(([name]) => name === "markRetryable"), false);
  }
});

test("ambiguous provider success persists every available correlation ID", async () => {
  const queue = createQueue();
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: {
      async initiateOutboundCall() {
        return {
          kind: "dispatch_unknown",
          code: "ambiguous_success_response",
          conversationId: "conv-partial",
          callSid: null,
        };
      },
    },
    now: () => fixedNow,
    logger: silentLogger(),
  });

  assert.deepEqual(await worker.runOnce(), { kind: "dispatch_unknown" });
  assert.deepEqual(
    queue.calls.find(([name]) => name === "markDispatchUnknown"),
    [
      "markDispatchUnknown",
      "ambiguous_success_response",
      { conversationId: "conv-partial", callSid: null },
    ]
  );
  assert.equal(queue.calls.some(([name]) => name === "markRetryable"), false);
});

test("une panne de configuration fournisseur met le tenant en quarantaine", async () => {
  const queue = createQueue();
  let providerCalls = 0;
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: {
      async initiateOutboundCall() {
        providerCalls += 1;
        return {
          kind: "configuration_failure",
          code: "agent_not_found",
          scope: "tenant",
        };
      },
    },
    now: () => fixedNow,
    providerConfigurationBackoffMs: 15 * 60 * 1_000,
    logger: silentLogger(),
  });

  assert.deepEqual(await worker.runOnce(), {
    kind: "error",
    phase: "provider_configuration_failure",
  });
  assert.equal(providerCalls, 1);
  const quarantine = queue.calls.find(
    ([name]) => name === "markConfigurationFailure"
  );
  assert.equal(quarantine[1].code, "agent_not_found");
  assert.equal(
    quarantine[1].retryAt.toISOString(),
    "2026-08-17T14:15:00.000Z"
  );
  assert.equal(queue.state.providerAttemptCount, 0);
  assert.equal(queue.calls.some(([name]) => name === "markRetryable"), false);

  assert.deepEqual(await worker.runOnce(), {
    kind: "error",
    phase: "provider_configuration_quarantine",
  });
  assert.equal(providerCalls, 1, "aucun second contact ne doit atteindre le fournisseur");
  assert.ok(queue.calls.some(([name, value]) => (
    name === "defer" && value.code === "provider_configuration_quarantine"
  )));
});

test("preflight block and deferral make no provider request", async () => {
  for (const [decision, transition, expected] of [
    [{ action: "block", code: "dnc_blocked" }, "block", "blocked"],
    [
      { action: "defer", code: "outside_hours", retryAt: new Date(fixedNow.getTime() + 60_000) },
      "defer",
      "deferred",
    ],
  ]) {
    const queue = createQueue();
    let providerCalls = 0;
    const worker = createOutboundWorker({
      queue,
      preflight: async () => decision,
      client: { async initiateOutboundCall() { providerCalls += 1; } },
      now: () => fixedNow,
      logger: silentLogger(),
    });
    assert.equal((await worker.runOnce()).kind, expected);
    assert.ok(queue.calls.some(([name]) => name === transition));
    assert.equal(queue.calls.some(([name]) => name === "beginAttempt"), false);
    assert.equal(providerCalls, 0);
  }
});

test("unexpected client throw is dispatch_unknown, never an automatic retry", async () => {
  const queue = createQueue();
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: { async initiateOutboundCall() { throw new Error("network"); } },
    now: () => fixedNow,
    logger: silentLogger(),
  });
  assert.deepEqual(await worker.runOnce(), { kind: "dispatch_unknown" });
  assert.ok(queue.calls.some(([name]) => name === "markDispatchUnknown"));
  assert.equal(queue.calls.some(([name]) => name === "markRetryable"), false);
});

test("une garde SQL atomique sans tentative ne déclenche jamais le fournisseur", async () => {
  let providerCalls = 0;
  const queue = createQueue({
    async beginAttempt() {
      const error = new Error("guarded");
      error.code = "outbound_attempt_not_created";
      throw error;
    },
  });
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: { async initiateOutboundCall() { providerCalls += 1; } },
    now: () => fixedNow,
    logger: silentLogger(),
  });

  assert.deepEqual(await worker.runOnce(), {
    kind: "deferred",
    code: "atomic_guard_applied",
  });
  assert.equal(providerCalls, 0);
});

test("poller is singleton per instance, recovers first, and is stoppable", async () => {
  const queue = createQueue({ async claimNext() { return null; } });
  const timers = [];
  const cleared = [];
  let clock = new Date(fixedNow);
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: { async initiateOutboundCall() {} },
    logger: silentLogger(),
    now: () => clock,
    setTimer(callback, delay) {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) { cleared.push(handle); },
    pollIntervalMs: 1234,
    recoveryIntervalMs: 60_000,
  });

  assert.equal(worker.start(), true);
  assert.equal(worker.start(), false);
  assert.equal(worker.getStatus().ready, false);
  assert.equal(worker.getStatus().status, "degraded");
  assert.equal(timers[0].delay, 0);
  await timers.shift().callback();
  assert.equal(worker.getStatus().ready, true);
  assert.equal(worker.getStatus().status, "running");
  assert.deepEqual(queue.calls[0], ["recoverStale"]);
  assert.equal(timers[0].delay, 1234);
  clock = new Date(clock.getTime() + 61_000);
  await timers.shift().callback();
  assert.equal(
    queue.calls.filter(([name]) => name === "recoverStale").length,
    2
  );
  assert.equal(worker.stop(), true);
  assert.equal(worker.stop(), false);
  assert.equal(cleared.length, 1);
  assert.equal(stopOutboundWorker(), false);
});

test("un heartbeat DB réussi rétablit la disponibilité après une panne transitoire", async () => {
  let claims = 0;
  const queue = createQueue({
    async claimNext() {
      claims += 1;
      if (claims === 1) throw new Error("storage offline");
      return null;
    },
  });
  const timers = [];
  const worker = createOutboundWorker({
    queue,
    preflight: async () => validation,
    client: { async initiateOutboundCall() {} },
    logger: silentLogger(),
    now: () => fixedNow,
    setTimer(callback, delay) {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer() {},
  });

  worker.start();
  await timers.shift().callback();
  assert.equal(worker.getStatus().ready, false);
  await timers.shift().callback();
  assert.equal(worker.getStatus().ready, true);
  worker.stop();
});

test("numeric migration schedule is evaluated in tenant timezone across DST", () => {
  const schedule = {
    1: [{ start: "09:00", end: "20:00" }],
    2: [{ start: "09:00", end: "20:00" }],
    3: [{ start: "09:00", end: "20:00" }],
    4: [{ start: "09:00", end: "20:00" }],
    5: [{ start: "09:00", end: "20:00" }],
    6: [],
    7: [],
  };
  assert.equal(evaluateOutboundBusinessHours({
    now: fixedNow,
    timeZone: "America/Toronto",
    outboundBusinessHours: schedule,
  }).isOpen, true);
  const next = findNextOutboundOpening({
    now: new Date("2026-11-01T14:00:00Z"), // Sunday after DST fallback
    timeZone: "America/Toronto",
    outboundBusinessHours: schedule,
  });
  assert.equal(next.toISOString(), "2026-11-02T14:00:00.000Z");
});

test("exponential backoff is deterministic with an injected random source", () => {
  assert.equal(computeBackoffMs(1, { baseMs: 1_000, random: () => 0.5 }), 1_000);
  assert.equal(computeBackoffMs(3, { baseMs: 1_000, random: () => 0.5 }), 4_000);
  assert.equal(
    computeBackoffMs(20, { baseMs: 1_000, maxMs: 10_000, random: () => 0.5 }),
    10_000
  );
});

class Query {
  constructor(storage, table) {
    this.storage = storage;
    this.table = table;
    this.filters = [];
    this.limitValue = null;
    this.head = false;
  }
  select(_columns, options = {}) { this.head = options.head === true; return this; }
  eq(column, value) { this.filters.push(row => row[column] === value); return this; }
  neq(column, value) { this.filters.push(row => row[column] !== value); return this; }
  is(column, value) { this.filters.push(row => row[column] === value); return this; }
  in(column, values) { this.filters.push(row => values.includes(row[column])); return this; }
  limit(value) { this.limitValue = value; return this; }
  result() {
    const error = this.storage.errors[this.table] || null;
    let rows = [...(this.storage.rows[this.table] || [])];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (this.limitValue !== null) rows = rows.slice(0, this.limitValue);
    return this.head
      ? { data: null, count: rows.length, error }
      : { data: rows, error };
  }
  async maybeSingle() {
    const result = this.result();
    return { data: result.data?.[0] || null, error: result.error };
  }
  then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
}

function validStorage() {
  return {
    errors: {},
    rows: {
      companies: [{
        id: "company-1",
        name: "Clinique Exemple",
      }],
      outbound_campaigns: [{
        id: "campaign-1",
        company_id: "company-1",
        name: "Relance",
        mission_type: "follow_up",
        script: "Voici un script suffisamment long.",
        status: "active",
        daily_call_limit: 10,
        outbound_phone_number_id: null,
      }],
      outbound_contacts: [{
        id: "outbound-contact-1",
        company_id: "company-1",
        campaign_id: "campaign-1",
        full_name: "Alice",
        phone: "+15145550123",
        language: "fr",
        status: "pending",
      }],
      voice_call_settings: [{
        company_id: "company-1",
        timezone: "America/Toronto",
        outbound_business_hours: {
          1: [{ start: "09:00", end: "20:00" }],
          2: [{ start: "09:00", end: "20:00" }],
          3: [{ start: "09:00", end: "20:00" }],
          4: [{ start: "09:00", end: "20:00" }],
          5: [{ start: "09:00", end: "20:00" }],
          6: [],
          7: [],
        },
      }],
      contacts: [{
        id: "contact-1",
        company_id: "company-1",
        full_name: "Alice",
        phone: "+15145550123",
        call_consent: true,
        status: "qualified",
        anonymized_at: null,
        merged_into_contact_id: null,
      }],
      dnc_list: [],
      subscriptions: [{
        company_id: "company-1",
        payment_status: "active",
        trial_ends_at: null,
        minutes_included: 400,
        minutes_used_current_period: 10,
        overage_policy: "block_at_limit",
      }],
      outbound_call_attempts: [],
      phone_numbers: [{
        id: "phone-1",
        company_id: "company-1",
        status: "active",
        elevenlabs_agent_id: "agent-1",
        elevenlabs_phone_number_id: "provider-phone-1",
      }],
    },
    from(table) { return new Query(this, table); },
  };
}

test("real preflight validates consent, DNC, subscription, quota and unique tenant phone", async () => {
  const storage = validStorage();
  const preflight = createOutboundPreflight({
    supabase: storage,
    now: () => fixedNow,
  });
  const result = await preflight(job);
  assert.equal(result.action, "dispatch");
  assert.equal(result.localCallDate, "2026-08-17");
  assert.equal(result.outboundPhone.id, "phone-1");

  storage.rows.dnc_list.push({
    id: "dnc-1",
    company_id: "company-1",
    phone: "+15145550123",
  });
  assert.deepEqual(await preflight(job), { action: "block", code: "dnc_blocked" });
  storage.rows.dnc_list.length = 0;

  storage.rows.contacts[0].call_consent = false;
  assert.deepEqual(await preflight(job), {
    action: "block",
    code: "call_consent_required",
  });
  storage.rows.contacts[0].call_consent = true;

  storage.rows.subscriptions[0].payment_status = "cancelled";
  assert.deepEqual(await preflight(job), {
    action: "block",
    code: "subscription_inactive",
  });
  storage.rows.subscriptions[0].payment_status = "active";

  storage.rows.subscriptions[0].payment_status = "trial";
  storage.rows.subscriptions[0].trial_ends_at = null;
  assert.deepEqual(await preflight(job), {
    action: "block",
    code: "trial_expired_or_invalid",
  });
  storage.rows.subscriptions[0].trial_ends_at = "2026-08-18T14:00:00.000Z";
  assert.equal((await preflight(job)).action, "dispatch");
  storage.rows.subscriptions[0].payment_status = "active";
  storage.rows.subscriptions[0].trial_ends_at = null;

  storage.rows.phone_numbers.push({
    ...storage.rows.phone_numbers[0],
    id: "phone-2",
  });
  assert.deepEqual(await preflight(job), {
    action: "block",
    code: "outbound_phone_ambiguous",
  });
});

test("DNC storage error fails closed instead of dispatching", async () => {
  const storage = validStorage();
  storage.errors.dnc_list = new Error("database unavailable");
  const preflight = createOutboundPreflight({
    supabase: storage,
    now: () => fixedNow,
  });
  await assert.rejects(preflight(job), error => {
    assert.equal(error.code, "dnc_lookup_failed");
    assert.equal(error.retryable, true);
    return true;
  });
});
