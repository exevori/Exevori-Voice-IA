import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "local-test-service-role";

const {
  buildPostCallEvent,
  normalizeE164Phone,
  normalizeTwilioCallSid,
  reconstructTranscript,
  verifyElevenLabsSignature,
} = await import("./index.js");

function sign(rawBody, timestamp, secret) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v0=${signature}`;
}

test("la vérification locale accepte seulement un HMAC frais au format strict", () => {
  const rawBody = '{"type":"post_call_transcription"}';
  const secret = "test-webhook-secret";
  const now = Math.floor(Date.now() / 1_000);

  assert.equal(
    verifyElevenLabsSignature(rawBody, sign(rawBody, now, secret), secret),
    "ok"
  );
  assert.equal(
    verifyElevenLabsSignature(rawBody, sign(rawBody, now - 301, secret), secret),
    "stale"
  );
  assert.equal(
    verifyElevenLabsSignature(rawBody, "t=1e9,v0=" + "a".repeat(64), secret),
    "invalid_format"
  );
  assert.equal(
    verifyElevenLabsSignature(rawBody, `t=${now},v0=xyz`, secret),
    "invalid_format"
  );
  assert.equal(
    verifyElevenLabsSignature(rawBody, sign(rawBody + "x", now, secret), secret),
    "bad_signature"
  );
});

test("les identifiants fournisseur sont normalisés sans inventer de valeur", () => {
  assert.equal(normalizeE164Phone(" +1 (514) 555-0123 "), "+15145550123");
  assert.equal(normalizeE164Phone("0033 1 42 68 53 00"), "+33142685300");
  assert.equal(normalizeE164Phone("514-555-0123"), null);
  assert.equal(
    normalizeTwilioCallSid(`CA${"a".repeat(32)}`),
    `CA${"a".repeat(32)}`
  );
  assert.equal(normalizeTwilioCallSid("conversation-not-a-call-sid"), null);
});

test("le transcript ignore les rôles système/outils et l'événement est borné", () => {
  const transcript = reconstructTranscript([
    { role: "system", message: "secret interne" },
    { role: "tool", message: "sortie outil" },
    { role: "agent", message: "Bonjour" },
    { role: "user", message: "Je veux réserver." },
  ]);
  assert.equal(transcript.includes("secret interne"), false);
  assert.equal(transcript.includes("sortie outil"), false);
  assert.match(transcript, /Léa: Bonjour/);
  assert.match(transcript, /Client: Je veux réserver/);

  const event = buildPostCallEvent({
    companyId: "company-1",
    conversationId: "conversation-1",
    twilioCallSid: "invalid",
    callerNumber: "+1 (514) 555-0123",
    durationSeconds: 100_000,
    transcriptText: `texte${"x".repeat(210_000)}`,
    providerSummary: "s".repeat(5_000),
    language: "fr-CA",
    appointmentRequested: true,
  });
  assert.equal(event.twilioCallSid, null);
  assert.equal(event.callerPhone, "+15145550123");
  assert.equal(event.durationSeconds, 86_400);
  assert.equal(event.transcriptText.length, 200_000);
  assert.equal(event.providerSummary.length, 4_000);
  assert.equal(event.appointmentRequested, true);
});
