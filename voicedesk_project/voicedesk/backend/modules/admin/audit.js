import express from "express";
import { randomUUID } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIT_FIELDS = "id,company_id,actor_user_id,actor_role,action,entity_type,entity_id,request_id,impersonation_session_id,details,created_at";
const SESSION_FIELDS = "id,company_id,actor_user_id,reason,started_at,expires_at,ended_at,end_reason";
const error = (code, status = 503) => Object.assign(new Error(code), { code, status });
const validUuid = value => typeof value === "string" && UUID.test(value);
const one = value => Array.isArray(value) ? value[0] : value;

async function run(query) {
  const { data, error: failure } = await query.abortSignal(AbortSignal.timeout(8000));
  if (failure) throw error("admin_audit_unavailable");
  return data;
}

// Explicit display projection: never expose arbitrary historical JSON payloads.
export function safeAuditDetails(details = {}) {
  const safe = {};
  for (const key of ["method", "route", "phase", "end_reason", "reason", "expires_at", "error_code"]) {
    if (typeof details?.[key] === "string") safe[key] = details[key].slice(0,500);
  }
  for (const key of ["status_code", "duration_ms", "duration_seconds"]) {
    if (Number.isFinite(details?.[key])) safe[key] = details[key];
  }
  return safe;
}

export function sessionView(s, now = new Date()) {
  const expired = new Date(s.expires_at) <= now;
  const end = s.ended_at || (expired ? s.expires_at : now.toISOString());
  return { ...s, state: s.ended_at ? "ended" : expired ? "expired" : "active",
    duration_seconds: Math.max(0, Math.floor((new Date(end) - new Date(s.started_at)) / 1000)),
    end_inferred: !s.ended_at && expired };
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0,10) !== value.slice(0,10)) throw error("invalid_audit_date", 400);
  return value;
}

export function parseAuditFilters(query = {}) {
  const filters = {};
  for (const key of ["company_id", "session_id", "actor_user_id"]) {
    if (query[key] !== undefined && query[key] !== "") {
      if (!validUuid(query[key])) throw error("invalid_audit_filter", 400);
      filters[key] = query[key];
    }
  }
  if (query.action) {
    if (typeof query.action !== "string" || !/^[a-z][a-z0-9_.-]{0,99}$/.test(query.action)) throw error("invalid_audit_filter", 400);
    filters.action = query.action;
  }
  for (const key of ["from", "to"]) if (query[key]) filters[key] = isoDate(query[key]);
  if (filters.from && filters.to && Date.parse(filters.from) >= Date.parse(filters.to)) throw error("invalid_audit_date", 400);
  if (query.limit !== undefined && (typeof query.limit !== "string" || !/^[1-9]\d{0,2}$/.test(query.limit))) throw error("invalid_audit_limit", 400);
  filters.limit = Math.min(Number(query.limit) || 50, 100);
  if (query.cursor) {
    try {
      if (typeof query.cursor !== "string" || query.cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const c = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      if (!validUuid(c.id)) throw new Error();
      filters.cursor = { id: c.id, at: isoDate(c.at) };
    } catch { throw error("invalid_audit_cursor", 400); }
  }
  return filters;
}

export function createAdminAuditService({ supabase, now = () => new Date() }) {
  async function session(id, actorId, { active = true } = {}) {
    if (!validUuid(id) || !validUuid(actorId)) throw error("impersonation_forbidden", 403);
    const s = await run(supabase.from("admin_impersonation_sessions").select(SESSION_FIELDS)
      .eq("id", id).eq("actor_user_id", actorId).maybeSingle());
    if (!s || s.id !== id || s.actor_user_id !== actorId
      || (active && (s.ended_at || new Date(s.expires_at) <= now()))) throw error("impersonation_expired", 403);
    return sessionView(s, now());
  }
  async function start(company, actor, reason) {
    if (!validUuid(company.id) || !validUuid(actor.id)) throw error("impersonation_forbidden",403);
    if (typeof reason !== "string" || reason.trim().length < 3 || reason.trim().length > 500) throw error("reason_required",400);
    const requestId = validUuid(actor.requestId) ? actor.requestId : randomUUID();
    const s = one(await run(supabase.rpc("start_admin_impersonation", {
      p_session_id: requestId, p_company_id: company.id, p_actor_user_id: actor.id,
      p_reason: reason.trim(), p_request_id: requestId,
    })));
    if (!s || s.id !== requestId || s.actor_user_id !== actor.id || s.company_id !== company.id
      || s.ended_at || new Date(s.expires_at) <= now()) throw error("impersonation_expired",403);
    return { success: true, company, session: sessionView(s,now()) };
  }
  async function end(id, actorId, reason = "user_exit", requestId = randomUUID()) {
    await session(id, actorId, { active: false });
    if (!["user_exit","sign_out"].includes(reason)) throw error("invalid_end_reason",400);
    const s = one(await run(supabase.rpc("end_admin_impersonation", {
      p_session_id: id, p_actor_user_id: actorId, p_reason: reason, p_request_id: requestId,
    })));
    if (!s || s.id !== id || s.actor_user_id !== actorId || !s.ended_at) throw error("admin_audit_unavailable");
    return { success: true, session: sessionView(s,now()) };
  }
  async function list(query, sessions = false) {
    const f = parseAuditFilters(query);
    const time = sessions ? "started_at" : "created_at";
    let q = supabase.from(sessions ? "admin_impersonation_sessions" : "audit_log").select(sessions ? SESSION_FIELDS : AUDIT_FIELDS);
    for (const key of ["company_id","actor_user_id"]) if (f[key]) q = q.eq(key,f[key]);
    if (f.session_id) q = q.eq(sessions ? "id" : "impersonation_session_id", f.session_id);
    if (f.action && !sessions) q = q.eq("action",f.action);
    if (f.from) q = q.gte(time,f.from);
    if (f.to) q = q.lt(time,f.to);
    if (f.cursor) q = q.or(`${time}.lt.${f.cursor.at},and(${time}.eq.${f.cursor.at},id.lt.${f.cursor.id})`);
    const rows = await run(q.order(time,{ascending:false}).order("id",{ascending:false}).limit(f.limit + 1)) || [];
    const page = rows.slice(0,f.limit);
    const last = page.at(-1);
    return { items: page.map(r => sessions ? sessionView(r,now()) : { ...r, details:safeAuditDetails(r.details) }),
      next_cursor: rows.length > f.limit && last
        ? Buffer.from(JSON.stringify({ at:last[time], id:last.id })).toString("base64url") : null };
  }
  const write = row => run(supabase.from("audit_log").insert(row));
  return { start, end, session, list, write };
}

export function createAdminAuditRouter(service) {
  const router = express.Router();
  router.use((req,res,next) => {
    if (!req.user) return res.status(401).json({error:"unauthorized"});
    if (req.user.role !== "super_admin") return res.status(403).json({error:"forbidden"});
    res.set("Cache-Control","no-store"); next();
  });
  const handle = fn => async (req,res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 503).json({error:e.code || "admin_audit_unavailable"}); }
  };
  router.get("/audit",handle(req => service.list(req.query)));
  router.get("/impersonations",handle(req => service.list(req.query,true)));
  router.get("/impersonations/:id",handle(async req => ({ session:await service.session(req.params.id,req.user.id) })));
  router.post("/impersonations/:id/end",handle(req => service.end(req.params.id,req.user.id,req.body?.reason || "user_exit")));
  return router;
}
