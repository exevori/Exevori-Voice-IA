// ============================================================
// EXEVORI VOICE IA — CRM CONTACTS
// Tenant-safe contacts, consent, duplicate detection and merge.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const productionSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const CRM_PIPELINE = Object.freeze([
  "new",
  "qualified",
  "client",
  "lost",
  "archived",
]);

const ACTIVE_PIPELINE = new Set(CRM_PIPELINE.filter(status => status !== "archived"));
const TERMINAL_STATUSES = new Set(["archived", "anonymized"]);
const MERGE_ROLES = new Set(["company_admin", "super_admin"]);
const SORT_COLUMNS = new Set([
  "created_at",
  "full_name",
  "last_interaction_at",
  "next_action_date",
  "status",
  "updated_at",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const URGENCIES = new Set(["low", "normal", "high"]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function normalizeE164(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  let normalized = String(value)
    .trim()
    .replace(/[\s()./\-]/g, "");
  if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
  return E164_RE.test(normalized) ? normalized : null;
}

function normalizeEmail(value) {
  const email = cleanText(value, 320)?.toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) return { error: "invalid_email" };
  return { value: email };
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return { value: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: "invalid_next_action_date" };
  return { value: parsed.toISOString() };
}

function normalizeConsent(value) {
  if (value === null) return { value: null };
  if (typeof value !== "boolean") return { error: "invalid_consent" };
  return { value };
}

function sanitizeSearch(value) {
  return cleanText(value, 120)?.replace(/[\\,%().]/g, " ").replace(/\s+/g, " ") || null;
}

function parseInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isSuperAdmin(req) {
  return req.user?.role === "super_admin";
}

function requestedCompanyId(req) {
  return req.body?.company_id || req.query?.company_id || null;
}

function resolveCollectionTenant(req) {
  if (!req.user) return { status: 401, error: "unauthorized" };

  const requested = requestedCompanyId(req);
  if (isSuperAdmin(req)) {
    if (!requested || !UUID_RE.test(requested)) {
      return { status: 400, error: "company_id_required" };
    }
    return { companyId: requested };
  }

  if (!req.user.company_id) return { status: 403, error: "company_context_required" };
  if (requested && requested !== req.user.company_id) {
    return { status: 403, error: "forbidden_cross_tenant" };
  }
  return { companyId: req.user.company_id };
}

function sendTenantResolutionError(res, tenant) {
  return res.status(tenant.status).json({ error: tenant.error });
}

function validateTags(value) {
  if (value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: "invalid_tags" };
  const tags = [...new Set(
    value.map(tag => cleanText(tag, 50)).filter(Boolean)
  )].slice(0, 30);
  return { value: tags };
}

function buildContactPayload(input, {
  partial = false,
  current = null,
  now = () => new Date(),
} = {}) {
  const payload = {};
  const errors = [];
  const copyText = (key, maxLength) => {
    if (!partial || hasOwn(input, key)) payload[key] = cleanText(input?.[key], maxLength);
  };

  copyText("full_name", 200);
  copyText("first_name", 100);
  copyText("last_name", 100);
  copyText("company", 200);
  copyText("source", 100);
  copyText("main_need", 2000);
  copyText("budget", 200);
  copyText("notes", 10000);

  if (!partial || hasOwn(input, "urgency")) {
    const urgency = cleanText(input?.urgency, 30)?.toLowerCase() || "normal";
    if (!URGENCIES.has(urgency)) errors.push("invalid_urgency");
    else payload.urgency = urgency;
  }

  if (!partial || hasOwn(input, "email")) {
    const email = normalizeEmail(input?.email);
    if (email.error) errors.push(email.error);
    else payload.email = email.value;
  }

  const rawPhone = hasOwn(input, "phone") ? input.phone : current?.phone;
  const phone = normalizeE164(rawPhone);
  const nextStatus = hasOwn(input, "status")
    ? String(input.status || "").toLowerCase()
    : (current?.status || "new");

  if (!ACTIVE_PIPELINE.has(nextStatus)) errors.push("invalid_contact_status");
  else if (!partial || hasOwn(input, "status")) payload.status = nextStatus;

  if (!phone) errors.push("phone_e164_required");
  else if (!partial || hasOwn(input, "phone") || phone !== current?.phone) payload.phone = phone;

  if ((!partial || hasOwn(input, "full_name")) && !payload.full_name) {
    errors.push("full_name_required");
  }

  if (!partial || hasOwn(input, "tags")) {
    const tags = validateTags(input?.tags ?? []);
    if (tags.error) errors.push(tags.error);
    else payload.tags = tags.value;
  }

  if (!partial || hasOwn(input, "next_action_date")) {
    const nextActionDate = normalizeDate(input?.next_action_date);
    if (nextActionDate.error) errors.push(nextActionDate.error);
    else payload.next_action_date = nextActionDate.value;
  }

  if (!partial || hasOwn(input, "next_action_note") || hasOwn(input, "next_action")) {
    const nextActionNote = cleanText(
      hasOwn(input, "next_action_note") ? input.next_action_note : input?.next_action,
      2000
    );
    payload.next_action_note = nextActionNote;
    payload.next_action = nextActionNote;
  }

  for (const channel of ["email", "sms", "call"]) {
    const key = `${channel}_consent`;
    if (partial && !hasOwn(input, key)) continue;
    const consent = normalizeConsent(input?.[key] ?? null);
    if (consent.error) {
      errors.push(`${key}_invalid`);
      continue;
    }
    payload[key] = consent.value;
    const oldValue = current?.[key] ?? null;
    if (!partial || consent.value !== oldValue) {
      payload[`${key}_at`] = consent.value === null ? null : now().toISOString();
    }
  }

  if (!partial) {
    payload.status ||= "new";
    payload.source ||= "manual";
    payload.urgency ||= "normal";
  }

  return { payload, errors: [...new Set(errors)] };
}

function formatDuplicate(row) {
  if (!row) return null;
  return {
    id: row.id,
    full_name: row.full_name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    status: row.status,
    similarity_score: Number(row.similarity_score || 0),
    match_reasons: Array.isArray(row.match_reasons) ? row.match_reasons : [],
  };
}

async function findDuplicates(supabase, companyId, contact, excludeContactId = null) {
  const { data, error } = await supabase.rpc("find_crm_contact_duplicates", {
    p_company_id: companyId,
    p_phone: contact.phone || null,
    p_email: contact.email || null,
    p_full_name: contact.full_name || null,
    p_company: contact.company || null,
    p_exclude_contact_id: excludeContactId,
  });
  if (error) throw error;
  return (data || []).map(formatDuplicate).filter(Boolean);
}

async function respondTenantMiss(supabase, res, id, notFoundMessage, req) {
  if (!isSuperAdmin(req)) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (data) return res.status(403).json({ error: "forbidden_cross_tenant" });
  }
  return res.status(404).json({ error: "not_found", message: notFoundMessage });
}

async function loadTenantContact(supabase, req, id, columns = "*") {
  let query = supabase.from("contacts").select(columns).eq("id", id);
  const requestedCompanyId = isSuperAdmin(req)
    ? req.query?.company_id || req.body?.company_id || null
    : req.user?.company_id;
  if (requestedCompanyId) query = query.eq("company_id", requestedCompanyId);
  return query.maybeSingle();
}

function duplicateResponse(res, duplicates) {
  return res.status(409).json({
    error: "duplicate_contact",
    message: "Un ou plusieurs doublons potentiels ont été détectés",
    duplicates,
  });
}

function handleRouteError(logger, res, context, error) {
  logger.error?.(`[CRM] ${context}`, error);
  return res.status(500).json({ error: "crm_unavailable", message: error.message });
}

export function createCrmRouter({
  supabaseClient = productionSupabase,
  now = () => new Date(),
  logger = console,
} = {}) {
  const router = express.Router();
  const supabase = supabaseClient;

  router.get("/", async (req, res) => {
    const tenant = resolveCollectionTenant(req);
    if (!tenant.companyId) return sendTenantResolutionError(res, tenant);

    const status = cleanText(req.query.status, 30)?.toLowerCase() || null;
    if (status && !CRM_PIPELINE.includes(status)) {
      return res.status(400).json({ error: "invalid_contact_status" });
    }
    const sort = SORT_COLUMNS.has(req.query.sort) ? req.query.sort : "last_interaction_at";
    const order = req.query.order === "asc" ? "asc" : "desc";
    const limit = parseInteger(req.query.limit, 50, { min: 1, max: 200 });
    const offset = parseInteger(req.query.offset, 0, { min: 0, max: 100000 });

    try {
      let query = supabase
        .from("contacts")
        .select("*", { count: "exact" })
        .eq("company_id", tenant.companyId)
        .neq("status", "anonymized");
      if (status) query = query.eq("status", status);
      else if (req.query.include_archived !== "true") {
        query = query.neq("status", "archived");
      }
      const source = cleanText(req.query.source, 100);
      const urgency = cleanText(req.query.urgency, 30);
      if (source) query = query.eq("source", source);
      if (urgency) query = query.eq("urgency", urgency);
      const tag = cleanText(req.query.tag, 50);
      if (tag) query = query.contains("tags", [tag]);
      const search = sanitizeSearch(req.query.search);
      if (search) {
        query = query.or(
          `full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,company.ilike.%${search}%`
        );
      }
      const { data, error, count } = await query
        .order(sort, { ascending: order === "asc", nullsFirst: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return res.json({ contacts: data || [], total: count || 0, limit, offset });
    } catch (error) {
      return handleRouteError(logger, res, "list", error);
    }
  });

  router.post("/", async (req, res) => {
    const tenant = resolveCollectionTenant(req);
    if (!tenant.companyId) return sendTenantResolutionError(res, tenant);
    const prepared = buildContactPayload(req.body || {}, { now });
    if (prepared.errors.length) {
      return res.status(400).json({
        error: prepared.errors[0],
        validation_errors: prepared.errors,
      });
    }
    try {
      const duplicates = await findDuplicates(supabase, tenant.companyId, prepared.payload);
      if (duplicates.length) return duplicateResponse(res, duplicates);
      const { data, error } = await supabase
        .from("contacts")
        .insert({ company_id: tenant.companyId, ...prepared.payload })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ success: true, contact: data });
    } catch (error) {
      return handleRouteError(logger, res, "create", error);
    }
  });

  router.get("/lookup/find", async (req, res) => {
    const tenant = resolveCollectionTenant(req);
    if (!tenant.companyId) return sendTenantResolutionError(res, tenant);
    const phone = req.query.phone ? normalizeE164(req.query.phone) : null;
    const email = req.query.email ? normalizeEmail(req.query.email) : { value: null };
    if (req.query.phone && !phone) return res.status(400).json({ error: "invalid_phone_e164" });
    if (email.error) return res.status(400).json({ error: email.error });
    if (!phone && !email.value) return res.status(400).json({ error: "phone_or_email_required" });
    try {
      let query = supabase
        .from("contacts")
        .select("*")
        .eq("company_id", tenant.companyId)
        .neq("status", "archived")
        .neq("status", "anonymized");
      query = phone ? query.eq("phone", phone) : query.eq("email", email.value);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return res.json({ contact: data || null, found: Boolean(data) });
    } catch (error) {
      return handleRouteError(logger, res, "lookup", error);
    }
  });

  router.get("/stats/overview", async (req, res) => {
    const tenant = resolveCollectionTenant(req);
    if (!tenant.companyId) return sendTenantResolutionError(res, tenant);
    try {
      const { data, error } = await supabase
        .from("contacts")
        .select("status, source, urgency, next_action_date, created_at")
        .eq("company_id", tenant.companyId)
        .neq("status", "anonymized");
      if (error) throw error;
      const clock = now();
      const weekAgo = new Date(clock.getTime() - 7 * 86400000).toISOString();
      const stats = {
        total: 0,
        by_status: Object.fromEntries(CRM_PIPELINE.map(item => [item, 0])),
        by_source: {},
        by_urgency: { high: 0, normal: 0, low: 0 },
        next_actions_due: 0,
        new_this_week: 0,
      };
      for (const contact of data || []) {
        if (contact.status !== "archived") stats.total += 1;
        if (stats.by_status[contact.status] !== undefined) stats.by_status[contact.status] += 1;
        if (contact.source) stats.by_source[contact.source] = (stats.by_source[contact.source] || 0) + 1;
        if (stats.by_urgency[contact.urgency] !== undefined) stats.by_urgency[contact.urgency] += 1;
        if (contact.status !== "archived" && contact.next_action_date && contact.next_action_date <= clock.toISOString()) {
          stats.next_actions_due += 1;
        }
        if (contact.status !== "archived" && contact.created_at >= weekAgo) stats.new_this_week += 1;
      }
      return res.json(stats);
    } catch (error) {
      return handleRouteError(logger, res, "stats", error);
    }
  });

  router.get("/:id/duplicates", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid_contact_id" });
    try {
      const { data: contact, error } = await loadTenantContact(supabase, req, req.params.id);
      if (error) throw error;
      if (!contact) return respondTenantMiss(supabase, res, req.params.id, "Contact introuvable", req);
      if (TERMINAL_STATUSES.has(contact.status)) return res.json({ duplicates: [] });
      const duplicates = await findDuplicates(supabase, contact.company_id, contact, contact.id);
      return res.json({ duplicates });
    } catch (error) {
      return handleRouteError(logger, res, "duplicates", error);
    }
  });

  router.post("/:id/merge", express.json(), async (req, res) => {
    if (!MERGE_ROLES.has(req.user?.role)) return res.status(403).json({ error: "forbidden" });
    const duplicateId = req.body?.duplicate_contact_id;
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(duplicateId || "")) {
      return res.status(400).json({ error: "invalid_contact_id" });
    }
    if (duplicateId === req.params.id) return res.status(400).json({ error: "cannot_merge_same_contact" });
    try {
      const { data: primary, error: primaryError } = await loadTenantContact(
        supabase, req, req.params.id, "id, company_id, status, merged_into_contact_id"
      );
      if (primaryError) throw primaryError;
      if (!primary) return respondTenantMiss(supabase, res, req.params.id, "Contact principal introuvable", req);
      const { data: duplicate, error: duplicateError } = await supabase
        .from("contacts")
        .select("id, company_id, status, merged_into_contact_id")
        .eq("id", duplicateId)
        .eq("company_id", primary.company_id)
        .maybeSingle();
      if (duplicateError) throw duplicateError;
      if (!duplicate) return respondTenantMiss(supabase, res, duplicateId, "Doublon introuvable", req);
      if (TERMINAL_STATUSES.has(primary.status) || TERMINAL_STATUSES.has(duplicate.status)) {
        return res.status(409).json({ error: "terminal_contact_cannot_merge" });
      }
      if (primary.merged_into_contact_id || duplicate.merged_into_contact_id) {
        return res.status(409).json({ error: "contact_already_merged" });
      }
      const { data, error } = await supabase.rpc("merge_crm_contacts", {
        p_company_id: primary.company_id,
        p_primary_contact_id: primary.id,
        p_duplicate_contact_id: duplicate.id,
        p_actor_user_id: req.user?.id || null,
        p_actor_role: req.user?.role || null,
      });
      if (error) {
        if (error.code === "42501") return res.status(403).json({ error: "forbidden_cross_tenant" });
        throw error;
      }
      return res.json({
        ...data,
        merged_contact_id: data?.archived_contact_id || duplicate.id,
      });
    } catch (error) {
      return handleRouteError(logger, res, "merge", error);
    }
  });

  router.get("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid_contact_id" });
    try {
      const { data: contact, error: contactError } = await loadTenantContact(supabase, req, req.params.id);
      if (contactError) throw contactError;
      if (!contact) return respondTenantMiss(supabase, res, req.params.id, "Contact introuvable", req);
      const companyId = contact.company_id;
      const [notes, calls, outboundCalls, emails, appointments] = await Promise.all([
        supabase.from("contact_notes").select("*").eq("contact_id", contact.id).eq("company_id", companyId).order("created_at", { ascending: false }),
        supabase.from("calls").select("*").eq("contact_id", contact.id).eq("company_id", companyId).order("created_at", { ascending: false }),
        supabase.from("outbound_calls").select("*").eq("contact_id", contact.id).eq("company_id", companyId).order("created_at", { ascending: false }),
        supabase.from("emails").select("*").eq("contact_id", contact.id).eq("company_id", companyId).order("received_at", { ascending: false }),
        supabase.from("appointments").select("*").eq("contact_id", contact.id).eq("company_id", companyId).order("date", { ascending: false }),
      ]);
      const relatedError = [notes, calls, outboundCalls, emails, appointments]
        .find(result => result.error)?.error;
      if (relatedError) throw relatedError;
      const callIds = (calls.data || []).map(call => call.id).filter(Boolean);
      let learningSuggestions = [];
      if (callIds.length) {
        const { data, error } = await supabase
          .from("learning_suggestions")
          .select("*")
          .eq("company_id", companyId)
          .overlaps("source_ids", callIds)
          .order("created_at", { ascending: false });
        if (error) throw error;
        learningSuggestions = data || [];
      }
      return res.json({
        contact,
        history: {
          notes: notes.data || [],
          calls: calls.data || [],
          outbound_calls: outboundCalls.data || [],
          emails: emails.data || [],
          appointments: appointments.data || [],
          learning_suggestions: learningSuggestions,
        },
        stats: {
          total_interactions: (notes.data?.length || 0) + (calls.data?.length || 0)
            + (outboundCalls.data?.length || 0) + (emails.data?.length || 0),
          total_appointments: appointments.data?.length || 0,
          pending_learning_suggestions: learningSuggestions.filter(item => item.status === "pending").length,
        },
      });
    } catch (error) {
      return handleRouteError(logger, res, "detail", error);
    }
  });

  router.patch("/:id", express.json(), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid_contact_id" });
    try {
      const { data: current, error: currentError } = await loadTenantContact(supabase, req, req.params.id);
      if (currentError) throw currentError;
      if (!current) return respondTenantMiss(supabase, res, req.params.id, "Contact introuvable", req);
      if (TERMINAL_STATUSES.has(current.status) || current.merged_into_contact_id) {
        return res.status(409).json({ error: "terminal_contact_read_only" });
      }
      const prepared = buildContactPayload(req.body || {}, { partial: true, current, now });
      if (prepared.errors.length) {
        return res.status(400).json({ error: prepared.errors[0], validation_errors: prepared.errors });
      }
      const identityChanged = ["phone", "email", "full_name", "company"]
        .some(key => hasOwn(req.body, key));
      if (identityChanged) {
        const duplicates = await findDuplicates(
          supabase, current.company_id, { ...current, ...prepared.payload }, current.id
        );
        if (duplicates.length) return duplicateResponse(res, duplicates);
      }
      const { data, error } = await supabase
        .from("contacts")
        .update({ ...prepared.payload, updated_at: now().toISOString() })
        .eq("id", current.id)
        .eq("company_id", current.company_id)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "contact_update_conflict" });
      return res.json({ success: true, contact: data });
    } catch (error) {
      return handleRouteError(logger, res, "update", error);
    }
  });

  router.delete("/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid_contact_id" });
    try {
      const { data: current, error: currentError } = await loadTenantContact(
        supabase, req, req.params.id, "id, company_id, status"
      );
      if (currentError) throw currentError;
      if (!current) return respondTenantMiss(supabase, res, req.params.id, "Contact introuvable", req);
      if (current.status === "anonymized") {
        return res.status(409).json({ error: "anonymized_contact_read_only" });
      }
      if (current.status === "archived") {
        return res.json({ success: true, archived: true, contact_id: current.id });
      }
      const archivedAt = now().toISOString();
      const { data, error } = await supabase
        .from("contacts")
        .update({
          status: "archived",
          archived_at: archivedAt,
          archived_by: req.user?.id || null,
          next_action: null,
          next_action_date: null,
          next_action_note: null,
          updated_at: archivedAt,
        })
        .eq("id", current.id)
        .eq("company_id", current.company_id)
        .select("id, status, archived_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "contact_archive_conflict" });
      return res.json({ success: true, archived: true, contact: data });
    } catch (error) {
      return handleRouteError(logger, res, "archive", error);
    }
  });

  router.post("/:id/notes", express.json(), async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid_contact_id" });
    const noteText = cleanText(req.body?.note, 10000);
    const nextActionNote = cleanText(req.body?.next_action_note ?? req.body?.next_action, 2000);
    const nextActionDate = normalizeDate(req.body?.next_action_date);
    if (nextActionDate.error) return res.status(400).json({ error: nextActionDate.error });
    if (!noteText && !nextActionNote) return res.status(400).json({ error: "note_required" });
    try {
      const { data: contact, error: contactError } = await loadTenantContact(
        supabase, req, req.params.id, "id, company_id, status"
      );
      if (contactError) throw contactError;
      if (!contact) return respondTenantMiss(supabase, res, req.params.id, "Contact introuvable", req);
      if (TERMINAL_STATUSES.has(contact.status)) {
        return res.status(409).json({ error: "terminal_contact_read_only" });
      }
      const { data, error } = await supabase
        .from("contact_notes")
        .insert({
          company_id: contact.company_id,
          contact_id: contact.id,
          direction: "manual",
          note: noteText,
          next_action: nextActionNote,
          created_by: req.user?.id || "manual",
        })
        .select()
        .single();
      if (error) throw error;
      const update = {
        last_interaction_at: now().toISOString(),
        updated_at: now().toISOString(),
      };
      if (nextActionNote !== null) {
        update.next_action = nextActionNote;
        update.next_action_note = nextActionNote;
      }
      if (hasOwn(req.body, "next_action_date")) {
        update.next_action_date = nextActionDate.value;
      }
      const { error: updateError } = await supabase
        .from("contacts")
        .update(update)
        .eq("id", contact.id)
        .eq("company_id", contact.company_id);
      if (updateError) throw updateError;
      return res.status(201).json({ success: true, note: data });
    } catch (error) {
      return handleRouteError(logger, res, "note", error);
    }
  });

  return router;
}

const router = createCrmRouter();

export default router;
