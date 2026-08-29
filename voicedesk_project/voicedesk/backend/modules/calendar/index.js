import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

import { createCalendarService } from "./service.js";

dotenv.config();

const COMPANY_MANAGER_ROLES = new Set(["company_admin", "super_admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createDefaultSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function createDefaultResend() {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

function requestedCompanyId(req) {
  if (req.user?.role !== "super_admin") return req.user?.company_id || null;
  return req.params?.company_id
    || req.body?.company_id
    || req.query?.company_id
    || req.user?.company_id
    || null;
}

function requireCompany(req) {
  const companyId = requestedCompanyId(req);
  if (!companyId || !UUID_RE.test(companyId)) {
    const error = new Error("Entreprise invalide ou absente.");
    error.code = "company_id_required";
    error.status = 400;
    throw error;
  }
  return companyId;
}

function requireCompanyManager(req) {
  if (!COMPANY_MANAGER_ROLES.has(req.user?.role)) {
    const error = new Error("Un administrateur de l’entreprise est requis.");
    error.code = "forbidden";
    error.status = 403;
    throw error;
  }
}

function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const payload = {
    error: error?.code || (status >= 500 ? "calendar_internal_error" : "calendar_request_failed"),
    message: status >= 500 ? "Le service calendrier est temporairement indisponible." : error.message,
  };
  if (error?.reschedule_url) payload.reschedule_url = error.reschedule_url;
  if (error?.required_scopes) payload.required_scopes = error.required_scopes;
  return res.status(status).json(payload);
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

export function createCalendarRouter({ service } = {}) {
  const router = express.Router();

  router.get("/connection", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    const connection = await service.getConnectionStatus(companyId);
    res.json({ ...connection, connection });
  }));

  router.post("/oauth/start", asyncRoute(async (req, res) => {
    requireCompanyManager(req);
    const companyId = requireCompany(req);
    const result = await service.startOAuth({
      companyId,
      userId: req.user.id,
      returnPath: req.body?.return_path,
    });
    res.json(result);
  }));

  router.delete("/connection", asyncRoute(async (req, res) => {
    requireCompanyManager(req);
    const companyId = requireCompany(req);
    res.json(await service.disconnect(companyId));
  }));

  router.get("/event-types", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    res.json({ event_types: await service.eventTypes(companyId) });
  }));

  router.patch("/settings", asyncRoute(async (req, res) => {
    requireCompanyManager(req);
    const companyId = requireCompany(req);
    const settings = await service.setDefaultEventType(
      companyId,
      req.body?.default_event_type_uri
    );
    res.json({ success: true, connection: settings, ...settings });
  }));

  router.get("/availability", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    const result = await service.availability(companyId, {
      eventTypeUri: req.query?.event_type_uri,
      startTime: req.query?.start_time,
      endTime: req.query?.end_time,
    });
    res.json({
      event_type_uri: result.event_type_uri,
      availability: result.slots,
    });
  }));

  router.post("/book", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    const headerKey = req.get("Idempotency-Key");
    if (headerKey && req.body?.idempotency_key && headerKey !== req.body.idempotency_key) {
      const error = new Error("Les clés d’idempotence ne correspondent pas.");
      error.code = "idempotency_key_mismatch";
      error.status = 400;
      throw error;
    }
    const result = await service.book(companyId, req.user.id, {
      ...req.body,
      idempotency_key: headerKey || req.body?.idempotency_key,
    });
    res.status(result.reused ? 200 : 201).json({
      success: true,
      appointment: result.appointment,
      idempotent_replay: result.reused,
      confirmation_queued: true,
    });
  }));

  router.get("/appointments", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    const appointments = await service.appointments(companyId, {
      from_date: req.query?.from_date,
      to_date: req.query?.to_date,
      status: req.query?.status,
    });
    res.json({ appointments });
  }));

  router.patch("/appointments/:id", asyncRoute(async (req, res) => {
    const companyId = requireCompany(req);
    if (!UUID_RE.test(req.params.id)) {
      const error = new Error("Rendez-vous invalide.");
      error.code = "invalid_appointment_id";
      error.status = 400;
      throw error;
    }
    const appointment = await service.updateAppointment(
      companyId,
      req.params.id,
      req.body || {}
    );
    res.json({ success: true, appointment });
  }));

  return router;
}

export function createCalendlyOAuthCallbackHandler({ service } = {}) {
  return async (req, res) => {
    const frontendOrigin = String(process.env.FRONTEND_URL || "http://localhost:5173")
      .split(",")[0]
      .trim();
    try {
      const result = await service.finishOAuth({
        state: req.query?.state,
        code: req.query?.code,
      });
      const destination = new URL(result.return_path || "/calendar", frontendOrigin);
      destination.searchParams.set("calendar", "connected");
      return res.redirect(303, destination.toString());
    } catch (error) {
      const destination = new URL("/calendar", frontendOrigin);
      destination.searchParams.set(
        "calendar_error",
        error?.code === "invalid_oauth_state"
          ? "La connexion Calendly a expiré. Veuillez recommencer."
          : "La connexion Calendly n’a pas pu être finalisée."
      );
      return res.redirect(303, destination.toString());
    }
  };
}

function signatureTimestamp(req) {
  const header = String(req.get("Calendly-Webhook-Signature") || "");
  const value = header
    .split(",")
    .map(part => part.trim())
    .find(part => part.startsWith("t="))
    ?.slice(2);
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createCalendlyWebhookHandler({ service } = {}) {
  return async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: "raw_body_required" });
      }
      let payload;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
      const result = await service.enqueueWebhook({
        connectionId: req.params.connectionId,
        payload,
        rawBody: req.body,
        signatureTimestamp: signatureTimestamp(req),
      });
      return res.status(result.duplicate ? 200 : 202).json({
        received: true,
        duplicate: result.duplicate,
      });
    } catch (error) {
      return sendError(res, error);
    }
  };
}

const defaultSupabase = createDefaultSupabase();
export const calendarService = defaultSupabase
  ? createCalendarService({
      supabase: defaultSupabase,
      resend: createDefaultResend(),
    })
  : null;

export const calendarSupabase = defaultSupabase;

const router = createCalendarRouter({
  service: calendarService || new Proxy({}, {
    get() {
      return async () => {
        const error = new Error("Calendrier non configuré.");
        error.code = "calendar_not_configured";
        error.status = 503;
        throw error;
      };
    },
  }),
});

export default router;
