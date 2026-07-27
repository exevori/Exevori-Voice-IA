import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  PostCallPersistenceError,
  isPostCallTranscription,
  normalizeConversationId,
  reservePostCall,
  transcriptHasConsentRefusal,
} from "./idempotency.js";

function createSupabaseDouble({
  lookups = [{ data: null, error: null }],
  insertResult = { data: { id: "call-new" }, error: null },
} = {}) {
  const state = {
    filters: [],
    inserts: [],
    lookupCount: 0,
  };

  return {
    state,
    client: {
      from(table) {
        assert.equal(table, "calls");
        return {
          select(columns) {
            assert.equal(columns, "id");
            const filters = [];
            state.filters.push(filters);
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
                const result = lookups[state.lookupCount];
                state.lookupCount += 1;
                return result ?? { data: null, error: null };
              },
            };
            return builder;
          },
          insert(row) {
            state.inserts.push(row);
            return {
              select(columns) {
                assert.equal(columns, "id");
                return {
                  async single() {
                    return insertResult;
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

test("seul post_call_transcription est traité", () => {
  assert.equal(
    isPostCallTranscription({ type: "post_call_transcription" }),
    true
  );
  for (const payload of [
    {},
    { type: "post_call_audio" },
    { type: "call_initiation_failure" },
    { type: "POST_CALL_TRANSCRIPTION" },
  ]) {
    assert.equal(isPostCallTranscription(payload), false);
  }
});

test("conversation_id opaque est obligatoire, borné et sans caractères de contrôle", () => {
  assert.equal(normalizeConversationId("  conv_abc-123  "), "conv_abc-123");
  assert.equal(normalizeConversationId("conv/opaque.value"), "conv/opaque.value");
  for (const value of [
    undefined,
    null,
    42,
    "",
    " ",
    "conv\n123",
    "x".repeat(256),
  ]) {
    assert.equal(normalizeConversationId(value), null);
  }
});

test("le refus est détecté uniquement dans les tours client", () => {
  assert.equal(
    transcriptHasConsentRefusal([
      {
        role: "agent",
        message: "Vous pouvez refuser l'enregistrement en tout temps.",
      },
      { role: "user", message: "Je refuse l'enregistrement." },
    ]),
    true
  );
  assert.equal(
    transcriptHasConsentRefusal([
      {
        role: "assistant",
        message: "Vous pouvez refuser la transcription.",
      },
      { role: "user", message: "D'accord, continuons." },
    ]),
    false
  );
});

test("un refus nu n'est accepté qu'au premier tour client", () => {
  assert.equal(
    transcriptHasConsentRefusal([
      { role: "agent", message: "Annonce de confidentialité." },
      { role: "user", message: "Non." },
    ]),
    true
  );
  assert.equal(
    transcriptHasConsentRefusal([
      { role: "user", message: "Je cherche un rendez-vous." },
      { role: "agent", message: "Demain vous convient ?" },
      { role: "user", message: "Non." },
    ]),
    false
  );
  assert.equal(
    transcriptHasConsentRefusal([
      { role: "tool", message: "Je refuse l'enregistrement." },
      { role: "agent", message: "Je refuse l'enregistrement." },
      { role: "caller", message: "Je refuse l'enregistrement." },
    ]),
    false
  );
});

test("le handler réserve l'appel avant le CRM et renvoie 503 si la réservation échoue", () => {
  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const tenantIndex = source.indexOf("const companyId = company.company_id");
  const refusalIndex = source.indexOf(
    "if (consentRefused)"
  );
  const detectionIndex = source.indexOf(
    "const consentRefused = transcriptHasConsentRefusal(transcriptArr)"
  );
  const reconstructionIndex = source.indexOf(
    ": reconstructTranscript(transcriptArr)"
  );
  const cleanupIndex = source.indexOf(
    '"enqueue_consent_refusal_cleanup"'
  );
  const reservationIndex = source.indexOf("reservation = await reservePostCall");
  const contactIndex = source.indexOf('.from("contacts")');

  assert.ok(source.includes("if (!isPostCallTranscription(body))"));
  assert.ok(source.includes("error: \"invalid conversation_id\""));
  assert.ok(detectionIndex >= 0);
  assert.ok(reconstructionIndex > detectionIndex);
  assert.ok(refusalIndex > tenantIndex);
  assert.ok(cleanupIndex > refusalIndex);
  assert.ok(reservationIndex > refusalIndex);
  assert.ok(
    source.includes('"enqueue_consent_refusal_cleanup"')
  );
  assert.ok(source.includes("error: \"privacy cleanup unavailable\""));
  assert.ok(source.includes('external_cleanup: "queued"'));
  assert.ok(reservationIndex >= 0);
  assert.ok(contactIndex > reservationIndex);
  assert.ok(source.includes("return res.status(503).json"));
  assert.ok(source.includes("return res.status(409).json"));
});

test("le pré-check est tenant-scopé et court-circuite un doublon", async () => {
  const { client, state } = createSupabaseDouble({
    lookups: [{ data: { id: "call-existing" }, error: null }],
  });

  const result = await reservePostCall({
    supabase: client,
    companyId: "company-a",
    conversationId: "conv-1",
    callRow: { company_id: "company-a" },
  });

  assert.deepEqual(result, {
    status: "duplicate",
    callId: "call-existing",
  });
  assert.deepEqual(state.filters, [[
    ["company_id", "company-a"],
    ["elevenlabs_conversation_id", "conv-1"],
  ]]);
  assert.equal(state.inserts.length, 0);
});

test("une conversation neuve est réservée avant les effets secondaires", async () => {
  const row = {
    company_id: "company-a",
    elevenlabs_conversation_id: "conv-2",
  };
  const { client, state } = createSupabaseDouble();

  const result = await reservePostCall({
    supabase: client,
    companyId: "company-a",
    conversationId: "conv-2",
    callRow: row,
  });

  assert.deepEqual(result, { status: "inserted", callId: "call-new" });
  assert.deepEqual(state.inserts, [row]);
});

test("un conflit 23505 simultané devient doublon seulement dans le même tenant", async () => {
  const { client } = createSupabaseDouble({
    lookups: [
      { data: null, error: null },
      { data: { id: "call-concurrent" }, error: null },
    ],
    insertResult: {
      data: null,
      error: { code: "23505", message: "redacted" },
    },
  });

  const result = await reservePostCall({
    supabase: client,
    companyId: "company-a",
    conversationId: "conv-race",
    callRow: { company_id: "company-a" },
  });

  assert.deepEqual(result, {
    status: "duplicate",
    callId: "call-concurrent",
  });
});

test("un conflit unique sans ligne du tenant n'est pas présenté comme un succès", async () => {
  const { client } = createSupabaseDouble({
    lookups: [
      { data: null, error: null },
      { data: null, error: null },
    ],
    insertResult: {
      data: null,
      error: { code: "23505", message: "redacted" },
    },
  });

  const result = await reservePostCall({
    supabase: client,
    companyId: "company-a",
    conversationId: "conv-conflict",
    callRow: { company_id: "company-a" },
  });

  assert.deepEqual(result, { status: "conflict", callId: null });
});

test("une panne du pré-check ou de l'insert principal remonte une erreur", async () => {
  const lookupFailure = createSupabaseDouble({
    lookups: [{ data: null, error: { code: "08006" } }],
  });
  await assert.rejects(
    reservePostCall({
      supabase: lookupFailure.client,
      companyId: "company-a",
      conversationId: "conv-3",
      callRow: {},
    }),
    PostCallPersistenceError
  );
  assert.equal(lookupFailure.state.inserts.length, 0);

  const insertFailure = createSupabaseDouble({
    insertResult: { data: null, error: { code: "08006" } },
  });
  await assert.rejects(
    reservePostCall({
      supabase: insertFailure.client,
      companyId: "company-a",
      conversationId: "conv-4",
      callRow: {},
    }),
    PostCallPersistenceError
  );
});
