// ============================================================
// VOICEDESK IA — MODULE ADMIN EXEVORI
// Dashboard + suivi consommation par client + rentabilité
//
// Pour le super_admin Exevori uniquement.
// Toutes les routes vérifient is_super_admin().
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Stripe from "stripe";
import { Resend } from "resend";
import { createAdminCompanyRouter } from "./companies.js";
import { createAdminCompanyService, monthlySubscriptionAmount } from "./companyService.js";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();
const companyService = createAdminCompanyService({
  supabase,
  stripe: process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18", timeout: 8000, maxNetworkRetries: 0 })
    : null,
  resend: process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null,
  provisionClient: async input => {
    const { provisionNewClient } = await import("../onboarding/provision_service.js");
    return provisionNewClient(input);
  },
  clearCompanyCache: async () => {
    const { clearProfileCache } = await import("../../middleware/auth.js");
    clearProfileCache();
  },
});

// Défense locale en plus de requireAuth + requireRole au montage de l'app.
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  if (req.user.role !== "super_admin") return res.status(403).json({ error: "forbidden" });
  return next();
});
router.use(createAdminCompanyRouter({ service: companyService }));

// ─────────────────────────────────────────────────────────────
// GET /api/v1/admin/companies
// Liste des PMEs (pour switcher impersonation super_admin)
// ─────────────────────────────────────────────────────────────
router.get("/companies", async (req, res) => {
  try {
    if (req.user?.role !== "super_admin") {
      return res.status(403).json({ error: "forbidden" });
    }
    const { data, error } = await supabase
      .from("companies")
      .select("id, name, city, province, country, plan, status, assistant_name")
      .order("name", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Enrichir avec counts (calls, kb_sources, members) en parallèle par company
    const companies = await Promise.all((data || []).map(async (c) => {
      const [callsRes, kbRes, membersRes] = await Promise.all([
        supabase.from("calls").select("*", { count: "exact", head: true }).eq("company_id", c.id),
        supabase.from("knowledge_sources").select("*", { count: "exact", head: true }).eq("company_id", c.id),
        supabase.from("profiles").select("*", { count: "exact", head: true }).eq("company_id", c.id),
      ]);
      if ([callsRes, kbRes, membersRes].some(result => result.error)) {
        throw new Error("company_counts_unavailable");
      }
      return {
        ...c,
        calls_count: callsRes.count ?? 0,
        kb_sources_count: kbRes.count ?? 0,
        members_count: membersRes.count ?? 0,
      };
    }));

    res.json({ companies, total: companies.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/admin/dashboard
// Dashboard global Exevori : MRR, ARR, churn, coûts, marges
// ─────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const now = new Date();
    const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    const [companies, subscriptions, usageRecords, invoicesThisMonth, ticketStats] = await Promise.all([
      supabase.from("companies").select("status"),
      supabase.from("subscriptions").select("*"),
      supabase.from("usage_records").select("*").eq("period_start", periodStart),
      supabase.from("invoices").select("*").eq("period_start", periodStart),
      getTicketStats(),
    ]);
    if ([companies, subscriptions, usageRecords, invoicesThisMonth].some(result => result.error)) {
      throw new Error("admin_dashboard_unavailable");
    }

    // KPIs revenus
    let mrr = 0, mrr_active = 0, mrr_trial = 0, mrr_overdue = 0;
    (subscriptions.data || []).forEach(s => {
      const monthly = monthlySubscriptionAmount(s);
      mrr += monthly || 0;
      if (["active", "active_paid"].includes(s.payment_status)) mrr_active += monthly || 0;
      else if (s.payment_status === "trial") mrr_trial += monthly || 0;
      else if (s.payment_status === "overdue") mrr_overdue += monthly || 0;
    });

    // KPIs clients
    const clientStats = {
      total:      companies.data?.length || 0,
      active:     companies.data?.filter(c => c.status === "active").length || 0,
      trial:      companies.data?.filter(c => c.status === "trial").length || 0,
      overdue:    companies.data?.filter(c => c.status === "overdue").length || 0,
      suspended:  companies.data?.filter(c => c.status === "suspended").length || 0,
      cancelled:  companies.data?.filter(c => c.status === "cancelled").length || 0,
    };

    // KPIs coûts infra
    let totalCost = 0;
    let costByResource = { voice_minutes: 0, ai_tokens: 0, email_sends: 0, sms_sends: 0 };
    (usageRecords.data || []).forEach(r => {
      const cost = parseFloat(r.total_cost_usd) || 0;
      totalCost += cost;
      costByResource[r.resource_type] = (costByResource[r.resource_type] || 0) + cost;
    });

    // KPIs facturation
    const invoicesPaid = (invoicesThisMonth.data || []).filter(i => i.status === "paid");
    const totalRevenueThisMonth = invoicesPaid.reduce((sum, i) => sum + parseFloat(i.total_usd || 0), 0);

    return res.json({
      revenue: {
        mrr_total: mrr,
        arr_estimated: mrr * 12,
        mrr_active_paid: mrr_active,
        mrr_trial: mrr_trial,
        mrr_overdue: mrr_overdue,
        revenue_this_month: totalRevenueThisMonth,
      },
      clients: clientStats,
      costs: {
        total_this_month: totalCost,
        by_resource: costByResource,
      },
      margins: {
        gross_revenue: totalRevenueThisMonth,
        gross_cost: totalCost,
        gross_profit: totalRevenueThisMonth - totalCost,
        margin_percent: totalRevenueThisMonth > 0
          ? Math.round(((totalRevenueThisMonth - totalCost) / totalRevenueThisMonth) * 100)
          : 0,
      },
      tickets: ticketStats,
      alerts: {
        clients_overdue: clientStats.overdue,
        trials_ending_soon: await getTrialsEndingSoon(),
        sla_breached: ticketStats.sla_breached || 0,
      },
    });
  } catch (err) {
    console.error("[ADMIN] Dashboard error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/admin/companies/:id/profitability
// Rentabilité détaillée d'un client (revenu vs coût)
// ─────────────────────────────────────────────────────────────
router.get("/companies/:id/profitability", async (req, res) => {
  const { id: company_id } = req.params;
  const { months = 1 } = req.query;

  try {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const periodStart = startDate.toISOString().split("T")[0];

    const [subscription, usageRecords, invoices, creditGrants] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("company_id", company_id).single(),
      supabase.from("usage_records").select("*").eq("company_id", company_id)
        .gte("period_start", periodStart),
      supabase.from("invoices").select("*").eq("company_id", company_id)
        .gte("period_start", periodStart),
      supabase.from("credit_grants").select("*").eq("company_id", company_id)
        .eq("status", "used"),
    ]);

    // Revenu généré
    const revenue = (invoices.data || [])
      .filter(i => i.status === "paid")
      .reduce((sum, i) => sum + parseFloat(i.total_usd || 0), 0);

    // Coût réel généré
    const totalCost = (usageRecords.data || [])
      .reduce((sum, r) => sum + parseFloat(r.total_cost_usd || 0), 0);

    // Coûts détaillés par ressource
    const costBreakdown = {
      voice_minutes: 0, ai_tokens: 0, email_sends: 0, sms_sends: 0,
    };
    (usageRecords.data || []).forEach(r => {
      costBreakdown[r.resource_type] = (costBreakdown[r.resource_type] || 0) + parseFloat(r.total_cost_usd || 0);
    });

    // Crédits accordés
    const creditsGiven = (creditGrants.data || [])
      .reduce((sum, c) => sum + parseFloat(c.amount_usd || 0), 0);

    return res.json({
      subscription: subscription.data,
      period_months: months,
      revenue: {
        gross_revenue: revenue,
        credits_given: creditsGiven,
        net_revenue: revenue - creditsGiven,
      },
      costs: {
        total: totalCost,
        breakdown: costBreakdown,
      },
      profitability: {
        gross_profit: revenue - totalCost,
        net_profit: (revenue - creditsGiven) - totalCost,
        margin_percent: revenue > 0
          ? Math.round(((revenue - totalCost) / revenue) * 100)
          : 0,
      },
      invoices: invoices.data || [],
      credit_grants: creditGrants.data || [],
    });
  } catch (err) {
    console.error("[ADMIN] Profitability error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/admin/credits
// Donner un crédit / rabais / gratuité à un client
// ─────────────────────────────────────────────────────────────
router.post("/credits", async (req, res) => {
  const { company_id, amount_usd, reason, type = "discount", expires_at, granted_by, notes } = req.body;

  try {
    const { data: credit } = await supabase
      .from("credit_grants")
      .insert({
        company_id, amount_usd, reason, type, expires_at, granted_by, notes,
        status: "active",
      })
      .select()
      .single();

    return res.json({ success: true, credit });
  } catch (err) {
    console.error("[ADMIN] Credit error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/admin/invoices/:id/mark-paid
// Marquer une facture comme payée (paiement manuel)
// ─────────────────────────────────────────────────────────────
router.post("/invoices/:id/mark-paid", async (req, res) => {
  const { id } = req.params;
  const { payment_method = "manual_transfer", marked_by, notes } = req.body;

  const { data: invoice } = await supabase
    .from("invoices")
    .update({
      status: "paid",
      payment_method,
      paid_at: new Date(),
      notes: notes || null,
    })
    .eq("id", id)
    .select()
    .single();

  if (invoice) {
    await supabase
      .from("subscriptions")
      .update({
        payment_status: "active_paid",
        last_payment_date: new Date().toISOString().split("T")[0],
        last_payment_amount: invoice.total_usd,
      })
      .eq("company_id", invoice.company_id);
  }

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/admin/usage/all
// Vue de toute la consommation (tous clients)
// ─────────────────────────────────────────────────────────────
router.get("/usage/all", async (req, res) => {
  const { period } = req.query;
  const periodStart = period || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;

  const { data } = await supabase
    .from("usage_records")
    .select("*, companies(name, contact_name, plan)")
    .eq("period_start", periodStart)
    .order("total_cost_usd", { ascending: false });

  return res.json({ usage_records: data || [], period_start: periodStart });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function getTrialsEndingSoon() {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 86400000);

  const { count, error } = await supabase
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("payment_status", "trial")
    .gte("trial_ends_at", now.toISOString())
    .lte("trial_ends_at", sevenDaysFromNow.toISOString());
  if (error) throw new Error("trial_stats_unavailable");
  return count || 0;
}

async function getTicketStats() {
  const now = new Date();
  const { data, error } = await supabase
    .from("tickets")
    .select("status, priority, sla_first_response_due, first_response_at, sla_resolution_due, resolved_at");
  if (error) throw new Error("ticket_stats_unavailable");

  const stats = {
    total: data?.length || 0,
    open: 0, in_progress: 0, waiting_client: 0, resolved: 0, closed: 0,
    sla_breached: 0,
    sla_at_risk: 0,
    by_priority_urgent: 0,
    by_priority_high: 0,
  };

  (data || []).forEach(t => {
    stats[t.status] = (stats[t.status] || 0) + 1;
    if (t.priority === "urgent") stats.by_priority_urgent++;
    if (t.priority === "high") stats.by_priority_high++;

    if (t.status === "resolved" || t.status === "closed") return;

    const dueResponse = t.sla_first_response_due ? new Date(t.sla_first_response_due) : null;
    const dueResolution = t.sla_resolution_due ? new Date(t.sla_resolution_due) : null;

    if (!t.first_response_at && dueResponse && dueResponse < now) stats.sla_breached++;
    else if (!t.resolved_at && dueResolution && dueResolution < now) stats.sla_breached++;
    else if (!t.first_response_at && dueResponse && (dueResponse - now) < 3600000) stats.sla_at_risk++;
  });

  return stats;
}

// ============================================================
// EXEVORI VOICE IA — Endpoint statut des providers externes
// Fichier : ajouter dans backend/modules/admin/index.js
//
// Coller ce bloc AVANT "export default router;"
//
// Vérifie en temps réel : Groq, ElevenLabs, Twilio, Supabase
// Utilisé par la page frontend Monitoring.jsx
// ============================================================

// ─────────────────────────────────────────────────────────────
// GET /api/v1/admin/provider-status
// Ping rapide de chaque provider externe — mesure latence + statut
// ─────────────────────────────────────────────────────────────
router.get("/provider-status", async (req, res) => {
  if (req.user?.role !== "super_admin") {
    return res.status(403).json({ error: "forbidden" });
  }

  const checkWithTimeout = async (fn, timeoutMs = 5000) => {
    const t0 = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      return { status: "ok", latency: Date.now() - t0, detail: result || null };
    } catch (err) {
      return { status: "error", latency: Date.now() - t0, detail: err.message };
    }
  };

  // ── Groq ────────────────────────────────────────────────
  const groqCheck = checkWithTimeout(async () => {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY absent");
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return "API accessible";
  });

  // ── ElevenLabs ──────────────────────────────────────────
  const elevenCheck = checkWithTimeout(async () => {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY absent");
    const r = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return `Quota: ${data.subscription?.character_count || 0}/${data.subscription?.character_limit || "?"}`;
  });

  // ── Twilio ──────────────────────────────────────────────
  const twilioCheck = checkWithTimeout(async () => {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error("Credentials Twilio absentes");
    }
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return `Compte: ${data.status}`;
  });

  // ── Supabase ────────────────────────────────────────────
  const supabaseCheck = checkWithTimeout(async () => {
    const { error } = await supabase.from("companies").select("id").limit(1);
    if (error) throw new Error(error.message);
    return "Connexion DB OK";
  });

  const [groq, elevenlabs, twilio, supa] = await Promise.all([
    groqCheck, elevenCheck, twilioCheck, supabaseCheck,
  ]);

  return res.json({
    groq:       { status: groq.status,       latency: groq.latency,       detail: groq.detail },
    elevenlabs: { status: elevenlabs.status,  latency: elevenlabs.latency, detail: elevenlabs.detail },
    twilio:     { status: twilio.status,      latency: twilio.latency,     detail: twilio.detail },
    supabase:   { status: supa.status,        latency: supa.latency,       detail: supa.detail },
    checked_at: new Date().toISOString(),
  });
});

export default router;
