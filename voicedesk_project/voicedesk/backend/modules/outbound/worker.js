import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { logger as defaultLogger } from "../../lib/logger.js";
import {
  prefixRecordingConsentEn,
  prefixRecordingConsentFr,
} from "../privacy/consent.js";
import { evaluateBusinessHours } from "../voice/businessHours.js";
import { createElevenLabsClient } from "./elevenlabsClient.js";
import { createOutboundQueue, OutboundQueueError } from "./queue.js";

const DEFAULT_TIME_ZONE = "America/Toronto";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_ERROR_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1_000;
const DEFAULT_PAUSED_RECHECK_MS = 60_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "active_paid",
  "trial",
]);
const COUNTED_ATTEMPT_STATUSES = [
  "dispatching",
  "in_progress",
  "completed",
  "no_answer",
  "retryable_failure",
  "failed",
  "dispatch_unknown",
];
const DAY_BY_ISO_NUMBER = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
  7: "sunday",
};
const LOCAL_DATE_FORMATTERS = new Map();

export class OutboundPreflightError extends Error {
  constructor(code, { retryable = true, cause = null } = {}) {
    super(code);
    this.name = "OutboundPreflightError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OutboundPreflightError("invalid_worker_clock", {
      retryable: false,
    });
  }
  return date;
}

function safeErrorCode(error, fallback = "outbound_worker_error") {
  return String(error?.code || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, 128) || fallback;
}

function positiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeOutboundHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = {};
  for (const [key, windows] of Object.entries(value)) {
    normalized[DAY_BY_ISO_NUMBER[key] || key.toLowerCase()] = windows;
  }
  return normalized;
}

export function evaluateOutboundBusinessHours({
  now,
  timeZone,
  outboundBusinessHours,
}) {
  return evaluateBusinessHours({
    now,
    timeZone,
    businessHours: normalizeOutboundHours(outboundBusinessHours),
  });
}

export function localDateInTimeZone(date, timeZone) {
  let formatter;
  try {
    formatter = LOCAL_DATE_FORMATTERS.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      if (LOCAL_DATE_FORMATTERS.size >= 128) LOCAL_DATE_FORMATTERS.clear();
      LOCAL_DATE_FORMATTERS.set(timeZone, formatter);
    }
  } catch (error) {
    throw new OutboundPreflightError("invalid_business_timezone", {
      retryable: false,
      cause: error,
    });
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Find the next open minute using absolute instants, so Intl handles DST. */
export function findNextOutboundOpening({
  now,
  timeZone,
  outboundBusinessHours,
  afterCurrentWindow = false,
  maxMinutes = 8 * 24 * 60,
}) {
  const start = asDate(now);
  const initialLocalDate = afterCurrentWindow
    ? localDateInTimeZone(start, timeZone)
    : null;
  for (let offset = 1; offset <= maxMinutes; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (
      initialLocalDate
      && localDateInTimeZone(candidate, timeZone) === initialLocalDate
    ) {
      continue;
    }
    const evaluation = evaluateOutboundBusinessHours({
      now: candidate,
      timeZone,
      outboundBusinessHours,
    });
    if (evaluation.isOpen) {
      candidate.setUTCSeconds(0, 0);
      return candidate;
    }
  }
  return null;
}

async function readMaybeSingle(query, code) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new OutboundPreflightError(code, { cause: error });
  return data || null;
}

async function readRows(query, code) {
  const { data, error } = await query;
  if (error) throw new OutboundPreflightError(code, { cause: error });
  return Array.isArray(data) ? data : [];
}

async function readCount(query, code) {
  const { count, error } = await query;
  if (error) throw new OutboundPreflightError(code, { cause: error });
  return Number(count) || 0;
}

function block(code) {
  return { action: "block", code };
}

function defer(code, retryAt) {
  return { action: "defer", code, retryAt };
}

/**
 * Revalidates every mutable guard after a queue claim. The migration's
 * begin_outbound_call_attempt RPC repeats the critical checks atomically just
 * before dispatch; this application check gives controlled retry/block states
 * and avoids needless provider calls.
 */
export function createOutboundPreflight({
  supabase,
  now = () => new Date(),
  pausedRecheckMs = DEFAULT_PAUSED_RECHECK_MS,
} = {}) {
  if (!supabase?.from) throw new TypeError("supabase with from() is required");
  const nextDayOpeningCache = new Map();

  return async function preflight(job) {
    const instant = asDate(now());
    const campaign = await readMaybeSingle(
      supabase
        .from("outbound_campaigns")
        .select(
          "id, company_id, name, mission_type, script, status, daily_call_limit, outbound_phone_number_id"
        )
        .eq("id", job.campaign_id)
        .eq("company_id", job.company_id),
      "campaign_lookup_failed"
    );
    if (!campaign) return block("campaign_not_found");
    if (campaign.status !== "active") {
      if (campaign.status === "paused") {
        return defer(
          "campaign_paused",
          new Date(instant.getTime() + pausedRecheckMs)
        );
      }
      return block("campaign_not_active");
    }
    if (typeof campaign.script !== "string" || campaign.script.trim().length < 20) {
      return block("campaign_script_invalid");
    }

    const company = await readMaybeSingle(
      supabase
        .from("companies")
        .select("id, name")
        .eq("id", job.company_id),
      "company_lookup_failed"
    );
    if (!company || typeof company.name !== "string" || !company.name.trim()) {
      return block("company_identity_missing");
    }

    const outboundContact = await readMaybeSingle(
      supabase
        .from("outbound_contacts")
        .select("id, company_id, campaign_id, full_name, phone, language, status")
        .eq("id", job.outbound_contact_id)
        .eq("company_id", job.company_id)
        .eq("campaign_id", job.campaign_id)
        .in("status", ["pending", "calling"]),
      "outbound_contact_lookup_failed"
    );
    if (!outboundContact || outboundContact.phone !== job.contact_phone_e164) {
      return block("outbound_contact_invalid");
    }

    const settings = await readMaybeSingle(
      supabase
        .from("voice_call_settings")
        .select("company_id, timezone, outbound_business_hours")
        .eq("company_id", job.company_id),
      "voice_settings_lookup_failed"
    );
    if (!settings?.outbound_business_hours) {
      return block("outbound_business_hours_missing");
    }
    const timeZone = settings.timezone || DEFAULT_TIME_ZONE;
    let hours;
    try {
      hours = evaluateOutboundBusinessHours({
        now: instant,
        timeZone,
        outboundBusinessHours: settings.outbound_business_hours,
      });
    } catch (error) {
      throw new OutboundPreflightError("outbound_business_hours_invalid", {
        retryable: false,
        cause: error,
      });
    }
    if (!hours.isOpen) {
      const retryAt = findNextOutboundOpening({
        now: instant,
        timeZone,
        outboundBusinessHours: settings.outbound_business_hours,
      });
      if (!retryAt) return block("outbound_business_hours_never_open");
      return defer("outside_outbound_business_hours", retryAt);
    }

    let contactQuery = supabase
      .from("contacts")
      .select("id, company_id, full_name, phone, call_consent, status")
      .eq("company_id", job.company_id)
      .eq("call_consent", true)
      .is("anonymized_at", null)
      .is("merged_into_contact_id", null)
      .neq("status", "archived")
      .neq("status", "anonymized");
    contactQuery = job.contact_id
      ? contactQuery.eq("id", job.contact_id)
      : contactQuery.eq("phone", job.contact_phone_e164).limit(1);
    const contact = await readMaybeSingle(
      contactQuery,
      "call_consent_lookup_failed"
    );
    if (!contact || contact.phone !== job.contact_phone_e164) {
      return block("call_consent_required");
    }

    // Fail closed: a DNC read error throws and no call can leave the worker.
    const dncEntry = await readMaybeSingle(
      supabase
        .from("dnc_list")
        .select("id")
        .eq("company_id", job.company_id)
        .eq("phone", job.contact_phone_e164),
      "dnc_lookup_failed"
    );
    if (dncEntry) return block("dnc_blocked");

    const subscription = await readMaybeSingle(
      supabase
        .from("subscriptions")
        .select(
          "company_id, payment_status, trial_ends_at, minutes_included, minutes_used_current_period, overage_policy"
        )
        .eq("company_id", job.company_id),
      "subscription_lookup_failed"
    );
    if (!subscription || !ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.payment_status)) {
      return block("subscription_inactive");
    }
    if (subscription.payment_status === "trial") {
      const trialEndsAt = subscription.trial_ends_at
        ? new Date(subscription.trial_ends_at)
        : null;
      if (
        !trialEndsAt
        || Number.isNaN(trialEndsAt.getTime())
        || trialEndsAt <= instant
      ) {
        return block("trial_expired_or_invalid");
      }
    }
    const included = Number(subscription.minutes_included);
    const used = Number(subscription.minutes_used_current_period) || 0;
    const reserved = Math.max(0, Number(job.reserved_minutes) || 0);
    if (
      subscription.overage_policy === "block_at_limit"
      && Number.isFinite(included)
      && used + reserved > included
    ) {
      return block("subscription_quota_exhausted");
    }

    const localCallDate = localDateInTimeZone(instant, timeZone);
    const dailyLimit = positiveInteger(campaign.daily_call_limit, 10, 1, 10_000);
    const attemptsToday = await readCount(
      supabase
        .from("outbound_call_attempts")
        .select("id, outbound_call_queue!inner(campaign_id)", {
          count: "exact",
          head: true,
        })
        .eq("company_id", job.company_id)
        .eq("outbound_call_queue.campaign_id", job.campaign_id)
        .eq("local_call_date", localCallDate)
        .in("status", COUNTED_ATTEMPT_STATUSES),
      "daily_quota_lookup_failed"
    );
    if (attemptsToday >= dailyLimit) {
      const retryAt = findNextOutboundOpening({
        now: instant,
        timeZone,
        outboundBusinessHours: settings.outbound_business_hours,
        afterCurrentWindow: true,
      });
      if (!retryAt) return block("outbound_business_hours_never_open");
      return defer("campaign_daily_quota_exhausted", retryAt);
    }
    let phoneQuery = supabase
      .from("phone_numbers")
      .select(
        "id, company_id, elevenlabs_agent_id, elevenlabs_phone_number_id, status"
      )
      .eq("company_id", job.company_id)
      .eq("status", "active");
    if (campaign.outbound_phone_number_id) {
      phoneQuery = phoneQuery.eq("id", campaign.outbound_phone_number_id);
    }
    const phoneNumbers = await readRows(
      phoneQuery.limit(2),
      "outbound_phone_lookup_failed"
    );
    if (phoneNumbers.length !== 1) {
      return block(
        phoneNumbers.length === 0
          ? "outbound_phone_missing"
          : "outbound_phone_ambiguous"
      );
    }
    const outboundPhone = phoneNumbers[0];
    if (
      !outboundPhone.elevenlabs_agent_id
      || !outboundPhone.elevenlabs_phone_number_id
    ) {
      return block("outbound_phone_not_provisioned");
    }

    const openingCacheKey = [
      job.company_id,
      localCallDate,
      timeZone,
      JSON.stringify(settings.outbound_business_hours),
    ].join("|");
    let nextAllowedAt = nextDayOpeningCache.get(openingCacheKey);
    if (nextAllowedAt === undefined) {
      nextAllowedAt = findNextOutboundOpening({
        now: instant,
        timeZone,
        outboundBusinessHours: settings.outbound_business_hours,
        afterCurrentWindow: true,
      });
      if (nextDayOpeningCache.size >= 512) nextDayOpeningCache.clear();
      nextDayOpeningCache.set(openingCacheKey, nextAllowedAt || null);
    }

    return {
      action: "dispatch",
      company,
      campaign,
      contact,
      outboundContact,
      outboundPhone,
      localCallDate,
      nextAllowedAt,
    };
  };
}

export function computeBackoffMs(
  attemptNumber,
  {
    baseMs = DEFAULT_ERROR_BACKOFF_MS,
    maxMs = DEFAULT_MAX_BACKOFF_MS,
    random = Math.random,
  } = {}
) {
  const attempt = positiveInteger(attemptNumber, 1, 1, 20);
  const exponential = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4;
  return Math.round(exponential * jitter);
}

export function buildConversationInitiationData(job, attempt, validation) {
  const ids = {
    voicedesk_direction: "outbound",
    company_id: String(job.company_id),
    campaign_id: String(job.campaign_id),
    outbound_contact_id: String(job.outbound_contact_id),
    contact_id: String(validation.contact.id),
    outbound_queue_id: String(job.id),
    outbound_attempt_id: String(attempt.id),
  };
  const contactName = String(
    validation.outboundContact?.full_name
      || validation.contact.full_name
      || ""
  )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const language = String(validation.outboundContact?.language || "fr")
    .trim()
    .toLowerCase()
    .startsWith("en") ? "en" : "fr";
  const companyName = String(validation.company?.name || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const greeting = language === "en"
    ? prefixRecordingConsentEn(
      contactName
        ? `Hello ${contactName}, I am the virtual assistant calling on behalf of ${companyName}.`
        : `I am the virtual assistant calling on behalf of ${companyName}.`
    )
    : prefixRecordingConsentFr(
      contactName
        ? `Bonjour ${contactName}, je suis l'assistante virtuelle qui appelle au nom de ${companyName}.`
        : `Je suis l'assistante virtuelle qui appelle au nom de ${companyName}.`
    );
  return {
    conversation_config_override: {
      agent: { first_message: greeting },
    },
    // Ne transporter que les identifiants de corrélation. Le Custom LLM relit
    // la mission, le contact et l'entreprise dans le tenant; le script métier
    // et les données CRM ne sont donc jamais copiés dans les métadonnées du
    // fournisseur.
    dynamic_variables: ids,
    custom_llm_extra_body: ids,
  };
}

export function createOutboundWorker({
  queue,
  client,
  preflight,
  now = () => new Date(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  providerTimeoutSeconds = 7_200,
  providerConfigurationBackoffMs = positiveInteger(
    process.env.OUTBOUND_PROVIDER_CONFIGURATION_BACKOFF_MS,
    15 * 60 * 1_000,
    60_000,
    24 * 60 * 60 * 1_000
  ),
  recoveryIntervalMs = positiveInteger(
    process.env.OUTBOUND_RECOVERY_INTERVAL_MS,
    DEFAULT_RECOVERY_INTERVAL_MS,
    10_000,
    60 * 60 * 1_000
  ),
  heartbeatTtlMs = positiveInteger(
    process.env.OUTBOUND_HEARTBEAT_TTL_MS,
    120_000,
    30_000,
    10 * 60 * 1_000
  ),
  random = Math.random,
  logger = defaultLogger,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!queue?.claimNext || !queue?.beginAttempt) {
    throw new TypeError("queue adapter is required");
  }
  if (!client?.initiateOutboundCall) {
    throw new TypeError("ElevenLabs client is required");
  }
  if (typeof preflight !== "function") {
    throw new TypeError("preflight function is required");
  }

  let running = false;
  let timer = null;
  let tickInProgress = false;
  let lastRecoveryAt = null;
  let startedAt = null;
  let lastSuccessfulTickAt = null;
  let lastErrorAt = null;
  let lastErrorCode = null;
  let persistentProviderError = false;
  let globalProviderBreakerUntil = 0;
  const tenantProviderBreakerUntil = new Map();
  const heartbeatTimeoutMs = Math.max(heartbeatTtlMs, pollIntervalMs * 10);

  async function runOnce() {
    let job;
    try {
      job = await queue.claimNext();
    } catch (error) {
      logger.error("Outbound queue claim failed", {
        error_code: safeErrorCode(error, "outbound_claim_failed"),
      });
      return { kind: "error", phase: "claim" };
    }
    if (!job) return { kind: "idle" };

    const currentTime = asDate(now()).getTime();
    const tenantBreakerUntil = tenantProviderBreakerUntil.get(job.company_id) || 0;
    const breakerUntil = Math.max(globalProviderBreakerUntil, tenantBreakerUntil);
    if (breakerUntil > currentTime) {
      await queue.defer(job, {
        code: "provider_configuration_quarantine",
        retryAt: new Date(breakerUntil),
      });
      return { kind: "error", phase: "provider_configuration_quarantine" };
    }
    if (tenantBreakerUntil) tenantProviderBreakerUntil.delete(job.company_id);
    if (globalProviderBreakerUntil && globalProviderBreakerUntil <= currentTime) {
      globalProviderBreakerUntil = 0;
    }

    let validation;
    try {
      validation = await preflight(job);
    } catch (error) {
      const code = safeErrorCode(error, "outbound_preflight_failed");
      const retryable = error?.retryable !== false;
      try {
        if (retryable) {
          await queue.defer(job, {
            code,
            retryAt: new Date(
              asDate(now()).getTime()
              + computeBackoffMs(job.attempt_count + 1, {
                baseMs: errorBackoffMs,
                maxMs: maxBackoffMs,
                random,
              })
            ),
          });
        } else {
          await queue.block(job, code);
        }
      } catch {
        // The lease recovery RPC owns uncertain queue-transition recovery.
      }
      logger.warn("Outbound preflight denied dispatch", { error_code: code });
      return { kind: retryable ? "deferred" : "blocked", code };
    }

    if (validation.action === "block") {
      await queue.block(job, validation.code);
      return { kind: "blocked", code: validation.code };
    }
    if (validation.action === "defer") {
      await queue.defer(job, validation);
      return { kind: "deferred", code: validation.code };
    }

    let attempt;
    try {
      // This RPC repeats consent/DNC/subscription/quota/number checks while
      // atomically reserving the attempt. It is the final pre-dispatch gate.
      attempt = await queue.beginAttempt(
        job,
        validation.localCallDate,
        validation.nextAllowedAt
      );
    } catch (error) {
      if (error?.code === "outbound_attempt_not_created") {
        logger.info("Outbound atomic guard changed queue state");
        return { kind: "deferred", code: "atomic_guard_applied" };
      }
      logger.warn("Outbound attempt could not begin", {
        error_code: safeErrorCode(error, "outbound_attempt_begin_failed"),
      });
      return { kind: "error", phase: "begin" };
    }

    const request = {
      agentId: validation.outboundPhone.elevenlabs_agent_id,
      agentPhoneNumberId:
        validation.outboundPhone.elevenlabs_phone_number_id,
      toNumber: job.contact_phone_e164,
      conversationInitiationClientData:
        buildConversationInitiationData(job, attempt, validation),
      callRecordingEnabled: true,
      ringingTimeoutSecs: 30,
    };

    let result;
    try {
      result = await client.initiateOutboundCall(request);
    } catch {
      // An injected/custom client may throw after sending. Never retry it.
      result = {
        kind: "dispatch_unknown",
        code: "provider_client_threw",
      };
    }

    if (result.kind === "accepted") {
      try {
        await queue.markDispatched(attempt, result, providerTimeoutSeconds);
      } catch (error) {
        logger.error("Outbound dispatch acknowledgement was not persisted", {
          error_code: safeErrorCode(error, "dispatch_persist_failed"),
        });
        return { kind: "error", phase: "persist_accepted" };
      }
      logger.info("Outbound call accepted by provider");
      return { kind: "accepted" };
    }

    if (result.kind === "retryable") {
      const backoffMs = computeBackoffMs(attempt.attempt_no, {
        baseMs: errorBackoffMs,
        maxMs: maxBackoffMs,
        random,
      });
      const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0);
      await queue.markRetryable(attempt, {
        code: result.code,
        retryAt: new Date(asDate(now()).getTime() + Math.max(backoffMs, retryAfterMs)),
      });
      return { kind: "retry_scheduled" };
    }

    if (result.kind === "permanent_failure") {
      await queue.markPermanentFailure(attempt, result.code);
      return { kind: "failed" };
    }

    if (result.kind === "configuration_failure") {
      const retryAt = new Date(
        asDate(now()).getTime() + providerConfigurationBackoffMs
      );
      await queue.markConfigurationFailure(attempt, {
        code: result.code,
        retryAt,
      });
      if (result.scope === "global") {
        globalProviderBreakerUntil = retryAt.getTime();
      } else {
        tenantProviderBreakerUntil.set(job.company_id, retryAt.getTime());
      }
      logger.error("Outbound provider configuration quarantined", {
        error_code: safeErrorCode(result, "provider_configuration_failure"),
        scope: result.scope === "global" ? "global" : "tenant",
      });
      return { kind: "error", phase: "provider_configuration_failure" };
    }

    await queue.markDispatchUnknown(attempt, result.code, {
      conversationId: result.conversationId,
      callSid: result.callSid,
    });
    logger.warn("Outbound provider dispatch state is unknown", {
      error_code: safeErrorCode(result, "provider_dispatch_unknown"),
    });
    return { kind: "dispatch_unknown" };
  }

  function schedule(delay) {
    if (!running) return;
    timer = setTimer(tick, Math.max(0, delay));
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    if (!running || tickInProgress) return;
    tickInProgress = true;
    let result = { kind: "error" };
    try {
      const tickNow = asDate(now()).getTime();
      if (
        lastRecoveryAt === null
        || tickNow - lastRecoveryAt >= recoveryIntervalMs
      ) {
        await queue.recoverStale();
        lastRecoveryAt = tickNow;
      }
      result = await runOnce();
      if (result.kind === "error") {
        lastErrorAt = asDate(now());
        lastErrorCode = result.phase || "outbound_worker_tick_failed";
        persistentProviderError = persistentProviderError
          || String(result.phase || "").startsWith("provider_configuration");
      } else {
        lastSuccessfulTickAt = asDate(now());
        const providerWasReached = [
          "accepted",
          "retry_scheduled",
          "failed",
          "dispatch_unknown",
        ].includes(result.kind);
        if (!persistentProviderError || providerWasReached) {
          lastErrorCode = null;
          persistentProviderError = false;
        }
      }
    } catch (error) {
      lastErrorAt = asDate(now());
      lastErrorCode = safeErrorCode(error);
      logger.error("Outbound worker tick failed", {
        error_code: lastErrorCode,
      });
    } finally {
      tickInProgress = false;
      schedule(
        result.kind === "idle"
          ? pollIntervalMs
          : result.kind === "error"
            ? errorBackoffMs
            : 0
      );
    }
  }

  function start() {
    if (running) return false;
    running = true;
    startedAt = asDate(now());
    lastSuccessfulTickAt = null;
    lastErrorAt = null;
    lastErrorCode = null;
    persistentProviderError = false;
    schedule(0);
    logger.info("Outbound worker started");
    return true;
  }

  function stop() {
    if (!running) return false;
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    logger.info("Outbound worker stopped");
    return true;
  }

  return {
    runOnce,
    start,
    stop,
    isRunning: () => running,
    getStatus: () => {
      const currentTime = asDate(now()).getTime();
      const heartbeatAgeMs = lastSuccessfulTickAt
        ? Math.max(0, currentTime - lastSuccessfulTickAt.getTime())
        : null;
      const ready = running
        && heartbeatAgeMs !== null
        && heartbeatAgeMs <= heartbeatTimeoutMs
        && lastErrorCode === null;
      return {
        ready,
        status: !running ? "stopped" : ready ? "running" : "degraded",
        started_at: startedAt?.toISOString() || null,
        last_successful_tick_at: lastSuccessfulTickAt?.toISOString() || null,
        last_error_at: lastErrorAt?.toISOString() || null,
        last_error_code: lastErrorCode,
      };
    },
  };
}

function createDefaultSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new OutboundQueueError("outbound_storage_unavailable");
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

let singletonWorker = null;

export function startOutboundWorker(options = {}) {
  if (singletonWorker?.isRunning()) return false;
  if (!options.client && !process.env.ELEVENLABS_API_KEY) {
    throw new OutboundQueueError("outbound_provider_unavailable");
  }
  const supabase = options.supabase || createDefaultSupabase();
  const now = options.now || (() => new Date());
  const workerId = options.workerId
    || process.env.OUTBOUND_WORKER_ID
    || `outbound-${process.pid}-${randomUUID()}`;
  const queue = options.queue || createOutboundQueue({
    supabase,
    workerId,
    leaseSeconds: options.leaseSeconds,
    reservedMinutes: options.reservedMinutes,
    now,
  });
  singletonWorker = createOutboundWorker({
    ...options,
    queue,
    now,
    client: options.client || createElevenLabsClient(options.clientOptions),
    preflight: options.preflight || createOutboundPreflight({ supabase, now }),
  });
  singletonWorker.start();
  return true;
}

export function getOutboundWorkerStatus() {
  return singletonWorker?.getStatus?.() || {
    ready: false,
    status: "stopped",
    started_at: null,
    last_successful_tick_at: null,
    last_error_at: null,
    last_error_code: null,
  };
}

export function stopOutboundWorker() {
  if (!singletonWorker) return false;
  const stopped = singletonWorker.stop();
  singletonWorker = null;
  return stopped;
}

export default createOutboundWorker;
