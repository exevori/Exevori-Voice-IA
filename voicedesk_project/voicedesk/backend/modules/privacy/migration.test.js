import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const migration = fs.readFileSync(
  new URL("../../../migrations/010_privacy_audit_log.sql", import.meta.url),
  "utf8"
);

test("migration 010 exposes privacy tables and RPCs only to service_role", () => {
  assert.match(
    migration,
    /ALTER TABLE public\.audit_log ENABLE ROW LEVEL SECURITY/
  );
  assert.match(
    migration,
    /ALTER TABLE public\.privacy_external_deletions ENABLE ROW LEVEL SECURITY/
  );
  assert.match(
    migration,
    /REVOKE ALL[\s\S]+FROM PUBLIC, anon, authenticated/
  );
  assert.match(
    migration,
    /GRANT EXECUTE[\s\S]+TO service_role/
  );
  assert.equal(
    (migration.match(/\nSECURITY INVOKER\n/g) || []).length,
    4
  );
  assert.equal(
    (migration.match(/\nSECURITY DEFINER\n/g) || []).length,
    1
  );
});

test("anonymization follows direct IDs and never infers identity from PII", () => {
  assert.match(
    migration,
    /v_crm_contact_ids := ARRAY\[v_direct_crm_contact_id\]/
  );
  assert.match(
    migration,
    /v_outbound_contact_ids := ARRAY\[p_contact_id\]/
  );
  assert.doesNotMatch(migration, /c\.phone\s*=\s*v_phone/);
  assert.doesNotMatch(migration, /c\.caller_phone\s*=\s*v_phone/);
  assert.doesNotMatch(migration, /oc\.contact_phone\s*=\s*v_phone/);
  assert.doesNotMatch(migration, /lower\(btrim\(v_email\)\)/);
});

test("anonymization reruns FK cleanup after the direct target is anonymized", () => {
  const anonymizationFunction = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.anonymize_contact_data"
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.purge_expired_privacy_data"
    )
  );
  assert.match(
    anonymizationFunction,
    /v_already_anonymized := v_anonymized_at IS NOT NULL/
  );
  assert.doesNotMatch(
    anonymizationFunction,
    /IF v_anonymized_at IS NOT NULL THEN[\s\S]*?RETURN jsonb_build_object/
  );
  assert.match(
    anonymizationFunction,
    /'already_anonymized', v_already_anonymized/
  );
});

test("retention covers conversation IDs, recording transcripts and call learning", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_elevenlabs_conversation[\s\S]*?WHERE elevenlabs_conversation_id IS NOT NULL/
  );
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS transcript_retention_days integer/
  );
  assert.match(
    migration,
    /SET transcript = NULL[\s\S]*?'call_recording_transcripts_cleared'/
  );
  const learningDelete = migration.indexOf(
    "DELETE FROM public.learning_suggestions AS ls",
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.purge_expired_privacy_data"
    )
  );
  const callDelete = migration.indexOf(
    "DELETE FROM public.calls AS c",
    learningDelete
  );
  assert.ok(learningDelete > 0);
  assert.ok(callDelete > learningDelete);
  assert.match(
    migration.slice(learningDelete, callDelete),
    /ls\.source = 'call:' \|\| linked\.call_id::text/
  );
});

test("global retention includes legacy NULL timestamps and tenant orphans", () => {
  assert.match(
    migration,
    /UPDATE public\.calls[\s\S]*?WHERE created_at IS NULL/
  );
  assert.match(
    migration,
    /UPDATE public\.outbound_calls[\s\S]*?WHERE created_at IS NULL/
  );
  assert.match(
    migration,
    /ALTER COLUMN created_at SET NOT NULL/
  );
  assert.doesNotMatch(migration, /WHERE c\.company_id IS NOT NULL/);
  assert.doesNotMatch(migration, /WHERE oc\.company_id IS NOT NULL/);
  assert.match(
    migration,
    /-- NULL is reserved for global cleanup[\s\S]*?company_id\s+uuid,/
  );
  assert.match(migration, /audit_log_orphan_retention_check/);
  assert.match(migration, /privacy_external_deletions_orphan_check/);
  assert.match(
    migration,
    /CASE WHEN c\.company_id IS NULL THEN NULL ELSE c\.contact_id END/
  );
});

test("provider failures are terminal, durable and explicitly retryable", () => {
  assert.match(
    migration,
    /status IN \('pending', 'processing', 'completed', 'retry', 'failed'\)/
  );
  assert.match(
    migration,
    /WHERE status = 'completed'/
  );
  assert.match(
    migration,
    /UPDATE public\.privacy_external_deletions AS d[\s\S]*d\.status = 'failed'/
  );
  assert.match(migration, /status = 'pending',[\s\S]*attempts = 0/);
  assert.doesNotMatch(
    migration,
    /d\.status IN \('pending', 'retry', 'failed'\)/
  );
  assert.doesNotMatch(
    migration,
    /WHERE d\.status IN \('completed', 'failed'\)/
  );
});

test("consent refusal cleanup is atomic, idempotent and contains no transcript PII", () => {
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.enqueue_consent_refusal_cleanup"
  );
  const end = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.anonymize_contact_data"
  );
  const cleanupFunction = migration.slice(start, end);

  assert.ok(start > 0);
  assert.ok(end > start);
  assert.match(
    cleanupFunction,
    /'elevenlabs',\s*'conversation'/
  );
  assert.match(cleanupFunction, /'twilio',\s*'call'/);
  assert.equal(
    (cleanupFunction.match(
      /ON CONFLICT \(provider, resource_type, external_id\) DO NOTHING/g
    ) || []).length,
    2
  );
  assert.match(
    cleanupFunction,
    /'privacy\.consent_refusal_cleanup_enqueued'/
  );
  assert.match(cleanupFunction, /'external_deletions_enqueued', v_enqueued/);
  assert.match(cleanupFunction, /IF v_enqueued > 0 THEN/);
  assert.match(cleanupFunction, /gen_random_uuid\(\)::text/);
  assert.match(cleanupFunction, /company_id IS DISTINCT FROM p_company_id/);
  assert.match(cleanupFunction, /\^CA\[0-9A-Fa-f\]\{32\}\$/);
  assert.doesNotMatch(
    cleanupFunction,
    /\b(transcript|summary|caller_phone|contact_id)\b/i
  );
  assert.match(
    cleanupFunction,
    /REVOKE ALL[\s\S]*?FROM PUBLIC, anon, authenticated/
  );
  assert.match(cleanupFunction, /GRANT EXECUTE[\s\S]*?TO service_role/);
});

test("audit_log is append-only to service_role with restricted maintenance", () => {
  assert.doesNotMatch(migration, /audit_log_service_role_delete/);
  assert.doesNotMatch(
    migration,
    /GRANT\s+SELECT,\s+INSERT,\s+DELETE\s+ON TABLE public\.audit_log/
  );
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION privacy_private\.purge_expired_audit_log/
  );
  assert.match(
    migration,
    /privacy_private\.purge_expired_audit_log[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''/
  );
  assert.match(
    migration,
    /REVOKE ALL[\s\S]*?privacy_private\.purge_expired_audit_log\(integer, uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
  );
});

test("migration transaction and function delimiters are structurally balanced", () => {
  assert.match(migration, /\nBEGIN;\n/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.equal((migration.match(/\$\$/g) || []).length % 2, 0);
  assert.equal(
    (migration.match(/CREATE OR REPLACE FUNCTION/g) || []).length,
    5
  );
});
