import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import express from "express";

import {
  createPrivacyRouter,
  processPrivacyExternalDeletions,
} from "./index.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTACT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTACT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTBOUND_CONTACT_A = "abababab-abab-4bab-8bab-abababababab";
const RELATED_CONTACT_A = "acacacac-acac-4cac-8cac-acacacacacac";
const CALL_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const UNLINKED_CALL_A = "12121212-1212-4212-8212-121212121212";
const CALL_B = "13131313-1313-4313-8313-131313131313";
const EMAIL_A = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const QUEUE_ONE = "10000000-0000-4000-8000-000000000001";
const QUEUE_TWO = "10000000-0000-4000-8000-000000000002";
const QUEUE_THREE = "10000000-0000-4000-8000-000000000003";
const FIXED_REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const FIXED_NOW = new Date("2026-07-27T16:00:00.000Z");

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.options = {};
    this.payload = null;
    this.singleResult = false;
    this.rangeValue = null;
    this.orderValue = null;
  }

  select(_columns = "*", options = {}) {
    this.options = options || {};
    return this;
  }

  insert(payload) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.action = "update";
    this.payload = payload;
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ operator: "is", column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ operator: "in", column, value: values });
    return this;
  }

  ilike(column, value) {
    this.filters.push({ operator: "ilike", column, value });
    return this;
  }

  order(column, options = {}) {
    this.orderValue = {
      column,
      ascending: options.ascending !== false,
    };
    return this;
  }

  range(from, to) {
    this.rangeValue = { from, to };
    return this;
  }

  maybeSingle() {
    this.singleResult = true;
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  matchingRows() {
    const rows = this.client.tables[this.table] || [];
    return rows.filter(row =>
      this.filters.every(filter => {
        if (filter.operator === "in") {
          return filter.value.includes(row[filter.column]);
        }
        if (filter.operator === "is") {
          return row[filter.column] === filter.value;
        }
        if (filter.operator === "ilike") {
          const expected = String(filter.value).replace(/\\([\\%_])/g, "$1");
          return (
            typeof row[filter.column] === "string" &&
            row[filter.column].toLowerCase() === expected.toLowerCase()
          );
        }
        return row[filter.column] === filter.value;
      })
    );
  }

  async execute() {
    this.client.queryLog.push({
      table: this.table,
      action: this.action,
      filters: structuredClone(this.filters),
      payload: this.payload ? structuredClone(this.payload) : null,
      options: structuredClone(this.options),
      range: this.rangeValue ? structuredClone(this.rangeValue) : null,
      order: this.orderValue ? structuredClone(this.orderValue) : null,
    });

    const configuredError =
      this.client.errors[`${this.table}:${this.action}`] ||
      this.client.errors[this.table];
    if (configuredError) return { data: null, error: configuredError };

    if (this.action === "insert") {
      const inserted = Array.isArray(this.payload)
        ? this.payload
        : [this.payload];
      this.client.tables[this.table] ||= [];
      this.client.tables[this.table].push(...structuredClone(inserted));
      return { data: structuredClone(inserted), error: null };
    }

    if (this.action === "update") {
      const rows = this.matchingRows();
      for (const row of rows) Object.assign(row, structuredClone(this.payload));
      return { data: structuredClone(rows), error: null };
    }

    let rows = this.matchingRows();
    if (this.orderValue) {
      const { column, ascending } = this.orderValue;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[column] ?? "").localeCompare(
          String(right[column] ?? "")
        );
        return ascending ? comparison : -comparison;
      });
    }
    if (this.options.head) {
      return { data: null, error: null, count: rows.length };
    }
    if (this.rangeValue) {
      rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
    }
    if (this.singleResult) {
      return { data: structuredClone(rows[0] || null), error: null };
    }
    return { data: structuredClone(rows), error: null };
  }
}

class FakeSupabase {
  constructor({ tables = {}, errors = {}, rpcHandlers = {} } = {}) {
    this.tables = structuredClone(tables);
    this.errors = errors;
    this.rpcHandlers = rpcHandlers;
    this.queryLog = [];
    this.rpcCalls = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  async rpc(name, args) {
    this.rpcCalls.push({ name, args: structuredClone(args) });
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: [], error: null };
    return handler(args);
  }
}

function userHeaders({
  role = "company_admin",
  companyId = COMPANY_A,
  userId = USER_A,
} = {}) {
  return {
    "x-test-role": role,
    "x-test-company": companyId,
    "x-test-user": userId,
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get("x-test-role");
    if (role) {
      req.user = {
        id: req.get("x-test-user"),
        role,
        company_id: req.get("x-test-company") || null,
      };
    }
    next();
  });
  app.use("/privacy", router);

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function jsonRequest(method, body, headers = {}) {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function testRouter(supabase, overrides = {}) {
  return createPrivacyRouter({
    supabase,
    now: () => FIXED_NOW,
    makeUuid: () => FIXED_REQUEST_ID,
    logger: { error() {} },
    fetchImpl: async () => ({ status: 204 }),
    ...overrides,
  });
}

test("privacy routes reject unauthenticated, unprivileged and invalid targets", async () => {
  const supabase = new FakeSupabase();
  await withServer(testRouter(supabase), async baseUrl => {
    const unauthenticated = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest("POST", { contact_id: CONTACT_A })
    );
    assert.equal(unauthenticated.status, 401);

    const companyUser = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: CONTACT_A },
        userHeaders({ role: "company_user" })
      )
    );
    assert.equal(companyUser.status, 403);

    const invalidUuid = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: "not-a-uuid" },
        userHeaders()
      )
    );
    assert.equal(invalidUuid.status, 400);

    const missingSuperAdminCompany = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: CONTACT_A },
        userHeaders({
          role: "super_admin",
          companyId: "",
          userId: SUPER_USER,
        })
      )
    );
    assert.equal(missingSuperAdminCompany.status, 400);
  });
});

test("cross-tenant export is 403 and the ownership query has both filters", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        {
          id: CONTACT_B,
          company_id: COMPANY_B,
          full_name: "Contact tenant B",
        },
      ],
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: CONTACT_B },
        userHeaders({ companyId: COMPANY_A })
      )
    );
    assert.equal(response.status, 403);
  });

  const contactQuery = supabase.queryLog.find(
    query => query.table === "contacts"
  );
  assert.ok(contactQuery);
  assert.deepEqual(contactQuery.filters, [
    { operator: "eq", column: "company_id", value: COMPANY_A },
    { operator: "eq", column: "id", value: CONTACT_B },
  ]);
  assert.equal(
    supabase.queryLog.some(query => query.table === "audit_log"),
    false
  );
});

test("cross-tenant outbound target is 403 before any related CRM data is read", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        {
          id: RELATED_CONTACT_A,
          company_id: COMPANY_A,
          phone: "+15145550777",
          email: "shared@example.test",
        },
      ],
      outbound_contacts: [
        {
          id: OUTBOUND_CONTACT_A,
          company_id: COMPANY_B,
          phone: "+15145550777",
          email: "shared@example.test",
        },
      ],
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: OUTBOUND_CONTACT_A },
        userHeaders({ companyId: COMPANY_A })
      )
    );
    assert.equal(response.status, 403);
  });

  const outboundOwnershipQuery = supabase.queryLog.find(
    query => query.table === "outbound_contacts"
  );
  assert.ok(outboundOwnershipQuery);
  assert.deepEqual(outboundOwnershipQuery.filters, [
    { operator: "eq", column: "company_id", value: COMPANY_A },
    { operator: "eq", column: "id", value: OUTBOUND_CONTACT_A },
  ]);
  assert.equal(
    supabase.queryLog.some(
      query => query.table === "contacts" && query.range !== null
    ),
    false
  );
  assert.equal(
    supabase.queryLog.some(query => query.table === "audit_log"),
    false
  );
});

test("complete export is attachment/no-store, tenant scoped and audited without PII", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        {
          id: CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Alice Exemple",
          email: "alice@example.test",
          phone: "+15145550123",
        },
      ],
      contact_notes: [
        { id: "note-1", company_id: COMPANY_A, contact_id: CONTACT_A, note: "Suivi" },
      ],
      outbound_contacts: [
        {
          id: OUTBOUND_CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Alice campagne",
          email: "ALICE@example.test",
          phone: "+15145550123",
          credentials: "must-not-be-exported",
        },
      ],
      calls: [
        {
          id: CALL_A,
          company_id: COMPANY_A,
          contact_id: CONTACT_A,
          ai_transcript: "Bonjour",
          elevenlabs_conversation_id: "conv-secret-id",
          twilio_call_sid: "CA-provider-call-id",
        },
      ],
      call_recordings: [
        {
          id: "recording-1",
          company_id: COMPANY_A,
          call_id: CALL_A,
          url: "https://provider.invalid/audio",
          transcript: "Bonjour",
        },
      ],
      call_events: [
        {
          id: "event-1",
          company_id: COMPANY_A,
          call_id: CALL_A,
          payload: {
            external_id: "provider-event-id",
            access_token: "must-not-be-exported",
            state: "completed",
          },
        },
      ],
      outbound_calls: [],
      emails: [
        {
          id: EMAIL_A,
          company_id: COMPANY_A,
          contact_id: CONTACT_A,
          from_email: "alice@example.test",
        },
      ],
      email_drafts: [
        {
          id: "draft-1",
          company_id: COMPANY_A,
          email_id: EMAIL_A,
          to_email: "alice@example.test",
        },
      ],
      appointments: [],
      learning_suggestions: [
        {
          id: "learning-1",
          company_id: COMPANY_A,
          source: `call:${CALL_A}`,
          question: "Question",
        },
      ],
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: CONTACT_A },
        userHeaders()
      )
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.match(response.headers.get("content-disposition"), /attachment/);

    const payload = await response.json();
    assert.equal(payload.target_type, "contact");
    assert.deepEqual(payload.data.related_contacts, []);
    assert.equal(payload.data.calls.length, 1);
    assert.equal(payload.data.outbound_contacts.length, 0);
    assert.equal(payload.data.email_drafts.length, 1);
    assert.equal(payload.data.learning_suggestions.length, 1);
    assert.equal(
      "elevenlabs_conversation_id" in payload.data.calls[0],
      true
    );
    assert.equal("url" in payload.data.call_recordings[0], true);
    assert.equal(
      "external_id" in payload.data.call_events[0].payload,
      true
    );
    assert.equal(payload.data.calls[0].twilio_call_sid, "CA-provider-call-id");
    assert.equal(
      "access_token" in payload.data.call_events[0].payload,
      false
    );
  });

  const relatedTables = [
    "contact_notes",
    "calls",
    "call_recordings",
    "call_events",
    "outbound_calls",
    "emails",
    "email_drafts",
    "appointments",
    "learning_suggestions",
  ];
  for (const table of relatedTables) {
    const query = supabase.queryLog.find(
      item => item.table === table && item.range !== null
    );
    assert.ok(query, `${table} doit etre interrogee`);
    assert.ok(
      query.filters.some(
        filter =>
          filter.column === "company_id" && filter.value === COMPANY_A
      ),
      `${table} doit etre filtree par company_id`
    );
  }
  const directOutboundQuery = supabase.queryLog.find(
    item => item.table === "outbound_contacts" && item.action === "select"
  );
  assert.ok(directOutboundQuery);
  assert.ok(
    directOutboundQuery.filters.some(
      filter =>
        filter.column === "company_id" && filter.value === COMPANY_A
    )
  );

  const auditInsert = supabase.queryLog.find(
    query => query.table === "audit_log" && query.action === "insert"
  );
  assert.ok(auditInsert);
  assert.equal(auditInsert.payload.entity_type, "contact");
  const serializedAudit = JSON.stringify(auditInsert.payload);
  assert.equal(serializedAudit.includes("alice@example.test"), false);
  assert.equal(serializedAudit.includes("+15145550123"), false);
  assert.equal(serializedAudit.includes("conv-secret-id"), false);
});

test("export paginates PostgREST collections beyond the 1000-row server cap", async () => {
  const contactNotes = Array.from({ length: 1_001 }, (_, index) => ({
    id: `note-${String(index).padStart(4, "0")}`,
    company_id: COMPANY_A,
    contact_id: CONTACT_A,
    note: `Note ${index}`,
  }));
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        {
          id: CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Sujet pagination",
        },
      ],
      outbound_contacts: [],
      contact_notes: contactNotes,
      calls: [],
      outbound_calls: [],
      emails: [],
      appointments: [],
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest("POST", { contact_id: CONTACT_A }, userHeaders())
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.contact_notes.length, 1_001);
  });

  const notePages = supabase.queryLog.filter(
    query => query.table === "contact_notes" && query.action === "select"
  );
  assert.deepEqual(
    notePages.map(page => page.range),
    [
      { from: 0, to: 999 },
      { from: 1_000, to: 1_999 },
    ]
  );
  assert.equal(
    notePages.every(page => page.order?.column === "id"),
    true
  );

  for (const table of [
    "calls",
    "outbound_calls",
    "emails",
    "appointments",
  ]) {
    const collectionQuery = supabase.queryLog.find(
      query => query.table === table && query.range !== null
    );
    assert.ok(collectionQuery, `${table} doit utiliser range()`);
    assert.equal(collectionQuery.order?.column, "id");
  }
});

test("export fails closed when the mandatory audit insert fails", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        { id: CONTACT_A, company_id: COMPANY_A, full_name: "Alice" },
      ],
      contact_notes: [],
      calls: [],
      outbound_calls: [],
      emails: [],
      appointments: [],
    },
    errors: { "audit_log:insert": { message: "database unavailable" } },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: CONTACT_A },
        userHeaders()
      )
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.data, undefined);
  });
});

test("standalone outbound contact can be exported and anonymized with the same contact_id RPC contract", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [],
      outbound_contacts: [
        {
          id: OUTBOUND_CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Prospect autonome",
          phone: "+15145550999",
          email: "prospect@example.test",
          api_key: "never-export-this",
        },
      ],
      contact_notes: [],
      calls: [],
      outbound_calls: [
        {
          id: "outbound-call-1",
          company_id: COMPANY_A,
          contact_id: OUTBOUND_CONTACT_A,
          contact_phone: "+15145550999",
          twilio_call_sid: "CA-standalone-provider-id",
        },
      ],
      emails: [],
      appointments: [],
      privacy_external_deletions: [],
    },
    rpcHandlers: {
      anonymize_contact_data: async () => ({
        data: { anonymized: true, external_deletions_enqueued: 0 },
        error: null,
      }),
      claim_privacy_external_deletions: async () => ({
        data: [],
        error: null,
      }),
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const exported = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: OUTBOUND_CONTACT_A },
        userHeaders()
      )
    );
    assert.equal(exported.status, 200);
    const exportPayload = await exported.json();
    assert.equal(exportPayload.target_type, "outbound_contact");
    assert.equal(exportPayload.data.contact, null);
    assert.deepEqual(exportPayload.data.related_contacts, []);
    assert.equal(exportPayload.data.outbound_contacts.length, 1);
    assert.equal(exportPayload.data.outbound_calls.length, 0);
    assert.equal(
      "api_key" in exportPayload.data.outbound_contacts[0],
      false
    );

    const anonymized = await fetch(
      `${baseUrl}/privacy/anonymize/${OUTBOUND_CONTACT_A}`,
      jsonRequest(
        "DELETE",
        { confirm: true, reason: "Demande du prospect" },
        userHeaders()
      )
    );
    assert.equal(anonymized.status, 200);
    assert.equal(
      (await anonymized.json()).target_type,
      "outbound_contact"
    );
  });

  const anonymizeCall = supabase.rpcCalls.find(
    call => call.name === "anonymize_contact_data"
  );
  assert.equal(anonymizeCall.args.p_company_id, COMPANY_A);
  assert.equal(anonymizeCall.args.p_contact_id, OUTBOUND_CONTACT_A);
});

test("outbound target never infers identity from shared phone or email", async () => {
  const sharedPhone = "+15145550888";
  const sharedEmail = "linked@example.test";
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        {
          id: RELATED_CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Prospect devenu client",
          phone: sharedPhone,
          email: "LINKED@example.test",
        },
        {
          id: CONTACT_B,
          company_id: COMPANY_B,
          full_name: "Contact autre tenant",
          phone: sharedPhone,
          email: sharedEmail,
        },
      ],
      outbound_contacts: [
        {
          id: OUTBOUND_CONTACT_A,
          company_id: COMPANY_A,
          full_name: "Prospect campagne",
          phone: sharedPhone,
          email: sharedEmail,
        },
      ],
      contact_notes: [
        {
          id: "note-a",
          company_id: COMPANY_A,
          contact_id: RELATED_CONTACT_A,
          note: "Note tenant A",
        },
        {
          id: "note-b",
          company_id: COMPANY_B,
          contact_id: CONTACT_B,
          note: "Note tenant B",
        },
      ],
      calls: [
        {
          id: CALL_A,
          company_id: COMPANY_A,
          contact_id: RELATED_CONTACT_A,
          caller_phone: sharedPhone,
          ai_summary: "Appel CRM lie",
        },
        {
          id: UNLINKED_CALL_A,
          company_id: COMPANY_A,
          contact_id: null,
          caller_phone: sharedPhone,
          ai_summary: "Appel retrouve par telephone",
        },
        {
          id: CALL_B,
          company_id: COMPANY_B,
          contact_id: CONTACT_B,
          caller_phone: sharedPhone,
          ai_summary: "Ne doit jamais sortir",
        },
      ],
      call_recordings: [
        {
          id: "recording-a",
          company_id: COMPANY_A,
          call_id: CALL_A,
          transcript: "Enregistrement CRM",
        },
        {
          id: "recording-unlinked-a",
          company_id: COMPANY_A,
          call_id: UNLINKED_CALL_A,
          transcript: "Enregistrement retrouve",
        },
        {
          id: "recording-b",
          company_id: COMPANY_B,
          call_id: CALL_B,
          transcript: "Enregistrement autre tenant",
        },
      ],
      call_events: [
        {
          id: "event-a",
          company_id: COMPANY_A,
          call_id: UNLINKED_CALL_A,
          event_type: "completed",
        },
        {
          id: "event-b",
          company_id: COMPANY_B,
          call_id: CALL_B,
          event_type: "completed",
        },
      ],
      outbound_calls: [
        {
          id: "outbound-call-a",
          company_id: COMPANY_A,
          contact_id: OUTBOUND_CONTACT_A,
          contact_phone: sharedPhone,
        },
        {
          id: "outbound-call-b",
          company_id: COMPANY_B,
          contact_id: CONTACT_B,
          contact_phone: sharedPhone,
        },
      ],
      emails: [
        {
          id: EMAIL_A,
          company_id: COMPANY_A,
          contact_id: RELATED_CONTACT_A,
          subject: "Courriel tenant A",
        },
        {
          id: "14141414-1414-4414-8414-141414141414",
          company_id: COMPANY_B,
          contact_id: CONTACT_B,
          subject: "Courriel tenant B",
        },
      ],
      email_drafts: [
        {
          id: "draft-a",
          company_id: COMPANY_A,
          email_id: EMAIL_A,
          subject: "Brouillon tenant A",
        },
      ],
      appointments: [
        {
          id: "appointment-a",
          company_id: COMPANY_A,
          contact_id: RELATED_CONTACT_A,
          title: "Rendez-vous tenant A",
        },
        {
          id: "appointment-b",
          company_id: COMPANY_B,
          contact_id: CONTACT_B,
          title: "Rendez-vous tenant B",
        },
      ],
      learning_suggestions: [
        {
          id: "learning-a",
          company_id: COMPANY_A,
          source: `call:${UNLINKED_CALL_A}`,
          question: "Suggestion tenant A",
        },
        {
          id: "learning-b",
          company_id: COMPANY_B,
          source: `call:${CALL_B}`,
          question: "Suggestion tenant B",
        },
      ],
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/data-export`,
      jsonRequest(
        "POST",
        { contact_id: OUTBOUND_CONTACT_A },
        userHeaders()
      )
    );
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.target_type, "outbound_contact");
    assert.equal(payload.data.contact, null);
    assert.equal(payload.data.outbound_contacts.length, 1);
    assert.deepEqual(payload.data.related_contacts, []);
    assert.deepEqual(payload.data.calls, []);
    assert.deepEqual(payload.data.call_recordings, []);
    assert.deepEqual(payload.data.call_events, []);
    assert.deepEqual(payload.data.contact_notes, []);
    assert.deepEqual(payload.data.emails, []);
    assert.deepEqual(payload.data.email_drafts, []);
    assert.deepEqual(payload.data.appointments, []);
    assert.deepEqual(payload.data.learning_suggestions, []);
    assert.deepEqual(payload.data.outbound_calls, []);
    assert.equal(JSON.stringify(payload).includes("tenant B"), false);
  });

  const relatedContactQueries = supabase.queryLog.filter(
    query => query.table === "contacts" && query.range !== null
  );
  assert.equal(relatedContactQueries.length, 0);

  const inferredRelationQueries = supabase.queryLog.filter(
    item =>
      [
        "contact_notes",
        "calls",
        "call_recordings",
        "call_events",
        "outbound_calls",
        "emails",
        "email_drafts",
        "appointments",
        "learning_suggestions",
      ].includes(item.table) && item.range !== null
  );
  assert.equal(inferredRelationQueries.length, 0);

  const auditInsert = supabase.queryLog.find(
    query => query.table === "audit_log" && query.action === "insert"
  );
  assert.ok(auditInsert);
  assert.equal(auditInsert.payload.entity_type, "outbound_contact");
  assert.equal(
    auditInsert.payload.details.record_counts.related_contacts,
    0
  );
});

test("anonymize requires confirmation/reason and calls the atomic RPC", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [{ id: CONTACT_A, company_id: COMPANY_A }],
      privacy_external_deletions: [],
    },
    rpcHandlers: {
      anonymize_contact_data: async () => ({
        data: { anonymized: true, external_deletions_enqueued: 0 },
        error: null,
      }),
      claim_privacy_external_deletions: async () => ({
        data: [],
        error: null,
      }),
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const withoutConfirmation = await fetch(
      `${baseUrl}/privacy/anonymize/${CONTACT_A}`,
      jsonRequest(
        "DELETE",
        { reason: "Demande valide" },
        userHeaders()
      )
    );
    assert.equal(withoutConfirmation.status, 400);

    const response = await fetch(
      `${baseUrl}/privacy/anonymize/${CONTACT_A}`,
      jsonRequest(
        "DELETE",
        {
          confirm: true,
          reason: "Demande de alice@example.test au +1 514 555 0123",
        },
        userHeaders()
      )
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.external_cleanup, "completed");
    assert.equal(JSON.stringify(payload).includes("alice@example.test"), false);
  });

  const anonymizeCall = supabase.rpcCalls.find(
    call => call.name === "anonymize_contact_data"
  );
  assert.deepEqual(anonymizeCall.args, {
    p_company_id: COMPANY_A,
    p_contact_id: CONTACT_A,
    p_actor_user_id: USER_A,
    p_actor_role: "company_admin",
    p_reason: "Demande de [courriel masque] au [telephone masque]",
    p_request_id: FIXED_REQUEST_ID,
  });
});

test("external queue deletes ElevenLabs/Twilio, keeps Calendly in retry and exposes counts only", async () => {
  const jobs = [
    {
      id: QUEUE_ONE,
      company_id: COMPANY_A,
      target_contact_id: CONTACT_A,
      provider: "elevenlabs",
      resource_type: "conversation",
      external_id: "conversation-sensitive-id",
      status: "processing",
      attempts: 1,
    },
    {
      id: QUEUE_TWO,
      company_id: COMPANY_A,
      target_contact_id: CONTACT_A,
      provider: "twilio",
      resource_type: "recording",
      external_id: "recording-sensitive-id",
      status: "processing",
      attempts: 1,
    },
    {
      id: QUEUE_THREE,
      company_id: COMPANY_A,
      target_contact_id: CONTACT_A,
      provider: "calendly",
      resource_type: "scheduled_event",
      external_id: "event-sensitive-id",
      status: "processing",
      attempts: 1,
    },
  ];
  const requests = [];
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: jobs },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: jobs,
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({
    supabase,
    companyId: COMPANY_A,
    contactId: CONTACT_A,
    now: () => FIXED_NOW,
    elevenLabsApiKey: "elevenlabs-test-secret",
    twilioAccountSid: "AC_TEST_ACCOUNT",
    twilioAuthToken: "twilio-test-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: url.includes("elevenlabs") ? 404 : 204 };
    },
  });

  assert.deepEqual(summary, {
    claimed: 3,
    completed: 2,
    retry: 1,
    failed: 0,
    pending: true,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests.every(request => request.options.method === "DELETE"), true);

  const queueRows = supabase.tables.privacy_external_deletions;
  assert.equal(queueRows.find(row => row.id === QUEUE_ONE).status, "completed");
  assert.equal(queueRows.find(row => row.id === QUEUE_TWO).status, "completed");
  assert.equal(queueRows.find(row => row.id === QUEUE_ONE).next_attempt_at, null);
  assert.equal(queueRows.find(row => row.id === QUEUE_TWO).next_attempt_at, null);
  const calendly = queueRows.find(row => row.id === QUEUE_THREE);
  assert.equal(calendly.status, "retry");
  assert.equal(calendly.last_error, "provider_not_configured");
  assert.ok(calendly.next_attempt_at > FIXED_NOW.toISOString());

  const serializedSummary = JSON.stringify(summary);
  for (const sensitiveValue of [
    "conversation-sensitive-id",
    "recording-sensitive-id",
    "event-sensitive-id",
    "elevenlabs-test-secret",
    "twilio-test-secret",
  ]) {
    assert.equal(serializedSummary.includes(sensitiveValue), false);
  }
});

test("external queue moves an exhausted provider deletion to failed", async () => {
  const job = {
    id: QUEUE_ONE,
    company_id: COMPANY_A,
    target_contact_id: CONTACT_A,
    provider: "calendly",
    resource_type: "scheduled_event",
    external_id: "event-terminal-failure",
    status: "processing",
    attempts: 8,
  };
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: [job] },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: [job],
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({
    supabase,
    maxAttempts: 8,
    now: () => FIXED_NOW,
    deleters: {
      calendly: async () => ({
        outcome: "retry",
        errorCode: "provider_request_failed",
      }),
    },
  });

  assert.deepEqual(summary, {
    claimed: 1,
    completed: 0,
    retry: 0,
    failed: 1,
    pending: false,
  });
  const failed = supabase.tables.privacy_external_deletions[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.next_attempt_at, null);
  assert.equal(failed.locked_at, null);
  assert.equal(failed.completed_at, FIXED_NOW.toISOString());
  assert.equal(failed.last_error, "provider_request_failed");
});

test("global provider cleanup processes legacy jobs without company_id", async () => {
  const job = {
    id: QUEUE_ONE,
    company_id: null,
    target_contact_id: null,
    provider: "elevenlabs",
    resource_type: "conversation",
    external_id: "orphan-conversation",
    status: "processing",
    attempts: 1,
  };
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: [job] },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: [job],
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({
    supabase,
    now: () => FIXED_NOW,
    deleters: {
      elevenlabs: async () => ({ outcome: "completed" }),
    },
  });

  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, false);
  assert.equal(
    supabase.tables.privacy_external_deletions[0].status,
    "completed"
  );
  const update = supabase.queryLog.find(
    query =>
      query.table === "privacy_external_deletions" &&
      query.action === "update"
  );
  assert.ok(update);
  assert.deepEqual(
    update.filters.find(filter => filter.column === "company_id"),
    { operator: "is", column: "company_id", value: null }
  );
});

test("tenant-scoped provider cleanup rejects an orphan queue item", async () => {
  const orphanJob = {
    id: QUEUE_ONE,
    company_id: null,
    target_contact_id: null,
    provider: "elevenlabs",
    resource_type: "conversation",
    external_id: "orphan-conversation",
    status: "processing",
    attempts: 1,
  };
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: [orphanJob] },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: [orphanJob],
        error: null,
      }),
    },
  });

  await assert.rejects(
    processPrivacyExternalDeletions({
      supabase,
      companyId: COMPANY_A,
      deleters: {
        elevenlabs: async () => ({ outcome: "completed" }),
      },
    }),
    /invalid_external_queue_item/
  );
});

test("Twilio call deletion uses the Calls resource and completes on 204", async () => {
  const job = {
    id: QUEUE_ONE,
    company_id: COMPANY_A,
    target_contact_id: CONTACT_A,
    provider: "twilio",
    resource_type: "call",
    external_id: "CA-sensitive-call-id",
    status: "processing",
    attempts: 1,
  };
  const requests = [];
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: [job] },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: [job],
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({
    supabase,
    companyId: COMPANY_A,
    contactId: CONTACT_A,
    now: () => FIXED_NOW,
    twilioAccountSid: "AC_TEST_ACCOUNT",
    twilioAuthToken: "twilio-test-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: 204 };
    },
  });

  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, false);
  assert.equal(requests.length, 1);
  assert.match(
    requests[0].url,
    /\/Accounts\/AC_TEST_ACCOUNT\/Calls\/CA-sensitive-call-id\.json$/
  );
  assert.equal(requests[0].options.method, "DELETE");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test("ElevenLabs and Twilio provider deletes abort at the configured timeout", async () => {
  const jobs = [
    {
      id: QUEUE_ONE,
      company_id: COMPANY_A,
      target_contact_id: CONTACT_A,
      provider: "elevenlabs",
      resource_type: "conversation",
      external_id: "conversation-timeout",
      status: "processing",
      attempts: 1,
    },
    {
      id: QUEUE_TWO,
      company_id: COMPANY_A,
      target_contact_id: CONTACT_A,
      provider: "twilio",
      resource_type: "recording",
      external_id: "recording-timeout",
      status: "processing",
      attempts: 1,
    },
  ];
  const signals = [];
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: jobs },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: jobs,
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({
    supabase,
    companyId: COMPANY_A,
    contactId: CONTACT_A,
    now: () => FIXED_NOW,
    providerTimeoutMs: 5,
    elevenLabsApiKey: "elevenlabs-test-secret",
    twilioAccountSid: "AC_TEST_ACCOUNT",
    twilioAuthToken: "twilio-test-secret",
    fetchImpl: async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      }),
  });

  assert.equal(summary.completed, 0);
  assert.equal(summary.retry, 2);
  assert.equal(summary.pending, true);
  assert.equal(signals.length, 2);
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.deepEqual(
    supabase.tables.privacy_external_deletions.map(row => row.last_error),
    ["provider_timeout", "provider_timeout"]
  );
});

test("global queue summary stays pending when retry jobs are not claimable yet", async () => {
  const futureRetry = {
    id: QUEUE_ONE,
    company_id: COMPANY_A,
    target_contact_id: CONTACT_A,
    provider: "elevenlabs",
    resource_type: "conversation",
    external_id: "future-conversation",
    status: "retry",
    attempts: 2,
    next_attempt_at: "2026-07-27T17:00:00.000Z",
  };
  const supabase = new FakeSupabase({
    tables: { privacy_external_deletions: [futureRetry] },
    rpcHandlers: {
      claim_privacy_external_deletions: async () => ({
        data: [],
        error: null,
      }),
    },
  });

  const summary = await processPrivacyExternalDeletions({ supabase });

  assert.deepEqual(summary, {
    claimed: 0,
    completed: 0,
    retry: 0,
    failed: 0,
    pending: true,
  });
  const globalCount = supabase.queryLog.find(
    query =>
      query.table === "privacy_external_deletions" &&
      query.options?.head === true
  );
  assert.ok(globalCount);
  assert.equal(
    globalCount.filters.some(filter => filter.column === "company_id"),
    false
  );
});

test("anonymize returns 202 while a provider deletion remains retryable", async () => {
  const queueJob = {
    id: QUEUE_THREE,
    company_id: COMPANY_A,
    target_contact_id: CONTACT_A,
    provider: "calendly",
    resource_type: "scheduled_event",
    external_id: "never-return-this-id",
    status: "processing",
    attempts: 1,
  };
  const supabase = new FakeSupabase({
    tables: {
      contacts: [{ id: CONTACT_A, company_id: COMPANY_A }],
      privacy_external_deletions: [queueJob],
    },
    rpcHandlers: {
      anonymize_contact_data: async () => ({
        data: { anonymized: true, external_deletions_enqueued: 1 },
        error: null,
      }),
      claim_privacy_external_deletions: async () => ({
        data: [queueJob],
        error: null,
      }),
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/anonymize/${CONTACT_A}`,
      jsonRequest(
        "DELETE",
        { confirm: true, reason: "Demande client valide" },
        userHeaders()
      )
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.external_cleanup, "pending");
    assert.equal(JSON.stringify(payload).includes("never-return-this-id"), false);
  });
});

test("anonymize never reports completed while a terminal provider failure remains", async () => {
  const failedJob = {
    id: QUEUE_THREE,
    company_id: COMPANY_A,
    target_contact_id: CONTACT_A,
    provider: "calendly",
    resource_type: "scheduled_event",
    external_id: "failed-provider-resource",
    status: "failed",
    attempts: 8,
  };
  const supabase = new FakeSupabase({
    tables: {
      contacts: [{ id: CONTACT_A, company_id: COMPANY_A }],
      privacy_external_deletions: [failedJob],
    },
    rpcHandlers: {
      anonymize_contact_data: async () => ({
        data: { anonymized: true },
        error: null,
      }),
      claim_privacy_external_deletions: async () => ({
        data: [],
        error: null,
      }),
    },
  });

  await withServer(testRouter(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/privacy/anonymize/${CONTACT_A}`,
      jsonRequest(
        "DELETE",
        { confirm: true, reason: "Nouvelle tentative explicite" },
        userHeaders()
      )
    );
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.external_cleanup, "pending");
    assert.equal(
      JSON.stringify(payload).includes("failed-provider-resource"),
      false
    );
  });

  const countQuery = [...supabase.queryLog].reverse().find(
    query =>
      query.table === "privacy_external_deletions"
      && query.options?.head === true
  );
  assert.ok(
    countQuery.filters.some(
      filter =>
        filter.operator === "in"
        && filter.column === "status"
        && filter.value.includes("failed")
    )
  );
});
