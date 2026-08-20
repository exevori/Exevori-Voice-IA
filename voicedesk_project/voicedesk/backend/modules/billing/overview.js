const DAY_MS = 86_400_000;
const POSTGREST_PAGE_SIZE = 1_000;

const BILLING_MANAGER_ROLES = new Set(["company_admin", "super_admin"]);
const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;
const SUPPORTED_PRICE_CURRENCIES = new Set(["CAD", "USD", "EUR"]);
const SUPPORTED_BILLING_CYCLES = new Set(["monthly", "annual"]);

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nonNegativeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString();
}

function unixSecondsToDate(value) {
  return unixSecondsToIso(value)?.slice(0, 10) || null;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseStripePriceConfiguration(rawValue, plans = {}) {
  if (!rawValue) return {};

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const result = {};
  for (const [planKey, currencies] of Object.entries(parsed)) {
    if (!plans[planKey] || !currencies || typeof currencies !== "object") continue;

    for (const [rawCurrency, cycles] of Object.entries(currencies)) {
      const currency = rawCurrency.toUpperCase();
      if (
        !SUPPORTED_PRICE_CURRENCIES.has(currency) ||
        !cycles ||
        typeof cycles !== "object"
      ) {
        continue;
      }

      for (const [cycle, priceId] of Object.entries(cycles)) {
        if (
          !SUPPORTED_BILLING_CYCLES.has(cycle) ||
          typeof priceId !== "string" ||
          !STRIPE_PRICE_ID_PATTERN.test(priceId)
        ) {
          continue;
        }
        result[planKey] ||= {};
        result[planKey][currency] ||= {};
        result[planKey][currency][cycle] = priceId;
      }
    }
  }
  return result;
}

export function getConfiguredStripePriceId(
  configuration,
  planKey,
  currency,
  billingCycle
) {
  return configuration?.[planKey]?.[String(currency).toUpperCase()]?.[
    billingCycle
  ] || null;
}

export function configuredStripePriceIds(configuration) {
  const ids = new Set();
  for (const currencies of Object.values(configuration || {})) {
    for (const cycles of Object.values(currencies || {})) {
      for (const priceId of Object.values(cycles || {})) {
        if (STRIPE_PRICE_ID_PATTERN.test(priceId)) ids.add(priceId);
      }
    }
  }
  return ids;
}

export function findConfiguredPlanByPriceId(configuration, priceId) {
  if (typeof priceId !== "string") return null;

  for (const [planKey, currencies] of Object.entries(configuration || {})) {
    for (const [currency, cycles] of Object.entries(currencies || {})) {
      for (const [billingCycle, configuredPriceId] of Object.entries(
        cycles || {}
      )) {
        if (configuredPriceId === priceId) {
          return {
            plan_key: planKey,
            currency,
            billing_cycle: billingCycle,
          };
        }
      }
    }
  }
  return null;
}

export function buildConfiguredSubscriptionPlanUpdate({
  configuration,
  plans,
  subscription,
} = {}) {
  const match = (subscription?.items?.data || [])
    .map(item => findConfiguredPlanByPriceId(configuration, item?.price?.id))
    .find(Boolean);
  const plan = match ? plans?.[match.plan_key] : null;
  if (!match || !plan) return {};

  return {
    plan_name: match.plan_key,
    plan_label: plan.label,
    billing_cycle: match.billing_cycle,
    monthly_price: plan.price,
    annual_price: plan.price_annual,
    minutes_included: plan.minutes_included,
    overage_rate_usd: plan.overage_rate,
    currency: match.currency,
  };
}

export function resolveVerifiedCheckoutStatus(session) {
  if (session?.status !== "complete") return null;
  const subscriptionStatus =
    session.subscription && typeof session.subscription === "object"
      ? session.subscription.status
      : null;

  if (subscriptionStatus === "trialing") return "trial";
  if (subscriptionStatus === "active") return "active_paid";
  return null;
}

function subscriptionUsesConfiguredPrice(subscription, configuredPriceIds) {
  const items = Array.isArray(subscription?.items?.data)
    ? subscription.items.data
    : [];
  return items.some(item => configuredPriceIds.has(item?.price?.id));
}

export function currentUtcMonthPeriod(nowValue = new Date()) {
  const now = asDate(nowValue);
  if (!now) throw new TypeError("invalid_billing_now");
  return {
    start: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString(),
    end: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    ).toISOString(),
  };
}

export function calculateTrialDaysRemaining(trialEndsAt, nowValue = new Date()) {
  const trialEnd = asDate(trialEndsAt);
  const now = asDate(nowValue);
  if (!trialEnd || !now) return null;
  return Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / DAY_MS));
}

export function calculateUsageForecast({
  minutesUsed,
  minutesIncluded,
  overageRate,
  periodStart,
  periodEnd,
  now: nowValue = new Date(),
} = {}) {
  const used = nonNegativeNumber(minutesUsed);
  const included = nonNegativeNumber(minutesIncluded);
  const rate = nonNegativeNumber(overageRate);
  const start = asDate(periodStart);
  const end = asDate(periodEnd);
  const now = asDate(nowValue);

  if (!start || !end || !now || end <= start) {
    return {
      projected_minutes: null,
      projected_overage_minutes: null,
      projected_overage_amount: null,
      elapsed_days: null,
      period_days: null,
      calculation: "Prévision indisponible : période de facturation invalide.",
    };
  }

  const totalMs = end.getTime() - start.getTime();
  const boundedNowMs = Math.min(
    end.getTime(),
    Math.max(start.getTime(), now.getTime())
  );
  const rawElapsedMs = boundedNowMs - start.getTime();
  const elapsedMs = Math.max(DAY_MS, rawElapsedMs);
  const projectionFactor = now >= end ? 1 : totalMs / elapsedMs;
  const projectedMinutes = Math.max(used, used * projectionFactor);
  const projectedOverage = Math.max(0, projectedMinutes - included);

  return {
    projected_minutes: roundOne(projectedMinutes),
    projected_overage_minutes: roundOne(projectedOverage),
    projected_overage_amount: roundMoney(projectedOverage * rate),
    elapsed_days: roundOne(Math.max(0, rawElapsedMs) / DAY_MS),
    period_days: roundOne(totalMs / DAY_MS),
    calculation:
      "Projection linéaire basée sur la consommation moyenne depuis le début de la période; minimum d'un jour observé.",
  };
}

export function resolveStripeBillingPeriod(subscription) {
  if (!subscription || typeof subscription !== "object") {
    return { start: null, end: null };
  }

  const items = Array.isArray(subscription.items?.data)
    ? subscription.items.data
    : [];
  const starts = items
    .map(item => Number(item?.current_period_start))
    .filter(value => Number.isFinite(value) && value > 0);
  const ends = items
    .map(item => Number(item?.current_period_end))
    .filter(value => Number.isFinite(value) && value > 0);

  const start = starts.length > 0
    ? Math.min(...starts)
    : Number(subscription.current_period_start);
  const end = ends.length > 0
    ? Math.max(...ends)
    : Number(subscription.current_period_end);

  return {
    start: unixSecondsToIso(start),
    end: unixSecondsToIso(end),
  };
}

export function mapStripeInvoice(invoice) {
  return {
    id: invoice?.id || null,
    number: invoice?.number || null,
    created_at: unixSecondsToIso(invoice?.created),
    period_start: unixSecondsToDate(invoice?.period_start),
    period_end: unixSecondsToDate(invoice?.period_end),
    total: roundMoney((numberOrNull(invoice?.total) ?? 0) / 100),
    amount_paid: roundMoney((numberOrNull(invoice?.amount_paid) ?? 0) / 100),
    currency:
      typeof invoice?.currency === "string"
        ? invoice.currency.toUpperCase()
        : null,
    status: invoice?.status || null,
    invoice_pdf_url: safeHttpsUrl(invoice?.invoice_pdf),
    hosted_invoice_url: safeHttpsUrl(invoice?.hosted_invoice_url),
  };
}

export function mapStripePaymentMethod(paymentMethod) {
  if (!paymentMethod || typeof paymentMethod !== "object") return null;
  const type = paymentMethod.type || (paymentMethod.card ? "card" : null);
  const details = (type && paymentMethod[type]) || paymentMethod.card;
  if (!type || !details) return null;

  const brand =
    details.brand ||
    details.bank_name ||
    (type === "sepa_debit" ? "SEPA" : null);
  return {
    type,
    brand,
    last4: details.last4 || null,
    exp_month: Number.isSafeInteger(details.exp_month) ? details.exp_month : null,
    exp_year: Number.isSafeInteger(details.exp_year) ? details.exp_year : null,
  };
}

function resolveTargetCompany(req, res) {
  const requestedCompanyId =
    req.method === "GET" ? req.query.company_id : req.body?.company_id;
  const isSuperAdmin = req.user?.role === "super_admin";

  if (
    !isSuperAdmin &&
    requestedCompanyId &&
    requestedCompanyId !== req.user?.company_id
  ) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }

  const companyId = isSuperAdmin
    ? requestedCompanyId || null
    : req.user?.company_id || null;

  if (!companyId) {
    res.status(isSuperAdmin ? 400 : 403).json({
      error: isSuperAdmin ? "company_id requis" : "forbidden",
    });
    return null;
  }

  return companyId;
}

async function readMaybeSingle(query, code) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(code);
  return data;
}

async function readAllPages(buildQuery, code) {
  const rows = [];

  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const { data, error } = await buildQuery()
      .order("id", { ascending: true })
      .range(from, from + POSTGREST_PAGE_SIZE - 1);
    if (error) throw new Error(code);

    const page = data || [];
    rows.push(...page);
    if (page.length < POSTGREST_PAGE_SIZE) return rows;
  }
}

function totalCallMinutes(...groups) {
  const seconds = groups.flat().reduce(
    (total, call) => total + nonNegativeNumber(call?.duration_seconds),
    0
  );
  return roundOne(seconds / 60);
}

function resolvePaymentMethod(customer, methods, retrievedMethod = null) {
  const defaultMethod = customer?.invoice_settings?.default_payment_method;
  if (defaultMethod && typeof defaultMethod === "object") {
    return mapStripePaymentMethod(defaultMethod);
  }

  const candidates = Array.isArray(methods?.data) ? methods.data : [];
  const selected =
    (typeof defaultMethod === "string"
      ? candidates.find(method => method.id === defaultMethod)
      : null) || retrievedMethod || candidates[0];
  return mapStripePaymentMethod(selected);
}

function normalizeCurrency(value, fallback = "CAD") {
  return typeof value === "string" && /^[a-z]{3}$/i.test(value)
    ? value.toUpperCase()
    : fallback;
}

export function mapStripeSubscriptionStatus(status, fallback = null) {
  const statuses = {
    active: "active_paid",
    trialing: "trial",
    past_due: "overdue",
    canceled: "cancelled",
    incomplete: "pending_payment",
    incomplete_expired: "cancelled",
    unpaid: "overdue",
    paused: "suspended",
  };
  return statuses[status] || fallback || null;
}

function safeFrontendReturnUrl(frontendUrl) {
  try {
    const url = new URL(frontendUrl);
    const isLocalhost = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return null;
    }
    url.pathname = "/billing";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function safePortalUrl(value) {
  const safeUrl = safeHttpsUrl(value);
  if (!safeUrl) return null;
  const url = new URL(safeUrl);
  return url.hostname === "billing.stripe.com" ? url.toString() : null;
}

/**
 * Données de facturation réelles du tenant.
 *
 * Les minutes utilisent la valeur la plus haute entre le compteur d'abonnement
 * et la somme des durées d'appels de la période. Ce choix empêche un compteur
 * asynchrone en retard d'afficher un faux zéro, sans additionner deux fois le
 * même usage.
 */
export function createBillingOverviewHandler({
  supabase,
  stripe,
  plans,
  now = () => new Date(),
  resolveCurrency = () => "CAD",
  portalConfigurationId = null,
  portalPlanPriceIds = new Set(),
  logger = console,
} = {}) {
  return async function billingOverview(req, res) {
    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;

    if (!supabase) {
      return res.status(503).json({ error: "billing_unavailable" });
    }

    try {
      const generatedAt = new Date(now());
      if (Number.isNaN(generatedAt.getTime())) {
        throw new Error("invalid_billing_now");
      }

      const [company, subscription] = await Promise.all([
        readMaybeSingle(
          supabase
            .from("companies")
            .select("id, billing_country, billing_currency")
            .eq("id", companyId),
          "company_read_failed"
        ),
        readMaybeSingle(
          supabase
            .from("subscriptions")
            .select(
              "company_id, plan_name, plan_label, monthly_price, annual_price, billing_cycle, payment_status, stripe_customer_id, stripe_subscription_id, trial_ends_at, current_period_start, current_period_end, next_payment_date, minutes_included, minutes_used_current_period, overage_rate_usd, overage_policy, currency"
            )
            .eq("company_id", companyId),
          "subscription_read_failed"
        ),
      ]);

      if (!company) {
        return res.status(404).json({ error: "company introuvable" });
      }
      if (!subscription) {
        return res.status(404).json({ error: "abonnement introuvable" });
      }

      let stripeSubscription = null;
      let stripeInvoices = [];
      let stripeCustomer = null;
      let stripePaymentMethods = { data: [] };
      let stripeRetrievedPaymentMethod = null;

      if (subscription.stripe_customer_id) {
        if (!stripe) throw new Error("stripe_not_configured");

        const stripeReads = [
          stripe.invoices.list({
            customer: subscription.stripe_customer_id,
            limit: 12,
          }),
          stripe.customers.retrieve(subscription.stripe_customer_id, {
            expand: ["invoice_settings.default_payment_method"],
          }),
          stripe.paymentMethods.list({
            customer: subscription.stripe_customer_id,
            type: "card",
            limit: 10,
          }),
        ];
        if (subscription.stripe_subscription_id) {
          stripeReads.push(
            stripe.subscriptions.retrieve(subscription.stripe_subscription_id)
          );
        }

        const [invoiceList, customer, paymentMethods, stripeSub = null] =
          await Promise.all(stripeReads);
        stripeInvoices = Array.isArray(invoiceList?.data) ? invoiceList.data : [];
        stripeCustomer = customer?.deleted ? null : customer;
        stripePaymentMethods = paymentMethods || { data: [] };
        stripeSubscription = stripeSub;

        const defaultPaymentMethod =
          stripeCustomer?.invoice_settings?.default_payment_method;
        if (
          typeof defaultPaymentMethod === "string" &&
          !stripePaymentMethods.data?.some(
            method => method.id === defaultPaymentMethod
          )
        ) {
          stripeRetrievedPaymentMethod = await stripe.paymentMethods.retrieve(
            defaultPaymentMethod
          );
        }
      }

      const fallbackPeriod = currentUtcMonthPeriod(generatedAt);
      const stripePeriod = resolveStripeBillingPeriod(stripeSubscription);
      const periodStart =
        stripePeriod.start || subscription.current_period_start || fallbackPeriod.start;
      const periodEnd =
        stripePeriod.end || subscription.current_period_end || fallbackPeriod.end;

      const [inboundCalls, outboundCalls] = await Promise.all([
        readAllPages(
          () =>
            supabase
              .from("calls")
              .select("id, duration_seconds")
              .eq("company_id", companyId)
              .gte("created_at", periodStart)
              .lt("created_at", periodEnd),
          "calls_read_failed"
        ),
        readAllPages(
          () =>
            supabase
              .from("outbound_calls")
              .select("id, duration_seconds")
              .eq("company_id", companyId)
              .gte("created_at", periodStart)
              .lt("created_at", periodEnd),
          "outbound_calls_read_failed"
        ),
      ]);

      const plan = plans?.[subscription.plan_name] || null;
      const measuredCallMinutes = totalCallMinutes(inboundCalls, outboundCalls);
      const subscriptionMinutes = nonNegativeNumber(
        subscription.minutes_used_current_period
      );
      const minutesUsed = Math.max(measuredCallMinutes, subscriptionMinutes);
      const minutesIncluded = nonNegativeNumber(
        subscription.minutes_included,
        nonNegativeNumber(plan?.minutes_included)
      );
      const overageRate = nonNegativeNumber(
        subscription.overage_rate_usd,
        nonNegativeNumber(plan?.overage_rate)
      );
      const billingCycle = subscription.billing_cycle || "monthly";
      const planPrice =
        billingCycle === "annual"
          ? numberOrNull(plan?.price_annual) ?? numberOrNull(subscription.annual_price)
          : numberOrNull(plan?.price) ?? numberOrNull(subscription.monthly_price);
      const currency = normalizeCurrency(
        subscription.currency || company.billing_currency,
        normalizeCurrency(resolveCurrency(company.billing_country || "CA"))
      );
      const minutesOverage = Math.max(0, minutesUsed - minutesIncluded);
      const trialEndsAt =
        unixSecondsToIso(stripeSubscription?.trial_end) ||
        subscription.trial_ends_at ||
        null;
      const paymentStatus = mapStripeSubscriptionStatus(
        stripeSubscription?.status,
        subscription.payment_status
      );
      const subscriptionUpdateAvailable = Boolean(
        subscription.stripe_customer_id &&
        subscription.stripe_subscription_id &&
        portalConfigurationId &&
        subscriptionUsesConfiguredPrice(
          stripeSubscription,
          portalPlanPriceIds
        )
      );

      return res.json({
        generated_at: generatedAt.toISOString(),
        plan: {
          key: subscription.plan_name || null,
          label: plan?.label || subscription.plan_label || null,
          billing_cycle: billingCycle,
          currency,
          price: planPrice,
          minutes_included: roundOne(minutesIncluded),
          overage_rate_per_minute: roundOne(overageRate),
        },
        subscription: {
          payment_status: paymentStatus,
          stripe_status: stripeSubscription?.status || null,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          next_payment_date: subscription.next_payment_date || null,
          trial_ends_at: trialEndsAt,
          trial_days_remaining: calculateTrialDaysRemaining(
            trialEndsAt,
            generatedAt
          ),
          overage_policy: subscription.overage_policy || null,
          portal_available: Boolean(
            subscription.stripe_customer_id && stripeCustomer
          ),
          subscription_update_available: subscriptionUpdateAvailable,
        },
        usage: {
          minutes_used: roundOne(minutesUsed),
          minutes_included: roundOne(minutesIncluded),
          minutes_remaining: roundOne(
            Math.max(0, minutesIncluded - minutesUsed)
          ),
          minutes_overage: roundOne(minutesOverage),
          usage_percentage:
            minutesIncluded > 0
              ? Math.round((minutesUsed / minutesIncluded) * 100)
              : null,
          source:
            subscriptionMinutes > measuredCallMinutes
              ? "subscription_meter"
              : "call_durations",
        },
        forecast: calculateUsageForecast({
          minutesUsed,
          minutesIncluded,
          overageRate,
          periodStart,
          periodEnd,
          now: generatedAt,
        }),
        payment_method: resolvePaymentMethod(
          stripeCustomer,
          stripePaymentMethods,
          stripeRetrievedPaymentMethod
        ),
        invoices: stripeInvoices.map(mapStripeInvoice),
      });
    } catch (error) {
      logger.error?.("[billing] overview unavailable", error);
      return res.status(503).json({ error: "billing_unavailable" });
    }
  };
}

export function createBillingPortalHandler({
  supabase,
  stripe,
  frontendUrl,
  portalConfigurationId = null,
  portalPlanPriceIds = new Set(),
  logger = console,
} = {}) {
  return async function billingPortal(req, res) {
    if (!BILLING_MANAGER_ROLES.has(req.user?.role)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;

    const action = req.body?.action || "home";
    if (!["home", "payment_method_update", "subscription_update"].includes(action)) {
      return res.status(400).json({ error: "action invalide" });
    }

    const returnUrl = safeFrontendReturnUrl(frontendUrl);
    if (!supabase || !stripe || !returnUrl) {
      return res.status(503).json({ error: "billing_not_configured" });
    }

    try {
      const [company, subscription] = await Promise.all([
        readMaybeSingle(
          supabase.from("companies").select("id").eq("id", companyId),
          "company_read_failed"
        ),
        readMaybeSingle(
          supabase
            .from("subscriptions")
            .select("stripe_customer_id, stripe_subscription_id")
            .eq("company_id", companyId),
          "subscription_read_failed"
        ),
      ]);

      if (!company) {
        return res.status(404).json({ error: "company introuvable" });
      }
      if (!subscription?.stripe_customer_id) {
        return res.status(404).json({ error: "compte Stripe introuvable" });
      }
      if (action === "subscription_update" && !subscription.stripe_subscription_id) {
        return res.status(409).json({ error: "abonnement Stripe introuvable" });
      }

      if (
        action === "subscription_update" &&
        (!portalConfigurationId || portalPlanPriceIds.size === 0)
      ) {
        return res.status(409).json({
          error: "changement de forfait non configuré",
        });
      }

      const parameters = {
        customer: subscription.stripe_customer_id,
        return_url: returnUrl,
        locale: "fr",
        ...(portalConfigurationId
          ? { configuration: portalConfigurationId }
          : {}),
      };

      if (action !== "home") {
        if (action === "subscription_update") {
          const stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripe_subscription_id
          );
          if (
            !subscriptionUsesConfiguredPrice(
              stripeSubscription,
              portalPlanPriceIds
            )
          ) {
            return res.status(409).json({
              error: "changement de forfait indisponible pour cet abonnement",
            });
          }
        }

        parameters.flow_data = {
          type: action,
          ...(action === "subscription_update"
            ? { subscription_update: { subscription: subscription.stripe_subscription_id } }
            : {}),
          after_completion: {
            type: "redirect",
            redirect: { return_url: returnUrl },
          },
        };
      }

      const portalSession = await stripe.billingPortal.sessions.create(parameters);
      const portalUrl = safePortalUrl(portalSession?.url);
      if (!portalUrl) throw new Error("invalid_portal_url");

      return res.json({ portal_url: portalUrl });
    } catch (error) {
      logger.error?.("[billing] portal unavailable", error);
      return res.status(503).json({ error: "billing_unavailable" });
    }
  };
}
