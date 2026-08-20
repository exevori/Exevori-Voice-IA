// ============================================================
// EXEVORI VOICE IA — DASHBOARD CLIENT
//
// Données réelles, lecture seule, isolées par tenant.
// Les appels entrants et sortants vivent dans deux tables distinctes.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const defaultSupabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGREST_PAGE_SIZE = 1_000;
const MAX_ACTIVITY_LIMIT = 50;
const DEFAULT_ACTIVITY_LIMIT = 8;
const TRANSFER_TAKEOVER_SECONDS = 120;

const AI_RESOLVED_OUTCOMES = new Set([
  "resolved",
  "appointment_booked",
  "info_provided",
]);
const TERMINAL_INBOUND_STATUSES = new Set([
  "completed",
  "abandoned",
  "transferred",
  "failed",
]);
const TERMINAL_OUTBOUND_STATUSES = new Set([
  "completed",
  "voicemail",
  "no_answer",
  "failed",
  "cancelled",
]);
const OPEN_TICKET_STATUSES = ["open", "in_progress", "waiting_client"];
const CANCELLED_APPOINTMENT_STATUSES = new Set(["cancelled", "canceled"]);

class DashboardStorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "DashboardStorageError";
    this.code = code;
  }
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Fenêtres du dashboard.
 *
 * - appels/contacts : fenêtre glissante de 7 jours, jusqu'à `now`
 * - rendez-vous : semaine civile UTC, lundi inclus à lundi exclu
 * - minutes : les dates de période de l'abonnement sont utilisées si présentes;
 *   la fenêtre mensuelle UTC sert uniquement de repli.
 */
export function buildDashboardWindows(nowValue = new Date()) {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("invalid_dashboard_now");
  }

  const callsStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const dayOffsetFromMonday = (now.getUTCDay() + 6) % 7;
  const weekStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - dayOffsetFromMonday
    )
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );

  return {
    calls_7d: {
      start: callsStart.toISOString(),
      end: now.toISOString(),
    },
    appointments_week: {
      start: formatDate(weekStart),
      end: formatDate(weekEnd),
    },
    month: {
      start: formatDate(monthStart),
      end: formatDate(monthEnd),
    },
  };
}

function resolveTargetCompany(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const requestedCompanyId = req.query?.company_id;
  if (requestedCompanyId !== undefined && !isUuid(requestedCompanyId)) {
    res.status(400).json({ error: "invalid_company_id" });
    return null;
  }

  if (req.user.role === "super_admin") {
    if (!requestedCompanyId) {
      res.status(400).json({ error: "company_id_required" });
      return null;
    }
    return requestedCompanyId;
  }

  const actorCompanyId = req.user.company_id;
  if (!isUuid(actorCompanyId)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  if (
    requestedCompanyId !== undefined &&
    requestedCompanyId !== actorCompanyId
  ) {
    res.status(403).json({ error: "cross_tenant_forbidden" });
    return null;
  }

  return actorCompanyId;
}

async function readAllPages(buildQuery, errorCode) {
  const rows = [];
  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const { data, error } = await buildQuery()
      .order("id", { ascending: true })
      .range(from, from + POSTGREST_PAGE_SIZE - 1);
    if (error) throw new DashboardStorageError(errorCode);
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < POSTGREST_PAGE_SIZE) return rows;
  }
}

async function readCount(query, errorCode) {
  const { count, error } = await query;
  if (error) throw new DashboardStorageError(errorCode);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function readMaybeOne(query, errorCode) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new DashboardStorageError(errorCode);
  return data || null;
}

function isTerminalInbound(call) {
  return TERMINAL_INBOUND_STATUSES.has(normalizeText(call?.status));
}

function isTerminalOutbound(call) {
  return TERMINAL_OUTBOUND_STATUSES.has(normalizeText(call?.status));
}

function isTransferred(call) {
  const status = normalizeText(call?.status);
  const outcome = normalizeText(call?.outcome);
  return status === "transferred" || outcome.startsWith("transferred");
}

/**
 * Calcul ROI documenté:
 *
 * Temps économisé = durée réellement traitée par l'IA sur les appels terminés.
 * Pour un transfert humain, 120 secondes sont retranchées afin de représenter
 * le temps de reprise par l'équipe. Les rendez-vous ne sont pas ajoutés sous
 * forme de forfait, car leur temps est déjà inclus dans la durée de l'appel.
 */
export function calculateDashboardMetrics({
  inboundCalls = [],
  outboundCalls = [],
  appointments = [],
  contactsCreated = 0,
  openTickets = 0,
  subscription = null,
  fallbackPeriod = {},
} = {}) {
  const terminalInbound = inboundCalls.filter(isTerminalInbound);
  const terminalOutbound = outboundCalls.filter(isTerminalOutbound);

  const aiResolved = terminalInbound.filter(call =>
    AI_RESOLVED_OUTCOMES.has(normalizeText(call.outcome))
  ).length;
  const aiEligible = terminalInbound.length;
  const aiResolutionRate =
    aiEligible === 0 ? 0 : Math.round((aiResolved / aiEligible) * 100);

  const savedSeconds = [...terminalInbound, ...terminalOutbound].reduce(
    (total, call) => {
      const duration = normalizeNumber(call.duration_seconds);
      const humanTakeover = isTransferred(call)
        ? Math.min(duration, TRANSFER_TAKEOVER_SECONDS)
        : 0;
      return total + Math.max(0, duration - humanTakeover);
    },
    0
  );

  const hasSubscription = Boolean(subscription);
  const minutesUsed = hasSubscription
    ? normalizeNumber(subscription.minutes_used_current_period)
    : null;
  const minutesIncluded = hasSubscription
    ? normalizeNumber(subscription.minutes_included)
    : null;

  return {
    kpis: {
      calls_7d: {
        total: inboundCalls.length + outboundCalls.length,
        inbound: inboundCalls.length,
        outbound: outboundCalls.length,
      },
      appointments_this_week: appointments.filter(
        appointment =>
          !CANCELLED_APPOINTMENT_STATUSES.has(
            normalizeText(appointment?.status)
          )
      ).length,
      contacts_created_7d: contactsCreated,
      ai_resolution_rate_pct: aiResolutionRate,
      ai_resolved_calls_7d: aiResolved,
      ai_resolution_eligible_calls_7d: aiEligible,
      tickets_open: openTickets,
    },
    roi: {
      time_saved_seconds: Math.round(savedSeconds),
      time_saved_hours: roundOne(savedSeconds / 3_600),
      calculation:
        "Somme des durées des appels terminés traités par l'IA, moins 120 secondes par transfert humain.",
      assumptions: {
        transfer_takeover_seconds: TRANSFER_TAKEOVER_SECONDS,
      },
    },
    minutes: hasSubscription
      ? {
          used: roundOne(minutesUsed),
          included: roundOne(minutesIncluded),
          remaining: roundOne(Math.max(0, minutesIncluded - minutesUsed)),
          overage: roundOne(Math.max(0, minutesUsed - minutesIncluded)),
          usage_pct:
            minutesIncluded > 0
              ? Math.round((minutesUsed / minutesIncluded) * 100)
              : 0,
          period_start:
            subscription.current_period_start || fallbackPeriod.start || null,
          period_end:
            subscription.current_period_end || fallbackPeriod.end || null,
        }
      : {
          used: null,
          included: null,
          remaining: null,
          overage: null,
          usage_pct: null,
          period_start: null,
          period_end: null,
        },
    has_activity:
      inboundCalls.length > 0 ||
      outboundCalls.length > 0 ||
      appointments.length > 0 ||
      contactsCreated > 0 ||
      openTickets > 0,
  };
}

function activityTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function appointmentDescription(appointment) {
  const date = appointment.date || "date à confirmer";
  const time = appointment.time
    ? String(appointment.time).slice(0, 5)
    : "heure à confirmer";
  return `${appointment.type || "Rendez-vous"} — ${date} à ${time}`;
}

function buildActivities({
  inboundCalls,
  outboundCalls,
  appointments,
  contacts,
  tickets,
  limit,
}) {
  const activities = [];

  for (const call of inboundCalls) {
    activities.push({
      id: call.id,
      type: "call_inbound",
      title: `Appel entrant — ${
        call.caller_name || call.caller_phone || "Contact"
      }`,
      description: call.ai_summary || call.intent || null,
      outcome: call.outcome || call.status || null,
      timestamp: activityTimestamp(call.created_at),
      link: "/calls",
    });
  }

  for (const call of outboundCalls) {
    activities.push({
      id: call.id,
      type: "call_outbound",
      title: `Appel sortant — ${
        call.contact_name || call.contact_phone || "Contact"
      }`,
      description: call.ai_summary || null,
      outcome: call.outcome || call.status || null,
      timestamp: activityTimestamp(call.created_at),
      link: "/outbound",
    });
  }

  for (const appointment of appointments) {
    activities.push({
      id: appointment.id,
      type: "appointment",
      title: `Rendez-vous — ${
        appointment.contact_name || appointment.type || "Contact"
      }`,
      description: appointmentDescription(appointment),
      outcome: appointment.status || null,
      timestamp: activityTimestamp(appointment.created_at),
      link: "/calendar",
    });
  }

  for (const contact of contacts) {
    activities.push({
      id: contact.id,
      type: "contact",
      title: `Contact créé — ${contact.full_name || "Sans nom"}`,
      description: contact.company || contact.source || null,
      outcome: contact.status || null,
      timestamp: activityTimestamp(contact.created_at),
      link: "/contacts",
    });
  }

  for (const ticket of tickets) {
    activities.push({
      id: ticket.id,
      type: "ticket",
      title: `Ticket — ${ticket.subject || ticket.ticket_number || "Support"}`,
      description: ticket.ticket_number || ticket.priority || null,
      outcome: ticket.status || null,
      timestamp: activityTimestamp(ticket.created_at),
      link: "/support",
    });
  }

  return activities
    .filter(activity => activity.timestamp)
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() -
        new Date(left.timestamp).getTime()
    )
    .slice(0, limit);
}

function parseActivityLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_ACTIVITY_LIMIT;
  }
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

function sendStorageError(res, logger, route, error) {
  logger.error?.(
    `[dashboard] ${route} failed: ${
      error instanceof DashboardStorageError ? error.code : "unexpected_error"
    }`
  );
  return res.status(503).json({ error: "dashboard_unavailable" });
}

export function createDashboardRouter({
  supabase = defaultSupabase,
  now = () => new Date(),
  logger = console,
} = {}) {
  const router = express.Router();

  // GET /api/v1/dashboard/stats
  router.get("/stats", async (req, res) => {
    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;

    try {
      const generatedAt = new Date(now());
      const windows = buildDashboardWindows(generatedAt);

      const [
        inboundCalls,
        outboundCalls,
        appointments,
        contactsCreated,
        openTickets,
        subscription,
      ] = await Promise.all([
        readAllPages(
          () =>
            supabase
              .from("calls")
              .select("id, duration_seconds, status, outcome, created_at")
              .eq("company_id", companyId)
              .gte("created_at", windows.calls_7d.start)
              .lt("created_at", windows.calls_7d.end),
          "calls_read_failed"
        ),
        readAllPages(
          () =>
            supabase
              .from("outbound_calls")
              .select("id, duration_seconds, status, outcome, created_at")
              .eq("company_id", companyId)
              .gte("created_at", windows.calls_7d.start)
              .lt("created_at", windows.calls_7d.end),
          "outbound_calls_read_failed"
        ),
        readAllPages(
          () =>
            supabase
              .from("appointments")
              .select("id, status, date")
              .eq("company_id", companyId)
              .gte("date", windows.appointments_week.start)
              .lt("date", windows.appointments_week.end),
          "appointments_read_failed"
        ),
        readCount(
          supabase
            .from("contacts")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .gte("created_at", windows.calls_7d.start)
            .lt("created_at", windows.calls_7d.end),
          "contacts_read_failed"
        ),
        readCount(
          supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .in("status", OPEN_TICKET_STATUSES),
          "tickets_read_failed"
        ),
        readMaybeOne(
          supabase
            .from("subscriptions")
            .select(
              "minutes_included, minutes_used_current_period, current_period_start, current_period_end"
            )
            .eq("company_id", companyId),
          "subscription_read_failed"
        ),
      ]);

      const metrics = calculateDashboardMetrics({
        inboundCalls,
        outboundCalls,
        appointments,
        contactsCreated,
        openTickets,
        subscription,
        fallbackPeriod: windows.month,
      });

      return res.json({
        generated_at: generatedAt.toISOString(),
        windows,
        ...metrics,
      });
    } catch (error) {
      return sendStorageError(res, logger, "stats", error);
    }
  });

  // GET /api/v1/dashboard/activity
  router.get("/activity", async (req, res) => {
    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;

    try {
      const limit = parseActivityLimit(req.query.limit);
      const [inboundCalls, outboundCalls, appointments, contacts, tickets] =
        await Promise.all([
          supabase
            .from("calls")
            .select(
              "id, caller_name, caller_phone, ai_summary, intent, outcome, status, created_at"
            )
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(limit),
          supabase
            .from("outbound_calls")
            .select(
              "id, contact_name, contact_phone, ai_summary, outcome, status, created_at"
            )
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(limit),
          supabase
            .from("appointments")
            .select(
              "id, contact_id, date, time, type, status, created_at"
            )
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(limit),
          supabase
            .from("contacts")
            .select("id, full_name, company, source, status, created_at")
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(limit),
          supabase
            .from("tickets")
            .select(
              "id, ticket_number, subject, priority, status, created_at"
            )
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(limit),
        ]);

      const results = [
        ["calls", inboundCalls],
        ["outbound_calls", outboundCalls],
        ["appointments", appointments],
        ["contacts", contacts],
        ["tickets", tickets],
      ];
      for (const [table, result] of results) {
        if (result.error) {
          throw new DashboardStorageError(`${table}_activity_read_failed`);
        }
      }

      const appointmentRows = appointments.data || [];
      const appointmentContactIds = [
        ...new Set(
          appointmentRows
            .map(appointment => appointment.contact_id)
            .filter(Boolean)
        ),
      ];
      const appointmentContactNames = new Map();

      if (appointmentContactIds.length > 0) {
        const appointmentContacts = await supabase
          .from("contacts")
          .select("id, full_name")
          .eq("company_id", companyId)
          .in("id", appointmentContactIds);
        if (appointmentContacts.error) {
          throw new DashboardStorageError(
            "appointment_contacts_activity_read_failed"
          );
        }
        for (const contact of appointmentContacts.data || []) {
          appointmentContactNames.set(contact.id, contact.full_name || null);
        }
      }

      const scopedAppointments = appointmentRows.map(appointment => ({
        ...appointment,
        contact_name:
          appointmentContactNames.get(appointment.contact_id) || null,
      }));

      const activities = buildActivities({
        inboundCalls: inboundCalls.data || [],
        outboundCalls: outboundCalls.data || [],
        appointments: scopedAppointments,
        contacts: contacts.data || [],
        tickets: tickets.data || [],
        limit,
      });

      return res.json({
        activities,
        total_returned: activities.length,
        has_activity: activities.length > 0,
      });
    } catch (error) {
      return sendStorageError(res, logger, "activity", error);
    }
  });

  // GET /api/v1/dashboard/alerts
  // Conservé pour compatibilité, sans les courriels opérationnels masqués en V1.
  router.get("/alerts", async (req, res) => {
    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;

    try {
      const [subscription, suggestions, tickets] = await Promise.all([
        readMaybeOne(
          supabase
            .from("subscriptions")
            .select("payment_status, trial_ends_at")
            .eq("company_id", companyId),
          "subscription_alert_read_failed"
        ),
        readCount(
          supabase
            .from("learning_suggestions")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .eq("status", "pending"),
          "learning_alert_read_failed"
        ),
        readCount(
          supabase
            .from("tickets")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .in("status", OPEN_TICKET_STATUSES),
          "ticket_alert_read_failed"
        ),
      ]);

      const alerts = [];
      const generatedAt = new Date(now());

      if (
        subscription?.payment_status === "trial" &&
        subscription.trial_ends_at
      ) {
        const trialEnd = new Date(subscription.trial_ends_at);
        const daysLeft = Math.ceil(
          (trialEnd.getTime() - generatedAt.getTime()) / 86_400_000
        );
        if (daysLeft <= 7 && daysLeft > 0) {
          alerts.push({
            type: "trial_ending",
            severity: daysLeft <= 3 ? "high" : "medium",
            title: `Essai gratuit se termine dans ${daysLeft} jour(s)`,
            action: "Choisir un forfait",
            link: "/billing",
          });
        }
      }

      if (subscription?.payment_status === "overdue") {
        alerts.push({
          type: "payment_overdue",
          severity: "high",
          title: "Paiement en retard",
          action: "Mettre à jour ma carte",
          link: "/billing",
        });
      }

      if (suggestions > 0) {
        alerts.push({
          type: "learning_pending",
          severity: "low",
          title: `${suggestions} suggestion(s) d'apprentissage à valider`,
          action: "Examiner",
          link: "/knowledge",
        });
      }

      if (tickets > 0) {
        alerts.push({
          type: "tickets_open",
          severity: "low",
          title: `${tickets} ticket(s) de support ouvert(s)`,
          action: "Voir les tickets",
          link: "/support",
        });
      }

      return res.json({ alerts });
    } catch (error) {
      return sendStorageError(res, logger, "alerts", error);
    }
  });

  return router;
}

export default createDashboardRouter();
