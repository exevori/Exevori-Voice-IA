import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import {
  OutboundCallbackError,
  extractOutboundCallbackHints,
  handleOutboundCallback,
} from "./callback.js";

const ATTEMPT_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUEUE_A = "22222222-2222-4222-8222-222222222222";
const QUEUE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_A = "33333333-3333-4333-8333-333333333333";
const COMPANY_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function attempt({
  id = ATTEMPT_A,
  companyId = COMPANY_A,
  queueId = QUEUE_A,
  attemptNo = 1,
  conversationId = "conv-a",
  callSid = "CA-a",
} = {}) {
  return {
    id,
    company_id: companyId,
    queue_id: queueId,
    attempt_no: attemptNo,
    status: "in_progress",
    elevenlabs_conversation_id: conversationId,
    twilio_call_sid: callSid,
  };
}

function queue({
  id = QUEUE_A,
  companyId = COMPANY_A,
  currentAttemptId = ATTEMPT_A,
  attemptCount = 1,
  providerAttemptCount = attemptCount,
  maxAttempts = 3,
} = {}) {
  return {
    id,
    company_id: companyId,
    campaign_id: "44444444-4444-4444-8444-444444444444",
    outbound_contact_id: "55555555-5555-4555-8555-555555555555",
    contact_id: "66666666-6666-4666-8666-666666666666",
    status: "in_progress",
    current_attempt_id: currentAttemptId,
    attempt_count: attemptCount,
    provider_attempt_count: providerAttemptCount,
    max_attempts: maxAttempts,
  };
}

function createSupabaseDouble({
  attemptRows = [attempt()],
  queueRows = [queue()],
  lookupError = null,
  queueError = null,
  rpcResults = [{ data: { success: true, duplicate: false }, error: null }],
} = {}) {
  const state = {
    lookups: [],
    rpcCalls: [],
  };

  function rowMatches(row, filters) {
    return filters.every(([column, value]) => row?.[column] === value);
  }

  return {
    state,
    client: {
      from(table) {
        assert.ok([
          "outbound_call_attempts",
          "outbound_call_queue",
        ].includes(table));
        return {
          select(columns) {
            const filters = [];
            const builder = {
              eq(column, value) {
                filters.push([column, value]);
                return builder;
              },
              limit(value) {
                assert.equal(value, 1);
                return builder;
              },
              async maybeSingle() {
                state.lookups.push({ table, columns, filters: [...filters] });
                const error = table === "outbound_call_attempts"
                  ? lookupError
                  : queueError;
                if (error) return { data: null, error };
                const rows = table === "outbound_call_attempts"
                  ? attemptRows
                  : queueRows;
                return {
                  data: rows.find((row) => rowMatches(row, filters)) || null,
                  error: null,
                };
              },
            };
            return builder;
          },
        };
      },
      async rpc(name, args) {
        state.rpcCalls.push({ name, args });
        return rpcResults[state.rpcCalls.length - 1]
          || rpcResults[rpcResults.length - 1];
      },
    },
  };
}

function transcriptionPayload({
  conversationId = "conv-a",
  callSid = "CA-a",
  direction = "outbound",
  attemptId = ATTEMPT_A,
  queueId = QUEUE_A,
  transcript = [
    { role: "agent", message: "Bonjour", time_in_call_secs: 0 },
    { role: "user", message: "Je suis intéressé", time_in_call_secs: 2 },
  ],
} = {}) {
  return {
    type: "post_call_transcription",
    event_timestamp: 1_759_931_652,
    data: {
      conversation_id: conversationId,
      status: "done",
      transcript,
      analysis: {
        transcript_summary: "Le contact est intéressé.",
        call_successful: "success",
      },
      metadata: {
        call_duration_secs: 42,
        phone_call: { call_sid: callSid },
      },
      conversation_initiation_client_data: {
        dynamic_variables: {
          voicedesk_direction: direction,
          attempt_id: attemptId,
          queue_id: queueId,
          company_id: COMPANY_B,
        },
      },
    },
  };
}

function failurePayload({
  conversationId = "conv-a",
  callSid = "CA-a",
  reason = "busy",
} = {}) {
  return {
    type: "call_initiation_failure",
    event_timestamp: 1_759_931_652,
    data: {
      agent_id: "agent-a",
      conversation_id: conversationId,
      failure_reason: reason,
      metadata: {
        type: "twilio",
        body: { CallSid: callSid, Direction: "outbound-api" },
      },
    },
  };
}

async function rejection(promise, { code, status }) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OutboundCallbackError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("les indices officiels sont extraits sans exposer company_id", () => {
  const hints = extractOutboundCallbackHints(transcriptionPayload());
  assert.equal(hints.eventType, "post_call_transcription");
  assert.equal(hints.direction, "outbound");
  assert.equal(hints.conversationId, "conv-a");
  assert.equal(hints.callSid, "CA-a");
  assert.equal(hints.attemptId, ATTEMPT_A);
  assert.equal(hints.queueId, QUEUE_A);
  assert.equal(Object.hasOwn(hints, "companyId"), false);
});

test("un type non pris en charge est ignoré sans accès base", async () => {
  const { client, state } = createSupabaseDouble();
  const result = await handleOutboundCallback({
    supabase: client,
    body: { type: "post_call_audio", data: { conversation_id: "conv-a" } },
  });
  assert.deepEqual(result, { handled: false });
  assert.equal(state.lookups.length, 0);
  assert.equal(state.rpcCalls.length, 0);
});

test("une transcription entrante sans tentative sortante est ignorée", async () => {
  const { client, state } = createSupabaseDouble({ attemptRows: [] });
  const body = transcriptionPayload({
    conversationId: "conv-inbound",
    callSid: "CA-inbound",
    direction: "inbound",
    attemptId: "",
    queueId: "",
  });

  const result = await handleOutboundCallback({ supabase: client, body });

  assert.deepEqual(result, { handled: false });
  assert.equal(state.rpcCalls.length, 0);
});

test("un callback marqué outbound mais non corrélé échoue fermé en 503", async () => {
  const { client } = createSupabaseDouble({ attemptRows: [] });
  await rejection(
    handleOutboundCallback({
      supabase: client,
      body: transcriptionPayload({ attemptId: "", queueId: "" }),
    }),
    { code: "outbound_callback_unresolved", status: 503 }
  );
});

test("un échec d'initiation officiel non corrélé échoue également fermé", async () => {
  const { client } = createSupabaseDouble({ attemptRows: [] });
  await rejection(
    handleOutboundCallback({ supabase: client, body: failurePayload() }),
    { code: "outbound_callback_unresolved", status: 503 }
  );
});

test("la finalisation réussie est atomique et ne fait jamais confiance au tenant du payload", async () => {
  const { client, state } = createSupabaseDouble();
  const body = transcriptionPayload();
  const rawBody = JSON.stringify(body);

  const result = await handleOutboundCallback({
    supabase: client,
    body,
    rawBody,
  });

  assert.deepEqual(result, {
    handled: true,
    duplicate: false,
    result: "completed",
  });
  assert.equal(state.rpcCalls.length, 1);
  const call = state.rpcCalls[0];
  assert.equal(call.name, "finalize_outbound_call");
  assert.equal(call.args.p_attempt_id, ATTEMPT_A);
  assert.equal(
    call.args.p_event_key,
    "post_call_transcription:conv-a"
  );
  assert.equal(
    call.args.p_payload_sha256,
    crypto.createHash("sha256").update(rawBody).digest("hex")
  );
  assert.equal(call.args.p_result, "completed");
  assert.equal(call.args.p_duration_seconds, 42);
  assert.equal(call.args.p_ai_summary, "Le contact est intéressé.");
  assert.deepEqual(call.args.p_ai_transcript, [
    { role: "agent", message: "Bonjour", time_in_call_secs: 0 },
    { role: "user", message: "Je suis intéressé", time_in_call_secs: 2 },
  ]);
  assert.equal(Object.hasOwn(call.args, "p_company_id"), false);
  assert.equal(Object.hasOwn(call.args, "payload"), false);
  assert.deepEqual(
    state.lookups.at(-1).filters,
    [["id", QUEUE_A], ["company_id", COMPANY_A]]
  );
});

test("une seconde livraison identique est rapportée comme doublon durable", async () => {
  const { client, state } = createSupabaseDouble({
    rpcResults: [
      { data: { success: true, duplicate: false }, error: null },
      { data: { success: true, duplicate: true }, error: null },
    ],
  });
  const body = transcriptionPayload();
  const rawBody = JSON.stringify(body);

  const first = await handleOutboundCallback({ supabase: client, body, rawBody });
  const second = await handleOutboundCallback({ supabase: client, body, rawBody });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(state.rpcCalls.length, 2);
  assert.equal(
    state.rpcCalls[0].args.p_payload_sha256,
    state.rpcCalls[1].args.p_payload_sha256
  );
  assert.equal(
    state.rpcCalls[0].args.p_event_key,
    state.rpcCalls[1].args.p_event_key
  );
});

test("un callback tardif finalisé par le RPC reste un succès non doublon", async () => {
  const { client } = createSupabaseDouble({
    rpcResults: [{
      data: {
        success: true,
        stale_attempt: true,
        status: "in_progress",
      },
      error: null,
    }],
  });

  const result = await handleOutboundCallback({
    supabase: client,
    body: transcriptionPayload(),
  });

  assert.deepEqual(result, {
    handled: true,
    duplicate: false,
    result: "completed",
  });
});

test("des identifiants fournisseur qui pointent sur deux tentatives sont refusés", async () => {
  const firstAttempt = attempt({ callSid: "CA-first" });
  const secondAttempt = attempt({
    id: ATTEMPT_B,
    companyId: COMPANY_B,
    queueId: QUEUE_B,
    conversationId: "conv-b",
    callSid: "CA-a",
  });
  const { client, state } = createSupabaseDouble({
    attemptRows: [firstAttempt, secondAttempt],
  });

  await rejection(
    handleOutboundCallback({
      supabase: client,
      body: transcriptionPayload({ attemptId: "", queueId: "" }),
    }),
    { code: "outbound_callback_conflict", status: 409 }
  );
  assert.equal(state.rpcCalls.length, 0);
});

test("une erreur de lecture base échoue fermé avec un code 503 structuré", async () => {
  const { client } = createSupabaseDouble({
    lookupError: { code: "08006", message: "not exposed" },
  });
  await rejection(
    handleOutboundCallback({ supabase: client, body: failurePayload() }),
    { code: "outbound_callback_storage_unavailable", status: 503 }
  );
});

test("une exception réseau Supabase reste une erreur structurée 503", async () => {
  await rejection(
    handleOutboundCallback({
      supabase: {
        from() {
          throw new Error("network detail");
        },
      },
      body: failurePayload(),
    }),
    { code: "outbound_callback_storage_unavailable", status: 503 }
  );

  const { client } = createSupabaseDouble();
  client.rpc = async () => {
    throw new Error("network detail");
  };
  await rejection(
    handleOutboundCallback({
      supabase: client,
      body: transcriptionPayload(),
    }),
    { code: "outbound_callback_storage_unavailable", status: 503 }
  );
});

test("une collision durable de clé/hash est exposée comme conflit sans fuite SQL", async () => {
  const { client } = createSupabaseDouble({
    rpcResults: [{
      data: null,
      error: { code: "23505", message: "sensitive database detail" },
    }],
  });
  await rejection(
    handleOutboundCallback({
      supabase: client,
      body: transcriptionPayload(),
      rawBody: "different-payload",
    }),
    { code: "outbound_callback_conflict", status: 409 }
  );
});

test("busy est replanifié avec backoff exponentiel avant la dernière tentative", async () => {
  const { client, state } = createSupabaseDouble();
  const now = Date.parse("2026-08-20T17:00:00.000Z");

  const result = await handleOutboundCallback({
    supabase: client,
    body: failurePayload({ reason: "busy" }),
    now: () => now,
    retryBaseMs: 30_000,
    retryMaxMs: 900_000,
  });

  assert.equal(result.result, "retryable_failure");
  const args = state.rpcCalls[0].args;
  assert.equal(args.p_result, "retryable_failure");
  assert.equal(args.p_contact_status, "no_answer");
  assert.equal(args.p_error_code, "busy");
  assert.equal(args.p_retry_at, "2026-08-20T17:00:30.000Z");
  assert.equal(args.p_ai_transcript, null);
  assert.equal(args.p_ai_summary, null);
});

test("no-answer devient terminal quand le nombre maximal d'essais est atteint", async () => {
  const finalAttempt = attempt({ attemptNo: 3 });
  const finalQueue = queue({ attemptCount: 3, maxAttempts: 3 });
  const { client, state } = createSupabaseDouble({
    attemptRows: [finalAttempt],
    queueRows: [finalQueue],
  });

  const result = await handleOutboundCallback({
    supabase: client,
    body: failurePayload({ reason: "no-answer" }),
  });

  assert.equal(result.result, "no_answer");
  assert.equal(state.rpcCalls[0].args.p_result, "no_answer");
  assert.equal(state.rpcCalls[0].args.p_retry_at, null);
  assert.equal(state.rpcCalls[0].args.p_contact_status, "no_answer");
});

test("une reprise de configuration ne consomme pas une tentative fournisseur", async () => {
  const recoveredAttempt = attempt({ attemptNo: 3 });
  const recoveredQueue = queue({
    attemptCount: 3,
    providerAttemptCount: 1,
    maxAttempts: 3,
  });
  const { client, state } = createSupabaseDouble({
    attemptRows: [recoveredAttempt],
    queueRows: [recoveredQueue],
  });

  const result = await handleOutboundCallback({
    supabase: client,
    body: failurePayload({ reason: "busy" }),
    retryBaseMs: 30_000,
  });

  assert.equal(result.result, "retryable_failure");
  assert.ok(state.rpcCalls[0].args.p_retry_at);
});

test("un refus d'enregistrement ne persiste ni transcript ni résumé", async () => {
  const { client, state } = createSupabaseDouble();
  const body = transcriptionPayload({
    transcript: [
      { role: "agent", message: "Cet appel peut être enregistré." },
      { role: "user", message: "Je refuse l'enregistrement." },
    ],
  });

  await handleOutboundCallback({ supabase: client, body });

  const args = state.rpcCalls[0].args;
  assert.equal(args.p_result, "consent_refused");
  assert.equal(args.p_outcome, "consent_refused");
  assert.equal(args.p_ai_transcript, null);
  assert.equal(args.p_ai_summary, null);
  assert.equal(args.p_error_code, "recording_consent_refused");
});

test("la migration finalise un refus avec nettoyage atomique et sans ligne d'appel", () => {
  const migration = fs.readFileSync(
    new URL("../../../migrations/012_outbound_rebuild.sql", import.meta.url),
    "utf8"
  );
  const branchStart = migration.indexOf("IF p_result = 'consent_refused' THEN");
  assert.ok(branchStart >= 0);
  const branch = migration.slice(branchStart, branchStart + 5_000);

  assert.match(branch, /enqueue_consent_refusal_cleanup/);
  assert.match(branch, /DELETE FROM public\.outbound_calls/);
  assert.match(branch, /elevenlabs_conversation_id = NULL/);
  assert.match(branch, /twilio_call_sid = NULL/);
  assert.match(branch, /status = 'cancelled'/);
  assert.match(branch, /contact_phone_e164 = NULL/);
  assert.match(branch, /'consent_refused', true/);
});
