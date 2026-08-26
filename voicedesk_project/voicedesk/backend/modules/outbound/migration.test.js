import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const sql = fs.readFileSync(
  new URL("../../../migrations/012_outbound_rebuild.sql", import.meta.url),
  "utf8"
);

const PUBLIC_FUNCTIONS = [
  "enqueue_outbound_campaign",
  "claim_next_outbound_call",
  "transition_claimed_outbound_call",
  "begin_outbound_call_attempt",
  "mark_outbound_call_dispatched",
  "fail_outbound_call_dispatch",
  "quarantine_outbound_provider_failure",
  "release_stale_outbound_claims",
  "resolve_outbound_manual_review",
  "finalize_outbound_call",
  "enqueue_post_call_processing",
  "enqueue_consent_refusal_cleanup",
  "claim_post_call_processing_jobs",
  "complete_post_call_processing_job",
  "fail_post_call_processing_job",
  "purge_expired_post_call_processing_jobs",
  "purge_expired_outbound_queue_metadata",
];

test("la migration 012 est transactionnelle et sans SECURITY DEFINER", () => {
  assert.match(sql, /^--[^\n]*\n(?:--[^\n]*\n)*\s*BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
  for (const name of PUBLIC_FUNCTIONS) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = sql.indexOf("AS $$", start);
    assert.ok(start > 0 && end > start, `${name} doit exister`);
    const declaration = sql.slice(start, end);
    assert.match(declaration, /SECURITY INVOKER/);
    assert.match(declaration, /SET search_path = ''/);
  }
});

test("queue, concurrence et garde pré-appel restent atomiques", () => {
  assert.match(sql, /FOR UPDATE OF campaign, q, subscription SKIP LOCKED/);
  assert.doesNotMatch(
    sql,
    /connected_at\s*=\s*COALESCE\(attempt\.connected_at,\s*now\(\)\)/i
  );
  assert.match(sql, /uq_outbound_queue_contact_inflight/);
  assert.match(sql, /c\.call_consent IS TRUE/);
  assert.match(sql, /FROM public\.dnc_list AS d/);
  assert.match(sql, /subscription_quota_exhausted/);
  assert.match(sql, /daily_call_limit_reached/);
  assert.match(sql, /p_next_allowed_at timestamptz DEFAULT NULL/);
  assert.equal(
    (sql.match(/begin_outbound_call_attempt\(uuid, text, date, timestamptz\)/g) || []).length,
    2
  );
});

test("les tables opérationnelles sont RLS et service_role only", () => {
  for (const table of [
    "voice_call_settings",
    "outbound_call_queue",
    "outbound_call_attempts",
    "outbound_callback_events",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.%I[\s\S]*PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*TO service_role/);
  assert.match(sql, /CREATE POLICY tenant_isolation/);
  assert.match(sql, /CREATE POLICY service_role_bypass/);
});

test("chaque nouvelle FK utilisée par les cascades dispose d'un index", () => {
  for (const indexName of [
    "idx_outbound_campaigns_phone_number_fk",
    "idx_outbound_queue_campaign_fk",
    "idx_outbound_queue_outbound_contact_fk",
    "idx_outbound_queue_contact_fk",
    "idx_outbound_queue_phone_number_fk",
    "idx_outbound_callback_queue_fk",
    "idx_outbound_callback_company_fk",
    "idx_outbound_calls_campaign_fk",
    "idx_outbound_calls_outbound_contact_fk",
    "idx_post_call_jobs_company_fk",
    "idx_post_call_jobs_contact_fk",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}`));
  }
});

test("callbacks et suppression privée sont idempotents et tenant-safe", () => {
  assert.match(sql, /UNIQUE \(provider, event_key\)/);
  assert.match(sql, /ON CONFLICT \(provider, event_key\) DO NOTHING/);
  assert.match(sql, /provider resource tenant conflict/);
  assert.match(sql, /enqueue_consent_refusal_cleanup/);
  assert.match(sql, /p_result = 'consent_refused'/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
});

test("manual-review quarantine cannot redial without an explicit audited resolution", () => {
  assert.match(sql, /'retry_scheduled', 'dispatch_unknown', 'manual_review'/);
  assert.match(sql, /status = 'manual_review'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.resolve_outbound_manual_review/);
  assert.match(sql, /outbound\.manual_review_resolved/);
  assert.match(sql, /confirmed_not_dispatched/);
  assert.match(sql, /provider_attempt_count = GREATEST\(q\.provider_attempt_count - 1, 0\)/);
  assert.match(sql, /profile\.role = 'super_admin'/);
});

test("trial, quota and provider attempt guards are strict", () => {
  assert.match(
    sql,
    /payment_status <> 'trial'[\s\S]*?trial_ends_at IS NOT NULL[\s\S]*?trial_ends_at > now\(\)/
  );
  assert.match(
    sql,
    /payment_status = 'trial'[\s\S]*?trial_ends_at IS NULL[\s\S]*?trial_ends_at <= now\(\)/
  );
  assert.match(sql, /p_reserved_minutes numeric DEFAULT 10/);
  assert.match(sql, /reserved_minutes must be between 1 and 30/);
  assert.match(sql, /provider_attempt_count/);
  assert.match(sql, /configuration_failure/);
  assert.match(sql, /provider_timeout_seconds must be between 60 and 14400/);
});

test("provider identifiers and privacy cleanup remain durable before deletion", () => {
  assert.match(sql, /BEFORE DELETE ON public\.outbound_calls/);
  assert.match(sql, /BEFORE DELETE ON public\.outbound_call_attempts/);
  assert.match(sql, /enqueue_outbound_provider_resources/);
  assert.match(sql, /'elevenlabs'[\s\S]*?'conversation'/);
  assert.match(sql, /'twilio'[\s\S]*?'call'/);
  assert.match(sql, /provider dispatch identity conflict/);
  assert.match(sql, /current_attempt_id IS DISTINCT FROM v_attempt\.id/);
});

test("post-call jobs are private, leased, idempotent and scrub transient PII", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.post_call_processing_jobs/);
  assert.match(sql, /ALTER TABLE public\.post_call_processing_jobs ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_post_call_jobs_conversation/);
  assert.match(sql, /FOREIGN KEY \(post_call_job_id, company_id\)/);
  assert.match(sql, /ON DELETE SET NULL \(post_call_job_id\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.enqueue_post_call_processing/);
  assert.match(sql, /'error_code', 'conversation_conflict'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_post_call_processing_jobs/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.complete_post_call_processing_job/);
  assert.match(sql, /post_call_processed_at = now\(\)/);
  assert.match(sql, /payload_scrubbed_at = now\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fail_post_call_processing_job/);
  assert.match(sql, /post-call retry_at must be within 24 hours/);
  assert.match(sql, /post_call_retention_expired/);
  assert.match(sql, /job\.created_at < now\(\) - make_interval\(days => job\.retention_days\)/);

  const completion = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_post_call_processing_job"),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.fail_post_call_processing_job")
  );
  assert.match(completion, /p_create_appointment[\s\S]*p_appointment_date IS NOT NULL/);
  assert.doesNotMatch(completion, /COALESCE\(p_appointment_date, current_date\)/);
  assert.match(completion, /Demande de rendez-vous a confirmer/);
});

test("chaque nouvelle entreprise reçoit automatiquement ses réglages vocaux", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION outbound_private\.ensure_voice_call_settings/);
  assert.match(sql, /CREATE TRIGGER companies_ensure_voice_call_settings/);
  assert.match(sql, /AFTER INSERT ON public\.companies/);
  assert.match(sql, /INSERT INTO public\.voice_call_settings \(company_id\)[\s\S]*VALUES \(NEW\.id\)/);
  assert.match(sql, /ON FUNCTION outbound_private\.ensure_voice_call_settings\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /ON FUNCTION outbound_private\.ensure_voice_call_settings\(\)[\s\S]*TO service_role/);
});

test("consent refusal serializes ingestion and removes raced local effects", () => {
  assert.equal(
    (sql.match(/hashtextextended\('post_call:' \|\| v_conversation_id, 0\)/g) || []).length,
    2
  );
  const override = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.enqueue_consent_refusal_cleanup",
    sql.indexOf("CREATE OR REPLACE FUNCTION public.enqueue_post_call_processing")
  );
  assert.ok(override > 0);
  const branch = sql.slice(
    override,
    sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_post_call_processing_jobs", override)
  );
  assert.match(branch, /DELETE FROM public\.learning_suggestions/);
  assert.match(branch, /DELETE FROM public\.appointments/);
  assert.match(branch, /DELETE FROM public\.calls/);
  assert.match(branch, /status = 'cancelled'/);
  assert.match(branch, /transcript = NULL/);
  assert.match(branch, /public\.anonymize_contact_data/);
});
