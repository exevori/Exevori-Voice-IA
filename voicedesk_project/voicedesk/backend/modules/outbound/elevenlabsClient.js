const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_TIMEOUT_MS = 15_000;

export const ELEVENLABS_OUTBOUND_PATH = "/v1/convai/twilio/outbound-call";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function providerErrorCode(payload) {
  const detail = payload?.detail;
  if (typeof detail === "object" && detail && !Array.isArray(detail)) {
    return detail.code || detail.status || null;
  }
  return payload?.code || null;
}

function providerId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Minimal client for ElevenLabs' official Twilio outbound-call endpoint.
 *
 * It deliberately performs exactly one HTTP request. Retrying a timed-out or
 * 5xx request here could create a duplicate telephone call because the
 * endpoint does not document an idempotency key.
 */
export function createElevenLabsClient({
  apiKey = process.env.ELEVENLABS_API_KEY,
  baseUrl = process.env.ELEVENLABS_API_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = positiveInteger(
    process.env.ELEVENLABS_OUTBOUND_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  ),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  async function initiateOutboundCall({
    agentId,
    agentPhoneNumberId,
    toNumber,
    conversationInitiationClientData,
    callRecordingEnabled,
    ringingTimeoutSecs,
  } = {}) {
    if (!apiKey || !agentId || !agentPhoneNumberId || !toNumber) {
      return {
        kind: "configuration_failure",
        status: null,
        code: "invalid_configuration",
        scope: !apiKey ? "global" : "tenant",
      };
    }

    const body = {
      agent_id: agentId,
      agent_phone_number_id: agentPhoneNumberId,
      to_number: toNumber,
    };
    if (conversationInitiationClientData !== undefined) {
      body.conversation_initiation_client_data =
        conversationInitiationClientData;
    }
    if (callRecordingEnabled !== undefined) {
      body.call_recording_enabled = Boolean(callRecordingEnabled);
    }
    if (ringingTimeoutSecs !== undefined) {
      body.telephony_call_config = {
        ringing_timeout_secs: positiveInteger(ringingTimeoutSecs, 30),
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
    timer?.unref?.();

    let response;
    try {
      response = await fetchImpl(
        `${String(baseUrl).replace(/\/$/, "")}${ELEVENLABS_OUTBOUND_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
    } catch (error) {
      return {
        kind: "dispatch_unknown",
        status: null,
        code: timedOut || error?.name === "AbortError"
          ? "request_timeout"
          : "network_error",
      };
    } finally {
      clearTimer(timer);
    }

    let payload = null;
    try {
      payload = parseJson(await response.text());
    } catch {
      // Reading a response that may already have dispatched the call failed.
      return {
        kind: "dispatch_unknown",
        status: response.status || null,
        code: "response_read_error",
      };
    }

    const conversationId = providerId(payload?.conversation_id);
    const callSid = providerId(payload?.callSid);

    if (response.ok) {
      if (payload?.success === true && conversationId && callSid) {
        return {
          kind: "accepted",
          status: response.status,
          conversationId,
          callSid,
        };
      }

      return {
        kind: "dispatch_unknown",
        status: response.status,
        code: "ambiguous_success_response",
        conversationId,
        callSid,
      };
    }

    const code = providerErrorCode(payload) || `http_${response.status}`;
    if (response.status === 429) {
      return {
        kind: "retryable",
        status: response.status,
        code,
        retryAfterMs: parseRetryAfter(
          response.headers?.get?.("retry-after"),
          now()
        ),
      };
    }

    if (response.status === 408 || response.status >= 500) {
      return {
        kind: "dispatch_unknown",
        status: response.status,
        code,
        ...(conversationId ? { conversationId } : {}),
        ...(callSid ? { callSid } : {}),
      };
    }

    if ([401, 402, 403].includes(response.status)) {
      return {
        kind: "configuration_failure",
        status: response.status,
        code,
        scope: "global",
      };
    }

    if (response.status === 404) {
      return {
        kind: "configuration_failure",
        status: response.status,
        code,
        scope: "tenant",
      };
    }

    if (response.status === 409) {
      return {
        // ElevenLabs does not document a 409 contract for this endpoint. It
        // may describe a call that was accepted before a conflicting reply,
        // so retrying could dial the same person twice.
        kind: "dispatch_unknown",
        status: response.status,
        code,
        ...(conversationId ? { conversationId } : {}),
        ...(callSid ? { callSid } : {}),
      };
    }

    return {
      kind: "permanent_failure",
      status: response.status,
      code,
    };
  }

  return { initiateOutboundCall };
}

export default createElevenLabsClient;
