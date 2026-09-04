import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createTicketsRouter } from "./index.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const TICKET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

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
    this.orders = [];
    this.rangeValue = null;
    this.limitValue = null;
    this.countRequested = false;
  }

  select(_columns = "*", options = {}) {
    this.countRequested = options.count === "exact";
    return this;
  }
  update(payload) { this.action = "update"; this.payload = clone(payload); return this; }
  eq(column, value) { this.filters.push({ column, value }); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  range(from, to) { this.rangeValue = { from, to }; return this; }
  limit(value) { this.limitValue = value; return this; }
  maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }

  matches(row) {
    return this.filters.every(filter => row?.[filter.column] === filter.value);
  }

  async execute(single) {
    this.client.queries.push({
      table: this.table,
      action: this.action,
      payload: clone(this.payload),
      filters: clone(this.filters),
    });
    let rows = (this.client.tables[this.table] || []).filter(row => this.matches(row));
    if (this.action === "update") {
      for (const row of rows) Object.assign(row, clone(this.payload));
    }
    for (const order of [...this.orders].reverse()) {
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[order.column] ?? "").localeCompare(String(right[order.column] ?? ""));
        return order.ascending ? comparison : -comparison;
      });
    }
    const count = rows.length;
    if (this.rangeValue) rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
    if (this.limitValue !== null) rows = rows.slice(0, this.limitValue);
    return {
      data: single ? clone(rows[0] || null) : clone(rows),
      count: this.countRequested ? count : null,
      error: null,
    };
  }
}

class FakeSupabase {
  constructor(tables = {}) {
    this.tables = clone(tables);
    this.queries = [];
  }
  from(table) { return new FakeQuery(this, table); }
  async rpc() { return { data: null, error: null }; }
}

function ticket(overrides = {}) {
  return {
    id: TICKET_A,
    company_id: COMPANY_A,
    ticket_number: "T-2026-000001",
    subject: "Appels entrants",
    description: "La ligne ne sonne plus.",
    category: "technical",
    priority: "high",
    status: "open",
    created_by_user_id: USER_A,
    created_by_name: "Karim",
    created_by_email: "secret-client@example.test",
    assigned_to_user_id: ADMIN,
    assigned_to_name: "Agent Exevori",
    sla_first_response_due: "2026-09-01T16:00:00.000Z",
    sla_resolution_due: "2026-09-02T12:00:00.000Z",
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    resolution_summary: null,
    satisfaction_rating: null,
    internal_notes: "note secrète",
    created_at: "2026-09-01T11:00:00.000Z",
    updated_at: "2026-09-01T11:00:00.000Z",
    companies: { name: "Alpha" },
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ticket_id: TICKET_A,
    company_id: COMPANY_A,
    author_name: "Karim",
    author_role: "client",
    body: "Bonjour",
    is_internal: false,
    attachments: [],
    created_at: "2026-09-01T11:00:00.000Z",
    ...overrides,
  };
}

function serviceStub(overrides = {}) {
  return {
    createCalls: [],
    appendCalls: [],
    async createTicket(input) {
      this.createCalls.push(clone(input));
      return { ticket: ticket(), message: message() };
    },
    async appendMessage(input) {
      this.appendCalls.push(clone(input));
      return {
        ticket: ticket({ status: "in_progress" }),
        message: message({
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          author_name: input.actorName,
          author_role: input.actorRole,
          body: input.body,
          is_internal: input.isInternal,
        }),
      };
    },
    ...overrides,
  };
}

function testApp(supabase, service) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: req.get("x-user-id") || USER_A,
      email: req.get("x-user-email") || "karim@example.test",
      company_id: req.get("x-company-id") || COMPANY_A,
      role: req.get("x-role") || "company_user",
      profile: { full_name: req.get("x-user-name") || "Karim Authentifié" },
    };
    next();
  });
  app.use("/tickets", createTicketsRouter({
    supabase,
    service,
    now: () => new Date(FIXED_NOW),
    logger: { error() {} },
  }));
  return app;
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function request(method, body, headers = {}) {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test("client list is tenant-scoped and strips private ticket fields", async () => {
  const supabase = new FakeSupabase({
    tickets: [ticket(), ticket({ id: TICKET_B, company_id: COMPANY_B, ticket_number: "T-2026-000002" })],
  });
  await withServer(testApp(supabase, serviceStub()), async baseUrl => {
    const response = await fetch(`${baseUrl}/tickets`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.tickets.map(item => item.id), [TICKET_A]);
    const visible = payload.tickets[0];
    for (const forbidden of [
      "company_id", "created_by_user_id", "created_by_email",
      "assigned_to_user_id", "internal_notes",
    ]) {
      assert.equal(forbidden in visible, false, `${forbidden} leaked`);
    }
  });
  assert.ok(supabase.queries[0].filters.some(filter =>
    filter.column === "company_id" && filter.value === COMPANY_A
  ));
});

test("three cross-tenant entry points return 403 before any mutation or thread read", async () => {
  const supabase = new FakeSupabase({
    tickets: [ticket({ id: TICKET_B, company_id: COMPANY_B })],
    ticket_messages: [message({ ticket_id: TICKET_B, company_id: COMPANY_B })],
  });
  const service = serviceStub();
  await withServer(testApp(supabase, service), async baseUrl => {
    const detail = await fetch(`${baseUrl}/tickets/${TICKET_B}`);
    assert.equal(detail.status, 403);
    assert.equal((await detail.json()).error, "forbidden_cross_tenant");

    const reply = await fetch(
      `${baseUrl}/tickets/${TICKET_B}/messages`,
      request("POST", { body: "Tentative" })
    );
    assert.equal(reply.status, 403);
    assert.equal((await reply.json()).error, "forbidden_cross_tenant");

    const create = await fetch(
      `${baseUrl}/tickets`,
      request("POST", {
        company_id: COMPANY_B,
        subject: "Tentative",
        description: "Autre entreprise",
      })
    );
    assert.equal(create.status, 403);
    assert.equal((await create.json()).error, "forbidden_cross_tenant");
  });
  assert.equal(service.createCalls.length, 0);
  assert.equal(service.appendCalls.length, 0);
  assert.equal(supabase.queries.some(query => query.table === "ticket_messages"), false);
});

test("client detail can never receive internal notes or admin-only identifiers", async () => {
  const supabase = new FakeSupabase({
    tickets: [ticket()],
    ticket_messages: [
      message(),
      message({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        author_role: "exevori_agent",
        body: "Secret interne",
        is_internal: true,
      }),
    ],
  });
  await withServer(testApp(supabase, serviceStub()), async baseUrl => {
    const response = await fetch(`${baseUrl}/tickets/${TICKET_A}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.messages.map(item => item.body), ["Bonjour"]);
    assert.equal("is_internal" in payload.messages[0], false);
    assert.equal("internal_notes" in payload.ticket, false);
    assert.equal("created_by_email" in payload.ticket, false);
  });
  const threadQuery = supabase.queries.find(query => query.table === "ticket_messages");
  assert.ok(threadQuery.filters.some(filter =>
    filter.column === "is_internal" && filter.value === false
  ));
});

test("client cannot forge an internal note", async () => {
  const supabase = new FakeSupabase({ tickets: [ticket()] });
  const service = serviceStub();
  await withServer(testApp(supabase, service), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/tickets/${TICKET_A}/messages`,
      request("POST", { body: "Secret", is_internal: true })
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "internal_notes_admin_only");
  });
  assert.equal(service.appendCalls.length, 0);
});

test("ticket creation trusts the authenticated actor, not spoofed body identity", async () => {
  const supabase = new FakeSupabase();
  const service = serviceStub();
  await withServer(testApp(supabase, service), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/tickets`,
      request("POST", {
        company_id: COMPANY_A,
        subject: "Besoin de support",
        description: "Le scénario ne fonctionne pas.",
        category: "bug",
        priority: "urgent",
        created_by_name: "Nom usurpé",
        created_by_email: "attacker@example.test",
      })
    );
    assert.equal(response.status, 201);
  });
  assert.equal(service.createCalls.length, 1);
  assert.equal(service.createCalls[0].actorName, "Karim Authentifié");
  assert.equal(service.createCalls[0].actorEmail, "karim@example.test");
  assert.equal(service.createCalls[0].actorRole, "client");
});

test("admin agent directory exposes no email and assignment uses database identity", async () => {
  const supabase = new FakeSupabase({
    tickets: [ticket()],
    profiles: [{
      user_id: ADMIN,
      full_name: "Agent Fiable",
      email: "private-admin@example.test",
      role: "super_admin",
      status: "active",
    }],
  });
  const headers = { "x-role": "super_admin", "x-user-id": ADMIN };
  await withServer(testApp(supabase, serviceStub()), async baseUrl => {
    const agents = await fetch(`${baseUrl}/tickets/agents`, { headers });
    assert.equal(agents.status, 200);
    assert.deepEqual(await agents.json(), {
      agents: [{ user_id: ADMIN, full_name: "Agent Fiable" }],
    });

    const assignment = await fetch(
      `${baseUrl}/tickets/${TICKET_A}/assign`,
      request("PATCH", {
        assigned_to_user_id: ADMIN,
        assigned_to_name: "Nom usurpé",
      }, headers)
    );
    assert.equal(assignment.status, 200);
    assert.equal((await assignment.json()).ticket.assigned_to_name, "Agent Fiable");
  });
  const update = supabase.queries.find(query => query.table === "tickets" && query.action === "update");
  assert.equal(update.payload.assigned_to_name, "Agent Fiable");
  assert.ok(update.filters.some(filter => filter.column === "company_id" && filter.value === COMPANY_A));
});

test("priority changes preserve the original SLA clock", async () => {
  const supabase = new FakeSupabase({ tickets: [ticket()] });
  const headers = { "x-role": "super_admin", "x-user-id": ADMIN };
  await withServer(testApp(supabase, serviceStub()), async baseUrl => {
    const response = await fetch(
      `${baseUrl}/tickets/${TICKET_A}/priority`,
      request("PATCH", { priority: "urgent" }, headers)
    );
    assert.equal(response.status, 200);
  });
  const update = supabase.queries.find(query =>
    query.table === "tickets" && query.action === "update"
  );
  assert.equal(update.payload.sla_first_response_due, "2026-09-01T12:00:00.000Z");
  assert.equal(update.payload.sla_resolution_due, "2026-09-01T15:00:00.000Z");
});

test("named stats route is reachable and averages start at ticket creation", async () => {
  const supabase = new FakeSupabase({
    tickets: [ticket({
      status: "resolved",
      first_response_at: "2026-09-01T11:30:00.000Z",
      resolved_at: "2026-09-01T12:00:00.000Z",
      satisfaction_rating: 5,
    })],
  });
  await withServer(testApp(supabase, serviceStub()), async baseUrl => {
    const response = await fetch(`${baseUrl}/tickets/stats/overview`);
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.equal(stats.total, 1);
    assert.equal(stats.resolved, 1);
    assert.equal(stats.avg_first_response_minutes, 30);
    assert.equal(stats.avg_resolution_hours, 1);
    assert.equal(stats.avg_satisfaction, 5);
  });
});
