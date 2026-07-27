-- Migration 010 — Loi 25 privacy, retention and append-only audit
-- Built against the production schema audited on Exevori Voice IA.
-- This migration deliberately does not reference auth.users, profiles,
-- companies or subscriptions from any foreign key or function.

BEGIN;

-- ============================================================
-- 1. Production-schema guard
-- ============================================================

DO $$
DECLARE
  missing_tables text[];
BEGIN
  SELECT array_agg(required.table_name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'appointments',
    'call_events',
    'call_recordings',
    'calls',
    'contact_notes',
    'contacts',
    'email_drafts',
    'emails',
    'learning_suggestions',
    'outbound_calls',
    'outbound_contacts'
  ]::text[]) AS required(table_name)
  WHERE to_regclass('public.' || quote_ident(required.table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 010 aborted — missing tables: %',
      array_to_string(missing_tables, ', ');
  END IF;
END
$$;

-- ============================================================
-- 2. Retention metadata
-- ============================================================

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS retention_days integer,
  ADD COLUMN IF NOT EXISTS transcript_retention_days integer,
  ADD COLUMN IF NOT EXISTS elevenlabs_conversation_id text;

-- Legacy rows may predate the created_at default. Give them a deterministic
-- retention clock instead of letting NULL compare false forever.
UPDATE public.calls
SET created_at = COALESCE(ended_at, now())
WHERE created_at IS NULL;

UPDATE public.calls
SET retention_days = 90
WHERE retention_days IS NULL;

UPDATE public.calls
SET transcript_retention_days = 90
WHERE transcript_retention_days IS NULL;

ALTER TABLE public.calls
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN retention_days SET DEFAULT 90,
  ALTER COLUMN retention_days SET NOT NULL,
  ALTER COLUMN transcript_retention_days SET DEFAULT 90,
  ALTER COLUMN transcript_retention_days SET NOT NULL;

-- Historical ElevenLabs calls temporarily stored their conversation ID in
-- twilio_call_sid. Only the explicit conv_ namespace is backfilled.
UPDATE public.calls
SET elevenlabs_conversation_id = twilio_call_sid
WHERE elevenlabs_conversation_id IS NULL
  AND twilio_call_sid LIKE 'conv\_%' ESCAPE '\';

ALTER TABLE public.call_recordings
  ADD COLUMN IF NOT EXISTS retention_days integer,
  ADD COLUMN IF NOT EXISTS transcript_retention_days integer;

UPDATE public.call_recordings
SET retention_days = 90
WHERE retention_days IS NULL;

UPDATE public.call_recordings
SET transcript_retention_days = 90
WHERE transcript_retention_days IS NULL;

ALTER TABLE public.call_recordings
  ALTER COLUMN retention_days SET DEFAULT 90,
  ALTER COLUMN retention_days SET NOT NULL,
  ALTER COLUMN transcript_retention_days SET DEFAULT 90,
  ALTER COLUMN transcript_retention_days SET NOT NULL;

ALTER TABLE public.outbound_calls
  ADD COLUMN IF NOT EXISTS retention_days integer,
  ADD COLUMN IF NOT EXISTS transcript_retention_days integer;

UPDATE public.outbound_calls
SET created_at = COALESCE(ended_at, now())
WHERE created_at IS NULL;

UPDATE public.outbound_calls
SET retention_days = 90
WHERE retention_days IS NULL;

UPDATE public.outbound_calls
SET transcript_retention_days = 90
WHERE transcript_retention_days IS NULL;

ALTER TABLE public.outbound_calls
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN retention_days SET DEFAULT 90,
  ALTER COLUMN retention_days SET NOT NULL,
  ALTER COLUMN transcript_retention_days SET DEFAULT 90,
  ALTER COLUMN transcript_retention_days SET NOT NULL;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

ALTER TABLE public.outbound_contacts
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.calls'::regclass
      AND conname = 'calls_retention_days_check'
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_retention_days_check
      CHECK (retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.calls'::regclass
      AND conname = 'calls_transcript_retention_days_check'
  ) THEN
    ALTER TABLE public.calls
      ADD CONSTRAINT calls_transcript_retention_days_check
      CHECK (transcript_retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.call_recordings'::regclass
      AND conname = 'call_recordings_retention_days_check'
  ) THEN
    ALTER TABLE public.call_recordings
      ADD CONSTRAINT call_recordings_retention_days_check
      CHECK (retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.call_recordings'::regclass
      AND conname = 'call_recordings_transcript_retention_days_check'
  ) THEN
    ALTER TABLE public.call_recordings
      ADD CONSTRAINT call_recordings_transcript_retention_days_check
      CHECK (transcript_retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_calls'::regclass
      AND conname = 'outbound_calls_retention_days_check'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_retention_days_check
      CHECK (retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_calls'::regclass
      AND conname = 'outbound_calls_transcript_retention_days_check'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_transcript_retention_days_check
      CHECK (transcript_retention_days BETWEEN 1 AND 3650);
  END IF;

  -- The live outbound-contact workflow already uses this named constraint.
  -- Recreate it idempotently so privacy anonymization has an explicit,
  -- non-operational terminal status.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_contacts'::regclass
      AND conname = 'outbound_contacts_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%anonymized%'
  ) THEN
    ALTER TABLE public.outbound_contacts
      DROP CONSTRAINT outbound_contacts_status_check;

    ALTER TABLE public.outbound_contacts
      ADD CONSTRAINT outbound_contacts_status_check
      CHECK (status IN (
        'pending',
        'calling',
        'called',
        'no_answer',
        'interested',
        'not_interested',
        'dnc',
        'error',
        'anonymized'
      ));
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_contacts'::regclass
      AND conname = 'outbound_contacts_status_check'
  ) THEN
    ALTER TABLE public.outbound_contacts
      ADD CONSTRAINT outbound_contacts_status_check
      CHECK (status IN (
        'pending',
        'calling',
        'called',
        'no_answer',
        'interested',
        'not_interested',
        'dnc',
        'error',
        'anonymized'
      ));
  END IF;
END
$$;

-- Immutable partial predicates keep the hot purge indexes compact. The
-- dynamic now() - retention_days cutoff stays in the query, not the index.
CREATE INDEX IF NOT EXISTS idx_calls_privacy_transcript_purge
  ON public.calls(created_at)
  WHERE ai_transcript IS NOT NULL OR ai_summary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calls_privacy_retention_purge
  ON public.calls(created_at)
  WHERE
    (status IS NULL OR status NOT IN (
      'in_progress', 'ringing', 'connecting', 'calling'
    ))
    AND
    (live_status IS NULL OR live_status NOT IN (
      'ringing', 'connecting', 'ai_speaking', 'user_speaking',
      'transferring'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_elevenlabs_conversation
  ON public.calls(elevenlabs_conversation_id)
  WHERE elevenlabs_conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_recordings_privacy_purge
  ON public.call_recordings(created_at);

CREATE INDEX IF NOT EXISTS idx_call_recordings_privacy_transcript_purge
  ON public.call_recordings(created_at)
  WHERE transcript IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_calls_privacy_transcript_purge
  ON public.outbound_calls(created_at)
  WHERE ai_transcript IS NOT NULL OR ai_summary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_calls_privacy_retention_purge
  ON public.outbound_calls(created_at)
  WHERE status IS NULL OR status NOT IN ('queued', 'calling', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_contacts_anonymized
  ON public.contacts(company_id, anonymized_at)
  WHERE anonymized_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_contacts_anonymized
  ON public.outbound_contacts(company_id, anonymized_at)
  WHERE anonymized_at IS NOT NULL;

-- ============================================================
-- 3. Append-only audit ledger
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL is reserved for service-role retention of legacy orphan rows.
  company_id      uuid,
  actor_user_id   uuid,
  actor_role      text,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  request_id      text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_days  integer NOT NULL DEFAULT 730
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.audit_log'::regclass
      AND conname = 'audit_log_retention_days_check'
  ) THEN
    ALTER TABLE public.audit_log
      ADD CONSTRAINT audit_log_retention_days_check
      CHECK (retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.audit_log'::regclass
      AND conname = 'audit_log_orphan_retention_check'
  ) THEN
    ALTER TABLE public.audit_log
      ADD CONSTRAINT audit_log_orphan_retention_check
      CHECK (
        company_id IS NOT NULL
        OR COALESCE(
          actor_role = 'system' AND entity_type = 'retention_batch',
          false
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_log_company_created
  ON public.audit_log(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created
  ON public.audit_log(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_entity_created
  ON public.audit_log(entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_request
  ON public.audit_log(request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_retention
  ON public.audit_log(created_at);

-- ============================================================
-- 4. Durable external-provider deletion queue
-- ============================================================

CREATE TABLE IF NOT EXISTS public.privacy_external_deletions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL is reserved for global cleanup of legacy orphan provider resources.
  company_id            uuid,
  target_contact_id     uuid,
  provider              text NOT NULL,
  resource_type         text NOT NULL,
  external_id           text NOT NULL,
  requested_by_user_id  uuid,
  requested_by_role     text,
  request_id            text,
  status                text NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz DEFAULT now(),
  locked_at             timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  retention_days        integer NOT NULL DEFAULT 30
);

ALTER TABLE public.privacy_external_deletions
  ADD COLUMN IF NOT EXISTS retention_days integer;

ALTER TABLE public.audit_log
  ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE public.privacy_external_deletions
  ALTER COLUMN company_id DROP NOT NULL;

UPDATE public.privacy_external_deletions
SET retention_days = 30
WHERE retention_days IS NULL;

ALTER TABLE public.privacy_external_deletions
  ALTER COLUMN retention_days SET DEFAULT 30,
  ALTER COLUMN retention_days SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.privacy_external_deletions'::regclass
      AND conname = 'privacy_external_deletions_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%failed%'
  ) THEN
    ALTER TABLE public.privacy_external_deletions
      DROP CONSTRAINT privacy_external_deletions_status_check;

    ALTER TABLE public.privacy_external_deletions
      ADD CONSTRAINT privacy_external_deletions_status_check
      CHECK (
        status IN ('pending', 'processing', 'completed', 'retry', 'failed')
      );
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.privacy_external_deletions'::regclass
      AND conname = 'privacy_external_deletions_status_check'
  ) THEN
    ALTER TABLE public.privacy_external_deletions
      ADD CONSTRAINT privacy_external_deletions_status_check
      CHECK (
        status IN ('pending', 'processing', 'completed', 'retry', 'failed')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.privacy_external_deletions'::regclass
      AND conname = 'privacy_external_deletions_attempts_check'
  ) THEN
    ALTER TABLE public.privacy_external_deletions
      ADD CONSTRAINT privacy_external_deletions_attempts_check
      CHECK (attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.privacy_external_deletions'::regclass
      AND conname = 'privacy_external_deletions_retention_days_check'
  ) THEN
    ALTER TABLE public.privacy_external_deletions
      ADD CONSTRAINT privacy_external_deletions_retention_days_check
      CHECK (retention_days BETWEEN 1 AND 3650);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.privacy_external_deletions'::regclass
      AND conname = 'privacy_external_deletions_orphan_check'
  ) THEN
    ALTER TABLE public.privacy_external_deletions
      ADD CONSTRAINT privacy_external_deletions_orphan_check
      CHECK (
        company_id IS NOT NULL
        OR COALESCE(
          requested_by_role = 'system' AND target_contact_id IS NULL,
          false
        )
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_privacy_external_deletions_resource
  ON public.privacy_external_deletions(provider, resource_type, external_id);

CREATE INDEX IF NOT EXISTS idx_privacy_external_deletions_claim
  ON public.privacy_external_deletions(
    status,
    next_attempt_at,
    locked_at,
    created_at
  )
  WHERE status IN ('pending', 'retry', 'processing');

CREATE INDEX IF NOT EXISTS idx_privacy_external_deletions_company_contact
  ON public.privacy_external_deletions(
    company_id,
    target_contact_id,
    status,
    next_attempt_at
  );

CREATE INDEX IF NOT EXISTS idx_privacy_external_deletions_terminal_purge
  ON public.privacy_external_deletions(completed_at)
  WHERE status = 'completed';

-- ============================================================
-- 5. Service-role-only RLS and least-privilege ACLs
-- ============================================================

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_external_deletions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('audit_log', 'privacy_external_deletions')
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  END LOOP;
END
$$;

CREATE POLICY audit_log_service_role_select
ON public.audit_log
FOR SELECT
TO service_role
USING (true);

CREATE POLICY audit_log_service_role_insert
ON public.audit_log
FOR INSERT
TO service_role
WITH CHECK (true);

CREATE POLICY privacy_external_deletions_service_role_select
ON public.privacy_external_deletions
FOR SELECT
TO service_role
USING (true);

CREATE POLICY privacy_external_deletions_service_role_insert
ON public.privacy_external_deletions
FOR INSERT
TO service_role
WITH CHECK (true);

CREATE POLICY privacy_external_deletions_service_role_update
ON public.privacy_external_deletions
FOR UPDATE
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY privacy_external_deletions_service_role_delete
ON public.privacy_external_deletions
FOR DELETE
TO service_role
USING (true);

REVOKE ALL PRIVILEGES ON TABLE public.audit_log
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON TABLE public.audit_log
TO service_role;

REVOKE ALL PRIVILEGES ON TABLE public.privacy_external_deletions
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.privacy_external_deletions
TO service_role;

-- The application role cannot delete audit rows directly. Expired ledger
-- entries can only be removed through this tightly-scoped maintenance RPC.
CREATE SCHEMA IF NOT EXISTS privacy_private;

REVOKE ALL ON SCHEMA privacy_private
FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA privacy_private TO service_role;

CREATE OR REPLACE FUNCTION privacy_private.purge_expired_audit_log(
  p_batch_size integer DEFAULT 500,
  p_company_id uuid DEFAULT NULL
)
RETURNS TABLE(purged_company_id uuid, affected integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH targets AS (
    SELECT a.id
    FROM public.audit_log AS a
    WHERE (p_company_id IS NULL OR a.company_id = p_company_id)
      AND a.created_at
          < now() - make_interval(days => a.retention_days)
    ORDER BY a.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.audit_log AS a
    USING targets AS t
    WHERE a.id = t.id
    RETURNING a.company_id
  )
  SELECT
    deleted.company_id,
    count(*)::integer
  FROM deleted
  GROUP BY deleted.company_id;
END
$$;

REVOKE ALL
ON FUNCTION privacy_private.purge_expired_audit_log(integer, uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE
ON FUNCTION privacy_private.purge_expired_audit_log(integer, uuid)
TO service_role;

-- ============================================================
-- 6. Consent-refusal provider cleanup
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_consent_refusal_cleanup(
  p_company_id uuid,
  p_conversation_id text,
  p_twilio_call_sid text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_conversation_id text := NULLIF(btrim(p_conversation_id), '');
  v_twilio_call_sid text := NULLIF(btrim(p_twilio_call_sid), '');
  v_request_id text := gen_random_uuid()::text;
  v_elevenlabs_enqueued integer := 0;
  v_twilio_enqueued integer := 0;
  v_enqueued integer := 0;
BEGIN
  IF p_company_id IS NULL OR v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'company_id and conversation_id are required'
      USING ERRCODE = '22004';
  END IF;

  IF length(v_conversation_id) > 255
     OR v_conversation_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid conversation_id'
      USING ERRCODE = '22023';
  END IF;

  IF v_twilio_call_sid IS NOT NULL
     AND (
       length(v_twilio_call_sid) > 255
       OR v_twilio_call_sid !~ '^CA[0-9A-Fa-f]{32}$'
     ) THEN
    RAISE EXCEPTION 'invalid twilio_call_sid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  VALUES (
    p_company_id,
    NULL,
    'elevenlabs',
    'conversation',
    v_conversation_id,
    NULL,
    'system',
    v_request_id
  )
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_elevenlabs_enqueued = ROW_COUNT;

  IF EXISTS (
    SELECT 1
    FROM public.privacy_external_deletions AS d
    WHERE d.provider = 'elevenlabs'
      AND d.resource_type = 'conversation'
      AND d.external_id = v_conversation_id
      AND d.company_id IS DISTINCT FROM p_company_id
  ) THEN
    RAISE EXCEPTION 'provider resource tenant conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_twilio_call_sid IS NOT NULL THEN
    INSERT INTO public.privacy_external_deletions (
      company_id,
      target_contact_id,
      provider,
      resource_type,
      external_id,
      requested_by_user_id,
      requested_by_role,
      request_id
    )
    VALUES (
      p_company_id,
      NULL,
      'twilio',
      'call',
      v_twilio_call_sid,
      NULL,
      'system',
      v_request_id
    )
    ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

    GET DIAGNOSTICS v_twilio_enqueued = ROW_COUNT;

    IF EXISTS (
      SELECT 1
      FROM public.privacy_external_deletions AS d
      WHERE d.provider = 'twilio'
        AND d.resource_type = 'call'
        AND d.external_id = v_twilio_call_sid
        AND d.company_id IS DISTINCT FROM p_company_id
    ) THEN
      RAISE EXCEPTION 'provider resource tenant conflict'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  v_enqueued := v_elevenlabs_enqueued + v_twilio_enqueued;

  IF v_enqueued > 0 THEN
    INSERT INTO public.audit_log (
      company_id,
      actor_user_id,
      actor_role,
      action,
      entity_type,
      entity_id,
      request_id,
      details
    )
    VALUES (
      p_company_id,
      NULL,
      'system',
      'privacy.consent_refusal_cleanup_enqueued',
      'consent_refusal',
      NULL,
      v_request_id,
      jsonb_build_object(
        'external_deletions_enqueued', v_enqueued,
        'elevenlabs_enqueued', v_elevenlabs_enqueued,
        'twilio_enqueued', v_twilio_enqueued
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'external_deletions_enqueued', v_enqueued,
    'status', CASE WHEN v_enqueued > 0 THEN 'queued' ELSE 'already_queued' END
  );
END
$$;

REVOKE ALL
ON FUNCTION public.enqueue_consent_refusal_cleanup(uuid, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.enqueue_consent_refusal_cleanup(uuid, text, text)
TO service_role;

-- ============================================================
-- 7. Atomic contact anonymization
-- ============================================================

CREATE OR REPLACE FUNCTION public.anonymize_contact_data(
  p_company_id uuid,
  p_contact_id uuid,
  p_actor_user_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_anonymized_at timestamptz;
  v_already_anonymized boolean := false;
  v_target_type text;
  v_direct_crm_contact_id uuid;
  v_crm_contact_ids uuid[] := ARRAY[]::uuid[];
  v_call_ids uuid[] := ARRAY[]::uuid[];
  v_outbound_call_ids uuid[] := ARRAY[]::uuid[];
  v_outbound_contact_ids uuid[] := ARRAY[]::uuid[];
  v_contact_notes_deleted integer := 0;
  v_email_drafts_deleted integer := 0;
  v_emails_deleted integer := 0;
  v_learning_deleted integer := 0;
  v_calls_anonymized integer := 0;
  v_outbound_anonymized integer := 0;
  v_contacts_anonymized integer := 0;
  v_outbound_contacts_anonymized integer := 0;
  v_appointments_anonymized integer := 0;
  v_recordings_anonymized integer := 0;
  v_events_anonymized integer := 0;
  v_external_enqueued integer := 0;
  v_rows integer := 0;
  v_counts jsonb;
BEGIN
  IF p_company_id IS NULL OR p_contact_id IS NULL THEN
    RAISE EXCEPTION 'company_id and contact_id are required'
      USING ERRCODE = '22004';
  END IF;

  -- A privacy target can be a CRM contact or a campaign-only outbound
  -- contact. CRM takes precedence in the practically impossible event that
  -- the same UUID exists in both tables.
  SELECT c.id, c.anonymized_at
  INTO v_direct_crm_contact_id, v_anonymized_at
  FROM public.contacts AS c
  WHERE c.id = p_contact_id
    AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT oc.anonymized_at
    INTO v_anonymized_at
    FROM public.outbound_contacts AS oc
    WHERE oc.id = p_contact_id
      AND oc.company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'privacy target % does not exist in company %',
        p_contact_id,
        p_company_id
        USING ERRCODE = 'P0002';
    END IF;

    v_target_type := 'outbound_contact';
  ELSE
    v_target_type := 'contact';
  END IF;

  -- Re-running the RPC is intentional: late-arriving FK-linked records must
  -- still be cleaned even when the direct contact was anonymized previously.
  v_already_anonymized := v_anonymized_at IS NOT NULL;

  -- Automated privacy actions never infer identity from a shared phone number
  -- or email address. Only the direct target and real foreign-key relations
  -- are changed. A future reviewed CRM merge can provide an explicit mapping.
  IF v_target_type = 'contact' THEN
    v_crm_contact_ids := ARRAY[v_direct_crm_contact_id];
  ELSE
    v_outbound_contact_ids := ARRAY[p_contact_id];
  END IF;

  SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[])
  INTO v_call_ids
  FROM public.calls AS c
  WHERE c.company_id = p_company_id
    AND c.contact_id = ANY(v_crm_contact_ids);

  SELECT COALESCE(array_agg(oc.id), ARRAY[]::uuid[])
  INTO v_outbound_call_ids
  FROM public.outbound_calls AS oc
  WHERE oc.company_id = p_company_id
    AND oc.contact_id = ANY(v_crm_contact_ids);

  -- Enqueue all external deletions before erasing local identifiers.
  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  SELECT
    p_company_id,
    p_contact_id,
    'elevenlabs',
    'conversation',
    c.elevenlabs_conversation_id,
    p_actor_user_id,
    p_actor_role,
    p_request_id
  FROM public.calls AS c
  WHERE c.company_id = p_company_id
    AND c.id = ANY(v_call_ids)
    AND c.elevenlabs_conversation_id IS NOT NULL
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  SELECT
    p_company_id,
    p_contact_id,
    'twilio',
    'call',
    c.twilio_call_sid,
    p_actor_user_id,
    p_actor_role,
    p_request_id
  FROM public.calls AS c
  WHERE c.company_id = p_company_id
    AND c.id = ANY(v_call_ids)
    AND c.twilio_call_sid IS NOT NULL
    AND c.twilio_call_sid NOT LIKE 'conv\_%' ESCAPE '\'
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  SELECT
    p_company_id,
    p_contact_id,
    'twilio',
    'recording',
    cr.twilio_recording_sid,
    p_actor_user_id,
    p_actor_role,
    p_request_id
  FROM public.call_recordings AS cr
  JOIN public.calls AS c
    ON c.id = cr.call_id
   AND c.company_id = cr.company_id
  WHERE c.company_id = p_company_id
    AND c.id = ANY(v_call_ids)
    AND cr.twilio_recording_sid IS NOT NULL
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  SELECT
    p_company_id,
    p_contact_id,
    'calendly',
    'scheduled_event',
    a.external_id,
    p_actor_user_id,
    p_actor_role,
    p_request_id
  FROM public.appointments AS a
  WHERE a.company_id = p_company_id
    AND a.contact_id = ANY(v_crm_contact_ids)
    AND a.external_id IS NOT NULL
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  INSERT INTO public.privacy_external_deletions (
    company_id,
    target_contact_id,
    provider,
    resource_type,
    external_id,
    requested_by_user_id,
    requested_by_role,
    request_id
  )
  SELECT
    p_company_id,
    p_contact_id,
    'twilio',
    'call',
    oc.twilio_call_sid,
    p_actor_user_id,
    p_actor_role,
    p_request_id
  FROM public.outbound_calls AS oc
  WHERE oc.company_id = p_company_id
    AND oc.id = ANY(v_outbound_call_ids)
    AND oc.twilio_call_sid IS NOT NULL
  ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  -- A repeated, explicit anonymization request is the manual retry path for
  -- terminal provider failures. Keep the external identifier in the durable
  -- queue, reset only this contact's failed jobs, then let the worker claim
  -- them again. Background retention never performs this requeue.
  UPDATE public.privacy_external_deletions AS d
  SET
    status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    locked_at = NULL,
    last_error = NULL,
    completed_at = NULL,
    requested_by_user_id = p_actor_user_id,
    requested_by_role = p_actor_role,
    request_id = p_request_id,
    updated_at = now()
  WHERE d.company_id = p_company_id
    AND d.target_contact_id = p_contact_id
    AND d.status = 'failed';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_external_enqueued := v_external_enqueued + v_rows;

  WITH deleted AS (
    DELETE FROM public.contact_notes AS cn
    WHERE cn.company_id = p_company_id
      AND cn.contact_id = ANY(v_crm_contact_ids)
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO v_contact_notes_deleted
  FROM deleted;

  -- Drafts must be deleted before their parent emails because the live FK
  -- has no ON DELETE action.
  WITH deleted AS (
    DELETE FROM public.email_drafts AS ed
    WHERE ed.company_id = p_company_id
      AND EXISTS (
        SELECT 1
        FROM public.emails AS e
        WHERE e.id = ed.email_id
          AND e.company_id = p_company_id
          AND e.contact_id = ANY(v_crm_contact_ids)
      )
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO v_email_drafts_deleted
  FROM deleted;

  WITH deleted AS (
    DELETE FROM public.emails AS e
    WHERE e.company_id = p_company_id
      AND e.contact_id = ANY(v_crm_contact_ids)
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO v_emails_deleted
  FROM deleted;

  WITH deleted AS (
    DELETE FROM public.learning_suggestions AS ls
    WHERE ls.company_id = p_company_id
      AND EXISTS (
        SELECT 1
        FROM public.calls AS c
        WHERE c.company_id = p_company_id
          AND c.id = ANY(v_call_ids)
          AND ls.source = 'call:' || c.id::text
      )
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO v_learning_deleted
  FROM deleted;

  WITH changed AS (
    UPDATE public.call_recordings AS cr
    SET
      twilio_recording_sid = NULL,
      url = NULL,
      transcript = NULL
    FROM public.calls AS c
    WHERE c.id = cr.call_id
      AND c.company_id = cr.company_id
      AND c.company_id = p_company_id
      AND c.id = ANY(v_call_ids)
    RETURNING cr.id
  )
  SELECT count(*)::integer
  INTO v_recordings_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.call_events AS ce
    SET payload = '{}'::jsonb
    FROM public.calls AS c
    WHERE c.id = ce.call_id
      AND c.company_id = ce.company_id
      AND c.company_id = p_company_id
      AND c.id = ANY(v_call_ids)
    RETURNING ce.id
  )
  SELECT count(*)::integer
  INTO v_events_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.appointments AS a
    SET
      contact_id = NULL,
      external_id = NULL,
      notes = NULL
    WHERE a.company_id = p_company_id
      AND a.contact_id = ANY(v_crm_contact_ids)
    RETURNING a.id
  )
  SELECT count(*)::integer
  INTO v_appointments_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.outbound_calls AS oc
    SET
      contact_id = NULL,
      twilio_call_sid = NULL,
      contact_name = NULL,
      contact_phone = NULL,
      outcome = NULL,
      answered_by = NULL,
      ai_summary = NULL,
      ai_transcript = NULL
    WHERE oc.company_id = p_company_id
      AND oc.id = ANY(v_outbound_call_ids)
    RETURNING oc.id
  )
  SELECT count(*)::integer
  INTO v_outbound_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.calls AS c
    SET
      contact_id = NULL,
      twilio_call_sid = NULL,
      caller_phone = NULL,
      caller_name = NULL,
      intent = NULL,
      outcome = NULL,
      ai_summary = NULL,
      ai_transcript = NULL,
      elevenlabs_conversation_id = NULL
    WHERE c.company_id = p_company_id
      AND c.id = ANY(v_call_ids)
    RETURNING c.id
  )
  SELECT count(*)::integer
  INTO v_calls_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.contacts AS c
    SET
      full_name = 'Contact anonymisé',
      first_name = NULL,
      last_name = NULL,
      email = NULL,
      phone = NULL,
      company = NULL,
      status = 'anonymized',
      source = 'privacy_request',
      main_need = NULL,
      budget = NULL,
      urgency = NULL,
      tags = NULL,
      notes = NULL,
      next_action = NULL,
      last_interaction_at = NULL,
      updated_at = now(),
      anonymized_at = now()
    WHERE c.company_id = p_company_id
      AND c.id = ANY(v_crm_contact_ids)
      AND c.anonymized_at IS NULL
    RETURNING c.id
  )
  SELECT count(*)::integer
  INTO v_contacts_anonymized
  FROM changed;

  WITH changed AS (
    UPDATE public.outbound_contacts AS oc
    SET
      full_name = 'Contact anonymisé',
      phone = 'anonymized',
      email = NULL,
      company_name = NULL,
      notes = NULL,
      status = 'anonymized',
      last_called_at = NULL,
      outcome = NULL,
      outcome_notes = NULL,
      anonymized_at = now()
    WHERE oc.company_id = p_company_id
      AND oc.id = ANY(v_outbound_contact_ids)
      AND oc.anonymized_at IS NULL
    RETURNING oc.id
  )
  SELECT count(*)::integer
  INTO v_outbound_contacts_anonymized
  FROM changed;

  v_counts := jsonb_build_object(
    'contact_notes_deleted', v_contact_notes_deleted,
    'email_drafts_deleted', v_email_drafts_deleted,
    'emails_deleted', v_emails_deleted,
    'learning_suggestions_deleted', v_learning_deleted,
    'calls_anonymized', v_calls_anonymized,
    'outbound_calls_anonymized', v_outbound_anonymized,
    'contacts_anonymized', v_contacts_anonymized,
    'outbound_contacts_anonymized', v_outbound_contacts_anonymized,
    'appointments_anonymized', v_appointments_anonymized,
    'call_recordings_anonymized', v_recordings_anonymized,
    'call_events_anonymized', v_events_anonymized,
    'external_deletions_enqueued', v_external_enqueued
  );

  -- p_reason is intentionally not copied to the audit ledger because it may
  -- contain personal data. Only its presence is recorded.
  INSERT INTO public.audit_log (
    company_id,
    actor_user_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    request_id,
    details
  )
  VALUES (
    p_company_id,
    p_actor_user_id,
    p_actor_role,
    'privacy.contact_anonymized',
    v_target_type,
    p_contact_id::text,
    p_request_id,
    jsonb_build_object(
      'counts', v_counts,
      'reason_supplied', NULLIF(btrim(p_reason), '') IS NOT NULL
    )
  );

  RETURN jsonb_build_object(
    'target_id', p_contact_id,
    'target_type', v_target_type,
    'contact_id', p_contact_id,
    'anonymized', true,
    'already_anonymized', v_already_anonymized,
    'counts', v_counts
  );
END
$$;

REVOKE ALL
ON FUNCTION public.anonymize_contact_data(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.anonymize_contact_data(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
)
TO service_role;

-- ============================================================
-- 8. Batched retention purge
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_expired_privacy_data(
  p_batch_size integer DEFAULT 500,
  p_company_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_call_ids uuid[] := ARRAY[]::uuid[];
  v_recording_ids uuid[] := ARRAY[]::uuid[];
  v_outbound_ids uuid[] := ARRAY[]::uuid[];
  v_calls_transcripts_cleared integer := 0;
  v_recording_transcripts_cleared integer := 0;
  v_outbound_transcripts_cleared integer := 0;
  v_recordings_deleted integer := 0;
  v_calls_deleted integer := 0;
  v_outbound_deleted integer := 0;
  v_learning_deleted integer := 0;
  v_external_deletions_deleted integer := 0;
  v_audit_rows_deleted integer := 0;
  v_external_enqueued integer := 0;
  v_phase_enqueued integer := 0;
  v_audit_rows integer := 0;
  v_phase_audits integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  -- Clear inbound transcripts/summaries without deleting operational metadata.
  WITH targets AS (
    SELECT c.id
    FROM public.calls AS c
    WHERE (p_company_id IS NULL OR c.company_id = p_company_id)
      AND c.created_at < now() - make_interval(days => c.transcript_retention_days)
      AND (c.ai_transcript IS NOT NULL OR c.ai_summary IS NOT NULL)
      AND (
        c.status IS NULL
        OR c.status NOT IN ('in_progress', 'ringing', 'connecting', 'calling')
      )
      AND (
        c.live_status IS NULL
        OR c.live_status NOT IN (
          'ringing', 'connecting', 'ai_speaking', 'user_speaking',
          'transferring'
        )
      )
    ORDER BY c.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  changed AS (
    UPDATE public.calls AS c
    SET
      ai_transcript = NULL,
      ai_summary = NULL
    FROM targets AS t
    WHERE c.id = t.id
    RETURNING c.company_id
  ),
  stats AS (
    SELECT company_id, count(*)::integer AS affected
    FROM changed
    GROUP BY company_id
  ),
  audited AS (
    INSERT INTO public.audit_log (
      company_id,
      actor_role,
      action,
      entity_type,
      details
    )
    SELECT
      stats.company_id,
      'system',
      'privacy.retention.calls_transcript_purged',
      'retention_batch',
      jsonb_build_object('calls_transcripts_cleared', stats.affected)
    FROM stats
    RETURNING (details ->> 'calls_transcripts_cleared')::integer AS affected
  )
  SELECT
    COALESCE(sum(affected), 0)::integer,
    count(*)::integer
  INTO v_calls_transcripts_cleared, v_phase_audits
  FROM audited;

  v_audit_rows := v_audit_rows + v_phase_audits;

  -- Clear outbound transcripts/summaries independently.
  WITH targets AS (
    SELECT oc.id
    FROM public.outbound_calls AS oc
    WHERE (p_company_id IS NULL OR oc.company_id = p_company_id)
      AND oc.created_at
          < now() - make_interval(days => oc.transcript_retention_days)
      AND (oc.ai_transcript IS NOT NULL OR oc.ai_summary IS NOT NULL)
      AND (
        oc.status IS NULL
        OR oc.status NOT IN ('queued', 'calling', 'in_progress')
      )
    ORDER BY oc.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  changed AS (
    UPDATE public.outbound_calls AS oc
    SET
      ai_transcript = NULL,
      ai_summary = NULL
    FROM targets AS t
    WHERE oc.id = t.id
    RETURNING oc.company_id
  ),
  stats AS (
    SELECT company_id, count(*)::integer AS affected
    FROM changed
    GROUP BY company_id
  ),
  audited AS (
    INSERT INTO public.audit_log (
      company_id,
      actor_role,
      action,
      entity_type,
      details
    )
    SELECT
      stats.company_id,
      'system',
      'privacy.retention.outbound_transcript_purged',
      'retention_batch',
      jsonb_build_object('outbound_transcripts_cleared', stats.affected)
    FROM stats
    RETURNING (details ->> 'outbound_transcripts_cleared')::integer AS affected
  )
  SELECT
    COALESCE(sum(affected), 0)::integer,
    count(*)::integer
  INTO v_outbound_transcripts_cleared, v_phase_audits
  FROM audited;

  v_audit_rows := v_audit_rows + v_phase_audits;

  -- Recording transcripts have a distinct retention clock from the audio
  -- resource. Clear the text first while preserving operational metadata.
  WITH targets AS (
    SELECT cr.id
    FROM public.call_recordings AS cr
    JOIN public.calls AS c
      ON c.id = cr.call_id
    WHERE (p_company_id IS NULL OR cr.company_id = p_company_id)
      AND cr.created_at
          < now() - make_interval(days => cr.transcript_retention_days)
      AND cr.transcript IS NOT NULL
      AND (
        c.status IS NULL
        OR c.status NOT IN ('in_progress', 'ringing', 'connecting', 'calling')
      )
      AND (
        c.live_status IS NULL
        OR c.live_status NOT IN (
          'ringing', 'connecting', 'ai_speaking', 'user_speaking',
          'transferring'
        )
      )
    ORDER BY cr.created_at
    LIMIT p_batch_size
    FOR UPDATE OF cr SKIP LOCKED
  ),
  changed AS (
    UPDATE public.call_recordings AS cr
    SET transcript = NULL
    FROM targets AS t
    WHERE cr.id = t.id
    RETURNING cr.company_id
  ),
  stats AS (
    SELECT company_id, count(*)::integer AS affected
    FROM changed
    GROUP BY company_id
  ),
  audited AS (
    INSERT INTO public.audit_log (
      company_id,
      actor_role,
      action,
      entity_type,
      details
    )
    SELECT
      stats.company_id,
      'system',
      'privacy.retention.recording_transcript_purged',
      'retention_batch',
      jsonb_build_object(
        'call_recording_transcripts_cleared',
        stats.affected
      )
    FROM stats
    RETURNING
      (details ->> 'call_recording_transcripts_cleared')::integer
        AS affected
  )
  SELECT
    COALESCE(sum(affected), 0)::integer,
    count(*)::integer
  INTO v_recording_transcripts_cleared, v_phase_audits
  FROM audited;

  v_audit_rows := v_audit_rows + v_phase_audits;

  -- Recordings have their own retention clock. External Twilio deletion is
  -- durably enqueued before the local row is removed.
  SELECT COALESCE(array_agg(target.id), ARRAY[]::uuid[])
  INTO v_recording_ids
  FROM (
    SELECT cr.id
    FROM public.call_recordings AS cr
    JOIN public.calls AS c
      ON c.id = cr.call_id
    WHERE (p_company_id IS NULL OR cr.company_id = p_company_id)
      AND cr.created_at < now() - make_interval(days => cr.retention_days)
      AND (
        c.status IS NULL
        OR c.status NOT IN ('in_progress', 'ringing', 'connecting', 'calling')
      )
      AND (
        c.live_status IS NULL
        OR c.live_status NOT IN (
          'ringing', 'connecting', 'ai_speaking', 'user_speaking',
          'transferring'
        )
      )
    ORDER BY cr.created_at
    LIMIT p_batch_size
    FOR UPDATE OF cr SKIP LOCKED
  ) AS target;

  IF cardinality(v_recording_ids) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      SELECT
        cr.company_id,
        CASE
          WHEN c.company_id = cr.company_id THEN c.contact_id
          ELSE NULL
        END,
        'twilio',
        'recording',
        cr.twilio_recording_sid,
        'system'
      FROM public.call_recordings AS cr
      JOIN public.calls AS c
        ON c.id = cr.call_id
      WHERE cr.id = ANY(v_recording_ids)
        AND cr.twilio_recording_sid IS NOT NULL
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer
    INTO v_phase_enqueued
    FROM inserted;

    v_external_enqueued := v_external_enqueued + v_phase_enqueued;

    WITH deleted AS (
      DELETE FROM public.call_recordings AS cr
      WHERE cr.id = ANY(v_recording_ids)
      RETURNING cr.company_id
    ),
    stats AS (
      SELECT company_id, count(*)::integer AS affected
      FROM deleted
      GROUP BY company_id
    ),
    audited AS (
      INSERT INTO public.audit_log (
        company_id,
        actor_role,
        action,
        entity_type,
        details
      )
      SELECT
        stats.company_id,
        'system',
        'privacy.retention.recordings_purged',
        'retention_batch',
        jsonb_build_object('call_recordings_deleted', stats.affected)
      FROM stats
      RETURNING (details ->> 'call_recordings_deleted')::integer AS affected
    )
    SELECT
      COALESCE(sum(affected), 0)::integer,
      count(*)::integer
    INTO v_recordings_deleted, v_phase_audits
    FROM audited;

    v_audit_rows := v_audit_rows + v_phase_audits;
  END IF;

  -- Select and lock the inbound calls to delete. Active calls are excluded.
  SELECT COALESCE(array_agg(target.id), ARRAY[]::uuid[])
  INTO v_call_ids
  FROM (
    SELECT c.id
    FROM public.calls AS c
    WHERE (p_company_id IS NULL OR c.company_id = p_company_id)
      AND c.created_at < now() - make_interval(days => c.retention_days)
      AND (
        c.status IS NULL
        OR c.status NOT IN ('in_progress', 'ringing', 'connecting', 'calling')
      )
      AND (
        c.live_status IS NULL
        OR c.live_status NOT IN (
          'ringing', 'connecting', 'ai_speaking', 'user_speaking',
          'transferring'
        )
      )
    ORDER BY c.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ) AS target;

  IF cardinality(v_call_ids) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      SELECT
        c.company_id,
        CASE WHEN c.company_id IS NULL THEN NULL ELSE c.contact_id END,
        'elevenlabs',
        'conversation',
        c.elevenlabs_conversation_id,
        'system'
      FROM public.calls AS c
      WHERE c.id = ANY(v_call_ids)
        AND c.elevenlabs_conversation_id IS NOT NULL
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer
    INTO v_phase_enqueued
    FROM inserted;

    v_external_enqueued := v_external_enqueued + v_phase_enqueued;

    WITH inserted AS (
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      SELECT
        c.company_id,
        CASE WHEN c.company_id IS NULL THEN NULL ELSE c.contact_id END,
        'twilio',
        'call',
        c.twilio_call_sid,
        'system'
      FROM public.calls AS c
      WHERE c.id = ANY(v_call_ids)
        AND c.twilio_call_sid IS NOT NULL
        AND c.twilio_call_sid NOT LIKE 'conv\_%' ESCAPE '\'
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer
    INTO v_phase_enqueued
    FROM inserted;

    v_external_enqueued := v_external_enqueued + v_phase_enqueued;

    -- A call deletion cascades to any remaining recordings. Queue their
    -- external deletion before that cascade.
    WITH inserted AS (
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      SELECT
        cr.company_id,
        CASE
          WHEN c.company_id = cr.company_id THEN c.contact_id
          ELSE NULL
        END,
        'twilio',
        'recording',
        cr.twilio_recording_sid,
        'system'
      FROM public.call_recordings AS cr
      JOIN public.calls AS c
        ON c.id = cr.call_id
      WHERE c.id = ANY(v_call_ids)
        AND cr.twilio_recording_sid IS NOT NULL
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer
    INTO v_phase_enqueued
    FROM inserted;

    v_external_enqueued := v_external_enqueued + v_phase_enqueued;

    -- Learning rows are derived from the call and carry the call UUID in an
    -- explicit source key. Delete them before the parent call disappears.
    WITH deleted AS (
      DELETE FROM public.learning_suggestions AS ls
      WHERE EXISTS (
        SELECT 1
        FROM unnest(v_call_ids) AS linked(call_id)
        WHERE ls.source = 'call:' || linked.call_id::text
      )
      RETURNING ls.company_id
    ),
    stats AS (
      SELECT company_id, count(*)::integer AS affected
      FROM deleted
      GROUP BY company_id
    ),
    audited AS (
      INSERT INTO public.audit_log (
        company_id,
        actor_role,
        action,
        entity_type,
        details
      )
      SELECT
        stats.company_id,
        'system',
        'privacy.retention.learning_suggestions_purged',
        'retention_batch',
        jsonb_build_object(
          'learning_suggestions_deleted',
          stats.affected
        )
      FROM stats
      RETURNING
        (details ->> 'learning_suggestions_deleted')::integer AS affected
    )
    SELECT
      COALESCE(sum(affected), 0)::integer,
      count(*)::integer
    INTO v_learning_deleted, v_phase_audits
    FROM audited;

    v_audit_rows := v_audit_rows + v_phase_audits;

    -- Break the calls.recording_id -> call_recordings cycle explicitly;
    -- call_recordings.call_id then cascades safely when the call is deleted.
    UPDATE public.calls
    SET recording_id = NULL
    WHERE id = ANY(v_call_ids);

    WITH deleted AS (
      DELETE FROM public.calls AS c
      WHERE c.id = ANY(v_call_ids)
      RETURNING c.company_id
    ),
    stats AS (
      SELECT company_id, count(*)::integer AS affected
      FROM deleted
      GROUP BY company_id
    ),
    audited AS (
      INSERT INTO public.audit_log (
        company_id,
        actor_role,
        action,
        entity_type,
        details
      )
      SELECT
        stats.company_id,
        'system',
        'privacy.retention.calls_purged',
        'retention_batch',
        jsonb_build_object('calls_deleted', stats.affected)
      FROM stats
      RETURNING (details ->> 'calls_deleted')::integer AS affected
    )
    SELECT
      COALESCE(sum(affected), 0)::integer,
      count(*)::integer
    INTO v_calls_deleted, v_phase_audits
    FROM audited;

    v_audit_rows := v_audit_rows + v_phase_audits;
  END IF;

  -- Outbound calls have no ElevenLabs conversation column in the audited
  -- schema, but their Twilio Call resource must be removed before the local
  -- identifier is erased.
  SELECT COALESCE(array_agg(target.id), ARRAY[]::uuid[])
  INTO v_outbound_ids
  FROM (
    SELECT oc.id
    FROM public.outbound_calls AS oc
    WHERE (p_company_id IS NULL OR oc.company_id = p_company_id)
      AND oc.created_at < now() - make_interval(days => oc.retention_days)
      AND (
        oc.status IS NULL
        OR oc.status NOT IN ('queued', 'calling', 'in_progress')
      )
    ORDER BY oc.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ) AS target;

  IF cardinality(v_outbound_ids) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      SELECT
        oc.company_id,
        CASE WHEN oc.company_id IS NULL THEN NULL ELSE oc.contact_id END,
        'twilio',
        'call',
        oc.twilio_call_sid,
        'system'
      FROM public.outbound_calls AS oc
      WHERE oc.id = ANY(v_outbound_ids)
        AND oc.twilio_call_sid IS NOT NULL
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::integer
    INTO v_phase_enqueued
    FROM inserted;

    v_external_enqueued := v_external_enqueued + v_phase_enqueued;

    WITH deleted AS (
      DELETE FROM public.outbound_calls AS oc
      WHERE oc.id = ANY(v_outbound_ids)
      RETURNING oc.company_id
    ),
    stats AS (
      SELECT company_id, count(*)::integer AS affected
      FROM deleted
      GROUP BY company_id
    ),
    audited AS (
      INSERT INTO public.audit_log (
        company_id,
        actor_role,
        action,
        entity_type,
        details
      )
      SELECT
        stats.company_id,
        'system',
        'privacy.retention.outbound_calls_purged',
        'retention_batch',
        jsonb_build_object('outbound_calls_deleted', stats.affected)
      FROM stats
      RETURNING (details ->> 'outbound_calls_deleted')::integer AS affected
    )
    SELECT
      COALESCE(sum(affected), 0)::integer,
      count(*)::integer
    INTO v_outbound_deleted, v_phase_audits
    FROM audited;

    v_audit_rows := v_audit_rows + v_phase_audits;
  END IF;

  -- Provider resource identifiers are operational secrets once deletion has
  -- completed. Keep only the short 30-day troubleshooting window. Failed
  -- jobs remain durable until an explicit anonymization retry succeeds.
  WITH targets AS (
    SELECT d.id
    FROM public.privacy_external_deletions AS d
    WHERE d.status = 'completed'
      AND (p_company_id IS NULL OR d.company_id = p_company_id)
      AND COALESCE(d.completed_at, d.updated_at, d.created_at)
          < now() - make_interval(days => d.retention_days)
    ORDER BY COALESCE(d.completed_at, d.updated_at, d.created_at)
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.privacy_external_deletions AS d
    USING targets AS t
    WHERE d.id = t.id
    RETURNING d.company_id
  ),
  stats AS (
    SELECT company_id, count(*)::integer AS affected
    FROM deleted
    GROUP BY company_id
  ),
  audited AS (
    INSERT INTO public.audit_log (
      company_id,
      actor_role,
      action,
      entity_type,
      details
    )
    SELECT
      stats.company_id,
      'system',
      'privacy.retention.external_deletion_log_purged',
      'retention_batch',
      jsonb_build_object('external_deletions_deleted', stats.affected)
    FROM stats
    RETURNING
      (details ->> 'external_deletions_deleted')::integer AS affected
  )
  SELECT
    COALESCE(sum(affected), 0)::integer,
    count(*)::integer
  INTO v_external_deletions_deleted, v_phase_audits
  FROM audited;

  v_audit_rows := v_audit_rows + v_phase_audits;

  -- The ledger stays append-only to service_role. Its finite retention is
  -- enforced only by the restricted SECURITY DEFINER maintenance function.
  WITH stats AS (
    SELECT
      purged_company_id AS company_id,
      affected
    FROM privacy_private.purge_expired_audit_log(
      p_batch_size,
      p_company_id
    )
  ),
  audited AS (
    INSERT INTO public.audit_log (
      company_id,
      actor_role,
      action,
      entity_type,
      details
    )
    SELECT
      stats.company_id,
      'system',
      'privacy.retention.audit_log_purged',
      'retention_batch',
      jsonb_build_object('audit_rows_deleted', stats.affected)
    FROM stats
    RETURNING (details ->> 'audit_rows_deleted')::integer AS affected
  )
  SELECT
    COALESCE(sum(affected), 0)::integer,
    count(*)::integer
  INTO v_audit_rows_deleted, v_phase_audits
  FROM audited;

  v_audit_rows := v_audit_rows + v_phase_audits;

  RETURN jsonb_build_object(
    'calls_transcripts_cleared', v_calls_transcripts_cleared,
    'call_recording_transcripts_cleared',
      v_recording_transcripts_cleared,
    'outbound_transcripts_cleared', v_outbound_transcripts_cleared,
    'call_recordings_deleted', v_recordings_deleted,
    'calls_deleted', v_calls_deleted,
    'outbound_calls_deleted', v_outbound_deleted,
    'learning_suggestions_deleted', v_learning_deleted,
    'external_deletions_deleted', v_external_deletions_deleted,
    'audit_rows_deleted', v_audit_rows_deleted,
    'external_deletions_enqueued', v_external_enqueued,
    'audit_rows_inserted', v_audit_rows
  );
END
$$;

REVOKE ALL
ON FUNCTION public.purge_expired_privacy_data(integer, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.purge_expired_privacy_data(integer, uuid)
TO service_role;

-- ============================================================
-- 9. Non-blocking external-deletion claim RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_privacy_external_deletions(
  p_batch_size integer DEFAULT 25,
  p_company_id uuid DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL
)
RETURNS SETOF public.privacy_external_deletions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 250 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 250'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.id
    FROM public.privacy_external_deletions AS d
    WHERE (p_company_id IS NULL OR d.company_id = p_company_id)
      AND (p_contact_id IS NULL OR d.target_contact_id = p_contact_id)
      AND (
        (
          d.status IN ('pending', 'retry')
          AND d.next_attempt_at <= now()
        )
        OR
        (
          d.status = 'processing'
          AND (
            d.locked_at IS NULL
            OR d.locked_at <= now() - interval '15 minutes'
          )
        )
      )
    ORDER BY d.next_attempt_at, d.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.privacy_external_deletions AS d
    SET
      status = 'processing',
      attempts = d.attempts + 1,
      locked_at = now(),
      updated_at = now()
    FROM candidates AS c
    WHERE d.id = c.id
    RETURNING d.*
  )
  SELECT claimed.*
  FROM claimed
  ORDER BY claimed.created_at;
END
$$;

REVOKE ALL
ON FUNCTION public.claim_privacy_external_deletions(integer, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.claim_privacy_external_deletions(integer, uuid, uuid)
TO service_role;

COMMIT;
