import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

import {
  ACTIVE_TICKET_STATUSES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SLA,
  TICKET_STATUSES,
  calculateTicketSla,
  createTicketService,
} from "./service.js";

dotenv.config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALL_TICKET_STATUSES = new Set([...ACTIVE_TICKET_STATUSES, "resolved", "closed"]);
const CLIENT_TICKET_FIELDS = [
  "id", "ticket_number", "subject", "description", "category", "priority",
  "status", "created_by_name", "assigned_to_name", "sla_first_response_due",
  "sla_resolution_due", "first_response_at", "resolved_at", "closed_at",
  "resolution_summary", "satisfaction_rating", "created_at", "updated_at",
].join(", ");
const TICKET_FIELDS = [
  "id", "company_id", "ticket_number", "subject", "description",
  "category", "priority", "status", "created_by_user_id",
  "created_by_name", "created_by_email", "assigned_to_user_id",
  "assigned_to_name", "sla_first_response_due", "sla_resolution_due",
  "first_response_at", "resolved_at", "closed_at", "resolution_summary",
  "satisfaction_rating", "internal_notes", "created_at", "updated_at",
].join(", ");

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function cleanText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function resolveCompanyId(req, requestedCompanyId) {
  if (isSuperAdmin(req)) return requestedCompanyId || null;
  if (requestedCompanyId && requestedCompanyId !== req.user?.company_id) return false;
  return req.user?.company_id || null;
}

function requestActor(req) {
  return {
    userId: req.user?.id,
    name: cleanText(req.user?.profile?.full_name || req.user?.email, 200) || "Utilisateur",
    email: cleanText(req.user?.email, 320),
    role: isSuperAdmin(req) ? "exevori_agent" : "client",
  };
}

function safeCompany(company) {
  return company?.name ? { name: company.name } : null;
}

function safeTicket(ticket, req, now = new Date()) {
  const sla = calculateTicketSla(ticket, now);
  const base = {
    id: ticket.id,
    ticket_number: ticket.ticket_number,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    created_by_name: ticket.created_by_name,
    assigned_to_name: ticket.assigned_to_name,
    sla_first_response_due: ticket.sla_first_response_due,
    sla_resolution_due: ticket.sla_resolution_due,
    first_response_at: ticket.first_response_at,
    resolved_at: ticket.resolved_at,
    closed_at: ticket.closed_at,
    resolution_summary: ticket.resolution_summary,
    satisfaction_rating: ticket.satisfaction_rating,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    ...sla,
  };
  const company = safeCompany(ticket.companies);
  if (company) base.companies = company;
  if (!isSuperAdmin(req)) return base;
  return {
    ...base,
    company_id: ticket.company_id,
    created_by_user_id: ticket.created_by_user_id,
    created_by_email: ticket.created_by_email,
    assigned_to_user_id: ticket.assigned_to_user_id,
    internal_notes: ticket.internal_notes,
  };
}

function safeMessage(message, req) {
  const base = {
    id: message.id,
    author_name: message.author_name,
    author_role: message.author_role,
    body: message.body,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    created_at: message.created_at,
  };
  return isSuperAdmin(req)
    ? { ...base, is_internal: message.is_internal === true }
    : base;
}

function statusForError(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const code = error?.code || error?.cause?.code;
  if (code === "42501") return 403;
  if (["22004", "22023", "23514"].includes(code)) return 400;
  if (code === "P0002") return 404;
  return 500;
}

function sendError(res, error, logger, fallbackCode) {
  const status = statusForError(error);
  logger.error?.("[tickets] Request failed", {
    error_code: error?.code || error?.cause?.code || fallbackCode,
  });
  return res.status(status).json({
    error: status >= 500 ? fallbackCode : error?.code || fallbackCode,
    message: status >= 500 ? "Traitement du ticket échoué" : error.message,
  });
}

async function ticketAccess(supabase, id, req) {
  let query = supabase
    .from("tickets")
    .select("id, company_id, status, first_response_at, resolved_at, closed_at, resolution_summary, created_at")
    .eq("id", id);
  if (!isSuperAdmin(req)) query = query.eq("company_id", req.user.company_id);
  const { data, error } = await query.maybeSingle();
  if (error) return { error };
  if (data) return { ticket: data, companyId: data.company_id, status: 200 };

  if (!isSuperAdmin(req)) {
    const existence = await supabase
      .from("tickets")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (existence.error) return { error: existence.error };
    if (existence.data) return { status: 403 };
  }
  return { status: 404 };
}

function accessResponse(res, access) {
  if (access.status === 403) {
    res.status(403).json({ error: "forbidden_cross_tenant" });
    return true;
  }
  if (access.status === 404) {
    res.status(404).json({ error: "ticket_not_found" });
    return true;
  }
  return false;
}

export function createTicketsRouter({
  supabase,
  service,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!supabase?.from || !supabase?.rpc) throw new TypeError("Supabase client required");
  if (!service) throw new TypeError("Ticket service required");

  const router = express.Router();

  // Les routes nommées doivent précéder /:id.
  router.get("/stats/overview", async (req, res) => {
    const companyId = resolveCompanyId(req, req.query.company_id);
    if (companyId === false) {
      return res.status(403).json({ error: "forbidden_cross_tenant" });
    }
    try {
      let query = supabase
        .from("tickets")
        .select("status, priority, created_at, sla_first_response_due, first_response_at, sla_resolution_due, resolved_at, satisfaction_rating");
      if (companyId) query = query.eq("company_id", companyId);
      const { data, error } = await query;
      if (error) throw error;

      const stats = {
        total: data?.length || 0,
        open: 0,
        in_progress: 0,
        waiting_client: 0,
        resolved: 0,
        closed: 0,
        by_priority: { urgent: 0, high: 0, normal: 0, low: 0 },
        sla_breached: 0,
        sla_at_risk: 0,
        avg_first_response_minutes: 0,
        avg_resolution_hours: 0,
        avg_satisfaction: 0,
      };
      let responseTotal = 0;
      let responseCount = 0;
      let resolutionTotal = 0;
      let resolutionCount = 0;
      let satisfactionTotal = 0;
      let satisfactionCount = 0;
      for (const ticket of data || []) {
        if (Object.hasOwn(stats, ticket.status)) stats[ticket.status] += 1;
        if (Object.hasOwn(stats.by_priority, ticket.priority)) {
          stats.by_priority[ticket.priority] += 1;
        }
        const sla = calculateTicketSla(ticket, now());
        if (sla.sla_status === "breached") stats.sla_breached += 1;
        if (sla.sla_status === "at_risk") stats.sla_at_risk += 1;
        if (ticket.first_response_at && ticket.created_at) {
          responseTotal += new Date(ticket.first_response_at) - new Date(ticket.created_at);
          responseCount += 1;
        }
        if (ticket.resolved_at && ticket.created_at) {
          resolutionTotal += new Date(ticket.resolved_at) - new Date(ticket.created_at);
          resolutionCount += 1;
        }
        if (Number.isInteger(ticket.satisfaction_rating)) {
          satisfactionTotal += ticket.satisfaction_rating;
          satisfactionCount += 1;
        }
      }
      stats.avg_first_response_minutes = responseCount
        ? Math.max(0, Math.round(responseTotal / responseCount / 60_000))
        : 0;
      stats.avg_resolution_hours = resolutionCount
        ? Math.max(0, Math.round((resolutionTotal / resolutionCount / 3_600_000) * 10) / 10)
        : 0;
      stats.avg_satisfaction = satisfactionCount
        ? Math.round((satisfactionTotal / satisfactionCount) * 10) / 10
        : 0;
      return res.json(stats);
    } catch (error) {
      return sendError(res, error, logger, "ticket_stats_failed");
    }
  });

  router.get("/agents", async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: "forbidden" });
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("role", "super_admin")
        .eq("status", "active")
        .order("full_name", { ascending: true });
      if (error) throw error;
      return res.json({
        agents: (data || []).map(agent => ({
          user_id: agent.user_id,
          full_name: cleanText(agent.full_name, 200) || "Membre Exevori",
        })),
      });
    } catch (error) {
      return sendError(res, error, logger, "ticket_agents_failed");
    }
  });

  router.post("/", async (req, res) => {
    const companyId = resolveCompanyId(req, req.body?.company_id);
    if (companyId === false) {
      return res.status(403).json({ error: "forbidden_cross_tenant" });
    }
    if (!companyId || !UUID_RE.test(companyId)) {
      return res.status(400).json({ error: "valid_company_id_required" });
    }
    const subject = cleanText(req.body?.subject, 201);
    const description = cleanText(req.body?.description, 10001);
    const category = req.body?.category || "general";
    const priority = req.body?.priority || "normal";
    if (!subject || subject.length > 200) {
      return res.status(400).json({ error: "invalid_ticket_subject" });
    }
    if (!description || description.length > 10000) {
      return res.status(400).json({ error: "invalid_ticket_description" });
    }
    if (!TICKET_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "invalid_ticket_category" });
    }
    if (!TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: "invalid_ticket_priority" });
    }

    const actor = requestActor(req);
    try {
      const result = await service.createTicket({
        companyId,
        actorUserId: actor.userId,
        actorName: actor.name,
        actorEmail: actor.email,
        actorRole: actor.role,
        subject,
        description,
        category,
        priority,
      });
      return res.status(201).json({
        success: true,
        ticket: safeTicket(result.ticket, req, now()),
        message: safeMessage(result.message, req),
        notification: { queued: true },
      });
    } catch (error) {
      return sendError(res, error, logger, "ticket_create_failed");
    }
  });

  router.get("/", async (req, res) => {
    const companyId = resolveCompanyId(req, req.query.company_id);
    if (companyId === false) {
      return res.status(403).json({ error: "forbidden_cross_tenant" });
    }
    const status = req.query.status || null;
    const priority = req.query.priority || null;
    const category = req.query.category || null;
    if (status && !ALL_TICKET_STATUSES.has(status)) {
      return res.status(400).json({ error: "invalid_ticket_status" });
    }
    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: "invalid_ticket_priority" });
    }
    if (category && !TICKET_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "invalid_ticket_category" });
    }
    if (req.query.assigned_to && !UUID_RE.test(req.query.assigned_to)) {
      return res.status(400).json({ error: "invalid_assigned_agent" });
    }
    const limit = boundedInteger(req.query.limit, 50, 1, 100);
    const offset = boundedInteger(req.query.offset, 0, 0, 100_000);

    try {
      const projection = isSuperAdmin(req) ? TICKET_FIELDS : CLIENT_TICKET_FIELDS;
      let query = supabase
        .from("tickets")
        .select(`${projection}, companies(name)`, { count: "exact" });
      if (companyId) query = query.eq("company_id", companyId);
      if (status) query = query.eq("status", status);
      if (priority) query = query.eq("priority", priority);
      if (category) query = query.eq("category", category);
      if (req.query.assigned_to) query = query.eq("assigned_to_user_id", req.query.assigned_to);
      const { data, count, error } = await query
        .order("updated_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return res.json({
        tickets: (data || []).map(ticket => safeTicket(ticket, req, now())),
        total: count || 0,
        limit,
        offset,
      });
    } catch (error) {
      return sendError(res, error, logger, "ticket_list_failed");
    }
  });

  router.get("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;

      const projection = isSuperAdmin(req) ? TICKET_FIELDS : CLIENT_TICKET_FIELDS;
      const ticketResult = await supabase
        .from("tickets")
        .select(`${projection}, companies(name)`)
        .eq("id", access.ticket.id)
        .eq("company_id", access.companyId)
        .maybeSingle();
      if (ticketResult.error) throw ticketResult.error;
      if (!ticketResult.data) return res.status(404).json({ error: "ticket_not_found" });

      let messagesQuery = supabase
        .from("ticket_messages")
        .select("id, ticket_id, company_id, author_name, author_role, body, is_internal, attachments, created_at")
        .eq("ticket_id", access.ticket.id)
        .eq("company_id", access.companyId);
      if (!isSuperAdmin(req)) messagesQuery = messagesQuery.eq("is_internal", false);
      const messagesResult = await messagesQuery
        .order("created_at", { ascending: true })
        .limit(500);
      if (messagesResult.error) throw messagesResult.error;

      return res.json({
        ticket: safeTicket(ticketResult.data, req, now()),
        messages: (messagesResult.data || []).map(message => safeMessage(message, req)),
      });
    } catch (error) {
      return sendError(res, error, logger, "ticket_read_failed");
    }
  });

  router.post("/:id/messages", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    const body = cleanText(req.body?.body, 10001);
    if (!body || body.length > 10000) {
      return res.status(400).json({ error: "invalid_ticket_message" });
    }
    if (Array.isArray(req.body?.attachments) && req.body.attachments.length) {
      return res.status(400).json({ error: "ticket_attachments_not_supported" });
    }
    if (!isSuperAdmin(req) && req.body?.is_internal === true) {
      return res.status(403).json({ error: "internal_notes_admin_only" });
    }

    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;
      if (access.ticket.status === "closed" && req.body?.is_internal !== true) {
        return res.status(409).json({ error: "ticket_closed" });
      }
      const actor = requestActor(req);
      const result = await service.appendMessage({
        ticketId: access.ticket.id,
        companyId: access.companyId,
        actorUserId: actor.userId,
        actorName: actor.name,
        actorRole: actor.role,
        body,
        isInternal: isSuperAdmin(req) && req.body?.is_internal === true,
      });
      return res.status(201).json({
        success: true,
        message: safeMessage(result.message, req),
        ticket: safeTicket(result.ticket, req, now()),
        notification: {
          queued: result.message.is_internal !== true,
          suppressed_for_internal_note: result.message.is_internal === true,
        },
      });
    } catch (error) {
      return sendError(res, error, logger, "ticket_message_failed");
    }
  });

  router.patch("/:id/assign", async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: "forbidden" });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    const agentId = req.body?.assigned_to_user_id || null;
    if (agentId && !UUID_RE.test(agentId)) {
      return res.status(400).json({ error: "invalid_assigned_agent" });
    }
    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;

      let agentName = null;
      if (agentId) {
        const agentResult = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .eq("user_id", agentId)
          .eq("role", "super_admin")
          .eq("status", "active")
          .maybeSingle();
        if (agentResult.error) throw agentResult.error;
        if (!agentResult.data) {
          return res.status(400).json({ error: "active_support_agent_required" });
        }
        agentName = cleanText(agentResult.data.full_name, 200) || "Membre Exevori";
      }

      const updates = {
        assigned_to_user_id: agentId,
        assigned_to_name: agentName,
        updated_at: now().toISOString(),
      };
      if (agentId && access.ticket.status === "open") updates.status = "in_progress";
      const { data, error } = await supabase
        .from("tickets")
        .update(updates)
        .eq("id", access.ticket.id)
        .eq("company_id", access.companyId)
        .select(TICKET_FIELDS)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "ticket_not_found" });
      return res.json({ success: true, ticket: safeTicket(data, req, now()) });
    } catch (error) {
      return sendError(res, error, logger, "ticket_assignment_failed");
    }
  });

  router.patch("/:id/status", async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: "forbidden" });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    if (!TICKET_STATUSES.includes(req.body?.status)) {
      return res.status(400).json({ error: "invalid_ticket_status" });
    }
    const resolutionSummary = cleanText(req.body?.resolution_summary, 5001);
    if (resolutionSummary?.length > 5000) {
      return res.status(400).json({ error: "invalid_resolution_summary" });
    }
    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;
      const timestamp = now().toISOString();
      const updates = { status: req.body.status, updated_at: timestamp };
      if (req.body.status === "resolved") {
        updates.resolved_at = access.ticket.resolved_at || timestamp;
        updates.closed_at = null;
        updates.resolution_summary = resolutionSummary || access.ticket.resolution_summary || null;
      } else if (req.body.status === "closed") {
        updates.resolved_at = access.ticket.resolved_at;
        updates.closed_at = access.ticket.closed_at || timestamp;
      } else {
        updates.resolved_at = null;
        updates.closed_at = null;
        updates.resolution_summary = null;
      }
      const { data, error } = await supabase
        .from("tickets")
        .update(updates)
        .eq("id", access.ticket.id)
        .eq("company_id", access.companyId)
        .select(TICKET_FIELDS)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "ticket_not_found" });
      return res.json({ success: true, ticket: safeTicket(data, req, now()) });
    } catch (error) {
      return sendError(res, error, logger, "ticket_status_failed");
    }
  });

  router.patch("/:id/priority", async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: "forbidden" });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    if (!TICKET_PRIORITIES.includes(req.body?.priority)) {
      return res.status(400).json({ error: "invalid_ticket_priority" });
    }
    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;
      const timestamp = now();
      const createdAt = new Date(access.ticket.created_at);
      const slaOrigin = Number.isNaN(createdAt.getTime()) ? timestamp : createdAt;
      const sla = TICKET_SLA[req.body.priority];
      const { data, error } = await supabase
        .from("tickets")
        .update({
          priority: req.body.priority,
          sla_first_response_due: new Date(slaOrigin.getTime() + sla.firstResponseHours * 3_600_000).toISOString(),
          sla_resolution_due: new Date(slaOrigin.getTime() + sla.resolutionHours * 3_600_000).toISOString(),
          updated_at: timestamp.toISOString(),
        })
        .eq("id", access.ticket.id)
        .eq("company_id", access.companyId)
        .select(TICKET_FIELDS)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "ticket_not_found" });
      return res.json({ success: true, ticket: safeTicket(data, req, now()) });
    } catch (error) {
      return sendError(res, error, logger, "ticket_priority_failed");
    }
  });

  router.post("/:id/rate", async (req, res) => {
    if (isSuperAdmin(req)) return res.status(403).json({ error: "client_rating_only" });
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "invalid_ticket_id" });
    }
    const rating = Number(req.body?.satisfaction_rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "invalid_satisfaction_rating" });
    }
    try {
      const access = await ticketAccess(supabase, req.params.id, req);
      if (access.error) throw access.error;
      if (accessResponse(res, access)) return;
      if (!["resolved", "closed"].includes(access.ticket.status)) {
        return res.status(409).json({ error: "resolved_ticket_required" });
      }
      const { data, error } = await supabase
        .from("tickets")
        .update({ satisfaction_rating: rating, updated_at: now().toISOString() })
        .eq("id", access.ticket.id)
        .eq("company_id", access.companyId)
        .select("id, satisfaction_rating")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "ticket_not_found" });
      return res.json({ success: true, satisfaction_rating: data.satisfaction_rating });
    } catch (error) {
      return sendError(res, error, logger, "ticket_rating_failed");
    }
  });

  return router;
}

export let ticketSupabase = null;
export let ticketService = null;

let defaultRouter;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  ticketSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  ticketService = createTicketService({ supabase: ticketSupabase, resend });
  defaultRouter = createTicketsRouter({
    supabase: ticketSupabase,
    service: ticketService,
  });
} else {
  defaultRouter = express.Router();
  defaultRouter.use((_req, res) => {
    res.status(503).json({ error: "tickets_not_configured" });
  });
}

export default defaultRouter;
