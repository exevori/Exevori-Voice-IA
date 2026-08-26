const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RESERVED_MINUTES = 10;

const ACTIVE_QUEUE_STATUSES = new Set([
  "pending",
  "claimed",
  "dispatching",
  "in_progress",
  "retry_scheduled",
  "dispatch_unknown",
  "manual_review",
]);

export class OutboundQueueError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = "OutboundQueueError";
    this.code = code;
    this.cause = cause;
  }
}

function integerBetween(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function numberBetween(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function safeCode(value, fallback) {
  const code = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, 128);
  return code || fallback;
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OutboundQueueError("invalid_transition_date");
  }
  return date.toISOString();
}

async function requireRpc(storage, name, args, errorCode) {
  const { data, error } = await storage.rpc(name, args);
  if (error) throw new OutboundQueueError(errorCode, error);
  return data;
}

export async function enqueueOutboundCampaign({
  supabase,
  campaignId,
  companyId,
  scheduledFor = new Date(),
  maxAttempts = 3,
} = {}) {
  if (!supabase?.rpc) throw new TypeError("supabase with rpc() is required");
  if (!campaignId || !companyId) {
    throw new OutboundQueueError("invalid_enqueue_scope");
  }
  const rows = await requireRpc(
    supabase,
    "enqueue_outbound_campaign",
    {
      p_campaign_id: campaignId,
      p_company_id: companyId,
      p_scheduled_for: isoDate(scheduledFor),
      p_max_attempts: integerBetween(maxAttempts, 3, 1, 10),
    },
    "outbound_enqueue_failed"
  );
  const entries = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const counts = {};
  for (const entry of entries) {
    const status = safeCode(entry?.queue_status, "unknown");
    counts[status] = (counts[status] || 0) + 1;
  }
  const activeTotal = entries.reduce(
    (total, entry) => total
      + (ACTIVE_QUEUE_STATUSES.has(String(entry?.queue_status || "")) ? 1 : 0),
    0
  );
  return {
    entries,
    counts,
    total: entries.length,
    activeTotal,
    hasActiveWork: activeTotal > 0,
  };
}

/**
 * Storage adapter for migration 012. All transitions include the tenant and,
 * where applicable, the worker claim to make stale workers harmless.
 */
export function createOutboundQueue({
  supabase,
  workerId,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  reservedMinutes = process.env.OUTBOUND_RESERVED_MINUTES,
  now = () => new Date(),
} = {}) {
  if (!supabase || typeof supabase.rpc !== "function") {
    throw new TypeError("supabase with rpc() is required");
  }
  if (!workerId || typeof workerId !== "string") {
    throw new TypeError("workerId is required");
  }

  const safeLeaseSeconds = integerBetween(
    leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    30,
    900
  );
  const safeReservedMinutes = numberBetween(
    reservedMinutes,
    DEFAULT_RESERVED_MINUTES,
    1,
    30
  );

  async function claimNext() {
    const data = await requireRpc(
      supabase,
      "claim_next_outbound_call",
      {
        p_worker_id: workerId,
        p_lease_seconds: safeLeaseSeconds,
        p_reserved_minutes: safeReservedMinutes,
      },
      "outbound_claim_failed"
    );
    return firstRow(data);
  }

  async function beginAttempt(job, localCallDate, nextAllowedAt = null) {
    const data = await requireRpc(
      supabase,
      "begin_outbound_call_attempt",
      {
        p_queue_id: job.id,
        p_worker_id: workerId,
        p_local_call_date: localCallDate || null,
        p_next_allowed_at: nextAllowedAt ? isoDate(nextAllowedAt) : null,
      },
      "outbound_attempt_begin_failed"
    );
    const attempt = firstRow(data);
    if (!attempt) throw new OutboundQueueError("outbound_attempt_not_created");
    return attempt;
  }

  async function markDispatched(attempt, result, providerTimeoutSeconds = 7_200) {
    const data = await requireRpc(
      supabase,
      "mark_outbound_call_dispatched",
      {
        p_attempt_id: attempt.id,
        p_worker_id: workerId,
        p_elevenlabs_conversation_id: result.conversationId,
        p_twilio_call_sid: result.callSid,
        p_provider_timeout_seconds: integerBetween(
          providerTimeoutSeconds,
          7_200,
          60,
          14_400
        ),
      },
      "outbound_dispatch_persist_failed"
    );
    return data;
  }

  async function recoverStale(batchSize = 100) {
    return requireRpc(
      supabase,
      "release_stale_outbound_claims",
      { p_batch_size: integerBetween(batchSize, 100, 1, 1_000) },
      "outbound_recovery_failed"
    );
  }

  async function transitionClaimed(job, action, code, retryAt = null) {
    return requireRpc(
      supabase,
      "transition_claimed_outbound_call",
      {
        p_queue_id: job.id,
        p_company_id: job.company_id,
        p_worker_id: workerId,
        p_action: action,
        p_error_code: safeCode(code, `preflight_${action}`),
        p_retry_at: retryAt ? isoDate(retryAt) : null,
      },
      "outbound_queue_transition_failed"
    );
  }

  async function defer(job, { code, retryAt }) {
    return transitionClaimed(job, "defer", code || "preflight_retry", retryAt);
  }

  async function block(job, code) {
    return transitionClaimed(job, "block", code || "preflight_blocked");
  }

  async function failDispatch(
    attempt,
    failureClass,
    code,
    retryAt = null,
    providerHints = {}
  ) {
    return requireRpc(
      supabase,
      "fail_outbound_call_dispatch",
      {
        p_attempt_id: attempt.id,
        p_worker_id: workerId,
        p_failure_class: failureClass,
        p_error_code: safeCode(code, "provider_dispatch_failed"),
        p_retry_at: retryAt ? isoDate(retryAt) : null,
        p_elevenlabs_conversation_id:
          providerHints?.conversationId || null,
        p_twilio_call_sid: providerHints?.callSid || null,
      },
      "outbound_dispatch_failure_persist_failed"
    );
  }

  async function markRetryable(attempt, { code, retryAt }) {
    return failDispatch(
      attempt,
      "retryable_failure",
      code || "provider_rate_limited",
      retryAt
    );
  }

  async function markConfigurationFailure(attempt, { code, retryAt }) {
    return requireRpc(
      supabase,
      "quarantine_outbound_provider_failure",
      {
        p_attempt_id: attempt.id,
        p_worker_id: workerId,
        p_error_code: safeCode(code, "provider_configuration_failure"),
        p_retry_at: isoDate(retryAt),
      },
      "outbound_configuration_failure_persist_failed"
    );
  }

  async function markDispatchUnknown(attempt, code, providerHints = {}) {
    return failDispatch(
      attempt,
      "dispatch_unknown",
      code || "provider_dispatch_unknown",
      null,
      providerHints
    );
  }

  async function markPermanentFailure(attempt, code) {
    return failDispatch(
      attempt,
      "failed",
      code || "provider_rejected"
    );
  }

  return {
    workerId,
    claimNext,
    beginAttempt,
    markDispatched,
    recoverStale,
    defer,
    block,
    markRetryable,
    markConfigurationFailure,
    markDispatchUnknown,
    markPermanentFailure,
  };
}

export default createOutboundQueue;
