import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVACY_ROLES = new Set(["company_admin", "super_admin"]);
const ACTIVE_EXTERNAL_QUEUE_STATUSES = ["pending", "processing", "retry"];
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const POSTGREST_PAGE_SIZE = 1_000;
const POSTGREST_IN_CHUNK_SIZE = 100;

const RESTRICTED_EXPORT_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "auth_token",
  "client_secret",
  "credentials",
  "encrypted_access_token",
  "encrypted_api_key",
  "encrypted_password",
  "encrypted_refresh_token",
  "password",
  "refresh_token",
  "secret",
  "webhook_secret",
]);

let configuredCalendlyPrivacyDeleter = null;

/**
 * Configure the production Calendly erasure adapter after the calendar OAuth
 * service is initialized. The adapter is intentionally injected so this
 * privacy module never reads OAuth tokens or performs an unmocked provider
 * request on its own.
 */
export function configureCalendlyPrivacyDeleter(deleter) {
  if (typeof deleter !== "function") {
    throw new TypeError("calendly_privacy_deleter_must_be_a_function");
  }
  if (
    configuredCalendlyPrivacyDeleter &&
    configuredCalendlyPrivacyDeleter !== deleter
  ) {
    throw new Error("calendly_privacy_deleter_already_configured");
  }
  configuredCalendlyPrivacyDeleter = deleter;
}

class PrivacyStorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrivacyStorageError";
    this.code = code;
  }
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeRows(data) {
  if (Array.isArray(data)) return data;
  if (data === null || data === undefined) return [];
  return [data];
}

function safeRequestId(req, makeUuid) {
  const supplied = req.get?.("x-request-id");
  if (
    typeof supplied === "string" &&
    supplied.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(supplied)
  ) {
    return supplied;
  }
  return makeUuid();
}

function sanitizeReason(reason) {
  return reason
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[courriel masque]"
    )
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[telephone masque]");
}

function sanitizeForExport(value, extraRestrictedKeys = new Set()) {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForExport(item, extraRestrictedKeys));
  }
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      RESTRICTED_EXPORT_KEYS.has(normalizedKey) ||
      extraRestrictedKeys.has(normalizedKey) ||
      normalizedKey.endsWith("_secret") ||
      normalizedKey.endsWith("_api_key") ||
      normalizedKey.endsWith("_access_token") ||
      normalizedKey.endsWith("_refresh_token")
    ) {
      continue;
    }
    result[key] = sanitizeForExport(nestedValue, extraRestrictedKeys);
  }
  return result;
}

function normalizeRecordCounts(recordCounts) {
  const safeCounts = {};
  if (!recordCounts || typeof recordCounts !== "object") return safeCounts;
  for (const [table, count] of Object.entries(recordCounts)) {
    if (!/^[a-z_]{1,64}$/.test(table)) continue;
    if (!Number.isSafeInteger(count) || count < 0) continue;
    safeCounts[table] = count;
  }
  return safeCounts;
}

function normalizeAuditToken(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,100}$/i.test(value)
    ? value
    : fallback;
}

/**
 * Insert a privacy audit entry without accepting raw personal data.
 * Only numeric record counts and a format version are persisted in details.
 */
export async function writeAuditLog(
  supabase,
  {
    companyId,
    actorUserId,
    actorRole,
    action,
    entityType = "contact",
    entityId,
    requestId,
    details = {},
  }
) {
  if (!supabase) throw new PrivacyStorageError("audit_storage_unavailable");
  if (!isUuid(companyId) || !isUuid(actorUserId) || !isUuid(entityId)) {
    throw new PrivacyStorageError("invalid_audit_identifiers");
  }

  const payload = {
    company_id: companyId,
    actor_user_id: actorUserId,
    actor_role: normalizeAuditToken(actorRole, "unknown"),
    action: normalizeAuditToken(action, "privacy_action"),
    entity_type: normalizeAuditToken(entityType, "contact"),
    entity_id: entityId,
    request_id: normalizeAuditToken(requestId, randomUUID()),
    details: {
      format_version: normalizeAuditToken(details.format_version, "1.0"),
      record_counts: normalizeRecordCounts(details.record_counts),
    },
  };

  const { error } = await supabase.from("audit_log").insert(payload);
  if (error) throw new PrivacyStorageError("audit_write_failed");
  return true;
}

async function readOne(query, code) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new PrivacyStorageError(code);
  return data || null;
}

async function readAllPages(buildQuery, code) {
  const rows = [];
  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(
      from,
      from + POSTGREST_PAGE_SIZE - 1
    );
    if (error) throw new PrivacyStorageError(code);
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < POSTGREST_PAGE_SIZE) return rows;
  }
}

function mergeUniqueRows(...groups) {
  const byIdentity = new Map();
  for (const row of groups.flat()) {
    if (!row || typeof row !== "object") continue;
    const identity =
      typeof row.id === "string" && row.id
        ? `id:${row.id}`
        : `row:${JSON.stringify(row)}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, row);
  }
  return [...byIdentity.values()];
}

async function readAllForChunks(values, buildQuery, code) {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  const groups = [];
  for (
    let offset = 0;
    offset < uniqueValues.length;
    offset += POSTGREST_IN_CHUNK_SIZE
  ) {
    const chunk = uniqueValues.slice(offset, offset + POSTGREST_IN_CHUNK_SIZE);
    groups.push(await readAllPages(() => buildQuery(chunk), code));
  }
  return mergeUniqueRows(...groups);
}

function resolveTargetCompany(req, res, { allowQuery = false } = {}) {
  const role = req.user?.role;
  const bodyCompany = req.body?.company_id;
  const queryCompany = allowQuery ? req.query?.company_id : undefined;

  if (
    bodyCompany !== undefined &&
    queryCompany !== undefined &&
    bodyCompany !== queryCompany
  ) {
    res.status(400).json({ error: "company_id_conflict" });
    return null;
  }

  const requestedCompany = bodyCompany ?? queryCompany;
  if (requestedCompany !== undefined && !isUuid(requestedCompany)) {
    res.status(400).json({ error: "invalid_company_id" });
    return null;
  }

  if (role === "super_admin") {
    if (!requestedCompany) {
      res.status(400).json({ error: "company_id_required" });
      return null;
    }
    return requestedCompany;
  }

  const actorCompany = req.user?.company_id;
  if (!isUuid(actorCompany)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  if (requestedCompany && requestedCompany !== actorCompany) {
    res.status(403).json({ error: "cross_tenant_forbidden" });
    return null;
  }
  return actorCompany;
}

async function loadContactExport(supabase, companyId, contactId) {
  const [contact, directOutboundContact] = await Promise.all([
    readOne(
      supabase
        .from("contacts")
        .select("*")
        .eq("company_id", companyId)
        .eq("id", contactId),
      "contact_read_failed"
    ),
    readOne(
      supabase
        .from("outbound_contacts")
        .select("*")
        .eq("company_id", companyId)
        .eq("id", contactId),
      "outbound_contact_read_failed"
    ),
  ]);
  if (!contact && !directOutboundContact) return null;

  const targetType = contact ? "contact" : "outbound_contact";
  // Never infer that two rows represent the same person from a shared phone
  // number or email address. Automated privacy actions follow only the direct
  // target and real foreign-key relationships. Task 9 will introduce an
  // explicit, reviewed duplicate-merge workflow.
  const relatedContacts = [];
  const crmContacts = contact ? [contact] : [];
  const outboundContacts = directOutboundContact
    ? [directOutboundContact]
    : [];
  const crmContactIds = crmContacts.map(row => row.id).filter(isUuid);

  const [notes, calls, outboundCalls, emails, directAppointments] =
    await Promise.all([
      crmContactIds.length
        ? readAllForChunks(
            crmContactIds,
            ids =>
              supabase
                .from("contact_notes")
                .select("*")
                .eq("company_id", companyId)
                .in("contact_id", ids)
                .order("id", { ascending: true }),
            "contact_notes_read_failed"
          )
        : [],
      crmContactIds.length
        ? readAllForChunks(
            crmContactIds,
            ids =>
              supabase
                .from("calls")
                .select("*")
                .eq("company_id", companyId)
                .in("contact_id", ids)
                .order("id", { ascending: true }),
            "calls_read_failed"
          )
        : [],
      crmContactIds.length
        ? readAllForChunks(
            crmContactIds,
            ids =>
              supabase
                .from("outbound_calls")
                .select("*")
                .eq("company_id", companyId)
                .in("contact_id", ids)
                .order("id", { ascending: true }),
            "outbound_calls_read_failed"
          )
        : [],
      crmContactIds.length
        ? readAllForChunks(
            crmContactIds,
            ids =>
              supabase
                .from("emails")
                .select("*")
                .eq("company_id", companyId)
                .in("contact_id", ids)
                .order("id", { ascending: true }),
            "emails_read_failed"
          )
        : [],
      crmContactIds.length
        ? readAllForChunks(
            crmContactIds,
            ids =>
              supabase
                .from("appointments")
                .select("*")
                .eq("company_id", companyId)
                .in("contact_id", ids)
                .order("id", { ascending: true }),
            "appointments_read_failed"
          )
        : [],
    ]);

  const callIds = calls.map(call => call.id).filter(isUuid);
  const emailIds = emails.map(email => email.id).filter(isUuid);

  const [
    recordings,
    events,
    drafts,
    learningSuggestions,
    directCalendarBookingRequests,
  ] = await Promise.all([
    callIds.length
      ? readAllForChunks(
          callIds,
          ids =>
            supabase
              .from("call_recordings")
              .select("*")
              .eq("company_id", companyId)
              .in("call_id", ids)
              .order("id", { ascending: true }),
          "call_recordings_read_failed"
        )
      : [],
    callIds.length
      ? readAllForChunks(
          callIds,
          ids =>
            supabase
              .from("call_events")
              .select("*")
              .eq("company_id", companyId)
              .in("call_id", ids)
              .order("id", { ascending: true }),
          "call_events_read_failed"
        )
      : [],
    emailIds.length
      ? readAllForChunks(
          emailIds,
          ids =>
            supabase
              .from("email_drafts")
              .select("*")
              .eq("company_id", companyId)
              .in("email_id", ids)
              .order("id", { ascending: true }),
          "email_drafts_read_failed"
        )
      : [],
    callIds.length
      ? readAllForChunks(
          callIds.map(callId => `call:${callId}`),
          sources =>
            supabase
              .from("learning_suggestions")
              .select("*")
              .eq("company_id", companyId)
              .in("source", sources)
              .order("id", { ascending: true }),
          "learning_suggestions_read_failed"
        )
      : [],
    crmContactIds.length
      ? readAllForChunks(
          crmContactIds,
          ids =>
            supabase
              .from("calendar_booking_requests")
              .select("*")
              .eq("company_id", companyId)
              .in("contact_id", ids)
              .order("id", { ascending: true }),
          "calendar_booking_requests_read_failed"
        )
      : [],
  ]);

  // Follow only explicit foreign-key relationships. A booking may keep the
  // contact link while its appointment has not yet been linked (or vice
  // versa), so collect both directions without inferring identity from PII.
  const bookingAppointmentIds = directCalendarBookingRequests
    .map(booking => booking.appointment_id)
    .filter(isUuid);
  const bookingAppointments = bookingAppointmentIds.length
    ? await readAllForChunks(
        bookingAppointmentIds,
        ids =>
          supabase
            .from("appointments")
            .select("*")
            .eq("company_id", companyId)
            .in("id", ids)
            .order("id", { ascending: true }),
        "appointments_read_failed"
      )
    : [];
  const appointments = mergeUniqueRows(
    directAppointments,
    bookingAppointments
  );
  const appointmentIds = appointments.map(row => row.id).filter(isUuid);
  const appointmentBookingRequests = appointmentIds.length
    ? await readAllForChunks(
        appointmentIds,
        ids =>
          supabase
            .from("calendar_booking_requests")
            .select("*")
            .eq("company_id", companyId)
            .in("appointment_id", ids)
            .order("id", { ascending: true }),
        "calendar_booking_requests_read_failed"
      )
    : [];
  const calendarBookingRequests = mergeUniqueRows(
    directCalendarBookingRequests,
    appointmentBookingRequests
  );
  const calendarEmailOutbox = appointmentIds.length
    ? await readAllForChunks(
        appointmentIds,
        ids =>
          supabase
            .from("calendar_email_outbox")
            .select("*")
            .eq("company_id", companyId)
            .in("appointment_id", ids)
            .order("id", { ascending: true }),
        "calendar_email_outbox_read_failed"
      )
    : [];

  const data = {
    contact: sanitizeForExport(contact),
    related_contacts: sanitizeForExport(relatedContacts),
    outbound_contacts: sanitizeForExport(outboundContacts),
    contact_notes: sanitizeForExport(notes),
    calls: sanitizeForExport(calls),
    call_recordings: sanitizeForExport(recordings),
    call_events: sanitizeForExport(events),
    outbound_calls: sanitizeForExport(outboundCalls),
    emails: sanitizeForExport(emails),
    email_drafts: sanitizeForExport(drafts),
    appointments: sanitizeForExport(appointments),
    calendar_booking_requests: sanitizeForExport(calendarBookingRequests),
    calendar_email_outbox: sanitizeForExport(calendarEmailOutbox),
    learning_suggestions: sanitizeForExport(learningSuggestions),
  };

  return {
    targetType,
    data,
    recordCounts: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.length : value ? 1 : 0,
      ])
    ),
  };
}

function normalizeProviderResult(result) {
  if (result === true || result?.ok === true || result?.outcome === "completed") {
    return { outcome: "completed", errorCode: null };
  }
  return {
    outcome: "retry",
    errorCode: normalizeAuditToken(
      result?.errorCode,
      "provider_request_failed"
    ),
  };
}

function normalizeProviderTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_PROVIDER_TIMEOUT_MS);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    normalizeProviderTimeout(timeoutMs)
  );
  timeout.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("provider_timeout");
      timeoutError.code = "provider_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function providerFetchError(error) {
  return error?.code === "provider_timeout" || error?.name === "AbortError"
    ? "provider_timeout"
    : "provider_network_error";
}

async function deleteElevenLabsResource(job, context) {
  if (job.resource_type !== "conversation") {
    return { outcome: "retry", errorCode: "unsupported_resource_type" };
  }
  if (!context.elevenLabsApiKey || typeof context.fetchImpl !== "function") {
    return { outcome: "retry", errorCode: "provider_not_configured" };
  }

  try {
    const response = await fetchWithTimeout(
      context.fetchImpl,
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(
        job.external_id
      )}`,
      {
        method: "DELETE",
        headers: { "xi-api-key": context.elevenLabsApiKey },
      },
      context.providerTimeoutMs
    );
    if ((response.status >= 200 && response.status < 300) || response.status === 404) {
      return { outcome: "completed" };
    }
    return {
      outcome: "retry",
      errorCode: `provider_http_${Number(response.status) || 500}`,
    };
  } catch (error) {
    return {
      outcome: "retry",
      errorCode: providerFetchError(error),
    };
  }
}

async function deleteTwilioResource(job, context) {
  if (!["call", "recording"].includes(job.resource_type)) {
    return { outcome: "retry", errorCode: "unsupported_resource_type" };
  }
  if (
    !context.twilioAccountSid ||
    !context.twilioAuthToken ||
    typeof context.fetchImpl !== "function"
  ) {
    return { outcome: "retry", errorCode: "provider_not_configured" };
  }

  const authorization = Buffer.from(
    `${context.twilioAccountSid}:${context.twilioAuthToken}`,
    "utf8"
  ).toString("base64");
  const resource =
    job.resource_type === "call" ? "Calls" : "Recordings";
  try {
    const response = await fetchWithTimeout(
      context.fetchImpl,
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        context.twilioAccountSid
      )}/${resource}/${encodeURIComponent(job.external_id)}.json`,
      {
        method: "DELETE",
        headers: { Authorization: `Basic ${authorization}` },
      },
      context.providerTimeoutMs
    );
    if ((response.status >= 200 && response.status < 300) || response.status === 404) {
      return { outcome: "completed" };
    }
    return {
      outcome: "retry",
      errorCode: `provider_http_${Number(response.status) || 500}`,
    };
  } catch (error) {
    return {
      outcome: "retry",
      errorCode: providerFetchError(error),
    };
  }
}

async function deleteCalendlyResource(job, context) {
  // Legacy scheduled_event jobs remain durable but are not silently mapped to
  // a person-level erasure. Task 11 queues the explicit invitee email instead.
  if (job.resource_type !== "invitee_email") {
    if (typeof context.legacyCalendlyDeleter === "function") {
      return context.legacyCalendlyDeleter(job, context);
    }
    return { outcome: "retry", errorCode: "provider_not_configured" };
  }

  const prefix = `${job.company_id}:`;
  const email = job.external_id.startsWith(prefix)
    ? job.external_id.slice(prefix.length).trim().toLowerCase()
    : "";
  if (
    !isUuid(job.company_id) ||
    !email ||
    email.length > 254 ||
    !/^[^@\s]+@[^@\s]+$/.test(email) ||
    job.external_id !== `${prefix}${email}`
  ) {
    return {
      outcome: "retry",
      errorCode: "invalid_calendly_invitee_identifier",
    };
  }

  const deleter =
    context.calendlyDeleter || context.legacyCalendlyDeleter;
  if (typeof deleter !== "function") {
    return { outcome: "retry", errorCode: "provider_not_configured" };
  }
  return deleter({ ...job, external_id: email }, context);
}

async function updateExternalDeletion(supabase, job, updates) {
  let query = supabase
    .from("privacy_external_deletions")
    .update(updates)
    .eq("id", job.id);
  query = job.company_id
    ? query.eq("company_id", job.company_id)
    : query.is("company_id", null);
  query = job.target_contact_id
    ? query.eq("target_contact_id", job.target_contact_id)
    : query.is("target_contact_id", null);
  const { error } = await query;
  if (error) throw new PrivacyStorageError("external_queue_update_failed");
}

async function countPendingExternalDeletions(
  supabase,
  {
    companyId = null,
    contactId = null,
    includeFailed = contactId !== null,
  } = {}
) {
  const statuses = includeFailed
    ? [...ACTIVE_EXTERNAL_QUEUE_STATUSES, "failed"]
    : ACTIVE_EXTERNAL_QUEUE_STATUSES;
  let query = supabase
    .from("privacy_external_deletions")
    .select("id", { count: "exact", head: true })
    .in("status", statuses);
  if (companyId) query = query.eq("company_id", companyId);
  if (contactId) query = query.eq("target_contact_id", contactId);
  const { count, error } = await query;
  if (error) throw new PrivacyStorageError("external_queue_count_failed");
  return Number(count || 0);
}

/**
 * Claim and process durable provider-deletion jobs.
 * The returned summary contains counts only, never provider identifiers or secrets.
 */
export async function processPrivacyExternalDeletions({
  supabase,
  fetchImpl = globalThis.fetch,
  companyId = null,
  contactId = null,
  batchSize = DEFAULT_BATCH_SIZE,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BACKOFF_MS,
  now = () => new Date(),
  elevenLabsApiKey = process.env.ELEVENLABS_API_KEY,
  twilioAccountSid = process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken = process.env.TWILIO_AUTH_TOKEN,
  providerTimeoutMs = process.env.PRIVACY_PROVIDER_TIMEOUT_MS,
  calendlyDeleter = null,
  deleters = {},
} = {}) {
  if (!supabase) throw new PrivacyStorageError("external_queue_unavailable");
  if (companyId !== null && !isUuid(companyId)) {
    throw new PrivacyStorageError("invalid_queue_company");
  }
  if (contactId !== null && !isUuid(contactId)) {
    throw new PrivacyStorageError("invalid_queue_contact");
  }
  if (calendlyDeleter !== null && typeof calendlyDeleter !== "function") {
    throw new PrivacyStorageError("invalid_calendly_deleter");
  }

  const safeBatchSize = Math.max(
    1,
    Math.min(100, Number.parseInt(batchSize, 10) || DEFAULT_BATCH_SIZE)
  );
  const { data: claimedData, error: claimError } = await supabase.rpc(
    "claim_privacy_external_deletions",
    {
      p_batch_size: safeBatchSize,
      p_company_id: companyId,
      p_contact_id: contactId,
    }
  );
  if (claimError) throw new PrivacyStorageError("external_queue_claim_failed");

  const claimed = normalizeRows(claimedData);
  const summary = {
    claimed: claimed.length,
    completed: 0,
    retry: 0,
    failed: 0,
    pending: false,
  };
  const safeDeleters =
    deleters && typeof deleters === "object" ? deleters : {};
  const {
    calendly: legacyCalendlyDeleter,
    ...otherProviderDeleters
  } = safeDeleters;
  const providerDeleters = {
    elevenlabs: deleteElevenLabsResource,
    twilio: deleteTwilioResource,
    calendly: deleteCalendlyResource,
    ...otherProviderDeleters,
  };
  const context = {
    fetchImpl,
    elevenLabsApiKey,
    twilioAccountSid,
    twilioAuthToken,
    providerTimeoutMs: normalizeProviderTimeout(providerTimeoutMs),
    calendlyDeleter:
      calendlyDeleter || configuredCalendlyPrivacyDeleter,
    legacyCalendlyDeleter,
  };

  for (const job of claimed) {
    const isOrphanCleanup = job?.company_id === null;
    if (
      !job ||
      !isUuid(job.id) ||
      (!isOrphanCleanup && !isUuid(job.company_id)) ||
      (isOrphanCleanup && companyId !== null) ||
      (job.target_contact_id !== null &&
        job.target_contact_id !== undefined &&
        !isUuid(job.target_contact_id)) ||
      typeof job.external_id !== "string" ||
      !job.external_id ||
      (companyId && job.company_id !== companyId) ||
      (contactId && job.target_contact_id !== contactId)
    ) {
      throw new PrivacyStorageError("invalid_external_queue_item");
    }

    const deleter = providerDeleters[job.provider];
    let providerResult;
    if (typeof deleter !== "function") {
      providerResult = {
        outcome: "retry",
        errorCode: "unsupported_provider",
      };
    } else {
      try {
        providerResult = normalizeProviderResult(await deleter(job, context));
      } catch {
        providerResult = {
          outcome: "retry",
          errorCode: "provider_request_failed",
        };
      }
    }

    const attempt = Math.max(1, Number.parseInt(job.attempts, 10) || 1);
    const timestamp = now();
    if (providerResult.outcome === "completed") {
      await updateExternalDeletion(supabase, job, {
        status: "completed",
        last_error: null,
        locked_at: null,
        next_attempt_at: null,
        completed_at: timestamp.toISOString(),
        updated_at: timestamp.toISOString(),
      });
      summary.completed += 1;
      continue;
    }

    const safeMaxAttempts = Math.max(
      1,
      Number.parseInt(maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS
    );
    if (attempt >= safeMaxAttempts) {
      await updateExternalDeletion(supabase, job, {
        status: "failed",
        last_error: providerResult.errorCode,
        locked_at: null,
        next_attempt_at: null,
        completed_at: timestamp.toISOString(),
        updated_at: timestamp.toISOString(),
      });
      summary.failed += 1;
      continue;
    }

    const cappedAttempt = Math.min(safeMaxAttempts, attempt);
    const delay = Math.min(
      MAX_BACKOFF_MS,
      Math.max(1_000, baseBackoffMs) * 2 ** Math.max(0, cappedAttempt - 1)
    );
    await updateExternalDeletion(supabase, job, {
      status: "retry",
      last_error: providerResult.errorCode,
      locked_at: null,
      completed_at: null,
      next_attempt_at: new Date(timestamp.getTime() + delay).toISOString(),
      updated_at: timestamp.toISOString(),
    });
    summary.retry += 1;
  }

  summary.pending =
    (await countPendingExternalDeletions(supabase, {
      companyId,
      contactId,
    })) > 0;
  return summary;
}

function requirePrivacyActor(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ error: "authentication_required" });
  }
  if (!PRIVACY_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (!isUuid(req.user.id)) {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}

export function createPrivacyRouter({
  supabase,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  makeUuid = randomUUID,
  logger = console,
  elevenLabsApiKey = process.env.ELEVENLABS_API_KEY,
  twilioAccountSid = process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken = process.env.TWILIO_AUTH_TOKEN,
  providerTimeoutMs = process.env.PRIVACY_PROVIDER_TIMEOUT_MS,
  calendlyDeleter = null,
  deleters = {},
} = {}) {
  const router = express.Router();
  router.use(requirePrivacyActor);

  router.post("/data-export", async (req, res) => {
    const contactId = req.body?.contact_id;
    if (!isUuid(contactId)) {
      return res.status(400).json({ error: "invalid_contact_id" });
    }
    const companyId = resolveTargetCompany(req, res);
    if (!companyId) return;
    if (!supabase) {
      return res.status(503).json({ error: "privacy_storage_unavailable" });
    }

    const requestId = safeRequestId(req, makeUuid);
    try {
      const exported = await loadContactExport(supabase, companyId, contactId);
      if (!exported) {
        return res.status(403).json({ error: "contact_access_forbidden" });
      }

      await writeAuditLog(supabase, {
        companyId,
        actorUserId: req.user.id,
        actorRole: req.auditActor?.role || req.user.role,
        action: "privacy_data_exported",
        entityType: exported.targetType,
        entityId: contactId,
        requestId,
        details: {
          format_version: "1.0",
          record_counts: exported.recordCounts,
        },
      });

      res.set("Cache-Control", "no-store, private");
      res.set(
        "Content-Disposition",
        'attachment; filename="contact-data-export.json"'
      );
      return res.json({
        format_version: "1.0",
        exported_at: now().toISOString(),
        request_id: requestId,
        company_id: companyId,
        contact_id: contactId,
        target_type: exported.targetType,
        data: exported.data,
      });
    } catch {
      logger?.error?.("[privacy] data export failed");
      return res.status(500).json({ error: "privacy_export_failed" });
    }
  });

  router.delete("/anonymize/:contact_id", async (req, res) => {
    const contactId = req.params.contact_id;
    if (!isUuid(contactId)) {
      return res.status(400).json({ error: "invalid_contact_id" });
    }
    const companyId = resolveTargetCompany(req, res, { allowQuery: true });
    if (!companyId) return;
    if (!supabase) {
      return res.status(503).json({ error: "privacy_storage_unavailable" });
    }

    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "confirmation_required" });
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({ error: "invalid_reason" });
    }

    const requestId = safeRequestId(req, makeUuid);
    try {
      const [contact, outboundContact] = await Promise.all([
        readOne(
          supabase
            .from("contacts")
            .select("id")
            .eq("company_id", companyId)
            .eq("id", contactId),
          "contact_ownership_check_failed"
        ),
        readOne(
          supabase
            .from("outbound_contacts")
            .select("id")
            .eq("company_id", companyId)
            .eq("id", contactId),
          "outbound_contact_ownership_check_failed"
        ),
      ]);
      if (!contact && !outboundContact) {
        return res.status(403).json({ error: "contact_access_forbidden" });
      }
      const targetType = contact ? "contact" : "outbound_contact";

      const { data, error } = await supabase.rpc("anonymize_contact_data", {
        p_company_id: companyId,
        p_contact_id: contactId,
        p_actor_user_id: req.user.id,
        p_actor_role: req.auditActor?.role || req.user.role,
        p_reason: sanitizeReason(reason),
        p_request_id: requestId,
      });
      if (error) throw new PrivacyStorageError("anonymize_rpc_failed");

      const rpcResult = normalizeRows(data)[0] || {};
      let externalCleanup;
      try {
        externalCleanup = await processPrivacyExternalDeletions({
          supabase,
          fetchImpl,
          companyId,
          contactId,
          now,
          elevenLabsApiKey,
          twilioAccountSid,
          twilioAuthToken,
          providerTimeoutMs,
          calendlyDeleter,
          deleters,
        });
      } catch {
        logger?.error?.("[privacy] external deletion processing deferred");
        externalCleanup = {
          claimed: 0,
          completed: 0,
          retry: 0,
          failed: 0,
          pending: true,
        };
      }

      const pending =
        externalCleanup.pending ||
        externalCleanup.retry > 0 ||
        externalCleanup.failed > 0;
      const cleanupStatus =
        externalCleanup.failed > 0
          ? "failed"
          : pending
            ? "pending"
            : "completed";
      return res.status(pending ? 202 : 200).json({
        success: true,
        anonymized: rpcResult.anonymized !== false,
        request_id: requestId,
        target_type: targetType,
        external_cleanup: cleanupStatus,
        external_cleanup_counts: {
          completed: externalCleanup.completed,
          retry: externalCleanup.retry,
          failed: externalCleanup.failed,
        },
      });
    } catch {
      logger?.error?.("[privacy] anonymization failed");
      return res.status(500).json({ error: "privacy_anonymization_failed" });
    }
  });

  return router;
}

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

const router = createPrivacyRouter({ supabase: createDefaultSupabase() });

export default router;
