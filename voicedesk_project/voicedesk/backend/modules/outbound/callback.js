import crypto from "node:crypto";

import { transcriptHasConsentRefusal } from "../post_call/idempotency.js";

const POST_CALL_TRANSCRIPTION = "post_call_transcription";
const CALL_INITIATION_FAILURE = "call_initiation_failure";
const SUPPORTED_EVENT_TYPES = new Set([
  POST_CALL_TRANSCRIPTION,
  CALL_INITIATION_FAILURE,
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;
const MAX_TRANSCRIPT_TURNS = 1_000;
const MAX_TRANSCRIPT_MESSAGE_LENGTH = 10_000;

export class OutboundCallbackError extends Error {
  constructor(code, { status = 503, cause = null } = {}) {
    super(code);
    this.name = "OutboundCallbackError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeOpaqueId(value, maxLength = 255) {
  const normalized = firstString(value);
  if (
    !normalized
    || normalized.length > maxLength
    || CONTROL_CHARACTERS.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeUuid(value) {
  const normalized = firstString(value);
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function boundedDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.round(parsed), 24 * 60 * 60);
}

function safeLabel(value, fallback, maxLength = 128) {
  const normalized = firstString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function stablePayload(rawBody, body) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return rawBody;
  return JSON.stringify(body ?? {});
}

export function hashOutboundCallbackPayload(rawBody, body) {
  return crypto
    .createHash("sha256")
    .update(stablePayload(rawBody, body))
    .digest("hex");
}

export function extractOutboundCallbackHints(body) {
  const root = objectValue(body);
  const data = objectValue(root.data || root);
  const metadata = objectValue(data.metadata);
  const metadataBody = objectValue(metadata.body);
  const phoneCall = objectValue(metadata.phone_call);
  const initiation = objectValue(data.conversation_initiation_client_data);
  const dynamicVariables = objectValue(initiation.dynamic_variables);

  const rawAttemptId = firstString(
    dynamicVariables.outbound_attempt_id,
    dynamicVariables.attempt_id
  );
  const rawQueueId = firstString(
    dynamicVariables.outbound_queue_id,
    dynamicVariables.queue_id
  );

  return {
    eventType: firstString(root.type),
    direction: firstString(dynamicVariables.voicedesk_direction).toLowerCase(),
    conversationId: normalizeOpaqueId(
      data.conversation_id ?? root.conversation_id
    ),
    callSid: normalizeOpaqueId(firstString(
      data.twilio_call_sid,
      phoneCall.call_sid,
      metadataBody.CallSid,
      metadataBody.call_sid
    )),
    attemptId: normalizeUuid(rawAttemptId),
    queueId: normalizeUuid(rawQueueId),
    hasInvalidAttemptId: Boolean(rawAttemptId) && !normalizeUuid(rawAttemptId),
    hasInvalidQueueId: Boolean(rawQueueId) && !normalizeUuid(rawQueueId),
    data,
  };
}

async function findAttempt(supabase, column, value) {
  let response;
  try {
    response = await supabase
      .from("outbound_call_attempts")
      .select([
        "id",
        "company_id",
        "queue_id",
        "attempt_no",
        "status",
        "elevenlabs_conversation_id",
        "twilio_call_sid",
      ].join(","))
      .eq(column, value)
      .limit(1)
      .maybeSingle();
  } catch (cause) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause,
    });
  }
  const { data, error } = response || {};

  if (error) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause: error,
    });
  }
  return data || null;
}

async function findQueue(supabase, attempt) {
  let response;
  try {
    response = await supabase
      .from("outbound_call_queue")
      .select([
        "id",
        "company_id",
        "campaign_id",
        "outbound_contact_id",
        "contact_id",
        "status",
        "current_attempt_id",
        "attempt_count",
        "provider_attempt_count",
        "max_attempts",
      ].join(","))
      .eq("id", attempt.queue_id)
      .eq("company_id", attempt.company_id)
      .limit(1)
      .maybeSingle();
  } catch (cause) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause,
    });
  }
  const { data, error } = response || {};

  if (error) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause: error,
    });
  }
  if (!data) {
    throw new OutboundCallbackError("outbound_callback_integrity_failure");
  }
  return data;
}

function conflict(cause = null) {
  return new OutboundCallbackError("outbound_callback_conflict", {
    status: 409,
    cause,
  });
}

async function correlateAttempt(supabase, hints) {
  if (hints.hasInvalidAttemptId || hints.hasInvalidQueueId) {
    throw conflict();
  }

  const candidates = [];
  if (hints.conversationId) {
    candidates.push(await findAttempt(
      supabase,
      "elevenlabs_conversation_id",
      hints.conversationId
    ));
  }
  if (hints.callSid) {
    candidates.push(await findAttempt(
      supabase,
      "twilio_call_sid",
      hints.callSid
    ));
  }
  if (hints.attemptId) {
    candidates.push(await findAttempt(supabase, "id", hints.attemptId));
  }

  const matches = candidates.filter(Boolean);
  if (matches.length === 0) return null;

  const attempt = matches[0];
  if (matches.some((match) => match.id !== attempt.id)) throw conflict();
  if (hints.attemptId && hints.attemptId !== attempt.id) throw conflict();
  if (hints.queueId && hints.queueId !== attempt.queue_id) throw conflict();
  if (
    hints.conversationId
    && attempt.elevenlabs_conversation_id
    && hints.conversationId !== attempt.elevenlabs_conversation_id
  ) {
    throw conflict();
  }
  if (
    hints.callSid
    && attempt.twilio_call_sid
    && hints.callSid !== attempt.twilio_call_sid
  ) {
    throw conflict();
  }

  const queue = await findQueue(supabase, attempt);
  if (queue.id !== attempt.queue_id || queue.company_id !== attempt.company_id) {
    throw new OutboundCallbackError("outbound_callback_integrity_failure");
  }

  return { attempt, queue };
}

function sanitizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return null;
  return transcript.slice(0, MAX_TRANSCRIPT_TURNS).map((turn) => {
    const item = objectValue(turn);
    const message = firstString(item.message, item.content, item.text)
      .slice(0, MAX_TRANSCRIPT_MESSAGE_LENGTH);
    const role = safeLabel(item.role, "unknown", 32);
    const time = Number(item.time_in_call_secs);
    return {
      role,
      message,
      ...(Number.isFinite(time) && time >= 0
        ? { time_in_call_secs: Math.min(Math.round(time), 24 * 60 * 60) }
        : {}),
    };
  }).filter((turn) => turn.message);
}

function getTranscriptResult(hints) {
  const data = hints.data;
  const metadata = objectValue(data.metadata);
  const analysis = objectValue(data.analysis);
  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const consentRefused = transcriptHasConsentRefusal(transcript);
  const callSuccessful = typeof analysis.call_successful === "string"
    ? analysis.call_successful
    : "";

  return {
    result: consentRefused ? "consent_refused" : "completed",
    durationSeconds: boundedDuration(
      metadata.call_duration_secs
      ?? metadata.duration_secs
      ?? data.duration
    ),
    outcome: safeLabel(
      consentRefused ? "consent_refused" : callSuccessful || data.status,
      consentRefused ? "consent_refused" : "completed",
      50
    ),
    contactStatus: null,
    summary: consentRefused
      ? null
      : firstString(analysis.transcript_summary).slice(0, 10_000) || null,
    transcript: consentRefused ? null : sanitizeTranscript(transcript),
    errorCode: consentRefused ? "recording_consent_refused" : null,
    retryAt: null,
  };
}

function isNoAnswerReason(reason) {
  return reason === "busy"
    || reason === "no-answer"
    || reason === "no_answer"
    || reason === "declined";
}

function getFailureResult(hints, correlation, options) {
  const metadata = objectValue(hints.data.metadata);
  const metadataBody = objectValue(metadata.body);
  const rawReason = firstString(
    hints.data.failure_reason,
    metadataBody.error_reason,
    metadataBody.CallStatus,
    metadataBody.call_status,
    "unknown"
  );
  const reason = safeLabel(rawReason, "unknown");
  const providerAttemptNo = positiveInteger(
    correlation.queue.provider_attempt_count,
    positiveInteger(
      correlation.attempt.attempt_no,
      positiveInteger(correlation.queue.attempt_count, 1, 10),
      10
    ),
    10
  );
  const maxAttempts = positiveInteger(
    correlation.queue.max_attempts,
    1,
    10
  );
  const canRetry = providerAttemptNo < maxAttempts;
  const noAnswer = isNoAnswerReason(reason);

  if (canRetry) {
    const delayMs = Math.min(
      options.retryMaxMs,
      options.retryBaseMs * (2 ** Math.max(0, providerAttemptNo - 1))
    );
    return {
      result: "retryable_failure",
      durationSeconds: 0,
      outcome: reason,
      contactStatus: noAnswer ? "no_answer" : "error",
      summary: null,
      transcript: null,
      errorCode: reason,
      retryAt: new Date(options.now() + delayMs).toISOString(),
    };
  }

  return {
    result: noAnswer ? "no_answer" : "failed",
    durationSeconds: 0,
    outcome: reason,
    contactStatus: noAnswer ? "no_answer" : "error",
    summary: null,
    transcript: null,
    errorCode: reason,
    retryAt: null,
  };
}

function normalizeRpcResult(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return objectValue(data);
}

async function finalizeCallback(supabase, args) {
  let response;
  try {
    response = await supabase.rpc("finalize_outbound_call", args);
  } catch (cause) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause,
    });
  }
  const { data, error } = response || {};
  if (error) {
    if (error.code === "23505") throw conflict(error);
    throw new OutboundCallbackError("outbound_callback_storage_unavailable", {
      cause: error,
    });
  }
  const result = normalizeRpcResult(data);
  if (
    !result
    || result.success !== true
    || (
      result.duplicate !== undefined
      && typeof result.duplicate !== "boolean"
    )
  ) {
    throw new OutboundCallbackError("outbound_callback_storage_unavailable");
  }
  return { ...result, duplicate: result.duplicate === true };
}

/**
 * Processes a webhook only after its ElevenLabs signature has been verified by
 * the public raw-body route. Tenant identifiers from the payload are ignored:
 * ownership comes exclusively from the correlated attempt and queue rows.
 */
export async function handleOutboundCallback({
  supabase,
  body,
  rawBody,
  now = () => Date.now(),
  retryBaseMs = positiveInteger(
    process.env.OUTBOUND_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS
  ),
  retryMaxMs = positiveInteger(
    process.env.OUTBOUND_RETRY_MAX_MS,
    DEFAULT_RETRY_MAX_MS
  ),
} = {}) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new TypeError("supabase client is required");
  }

  const hints = extractOutboundCallbackHints(body);
  if (!SUPPORTED_EVENT_TYPES.has(hints.eventType)) {
    return { handled: false };
  }

  const correlation = await correlateAttempt(supabase, hints);
  if (!correlation) {
    if (
      hints.direction === "outbound"
      || hints.eventType === CALL_INITIATION_FAILURE
    ) {
      throw new OutboundCallbackError("outbound_callback_unresolved");
    }
    return { handled: false };
  }

  const safeRetryBaseMs = positiveInteger(
    retryBaseMs,
    DEFAULT_RETRY_BASE_MS,
    24 * 60 * 60_000
  );
  const safeRetryMaxMs = Math.max(
    safeRetryBaseMs,
    positiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS, 7 * 24 * 60 * 60_000)
  );
  const final = hints.eventType === POST_CALL_TRANSCRIPTION
    ? getTranscriptResult(hints)
    : getFailureResult(hints, correlation, {
        now,
        retryBaseMs: safeRetryBaseMs,
        retryMaxMs: safeRetryMaxMs,
      });
  const providerKey = hints.conversationId
    || hints.callSid
    || correlation.attempt.id;
  const eventKey = `${hints.eventType}:${providerKey}`;

  const result = await finalizeCallback(supabase, {
    p_event_key: eventKey,
    p_payload_sha256: hashOutboundCallbackPayload(rawBody, body),
    p_event_type: hints.eventType,
    p_attempt_id: correlation.attempt.id,
    p_result: final.result,
    p_duration_seconds: final.durationSeconds,
    p_outcome: final.outcome,
    p_contact_status: final.contactStatus,
    p_ai_summary: final.summary,
    p_ai_transcript: final.transcript,
    p_twilio_call_sid: hints.callSid,
    p_elevenlabs_conversation_id: hints.conversationId,
    p_error_code: final.errorCode,
    p_retry_at: final.retryAt,
  });

  return {
    handled: true,
    duplicate: result.duplicate,
    result: final.result,
  };
}

export default handleOutboundCallback;
