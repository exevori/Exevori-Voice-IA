import express from "express";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAdminCompanyRouter({ service, provisioningHealth = null, logger = console }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    if (req.user.role !== "super_admin") return res.status(403).json({ error: "forbidden" });
    res.set("Cache-Control", "no-store");
    return next();
  });
  router.param("id", (req, res, next, id) => {
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid_company_id" });
    return next();
  });

  const handle = callback => async (req, res) => {
    try {
      const requestId = req.get("X-Request-Id");
      if (requestId && !UUID.test(requestId)) return res.status(400).json({ error: "invalid_request_id" });
      const actor = { id: req.user.id, requestId: requestId || randomUUID() };
      return res.json(await callback(req, actor));
    } catch (error) {
      const code = error.code || "admin_company_action_failed";
      logger.error?.("[admin] Company request failed", { error_code: code });
      return res.status(error.status || 503).json({ error: code });
    }
  };

  function confirm(req, _res, next) {
    if (req.body?.confirm_company_id !== req.params.id) {
      return _res.status(400).json({ error: "company_confirmation_required" });
    }
    return next();
  }
  function requireReason(req, res, next) {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: "reason_required" });
    req.actionReason = reason;
    return next();
  }

  router.get("/companies/:id", handle((req, actor) => service.getCompanyDetail(req.params.id, actor)));
  if (provisioningHealth) {
    router.get("/companies/:id/provisioning-health", handle((req, actor) => provisioningHealth.getHealth(req.params.id, actor)));
    router.post("/companies/:id/provisioning-repair", confirm, requireReason,
      handle((req, actor) => provisioningHealth.repair(req.params.id, actor, req.actionReason)));
  }
  for (const action of ["suspend", "reactivate"]) {
    router.post(`/companies/:id/${action}`, confirm, requireReason,
      handle((req, actor) => service.changeAccess(req.params.id, action, actor, req.actionReason)));
  }
  router.post("/companies/:id/impersonate", confirm, requireReason,
    handle((req, actor) => service.impersonate(req.params.id, actor, req.actionReason)));
  router.post("/companies/:id/resend-welcome", confirm,
    handle((req, actor) => service.resendWelcome(req.params.id, actor)));
  router.post("/companies/:id/resync-provisioning", confirm, requireReason,
    handle((req, actor) => service.resyncProvisioning(req.params.id, actor, req.actionReason)));
  return router;
}
