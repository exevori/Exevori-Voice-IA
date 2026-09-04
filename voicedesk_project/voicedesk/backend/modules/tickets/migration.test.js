import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../../migrations/015_ticket_support_hardening.sql", import.meta.url),
  "utf8"
);

const RPCS = [
  "create_support_ticket",
  "append_support_ticket_message",
  "enqueue_ticket_sla_alerts",
  "claim_ticket_email_outbox",
  "complete_ticket_email_outbox",
  "suppress_ticket_email_outbox",
  "fail_ticket_email_outbox",
  "purge_ticket_email_outbox",
];

test("migration 015 is transactional, guarded and invoker-only", () => {
  assert.match(migration, /^--[^\n]*\n(?:--[^\n]*\n)*\s*BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /Migration 015 aborted — migration 009 tenant helpers are missing/);
  assert.match(migration, /Migration 015 aborted — missing required columns/);
  assert.doesNotMatch(migration, /SECURITY DEFINER/i);
  for (const name of RPCS) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    assert.ok(start > 0, `${name} must exist`);
    const declarationEnd = migration.indexOf("AS $function$", start);
    const declaration = migration.slice(start, declarationEnd);
    assert.match(declaration, /SECURITY INVOKER/);
    assert.match(declaration, /SET search_path = ''/);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}`));
  }
});

test("ticket ownership is enforced through composite keys and RLS", () => {
  for (const fragment of [
    "tickets_id_company_unique UNIQUE (id, company_id)",
    "ticket_messages_id_ticket_unique UNIQUE (id, ticket_id)",
    "FOREIGN KEY (ticket_id, company_id)",
    "REFERENCES public.tickets(id, company_id)",
    "FOREIGN KEY (message_id, ticket_id)",
    "REFERENCES public.ticket_messages(id, ticket_id)",
  ]) {
    assert.ok(migration.includes(fragment), `missing ${fragment}`);
  }
  for (const table of ["tickets", "ticket_messages", "ticket_attachments", "ticket_email_outbox"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.ticket_email_outbox[\s\S]*PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.ticket_email_outbox[\s\S]*TO service_role/);
});

test("ticket and first message plus reply transitions enqueue email atomically", () => {
  const createStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.create_support_ticket");
  const appendStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.append_support_ticket_message");
  const slaStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.enqueue_ticket_sla_alerts");
  const create = migration.slice(createStart, appendStart);
  const append = migration.slice(appendStart, slaStart);
  assert.match(create, /INSERT INTO public\.tickets/);
  assert.match(create, /INSERT INTO public\.ticket_messages/);
  assert.match(create, /INSERT INTO public\.ticket_email_outbox/);
  assert.match(create, /profile\.company_id = p_company_id/);
  assert.match(create, /profile\.role = 'super_admin'/);
  assert.match(create, /nextval\('public\.support_ticket_number_seq'\)/);
  assert.doesNotMatch(create, /count\(\*\)/i);
  assert.match(append, /FOR UPDATE/);
  assert.match(append, /p_is_internal IS TRUE AND p_actor_role <> 'exevori_agent'/);
  assert.match(append, /'agent_reply'/);
  assert.match(append, /'client_reply'/);
  assert.match(append, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

test("SLA and delivery queues are durable, idempotent and concurrency-safe", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.ticket_email_outbox/);
  assert.match(migration, /idempotency_key\s+text NOT NULL UNIQUE/);
  assert.match(migration, /'sla_at_risk', 'sla_breached'/);
  assert.match(migration, /'first_response'::text AS milestone/);
  assert.match(migration, /'resolution'::text/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /lease_expires_at <= clock_timestamp\(\)/);
  assert.match(migration, /email\.attempts >= 8/);
  assert.match(migration, /interval '30 days'/);
  assert.match(migration, /interval '90 days'/);
  assert.doesNotMatch(migration, /https?:\/\//i);
});

test("indexes cover tenant threads, active SLA scans and outbox claims", () => {
  for (const index of [
    "idx_tickets_company_status_updated",
    "idx_tickets_active_sla_response",
    "idx_tickets_active_sla_resolution",
    "idx_ticket_messages_company_ticket_created",
    "idx_ticket_email_outbox_claim",
    "idx_ticket_email_outbox_ticket",
  ]) {
    assert.match(migration, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
  }
});
