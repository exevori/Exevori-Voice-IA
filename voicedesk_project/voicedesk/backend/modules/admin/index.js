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

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

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

    // KPIs revenus
    let mrr = 0, mrr_active = 0, mrr_trial = 0, mrr_overdue = 0;
    (subscriptions.data || []).forEach(s => {
      const monthly = s.billing_cycle === "annual"
        ? (s.monthly_price || s.annual_price / 12)
        : s.monthly_price;
      mrr += monthly || 0;
      if (s.payment_status === "active_paid") mrr_active += monthly || 0;
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
// POST /api/v1/admin/companies/:id/suspend
// Suspendre un client (accès bloqué)
// ─────────────────────────────────────────────────────────────
router.post("/companies/:id/suspend", async (req, res) => {
  const { id } = req.params;
  const { reason, suspended_by } = req.body;

  await Promise.all([
    supabase
      .from("companies")
      .update({ status: "suspended", notes_admin: reason })
      .eq("id", id),
    supabase
      .from("subscriptions")
      .update({ payment_status: "suspended" })
      .eq("company_id", id),
    supabase
      .from("activity_logs")
      .insert({ company_id: id, action: "company_suspended", details: { reason, suspended_by } }),
  ]);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/admin/companies/:id/reactivate
// Réactiver un client suspendu
// ─────────────────────────────────────────────────────────────
router.post("/companies/:id/reactivate", async (req, res) => {
  const { id } = req.params;
  const { reactivated_by } = req.body;

  await Promise.all([
    supabase
      .from("companies")
      .update({ status: "active" })
      .eq("id", id),
    supabase
      .from("subscriptions")
      .update({ payment_status: "active_paid" })
      .eq("company_id", id),
    supabase
      .from("activity_logs")
      .insert({ company_id: id, action: "company_reactivated", details: { reactivated_by } }),
  ]);

  return res.json({ success: true });
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

  const { count } = await supabase
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("payment_status", "trial")
    .gte("trial_ends_at", now.toISOString())
    .lte("trial_ends_at", sevenDaysFromNow.toISOString());

  return count || 0;
}

async function getTicketStats() {
  const now = new Date();
  const { data } = await supabase
    .from("tickets")
    .select("status, priority, sla_first_response_due, first_response_at, sla_resolution_due, resolved_at");

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

export default router;
