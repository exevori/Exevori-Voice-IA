import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";

import express from "express";

process.env.SUPABASE_URL ||= "https://crm-tests.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-only-service-role-key";

const {
  CRM_PIPELINE,
  createCrmRouter,
  normalizeE164,
} = await import("./index.js");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_A_DUPLICATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIXED_NOW = new Date("2026-08-20T15:30:00.000Z");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.action = "select";
    this.payload = null;
    this.filters = [];
    this.selectOptions = {};
    this.orderValue = null;
    this.rangeValue = null;
    this.limitValue = null;
  }

  select(_columns = "*", options = {}) {
    this.selectOptions = options || {};
    return this;
  }

  insert(payload) {
    this.action = "insert";
    this.payload = clone(payload);
    return this;
  }

  update(payload) {
    this.action = "update";
    this.payload = clone(payload);
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ operator: "neq", column, value });
    return this;
  }

  contains(column, value) {
    this.filters.push({ operator: "contains", column, value: clone(value) });
    return this;
  }

  overlaps(column, value) {
    this.filters.push({ operator: "overlaps", column, value: clone(value) });
    return this;
  }

  in(column, value) {
    this.filters.push({ operator: "in", column, value: clone(value) });
    return this;
  }

  or(value) {
    this.filters.push({ operator: "or", value });
    return this;
  }

  order(column, options = {}) {
    this.orderValue = { column, ascending: options.ascending !== false };
    return this;
  }

  range(from, to) {
    this.rangeValue = { from, to };
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  maybeSingle() {
    return this.execute({ single: true });
  }

  single() {
    return this.execute({ single: true });
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  matches(row) {
    return this.filters.every(filter => {
      if (filter.operator === "or") return true;
      const actual = row?.[filter.column];
      if (filter.operator === "eq") return actual === filter.value;
      if (filter.operator === "neq") return actual !== filter.value;
      if (filter.operator === "in") return filter.value.includes(actual);
      if (filter.operator === "contains") {
        return Array.isArray(actual)
          && filter.value.every(item => actual.includes(item));
      }
      if (filter.operator === "overlaps") {
        return Array.isArray(actual)
          && filter.value.some(item => actual.includes(item));
      }
      return true;
    });
  }

  async execute({ single = false } = {}) {
    const logEntry = {
      table: this.table,
      action: this.action,
      payload: clone(this.payload),
      filters: clone(this.filters),
    };
    this.client.queryLog.push(logEntry);

    const error = this.client.errors[this.table]?.[this.action]
      || this.client.errors[this.table]
      || null;
    if (error) return { data: null, count: null, error };

    const tableRows = this.client.tables[this.table] ||= [];
    let rows = tableRows.filter(row => this.matches(row));

    if (this.action === "insert") {
      const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload])
        .map((row, index) => ({
          id: row.id || `eeeeeeee-eeee-4eee-8eee-${String(this.client.insertId + index).padStart(12, "0")}`,
          ...clone(row),
        }));
      this.client.insertId += inserted.length;
      tableRows.push(...inserted);
      rows = inserted;
    } else if (this.action === "update") {
      rows = tableRows.filter(row => this.matches(row));
      for (const row of rows) Object.assign(row, clone(this.payload));
    } else if (this.action === "delete") {
      const deleted = rows;
      this.client.tables[this.table] = tableRows.filter(row => !this.matches(row));
      rows = deleted;
    }

    if (this.orderValue) {
      const { column, ascending } = this.orderValue;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[column] ?? "").localeCompare(
          String(right[column] ?? "")
        );
        return ascending ? comparison : -comparison;
      });
    }

    const count = rows.length;
    if (this.rangeValue) {
      rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
    }
    if (this.limitValue !== null) rows = rows.slice(0, this.limitValue);

    return {
      data: single ? clone(rows[0] || null) : clone(rows),
      count: this.selectOptions.count === "exact" ? count : null,
      error: null,
    };
  }
}

class FakeSupabase {
  constructor({ tables = {}, rpcHandlers = {}, errors = {} } = {}) {
    this.tables = clone(tables);
    this.rpcHandlers = rpcHandlers;
    this.errors = errors;
    this.queryLog = [];
    this.rpcCalls = [];
    this.insertId = 1;
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  async rpc(name, args) {
    this.rpcCalls.push({ name, args: clone(args) });
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: [], error: null };
    return handler(clone(args));
  }
}

function userHeaders({
  companyId = COMPANY_A,
  role = "company_user",
  userId = USER_A,
} = {}) {
  return {
    "x-test-company-id": companyId,
    "x-test-role": role,
    "x-test-user-id": userId,
  };
}

function testApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: req.get("x-test-user-id") || USER_A,
      company_id: req.get("x-test-company-id") || COMPANY_A,
      role: req.get("x-test-role") || "company_user",
    };
    next();
  });
  app.use(
    "/contacts",
    createCrmRouter({
      supabaseClient: supabase,
      now: () => new Date(FIXED_NOW),
      logger: { error() {} },
    })
  );
  return app;
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function jsonRequest(method, body, headers = {}) {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function baseContact(overrides = {}) {
  return {
    id: CONTACT_A,
    company_id: COMPANY_A,
    full_name: "Alice Martin",
    phone: "+15145550123",
    email: "alice@example.test",
    company: "Atelier Alpha",
    status: "new",
    source: "manual",
    urgency: "normal",
    tags: [],
    merged_into_contact_id: null,
    ...overrides,
  };
}

test("normalizeE164 stores canonical international numbers and rejects non-E.164 input", () => {
  assert.equal(normalizeE164(" +1 (514) 555-0123 "), "+15145550123");
  assert.equal(normalizeE164("0033 1 42 68 53 00"), "+33142685300");
  assert.equal(normalizeE164("+442079460958"), "+442079460958");
  assert.equal(normalizeE164("5145550123"), null);
  assert.equal(normalizeE164("+0123456789"), null);
  assert.equal(normalizeE164("+15145550123 ext 4"), null);
  assert.equal(normalizeE164(null), null);
});

test("create requires E.164 and never accepts another tenant", async () => {
  const supabase = new FakeSupabase();
  await withServer(testApp(supabase), async baseUrl => {
    const invalid = await fetch(
      `${baseUrl}/contacts`,
      jsonRequest("POST", {
        full_name: "Invalid Phone",
        phone: "514-555-0123",
      }, userHeaders())
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "phone_e164_required");

    const crossTenant = await fetch(
      `${baseUrl}/contacts`,
      jsonRequest("POST", {
        company_id: COMPANY_B,
        full_name: "Cross Tenant",
        phone: "+15145550199",
      }, userHeaders())
    );
    assert.equal(crossTenant.status, 403);
    assert.equal((await crossTenant.json()).error, "forbidden_cross_tenant");
  });

  assert.equal(supabase.queryLog.length, 0);
  assert.equal(supabase.rpcCalls.length, 0);
});

test("create normalizes E.164/email and writes only in the authenticated tenant", async () => {
  const supabase = new FakeSupabase({
    rpcHandlers: {
      find_crm_contact_duplicates: async () => ({ data: [], error: null }),
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts`,
      jsonRequest("POST", {
        company_id: COMPANY_A,
        full_name: " Alice Martin ",
        phone: " +1 (514) 555-0123 ",
        email: " ALICE@EXAMPLE.TEST ",
        status: "new",
        archived_at: "2000-01-01T00:00:00.000Z",
      }, userHeaders())
    );
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.contact.company_id, COMPANY_A);
    assert.equal(payload.contact.phone, "+15145550123");
    assert.equal(payload.contact.email, "alice@example.test");
    assert.equal("archived_at" in payload.contact, false);
  });

  const duplicateCheck = supabase.rpcCalls[0];
  assert.equal(duplicateCheck.args.p_company_id, COMPANY_A);
  assert.equal(duplicateCheck.args.p_phone, "+15145550123");
  const insert = supabase.queryLog.find(item => item.action === "insert");
  assert.ok(insert);
  assert.equal(insert.payload.company_id, COMPANY_A);
  assert.equal("archived_at" in insert.payload, false);
});

test("list is tenant scoped and rejects a forged company_id", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        baseContact(),
        baseContact({ id: CONTACT_B, company_id: COMPANY_B, full_name: "Bob Beta" }),
      ],
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts`,
      { headers: userHeaders() }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.contacts.map(contact => contact.id), [CONTACT_A]);

    const forged = await fetch(
      `${baseUrl}/contacts?company_id=${COMPANY_B}`,
      { headers: userHeaders() }
    );
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).error, "forbidden_cross_tenant");
  });

  const listQuery = supabase.queryLog[0];
  assert.deepEqual(
    listQuery.filters.find(filter => filter.column === "company_id"),
    { operator: "eq", column: "company_id", value: COMPANY_A }
  );
});

test("a contact from another tenant returns 403 and no related history is read", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [baseContact({ id: CONTACT_B, company_id: COMPANY_B })],
      calls: [{ id: "call-b", company_id: COMPANY_B, contact_id: CONTACT_B }],
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts/${CONTACT_B}`,
      { headers: userHeaders() }
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden_cross_tenant");
  });

  assert.equal(
    supabase.queryLog.some(item => item.table === "calls"),
    false
  );
  assert.ok(
    supabase.queryLog[0].filters.some(
      filter => filter.column === "company_id" && filter.value === COMPANY_A
    )
  );
});

test("contact detail links learning suggestions through source_ids and created_at", async () => {
  const callId = "99999999-9999-4999-8999-999999999999";
  const suggestionId = "88888888-8888-4888-8888-888888888888";
  const supabase = new FakeSupabase({
    tables: {
      contacts: [baseContact()],
      contact_notes: [],
      calls: [{
        id: callId,
        company_id: COMPANY_A,
        contact_id: CONTACT_A,
        created_at: "2026-08-19T10:00:00.000Z",
      }],
      outbound_calls: [],
      emails: [],
      appointments: [],
      learning_suggestions: [{
        id: suggestionId,
        company_id: COMPANY_A,
        source_ids: [callId],
        status: "pending",
        created_at: "2026-08-20T10:00:00.000Z",
      }, {
        id: "77777777-7777-4777-8777-777777777777",
        company_id: COMPANY_B,
        source_ids: [callId],
        status: "pending",
        created_at: "2026-08-20T11:00:00.000Z",
      }],
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}`,
      { headers: userHeaders() }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.history.learning_suggestions.map(item => item.id),
      [suggestionId]
    );
    assert.equal(payload.stats.pending_learning_suggestions, 1);
  });

  const suggestionQuery = supabase.queryLog.find(
    item => item.table === "learning_suggestions"
  );
  assert.ok(suggestionQuery.filters.some(
    filter => filter.operator === "eq"
      && filter.column === "company_id"
      && filter.value === COMPANY_A
  ));
  assert.deepEqual(
    suggestionQuery.filters.find(filter => filter.operator === "overlaps"),
    { operator: "overlaps", column: "source_ids", value: [callId] }
  );
});

test("duplicate detection blocks insertion and stays tenant scoped", async () => {
  const duplicate = baseContact({
    similarity_score: 1,
    match_reasons: ["phone", "email"],
  });
  const supabase = new FakeSupabase({
    rpcHandlers: {
      find_crm_contact_duplicates: async args => ({
        data: args.p_company_id === COMPANY_A ? [duplicate] : [],
        error: null,
      }),
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts`,
      jsonRequest("POST", {
        full_name: "Alice Martin",
        phone: "+15145550123",
        email: "Alice@Example.Test",
        company: "Atelier Alpha",
      }, userHeaders())
    );
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error, "duplicate_contact");
    assert.deepEqual(payload.duplicates[0].match_reasons, ["phone", "email"]);
  });

  assert.equal(supabase.rpcCalls.length, 1);
  assert.equal(supabase.rpcCalls[0].args.p_company_id, COMPANY_A);
  assert.equal(supabase.rpcCalls[0].args.p_email, "alice@example.test");
  assert.equal(
    supabase.queryLog.some(item => item.action === "insert"),
    false
  );
});

test("merge requires an admin role and refuses a duplicate from another tenant", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        baseContact(),
        baseContact({ id: CONTACT_B, company_id: COMPANY_B, full_name: "Bob Beta" }),
      ],
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const forbiddenRole = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}/merge`,
      jsonRequest("POST", { duplicate_contact_id: CONTACT_B }, userHeaders())
    );
    assert.equal(forbiddenRole.status, 403);
    assert.equal((await forbiddenRole.json()).error, "forbidden");

    const crossTenant = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}/merge`,
      jsonRequest(
        "POST",
        { duplicate_contact_id: CONTACT_B },
        userHeaders({ role: "company_admin" })
      )
    );
    assert.equal(crossTenant.status, 403);
    assert.equal((await crossTenant.json()).error, "forbidden_cross_tenant");
  });

  assert.equal(supabase.rpcCalls.length, 0);
});

test("same-tenant merge calls only the restricted atomic RPC contract", async () => {
  const supabase = new FakeSupabase({
    tables: {
      contacts: [
        baseContact(),
        baseContact({ id: CONTACT_A_DUPLICATE, full_name: "Alice M." }),
      ],
    },
    rpcHandlers: {
      merge_crm_contacts: async args => ({
        data: {
          success: true,
          archived_contact_id: args.p_duplicate_contact_id,
          moved: { calls: 1 },
        },
        error: null,
      }),
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}/merge`,
      jsonRequest(
        "POST",
        { duplicate_contact_id: CONTACT_A_DUPLICATE },
        userHeaders({ role: "company_admin" })
      )
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).merged_contact_id, CONTACT_A_DUPLICATE);
  });

  assert.deepEqual(supabase.rpcCalls, [{
    name: "merge_crm_contacts",
    args: {
      p_company_id: COMPANY_A,
      p_primary_contact_id: CONTACT_A,
      p_duplicate_contact_id: CONTACT_A_DUPLICATE,
      p_actor_user_id: USER_A,
      p_actor_role: "company_admin",
    },
  }]);
});

test("DELETE performs a tenant-scoped soft archive and never deletes the row", async () => {
  const supabase = new FakeSupabase({
    tables: { contacts: [baseContact()] },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}`,
      { method: "DELETE", headers: userHeaders() }
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.archived, true);
  });

  assert.equal(supabase.tables.contacts.length, 1);
  assert.equal(supabase.tables.contacts[0].status, "archived");
  assert.equal(supabase.tables.contacts[0].archived_at, FIXED_NOW.toISOString());
  assert.equal(supabase.tables.contacts[0].archived_by, USER_A);
  assert.equal(
    supabase.queryLog.some(item => item.action === "delete"),
    false
  );
  const archive = supabase.queryLog.find(item => item.action === "update");
  assert.ok(
    archive.filters.some(
      filter => filter.column === "company_id" && filter.value === COMPANY_A
    )
  );
});

test("PATCH enforces the pipeline and allowlists mutable fields", async () => {
  const supabase = new FakeSupabase({
    tables: { contacts: [baseContact()] },
    rpcHandlers: {
      find_crm_contact_duplicates: async () => ({ data: [], error: null }),
    },
  });

  await withServer(testApp(supabase), async baseUrl => {
    const invalidStatus = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}`,
      jsonRequest("PATCH", { status: "hot" }, userHeaders())
    );
    assert.equal(invalidStatus.status, 400);
    assert.equal((await invalidStatus.json()).error, "invalid_contact_status");

    const response = await fetch(
      `${baseUrl}/contacts/${CONTACT_A}`,
      jsonRequest("PATCH", {
        company_id: COMPANY_A,
        id: CONTACT_B,
        full_name: "Alice Updated",
        status: "qualified",
        call_consent: false,
        call_consent_at: "2000-01-01T00:00:00.000Z",
        archived_at: "2000-01-01T00:00:00.000Z",
        archived_by: CONTACT_B,
        merged_into_contact_id: CONTACT_B,
        anonymized_at: "2000-01-01T00:00:00.000Z",
      }, userHeaders())
    );
    assert.equal(response.status, 200);
  });

  const updates = supabase.queryLog.filter(item => item.action === "update");
  assert.equal(updates.length, 1);
  const payload = updates[0].payload;
  assert.equal(payload.full_name, "Alice Updated");
  assert.equal(payload.status, "qualified");
  assert.equal(payload.call_consent, false);
  assert.equal(payload.call_consent_at, FIXED_NOW.toISOString());
  for (const forbidden of [
    "company_id",
    "id",
    "archived_at",
    "archived_by",
    "merged_into_contact_id",
    "anonymized_at",
  ]) {
    assert.equal(forbidden in payload, false, `${forbidden} must be blocked`);
  }
});

test("migration keeps the five-stage UI pipeline plus internal anonymized status", () => {
  assert.deepEqual(CRM_PIPELINE, ["new", "qualified", "client", "lost", "archived"]);
  const migration = fs.readFileSync(
    new URL("../../../migrations/011_crm_enrichment.sql", import.meta.url),
    "utf8"
  );

  assert.match(
    migration,
    /status IN \(\s*'new', 'qualified', 'client', 'lost', 'archived', 'anonymized'\s*\)/
  );
  assert.match(migration, /WHEN 'anonymized'\s+THEN 'anonymized'/);
  assert.match(
    migration,
    /status IN \('archived', 'anonymized'\)\s+OR phone ~ '\^\[\+\]\[1-9\]\[0-9\]\{7,14\}\$'/
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS call_consent boolean/);
  assert.doesNotMatch(migration, /call_consent boolean[^,;\n]*DEFAULT false/i);
});

test("migration synchronizes CRM refusal with DNC without removing manual entries", () => {
  const migration = fs.readFileSync(
    new URL("../../../migrations/011_crm_enrichment.sql", import.meta.url),
    "utf8"
  );
  const dncStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION crm_private.sync_contact_dnc"
  );
  const dncEnd = migration.indexOf(
    "CREATE INDEX IF NOT EXISTS idx_contacts_company_pipeline"
  );
  const dncFunction = migration.slice(dncStart, dncEnd);

  assert.ok(dncStart > 0 && dncEnd > dncStart);
  assert.match(dncFunction, /NEW\.call_consent IS FALSE/);
  assert.match(dncFunction, /INSERT INTO public\.dnc_list \(company_id, phone, reason, source\)/);
  assert.match(dncFunction, /'crm_call_consent_revoked',\s*'crm_consent'/);
  assert.match(dncFunction, /d\.source = 'crm_consent'/);
  assert.match(dncFunction, /d\.reason = 'crm_call_consent_revoked'/);
  assert.match(dncFunction, /remaining\.merged_into_contact_id IS NULL/);
  assert.doesNotMatch(
    dncFunction,
    /DELETE FROM public\.dnc_list[\s\S]*?WHERE d\.company_id = OLD\.company_id\s+AND d\.phone = OLD\.phone\s*;/
  );
});

test("migration guards every column required by rewrites and atomic merge", () => {
  const migration = fs.readFileSync(
    new URL("../../../migrations/011_crm_enrichment.sql", import.meta.url),
    "utf8"
  );
  const guardMessage = migration.indexOf(
    "Migration 011 aborted — missing required columns"
  );
  const firstRewrite = migration.indexOf(
    "UPDATE public.contacts\nSET next_action_note"
  );

  assert.ok(guardMessage > 0 && firstRewrite > guardMessage);
  for (const [table, column] of [
    ["appointments", "company_id"],
    ["appointments", "contact_id"],
    ["audit_log", "actor_user_id"],
    ["audit_log", "details"],
    ["calls", "company_id"],
    ["calls", "contact_id"],
    ["contact_notes", "company_id"],
    ["contact_notes", "contact_id"],
    ["contacts", "company_id"],
    ["contacts", "next_action"],
    ["contacts", "last_interaction_at"],
    ["contacts", "updated_at"],
    ["dnc_list", "company_id"],
    ["dnc_list", "phone"],
    ["email_drafts", "company_id"],
    ["email_drafts", "contact_id"],
    ["emails", "company_id"],
    ["emails", "contact_id"],
    ["outbound_calls", "company_id"],
    ["outbound_calls", "contact_id"],
  ]) {
    assert.match(
      migration,
      new RegExp("\\('" + table + "', '" + column + "'\\)")
    );
  }
});

test("migration keeps archive metadata and consent timestamps coherent", () => {
  const migration = fs.readFileSync(
    new URL("../../../migrations/011_crm_enrichment.sql", import.meta.url),
    "utf8"
  );

  assert.match(
    migration,
    /SET archived_at = COALESCE\(archived_at, updated_at, created_at, now\(\)\)/
  );
  assert.match(
    migration,
    /NEW\.status = 'archived'[\s\S]*?NEW\.archived_at := COALESCE\(NEW\.archived_at, now\(\)\)/
  );
  assert.match(migration, /status <> 'archived' OR archived_at IS NOT NULL/);
  const prepareStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION crm_private.prepare_contact_write"
  );
  const prepareEnd = migration.indexOf(
    "CREATE OR REPLACE FUNCTION crm_private.sync_contact_dnc"
  );
  const prepareFunction = migration.slice(prepareStart, prepareEnd);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  for (const channel of ["email", "sms", "call"]) {
    assert.match(
      migration,
      new RegExp(`${channel}_consent_at = CASE[\\s\\S]*?ELSE NULL[\\s\\S]*?END`)
    );
    assert.match(
      migration,
      new RegExp(
        `WHEN c\\.${channel}_consent IS FALSE[\\s\\S]*?THEN GREATEST\\([\\s\\S]*?`
        + `CASE WHEN c\\.${channel}_consent IS FALSE THEN c\\.${channel}_consent_at END,[\\s\\S]*?`
        + `CASE WHEN duplicate_contact\\.${channel}_consent IS FALSE THEN duplicate_contact\\.${channel}_consent_at END`
      )
    );
    assert.match(
      prepareFunction,
      new RegExp(
        "IF NEW\\." + channel + "_consent IS DISTINCT FROM OLD\\."
        + channel + "_consent THEN[\\s\\S]*?"
        + "WHEN NEW\\." + channel + "_consent_at IS NOT NULL[\\s\\S]*?"
        + "AND NEW\\." + channel + "_consent_at IS DISTINCT FROM OLD\\."
        + channel + "_consent_at[\\s\\S]*?"
        + "THEN NEW\\." + channel + "_consent_at[\\s\\S]*?"
        + "ELSE now\\(\\)"
      )
    );
  }
});

test("migration merge RPC is invoker-only, tenant-filtered, atomic and audited", () => {
  const migration = fs.readFileSync(
    new URL("../../../migrations/011_crm_enrichment.sql", import.meta.url),
    "utf8"
  );
  const mergeStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.merge_crm_contacts"
  );
  const mergeEnd = migration.indexOf("NOTIFY pgrst", mergeStart);
  const mergeFunction = migration.slice(mergeStart, mergeEnd);

  assert.ok(mergeStart > 0 && mergeEnd > mergeStart);
  assert.match(mergeFunction, /SECURITY INVOKER/);
  assert.match(mergeFunction, /SET search_path = ''/);
  assert.doesNotMatch(mergeFunction, /SECURITY DEFINER/);
  assert.match(mergeFunction, /ORDER BY c\.id\s+FOR UPDATE/);
  assert.match(mergeFunction, /USING ERRCODE = '42501'/);
  for (const table of [
    "contact_notes",
    "calls",
    "outbound_calls",
    "emails",
    "email_drafts",
    "appointments",
  ]) {
    assert.match(
      mergeFunction,
      new RegExp(`UPDATE public\\.${table}[\\s\\S]*?WHERE company_id = p_company_id[\\s\\S]*?contact_id = p_duplicate_contact_id`)
    );
  }
  assert.match(mergeFunction, /'crm\.contact_merged'/);
  assert.match(
    mergeFunction,
    /REVOKE ALL[\s\S]*?FROM PUBLIC, anon, authenticated/
  );
  assert.match(mergeFunction, /GRANT EXECUTE[\s\S]*?TO service_role/);
});
