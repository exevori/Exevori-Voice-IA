import assert from "node:assert/strict";
import test from "node:test";

import { createCalendarService } from "./service.js";
import { encryptCalendarSecret } from "./secrets.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_URI = "https://api.calendly.com/users/user-1";
const ORGANIZATION_URI = "https://api.calendly.com/organizations/org-1";
const NOW = new Date("2026-08-28T12:00:00.000Z");
const ORIGINAL_ENV = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  CALENDLY_CLIENT_ID: process.env.CALENDLY_CLIENT_ID,
  CALENDLY_CLIENT_SECRET: process.env.CALENDLY_CLIENT_SECRET,
};

test.before(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.CALENDLY_CLIENT_ID = "client-id";
  process.env.CALENDLY_CLIENT_SECRET = "client-secret";
});

test.after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class FakeQuery {
  constructor(owner, table) {
    this.owner = owner;
    this.table = table;
    this.operations = [];
  }

  operation(name, ...args) {
    this.operations.push({ name, args });
    return this;
  }

  select(...args) { return this.operation("select", ...args); }
  insert(...args) { return this.operation("insert", ...args); }
  update(...args) { return this.operation("update", ...args); }
  upsert(...args) { return this.operation("upsert", ...args); }
  eq(...args) { return this.operation("eq", ...args); }
  is(...args) { return this.operation("is", ...args); }
  neq(...args) { return this.operation("neq", ...args); }
  in(...args) { return this.operation("in", ...args); }
  gte(...args) { return this.operation("gte", ...args); }
  lte(...args) { return this.operation("lte", ...args); }
  limit(...args) { return this.operation("limit", ...args); }
  order(...args) { return this.operation("order", ...args); }

  maybeSingle() { return this.owner.execute(this.table, this.operations, "maybeSingle"); }
  single() { return this.owner.execute(this.table, this.operations, "single"); }
  then(resolve, reject) {
    return this.owner.execute(this.table, this.operations, "then").then(resolve, reject);
  }
}

function fakeSupabase(handler, rpcHandler) {
  return {
    queries: [],
    rpcs: [],
    from(table) { return new FakeQuery(this, table); },
    async execute(table, operations, terminal) {
      this.queries.push({ table, operations, terminal });
      return handler(table, operations, terminal);
    },
    async rpc(name, args) {
      this.rpcs.push({ name, args });
      return rpcHandler(name, args);
    },
  };
}

function tokenColumns(token, prefix) {
  const encrypted = encryptCalendarSecret(token, `${prefix}:${COMPANY}`);
  return {
    [`${prefix}_token_ciphertext`]: encrypted.ciphertext,
    [`${prefix}_token_iv`]: encrypted.iv,
    [`${prefix}_token_tag`]: encrypted.tag,
  };
}

function connection(overrides = {}) {
  return {
    id: CONNECTION,
    company_id: COMPANY,
    status: "connected",
    calendly_user_uri: USER_URI,
    calendly_organization_uri: ORGANIZATION_URI,
    granted_scopes: ["event_types:read", "scheduled_events:write"],
    token_expires_at: "2026-08-28T11:00:00.000Z",
    token_version: 1,
    ...tokenColumns("old-access", "access"),
    ...tokenColumns("single-use-refresh", "refresh"),
    ...overrides,
  };
}

test("expired access token is refreshed once and both rotated tokens are committed by the atomic RPC", async () => {
  const claimed = connection({
    refresh_lock_token: "11111111-1111-4111-8111-111111111111",
    refresh_locked_until: "2026-08-28T12:00:30.000Z",
  });
  const supabase = fakeSupabase(
    async (table, operations, terminal) => {
      assert.equal(table, "calendly_connections");
      assert.equal(terminal, "maybeSingle");
      assert.equal(operations.some(op => op.name === "update"), false);
      return { data: connection(), error: null };
    },
    async (name, args) => {
      if (name === "claim_calendly_token_refresh") return { data: [claimed], error: null };
      if (name === "complete_calendly_token_refresh") {
        assert.ok(args.p_access_token_ciphertext);
        assert.ok(args.p_refresh_token_ciphertext);
        assert.equal(args.p_lock_token.length > 0, true);
        return {
          data: [{
            ...claimed,
            token_version: 2,
            token_expires_at: args.p_token_expires_at,
            access_token_ciphertext: args.p_access_token_ciphertext,
            access_token_iv: args.p_access_token_iv,
            access_token_tag: args.p_access_token_tag,
            refresh_token_ciphertext: args.p_refresh_token_ciphertext,
            refresh_token_iv: args.p_refresh_token_iv,
            refresh_token_tag: args.p_refresh_token_tag,
            refresh_lock_token: null,
            refresh_locked_until: null,
          }],
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    }
  );
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("auth.calendly.com/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-single-use-refresh",
        expires_in: 7200,
        scope: "event_types:read scheduled_events:write",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ collection: [{ uri: "type-1", name: "Consultation" }] }), {
      status: 200,
    });
  };
  const service = createCalendarService({ supabase, fetchImpl, now: () => NOW });

  const types = await service.eventTypes(COMPANY);
  assert.equal(types[0].name, "Consultation");
  assert.equal(requests.filter(request => request.url.includes("/oauth/token")).length, 1);
  assert.deepEqual(
    supabase.rpcs.map(call => call.name),
    ["claim_calendly_token_refresh", "complete_calendly_token_refresh"]
  );
});

test("an ambiguous refresh failure invalidates the lease and requires fresh OAuth without retry", async () => {
  const supabase = fakeSupabase(
    async () => ({ data: connection(), error: null }),
    async name => {
      if (name === "claim_calendly_token_refresh") return { data: [connection()], error: null };
      if (name === "invalidate_calendly_token_refresh") return { data: true, error: null };
      throw new Error(name);
    }
  );
  let calls = 0;
  const service = createCalendarService({
    supabase,
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("connection reset after request write");
    },
  });

  await assert.rejects(
    service.eventTypes(COMPANY),
    error => error.code === "calendly_reconnect_required" && error.status === 409
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    supabase.rpcs.map(call => call.name),
    ["claim_calendly_token_refresh", "invalidate_calendly_token_refresh"]
  );
});

test("webhook idempotency key depends on connection, event type and invitee URI, not raw PII", async () => {
  const inserted = [];
  const supabase = fakeSupabase(
    async (table, operations) => {
      if (table === "calendly_connections") {
        return { data: connection(), error: null };
      }
      if (table === "calendly_webhook_events") {
        inserted.push(operations.find(op => op.name === "upsert").args[0]);
        return { data: { id: `event-${inserted.length}`, status: "pending" }, error: null };
      }
      throw new Error(table);
    },
    async name => { throw new Error(name); }
  );
  const service = createCalendarService({ supabase, now: () => NOW });
  const payload = {
    event: "invitee.created",
    created_by: USER_URI,
    payload: {
      uri: "https://api.calendly.com/scheduled_events/event-1/invitees/invitee-1",
      email: "person@example.test",
    },
  };

  await service.enqueueWebhook({
    connectionId: CONNECTION,
    payload,
    rawBody: Buffer.from(JSON.stringify(payload)),
    signatureTimestamp: 1787918400,
  });
  await service.enqueueWebhook({
    connectionId: CONNECTION,
    payload,
    rawBody: Buffer.from(JSON.stringify({ ...payload, transport_noise: true })),
    signatureTimestamp: 1787918401,
  });
  assert.equal(inserted[0].event_key, inserted[1].event_key);
  assert.equal(inserted[0].event_key.includes("person@example.test"), false);

  await assert.rejects(
    service.enqueueWebhook({
      connectionId: CONNECTION,
      payload: { ...payload, created_by: "https://api.calendly.com/users/other" },
      rawBody: Buffer.from("{}"),
      signatureTimestamp: 1,
    }),
    error => error.code === "calendly_webhook_owner_mismatch"
  );
});

test("Calendly privacy erasure validates the tenant-prefixed target and granted scope", async () => {
  const activeConnection = connection({
    token_expires_at: "2026-08-28T16:00:00.000Z",
    granted_scopes: ["event_types:read", "data_compliance:write"],
  });
  const supabase = fakeSupabase(
    async () => ({ data: activeConnection, error: null }),
    async name => { throw new Error(name); }
  );
  let request;
  const service = createCalendarService({
    supabase,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response("{}", { status: 202 });
    },
  });

  await service.deleteInviteeData(COMPANY, `${COMPANY}:person@example.test`);
  assert.equal(request.url, "https://api.calendly.com/data_compliance/deletion/invitees");
  assert.deepEqual(JSON.parse(request.options.body), { emails: ["person@example.test"] });
  await assert.rejects(
    service.deleteInviteeData(COMPANY, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:person@example.test`),
    error => error.code === "invalid_calendly_privacy_target"
  );
});

test("direct booking atomically claims its local intent before the single Calendly dispatch and records CRM effects", async () => {
  const contactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const bookingId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const appointmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const startTime = "2026-09-01T14:00:00.000Z";
  const eventTypeUri = "https://api.calendly.com/event_types/type-1";
  const eventUri = "https://api.calendly.com/scheduled_events/event-1";
  const inviteeUri = `${eventUri}/invitees/invitee-1`;
  const timeline = [];
  let outboxRows = [];
  const activeConnection = connection({
    token_expires_at: "2026-08-28T16:00:00.000Z",
    default_event_type_uri: eventTypeUri,
  });
  const appointment = {
    id: appointmentId,
    company_id: COMPANY,
    contact_id: contactId,
    start_at: startTime,
    end_at: "2026-09-01T14:30:00.000Z",
    date: "2026-09-01",
    time: "10:00:00",
    type: "Consultation",
    channel: "Zoom",
    status: "confirmed",
    calendly_cancel_url: "https://calendly.com/cancel/1",
    calendly_reschedule_url: "https://calendly.com/resched/1",
  };

  const supabase = fakeSupabase(
    async (table, operations, terminal) => {
      const operationNames = operations.map(op => op.name);
      if (table === "calendly_connections") {
        return { data: activeConnection, error: null };
      }
      if (table === "contacts") {
        if (operationNames.includes("update")) return { data: null, error: null };
        return {
          data: {
            id: contactId,
            company_id: COMPANY,
            full_name: "Alice Tremblay",
            email: "alice@example.test",
            phone: "+15145550123",
            status: "new",
          },
          error: null,
        };
      }
      if (table === "calendar_booking_requests") {
        if (operationNames.includes("insert")) {
          timeline.push("intent-inserted");
          return { data: { id: bookingId, company_id: COMPANY, status: "pending" }, error: null };
        }
        if (operationNames.includes("update") && terminal === "maybeSingle") {
          const payload = operations.find(op => op.name === "update").args[0];
          timeline.push(`intent-${payload.status}`);
          return { data: { id: bookingId }, error: null };
        }
        return { data: null, error: null };
      }
      if (table === "appointments") {
        if (operationNames.includes("upsert")) {
          timeline.push("appointment-upserted");
          return { data: appointment, error: null };
        }
        return { data: null, error: null };
      }
      if (table === "contact_notes") {
        timeline.push("crm-note");
        return { data: null, error: null };
      }
      if (table === "calendar_email_outbox") {
        outboxRows = operations.find(op => op.name === "upsert").args[0];
        timeline.push("email-outbox");
        return { data: null, error: null };
      }
      throw new Error(`unexpected table ${table}`);
    },
    async (name, args) => {
      assert.equal(name, "claim_calendar_booking_dispatch");
      timeline.push("dispatch-claimed");
      return {
        data: [{
          id: bookingId,
          company_id: COMPANY,
          status: "dispatching",
          dispatch_token: args.p_dispatch_token,
        }],
        error: null,
      };
    }
  );

  let inviteeCalls = 0;
  const fetchImpl = async (url, options) => {
    const value = String(url);
    if (value.includes("/event_types?")) {
      return new Response(JSON.stringify({
        collection: [{
          uri: eventTypeUri,
          name: "Consultation",
          active: true,
          duration: 30,
          locations: [],
        }],
      }), { status: 200 });
    }
    if (value.includes("/event_type_available_times?")) {
      return new Response(JSON.stringify({
        collection: [{ start_time: startTime, status: "available" }],
      }), { status: 200 });
    }
    if (value.endsWith("/invitees")) {
      inviteeCalls += 1;
      timeline.push("provider-dispatch");
      const body = JSON.parse(options.body);
      assert.equal(body.tracking.utm_content, bookingId);
      return new Response(JSON.stringify({
        resource: {
          uri: inviteeUri,
          event: eventUri,
          name: "Alice Tremblay",
          email: "alice@example.test",
          timezone: "America/Toronto",
          cancel_url: "https://calendly.com/cancel/1",
          reschedule_url: "https://calendly.com/resched/1",
        },
      }), { status: 201 });
    }
    if (value.endsWith("/scheduled_events/event-1")) {
      return new Response(JSON.stringify({
        resource: {
          uri: eventUri,
          start_time: startTime,
          end_time: "2026-09-01T14:30:00.000Z",
          name: "Consultation",
          event_type: eventTypeUri,
          location: { kind: "zoom", join_url: "https://zoom.example.test/meeting" },
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected Calendly URL ${value}`);
  };
  const service = createCalendarService({ supabase, fetchImpl, now: () => NOW });

  const result = await service.book(COMPANY, "ffffffff-ffff-4fff-8fff-ffffffffffff", {
    confirmed: true,
    idempotency_key: "booking-intent-123456",
    contact_id: contactId,
    event_type_uri: eventTypeUri,
    start_time: startTime,
    timezone: "America/Toronto",
    name: "Alice Tremblay",
    email: "alice@example.test",
    phone: "+15145550123",
  });

  assert.equal(result.reused, false);
  assert.equal(result.appointment.id, appointmentId);
  assert.equal(inviteeCalls, 1);
  assert.ok(timeline.indexOf("dispatch-claimed") < timeline.indexOf("provider-dispatch"));
  assert.ok(timeline.indexOf("provider-dispatch") < timeline.indexOf("intent-provider_succeeded"));
  assert.ok(timeline.includes("crm-note"));
  assert.equal(outboxRows.some(row => row.email_kind === "confirmation"), true);
  assert.equal(outboxRows.some(row => row.email_kind === "reminder"), true);
});
