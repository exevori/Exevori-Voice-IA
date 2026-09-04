import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateTicketSla,
  createTicketService,
  escapeHtml,
  normalizeFrontendUrl,
} from "./service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class ReadQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.filters = [];
  }
  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  async maybeSingle() {
    this.client.reads.push({ table: this.table, filters: [...this.filters] });
    const row = (this.client.tables[this.table] || []).find(candidate =>
      this.filters.every(([column, value]) => candidate[column] === value)
    );
    return { data: row ? structuredClone(row) : null, error: null };
  }
}

function fakeSupabase({ tables = {}, rpc = {} } = {}) {
  return {
    tables: structuredClone(tables),
    reads: [],
    rpcCalls: [],
    from(table) { return new ReadQuery(this, table); },
    async rpc(name, args) {
      this.rpcCalls.push({ name, args: structuredClone(args) });
      return rpc[name]?.(args) || { data: null, error: null };
    },
  };
}

function baseTables(overrides = {}) {
  return {
    tickets: [{
      id: TICKET,
      company_id: COMPANY,
      ticket_number: "T-2026-000001",
      subject: "Téléphone <bloqué>",
      description: "Description",
      category: "technical",
      priority: "urgent",
      status: "open",
      created_by_user_id: USER,
      created_by_name: "Karim",
      created_by_email: "karim@example.test",
      assigned_to_name: null,
    }],
    ticket_messages: [{
      id: MESSAGE,
      ticket_id: TICKET,
      company_id: COMPANY,
      author_name: "Karim <script>",
      author_role: "client",
      body: "Bonjour <script>alert(1)</script>",
      is_internal: false,
    }],
    profiles: [{
      user_id: USER,
      company_id: COMPANY,
      full_name: "Karim",
      email: "karim@example.test",
      role: "company_admin",
      status: "active",
    }],
    notification_preferences: [],
    companies: [{ id: COMPANY, name: "Entreprise <Alpha>" }],
    ...overrides,
  };
}

test("SLA snapshot exposes the earliest live deadline and completed state", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  assert.deepEqual(calculateTicketSla({ status: "closed" }, now), {
    sla_status: "completed",
    sla_deadline: null,
    sla_milestone: null,
    sla_remaining_ms: null,
  });
  const breached = calculateTicketSla({
    status: "open",
    first_response_at: null,
    sla_first_response_due: "2026-09-01T11:00:00.000Z",
    sla_resolution_due: "2026-09-02T12:00:00.000Z",
  }, now);
  assert.equal(breached.sla_status, "breached");
  assert.equal(breached.sla_milestone, "first_response");
  assert.equal(breached.sla_remaining_ms, -3_600_000);

  const atRisk = calculateTicketSla({
    status: "in_progress",
    first_response_at: "2026-09-01T10:00:00.000Z",
    sla_resolution_due: "2026-09-01T15:00:00.000Z",
  }, now);
  assert.equal(atRisk.sla_status, "at_risk");
  assert.equal(atRisk.sla_milestone, "resolution");
});

test("ticket creation calls only the atomic RPC contract", async () => {
  const result = { ticket: { id: TICKET }, message: { id: MESSAGE } };
  const supabase = fakeSupabase({
    rpc: { create_support_ticket: () => ({ data: result, error: null }) },
  });
  const service = createTicketService({ supabase });
  const created = await service.createTicket({
    companyId: COMPANY,
    actorUserId: USER,
    actorName: "Karim",
    actorEmail: "karim@example.test",
    actorRole: "client",
    subject: "Test",
    description: "Description",
    category: "general",
    priority: "normal",
  });
  assert.deepEqual(created, result);
  assert.deepEqual(supabase.rpcCalls, [{
    name: "create_support_ticket",
    args: {
      p_company_id: COMPANY,
      p_actor_user_id: USER,
      p_actor_name: "Karim",
      p_actor_email: "karim@example.test",
      p_actor_role: "client",
      p_subject: "Test",
      p_description: "Description",
      p_category: "general",
      p_priority: "normal",
    },
  }]);
  assert.equal(supabase.reads.length, 0);
});

test("email delivery escapes customer HTML and uses Resend idempotency", async () => {
  const supabase = fakeSupabase({ tables: baseTables() });
  const sends = [];
  const resend = {
    emails: {
      send: async (...args) => {
        sends.push(args);
        return { data: { id: "resend-message" }, error: null };
      },
    },
  };
  const service = createTicketService({
    supabase,
    resend,
    frontendUrl: "https://app.example.test/ignored/path",
    emailFrom: "Support <support@example.test>",
  });
  const outcome = await service.sendEmailOutbox({
    id: "job",
    company_id: COMPANY,
    ticket_id: TICKET,
    message_id: MESSAGE,
    email_kind: "agent_reply",
    recipient_kind: "ticket_creator",
    recipient_user_id: USER,
    idempotency_key: `ticket/agent-reply/${MESSAGE}/creator`,
    context: {},
  });

  assert.deepEqual(outcome, { suppressed: false, providerMessageId: "resend-message" });
  assert.equal(sends.length, 1);
  const [payload, options] = sends[0];
  assert.equal(payload.to, "karim@example.test");
  assert.equal(payload.from, "Support <support@example.test>");
  assert.match(payload.html, /Karim &lt;script&gt;/);
  assert.match(payload.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(payload.html, /Téléphone &lt;bloqué&gt;/);
  assert.doesNotMatch(payload.html, /<script>/);
  assert.match(payload.html, /https:\/\/app\.example\.test\/tickets\?ticket=/);
  assert.equal(options.idempotencyKey, `ticket/agent-reply/${MESSAGE}/creator`);
});

test("internal notes and disabled preferences can never emit email", async () => {
  let sends = 0;
  const resend = { emails: { send: async () => { sends += 1; return { data: { id: "x" } }; } } };
  const internalTables = baseTables({
    ticket_messages: [{
      ...baseTables().ticket_messages[0],
      is_internal: true,
    }],
  });
  const internalService = createTicketService({
    supabase: fakeSupabase({ tables: internalTables }),
    resend,
    frontendUrl: "https://app.example.test",
  });
  const internal = await internalService.sendEmailOutbox({
    company_id: COMPANY,
    ticket_id: TICKET,
    message_id: MESSAGE,
    email_kind: "agent_reply",
    recipient_kind: "ticket_creator",
    recipient_user_id: USER,
    idempotency_key: "internal",
  });
  assert.deepEqual(internal, { suppressed: true, reason: "internal_note_never_emailed" });

  const preferenceService = createTicketService({
    supabase: fakeSupabase({
      tables: baseTables({
        notification_preferences: [{ user_id: USER, ticket_email: false }],
      }),
    }),
    resend,
    frontendUrl: "https://app.example.test",
  });
  const disabled = await preferenceService.sendEmailOutbox({
    company_id: COMPANY,
    ticket_id: TICKET,
    message_id: MESSAGE,
    email_kind: "agent_reply",
    recipient_kind: "ticket_creator",
    recipient_user_id: USER,
    idempotency_key: "disabled",
  });
  assert.deepEqual(disabled, { suppressed: true, reason: "ticket_email_disabled" });
  assert.equal(sends, 0);
});

test("Resend structured errors are treated as delivery failures", async () => {
  const service = createTicketService({
    supabase: fakeSupabase({ tables: baseTables() }),
    resend: {
      emails: {
        send: async () => ({
          data: null,
          error: { name: "rate_limit_exceeded", message: "retry later", statusCode: 429 },
        }),
      },
    },
    frontendUrl: "https://app.example.test",
  });
  await assert.rejects(
    service.sendEmailOutbox({
      company_id: COMPANY,
      ticket_id: TICKET,
      message_id: MESSAGE,
      email_kind: "agent_reply",
      recipient_kind: "ticket_creator",
      recipient_user_id: USER,
      idempotency_key: "resend-error",
    }),
    error => error.code === "rate_limit_exceeded" && error.providerStatusCode === 429
  );
});

test("HTML and frontend URL helpers are fail-closed", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(normalizeFrontendUrl("javascript:alert(1)"), null);
  assert.equal(normalizeFrontendUrl("https://app.example.test/path?q=x"), "https://app.example.test");
  assert.equal(normalizeFrontendUrl("https://one.test,https://two.test"), "https://one.test");
});
