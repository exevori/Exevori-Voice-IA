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

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18" });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// ── PRIX DES FORFAITS ─────────────────────────────────────────
// ── PRIX MULTI-DEVISE ──
// Source de vérité : shared/constants.js
// Même chiffre dans toutes les devises (79 = 79$ CAD = 79$ USD = 79€)
// CA : + TPS/TVQ + installation 319$ | US/EU/Monde : sans taxe, sans installation
import {
  PLANS as SHARED_PLANS,
  TAXES_CA,
  EU_COUNTRIES,
  INSTALLATION_FEE,
  INSTALLATION_FEE_COUNTRIES,
  getPricingForCountry,
} from "../../../shared/constants.js";

const PLANS = {
  solo:          { label: "Solo",          price: 79,  minutes: 150,   overage_rate: 0.35 },
  demarrage:     { label: "Démarrage",     price: 159, minutes: 400,   overage_rate: 0.30 },
  essentiel:     { label: "Essentiel",     price: 319, minutes: 1000,  overage_rate: 0.25 },
  professionnel: { label: "Professionnel", price: 529, minutes: 2500,  overage_rate: 0.20 },
  entreprise:    { label: "Entreprise",    price: 949, minutes: 6000,  overage_rate: 0.15 },
};

// Devise Stripe selon pays
function currencyForCountry(country) {
  if (country === "CA") return "cad";
  if (country === "US") return "usd";
  if (EU_COUNTRIES.includes(country)) return "eur";
  return "usd";
}

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/checkout
// Créer une session Stripe Checkout pour s'abonner
// ─────────────────────────────────────────────────────────────
router.post("/checkout", async (req, res) => {
  const { company_id, plan_name, billing_cycle = "monthly", country: countryOverride } = req.body;

  try {
    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("id", company_id)
      .single();

    if (!company) return res.status(404).json({ error: "company introuvable" });

    const plan = PLANS[plan_name];
    if (!plan) return res.status(400).json({ error: "plan invalide" });

    // Récupérer ou créer le customer Stripe
    let { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("company_id", company_id)
      .single();

    let customerId = sub?.stripe_customer_id;
    if (!customerId) {
      const billingCountry = countryOverride || company.billing_country || "CA";
      const customer = await stripe.customers.create({
        email: company.contact_email,
        name: company.contact_name,
        metadata: { company_id, company_name: company.name, billing_country: billingCountry },
        address: { country: billingCountry, state: billingCountry === "CA" ? (company.province || "QC") : undefined },
      });
      customerId = customer.id;
    }

    // ── MULTI-DEVISE ──
    // Même chiffre dans toutes les devises (79$ CAD = 79$ USD = 79€)
    const billingCountry = countryOverride || company.billing_country || "CA";
    const stripeCurrency = currencyForCountry(billingCountry);
    const isCanada = billingCountry === "CA";

    // Calcul prix avec remise annuelle
    const basePrice = billing_cycle === "annual"
      ? Math.round(plan.price * 12 * 0.80)
      : plan.price;

    // Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `VoiceDesk IA — ${plan.label}`,
              description: `${plan.minutes} minutes incluses/mois`,
            },
            unit_amount: basePrice * 100,
            recurring: {
              interval: billing_cycle === "annual" ? "year" : "month",
            },
          },
          quantity: 1,
        },
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
      automatic_tax: { enabled: isCanada },
      subscription_data: {
        metadata: { company_id, plan_name },
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
router.post("/portal", async (req, res) => {
  const { company_id } = req.body;

  try {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("company_id", company_id)
      .single();

    if (!sub?.stripe_customer_id) {
      return res.status(404).json({ error: "Pas de compte Stripe pour ce client" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/config/billing`,
      locale: "fr-CA",
    });

    return res.json({ portal_url: portalSession.url });
  } catch (err) {
    console.error("[BILLING] Portal error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/billing/me
// Consultation par le client de son propre abonnement
// ─────────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  const { company_id } = req.query;

  try {
    const [sub, currentUsage, invoices, paymentMethods] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("company_id", company_id).single(),
      getCurrentPeriodUsage(company_id),
      supabase.from("invoices").select("*").eq("company_id", company_id)
        .order("created_at", { ascending: false }).limit(12),
      supabase.from("payment_methods").select("*").eq("company_id", company_id),
    ]);

    const subscription = sub.data;
    if (!subscription) return res.json({ subscription: null });

    const plan = PLANS[subscription.plan_name];
    const minutesUsed = currentUsage.voice_minutes || 0;
    const minutesIncluded = subscription.minutes_included || plan?.minutes || 0;
    const minutesOverage = Math.max(0, minutesUsed - minutesIncluded);
    const overageRate = subscription.overage_rate_usd || plan?.overage_rate || 0;
    const estimatedOverageCost = minutesOverage * overageRate;

    return res.json({
      subscription: {
        plan_name: subscription.plan_name,
        plan_label: plan?.label,
        monthly_price: subscription.monthly_price,
        billing_cycle: subscription.billing_cycle,
        payment_status: subscription.payment_status,
        overage_policy: subscription.overage_policy,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        trial_ends_at: subscription.trial_ends_at,
        next_payment_date: subscription.next_payment_date,
      },
      usage: {
        minutes_used: minutesUsed,
        minutes_included: minutesIncluded,
        minutes_remaining: Math.max(0, minutesIncluded - minutesUsed),
        minutes_overage: minutesOverage,
        usage_percentage: minutesIncluded > 0 ? Math.round((minutesUsed / minutesIncluded) * 100) : 0,
        overage_rate_per_minute: overageRate,
        estimated_overage_cost: estimatedOverageCost,
        ai_tokens_used: currentUsage.ai_tokens || 0,
        emails_sent: currentUsage.email_sends || 0,
      },
      invoices: invoices.data || [],
      payment_methods: paymentMethods.data || [],
    });
  } catch (err) {
    console.error("[BILLING] Me error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/overage-policy
// Le client choisit : pay_as_you_go OU block_at_limit
// ─────────────────────────────────────────────────────────────
router.post("/overage-policy", async (req, res) => {
  const { company_id, overage_policy } = req.body;

  if (!["pay_as_you_go", "block_at_limit"].includes(overage_policy)) {
    return res.status(400).json({ error: "overage_policy invalide" });
  }

  await supabase
    .from("subscriptions")
    .update({ overage_policy, updated_at: new Date() })
    .eq("company_id", company_id);

  return res.json({ success: true, overage_policy });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/change-plan
// Le client demande de changer de forfait
// ─────────────────────────────────────────────────────────────
router.post("/change-plan", async (req, res) => {
  const { company_id, new_plan } = req.body;

  if (!PLANS[new_plan]) return res.status(400).json({ error: "plan invalide" });

  try {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("company_id", company_id)
      .single();

    if (sub.stripe_subscription_id) {
      // Mettre à jour Stripe (prorata automatique)
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{
          id: stripeSub.items.data[0].id,
          price_data: {
            currency: stripeCurrency,
            product: stripeSub.items.data[0].price.product,
            unit_amount: PLANS[new_plan].price * 100,
            recurring: { interval: "month" },
          },
        }],
        proration_behavior: "create_prorations",
      });
    }

    // Mettre à jour Supabase
    await supabase
      .from("subscriptions")
      .update({
        plan_name: new_plan,
        plan_label: PLANS[new_plan].label,
        monthly_price: PLANS[new_plan].price,
        minutes_included: PLANS[new_plan].minutes,
        overage_rate_usd: PLANS[new_plan].overage_rate,
        updated_at: new Date(),
      })
      .eq("company_id", company_id);

    return res.json({ success: true, new_plan, label: PLANS[new_plan].label });
  } catch (err) {
    console.error("[BILLING] Change plan error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/billing/track-usage
// Enregistrer la consommation (appelé après chaque appel/email)
// ─────────────────────────────────────────────────────────────
router.post("/track-usage", async (req, res) => {
  const { company_id, resource_type, quantity, unit_cost_usd = 0 } = req.body;

  try {
    const now = new Date();
    const period_start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const period_end = lastDay.toISOString().split("T")[0];

    // Upsert dans usage_records
    const { data: existing } = await supabase
      .from("usage_records")
      .select("*")
      .eq("company_id", company_id)
      .eq("period_start", period_start)
      .eq("resource_type", resource_type)
      .single();

    if (existing) {
      await supabase
        .from("usage_records")
        .update({
          quantity: parseFloat(existing.quantity) + quantity,
          total_cost_usd: parseFloat(existing.total_cost_usd) + (quantity * unit_cost_usd),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("usage_records").insert({
        company_id, period_start, period_end,
        resource_type, quantity, unit_cost_usd,
        total_cost_usd: quantity * unit_cost_usd,
      });
    }

    // Si voice_minutes, mettre à jour le compteur sur subscriptions
    if (resource_type === "voice_minutes") {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("company_id", company_id)
        .single();

      const newMinutesUsed = (sub.minutes_used_current_period || 0) + quantity;
      await supabase
        .from("subscriptions")
        .update({ minutes_used_current_period: newMinutesUsed })
        .eq("company_id", company_id);

      // Si block_at_limit et dépassement → bloquer
      const limit = sub.minutes_included;
      if (sub.overage_policy === "block_at_limit" && newMinutesUsed >= limit) {
        await supabase
          .from("companies")
          .update({ status: "suspended_overage" })
          .eq("id", company_id);

        return res.json({
          success: true,
          warning: "Limite atteinte — compte bloqué selon votre politique",
          blocked: true,
        });
      }

      // Si pay_as_you_go et Stripe metering activé → reporter à Stripe
      if (sub.overage_policy === "pay_as_you_go" &&
          sub.stripe_subscription_id &&
          sub.stripe_meter_id &&
          newMinutesUsed > limit) {
        const overage = newMinutesUsed - limit;
        await stripe.billing.meterEvents.create({
          event_name: "voice_minutes_overage",
          payload: {
            stripe_customer_id: sub.stripe_customer_id,
            value: String(quantity),
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

  await supabase
    .from("subscriptions")
    .update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      payment_status: "active_paid",
    })
    .eq("company_id", companyId);

  await supabase.from("companies").update({ status: "active" }).eq("id", companyId);
}

async function handleSubscriptionUpdate(subscription) {
  const companyId = subscription.metadata?.company_id;
  if (!companyId) return;

  const planName = subscription.metadata?.plan_name;
  const status = mapStripeStatus(subscription.status);

  await supabase
    .from("subscriptions")
    .update({
      stripe_subscription_id: subscription.id,
      payment_status: status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString().split("T")[0],
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString().split("T")[0],
      next_payment_date: new Date(subscription.current_period_end * 1000).toISOString().split("T")[0],
      trial_ends_at: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
    })
    .eq("company_id", companyId);
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

function mapStripeStatus(stripeStatus) {
  const map = {
    "active": "active_paid",
    "trialing": "trial",
    "past_due": "overdue",
    "canceled": "cancelled",
    "incomplete": "pending_payment",
    "incomplete_expired": "cancelled",
    "unpaid": "overdue",
  };
  return map[stripeStatus] || "pending_payment";
}

async function getCurrentPeriodUsage(companyId) {
  const now = new Date();
  const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const { data } = await supabase
    .from("usage_records")
    .select("resource_type, quantity")
    .eq("company_id", companyId)
    .eq("period_start", periodStart);

  const result = { voice_minutes: 0, ai_tokens: 0, email_sends: 0, sms_sends: 0 };
  (data || []).forEach(r => {
    result[r.resource_type] = parseFloat(r.quantity);
  });
  return result;
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
    for (const planKey of Object.keys(PLANS)) {
      pricing[planKey] = getPricingForCountry(planKey, country, billing_cycle);
      pricing[planKey].label = PLANS[planKey].label;
      pricing[planKey].minutes_included = PLANS[planKey].minutes;
      pricing[planKey].overage_rate = PLANS[planKey].overage_rate;
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
        ? { tps: "5%", tvq: "9,975%", note: "Taxes canadiennes ajoutées à la facturation" }
        : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
export { PLANS };
