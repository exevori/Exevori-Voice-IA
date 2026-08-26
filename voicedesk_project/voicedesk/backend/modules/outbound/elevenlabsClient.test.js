import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ELEVENLABS_OUTBOUND_PATH,
  createElevenLabsClient,
  parseRetryAfter,
} from "./elevenlabsClient.js";

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    async text() {
      return payload === undefined ? "" : JSON.stringify(payload);
    },
  };
}

const validCall = {
  agentId: "agent_test",
  agentPhoneNumberId: "phone_test",
  toNumber: "+15145550123",
};

test("client sends the documented payload once and normalizes accepted IDs", async () => {
  const requests = [];
  const client = createElevenLabsClient({
    apiKey: "test-key",
    baseUrl: "https://example.test/",
    fetchImpl: async (...args) => {
      requests.push(args);
      return response(200, {
        success: true,
        message: "Call initiated",
        conversation_id: "conv_123",
        callSid: "CA123",
      });
    },
  });

  const result = await client.initiateOutboundCall({
    ...validCall,
    conversationInitiationClientData: {
      dynamic_variables: { contact_id: "contact-1" },
    },
    callRecordingEnabled: true,
    ringingTimeoutSecs: 25,
  });

  assert.deepEqual(result, {
    kind: "accepted",
    status: 200,
    conversationId: "conv_123",
    callSid: "CA123",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], `https://example.test${ELEVENLABS_OUTBOUND_PATH}`);
  assert.equal(requests[0][1].method, "POST");
  assert.equal(requests[0][1].headers["xi-api-key"], "test-key");
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    agent_id: "agent_test",
    agent_phone_number_id: "phone_test",
    to_number: "+15145550123",
    conversation_initiation_client_data: {
      dynamic_variables: { contact_id: "contact-1" },
    },
    call_recording_enabled: true,
    telephony_call_config: { ringing_timeout_secs: 25 },
  });
});

test("client never retries a network failure and marks dispatch unknown", async () => {
  let calls = 0;
  const client = createElevenLabsClient({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("socket closed");
    },
  });

  assert.deepEqual(await client.initiateOutboundCall(validCall), {
    kind: "dispatch_unknown",
    status: null,
    code: "network_error",
  });
  assert.equal(calls, 1);
});

test("timeout aborts the single request and is dispatch_unknown", async () => {
  let scheduled;
  const client = createElevenLabsClient({
    apiKey: "test-key",
    timeoutMs: 50,
    setTimer(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    clearTimer() {},
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      scheduled();
    }),
  });

  assert.deepEqual(await client.initiateOutboundCall(validCall), {
    kind: "dispatch_unknown",
    status: null,
    code: "request_timeout",
  });
});

test("429 is retryable and honors Retry-After", async () => {
  const client = createElevenLabsClient({
    apiKey: "test-key",
    now: () => Date.parse("2026-08-20T12:00:00Z"),
    fetchImpl: async () => response(
      429,
      { detail: { code: "concurrency_limit" } },
      { "retry-after": "7" }
    ),
  });

  assert.deepEqual(await client.initiateOutboundCall(validCall), {
    kind: "retryable",
    status: 429,
    code: "concurrency_limit",
    retryAfterMs: 7_000,
  });
});

test("400 et 422 invalides pour le contact sont permanents", async () => {
  for (const status of [400, 422]) {
    const client = createElevenLabsClient({
      apiKey: "test-key",
      fetchImpl: async () => response(status, { detail: { code: "invalid" } }),
    });
    assert.deepEqual(await client.initiateOutboundCall(validCall), {
      kind: "permanent_failure",
      status,
      code: "invalid",
    });
  }
});

test("auth, facturation et configuration agent ouvrent une quarantaine", async () => {
  for (const [status, scope] of [[401, "global"], [402, "global"], [403, "global"], [404, "tenant"]]) {
    const client = createElevenLabsClient({
      apiKey: "test-key",
      fetchImpl: async () => response(status, { detail: { code: "provider_config" } }),
    });
    assert.deepEqual(await client.initiateOutboundCall(validCall), {
      kind: "configuration_failure",
      status,
      code: "provider_config",
      scope,
    });
  }
});

test("408 and 5xx responses are dispatch_unknown", async () => {
  for (const [status, payload, code] of [
    [408, { code: "timeout" }, "timeout"],
    [500, { code: "internal" }, "internal"],
    [503, null, "http_503"],
  ]) {
    const client = createElevenLabsClient({
      apiKey: "test-key",
      fetchImpl: async () => response(status, payload),
    });
    assert.deepEqual(await client.initiateOutboundCall(validCall), {
      kind: "dispatch_unknown",
      status,
      code,
    });
  }
});

test("ambiguous 2xx response preserves sanitized provider correlation IDs", async () => {
  for (const [payload, conversationId, callSid] of [
    [
      { success: true, conversation_id: " conv-only " },
      "conv-only",
      null,
    ],
    [
      { success: false, conversation_id: "conv-2", callSid: " CA2 " },
      "conv-2",
      "CA2",
    ],
    [
      { success: true, conversation_id: "conv\ninvalid", callSid: "CA3" },
      null,
      "CA3",
    ],
  ]) {
    const client = createElevenLabsClient({
      apiKey: "test-key",
      fetchImpl: async () => response(200, payload),
    });
    assert.deepEqual(await client.initiateOutboundCall(validCall), {
      kind: "dispatch_unknown",
      status: 200,
      code: "ambiguous_success_response",
      conversationId,
      callSid,
    });
  }
});

test("undocumented 409 is never retried and keeps reconciliation IDs", async () => {
  const client = createElevenLabsClient({
    apiKey: "test-key",
    fetchImpl: async () => response(409, {
      code: "conflict",
      conversation_id: "conv-conflict",
      callSid: "CA-conflict",
    }),
  });

  assert.deepEqual(await client.initiateOutboundCall(validCall), {
    kind: "dispatch_unknown",
    status: 409,
    code: "conflict",
    conversationId: "conv-conflict",
    callSid: "CA-conflict",
  });
});

test("missing configuration fails before any HTTP request", async () => {
  let called = false;
  const client = createElevenLabsClient({
    apiKey: "",
    fetchImpl: async () => {
      called = true;
    },
  });

  assert.deepEqual(await client.initiateOutboundCall(validCall), {
    kind: "configuration_failure",
    status: null,
    code: "invalid_configuration",
    scope: "global",
  });
  assert.equal(called, false);
});

test("Retry-After supports both delta-seconds and HTTP dates", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  assert.equal(parseRetryAfter("2.5", now), 2_500);
  assert.equal(
    parseRetryAfter("Thu, 20 Aug 2026 12:00:09 GMT", now),
    9_000
  );
  assert.equal(parseRetryAfter("invalid", now), null);
});
