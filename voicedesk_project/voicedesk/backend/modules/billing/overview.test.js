import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConfiguredSubscriptionPlanUpdate,
  calculateTrialDaysRemaining,
  calculateUsageForecast,
  configuredStripePriceIds,
  createBillingOverviewHandler,
  createBillingPortalHandler,
  currentUtcMonthPeriod,
  findConfiguredPlanByPriceId,
  getConfiguredStripePriceId,
  mapStripeInvoice,
  mapStripePaymentMethod,
  mapStripeSubscriptionStatus,
  parseStripePriceConfiguration,
  resolveStripeBillingPeriod,
  resolveVerifiedCheckoutStatus,
} from "./overview.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = new Date("2026-08-20T12:00:00.000Z");

const PLANS = {
  demarrage: {
    label: "Démarrage",
    price: 159,
    price_annual: 1_526,
    minutes_included: 400,
    overage_rate: 0.3,
  },
};
const PORTAL_CONFIGURATION_ID = "bpc_test";
const CONFIGURED_PRICE_ID = "price_1TestCADMonthly";
const PORTAL_PRICE_IDS = new Set([CONFIGURED_PRICE_ID]);

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.filters = [];
    this.orderValue = null;
    this.rangeValue = null;
    this.singleResult = false;
  }

  select() {
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

  async execute() {
    this.client.queryLog.push({
      table: this.table,
      filters: structuredClone(this.filters),
      order: this.orderValue ? structuredClone(this.orderValue) : null,
      range: this.rangeValue ? structuredClone(this.rangeValue) : null,
    });

    const configuredError = this.client.errors[this.table];
    if (configuredError) return { data: null, error: configuredError };

    let rows = (this.client.tables[this.table] || []).filter(row =>
      this.filters.every(filter => {
        const actual = row[filter.column];
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
  constructor({ tables = {}, errors = {} } = {}) {
    this.tables = structuredClone(tables);
    this.errors = errors;
    this.queryLog = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }
}

function createFakeStripe({
  invoices = [],
  customer = {
    id: "cus_a",
    invoice_settings: { default_payment_method: null },
  },
  paymentMethods = [],
  retrievedPaymentMethod = null,
  subscription = null,
  portalUrl = "https://billing.stripe.com/p/session/test_session",
  failInvoices = null,
  failPortal = null,
} = {}) {
  const calls = {
    invoices: [],
    customers: [],
    paymentMethods: [],
    paymentMethodRetrieve: [],
    subscriptions: [],
    portal: [],
  };

  return {
    calls,
    invoices: {
      async list(parameters) {
        calls.invoices.push(structuredClone(parameters));
        if (failInvoices) throw failInvoices;
        return { data: structuredClone(invoices) };
      },
    },
    customers: {
      async retrieve(id, parameters) {
        calls.customers.push({ id, parameters: structuredClone(parameters) });
        return structuredClone(customer);
      },
    },
    paymentMethods: {
      async list(parameters) {
        calls.paymentMethods.push(structuredClone(parameters));
        return { data: structuredClone(paymentMethods) };
      },
      async retrieve(id) {
        calls.paymentMethodRetrieve.push(id);
        return structuredClone(retrievedPaymentMethod);
      },
    },
    subscriptions: {
      async retrieve(id) {
        calls.subscriptions.push(id);
        return structuredClone(subscription);
      },
    },
    billingPortal: {
      sessions: {
        async create(parameters) {
          calls.portal.push(structuredClone(parameters));
          if (failPortal) throw failPortal;
          return { url: portalUrl };
        },
      },
    },
  };
}

function totalStripeCalls(stripe) {
  return Object.values(stripe.calls).reduce((total, calls) => total + calls.length, 0);
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function overviewRequest({
  role = "company_admin",
  userCompanyId = COMPANY_A,
  requestedCompanyId,
} = {}) {
  return {
    method: "GET",
    query: requestedCompanyId ? { company_id: requestedCompanyId } : {},
    body: {},
    user: { role, company_id: userCompanyId },
  };
}

function portalRequest({
  role = "company_admin",
  userCompanyId = COMPANY_A,
  requestedCompanyId,
  action = "home",
} = {}) {
  return {
    method: "POST",
    query: {},
    body: {
      action,
      ...(requestedCompanyId ? { company_id: requestedCompanyId } : {}),
    },
    user: { role, company_id: userCompanyId },
  };
}

function baseTables(subscriptionOverrides = {}, tableOverrides = {}) {
  return {
    companies: [
      {
        id: COMPANY_A,
        billing_country: "CA",
        billing_currency: "CAD",
      },
      {
        id: COMPANY_B,
        billing_country: "US",
        billing_currency: "USD",
      },
    ],
    subscriptions: [
      {
        company_id: COMPANY_A,
        plan_name: "demarrage",
        plan_label: "Ancienne valeur",
        monthly_price: 147,
        annual_price: 1_400,
        billing_cycle: "monthly",
        payment_status: "trial",
        stripe_customer_id: "cus_a",
        stripe_subscription_id: "sub_a",
        trial_ends_at: "2026-08-25T12:00:00.000Z",
        current_period_start: "2026-08-01",
        current_period_end: "2026-09-01",
        next_payment_date: "2026-09-01",
        minutes_included: 400,
        minutes_used_current_period: 0,
        overage_rate_usd: 0.3,
        overage_policy: "pay_as_you_go",
        currency: "cad",
        ...subscriptionOverrides,
      },
    ],
    calls: [],
    outbound_calls: [],
    ...tableOverrides,
  };
}

test("UTC month, trial and forecast helpers are deterministic", () => {
  assert.deepEqual(currentUtcMonthPeriod(FIXED_NOW), {
    start: "2026-08-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(
    calculateTrialDaysRemaining("2026-08-23T11:00:00.000Z", FIXED_NOW),
    3
  );
  assert.equal(
    calculateTrialDaysRemaining("2026-08-19T12:00:00.000Z", FIXED_NOW),
    0
  );
  assert.equal(calculateTrialDaysRemaining("invalid", FIXED_NOW), null);

  assert.deepEqual(
    calculateUsageForecast({
      minutesUsed: 150,
      minutesIncluded: 200,
      overageRate: 0.25,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      now: "2026-08-16T00:00:00.000Z",
    }),
    {
      projected_minutes: 310,
      projected_overage_minutes: 110,
      projected_overage_amount: 27.5,
      elapsed_days: 15,
      period_days: 31,
      calculation:
        "Projection linéaire basée sur la consommation moyenne depuis le début de la période; minimum d'un jour observé.",
    }
  );
});

test("invalid forecast periods fail closed without synthetic numbers", () => {
  assert.deepEqual(
    calculateUsageForecast({
      minutesUsed: 10,
      minutesIncluded: 400,
      periodStart: "invalid",
      periodEnd: "2026-09-01T00:00:00.000Z",
      now: FIXED_NOW,
    }),
    {
      projected_minutes: null,
      projected_overage_minutes: null,
      projected_overage_amount: null,
      elapsed_days: null,
      period_days: null,
      calculation: "Prévision indisponible : période de facturation invalide.",
    }
  );

  const firstDay = calculateUsageForecast({
    minutesUsed: 10,
    minutesIncluded: 400,
    overageRate: 0.3,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    now: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(firstDay.projected_minutes, 310);
  assert.equal(firstDay.elapsed_days, 0);

  const expired = calculateUsageForecast({
    minutesUsed: 450,
    minutesIncluded: 400,
    overageRate: 0.3,
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    now: FIXED_NOW,
  });
  assert.equal(expired.projected_minutes, 450);
  assert.equal(expired.projected_overage_amount, 15);
});

test("Stripe period and invoice/payment mappings expose only normalized fields", () => {
  const startA = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;
  const startB = Date.parse("2026-08-02T00:00:00.000Z") / 1_000;
  const endA = Date.parse("2026-09-01T00:00:00.000Z") / 1_000;
  const endB = Date.parse("2026-09-02T00:00:00.000Z") / 1_000;

  assert.deepEqual(
    resolveStripeBillingPeriod({
      current_period_start: startB,
      current_period_end: endA,
      items: {
        data: [
          { current_period_start: startB, current_period_end: endA },
          { current_period_start: startA, current_period_end: endB },
        ],
      },
    }),
    {
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-02T00:00:00.000Z",
    }
  );

  assert.deepEqual(
    mapStripeInvoice({
      id: "in_1",
      number: "INV-0001",
      created: startA,
      period_start: startA,
      period_end: endA,
      total: 12_345,
      amount_paid: 12_000,
      currency: "cad",
      status: "paid",
      invoice_pdf: "https://files.stripe.com/invoice.pdf",
      hosted_invoice_url: "http://unsafe.example.test/invoice",
      customer_email: "must-not-leak@example.test",
    }),
    {
      id: "in_1",
      number: "INV-0001",
      created_at: "2026-08-01T00:00:00.000Z",
      period_start: "2026-08-01",
      period_end: "2026-09-01",
      total: 123.45,
      amount_paid: 120,
      currency: "CAD",
      status: "paid",
      invoice_pdf_url: "https://files.stripe.com/invoice.pdf",
      hosted_invoice_url: null,
    }
  );

  assert.deepEqual(
    mapStripePaymentMethod({
      id: "pm_1",
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030 },
    }),
    {
      type: "card",
      brand: "visa",
      last4: "4242",
      exp_month: 8,
      exp_year: 2030,
    }
  );
  assert.deepEqual(
    mapStripePaymentMethod({
      id: "pm_bank",
      type: "acss_debit",
      acss_debit: { bank_name: "Banque Test", last4: "6789" },
    }),
    {
      type: "acss_debit",
      brand: "Banque Test",
      last4: "6789",
      exp_month: null,
      exp_year: null,
    }
  );
  assert.equal(mapStripePaymentMethod({ id: "pm_no_card" }), null);
});

test("Stripe price configuration keeps only known plans, currencies and IDs", () => {
  const configuration = parseStripePriceConfiguration(
    JSON.stringify({
      demarrage: {
        cad: {
          monthly: CONFIGURED_PRICE_ID,
          annual: "invalid",
        },
        BTC: { monthly: "price_btc" },
      },
      unknown: { CAD: { monthly: "price_unknown" } },
    }),
    PLANS
  );

  assert.deepEqual(configuration, {
    demarrage: { CAD: { monthly: CONFIGURED_PRICE_ID } },
  });
  assert.equal(
    getConfiguredStripePriceId(configuration, "demarrage", "cad", "monthly"),
    CONFIGURED_PRICE_ID
  );
  assert.deepEqual([...configuredStripePriceIds(configuration)], [
    CONFIGURED_PRICE_ID,
  ]);
  assert.deepEqual(
    findConfiguredPlanByPriceId(configuration, CONFIGURED_PRICE_ID),
    {
      plan_key: "demarrage",
      currency: "CAD",
      billing_cycle: "monthly",
    }
  );
  assert.deepEqual(
    buildConfiguredSubscriptionPlanUpdate({
      configuration,
      plans: PLANS,
      subscription: {
        items: { data: [{ price: { id: CONFIGURED_PRICE_ID } }] },
      },
    }),
    {
      plan_name: "demarrage",
      plan_label: "Démarrage",
      billing_cycle: "monthly",
      monthly_price: 159,
      annual_price: 1_526,
      minutes_included: 400,
      overage_rate_usd: 0.3,
      currency: "CAD",
    }
  );
  assert.deepEqual(parseStripePriceConfiguration("not-json", PLANS), {});
});

test("checkout verification trusts only active or trialing subscriptions", () => {
  assert.equal(mapStripeSubscriptionStatus("trialing"), "trial");
  assert.equal(mapStripeSubscriptionStatus("active"), "active_paid");
  assert.equal(mapStripeSubscriptionStatus("past_due"), "overdue");
  assert.equal(
    resolveVerifiedCheckoutStatus({
      status: "complete",
      payment_status: "no_payment_required",
      subscription: { status: "trialing" },
    }),
    "trial"
  );
  assert.equal(
    resolveVerifiedCheckoutStatus({
      status: "complete",
      payment_status: "paid",
      subscription: { status: "active" },
    }),
    "active_paid"
  );
  assert.equal(
    resolveVerifiedCheckoutStatus({
      status: "complete",
      payment_status: "unpaid",
      subscription: { status: "incomplete" },
    }),
    null
  );
  assert.equal(
    resolveVerifiedCheckoutStatus({
      status: "open",
      payment_status: "paid",
      subscription: { status: "active" },
    }),
    null
  );
});

test("tenant mismatches return 403 before Supabase or Stripe is called", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe();
  const overview = createBillingOverviewHandler({ supabase, stripe, plans: PLANS });
  const portal = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com",
  });

  const overviewRes = createResponse();
  await overview(
    overviewRequest({ requestedCompanyId: COMPANY_B }),
    overviewRes
  );
  assert.equal(overviewRes.statusCode, 403);

  const portalRes = createResponse();
  await portal(
    portalRequest({ requestedCompanyId: COMPANY_B }),
    portalRes
  );
  assert.equal(portalRes.statusCode, 403);
  assert.equal(supabase.queryLog.length, 0);
  assert.equal(totalStripeCalls(stripe), 0);
});

test("super_admin must explicitly select a target company", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe();
  const overview = createBillingOverviewHandler({ supabase, stripe, plans: PLANS });
  const portal = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com",
  });

  const overviewRes = createResponse();
  await overview(overviewRequest({ role: "super_admin", userCompanyId: null }), overviewRes);
  assert.equal(overviewRes.statusCode, 400);
  assert.deepEqual(overviewRes.body, { error: "company_id requis" });

  const portalRes = createResponse();
  await portal(portalRequest({ role: "super_admin", userCompanyId: null }), portalRes);
  assert.equal(portalRes.statusCode, 400);
  assert.deepEqual(portalRes.body, { error: "company_id requis" });
  assert.equal(supabase.queryLog.length, 0);
  assert.equal(totalStripeCalls(stripe), 0);
});

test("overview uses tenant call durations and sanitized live Stripe invoices", async () => {
  const periodStart = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;
  const periodEnd = Date.parse("2026-09-01T00:00:00.000Z") / 1_000;
  const supabase = new FakeSupabase({
    tables: baseTables({}, {
      calls: [
        {
          id: "call_a_1",
          company_id: COMPANY_A,
          duration_seconds: 120,
          created_at: "2026-08-10T10:00:00.000Z",
        },
        {
          id: "call_b",
          company_id: COMPANY_B,
          duration_seconds: 9_999,
          created_at: "2026-08-10T10:00:00.000Z",
        },
        {
          id: "call_a_old",
          company_id: COMPANY_A,
          duration_seconds: 9_999,
          created_at: "2026-07-31T23:59:59.000Z",
        },
      ],
      outbound_calls: [
        {
          id: "out_a_1",
          company_id: COMPANY_A,
          duration_seconds: 180,
          created_at: "2026-08-11T10:00:00.000Z",
        },
      ],
    }),
  });
  const stripe = createFakeStripe({
    invoices: [
      {
        id: "in_live",
        number: "INV-LIVE",
        created: periodStart,
        period_start: periodStart,
        period_end: periodEnd,
        total: 15_900,
        amount_paid: 15_900,
        currency: "cad",
        status: "paid",
        invoice_pdf: "https://files.stripe.com/live.pdf",
        hosted_invoice_url: "https://invoice.stripe.com/i/live",
      },
    ],
    customer: {
      id: "cus_a",
      invoice_settings: {
        default_payment_method: {
          id: "pm_default",
          card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030 },
        },
      },
    },
    subscription: {
      id: "sub_a",
      status: "trialing",
      items: {
        data: [
          {
            current_period_start: periodStart,
            current_period_end: periodEnd,
            price: { id: CONFIGURED_PRICE_ID },
          },
        ],
      },
    },
  });
  const handler = createBillingOverviewHandler({
    supabase,
    stripe,
    plans: PLANS,
    now: () => FIXED_NOW,
    resolveCurrency: () => "CAD",
    portalConfigurationId: PORTAL_CONFIGURATION_ID,
    portalPlanPriceIds: PORTAL_PRICE_IDS,
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(overviewRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.plan, {
    key: "demarrage",
    label: "Démarrage",
    billing_cycle: "monthly",
    currency: "CAD",
    price: 159,
    minutes_included: 400,
    overage_rate_per_minute: 0.3,
  });
  assert.equal(res.body.subscription.trial_days_remaining, 5);
  assert.equal(res.body.subscription.subscription_update_available, true);
  assert.equal(res.body.usage.minutes_used, 5);
  assert.equal(res.body.usage.source, "call_durations");
  assert.equal(res.body.invoices.length, 1);
  assert.equal(res.body.invoices[0].id, "in_live");
  assert.deepEqual(res.body.payment_method, {
    type: "card",
    brand: "visa",
    last4: "4242",
    exp_month: 8,
    exp_year: 2030,
  });
  assert.deepEqual(stripe.calls.invoices, [{ customer: "cus_a", limit: 12 }]);

  for (const table of ["companies", "subscriptions", "calls", "outbound_calls"]) {
    const queries = supabase.queryLog.filter(query => query.table === table);
    assert.ok(queries.length > 0, `missing ${table} query`);
    assert.ok(
      queries.every(query =>
        query.filters.some(
          filter =>
            filter.operator === "eq" &&
            filter.column === (table === "companies" ? "id" : "company_id") &&
            filter.value === COMPANY_A
        )
      ),
      `${table} must remain tenant-scoped`
    );
  }
});

test("overview returns a legitimate empty Stripe state when no customer exists", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables({
      stripe_customer_id: null,
      stripe_subscription_id: null,
    }),
  });
  const stripe = createFakeStripe({ failInvoices: new Error("must not be called") });
  const handler = createBillingOverviewHandler({
    supabase,
    stripe,
    plans: PLANS,
    now: () => FIXED_NOW,
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(overviewRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription.portal_available, false);
  assert.equal(res.body.subscription.subscription_update_available, false);
  assert.deepEqual(res.body.invoices, []);
  assert.equal(res.body.payment_method, null);
  assert.equal(totalStripeCalls(stripe), 0);
});

test("overview retrieves and maps a non-card default payment method", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe({
    customer: {
      id: "cus_a",
      invoice_settings: { default_payment_method: "pm_bank" },
    },
    retrievedPaymentMethod: {
      id: "pm_bank",
      type: "acss_debit",
      acss_debit: { bank_name: "Banque Test", last4: "6789" },
    },
    subscription: {
      id: "sub_a",
      status: "active",
      items: { data: [] },
    },
  });
  const handler = createBillingOverviewHandler({
    supabase,
    stripe,
    plans: PLANS,
    now: () => FIXED_NOW,
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(overviewRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.payment_method, {
    type: "acss_debit",
    brand: "Banque Test",
    last4: "6789",
    exp_month: null,
    exp_year: null,
  });
  assert.deepEqual(stripe.calls.paymentMethodRetrieve, ["pm_bank"]);
});

test("Stripe outages return 503 instead of fake empty billing data", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe({ failInvoices: new Error("stripe offline") });
  const handler = createBillingOverviewHandler({
    supabase,
    stripe,
    plans: PLANS,
    now: () => FIXED_NOW,
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(overviewRequest(), res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "billing_unavailable" });
  assert.equal(stripe.calls.invoices.length, 1);
});

test("company_user cannot create a Stripe portal session", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe();
  const handler = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com",
  });
  const res = createResponse();

  await handler(portalRequest({ role: "company_user" }), res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "forbidden" });
  assert.equal(supabase.queryLog.length, 0);
  assert.equal(totalStripeCalls(stripe), 0);
});

test("portal reports a missing Stripe customer without provider calls", async () => {
  const supabase = new FakeSupabase({
    tables: baseTables({ stripe_customer_id: null, stripe_subscription_id: null }),
  });
  const stripe = createFakeStripe();
  const handler = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com",
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(portalRequest({ action: "payment_method_update" }), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "compte Stripe introuvable" });
  assert.equal(totalStripeCalls(stripe), 0);
});

test("subscription changes fail closed until stable prices and a Portal configuration exist", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe();
  const handler = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com",
    logger: { error() {} },
  });
  const res = createResponse();

  await handler(portalRequest({ action: "subscription_update" }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "changement de forfait non configuré",
  });
  assert.equal(totalStripeCalls(stripe), 0);
});

test("portal creates payment and subscription deep links returning to /billing", async () => {
  const supabase = new FakeSupabase({ tables: baseTables() });
  const stripe = createFakeStripe({
    subscription: {
      id: "sub_a",
      items: { data: [{ price: { id: CONFIGURED_PRICE_ID } }] },
    },
  });
  const handler = createBillingPortalHandler({
    supabase,
    stripe,
    frontendUrl: "https://app.exevori.com/config?tab=billing#old",
    portalConfigurationId: PORTAL_CONFIGURATION_ID,
    portalPlanPriceIds: PORTAL_PRICE_IDS,
    logger: { error() {} },
  });

  const paymentRes = createResponse();
  await handler(
    portalRequest({ action: "payment_method_update" }),
    paymentRes
  );
  assert.equal(paymentRes.statusCode, 200);
  assert.equal(
    paymentRes.body.portal_url,
    "https://billing.stripe.com/p/session/test_session"
  );

  const subscriptionRes = createResponse();
  await handler(
    portalRequest({ action: "subscription_update" }),
    subscriptionRes
  );
  assert.equal(subscriptionRes.statusCode, 200);

  assert.deepEqual(stripe.calls.portal, [
    {
      customer: "cus_a",
      return_url: "https://app.exevori.com/billing",
      locale: "fr",
      configuration: PORTAL_CONFIGURATION_ID,
      flow_data: {
        type: "payment_method_update",
        after_completion: {
          type: "redirect",
          redirect: { return_url: "https://app.exevori.com/billing" },
        },
      },
    },
    {
      customer: "cus_a",
      return_url: "https://app.exevori.com/billing",
      locale: "fr",
      configuration: PORTAL_CONFIGURATION_ID,
      flow_data: {
        type: "subscription_update",
        subscription_update: { subscription: "sub_a" },
        after_completion: {
          type: "redirect",
          redirect: { return_url: "https://app.exevori.com/billing" },
        },
      },
    },
  ]);
});
