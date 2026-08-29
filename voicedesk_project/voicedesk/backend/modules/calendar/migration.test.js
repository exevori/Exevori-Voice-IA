import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../../migrations/013_calendly_oauth.sql", import.meta.url),
  "utf8"
);

test("migration 013 is transactional and guarded by migrations 009 through 012", () => {
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/);
  for (const sentinel of [
    "private.current_company_id()",
    "private.is_super_admin()",
    "public.anonymize_contact_data(uuid,uuid,uuid,text,text,text)",
    "privacy_external_deletions",
    "post_call_processing_jobs",
    "contacts', 'next_action_note",
    "appointments', 'post_call_job_id",
  ]) {
    assert.ok(migration.includes(sentinel), `missing schema guard: ${sentinel}`);
  }
});

test("all calendar operational tables are backend-only with RLS and explicit grants", () => {
  for (const table of [
    "calendly_connections",
    "calendly_oauth_states",
    "calendly_webhook_events",
    "calendar_booking_requests",
    "calendar_email_outbox",
  ]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/);
  assert.doesNotMatch(migration, /FOR policy IN[\s\S]*DROP POLICY %I/);
  assert.match(migration, /DROP POLICY IF EXISTS service_role_bypass/);
});

test("tenant ownership is enforced by composite foreign keys", () => {
  for (const fragment of [
    "contacts_id_company_unique UNIQUE (id, company_id)",
    "appointments_id_company_unique UNIQUE (id, company_id)",
    "calendly_connections_id_company_unique UNIQUE (id, company_id)",
    "FOREIGN KEY (connection_id, company_id)",
    "FOREIGN KEY (contact_id, company_id)",
    "FOREIGN KEY (appointment_id, company_id)",
    "FOREIGN KEY (calendly_connection_id, company_id)",
  ]) {
    assert.ok(migration.includes(fragment), `missing tenant FK fragment: ${fragment}`);
  }
});

test("OAuth tokens and PKCE verifier are encrypted triplets with atomic single-use refresh", () => {
  assert.match(migration, /access_token_ciphertext\s+text/);
  assert.match(migration, /refresh_token_ciphertext\s+text/);
  assert.match(migration, /verifier_ciphertext\s+text NOT NULL/);
  assert.doesNotMatch(migration, /\baccess_token\s+text[,\n]/);
  assert.doesNotMatch(migration, /\brefresh_token\s+text[,\n]/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_calendly_token_refresh/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_calendly_token_refresh/);
  assert.match(migration, /token_version = connection\.token_version \+ 1/);
  assert.match(migration, /connection\.refresh_lock_token = p_lock_token/);
  assert.match(migration, /connection\.refresh_locked_until > clock_timestamp\(\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.invalidate_calendly_token_refresh/);
});

test("booking dispatch is one-way and ambiguous attempts are quarantined, never reclaimed", () => {
  assert.match(migration, /status IN \('pending', 'dispatching', 'provider_succeeded', 'committed', 'reconciliation_required', 'failed'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_calendar_booking_dispatch/);
  const claimBlock = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.claim_calendar_booking_dispatch"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.claim_calendly_webhook_events")
  );
  assert.match(claimBlock, /request\.status = 'pending'/);
  assert.doesNotMatch(claimBlock, /lease_expires_at/);
  assert.match(migration, /status = 'dispatching'[\s\S]*status = 'reconciliation_required'/);
  assert.doesNotMatch(migration, /calendar_booking_request_id/);
});

test("webhooks, reminders, privacy and retention are durable and bounded", () => {
  assert.match(migration, /UNIQUE \(connection_id, event_key\)/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /UNIQUE \(appointment_id, email_kind\)/);
  assert.match(migration, /trg_scrub_calendar_appointment_on_anonymization/);
  assert.match(migration, /trg_scrub_calendar_contact_on_anonymization/);
  assert.match(migration, /'calendly',[\s\S]*'invitee_email'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.purge_expired_calendar_data/);
  assert.match(migration, /dispatch_interrupted/);
  assert.match(migration, /interval '30 days'/);
  assert.match(migration, /interval '90 days'/);
});

test("appointment upsert has a non-partial unique arbiter and safe return paths are allowlisted", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_calendly_invitee\s+ON public\.appointments\(company_id, calendly_invitee_uri\);/
  );
  assert.match(
    migration,
    /return_path IN \('\/calendar', '\/settings', '\/settings\/integrations'\)/
  );
  assert.doesNotMatch(migration, /return_path ~ '\^\//);
});

test("every SECURITY DEFINER calendar RPC is denied to public clients", () => {
  const rpcNames = [
    "consume_calendly_oauth_state",
    "claim_calendly_token_refresh",
    "complete_calendly_token_refresh",
    "invalidate_calendly_token_refresh",
    "release_calendly_token_refresh",
    "claim_calendar_booking_dispatch",
    "claim_calendly_webhook_events",
    "claim_calendar_email_outbox",
    "purge_expired_calendar_data",
  ];
  for (const name of rpcNames) {
    assert.match(migration, new RegExp(`REVOKE ALL\\s+ON FUNCTION public\\.${name}`));
    assert.match(migration, new RegExp(`GRANT EXECUTE\\s+ON FUNCTION public\\.${name}`));
  }
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = ''/g);
});
