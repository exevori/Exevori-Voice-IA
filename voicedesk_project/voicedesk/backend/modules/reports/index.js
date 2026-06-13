// ============================================================
// EXEVORI VOICE IA — MODULE REPORTS (Phase Reports+A)
//
// Routes :
//   GET /api/v1/reports/summary?company_id=...&period=today|week|month|year
//     → 4 KPIs principaux + breakdown Avant/Après (TimeSavedCard) + sparkline série temporelle
//
// Lecture seule, agrège calls + emails + email_drafts + appointments.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const router = express.Router();

// Facteurs ROI configurables (ENV ou défauts Québec PME)
const PME_HOURLY_RATE_CAD       = Number(process.env.PME_HOURLY_RATE_CAD       || 35);  // taux horaire moyen
const SEC_PER_EMAIL_WITHOUT_AI  = Number(process.env.SEC_PER_EMAIL_WITHOUT_AI  || 180); // 3 min/email lu+répondu manuellement
const SEC_PER_APPOINTMENT_BOOK  = Number(process.env.SEC_PER_APPOINTMENT_BOOK  || 300); // 5 min/RDV pris au téléphone
const SEC_PER_DRAFT_VALIDATION  = Number(process.env.SEC_PER_DRAFT_VALIDATION  || 60);  // 1 min/draft validé
const SEC_PER_TRANSFER          = Number(process.env.SEC_PER_TRANSFER          || 120); // 2 min/appel transféré

// ─────────────────────────────────────────────────────────────
// GET /summary
// ─────────────────────────────────────────────────────────────
router.get("/summary", async (req, res) => {
  const { company_id, period = "week" } = req.query;
  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const { start, end, label, granularity } = resolvePeriod(period);

    // Pull aggregated data en parallèle
    const [callsRes, emailsRes, draftsRes, apptsRes] = await Promise.all([
      supabase.from("calls")
        .select("id, duration_seconds, outcome, status, created_at")
        .eq("company_id", company_id)
        .gte("created_at", start.toISOString())
        .lt("created_at",  end.toISOString()),
      supabase.from("emails")
        .select("id, status, received_at, classification")
        .eq("company_id", company_id)
        .gte("received_at", start.toISOString())
        .lt("received_at",  end.toISOString()),
      supabase.from("email_drafts")
        .select("id, status, created_at")
        .eq("company_id", company_id)
        .gte("created_at", start.toISOString())
        .lt("created_at",  end.toISOString()),
      supabase.from("appointments")
        .select("id, date, status, source, created_at")
        .eq("company_id", company_id)
        .gte("date", start.toISOString().split("T")[0])
        .lt("date",  end.toISOString().split("T")[0]),
    ]);

    const calls  = callsRes.data  || [];
    const emails = emailsRes.data || [];
    const drafts = draftsRes.data || [];
    const appts  = apptsRes.data  || [];

    // ─── KPIs ─────────────────────────────────────────────────
    const totalHandled       = calls.length + emails.length;
    const appointmentsBooked = appts.length;

    const successfulCalls = calls.filter((c) =>
      ["resolved", "appointment_booked", "transferred", "info_provided"].includes(c.outcome || "")
    ).length;
    const recoveryRatePct = totalHandled === 0
      ? 0
      : Math.round(((successfulCalls + emails.filter((e) => e.status === "processed").length) / totalHandled) * 100);

    // ─── Avant / Après ────────────────────────────────────────
    // Sans Léa : temps que la PME aurait passé manuellement
    const sansLeaSeconds =
        calls.reduce((s, c) => s + (c.duration_seconds || 0), 0)  // chaque appel
      + emails.length * SEC_PER_EMAIL_WITHOUT_AI                  // chaque email lu+répondu manuellement
      + appointmentsBooked * SEC_PER_APPOINTMENT_BOOK;            // chaque RDV pris au téléphone

    // Avec Léa : temps réel passé par la PME (validation drafts + reprise appels transférés)
    const transferredCalls = calls.filter((c) => c.outcome === "transferred").length;
    const pendingValidatedDrafts = drafts.filter((d) => ["sent", "rejected", "approved"].includes(d.status)).length;
    const avecLeaSeconds =
        pendingValidatedDrafts * SEC_PER_DRAFT_VALIDATION
      + transferredCalls * SEC_PER_TRANSFER;

    const savedSeconds = Math.max(0, sansLeaSeconds - avecLeaSeconds);
    const savedHours   = savedSeconds / 3600;
    const savedCAD     = Math.round(savedHours * PME_HOURLY_RATE_CAD * 100) / 100;

    // ─── Série temporelle (sparkline) ────────────────────────
    const series = buildSeries({ calls, emails, drafts, apptsCount: appointmentsBooked, start, end, granularity });

    return res.json({
      period: { key: period, label, start: start.toISOString(), end: end.toISOString(), granularity },
      kpis: {
        total_handled:        totalHandled,
        appointments_booked:  appointmentsBooked,
        time_saved_seconds:   savedSeconds,
        recovery_rate_pct:    recoveryRatePct,
      },
      time_saved: {
        sans_lea_seconds:  Math.round(sansLeaSeconds),
        avec_lea_seconds:  Math.round(avecLeaSeconds),
        saved_seconds:     Math.round(savedSeconds),
        saved_hours:       Math.round(savedHours * 10) / 10,
        saved_cad:         savedCAD,
        hourly_rate_cad:   PME_HOURLY_RATE_CAD,
        breakdown: {
          calls_seconds:               calls.reduce((s, c) => s + (c.duration_seconds || 0), 0),
          emails_seconds_equivalent:   emails.length * SEC_PER_EMAIL_WITHOUT_AI,
          appointments_seconds_equiv:  appointmentsBooked * SEC_PER_APPOINTMENT_BOOK,
          drafts_validated_seconds:    pendingValidatedDrafts * SEC_PER_DRAFT_VALIDATION,
          transfers_seconds:           transferredCalls * SEC_PER_TRANSFER,
        },
      },
      series,
      counts: {
        calls:        calls.length,
        emails:       emails.length,
        drafts:       drafts.length,
        appointments: appointmentsBooked,
        transferred:  transferredCalls,
      },
    });
  } catch (err) {
    console.error("[REPORTS] summary error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HELPERS
// ============================================================

function resolvePeriod(period) {
  const now = new Date();
  let start, end, label, granularity;

  switch (period) {
    case "today": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end   = new Date(start.getTime() + 24 * 3600 * 1000);
      label = "Aujourd'hui";
      granularity = "hour";
      break;
    }
    case "week": {
      start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      end   = new Date(now.getTime() + 1 * 24 * 3600 * 1000);
      label = "7 derniers jours";
      granularity = "day";
      break;
    }
    case "month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      label = "Ce mois-ci";
      granularity = "day";
      break;
    }
    case "year": {
      start = new Date(now.getFullYear(), 0, 1);
      end   = new Date(now.getFullYear() + 1, 0, 1);
      label = "Cette année";
      granularity = "month";
      break;
    }
    default: {
      start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      end   = new Date(now.getTime() + 1 * 24 * 3600 * 1000);
      label = "7 derniers jours";
      granularity = "day";
    }
  }
  return { start, end, label, granularity };
}

function buildSeries({ calls, emails, apptsCount, start, end, granularity }) {
  // Bucketize calls + emails par granularité
  const buckets = new Map();
  const keyFn = (dateStr) => {
    const d = new Date(dateStr);
    if (granularity === "hour") {
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
    }
    if (granularity === "month") {
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };

  // Init tous les buckets vides pour avoir une série continue
  const step = granularity === "hour"  ? 3600 * 1000
             : granularity === "month" ? 30 * 24 * 3600 * 1000  // approx
             : 24 * 3600 * 1000;
  const cursor = new Date(start);
  while (cursor < end) {
    buckets.set(keyFn(cursor.toISOString()), { calls: 0, emails: 0, time_saved_seconds: 0 });
    if (granularity === "month") {
      cursor.setMonth(cursor.getMonth() + 1);
    } else {
      cursor.setTime(cursor.getTime() + step);
    }
  }

  for (const c of calls) {
    const k = keyFn(c.created_at);
    if (!buckets.has(k)) buckets.set(k, { calls: 0, emails: 0, time_saved_seconds: 0 });
    const b = buckets.get(k);
    b.calls += 1;
    b.time_saved_seconds += (c.duration_seconds || 0);
  }
  for (const e of emails) {
    const k = keyFn(e.received_at);
    if (!buckets.has(k)) buckets.set(k, { calls: 0, emails: 0, time_saved_seconds: 0 });
    const b = buckets.get(k);
    b.emails += 1;
    b.time_saved_seconds += 180;  // 3 min eq.
  }

  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([t, v]) => ({ t, ...v }));
}

function pad(n) { return String(n).padStart(2, "0"); }

export default router;
