// ============================================================
// VOICEDESK IA — MODULE BILLING (Stripe)
// Inspiré de :
//   github.com/uxfris/saas-starter (usage tracking + webhooks)
//   github.com/Saas-Starter-Kit/Saas-Kit-supabase (subscriptions)
//   github.com/dzlau/stripe-supabase-saas-template (customer portal)
//
// Pipeline VoiceDesk :
//   1. Onboarding → Stripe Checkout → carte enregistrée
//   2. Abonnement mensuel automatique
//   3. Usage tracking (minutes voix + tokens IA)
//   4. Overage : pay_as_you_go ou block_at_limit (choix client)
//   5. Webhooks Stripe → mise à jour automatique
//   6. Customer Portal → client gère sa carte
//   7. Mode manuel en option pour PME qui préfèrent virement
// ============================================================

import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  buildConfiguredSubscriptionPlanUpdate,
  configuredStripePriceIds,
  createBillingOverviewHandler,
  createBillingPortalHandler,
  getConfiguredStripePriceId,
  mapStripeSubscriptionStatus,
  parseStripePriceConfiguration,
  resolveStripeBillingPeriod,
  resolveVerifiedCheckoutStatus,
} from "./overview.js";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18" });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function hasTenantMismatch(req, requestedCompanyId) {
  return Boolean(
    !isSuperAdmin(req) &&
    requestedCompanyId &&
    requestedCompanyId !== req.user?.company_id
  );
}

function getTargetCompanyId(req, requestedCompanyId) {
  return isSuperAdmin(req)
    ? requestedCompanyId || null
    : req.user?.company_id || null;
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}

function requireBillingManager(req, res, next) {
  if (!["company_admin", "super_admin"].includes(req.user?.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}

async function getCompany(companyId, columns = "id") {
  const { data, error } = await supabase
    .from("companies")
    .select(columns)
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getSubscription(companyId, columns = "*") {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(columns)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ── PRIX DES FORFAITS ─────────────────────────────────────────
// ── PRIX MULTI-DEVISE ──
// Source de vérité : shared/constants.js
// Même chiffre dans toutes les devises (79 = 79$ CAD = 79$ USD = 79€)
// CA : + TPS/TVQ + installation 319$ | US/EU/Monde : sans taxe, sans installation
import {
  PLANS as PLAN_PRICES,
  EU_COUNTRIES,
  INSTALLATION_FEE,
  getPricingForCountry,
} from "../../../shared/constants.js";

const STRIPE_PRICE_CONFIGURATION = parseStripePriceConfiguration(
  process.env.STRIPE_PRICE_IDS_JSON,
  PLAN_PRICES
);
const STRIPE_PORTAL_PRICE_IDS = configuredStripePriceIds(
  STRIPE_PRICE_CONFIGURATION
);
const STRIPE_PORTAL_CONFIGURATION_ID =
  /^bpc_[A-Za-z0-9]+$/.test(process.env.STRIPE_PORTAL_CONFIGURATION_ID || "")
    ? process.env.STRIPE_PORTAL_CONFIGURATION_ID
    : null;
const STRIPE_TAX_ENABLED = process.env.STRIPE_TAX_ENABLED === "true";

// Devise Stripe selon pays
function currencyForCountry(country) {
  if (country === "CA") return "cad";
  if (country === "US") return "usd";
  if (EU_COUNTRIES.includes(country)) return "eur";
  return "usd";
}

function normalizeBillingCountry(value) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(country) ? country : "CA";
}

const billingOverviewHandler = createBillingOverviewHandler({
  supabase,
  stripe,
  plans: PLAN_PRICES,
  resolveCurrency: currencyForCountry,
  portalConfigurationId: STRIPE_PORTAL_CONFIGURATION_ID,
  portalPlanPriceIds: STRIPE_PORTAL_PRICE_IDS,
});

const billingPortalHandler = createBillingPortalHandler({
  supabase,
  stripe,
  frontendUrl: process.env.FRONTEND_URL,
  portalConfigurationId: STRIPE_PORTAL_CONFIGURATION_ID,
  portalPlanPriceIds: STRIPE_PORTAL_PRICE_IDS,
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/checkout
// Créer une session Stripe Checkout pour s'abonner
// ─────────────────────────────────────────────────────────────
router.post("/checkout", requireBillingManager, async (req, res) => {
  const { company_id, plan_name, billing_cycle = "monthly" } = req.body;

  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId) {
    return res.status(isSuperAdmin(req) ? 400 : 403).json({
      error: isSuperAdmin(req) ? "company_id requis" : "forbidden",
    });
  }

  try {
    const company = await getCompany(companyId, "*");
    if (!company) return res.status(404).json({ error: "company introuvable" });

    const plan = PLAN_PRICES[plan_name];
    if (!plan) return res.status(400).json({ error: "plan invalide" });
    if (!["monthly", "annual"].includes(billing_cycle)) {
      return res.status(400).json({ error: "cycle de facturation invalide" });
    }

    const billingCountry = normalizeBillingCountry(company.billing_country);

    // Récupérer ou créer le customer Stripe
    const sub = await getSubscription(companyId);

    let customerId = sub?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: company.contact_email,
        name: company.contact_name,
        metadata: {
          company_id: companyId,
          company_name: company.name,
          billing_country: billingCountry,
        },
        address: { country: billingCountry, state: billingCountry === "CA" ? (company.province || "QC") : undefined },
      });
      customerId = customer.id;
    }

    // ── MULTI-DEVISE ──
    // Même chiffre dans toutes les devises (79$ CAD = 79$ USD = 79€)
    const stripeCurrency = currencyForCountry(billingCountry);
    const isCanada = billingCountry === "CA";

    // Calcul prix avec remise annuelle
    const basePrice = billing_cycle === "annual"
      ? plan.price_annual
      : plan.price;
    const configuredPriceId = getConfiguredStripePriceId(
      STRIPE_PRICE_CONFIGURATION,
      plan_name,
      stripeCurrency,
      billing_cycle
    );
    const subscriptionLineItem = configuredPriceId
      ? { price: configuredPriceId, quantity: 1 }
      : {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `VoiceDesk IA — ${plan.label}`,
              description: `${plan.minutes_included} minutes incluses/mois`,
            },
            unit_amount: basePrice * 100,
            recurring: {
              interval: billing_cycle === "annual" ? "year" : "month",
            },
          },
          quantity: 1,
        };

    // Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        subscriptionLineItem,
        // ── FRAIS D'INSTALLATION : CANADA UNIQUEMENT ──
        ...(isCanada ? [{
          price_data: {
            currency: "cad",
            product_data: {
              name: "Frais d'installation VoiceDesk IA",
              description: "Configuration initiale + onboarding (paiement unique)",
            },
            unit_amount: INSTALLATION_FEE * 100,  // 319$ CAD
          },
          quantity: 1,
        }] : []),
      ],
      // ── TAXES AUTOMATIQUES (TPS/TVQ au Canada via Stripe Tax) ──
      ...(isCanada && STRIPE_TAX_ENABLED
        ? { automatic_tax: { enabled: true } }
        : {}),
      metadata: { company_id: companyId, plan_name, billing_cycle },
      subscription_data: {
        metadata: { company_id: companyId, plan_name, billing_cycle },
        trial_period_days: 14,
      },
      success_url: `${process.env.FRONTEND_URL}/onboarding/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/onboarding/billing`,
      allow_promotion_codes: true,
      locale: "fr-CA",
    });

    return res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error("[BILLING] Checkout error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/portal
// Rediriger vers Customer Portal Stripe (client gère sa carte)
// ─────────────────────────────────────────────────────────────
router.post("/portal", billingPortalHandler);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/billing/me
// Consultation par le client de son propre abonnement
// ─────────────────────────────────────────────────────────────
router.get("/me", billingOverviewHandler);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/overage-policy
// Le client choisit : pay_as_you_go OU block_at_limit
// ─────────────────────────────────────────────────────────────
router.post("/overage-policy", requireBillingManager, async (req, res) => {
  const { company_id, overage_policy } = req.body;

  if (hasTenantMismatch(req, company_id)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const companyId = getTargetCompanyId(req, company_id);
  if (!companyId) {
    return res.status(isSuperAdmin(req) ? 400 : 403).json({
      error: isSuperAdmin(req) ? "company_id requis" : "forbidden",
    });
  }

  if (!["pay_as_you_go", "block_at_limit"].includes(overage_policy)) {
    return res.status(400).json({ error: "overage_policy invalide" });
  }

  try {
    const company = await getCompany(companyId);
    if (!company) return res.status(404).json({ error: "company introuvable" });

    const { data: subscription, error } = await supabase
      .from("subscriptions")
      .update({ overage_policy, updated_at: new Date() })
      .eq("company_id", companyId)
      .select("company_id")
      .maybeSingle();

    if (error) throw error;
    if (!subscription) {
      return res.status(404).json({ error: "abonnement introuvable" });
    }

    return res.json({ success: true, overage_policy });
  } catch (err) {
    console.error("[BILLING] Overage policy error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/change-plan
// Le client demande de changer de forfait
// ─────────────────────────────────────────────────────────────
router.post("/change-plan", requireBillingManager, (req, res) => {
  req.body = { ...req.body, action: "subscription_update" };
  return billingPortalHandler(req, res);
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/track-usage
// Enregistrer la consommation (appelé après chaque appel/email)
// ─────────────────────────────────────────────────────────────
router.post("/track-usage", requireSuperAdmin, async (req, res) => {
  const { company_id, resource_type, quantity, unit_cost_usd = 0 } = req.body;

  if (typeof company_id !== "string" || !company_id.trim()) {
    return res.status(400).json({ error: "company_id requis" });
  }
  if (typeof resource_type !== "string" || !resource_type.trim()) {
    return res.status(400).json({ error: "resource_type requis" });
  }

  const usageQuantity = Number(quantity);
  if (quantity === null || quantity === undefined || !Number.isFinite(usageQuantity)) {
    return res.status(400).json({ error: "quantity doit être un nombre fini" });
  }

  const unitCost = Number(unit_cost_usd);
  if (!Number.isFinite(unitCost)) {
    return res.status(400).json({ error: "unit_cost_usd doit être un nombre fini" });
  }

  const companyId = company_id.trim();
  const resourceType = resource_type.trim();

  try {
    const company = await getCompany(companyId);
    if (!company) return res.status(404).json({ error: "company introuvable" });

    let subscription = null;
    if (resourceType === "voice_minutes") {
      subscription = await getSubscription(companyId);
      if (!subscription) {
        return res.status(404).json({ error: "abonnement introuvable" });
      }
    }

    const now = new Date();
    const period_start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const period_end = lastDay.toISOString().split("T")[0];

    // Upsert dans usage_records
    const { data: existing, error: existingError } = await supabase
      .from("usage_records")
      .select("*")
      .eq("company_id", companyId)
      .eq("period_start", period_start)
      .eq("resource_type", resourceType)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      const { error } = await supabase
        .from("usage_records")
        .update({
          quantity: (Number(existing.quantity) || 0) + usageQuantity,
          total_cost_usd: (Number(existing.total_cost_usd) || 0) + (usageQuantity * unitCost),
        })
        .eq("id", existing.id)
        .eq("company_id", companyId);

      if (error) throw error;
    } else {
      const { error } = await supabase.from("usage_records").insert({
        company_id: companyId,
        period_start,
        period_end,
        resource_type: resourceType,
        quantity: usageQuantity,
        unit_cost_usd: unitCost,
        total_cost_usd: usageQuantity * unitCost,
      });

      if (error) throw error;
    }

    // Si voice_minutes, mettre à jour le compteur sur subscriptions
    if (resourceType === "voice_minutes") {
      const newMinutesUsed =
        (Number(subscription.minutes_used_current_period) || 0) + usageQuantity;
      const { data: updatedSubscription, error } = await supabase
        .from("subscriptions")
        .update({ minutes_used_current_period: newMinutesUsed })
        .eq("company_id", companyId)
        .select("company_id")
        .maybeSingle();

      if (error) throw error;
      if (!updatedSubscription) {
        return res.status(404).json({ error: "abonnement introuvable" });
      }

      // Si block_at_limit et dépassement → bloquer
      const limit = subscription.minutes_included;
      if (subscription.overage_policy === "block_at_limit" && newMinutesUsed >= limit) {
        const { error: suspendError } = await supabase
          .from("companies")
          .update({ status: "suspended_overage" })
          .eq("id", companyId);

        if (suspendError) throw suspendError;

        return res.json({
          success: true,
          warning: "Limite atteinte — compte bloqué selon votre politique",
          blocked: true,
        });
      }

      // Si pay_as_you_go et Stripe metering activé → reporter à Stripe
      if (subscription.overage_policy === "pay_as_you_go" &&
          subscription.stripe_subscription_id &&
          subscription.stripe_meter_id &&
          newMinutesUsed > limit) {
        const overage = newMinutesUsed - limit;
        await stripe.billing.meterEvents.create({
          event_name: "voice_minutes_overage",
          payload: {
            stripe_customer_id: subscription.stripe_customer_id,
            value: String(usageQuantity),
          },
        });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[BILLING] Track usage error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /webhooks/stripe
// Webhook Stripe — events automatiques
// ─────────────────────────────────────────────────────────────
router.post("/webhook-stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log l'event
  await supabase.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    payload: event.data,
  });

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpdate(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePaid(event.data.object);
        break;
      case "invoice.payment_failed":
        await handleInvoiceFailed(event.data.object);
        break;
      case "payment_method.attached":
        await handlePaymentMethodAttached(event.data.object);
        break;
      default:
        console.log(`[STRIPE] Event non géré : ${event.type}`);
    }

    await supabase
      .from("stripe_webhook_events")
      .update({ processed: true, processed_at: new Date() })
      .eq("stripe_event_id", event.id);

    return res.json({ received: true });
  } catch (err) {
    console.error("[STRIPE] Webhook handler error:", err);
    await supabase
      .from("stripe_webhook_events")
      .update({ error: err.message })
      .eq("stripe_event_id", event.id);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// HANDLERS WEBHOOK
// ─────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  const companyId = session.metadata?.company_id;
  if (!companyId) return;

  const checkoutStatus =
    session.payment_status === "paid"
      ? "active_paid"
      : session.payment_status === "no_payment_required"
        ? "trial"
        : "pending_payment";

  const { data: updatedSubscription, error: subscriptionError } = await supabase
    .from("subscriptions")
    .update({
      stripe_customer_id: session.customer?.id || session.customer,
      stripe_subscription_id: session.subscription?.id || session.subscription,
      payment_status: checkoutStatus,
    })
    .eq("company_id", companyId)
    .select("company_id")
    .maybeSingle();
  if (subscriptionError || !updatedSubscription) {
    throw new Error("checkout_subscription_sync_failed");
  }

  if (checkoutStatus === "active_paid") {
    const { error: companyError } = await supabase
      .from("companies")
      .update({ status: "active" })
      .eq("id", companyId);
    if (companyError) throw new Error("checkout_company_sync_failed");
  }
}

async function handleSubscriptionUpdate(subscription) {
  const companyId = subscription.metadata?.company_id;
  if (!companyId) return;

  const status = mapStripeSubscriptionStatus(
    subscription.status,
    "pending_payment"
  );
  const period = resolveStripeBillingPeriod(subscription);
  const planUpdate = buildConfiguredSubscriptionPlanUpdate({
    configuration: STRIPE_PRICE_CONFIGURATION,
    plans: PLAN_PRICES,
    subscription,
  });

  const { data: updatedSubscription, error } = await supabase
    .from("subscriptions")
    .update({
      stripe_subscription_id: subscription.id,
      payment_status: status,
      ...(period.start
        ? { current_period_start: period.start.slice(0, 10) }
        : {}),
      ...(period.end
        ? {
            current_period_end: period.end.slice(0, 10),
            next_payment_date: period.end.slice(0, 10),
          }
        : {}),
      trial_ends_at: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
      ...planUpdate,
    })
    .eq("company_id", companyId)
    .select("company_id")
    .maybeSingle();
  if (error || !updatedSubscription) {
    throw new Error("subscription_update_sync_failed");
  }

  if (status === "active_paid") {
    const { error: companyError } = await supabase
      .from("companies")
      .update({ status: "active" })
      .eq("id", companyId)
      .eq("status", "trial");
    if (companyError) throw new Error("subscription_company_sync_failed");
  }
}

async function handleSubscriptionDeleted(subscription) {
  const companyId = subscription.metadata?.company_id;
  if (!companyId) return;

  await supabase
    .from("subscriptions")
    .update({ payment_status: "cancelled" })
    .eq("company_id", companyId);

  await supabase
    .from("companies")
    .update({ status: "cancelled" })
    .eq("id", companyId);
}

async function handleInvoicePaid(invoice) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("company_id")
    .eq("stripe_customer_id", invoice.customer)
    .single();

  if (!sub) return;

  await supabase.from("invoices").insert({
    company_id: sub.company_id,
    stripe_invoice_id: invoice.id,
    invoice_number: invoice.number,
    period_start: new Date(invoice.period_start * 1000).toISOString().split("T")[0],
    period_end: new Date(invoice.period_end * 1000).toISOString().split("T")[0],
    subtotal_usd: invoice.subtotal / 100,
    tax_usd: (invoice.tax || 0) / 100,
    total_usd: invoice.total / 100,
    status: "paid",
    payment_method: "stripe",
    paid_at: new Date(),
    invoice_pdf_url: invoice.invoice_pdf,
    receipt_url: invoice.hosted_invoice_url,
  });

  await supabase
    .from("subscriptions")
    .update({
      payment_status: "active_paid",
      last_payment_date: new Date().toISOString().split("T")[0],
      last_payment_amount: invoice.total / 100,
      minutes_used_current_period: 0,
    })
    .eq("company_id", sub.company_id);
}

async function handleInvoiceFailed(invoice) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("company_id")
    .eq("stripe_customer_id", invoice.customer)
    .single();

  if (!sub) return;

  await supabase
    .from("subscriptions")
    .update({ payment_status: "overdue" })
    .eq("company_id", sub.company_id);
}

async function handlePaymentMethodAttached(paymentMethod) {
  const customerId = paymentMethod.customer;
  if (!customerId) return;

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("company_id")
    .eq("stripe_customer_id", customerId)
    .single();

  if (!sub) return;

  await supabase.from("payment_methods").insert({
    company_id: sub.company_id,
    stripe_payment_method_id: paymentMethod.id,
    brand: paymentMethod.card?.brand,
    last4: paymentMethod.card?.last4,
    exp_month: paymentMethod.card?.exp_month,
    exp_year: paymentMethod.card?.exp_year,
    is_default: true,
  });
}

// ─────────────────────────────────────────────────────────────
// GET /api/v1/billing/pricing?country=CA
// Grille de prix selon le pays du client
// CA → CAD + TPS/TVQ + installation 319$
// US → USD sans taxe, sans installation
// EU → EUR sans taxe, sans installation
// Autres → USD sans taxe, sans installation
// ─────────────────────────────────────────────────────────────
router.get("/pricing", async (req, res) => {
  const { country = "CA", billing_cycle = "monthly" } = req.query;

  try {
    const pricing = {};
    for (const planKey of Object.keys(PLAN_PRICES)) {
      pricing[planKey] = getPricingForCountry(planKey, country, billing_cycle);
      pricing[planKey].label = PLAN_PRICES[planKey].label;
      pricing[planKey].minutes_included = PLAN_PRICES[planKey].minutes_included;
      pricing[planKey].overage_rate = PLAN_PRICES[planKey].overage_rate;
    }

    const isCanada = country === "CA";

    return res.json({
      country,
      currency: currencyForCountry(country).toUpperCase(),
      billing_cycle,
      plans: pricing,
      installation: {
        applicable: isCanada,
        amount: isCanada ? INSTALLATION_FEE : 0,
        note: isCanada
          ? "Frais d'installation uniques de 319$ CAD + taxes (Canada uniquement)"
          : "No installation fee",
      },
      taxes: isCanada
        ? {
            tps: "5%",
            tvq: "9,975%",
            collection_enabled: STRIPE_TAX_ENABLED,
            note: STRIPE_TAX_ENABLED
              ? "Taxes canadiennes ajoutées à la facturation"
              : "Collecte Stripe Tax à configurer avant la production",
          }
        : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXEVORI VOICE IA — Endpoint vérification session Stripe post-paiement
// Fichier : ajouter dans backend/modules/billing/index.js
//
// Coller ce bloc AVANT "export default router;"
// ============================================================

// ─────────────────────────────────────────────────────────────
// GET /api/v1/billing/verify-session?session_id=cs_xxx
// Vérifie qu'une session Stripe checkout est bien payée
// et met à jour la subscription en DB
// ─────────────────────────────────────────────────────────────
router.get("/verify-session", async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: "session_id requis" });
  }

  try {
    // Récupérer la session depuis Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription", "customer"],
    });

    const verifiedPaymentStatus = resolveVerifiedCheckoutStatus(session);
    if (!verifiedPaymentStatus) {
      return res.status(409).json({
        success: false,
        error: "abonnement Stripe non actif",
      });
    }

    const companyId = session.metadata?.company_id ||
                      session.subscription?.metadata?.company_id;

    if (!companyId) {
      console.warn("[verify-session] company_id absent du metadata Stripe");
      return res.status(202).json({
        success: false,
        pending: true,
        error: "synchronisation Stripe en cours",
      });
    }

    // Mettre à jour la subscription en DB
    const { data: updatedSubscription, error: subscriptionUpdateError } =
      await supabase.from("subscriptions").update({
      payment_status:      verifiedPaymentStatus,
      stripe_customer_id:  session.customer?.id || session.customer,
      stripe_subscription_id: session.subscription?.id || session.subscription,
    })
        .eq("company_id", companyId)
        .select("company_id")
        .maybeSingle();
    if (subscriptionUpdateError) throw new Error("subscription_sync_failed");
    if (!updatedSubscription) {
      return res.status(409).json({ error: "abonnement introuvable" });
    }

    if (verifiedPaymentStatus === "active_paid") {
      const { error: companyUpdateError } = await supabase
        .from("companies")
        .update({ status: "active" })
        .eq("id", companyId)
        .eq("status", "trial");
      if (companyUpdateError) throw new Error("company_sync_failed");
    }

    console.log(`[verify-session] Paiement confirmé pour company ${companyId}`);

    return res.json({
      success:    true,
      plan:       session.metadata?.plan_name || session.subscription?.metadata?.plan_name,
    });

  } catch (err) {
    console.error("[verify-session] Erreur:", err.message);
    return res.status(503).json({ error: "billing_verification_failed" });
  }
});

export default router;
export { PLAN_PRICES, PLAN_PRICES as PLANS };
