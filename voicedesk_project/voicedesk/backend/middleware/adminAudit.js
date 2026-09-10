import { randomUUID } from "node:crypto";
import { UUID } from "../modules/admin/audit.js";

const HANDLED = Symbol("adminAuditHandled");
const SEGMENTS = new Set(("api v1 admin companies contacts calls tickets messages attachments notes dashboard config company team billing privacy knowledge sources chunks kb learning calendar appointments outbound campaigns dnc notifications auth invite resend import voice-library twilio-config email-accounts emails reports audit impersonations end start stop pause resume publish archive anonymize data-export export change-plan portal suspend reactivate impersonate resend-welcome resync-provisioning provisioning-health provisioning-repair overage-policy consumption summary stats history providers provider-status status settings").split(" "));
function scopeClient(req) {
  if (!req.impersonation) return;
  const companyId = req.impersonation.company_id;
  req.user = {...req.user,role:"company_admin",company_id:companyId,
    profile:{...req.user.profile,role:"company_admin",company_id:companyId,companies:{id:companyId}}};
}
export function auditRoute(url) {
  return String(url || "").split("?")[0].split("/").map(s =>
    !s || SEGMENTS.has(s) || UUID.test(s) ? s : ":value").join("/").slice(0,500);
}
export function createAdminAuditMiddleware({ service, logger = console, now = Date.now }) {
  return async (req,res,next) => {
    if (req[HANDLED]) { scopeClient(req); return next(); }
    const sessionId = req.get("X-Impersonation-Session");
    if (req.user?.role !== "super_admin") {
      return sessionId ? res.status(403).json({error:"impersonation_forbidden"}) : next();
    }
    req[HANDLED] = true;
    const path = req.originalUrl.split("?")[0];
    if (path === "/api/v1/auth/me") return next();
    // Session lifecycle is atomically logged by its dedicated RPCs.
    if (/^\/api\/v1\/admin\/impersonations\/[0-9a-f-]+(?:\/end)?$/i.test(path)) return next();
    const actor = { id:req.user.id, role:"super_admin" };
    const suppliedId = req.get("X-Request-Id");
    if (suppliedId && !UUID.test(suppliedId)) return res.status(400).json({error:"invalid_request_id"});
    const requestId = suppliedId || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.set("X-Request-Id",requestId);
    res.set("Cache-Control","no-store");
    try {
      let session = null;
      if (sessionId) {
        session = await service.session(sessionId,actor.id);
        req.impersonation = session;
      }
      const companyFromPath = path.match(/^\/api\/v1\/admin\/companies\/([0-9a-f-]+)(?:\/|$)/i)?.[1];
      const candidate = session?.company_id || companyFromPath || req.body?.company_id || req.query?.company_id || req.user.company_id;
      const companyId = typeof candidate === "string" && UUID.test(candidate) ? candidate : null;
      const planChange = req.method === "POST" && (path === "/api/v1/billing/change-plan"
        || (path === "/api/v1/billing/portal" && req.body?.action === "subscription_update"));
      const row = { company_id:companyId, actor_user_id:actor.id, actor_role:actor.role,
        action:planChange ? "admin_plan_change_requested" : "admin_request_started",entity_type:"admin_request",entity_id:null,
        request_id:requestId,impersonation_session_id:session?.id || null,
        details:{method:req.method,route:auditRoute(path),phase:"started"} };
      // Fail closed BEFORE any handler can read sensitive data or mutate it.
      await service.write(row);
      const started = now();
      let completed = false;
      const finish = async phase => {
        if (completed) return;
        completed = true;
        try {
          await service.write({...row,action:planChange ? "admin_plan_change_response" : "admin_request_finished",details:{...row.details,phase,
            status_code:res.statusCode,duration_ms:Math.max(0,now()-started)}});
        } catch { logger.error?.("[admin-audit] outcome unavailable",{request_id:requestId}); }
      };
      res.once("finish",() => { void finish("finished"); });
      res.once("close",() => { if (!res.writableFinished) void finish("connection_closed"); });
      if (session) {
        for (const id of [req.query?.company_id, req.body?.company_id]) {
          if (id !== undefined && id !== session.company_id) return res.status(403).json({error:"impersonation_company_mismatch"});
        }
        // A client view must not retain the global super-admin tenant bypass.
        // The authenticated actor is preserved separately for audit attribution.
        req.auditActor = actor;
        scopeClient(req);
      }
      return next();
    } catch (e) {
      return res.status(e.status || 503).json({error:e.code || "admin_audit_unavailable"});
    }
  };
}
