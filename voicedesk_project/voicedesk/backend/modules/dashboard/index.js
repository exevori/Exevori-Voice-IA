// ============================================================
// VOICEDESK IA — MODULE DASHBOARD PME
// Agrégation des KPIs pour le premier écran que voit la PME
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
// GET /api/v1/dashboard/stats
// KPIs principaux pour le dashboard PME
// ─────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const { company_id, period = "today" } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const periodStart = {
      today: todayStart,
      week: weekStart,
      month: monthStart,
    }[period] || todayStart;

    const periodStartISO = periodStart.toISOString();

    const [calls, emails, appointments, contacts, kbSources, qaCount] = await Promise.all([

      supabase.from("calls")
        .select("id, duration_seconds, outcome", { count: "exact" })
        .eq("company_id", company_id)
        .gte("created_at", periodStartISO),

      supabase.from("emails")
        .select("id, status", { count: "exact" })
        .eq("company_id", company_id)
        .gte("received_at", periodStartISO),

      supabase.from("appointments")
        .select("id", { count: "exact" })
        .eq("company_id", company_id)
        .gte("created_at", todayStart.toISOString()),

      supabase.from("contacts")
        .select("id", { count: "exact" })
        .eq("company_id", company_id),

      supabase.from("knowledge_sources")
        .select("id", { count: "exact" })
        .eq("company_id", company_id)
        .eq("status", "ready"),

      supabase.from("knowledge_sources")
        .select("id", { count: "exact" })
        .eq("company_id", company_id)
        .eq("type", "qa"),
    ]);

    const totalCallMinutes = (calls.data || []).reduce(
      (sum, c) => sum + (c.duration_seconds || 0), 0
    ) / 60;

    const successfulCalls = (calls.data || []).filter(c =>
      ["resolved", "appointment_booked", "transferred"].includes(c.outcome)
    ).length;

    return res.json({
      period,
      period_start: periodStartISO,
      kpis: {
        inbound_calls: calls.count || 0,
        outbound_calls: 0,
        total_minutes: Math.round(totalCallMinutes),
        successful_inbound: successfulCalls,
        emails_received: emails.count || 0,
        drafts_pending: 0,
        appointments_upcoming: appointments.count || 0,
        learning_suggestions_pending: 0,
        knowledge_base_size: kbSources.count || 0,
        qa_count: qaCount.count || 0,
        hot_leads: (contacts.data || []).filter(c =>
          ["hot", "hot_lead"].includes(c.status)
        ).length,
        total_contacts: contacts.count || 0,
      },
    });
  } catch (err) {
    console.error("[DASHBOARD] Stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/activity
// Activité récente cross-module (timeline)
// ─────────────────────────────────────────────────────────────
router.get("/activity", async (req, res) => {
  const { company_id, limit = 20 } = req.query;

  try {
    const [calls, outbound, emails, appointments] = await Promise.all([
      supabase.from("calls")
        .select("id, caller_phone, ai_summary, outcome, created_at, contacts(full_name)")
        .eq("company_id", company_id).order("created_at", { ascending: false }).limit(10),
      supabase.from("outbound_calls")
        .select("id, contact_name, ai_summary, outcome, created_at")
        .eq("company_id", company_id).order("created_at", { ascending: false }).limit(10),
      supabase.from("emails")
        .select("id, from_email, from_name, subject, status, received_at")
        .eq("company_id", company_id).order("received_at", { ascending: false }).limit(10),
      supabase.from("appointments")
        .select("id, date, time, type, contacts(full_name)")
        .eq("company_id", company_id).order("date", { ascending: false }).limit(5),
    ]);

    // Combiner toutes les activités
    const activities = [];

    (calls.data || []).forEach(c => activities.push({
      type: "call_inbound",
      icon: "📞",
      title: `Appel entrant — ${c.contacts?.full_name || c.caller_phone}`,
      description: c.ai_summary,
      outcome: c.outcome,
      timestamp: c.created_at,
      link: `/calls/${c.id}`,
    }));

    (outbound.data || []).forEach(c => activities.push({
      type: "call_outbound",
      icon: "📤",
      title: `Appel sortant — ${c.contact_name}`,
      description: c.ai_summary,
      outcome: c.outcome,
      timestamp: c.created_at,
      link: `/outbound/${c.id}`,
    }));

    (emails.data || []).forEach(e => activities.push({
      type: "email",
      icon: "✉️",
      title: `Courriel de ${e.from_name || e.from_email}`,
      description: e.subject,
      outcome: e.status,
      timestamp: e.received_at,
      link: `/emails/${e.id}`,
    }));

    (appointments.data || []).forEach(a => activities.push({
      type: "appointment",
      icon: "📅",
      title: `RDV — ${a.contacts?.full_name}`,
      description: `${a.type} le ${a.date} à ${a.time}`,
      timestamp: a.date,
      link: `/calendar/${a.id}`,
    }));

    // Trier par timestamp desc et limiter
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json({ activities: activities.slice(0, parseInt(limit)) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/alerts
// Alertes importantes pour la PME
// ─────────────────────────────────────────────────────────────
router.get("/alerts", async (req, res) => {
  const { company_id } = req.query;

  try {
    const [subscription, drafts, suggestions, tickets] = await Promise.all([
      supabase.from("subscriptions").select("*").eq("company_id", company_id).single(),
      supabase.from("email_drafts").select("id", { count: "exact", head: true })
        .eq("company_id", company_id).eq("status", "pending_validation"),
      supabase.from("learning_suggestions").select("id", { count: "exact", head: true })
        .eq("company_id", company_id).eq("status", "pending"),
      supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("company_id", company_id).in("status", ["open", "in_progress"]),
    ]);

    const alerts = [];

    // Alerte essai expirant
    if (subscription.data?.payment_status === "trial") {
      const trialEnd = new Date(subscription.data.trial_ends_at);
      const daysLeft = Math.ceil((trialEnd - new Date()) / 86400000);
      if (daysLeft <= 7 && daysLeft > 0) {
        alerts.push({
          type: "trial_ending",
          severity: daysLeft <= 3 ? "high" : "medium",
          title: `Essai gratuit se termine dans ${daysLeft} jour(s)`,
          action: "Choisir un forfait",
          link: "/config/billing",
        });
      }
    }

    // Alerte paiement en retard
    if (subscription.data?.payment_status === "overdue") {
      alerts.push({
        type: "payment_overdue",
        severity: "high",
        title: "Paiement en retard",
        action: "Mettre à jour ma carte",
        link: "/config/billing",
      });
    }

    // Brouillons en attente
    if (drafts.count > 0) {
      alerts.push({
        type: "drafts_pending",
        severity: "medium",
        title: `${drafts.count} brouillon(s) de courriel à valider`,
        action: "Voir les brouillons",
        link: "/emails?tab=drafts",
      });
    }

    // Suggestions d'apprentissage
    if (suggestions.count > 0) {
      alerts.push({
        type: "learning_pending",
        severity: "low",
        title: `${suggestions.count} suggestion(s) d'apprentissage à valider`,
        action: "Examiner",
        link: "/knowledge?tab=suggestions",
      });
    }

    // Tickets ouverts
    if (tickets.count > 0) {
      alerts.push({
        type: "tickets_open",
        severity: "low",
        title: `${tickets.count} ticket(s) de support ouvert(s)`,
        action: "Voir les tickets",
        link: "/support",
      });
    }

    return res.json({ alerts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
