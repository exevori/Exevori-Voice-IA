import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import express from "express";

import {
  buildDashboardWindows,
  calculateDashboardMetrics,
  createDashboardRouter,
} from "./index.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = new Date("2026-07-27T16:00:00.000Z");

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.filters = [];
    this.options = {};
    this.orderValue = null;
    this.limitValue = null;
    this.rangeValue = null;
    this.singleResult = false;
  }

  select(_columns = "*", options = {}) {
    this.options = options || {};
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: "gte", column, value });
    return this;
  }

  lt(column, value) {
    this.filters.push({ operator: "lt", column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ operator: "in", column, value });
    return this;
  }

  order(column, options = {}) {
    this.orderValue = {
      column,
      ascending: options.ascending !== false,
    };
    return this;
  }

  limit(value) {
    this.limitValue = value;
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

  async execute() {
    this.client.queryLog.push({
      table: this.table,
      filters: structuredClone(this.filters),
      head: Boolean(this.options.head),
      order: this.orderValue ? structuredClone(this.orderValue) : null,
    });

    const configuredError = this.client.errors[this.table];
    if (configuredError) {
      return { data: null, count: null, error: configuredError };
    }

    let rows = (this.client.tables[this.table] || []).filter(row =>
      this.filters.every(filter => {
        const actual = row[filter.column];
        if (filter.operator === "in") {
          return filter.value.includes(actual);
        }
        if (filter.operator === "gte") {
          return String(actual ?? "") >= String(filter.value);
        }
        if (filter.operator === "lt") {
          return String(actual ?? "") < String(filter.value);
        }
        return actual === filter.value;
      })
    );

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
      return { data: null, count: rows.length, error: null };
    }
    if (this.rangeValue) {
      rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
    }
    if (this.limitValue !== null) {
      rows = rows.slice(0, this.limitValue);
    }
    if (this.singleResult) {
      return { data: structuredClone(rows[0] || null), error: null };
    }
    return { data: structuredClone(rows), error: null };
  }
}

class FakeSupabase {
  constructor({ tables = {}, errors = {} } = {}) {
    this.tables = structuredClone(tables);
    this.errors = errors;
    this.queryLog = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }
}

async function withServer(supabase, callback) {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.get("x-test-role");
    if (role) {
      req.user = {
        role,
        company_id: req.get("x-test-company") || null,
      };
    }
    next();
  });
  app.use(
    "/dashboard",
    createDashboardRouter({
      supabase,
      now: () => FIXED_NOW,
      logger: { error() {} },
    })
  );

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

function userHeaders({
  role = "company_admin",
  companyId = COMPANY_A,
} = {}) {
  return {
    "x-test-role": role,
    "x-test-company": companyId,
  };
}

function baseTables(overrides = {}) {
  return {
    calls: [],
    outbound_calls: [],
    appointments: [],
    contacts: [],
    tickets: [],
    subscriptions: [],
    learning_suggestions: [],
    ...overrides,
  };
}

test("dashboard windows use a rolling seven-day range and Monday week", () => {
  assert.deepEqual(buildDashboardWindows(FIXED_NOW), {
    calls_7d: {
      start: "2026-07-20T16:00:00.000Z",
      end: "2026-07-27T16:00:00.000Z",
    },
    appointments_week: {
      start: "2026-07-27",
      end: "2026-08-03",
    },
    month: {
      start: "2026-07-01",
      end: "2026-08-01",
    },
  });
});

test("metrics document ROI and count completed calls without an outcome as unresolved", () => {
  const result = calculateDashboardMetrics({
    inboundCalls: [
      { status: "completed", outcome: "info_provided", duration_seconds: 300 },
      { status: "completed", outcome: null, duration_seconds: 60 },
      { status: "in_progress", outcome: null, duration_seconds: 100 },
      { status: "transferred", outcome: "transferred_human", duration_seconds: 300 },
    ],
    outboundCalls: [
      { status: "completed", outcome: "interested", duration_seconds: 240 },
      { status: "queued", duration_seconds: 0 },
    ],
    appointments: [
      { status: "confirmed" },
      { status: "cancelled" },
    ],
    contactsCreated: 2,
    openTickets: 3,
    subscription: {
      minutes_used_current_period: "120.5",
      minutes_included: 400,
      current_period_start: "2026-07-01",
      current_period_end: "2026-08-01",
    },
  });

  assert.deepEqual(result.kpis, {
    calls_7d: { total: 6, inbound: 4, outbound: 2 },
    appointments_this_week: 1,
    contacts_created_7d: 2,
    ai_resolution_rate_pct: 33,
    ai_resolved_calls_7d: 1,
    ai_resolution_eligible_calls_7d: 3,
    tickets_open: 3,
  });
  assert.deepEqual(result.roi, {
    time_saved_seconds: 780,
    time_saved_hours: 0.2,
    calculation:
      "Somme des durées des appels terminés traités par l'IA, moins 120 secondes par transfert humain.",
    assumptions: { transfer_takeover_seconds: 120 },
  });
  assert.deepEqual(result.minutes, {
    used: 120.5,
    included: 400,
    remaining: 279.5,
    overage: 0,
    usage_pct: 30,
    period_start: "2026-07-01",
    period_end: "2026-08-01",
  });
});

test("stats use only the authenticated tenant and return real aggregates", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables({
      calls: [
        {
          id: "call-a-1",
          company_id: COMPANY_A,
          status: "completed",
          outcome: "appointment_booked",
          duration_seconds: 180,
          created_at: "2026-07-25T12:00:00.000Z",
        },
        {
          id: "call-b-1",
          company_id: COMPANY_B,
          status: "completed",
          outcome: "resolved",
          duration_seconds: 999,
          created_at: "2026-07-25T12:00:00.000Z",
        },
      ],
      outbound_calls: [
        {
          id: "out-a-1",
          company_id: COMPANY_A,
          status: "completed",
          outcome: "interested",
          duration_seconds: 120,
          created_at: "2026-07-26T12:00:00.000Z",
        },
      ],
      appointments: [
        {
          id: "appointment-a",
          company_id: COMPANY_A,
          status: "confirmed",
          date: "2026-07-30",
        },
      ],
      contacts: [
        {
          id: "contact-a",
          company_id: COMPANY_A,
          created_at: "2026-07-24T12:00:00.000Z",
        },
        {
          id: "contact-old",
          company_id: COMPANY_A,
          created_at: "2026-07-01T12:00:00.000Z",
        },
      ],
      tickets: [
        { id: "ticket-a", company_id: COMPANY_A, status: "open" },
        { id: "ticket-closed", company_id: COMPANY_A, status: "closed" },
      ],
      subscriptions: [
        {
          company_id: COMPANY_A,
          minutes_used_current_period: 25,
          minutes_included: 400,
          current_period_start: "2026-07-01",
          current_period_end: "2026-08-01",
        },
      ],
    }),
  });

  await withServer(supabase, async baseUrl => {
    const response = await fetch(`${baseUrl}/dashboard/stats`, {
      headers: userHeaders(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(payload.kpis.calls_7d, {
      total: 2,
      inbound: 1,
      outbound: 1,
    });
    assert.equal(payload.kpis.appointments_this_week, 1);
    assert.equal(payload.kpis.contacts_created_7d, 1);
    assert.equal(payload.kpis.ai_resolution_rate_pct, 100);
    assert.equal(payload.kpis.tickets_open, 1);
    assert.equal(payload.minutes.used, 25);

    for (const query of supabase.queryLog) {
      const companyFilter = query.filters.find(
        filter => filter.column === "company_id"
      );
      assert.equal(companyFilter?.value, COMPANY_A);
    }
  });
});

test("tenant selection rejects cross-tenant access and requires a target for super_admin", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });

  await withServer(supabase, async baseUrl => {
    const crossTenant = await fetch(
      `${baseUrl}/dashboard/stats?company_id=${COMPANY_B}`,
      { headers: userHeaders() }
    );
    assert.equal(crossTenant.status, 403);
    assert.equal((await crossTenant.json()).error, "cross_tenant_forbidden");

    const missingSuperAdminTarget = await fetch(
      `${baseUrl}/dashboard/stats`,
      {
        headers: userHeaders({
          role: "super_admin",
          companyId: "",
        }),
      }
    );
    assert.equal(missingSuperAdminTarget.status, 400);
    assert.equal(
      (await missingSuperAdminTarget.json()).error,
      "company_id_required"
    );

    assert.equal(supabase.queryLog.length, 0);

    const allowedSuperAdminTarget = await fetch(
      `${baseUrl}/dashboard/stats?company_id=${COMPANY_B}`,
      {
        headers: userHeaders({
          role: "super_admin",
          companyId: "",
        }),
      }
    );
    assert.equal(allowedSuperAdminTarget.status, 200);
    for (const query of supabase.queryLog) {
      const companyFilter = query.filters.find(
        filter => filter.column === "company_id"
      );
      assert.equal(companyFilter?.value, COMPANY_B);
    }
  });
});

test("empty tenant returns zeros and an empty activity instead of synthetic data", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });

  await withServer(supabase, async baseUrl => {
    const statsResponse = await fetch(`${baseUrl}/dashboard/stats`, {
      headers: userHeaders(),
    });
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.deepEqual(stats.kpis.calls_7d, {
      total: 0,
      inbound: 0,
      outbound: 0,
    });
    assert.equal(stats.kpis.appointments_this_week, 0);
    assert.equal(stats.kpis.contacts_created_7d, 0);
    assert.equal(stats.kpis.ai_resolution_rate_pct, 0);
    assert.equal(stats.kpis.tickets_open, 0);
    assert.equal(stats.roi.time_saved_seconds, 0);
    assert.deepEqual(stats.minutes, {
      used: null,
      included: null,
      remaining: null,
      overage: null,
      usage_pct: null,
      period_start: null,
      period_end: null,
    });
    assert.equal(stats.has_activity, false);

    const activityResponse = await fetch(`${baseUrl}/dashboard/activity`, {
      headers: userHeaders(),
    });
    assert.equal(activityResponse.status, 200);
    assert.deepEqual(await activityResponse.json(), {
      activities: [],
      total_returned: 0,
      has_activity: false,
    });
  });
});

test("activity combines only real V1 interactions and sorts them newest first", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables({
      calls: [
        {
          id: "call-a",
          company_id: COMPANY_A,
          caller_name: "Alice",
          ai_summary: "Demande de prix",
          outcome: "info_provided",
          status: "completed",
          created_at: "2026-07-27T12:00:00.000Z",
        },
      ],
      outbound_calls: [
        {
          id: "out-a",
          company_id: COMPANY_A,
          contact_name: "Bob",
          outcome: "interested",
          status: "completed",
          created_at: "2026-07-27T13:00:00.000Z",
        },
      ],
      appointments: [
        {
          id: "appointment-a",
          company_id: COMPANY_A,
          contact_id: "contact-appointment-a",
          date: "2026-07-30",
          time: "09:30:00",
          type: "Consultation",
          status: "confirmed",
          created_at: "2026-07-27T14:00:00.000Z",
        },
      ],
      contacts: [
        {
          id: "contact-appointment-a",
          company_id: COMPANY_A,
          full_name: "Chloé",
          status: "active",
          created_at: "2026-07-01T10:00:00.000Z",
        },
        {
          id: "contact-a",
          company_id: COMPANY_A,
          full_name: "David",
          status: "new",
          created_at: "2026-07-27T15:00:00.000Z",
        },
      ],
      tickets: [
        {
          id: "ticket-a",
          company_id: COMPANY_A,
          ticket_number: "T-1",
          subject: "Besoin d'aide",
          status: "open",
          created_at: "2026-07-27T11:00:00.000Z",
        },
      ],
    }),
  });

  await withServer(supabase, async baseUrl => {
    const response = await fetch(`${baseUrl}/dashboard/activity?limit=4`, {
      headers: userHeaders(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(
      payload.activities.map(activity => activity.type),
      ["contact", "appointment", "call_outbound", "call_inbound"]
    );
    assert.equal(payload.total_returned, 4);
    assert.equal(payload.has_activity, true);
    assert.equal(payload.activities[1].title, "Rendez-vous — Chloé");
    assert.equal(
      payload.activities.some(activity => activity.type === "email"),
      false
    );
  });
});

test("appointment activity never resolves a contact name outside the tenant", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables({
      appointments: [
        {
          id: "appointment-a",
          company_id: COMPANY_A,
          contact_id: "contact-b",
          contacts: { full_name: "Nom secret tenant B" },
          date: "2026-07-30",
          time: "09:30:00",
          type: "Consultation",
          status: "confirmed",
          created_at: "2026-07-27T14:00:00.000Z",
        },
      ],
      contacts: [
        {
          id: "contact-b",
          company_id: COMPANY_B,
          full_name: "Nom secret tenant B",
          created_at: "2026-07-27T15:00:00.000Z",
        },
      ],
    }),
  });

  await withServer(supabase, async baseUrl => {
    const response = await fetch(`${baseUrl}/dashboard/activity`, {
      headers: userHeaders(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.activities.length, 1);
    assert.equal(payload.activities[0].title, "Rendez-vous — Consultation");
    assert.equal(JSON.stringify(payload).includes("Nom secret tenant B"), false);
  });

  for (const query of supabase.queryLog.filter(query => query.table === "contacts")) {
    const companyFilter = query.filters.find(
      filter => filter.column === "company_id"
    );
    assert.equal(companyFilter?.value, COMPANY_A);
  }
});

test("Supabase errors return 503 and never masquerade as an empty dashboard", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables(),
    errors: { calls: { message: "database unavailable" } },
  });

  await withServer(supabase, async baseUrl => {
    const response = await fetch(`${baseUrl}/dashboard/stats`, {
      headers: userHeaders(),
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.deepEqual(payload, {
      error: "dashboard_unavailable",
    });
    assert.equal("kpis" in payload, false);
  });
});

test("weekly call aggregation uses a stable order and paginates past PostgREST's 1000-row default", async () => {
  const calls = Array.from({ length: 1_001 }, (_, index) => ({
    id: `call-${index}`,
    company_id: COMPANY_A,
    status: "completed",
    outcome: "resolved",
    duration_seconds: 1,
    created_at: "2026-07-25T12:00:00.000Z",
  }));
  const supabase = new FakeSupabase({
    tables: baseTables({ calls }),
  });

  await withServer(supabase, async baseUrl => {
    const response = await fetch(`${baseUrl}/dashboard/stats`, {
      headers: userHeaders(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.kpis.calls_7d.total, 1_001);
    assert.equal(payload.kpis.ai_resolution_eligible_calls_7d, 1_001);
  });

  const callQueries = supabase.queryLog.filter(query => query.table === "calls");
  assert.equal(callQueries.length, 2);
  for (const query of callQueries) {
    assert.deepEqual(query.order, { column: "id", ascending: true });
  }
});
