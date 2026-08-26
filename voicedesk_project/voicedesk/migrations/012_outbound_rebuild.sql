-- Migration 012 — native ElevenLabs outbound calls and durable scheduling
--
-- This migration is intentionally backend-only.  The public Data API keeps
-- no direct grants on these operational tables; the service role is the only
-- writer.  The application still applies tenant filters as defense in depth.

BEGIN;

-- ============================================================
-- 1. Production-schema guard
-- ============================================================

DO $$
DECLARE
  missing_tables text[];
  missing_columns text[];
BEGIN
  SELECT array_agg(required.table_name ORDER BY required.table_name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'appointments',
    'audit_log',
    'calls',
    'companies',
    'contacts',
    'dnc_list',
    'learning_suggestions',
    'notifications',
    'outbound_calls',
    'outbound_campaigns',
    'outbound_contacts',
    'phone_numbers',
    'profiles',
    'privacy_external_deletions',
    'subscriptions'
  ]::text[]) AS required(table_name)
  WHERE to_regclass('public.' || quote_ident(required.table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — missing tables: %',
      array_to_string(missing_tables, ', ');
  END IF;

  SELECT array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.column_name
  )
  INTO missing_columns
  FROM (
    VALUES
      ('appointments', 'channel'),
      ('appointments', 'company_id'),
      ('appointments', 'contact_id'),
      ('appointments', 'date'),
      ('appointments', 'id'),
      ('appointments', 'notes'),
      ('appointments', 'source'),
      ('appointments', 'status'),
      ('appointments', 'type'),
      ('audit_log', 'action'),
      ('audit_log', 'actor_role'),
      ('audit_log', 'actor_user_id'),
      ('audit_log', 'company_id'),
      ('audit_log', 'details'),
      ('audit_log', 'entity_id'),
      ('audit_log', 'entity_type'),
      ('audit_log', 'request_id'),
      ('calls', 'company_id'),
      ('calls', 'confidence_score'),
      ('calls', 'contact_id'),
      ('calls', 'created_at'),
      ('calls', 'duration_seconds'),
      ('calls', 'elevenlabs_conversation_id'),
      ('calls', 'ended_at'),
      ('calls', 'caller_phone'),
      ('calls', 'intent'),
      ('calls', 'language_used'),
      ('calls', 'outcome'),
      ('calls', 'status'),
      ('calls', 'twilio_call_sid'),
      ('calls', 'ai_summary'),
      ('calls', 'ai_transcript'),
      ('companies', 'id'),
      ('contacts', 'anonymized_at'),
      ('contacts', 'call_consent'),
      ('contacts', 'company_id'),
      ('contacts', 'created_at'),
      ('contacts', 'id'),
      ('contacts', 'full_name'),
      ('contacts', 'last_interaction_at'),
      ('contacts', 'merged_into_contact_id'),
      ('contacts', 'phone'),
      ('contacts', 'status'),
      ('contacts', 'source'),
      ('contacts', 'updated_at'),
      ('dnc_list', 'company_id'),
      ('dnc_list', 'phone'),
      ('learning_suggestions', 'company_id'),
      ('learning_suggestions', 'confidence'),
      ('learning_suggestions', 'detected_at'),
      ('learning_suggestions', 'id'),
      ('learning_suggestions', 'occurrences'),
      ('learning_suggestions', 'proposed_answer'),
      ('learning_suggestions', 'question'),
      ('learning_suggestions', 'source'),
      ('learning_suggestions', 'status'),
      ('learning_suggestions', 'type'),
      ('notifications', 'body'),
      ('notifications', 'category'),
      ('notifications', 'company_id'),
      ('notifications', 'link'),
      ('notifications', 'title'),
      ('notifications', 'type'),
      ('notifications', 'user_id'),
      ('outbound_calls', 'ai_summary'),
      ('outbound_calls', 'ai_transcript'),
      ('outbound_calls', 'company_id'),
      ('outbound_calls', 'contact_id'),
      ('outbound_calls', 'contact_name'),
      ('outbound_calls', 'contact_phone'),
      ('outbound_calls', 'created_at'),
      ('outbound_calls', 'duration_seconds'),
      ('outbound_calls', 'ended_at'),
      ('outbound_calls', 'id'),
      ('outbound_calls', 'outcome'),
      ('outbound_calls', 'retention_days'),
      ('outbound_calls', 'status'),
      ('outbound_calls', 'transcript_retention_days'),
      ('outbound_calls', 'twilio_call_sid'),
      ('outbound_campaigns', 'company_id'),
      ('outbound_campaigns', 'calls_made'),
      ('outbound_campaigns', 'created_at'),
      ('outbound_campaigns', 'daily_call_limit'),
      ('outbound_campaigns', 'id'),
      ('outbound_campaigns', 'status'),
      ('outbound_campaigns', 'updated_at'),
      ('outbound_contacts', 'anonymized_at'),
      ('outbound_contacts', 'call_attempts'),
      ('outbound_contacts', 'campaign_id'),
      ('outbound_contacts', 'company_id'),
      ('outbound_contacts', 'created_at'),
      ('outbound_contacts', 'full_name'),
      ('outbound_contacts', 'id'),
      ('outbound_contacts', 'last_called_at'),
      ('outbound_contacts', 'outcome'),
      ('outbound_contacts', 'outcome_notes'),
      ('outbound_contacts', 'phone'),
      ('outbound_contacts', 'status'),
      ('phone_numbers', 'company_id'),
      ('phone_numbers', 'created_at'),
      ('phone_numbers', 'elevenlabs_agent_id'),
      ('phone_numbers', 'elevenlabs_phone_number_id'),
      ('phone_numbers', 'id'),
      ('phone_numbers', 'phone_number'),
      ('phone_numbers', 'status'),
      ('profiles', 'company_id'),
      ('profiles', 'role'),
      ('profiles', 'status'),
      ('profiles', 'user_id'),
      ('privacy_external_deletions', 'company_id'),
      ('privacy_external_deletions', 'external_id'),
      ('privacy_external_deletions', 'provider'),
      ('privacy_external_deletions', 'request_id'),
      ('privacy_external_deletions', 'requested_by_user_id'),
      ('privacy_external_deletions', 'requested_by_role'),
      ('privacy_external_deletions', 'resource_type'),
      ('privacy_external_deletions', 'target_contact_id'),
      ('subscriptions', 'company_id'),
      ('subscriptions', 'current_period_end'),
      ('subscriptions', 'current_period_start'),
      ('subscriptions', 'minutes_included'),
      ('subscriptions', 'minutes_used_current_period'),
      ('subscriptions', 'overage_policy'),
      ('subscriptions', 'payment_status'),
      ('subscriptions', 'trial_ends_at')
  ) AS required(table_name, column_name)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required.table_name
   AND actual.column_name = required.column_name
  WHERE actual.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — missing required columns: %',
      array_to_string(missing_columns, ', ');
  END IF;

  IF to_regprocedure('private.current_company_id()') IS NULL
     OR to_regprocedure('private.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — migration 009 tenant helpers are required';
  END IF;

  IF to_regprocedure('crm_private.normalize_e164(text)') IS NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — migration 011 E.164 helper is required';
  END IF;

  IF to_regclass('public.uq_privacy_external_deletions_resource') IS NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — migration 010 provider deletion uniqueness is required';
  END IF;

  IF to_regprocedure(
    'public.enqueue_consent_refusal_cleanup(uuid,text,text)'
  ) IS NULL
     OR to_regprocedure(
       'public.anonymize_contact_data(uuid,uuid,uuid,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — migration 010 consent cleanup RPC is required';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS outbound_private;

REVOKE ALL ON SCHEMA outbound_private
FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA outbound_private TO service_role;

-- ============================================================
-- 2. Tenant voice settings and provider references
-- ============================================================

CREATE TABLE IF NOT EXISTS public.voice_call_settings (
  company_id                  uuid PRIMARY KEY
    REFERENCES public.companies(id) ON DELETE CASCADE,
  timezone                    text NOT NULL DEFAULT 'America/Toronto',
  -- NULL deliberately preserves the existing 24/7 inbound behaviour.
  business_hours              jsonb,
  outbound_business_hours     jsonb NOT NULL DEFAULT
    '{"1":[{"start":"09:00","end":"20:00"}],"2":[{"start":"09:00","end":"20:00"}],"3":[{"start":"09:00","end":"20:00"}],"4":[{"start":"09:00","end":"20:00"}],"5":[{"start":"09:00","end":"20:00"}],"6":[],"7":[]}'::jsonb,
  after_hours_message_fr      text NOT NULL DEFAULT
    'Nos bureaux sont actuellement fermés. Je peux prendre vos coordonnées et transmettre votre demande à notre équipe.',
  after_hours_message_en      text NOT NULL DEFAULT
    'Our office is currently closed. I can take your contact details and forward your request to our team.',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_call_settings_timezone_check
    CHECK (timezone = btrim(timezone) AND length(timezone) BETWEEN 1 AND 128),
  CONSTRAINT voice_call_settings_business_hours_check
    CHECK (business_hours IS NULL OR jsonb_typeof(business_hours) = 'object'),
  CONSTRAINT voice_call_settings_outbound_hours_check
    CHECK (jsonb_typeof(outbound_business_hours) = 'object'),
  CONSTRAINT voice_call_settings_messages_check
    CHECK (
      length(btrim(after_hours_message_fr)) BETWEEN 1 AND 1000
      AND length(btrim(after_hours_message_en)) BETWEEN 1 AND 1000
    )
);

ALTER TABLE public.outbound_campaigns
  ADD COLUMN IF NOT EXISTS outbound_phone_number_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_campaigns'::regclass
      AND conname = 'outbound_campaigns_phone_number_fk'
  ) THEN
    ALTER TABLE public.outbound_campaigns
      ADD CONSTRAINT outbound_campaigns_phone_number_fk
      FOREIGN KEY (outbound_phone_number_id)
      REFERENCES public.phone_numbers(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE public.outbound_calls
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS outbound_contact_id uuid,
  ADD COLUMN IF NOT EXISTS elevenlabs_conversation_id text;

-- The repository contains two historical outbound status contracts.  Keep
-- their values readable, add the durable queue value, and enforce the union
-- for every new/updated row.  NOT VALID avoids rewriting unknown legacy rows.
UPDATE public.outbound_calls
SET status = 'failed'
WHERE status = 'error';

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.outbound_calls'::regclass
      AND con.contype = 'c'
      AND position('status' IN lower(pg_get_constraintdef(con.oid))) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE public.outbound_calls DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE public.outbound_calls
    ADD CONSTRAINT outbound_calls_status_check
    CHECK (status IS NULL OR status IN (
      'to_call', 'queued', 'calling', 'in_progress', 'completed',
      'voicemail', 'no_answer', 'failed'
    )) NOT VALID;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.outbound_calls'::regclass
      AND conname = 'outbound_calls_campaign_fk'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_campaign_fk
      FOREIGN KEY (campaign_id)
      REFERENCES public.outbound_campaigns(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.outbound_calls'::regclass
      AND conname = 'outbound_calls_outbound_contact_fk'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_outbound_contact_fk
      FOREIGN KEY (outbound_contact_id)
      REFERENCES public.outbound_contacts(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- ============================================================
-- 3. Durable queue, attempts and callback idempotency
-- ============================================================

CREATE TABLE IF NOT EXISTS public.outbound_call_queue (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  campaign_id               uuid NOT NULL
    REFERENCES public.outbound_campaigns(id) ON DELETE CASCADE,
  outbound_contact_id       uuid NOT NULL
    REFERENCES public.outbound_contacts(id) ON DELETE CASCADE,
  contact_id                uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  outbound_phone_number_id  uuid
    REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  contact_phone_e164        text,
  status                    text NOT NULL DEFAULT 'pending',
  scheduled_for             timestamptz NOT NULL DEFAULT now(),
  next_attempt_at           timestamptz NOT NULL DEFAULT now(),
  attempt_count             integer NOT NULL DEFAULT 0,
  provider_attempt_count    integer NOT NULL DEFAULT 0,
  max_attempts              integer NOT NULL DEFAULT 3,
  -- Deliberately not an FK: attempts cascade from this row and a circular FK
  -- would make retention/deletion unnecessarily fragile. RPCs validate it.
  current_attempt_id        uuid,
  claimed_by                text,
  claimed_at                timestamptz,
  lease_expires_at          timestamptz,
  reserved_minutes          numeric(8,2) NOT NULL DEFAULT 0,
  block_reason              text,
  last_error_code           text,
  completed_at              timestamptz,
  retention_days            integer NOT NULL DEFAULT 90,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_call_queue_status_check CHECK (status IN (
    'pending', 'claimed', 'dispatching', 'in_progress',
    'retry_scheduled', 'dispatch_unknown', 'manual_review',
    'completed', 'failed', 'blocked', 'cancelled'
  )),
  CONSTRAINT outbound_call_queue_phone_check CHECK (
    contact_phone_e164 IS NULL
    OR contact_phone_e164 ~ '^[+][1-9][0-9]{7,14}$'
  ),
  CONSTRAINT outbound_call_queue_callable_phone_check CHECK (
    status NOT IN (
      'pending', 'claimed', 'dispatching', 'in_progress',
      'retry_scheduled', 'dispatch_unknown', 'manual_review'
    )
    OR contact_phone_e164 IS NOT NULL
  ),
  CONSTRAINT outbound_call_queue_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10
  ),
  CONSTRAINT outbound_call_queue_provider_attempts_check CHECK (
    provider_attempt_count >= 0
    AND provider_attempt_count <= attempt_count
  ),
  CONSTRAINT outbound_call_queue_reserved_minutes_check CHECK (
    reserved_minutes >= 0 AND reserved_minutes <= 30
  ),
  CONSTRAINT outbound_call_queue_retention_check CHECK (
    retention_days BETWEEN 1 AND 3650
  ),
  CONSTRAINT outbound_call_queue_claim_check CHECK (
    (status <> 'claimed')
    OR (
      claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

ALTER TABLE public.outbound_call_queue
  ADD COLUMN IF NOT EXISTS provider_attempt_count integer;

UPDATE public.outbound_call_queue
SET provider_attempt_count = LEAST(attempt_count, max_attempts)
WHERE provider_attempt_count IS NULL;

ALTER TABLE public.outbound_call_queue
  ALTER COLUMN provider_attempt_count SET DEFAULT 0,
  ALTER COLUMN provider_attempt_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_queue'::regclass
      AND conname = 'outbound_call_queue_provider_attempts_check'
  ) THEN
    ALTER TABLE public.outbound_call_queue
      ADD CONSTRAINT outbound_call_queue_provider_attempts_check
      CHECK (
        provider_attempt_count >= 0
        AND provider_attempt_count <= attempt_count
      );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_queue'::regclass
      AND conname = 'outbound_call_queue_status_check'
      AND position('manual_review' IN pg_get_constraintdef(oid)) = 0
  ) THEN
    ALTER TABLE public.outbound_call_queue
      DROP CONSTRAINT outbound_call_queue_status_check;
    ALTER TABLE public.outbound_call_queue
      ADD CONSTRAINT outbound_call_queue_status_check CHECK (status IN (
        'pending', 'claimed', 'dispatching', 'in_progress',
        'retry_scheduled', 'dispatch_unknown', 'manual_review',
        'completed', 'failed', 'blocked', 'cancelled'
      ));
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_queue'::regclass
      AND conname = 'outbound_call_queue_callable_phone_check'
      AND position('manual_review' IN pg_get_constraintdef(oid)) = 0
  ) THEN
    ALTER TABLE public.outbound_call_queue
      DROP CONSTRAINT outbound_call_queue_callable_phone_check;
    ALTER TABLE public.outbound_call_queue
      ADD CONSTRAINT outbound_call_queue_callable_phone_check CHECK (
        status NOT IN (
          'pending', 'claimed', 'dispatching', 'in_progress',
          'retry_scheduled', 'dispatch_unknown', 'manual_review'
        )
        OR contact_phone_e164 IS NOT NULL
      );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_queue'::regclass
      AND conname = 'outbound_call_queue_reserved_minutes_check'
      AND position('<= 30' IN pg_get_constraintdef(oid)) = 0
  ) THEN
    ALTER TABLE public.outbound_call_queue
      DROP CONSTRAINT outbound_call_queue_reserved_minutes_check;
    -- Do not rewrite/abort a live rollout if a previously claimed row used
    -- the old wider bound. New and subsequently updated rows are constrained.
    ALTER TABLE public.outbound_call_queue
      ADD CONSTRAINT outbound_call_queue_reserved_minutes_check
      CHECK (reserved_minutes >= 0 AND reserved_minutes <= 30) NOT VALID;
  END IF;
END
$$;

-- Existing tenants receive safe defaults during rollout.  The enqueue RPC
-- repeats this insert so companies created after migration 012 cannot be
-- stranded without an outbound-hours policy.
INSERT INTO public.voice_call_settings (company_id)
SELECT company.id
FROM public.companies AS company
ON CONFLICT (company_id) DO NOTHING;

CREATE OR REPLACE FUNCTION outbound_private.ensure_voice_call_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.voice_call_settings (company_id)
  VALUES (NEW.id)
  ON CONFLICT (company_id) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS companies_ensure_voice_call_settings
ON public.companies;

CREATE TRIGGER companies_ensure_voice_call_settings
AFTER INSERT ON public.companies
FOR EACH ROW
EXECUTE FUNCTION outbound_private.ensure_voice_call_settings();

CREATE TABLE IF NOT EXISTS public.outbound_call_attempts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  queue_id                        uuid NOT NULL
    REFERENCES public.outbound_call_queue(id) ON DELETE CASCADE,
  attempt_no                      integer NOT NULL,
  status                          text NOT NULL DEFAULT 'dispatching',
  elevenlabs_conversation_id      text,
  twilio_call_sid                 text,
  local_call_date                 date,
  duration_seconds                integer NOT NULL DEFAULT 0,
  error_code                      text,
  started_at                      timestamptz NOT NULL DEFAULT now(),
  dispatched_at                   timestamptz,
  connected_at                    timestamptz,
  ended_at                        timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_call_attempts_number_check
    CHECK (attempt_no >= 1),
  CONSTRAINT outbound_call_attempts_status_check CHECK (status IN (
    'dispatching', 'in_progress', 'completed', 'no_answer',
    'retryable_failure', 'configuration_failure', 'failed',
    'dispatch_unknown', 'cancelled'
  )),
  CONSTRAINT outbound_call_attempts_duration_check
    CHECK (duration_seconds >= 0),
  CONSTRAINT outbound_call_attempts_queue_attempt_unique
    UNIQUE (queue_id, attempt_no)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_attempts'::regclass
      AND conname = 'outbound_call_attempts_number_check'
      AND pg_get_constraintdef(oid) ~ '10'
  ) THEN
    ALTER TABLE public.outbound_call_attempts
      DROP CONSTRAINT outbound_call_attempts_number_check;
    ALTER TABLE public.outbound_call_attempts
      ADD CONSTRAINT outbound_call_attempts_number_check
      CHECK (attempt_no >= 1);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.outbound_call_attempts'::regclass
      AND conname = 'outbound_call_attempts_status_check'
      AND position(
        'configuration_failure' IN pg_get_constraintdef(oid)
      ) = 0
  ) THEN
    ALTER TABLE public.outbound_call_attempts
      DROP CONSTRAINT outbound_call_attempts_status_check;
    ALTER TABLE public.outbound_call_attempts
      ADD CONSTRAINT outbound_call_attempts_status_check CHECK (status IN (
        'dispatching', 'in_progress', 'completed', 'no_answer',
        'retryable_failure', 'configuration_failure', 'failed',
        'dispatch_unknown', 'cancelled'
      ));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.outbound_callback_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  queue_id            uuid NOT NULL
    REFERENCES public.outbound_call_queue(id) ON DELETE CASCADE,
  attempt_id          uuid NOT NULL
    REFERENCES public.outbound_call_attempts(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'elevenlabs',
  event_key           text NOT NULL,
  event_type          text NOT NULL,
  payload_sha256      text NOT NULL,
  processed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_callback_events_provider_check
    CHECK (provider = 'elevenlabs'),
  CONSTRAINT outbound_callback_events_key_check
    CHECK (length(event_key) BETWEEN 1 AND 512),
  CONSTRAINT outbound_callback_events_type_check
    CHECK (length(event_type) BETWEEN 1 AND 128),
  CONSTRAINT outbound_callback_events_hash_check
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT outbound_callback_events_provider_key_unique
    UNIQUE (provider, event_key)
);

-- Signed inbound post-call webhooks are acknowledged after this durable job
-- is committed. Provider payload PII is kept only until atomic CRM effects
-- complete (or the bounded retry budget reaches a terminal failure).
ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS post_call_processed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.post_call_processing_jobs (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL
    REFERENCES public.companies(id) ON DELETE CASCADE,
  call_id                       uuid NOT NULL
    REFERENCES public.calls(id) ON DELETE CASCADE,
  contact_id                    uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  contact_created               boolean NOT NULL DEFAULT false,
  conversation_id              text NOT NULL,
  twilio_call_sid               text,
  caller_phone_e164             text,
  duration_seconds              integer NOT NULL DEFAULT 0,
  language_used                 text NOT NULL DEFAULT 'fr-CA',
  transcript                    text,
  provider_summary              text,
  appointment_requested         boolean NOT NULL DEFAULT false,
  status                        text NOT NULL DEFAULT 'pending',
  attempt_count                 integer NOT NULL DEFAULT 0,
  max_attempts                  integer NOT NULL DEFAULT 5,
  next_attempt_at               timestamptz NOT NULL DEFAULT now(),
  claimed_by                    text,
  claimed_at                    timestamptz,
  lease_expires_at              timestamptz,
  last_error_code               text,
  last_error_message            text,
  appointment_id                uuid,
  learning_suggestions_created  integer NOT NULL DEFAULT 0,
  payload_scrubbed_at           timestamptz,
  completed_at                  timestamptz,
  retention_days                integer NOT NULL DEFAULT 30,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_call_jobs_status_check CHECK (status IN (
    'pending', 'processing', 'retry_scheduled',
    'completed', 'failed', 'cancelled'
  )),
  CONSTRAINT post_call_jobs_conversation_check CHECK (
    conversation_id = btrim(conversation_id)
    AND length(conversation_id) BETWEEN 1 AND 255
    AND conversation_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT post_call_jobs_phone_check CHECK (
    caller_phone_e164 IS NULL
    OR caller_phone_e164 ~ '^[+][1-9][0-9]{7,14}$'
  ),
  CONSTRAINT post_call_jobs_duration_check CHECK (
    duration_seconds BETWEEN 0 AND 86400
  ),
  CONSTRAINT post_call_jobs_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10
  ),
  CONSTRAINT post_call_jobs_learning_count_check CHECK (
    learning_suggestions_created >= 0
  ),
  CONSTRAINT post_call_jobs_retention_check CHECK (
    retention_days BETWEEN 1 AND 365
  ),
  CONSTRAINT post_call_jobs_claim_check CHECK (
    status <> 'processing'
    OR (
      claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

ALTER TABLE public.post_call_processing_jobs
  ADD COLUMN IF NOT EXISTS contact_created boolean;

UPDATE public.post_call_processing_jobs
SET contact_created = false
WHERE contact_created IS NULL;

ALTER TABLE public.post_call_processing_jobs
  ALTER COLUMN contact_created SET DEFAULT false,
  ALTER COLUMN contact_created SET NOT NULL;

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS post_call_job_id uuid;

ALTER TABLE public.learning_suggestions
  ADD COLUMN IF NOT EXISTS post_call_job_id uuid,
  ADD COLUMN IF NOT EXISTS post_call_item_no integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.post_call_processing_jobs'::regclass
      AND conname = 'post_call_jobs_id_company_unique'
  ) THEN
    ALTER TABLE public.post_call_processing_jobs
      ADD CONSTRAINT post_call_jobs_id_company_unique
      UNIQUE (id, company_id);
  END IF;

  ALTER TABLE public.appointments
    DROP CONSTRAINT IF EXISTS appointments_post_call_job_fk;

  ALTER TABLE public.appointments
    ADD CONSTRAINT appointments_post_call_job_fk
    FOREIGN KEY (post_call_job_id, company_id)
    REFERENCES public.post_call_processing_jobs(id, company_id)
    ON DELETE SET NULL (post_call_job_id);

  ALTER TABLE public.learning_suggestions
    DROP CONSTRAINT IF EXISTS learning_suggestions_post_call_job_fk;

  ALTER TABLE public.learning_suggestions
    ADD CONSTRAINT learning_suggestions_post_call_job_fk
    FOREIGN KEY (post_call_job_id, company_id)
    REFERENCES public.post_call_processing_jobs(id, company_id)
    ON DELETE SET NULL (post_call_job_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.learning_suggestions'::regclass
      AND conname = 'learning_suggestions_post_call_item_check'
  ) THEN
    ALTER TABLE public.learning_suggestions
      ADD CONSTRAINT learning_suggestions_post_call_item_check
      CHECK (post_call_item_no IS NULL OR post_call_item_no BETWEEN 1 AND 10);
  END IF;
END
$$;

ALTER TABLE public.outbound_calls
  ADD COLUMN IF NOT EXISTS queue_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.outbound_calls'::regclass
      AND conname = 'outbound_calls_queue_fk'
  ) THEN
    ALTER TABLE public.outbound_calls
      ADD CONSTRAINT outbound_calls_queue_fk
      FOREIGN KEY (queue_id)
      REFERENCES public.outbound_call_queue(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Verify all columns created above as well as the exact critical UUID/JSON
-- types.  CREATE TABLE IF NOT EXISTS must not silently accept a partial table.
DO $$
DECLARE
  missing_columns text[];
  wrong_types text[];
BEGIN
  SELECT array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.column_name
  )
  INTO missing_columns
  FROM (
    VALUES
      ('calls', 'post_call_processed_at'),
      ('outbound_call_attempts', 'attempt_no'),
      ('outbound_call_attempts', 'company_id'),
      ('outbound_call_attempts', 'duration_seconds'),
      ('outbound_call_attempts', 'dispatched_at'),
      ('outbound_call_attempts', 'elevenlabs_conversation_id'),
      ('outbound_call_attempts', 'error_code'),
      ('outbound_call_attempts', 'id'),
      ('outbound_call_attempts', 'local_call_date'),
      ('outbound_call_attempts', 'queue_id'),
      ('outbound_call_attempts', 'status'),
      ('outbound_call_attempts', 'twilio_call_sid'),
      ('outbound_call_queue', 'attempt_count'),
      ('outbound_call_queue', 'block_reason'),
      ('outbound_call_queue', 'campaign_id'),
      ('outbound_call_queue', 'claimed_by'),
      ('outbound_call_queue', 'company_id'),
      ('outbound_call_queue', 'contact_id'),
      ('outbound_call_queue', 'contact_phone_e164'),
      ('outbound_call_queue', 'current_attempt_id'),
      ('outbound_call_queue', 'id'),
      ('outbound_call_queue', 'lease_expires_at'),
      ('outbound_call_queue', 'max_attempts'),
      ('outbound_call_queue', 'next_attempt_at'),
      ('outbound_call_queue', 'outbound_contact_id'),
      ('outbound_call_queue', 'outbound_phone_number_id'),
      ('outbound_call_queue', 'provider_attempt_count'),
      ('outbound_call_queue', 'reserved_minutes'),
      ('outbound_call_queue', 'scheduled_for'),
      ('outbound_call_queue', 'status'),
      ('outbound_callback_events', 'attempt_id'),
      ('outbound_callback_events', 'event_key'),
      ('outbound_callback_events', 'payload_sha256'),
      ('outbound_callback_events', 'provider'),
      ('outbound_callback_events', 'queue_id'),
      ('post_call_processing_jobs', 'appointment_id'),
      ('post_call_processing_jobs', 'appointment_requested'),
      ('post_call_processing_jobs', 'attempt_count'),
      ('post_call_processing_jobs', 'call_id'),
      ('post_call_processing_jobs', 'caller_phone_e164'),
      ('post_call_processing_jobs', 'company_id'),
      ('post_call_processing_jobs', 'contact_id'),
      ('post_call_processing_jobs', 'contact_created'),
      ('post_call_processing_jobs', 'conversation_id'),
      ('post_call_processing_jobs', 'id'),
      ('post_call_processing_jobs', 'lease_expires_at'),
      ('post_call_processing_jobs', 'max_attempts'),
      ('post_call_processing_jobs', 'next_attempt_at'),
      ('post_call_processing_jobs', 'payload_scrubbed_at'),
      ('post_call_processing_jobs', 'status'),
      ('post_call_processing_jobs', 'transcript'),
      ('outbound_calls', 'campaign_id'),
      ('outbound_calls', 'elevenlabs_conversation_id'),
      ('outbound_calls', 'outbound_contact_id'),
      ('outbound_calls', 'queue_id'),
      ('outbound_campaigns', 'outbound_phone_number_id'),
      ('voice_call_settings', 'business_hours'),
      ('voice_call_settings', 'company_id'),
      ('voice_call_settings', 'outbound_business_hours'),
      ('voice_call_settings', 'timezone')
  ) AS required(table_name, column_name)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required.table_name
   AND actual.column_name = required.column_name
  WHERE actual.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — incomplete created schema: %',
      array_to_string(missing_columns, ', ');
  END IF;

  SELECT array_agg(
    required.table_name || '.' || required.column_name
      || ' expected ' || required.udt_name || ' got ' || actual.udt_name
    ORDER BY required.table_name, required.column_name
  )
  INTO wrong_types
  FROM (
    VALUES
      ('calls', 'post_call_processed_at', 'timestamptz'),
      ('outbound_call_attempts', 'id', 'uuid'),
      ('outbound_call_attempts', 'queue_id', 'uuid'),
      ('outbound_call_attempts', 'dispatched_at', 'timestamptz'),
      ('outbound_call_queue', 'id', 'uuid'),
      ('outbound_call_queue', 'company_id', 'uuid'),
      ('outbound_callback_events', 'id', 'uuid'),
      ('outbound_callback_events', 'attempt_id', 'uuid'),
      ('post_call_processing_jobs', 'call_id', 'uuid'),
      ('post_call_processing_jobs', 'company_id', 'uuid'),
      ('post_call_processing_jobs', 'id', 'uuid'),
      ('outbound_calls', 'queue_id', 'uuid'),
      ('outbound_calls', 'ai_transcript', 'jsonb'),
      ('outbound_calls', 'contact_phone', 'text'),
      ('outbound_calls', 'outcome', 'text'),
      ('outbound_calls', 'status', 'text'),
      ('outbound_campaigns', 'outbound_phone_number_id', 'uuid'),
      ('voice_call_settings', 'business_hours', 'jsonb'),
      ('voice_call_settings', 'outbound_business_hours', 'jsonb')
  ) AS required(table_name, column_name, udt_name)
  JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required.table_name
   AND actual.column_name = required.column_name
  WHERE actual.udt_name <> required.udt_name;

  IF wrong_types IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 012 aborted — incompatible column types: %',
      array_to_string(wrong_types, ', ');
  END IF;
END
$$;

-- ============================================================
-- 4. Concurrency, lookup and retention indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_phone_number
  ON public.outbound_campaigns(company_id, outbound_phone_number_id)
  WHERE outbound_phone_number_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_phone_number_fk
  ON public.outbound_campaigns(outbound_phone_number_id)
  WHERE outbound_phone_number_id IS NOT NULL;

DROP INDEX IF EXISTS public.uq_outbound_queue_campaign_contact_active;

CREATE UNIQUE INDEX uq_outbound_queue_campaign_contact_active
  ON public.outbound_call_queue(campaign_id, outbound_contact_id)
  WHERE status IN (
    'pending', 'claimed', 'dispatching', 'in_progress',
    'retry_scheduled', 'dispatch_unknown', 'manual_review'
  );

DROP INDEX IF EXISTS public.uq_outbound_queue_contact_inflight;

CREATE UNIQUE INDEX uq_outbound_queue_contact_inflight
  ON public.outbound_call_queue(company_id, contact_phone_e164)
  WHERE contact_phone_e164 IS NOT NULL
    AND status IN (
      'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
      'manual_review'
    );

CREATE INDEX IF NOT EXISTS idx_outbound_queue_due
  ON public.outbound_call_queue(
    status, next_attempt_at, scheduled_for, created_at
  )
  WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_outbound_queue_lease
  ON public.outbound_call_queue(status, lease_expires_at)
  WHERE status IN ('claimed', 'dispatching');

CREATE INDEX IF NOT EXISTS idx_outbound_queue_company_campaign
  ON public.outbound_call_queue(company_id, campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_campaign_fk
  ON public.outbound_call_queue(campaign_id);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_outbound_contact_fk
  ON public.outbound_call_queue(outbound_contact_id);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_contact_fk
  ON public.outbound_call_queue(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_queue_phone_number_fk
  ON public.outbound_call_queue(outbound_phone_number_id)
  WHERE outbound_phone_number_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_queue_terminal_retention
  ON public.outbound_call_queue(completed_at, updated_at)
  WHERE status IN ('completed', 'failed', 'blocked', 'cancelled');

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_attempt_conversation
  ON public.outbound_call_attempts(elevenlabs_conversation_id)
  WHERE elevenlabs_conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_attempt_twilio_call
  ON public.outbound_call_attempts(twilio_call_sid)
  WHERE twilio_call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_attempt_queue_created
  ON public.outbound_call_attempts(queue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbound_attempt_daily_limit
  ON public.outbound_call_attempts(company_id, local_call_date, status);

CREATE INDEX IF NOT EXISTS idx_outbound_callback_attempt
  ON public.outbound_callback_events(attempt_id, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_callback_queue_fk
  ON public.outbound_callback_events(queue_id);

CREATE INDEX IF NOT EXISTS idx_outbound_callback_company_fk
  ON public.outbound_callback_events(company_id);

CREATE INDEX IF NOT EXISTS idx_outbound_callback_retention
  ON public.outbound_callback_events(created_at)
  WHERE processed_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_post_call_jobs_conversation
  ON public.post_call_processing_jobs(conversation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_post_call_jobs_call
  ON public.post_call_processing_jobs(call_id);

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_company_fk
  ON public.post_call_processing_jobs(company_id);

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_contact_fk
  ON public.post_call_processing_jobs(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_due
  ON public.post_call_processing_jobs(status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_lease
  ON public.post_call_processing_jobs(lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_retention
  ON public.post_call_processing_jobs(completed_at, updated_at)
  WHERE status IN ('completed', 'failed', 'cancelled');

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_post_call_job
  ON public.appointments(post_call_job_id)
  WHERE post_call_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_post_call_item
  ON public.learning_suggestions(post_call_job_id, post_call_item_no)
  WHERE post_call_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_calls_queue
  ON public.outbound_calls(queue_id)
  WHERE queue_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_calls_elevenlabs_conversation
  ON public.outbound_calls(elevenlabs_conversation_id)
  WHERE elevenlabs_conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_calls_campaign_fk
  ON public.outbound_calls(campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_calls_outbound_contact_fk
  ON public.outbound_calls(outbound_contact_id)
  WHERE outbound_contact_id IS NOT NULL;

-- Keep the legacy campaign counters/status used by the current UI in sync
-- with the durable queue.  A call counts only once the provider has returned
-- an identifier; pre-dispatch failures therefore do not inflate calls_made.
CREATE OR REPLACE FUNCTION outbound_private.refresh_campaign_state(
  p_campaign_id uuid,
  p_company_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_calls_made integer;
  v_has_active_work boolean;
BEGIN
  IF p_campaign_id IS NULL OR p_company_id IS NULL THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT q.outbound_contact_id)::integer
  INTO v_calls_made
  FROM public.outbound_call_attempts AS attempt
  JOIN public.outbound_call_queue AS q
    ON q.id = attempt.queue_id
   AND q.company_id = attempt.company_id
  WHERE q.campaign_id = p_campaign_id
    AND q.company_id = p_company_id
    AND attempt.dispatched_at IS NOT NULL;

  SELECT EXISTS (
    SELECT 1
    FROM public.outbound_call_queue AS q
    WHERE q.campaign_id = p_campaign_id
      AND q.company_id = p_company_id
      AND q.status IN (
        'pending', 'claimed', 'dispatching', 'in_progress',
        'retry_scheduled', 'dispatch_unknown', 'manual_review'
      )
  )
  INTO v_has_active_work;

  UPDATE public.outbound_campaigns AS campaign
  SET
    calls_made = v_calls_made,
    status = CASE
      WHEN NOT v_has_active_work
           AND campaign.status IN ('paused', 'draft') THEN campaign.status
      WHEN NOT v_has_active_work THEN 'completed'
      WHEN campaign.status = 'completed' THEN 'active'
      ELSE campaign.status
    END,
    updated_at = now()
  WHERE campaign.id = p_campaign_id
    AND campaign.company_id = p_company_id;
END
$$;

-- ============================================================
-- 5. Privacy hooks compatible with migration 010
-- ============================================================

CREATE OR REPLACE FUNCTION outbound_private.enqueue_outbound_provider_resources(
  p_company_id uuid,
  p_contact_id uuid,
  p_elevenlabs_conversation_id text,
  p_twilio_call_sid text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contact_id uuid := CASE
    WHEN p_company_id IS NULL THEN NULL ELSE p_contact_id END;
  v_conversation_id text := NULLIF(
    btrim(p_elevenlabs_conversation_id),
    ''
  );
  v_call_sid text := NULLIF(btrim(p_twilio_call_sid), '');
BEGIN
  IF v_conversation_id IS NOT NULL THEN
    INSERT INTO public.privacy_external_deletions (
      company_id,
      target_contact_id,
      provider,
      resource_type,
      external_id,
      requested_by_role
    )
    VALUES (
      p_company_id,
      v_contact_id,
      'elevenlabs',
      'conversation',
      v_conversation_id,
      'system'
    )
    ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM public.privacy_external_deletions AS deletion
      WHERE deletion.provider = 'elevenlabs'
        AND deletion.resource_type = 'conversation'
        AND deletion.external_id = v_conversation_id
        AND deletion.company_id IS DISTINCT FROM p_company_id
    ) THEN
      RAISE EXCEPTION 'provider resource tenant conflict'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_call_sid IS NOT NULL THEN
    INSERT INTO public.privacy_external_deletions (
      company_id,
      target_contact_id,
      provider,
      resource_type,
      external_id,
      requested_by_role
    )
    VALUES (
      p_company_id,
      v_contact_id,
      'twilio',
      'call',
      v_call_sid,
      'system'
    )
    ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM public.privacy_external_deletions AS deletion
      WHERE deletion.provider = 'twilio'
        AND deletion.resource_type = 'call'
        AND deletion.external_id = v_call_sid
        AND deletion.company_id IS DISTINCT FROM p_company_id
    ) THEN
      RAISE EXCEPTION 'provider resource tenant conflict'
        USING ERRCODE = '23505';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION outbound_private.enqueue_outbound_provider_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_company_id uuid;
  v_contact_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'outbound_calls' THEN
    v_company_id := OLD.company_id;
    v_contact_id := CASE
      WHEN OLD.company_id IS NULL THEN NULL
      ELSE OLD.contact_id
    END;
  ELSIF TG_TABLE_NAME = 'outbound_call_attempts' THEN
    v_company_id := OLD.company_id;

    SELECT q.contact_id
    INTO v_contact_id
    FROM public.outbound_call_queue AS q
    WHERE q.id = OLD.queue_id
      AND q.company_id = OLD.company_id;
  ELSE
    RAISE EXCEPTION 'unsupported provider-deletion trigger table: %',
      TG_TABLE_NAME;
  END IF;

  PERFORM outbound_private.enqueue_outbound_provider_resources(
    v_company_id,
    v_contact_id,
    OLD.elevenlabs_conversation_id,
    OLD.twilio_call_sid
  );

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS outbound_calls_enqueue_provider_deletion
ON public.outbound_calls;

CREATE TRIGGER outbound_calls_enqueue_provider_deletion
BEFORE DELETE ON public.outbound_calls
FOR EACH ROW
EXECUTE FUNCTION outbound_private.enqueue_outbound_provider_deletion();

DROP TRIGGER IF EXISTS outbound_attempts_enqueue_provider_deletion
ON public.outbound_call_attempts;

CREATE TRIGGER outbound_attempts_enqueue_provider_deletion
BEFORE DELETE ON public.outbound_call_attempts
FOR EACH ROW
EXECUTE FUNCTION outbound_private.enqueue_outbound_provider_deletion();

-- Migration 010 anonymizes contacts without knowing about migration 012.
-- These hooks cancel any queued work and erase the duplicated destination.
CREATE OR REPLACE FUNCTION outbound_private.scrub_queue_for_crm_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_company_id uuid;
  v_contact_id uuid;
  v_is_privacy_delete boolean;
  v_campaign_ids uuid[] := ARRAY[]::uuid[];
  v_campaign_id uuid;
  v_attempt record;
  v_outbound_call record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_contact_id := OLD.id;
    v_is_privacy_delete := true;
  ELSE
    v_company_id := NEW.company_id;
    v_contact_id := NEW.id;
    v_is_privacy_delete := NEW.anonymized_at IS NOT NULL
      OR NEW.status = 'anonymized';

    IF NEW.merged_into_contact_id IS NOT NULL
       AND NEW.merged_into_contact_id IS DISTINCT FROM
         OLD.merged_into_contact_id THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.contacts AS primary_contact
        WHERE primary_contact.id = NEW.merged_into_contact_id
          AND primary_contact.company_id = NEW.company_id
          AND primary_contact.status NOT IN ('archived', 'anonymized')
          AND primary_contact.anonymized_at IS NULL
      ) THEN
        RAISE EXCEPTION 'merged contact target is invalid'
          USING ERRCODE = '23503';
      END IF;

      UPDATE public.outbound_call_queue AS q
      SET
        contact_id = NEW.merged_into_contact_id,
        updated_at = now()
      WHERE q.company_id = NEW.company_id
        AND q.contact_id = OLD.id;
    END IF;
  END IF;

  IF v_is_privacy_delete THEN
    SELECT COALESCE(
      array_agg(DISTINCT q.campaign_id),
      ARRAY[]::uuid[]
    )
    INTO v_campaign_ids
    FROM public.outbound_call_queue AS q
    WHERE q.company_id = v_company_id
      AND q.contact_id = v_contact_id;

    -- Lock provider attempts before their parent queue rows. Every RPC that
    -- touches both relations follows this same order.
    FOR v_attempt IN
      SELECT
        attempt.company_id,
        attempt.elevenlabs_conversation_id,
        attempt.twilio_call_sid
      FROM public.outbound_call_attempts AS attempt
      JOIN public.outbound_call_queue AS q
        ON q.id = attempt.queue_id
       AND q.company_id = attempt.company_id
      WHERE q.company_id = v_company_id
        AND q.contact_id = v_contact_id
      ORDER BY attempt.id
      FOR UPDATE OF attempt
    LOOP
      PERFORM outbound_private.enqueue_outbound_provider_resources(
        v_attempt.company_id,
        v_contact_id,
        v_attempt.elevenlabs_conversation_id,
        v_attempt.twilio_call_sid
      );
    END LOOP;

    FOR v_outbound_call IN
      SELECT
        outbound_call.company_id,
        outbound_call.elevenlabs_conversation_id,
        outbound_call.twilio_call_sid
      FROM public.outbound_calls AS outbound_call
      JOIN public.outbound_call_queue AS q
        ON q.id = outbound_call.queue_id
       AND q.company_id = outbound_call.company_id
      WHERE q.company_id = v_company_id
        AND q.contact_id = v_contact_id
      ORDER BY outbound_call.id
      FOR UPDATE OF outbound_call
    LOOP
      PERFORM outbound_private.enqueue_outbound_provider_resources(
        v_outbound_call.company_id,
        v_contact_id,
        v_outbound_call.elevenlabs_conversation_id,
        v_outbound_call.twilio_call_sid
      );
    END LOOP;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.status
        ELSE 'cancelled'
      END,
      elevenlabs_conversation_id = NULL,
      twilio_call_sid = NULL,
      error_code = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.error_code
        ELSE 'contact_anonymized'
      END,
      ended_at = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.ended_at
        ELSE COALESCE(attempt.ended_at, now())
      END,
      updated_at = now()
    WHERE attempt.queue_id IN (
      SELECT q.id
      FROM public.outbound_call_queue AS q
      WHERE q.company_id = v_company_id
        AND q.contact_id = v_contact_id
    );

    UPDATE public.outbound_calls AS outbound_call
    SET
      contact_id = NULL,
      twilio_call_sid = NULL,
      elevenlabs_conversation_id = NULL,
      contact_name = NULL,
      contact_phone = NULL,
      outcome = NULL,
      answered_by = NULL,
      ai_summary = NULL,
      ai_transcript = NULL
    WHERE outbound_call.queue_id IN (
      SELECT q.id
      FROM public.outbound_call_queue AS q
      WHERE q.company_id = v_company_id
        AND q.contact_id = v_contact_id
    );

    UPDATE public.outbound_call_queue AS q
    SET
      status = CASE
        WHEN q.status IN ('completed', 'failed', 'blocked', 'cancelled')
          THEN q.status
        ELSE 'cancelled'
      END,
      contact_id = NULL,
      contact_phone_e164 = NULL,
      current_attempt_id = NULL,
      reserved_minutes = 0,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      block_reason = COALESCE(q.block_reason, 'contact_anonymized'),
      completed_at = COALESCE(q.completed_at, now()),
      updated_at = now()
    WHERE q.company_id = v_company_id
      AND q.contact_id = v_contact_id;

    FOREACH v_campaign_id IN ARRAY v_campaign_ids
    LOOP
      PERFORM outbound_private.refresh_campaign_state(
        v_campaign_id,
        v_company_id
      );
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION outbound_private.scrub_queue_for_outbound_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_company_id uuid;
  v_contact_id uuid;
  v_is_privacy_delete boolean;
  v_campaign_ids uuid[] := ARRAY[]::uuid[];
  v_campaign_id uuid;
  v_attempt record;
  v_outbound_call record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_contact_id := OLD.id;
    v_is_privacy_delete := true;
  ELSE
    v_company_id := NEW.company_id;
    v_contact_id := NEW.id;
    v_is_privacy_delete := NEW.anonymized_at IS NOT NULL
      OR NEW.status = 'anonymized';
  END IF;

  IF v_is_privacy_delete THEN
    SELECT COALESCE(
      array_agg(DISTINCT q.campaign_id),
      ARRAY[]::uuid[]
    )
    INTO v_campaign_ids
    FROM public.outbound_call_queue AS q
    WHERE q.company_id = v_company_id
      AND q.outbound_contact_id = v_contact_id;

    FOR v_attempt IN
      SELECT
        attempt.company_id,
        attempt.elevenlabs_conversation_id,
        attempt.twilio_call_sid
      FROM public.outbound_call_attempts AS attempt
      JOIN public.outbound_call_queue AS q
        ON q.id = attempt.queue_id
       AND q.company_id = attempt.company_id
      WHERE q.company_id = v_company_id
        AND q.outbound_contact_id = v_contact_id
      ORDER BY attempt.id
      FOR UPDATE OF attempt
    LOOP
      PERFORM outbound_private.enqueue_outbound_provider_resources(
        v_attempt.company_id,
        v_contact_id,
        v_attempt.elevenlabs_conversation_id,
        v_attempt.twilio_call_sid
      );
    END LOOP;

    FOR v_outbound_call IN
      SELECT
        outbound_call.company_id,
        outbound_call.elevenlabs_conversation_id,
        outbound_call.twilio_call_sid
      FROM public.outbound_calls AS outbound_call
      JOIN public.outbound_call_queue AS q
        ON q.id = outbound_call.queue_id
       AND q.company_id = outbound_call.company_id
      WHERE q.company_id = v_company_id
        AND q.outbound_contact_id = v_contact_id
      ORDER BY outbound_call.id
      FOR UPDATE OF outbound_call
    LOOP
      PERFORM outbound_private.enqueue_outbound_provider_resources(
        v_outbound_call.company_id,
        v_contact_id,
        v_outbound_call.elevenlabs_conversation_id,
        v_outbound_call.twilio_call_sid
      );
    END LOOP;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.status
        ELSE 'cancelled'
      END,
      elevenlabs_conversation_id = NULL,
      twilio_call_sid = NULL,
      error_code = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.error_code
        ELSE 'outbound_contact_anonymized'
      END,
      ended_at = CASE
        WHEN attempt.status IN (
          'completed', 'no_answer', 'failed', 'cancelled'
        ) THEN attempt.ended_at
        ELSE COALESCE(attempt.ended_at, now())
      END,
      updated_at = now()
    WHERE attempt.queue_id IN (
      SELECT q.id
      FROM public.outbound_call_queue AS q
      WHERE q.company_id = v_company_id
        AND q.outbound_contact_id = v_contact_id
    );

    UPDATE public.outbound_calls AS outbound_call
    SET
      contact_id = NULL,
      outbound_contact_id = NULL,
      twilio_call_sid = NULL,
      elevenlabs_conversation_id = NULL,
      contact_name = NULL,
      contact_phone = NULL,
      outcome = NULL,
      answered_by = NULL,
      ai_summary = NULL,
      ai_transcript = NULL
    WHERE outbound_call.queue_id IN (
      SELECT q.id
      FROM public.outbound_call_queue AS q
      WHERE q.company_id = v_company_id
        AND q.outbound_contact_id = v_contact_id
    );

    UPDATE public.outbound_call_queue AS q
    SET
      status = CASE
        WHEN q.status IN ('completed', 'failed', 'blocked', 'cancelled')
          THEN q.status
        ELSE 'cancelled'
      END,
      contact_id = NULL,
      contact_phone_e164 = NULL,
      current_attempt_id = NULL,
      reserved_minutes = 0,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      block_reason = COALESCE(q.block_reason, 'outbound_contact_anonymized'),
      completed_at = COALESCE(q.completed_at, now()),
      updated_at = now()
    WHERE q.company_id = v_company_id
      AND q.outbound_contact_id = v_contact_id;

    FOREACH v_campaign_id IN ARRAY v_campaign_ids
    LOOP
      PERFORM outbound_private.refresh_campaign_state(
        v_campaign_id,
        v_company_id
      );
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Serialize campaign list mutations with launch/resume/claim. Application
-- pre-checks remain useful for friendly errors, while this trigger closes the
-- database race and protects imports that insert several rows at once.
CREATE OR REPLACE FUNCTION outbound_private.guard_outbound_contact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_company_id uuid;
  v_campaign_id uuid;
  v_campaign_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.anonymized_at IS NOT NULL OR NEW.status = 'anonymized' THEN
      RETURN NEW;
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
      RAISE EXCEPTION 'outbound contact tenant/campaign cannot be changed'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_campaign_id := OLD.campaign_id;
  ELSE
    v_company_id := NEW.company_id;
    v_campaign_id := NEW.campaign_id;
  END IF;

  SELECT campaign.status
  INTO v_campaign_status
  FROM public.outbound_campaigns AS campaign
  WHERE campaign.id = v_campaign_id
    AND campaign.company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- The only FK-valid missing parent during DELETE is its own cascade.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'outbound campaign does not belong to company'
      USING ERRCODE = '23503';
  END IF;

  IF v_campaign_status NOT IN ('draft', 'paused') THEN
    RAISE EXCEPTION
      'outbound contacts can only change while campaign is draft or paused'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1
    FROM public.outbound_call_queue AS q
    WHERE q.company_id = v_company_id
      AND q.campaign_id = v_campaign_id
      AND q.outbound_contact_id = OLD.id
      AND q.status IN (
        'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
        'manual_review'
      )
  ) THEN
    RAISE EXCEPTION 'outbound contact has an active or ambiguous call'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Post-call jobs temporarily hold a normalized phone and transcript. Erase
-- that payload before a linked CRM contact is anonymized/deleted; the call
-- privacy workflow separately enqueues the provider resource deletion.
CREATE OR REPLACE FUNCTION outbound_private.scrub_post_call_jobs_for_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.anonymized_at IS NULL
     AND NEW.status <> 'anonymized' THEN
    RETURN NEW;
  END IF;

  UPDATE public.post_call_processing_jobs AS job
  SET
    conversation_id = 'anonymized:' || job.id::text,
    twilio_call_sid = NULL,
    caller_phone_e164 = NULL,
    transcript = NULL,
    provider_summary = NULL,
    status = CASE
      WHEN job.status IN ('completed', 'failed', 'cancelled') THEN job.status
      ELSE 'cancelled'
    END,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_code = COALESCE(job.last_error_code, 'contact_anonymized'),
    last_error_message = NULL,
    payload_scrubbed_at = COALESCE(job.payload_scrubbed_at, now()),
    completed_at = COALESCE(job.completed_at, now()),
    updated_at = now()
  WHERE job.company_id = OLD.company_id
    AND (
      job.contact_id = OLD.id
      OR EXISTS (
        SELECT 1
        FROM public.calls AS call
        WHERE call.id = job.call_id
          AND call.company_id = job.company_id
          AND call.contact_id = OLD.id
      )
    );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION outbound_private.guard_outbound_campaign_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'active' OR EXISTS (
    SELECT 1
    FROM public.outbound_call_queue AS q
    WHERE q.company_id = OLD.company_id
      AND q.campaign_id = OLD.id
      AND q.status IN (
        'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
        'manual_review'
      )
  ) THEN
    RAISE EXCEPTION 'outbound campaign has active or ambiguous calls'
      USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS outbound_contacts_guard_campaign_mutation
ON public.outbound_contacts;

CREATE TRIGGER outbound_contacts_guard_campaign_mutation
BEFORE INSERT
  OR UPDATE OF company_id, campaign_id, full_name, phone, email,
    company_name, notes, language
  OR DELETE ON public.outbound_contacts
FOR EACH ROW
EXECUTE FUNCTION outbound_private.guard_outbound_contact_mutation();

DROP TRIGGER IF EXISTS outbound_campaigns_guard_delete
ON public.outbound_campaigns;

CREATE TRIGGER outbound_campaigns_guard_delete
BEFORE DELETE ON public.outbound_campaigns
FOR EACH ROW
EXECUTE FUNCTION outbound_private.guard_outbound_campaign_delete();

DROP TRIGGER IF EXISTS contacts_scrub_outbound_queue
ON public.contacts;

DROP TRIGGER IF EXISTS contacts_scrub_post_call_jobs
ON public.contacts;

CREATE TRIGGER contacts_scrub_post_call_jobs
BEFORE UPDATE OF anonymized_at, status
  OR DELETE ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION outbound_private.scrub_post_call_jobs_for_contact();

CREATE TRIGGER contacts_scrub_outbound_queue
BEFORE UPDATE OF anonymized_at, status, merged_into_contact_id
  OR DELETE ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION outbound_private.scrub_queue_for_crm_contact();

DROP TRIGGER IF EXISTS outbound_contacts_scrub_outbound_queue
ON public.outbound_contacts;

CREATE TRIGGER outbound_contacts_scrub_outbound_queue
BEFORE UPDATE OF anonymized_at, status
  OR DELETE ON public.outbound_contacts
FOR EACH ROW
EXECUTE FUNCTION outbound_private.scrub_queue_for_outbound_contact();

-- ============================================================
-- 6. RLS and backend-only privileges
-- ============================================================

ALTER TABLE public.voice_call_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_call_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_call_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_callback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_call_processing_jobs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tenant_table text;
  existing_policy record;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'voice_call_settings',
    'outbound_call_queue',
    'outbound_call_attempts',
    'outbound_callback_events',
    'post_call_processing_jobs'
  ]
  LOOP
    FOR existing_policy IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = tenant_table
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.%I',
        existing_policy.policyname,
        tenant_table
      );
    END LOOP;

    EXECUTE format(
      'CREATE POLICY tenant_isolation
       ON public.%I
       FOR ALL
       TO authenticated
       USING (
         company_id = (SELECT private.current_company_id())
         OR (SELECT private.is_super_admin())
       )
       WITH CHECK (
         company_id = (SELECT private.current_company_id())
         OR (SELECT private.is_super_admin())
       )',
      tenant_table
    );

    EXECUTE format(
      'CREATE POLICY service_role_bypass
       ON public.%I
       FOR ALL
       TO service_role
       USING (true)
       WITH CHECK (true)',
      tenant_table
    );

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I
       FROM PUBLIC, anon, authenticated, service_role',
      tenant_table
    );

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE
       ON TABLE public.%I
       TO service_role',
      tenant_table
    );
  END LOOP;
END
$$;

-- ============================================================
-- 7. Durable campaign enqueue
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_outbound_campaign(
  p_campaign_id uuid,
  p_company_id uuid,
  p_scheduled_for timestamptz DEFAULT now(),
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE(
  queue_id uuid,
  outbound_contact_id uuid,
  queue_status text,
  block_reason text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.outbound_campaigns%ROWTYPE;
BEGIN
  IF p_campaign_id IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION 'campaign_id and company_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_scheduled_for IS NULL THEN
    RAISE EXCEPTION 'scheduled_for is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 10 THEN
    RAISE EXCEPTION 'max_attempts must be between 1 and 10'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.*
  INTO v_campaign
  FROM public.outbound_campaigns AS c
  WHERE c.id = p_campaign_id
    AND c.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign does not belong to company'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.voice_call_settings (company_id)
  VALUES (p_company_id)
  ON CONFLICT (company_id) DO NOTHING;

  RETURN QUERY
  WITH source AS (
    SELECT
      oc.id AS outbound_contact_id,
      normalized.phone AS normalized_phone,
      CASE WHEN COALESCE(crm.match_count, 0) = 1
        THEN crm.contact_id ELSE NULL END AS contact_id,
      CASE WHEN COALESCE(phone_config.match_count, 0) = 1
        THEN phone_config.phone_number_id ELSE NULL END
        AS outbound_phone_number_id,
      CASE
        WHEN normalized.phone IS NULL THEN 'invalid_phone'
        WHEN EXISTS (
          SELECT 1
          FROM public.dnc_list AS d
          WHERE d.company_id = p_company_id
            AND d.phone = normalized.phone
        ) THEN 'dnc'
        WHEN COALESCE(crm.match_count, 0) <> 1 THEN 'explicit_call_consent_required'
        WHEN COALESCE(phone_config.match_count, 0) <> 1 THEN 'tenant_phone_mapping_required'
        ELSE NULL
      END AS reason
    FROM public.outbound_contacts AS oc
    CROSS JOIN LATERAL (
      SELECT crm_private.normalize_e164(oc.phone) AS phone
    ) AS normalized
    LEFT JOIN LATERAL (
      SELECT
        count(*) OVER ()::integer AS match_count,
        c.id AS contact_id
      FROM public.contacts AS c
      WHERE c.company_id = p_company_id
        AND c.phone = normalized.phone
        AND c.call_consent IS TRUE
        AND c.status NOT IN ('archived', 'anonymized')
        AND c.anonymized_at IS NULL
        AND c.merged_into_contact_id IS NULL
      ORDER BY c.created_at, c.id
      LIMIT 1
    ) AS crm ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*) OVER ()::integer AS match_count,
        pn.id AS phone_number_id
      FROM public.phone_numbers AS pn
      WHERE pn.company_id = p_company_id
        AND pn.status = 'active'
        AND NULLIF(btrim(pn.elevenlabs_agent_id), '') IS NOT NULL
        AND NULLIF(btrim(pn.elevenlabs_phone_number_id), '') IS NOT NULL
        AND (
          v_campaign.outbound_phone_number_id IS NULL
          OR pn.id = v_campaign.outbound_phone_number_id
        )
      ORDER BY pn.created_at, pn.id
      LIMIT 1
    ) AS phone_config ON true
    WHERE oc.company_id = p_company_id
      AND oc.campaign_id = p_campaign_id
      AND oc.status = 'pending'
      AND oc.anonymized_at IS NULL
  ),
  inserted AS (
    INSERT INTO public.outbound_call_queue AS queued (
      company_id,
      campaign_id,
      outbound_contact_id,
      contact_id,
      outbound_phone_number_id,
      contact_phone_e164,
      status,
      scheduled_for,
      next_attempt_at,
      max_attempts,
      block_reason,
      completed_at
    )
    SELECT
      p_company_id,
      p_campaign_id,
      source.outbound_contact_id,
      source.contact_id,
      source.outbound_phone_number_id,
      source.normalized_phone,
      CASE WHEN source.reason IS NULL THEN 'pending' ELSE 'blocked' END,
      p_scheduled_for,
      p_scheduled_for,
      p_max_attempts,
      source.reason,
      CASE WHEN source.reason IS NULL THEN NULL ELSE now() END
    FROM source
    ON CONFLICT DO NOTHING
    RETURNING
      queued.id,
      queued.outbound_contact_id,
      queued.status,
      queued.block_reason
  ),
  synced AS (
    UPDATE public.outbound_contacts AS oc
    SET
      status = CASE
        WHEN inserted.block_reason = 'dnc' THEN 'dnc'
        ELSE 'error'
      END,
      outcome_notes = left(inserted.block_reason, 500)
    FROM inserted
    WHERE oc.id = inserted.outbound_contact_id
      AND oc.company_id = p_company_id
      AND inserted.status = 'blocked'
      AND oc.status <> 'anonymized'
    RETURNING oc.id
  )
  SELECT
    q.id,
    q.outbound_contact_id,
    q.status,
    q.block_reason
  FROM public.outbound_call_queue AS q
  WHERE q.company_id = p_company_id
    AND q.campaign_id = p_campaign_id
    AND (
      q.status IN (
        'pending', 'claimed', 'dispatching', 'in_progress',
        'retry_scheduled', 'dispatch_unknown', 'manual_review'
      )
      OR EXISTS (
        SELECT 1
        FROM inserted
        WHERE inserted.id = q.id
      )
    )
  ORDER BY q.id;

  -- Une campagne ne devient active que si elle possède réellement du travail
  -- appelable. Les lancements vides ou entièrement bloqués restent modifiables
  -- en brouillon/en pause au lieu de devenir « completed » par effet de bord.
  UPDATE public.outbound_campaigns AS campaign
  SET status = 'active', updated_at = now()
  WHERE campaign.id = p_campaign_id
    AND campaign.company_id = p_company_id
    AND EXISTS (
      SELECT 1
      FROM public.outbound_call_queue AS q
      WHERE q.campaign_id = p_campaign_id
        AND q.company_id = p_company_id
        AND q.status IN (
          'pending', 'claimed', 'dispatching', 'in_progress',
          'retry_scheduled', 'dispatch_unknown', 'manual_review'
        )
    );

  PERFORM outbound_private.refresh_campaign_state(
    p_campaign_id,
    p_company_id
  );
END
$$;

-- ============================================================
-- 8. Atomic claim and final pre-dispatch compliance gate
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_next_outbound_call(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120,
  p_reserved_minutes numeric DEFAULT 10
)
RETURNS SETOF public.outbound_call_queue
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL
     OR length(p_worker_id) > 200 THEN
    RAISE EXCEPTION 'worker_id is required and must be at most 200 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_lease_seconds IS NULL
     OR p_lease_seconds < 30
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds must be between 30 and 900'
      USING ERRCODE = '22023';
  END IF;

  IF p_reserved_minutes IS NULL
     OR p_reserved_minutes < 1
     OR p_reserved_minutes > 30 THEN
    RAISE EXCEPTION 'reserved_minutes must be between 1 and 30'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT q.id
    FROM public.outbound_campaigns AS campaign
    JOIN public.outbound_call_queue AS q
      ON q.campaign_id = campaign.id
     AND q.company_id = campaign.company_id
    JOIN public.subscriptions AS subscription
      ON subscription.company_id = q.company_id
    WHERE campaign.status = 'active'
      AND q.status IN ('pending', 'retry_scheduled')
      AND q.scheduled_for <= now()
      AND q.next_attempt_at <= now()
      AND q.provider_attempt_count < q.max_attempts
      AND q.contact_phone_e164 IS NOT NULL
      AND subscription.payment_status IN ('active', 'active_paid', 'trial')
      AND (
        subscription.payment_status <> 'trial'
        OR (
          subscription.trial_ends_at IS NOT NULL
          AND subscription.trial_ends_at > now()
        )
      )
      AND (
        subscription.overage_policy = 'pay_as_you_go'
        OR (
          subscription.overage_policy = 'block_at_limit'
          AND (
            GREATEST(
              COALESCE(subscription.minutes_used_current_period, 0),
              (
                COALESCE((
                  SELECT sum(GREATEST(COALESCE(c.duration_seconds, 0), 0))
                  FROM public.calls AS c
                  WHERE c.company_id = q.company_id
                    AND c.created_at >= COALESCE(
                      subscription.current_period_start::timestamptz,
                      date_trunc('month', now())
                    )
                    AND c.created_at < COALESCE(
                      subscription.current_period_end::timestamptz,
                      date_trunc('month', now()) + interval '1 month'
                    )
                ), 0)
                + COALESCE((
                  SELECT sum(GREATEST(COALESCE(oc.duration_seconds, 0), 0))
                  FROM public.outbound_calls AS oc
                  WHERE oc.company_id = q.company_id
                    AND oc.created_at >= COALESCE(
                      subscription.current_period_start::timestamptz,
                      date_trunc('month', now())
                    )
                    AND oc.created_at < COALESCE(
                      subscription.current_period_end::timestamptz,
                      date_trunc('month', now()) + interval '1 month'
                    )
                ), 0)
              ) / 60.0
            )
            + COALESCE((
              SELECT sum(active.reserved_minutes)
              FROM public.outbound_call_queue AS active
              WHERE active.company_id = q.company_id
                AND active.status IN (
                  'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
                  'manual_review'
                )
            ), 0)
            + p_reserved_minutes
          ) <= COALESCE(subscription.minutes_included, 0)
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.outbound_call_queue AS active
        WHERE active.company_id = q.company_id
          AND active.contact_phone_e164 = q.contact_phone_e164
          AND active.id <> q.id
          AND active.status IN (
            'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
            'manual_review'
          )
      )
    ORDER BY q.next_attempt_at, q.scheduled_for, q.created_at
    LIMIT 1
    FOR UPDATE OF campaign, q, subscription SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'claimed',
      claimed_by = btrim(p_worker_id),
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      reserved_minutes = p_reserved_minutes,
      block_reason = NULL,
      last_error_code = NULL,
      updated_at = now()
    FROM candidate
    WHERE q.id = candidate.id
    RETURNING q.*
  )
  SELECT claimed.*
  FROM claimed;
END
$$;

-- Preflight outcomes must update the queue, contact and campaign in one
-- transaction. Direct PostgREST updates used to leave campaign state stale.
CREATE OR REPLACE FUNCTION public.transition_claimed_outbound_call(
  p_queue_id uuid,
  p_company_id uuid,
  p_worker_id text,
  p_action text,
  p_error_code text,
  p_retry_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_queue public.outbound_call_queue%ROWTYPE;
  v_error_code text := left(NULLIF(btrim(p_error_code), ''), 200);
  v_status text;
BEGIN
  IF p_queue_id IS NULL
     OR p_company_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR v_error_code IS NULL THEN
    RAISE EXCEPTION 'queue, company, worker and error code are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_action NOT IN ('defer', 'block') THEN
    RAISE EXCEPTION 'action must be defer or block'
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'defer' AND p_retry_at IS NULL THEN
    RAISE EXCEPTION 'retry_at is required for defer'
      USING ERRCODE = '22023';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = p_queue_id
    AND q.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_queue.status <> 'claimed'
     OR v_queue.claimed_by IS DISTINCT FROM btrim(p_worker_id)
     OR v_queue.lease_expires_at IS NULL
     OR v_queue.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'queue claim is stale or owned by another worker'
      USING ERRCODE = '55000';
  END IF;

  v_status := CASE WHEN p_action = 'defer'
    THEN 'retry_scheduled' ELSE 'blocked' END;

  UPDATE public.outbound_call_queue AS q
  SET
    status = v_status,
    next_attempt_at = CASE
      WHEN p_action = 'defer' THEN p_retry_at ELSE q.next_attempt_at END,
    current_attempt_id = NULL,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    reserved_minutes = 0,
    block_reason = CASE
      WHEN p_action = 'block' THEN v_error_code ELSE NULL END,
    last_error_code = v_error_code,
    completed_at = CASE
      WHEN p_action = 'block' THEN now() ELSE NULL END,
    updated_at = now()
  WHERE q.id = v_queue.id;

  UPDATE public.outbound_contacts AS outbound_contact
  SET
    status = CASE
      WHEN p_action = 'defer' THEN 'pending'
      WHEN v_error_code = 'dnc' THEN 'dnc'
      ELSE 'error'
    END,
    outcome_notes = left(v_error_code, 500)
  WHERE outbound_contact.id = v_queue.outbound_contact_id
    AND outbound_contact.company_id = v_queue.company_id
    AND outbound_contact.status <> 'anonymized';

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'queue_id', v_queue.id,
    'status', v_status,
    'next_attempt_at', CASE
      WHEN p_action = 'defer' THEN p_retry_at ELSE NULL END
  );
END
$$;

CREATE OR REPLACE FUNCTION public.begin_outbound_call_attempt(
  p_queue_id uuid,
  p_worker_id text,
  p_local_call_date date,
  p_next_allowed_at timestamptz DEFAULT NULL
)
RETURNS SETOF public.outbound_call_attempts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_queue public.outbound_call_queue%ROWTYPE;
  v_campaign public.outbound_campaigns%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_attempt_id uuid;
  v_daily_attempts integer := 0;
  v_guard_failure text;
BEGIN
  IF p_queue_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR p_local_call_date IS NULL THEN
    RAISE EXCEPTION 'queue_id, worker_id and local_call_date are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue item not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_queue.status <> 'claimed'
     OR v_queue.claimed_by IS DISTINCT FROM btrim(p_worker_id)
     OR v_queue.lease_expires_at IS NULL
     OR v_queue.lease_expires_at <= now()
     OR v_queue.reserved_minutes < 1
     OR v_queue.reserved_minutes > 30 THEN
    RAISE EXCEPTION 'queue claim is stale or owned by another worker'
      USING ERRCODE = '55000';
  END IF;

  SELECT campaign.*
  INTO v_campaign
  FROM public.outbound_campaigns AS campaign
  WHERE campaign.id = v_queue.campaign_id
    AND campaign.company_id = v_queue.company_id
  FOR UPDATE;

  -- A pause racing the application preflight is temporary, not a terminal
  -- consent/configuration failure. Release the claim so resume can continue it.
  IF FOUND AND v_campaign.status = 'paused' THEN
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'retry_scheduled',
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      next_attempt_at = now() + interval '1 minute',
      block_reason = NULL,
      last_error_code = 'campaign_paused',
      completed_at = NULL,
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      status = 'pending',
      outcome_notes = 'campaign_paused'
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';

    PERFORM outbound_private.refresh_campaign_state(
      v_queue.campaign_id,
      v_queue.company_id
    );
    RETURN;
  END IF;

  IF NOT FOUND OR v_campaign.status <> 'active' THEN
    v_guard_failure := 'campaign_not_active';
  ELSIF v_campaign.daily_call_limit IS NULL
        OR v_campaign.daily_call_limit < 1 THEN
    v_guard_failure := 'invalid_campaign_daily_limit';
  ELSE
    SELECT count(*)::integer
    INTO v_daily_attempts
    FROM public.outbound_call_attempts AS attempt
    JOIN public.outbound_call_queue AS attempted_queue
      ON attempted_queue.id = attempt.queue_id
     AND attempted_queue.company_id = attempt.company_id
    WHERE attempted_queue.company_id = v_queue.company_id
      AND attempted_queue.campaign_id = v_queue.campaign_id
      AND attempt.local_call_date = p_local_call_date
      AND attempt.status NOT IN ('cancelled', 'configuration_failure');
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.company_id = v_queue.company_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_subscription.payment_status IS NULL
     OR v_subscription.payment_status NOT IN ('active', 'active_paid', 'trial')
     OR (
       v_subscription.payment_status = 'trial'
       AND (
         v_subscription.trial_ends_at IS NULL
         OR v_subscription.trial_ends_at <= now()
       )
     ) THEN
    v_guard_failure := COALESCE(v_guard_failure, 'subscription_not_active');
  ELSIF v_guard_failure IS NULL
        AND v_subscription.overage_policy = 'block_at_limit'
        AND COALESCE(v_subscription.minutes_used_current_period, 0)
          + COALESCE((
              SELECT sum(active.reserved_minutes)
              FROM public.outbound_call_queue AS active
              WHERE active.company_id = v_queue.company_id
                AND active.status IN (
                  'claimed', 'dispatching', 'in_progress', 'dispatch_unknown',
                  'manual_review'
                )
            ), 0)
          > COALESCE(v_subscription.minutes_included, 0) THEN
    v_guard_failure := 'subscription_quota_exhausted';
  END IF;

  IF v_guard_failure IS NULL
     AND v_daily_attempts >= v_campaign.daily_call_limit THEN
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'retry_scheduled',
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      next_attempt_at = CASE
        WHEN p_next_allowed_at IS NOT NULL AND p_next_allowed_at > now()
          THEN p_next_allowed_at
        ELSE now() + interval '24 hours'
      END,
      last_error_code = 'daily_call_limit_reached',
      updated_at = now()
    WHERE q.id = v_queue.id;
    RETURN;
  END IF;

  IF v_guard_failure IS NULL
     AND v_queue.provider_attempt_count >= v_queue.max_attempts THEN
    v_guard_failure := 'max_attempts_reached';
  ELSIF v_guard_failure IS NULL
        AND (v_queue.contact_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.contacts AS c
    WHERE c.id = v_queue.contact_id
      AND c.company_id = v_queue.company_id
      AND c.call_consent IS TRUE
      AND c.status NOT IN ('archived', 'anonymized')
      AND c.anonymized_at IS NULL
      AND c.merged_into_contact_id IS NULL
      AND crm_private.normalize_e164(c.phone) = v_queue.contact_phone_e164
  )) THEN
    v_guard_failure := 'explicit_call_consent_required';
  ELSIF v_guard_failure IS NULL AND EXISTS (
    SELECT 1
    FROM public.dnc_list AS d
    WHERE d.company_id = v_queue.company_id
      AND d.phone = v_queue.contact_phone_e164
  ) THEN
    v_guard_failure := 'dnc';
  ELSIF v_guard_failure IS NULL
        AND (v_queue.outbound_phone_number_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.phone_numbers AS pn
    WHERE pn.id = v_queue.outbound_phone_number_id
      AND pn.company_id = v_queue.company_id
      AND pn.status = 'active'
      AND NULLIF(btrim(pn.elevenlabs_agent_id), '') IS NOT NULL
      AND NULLIF(btrim(pn.elevenlabs_phone_number_id), '') IS NOT NULL
  )) THEN
    v_guard_failure := 'tenant_phone_mapping_required';
  END IF;

  IF v_guard_failure IS NOT NULL THEN
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'blocked',
      block_reason = v_guard_failure,
      reserved_minutes = 0,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      completed_at = now(),
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      status = CASE WHEN v_guard_failure = 'dnc' THEN 'dnc' ELSE 'error' END,
      outcome_notes = left(v_guard_failure, 500)
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';

    PERFORM outbound_private.refresh_campaign_state(
      v_queue.campaign_id,
      v_queue.company_id
    );
    RETURN;
  END IF;

  INSERT INTO public.outbound_call_attempts (
    company_id,
    queue_id,
    attempt_no,
    status,
    local_call_date
  )
  VALUES (
    v_queue.company_id,
    v_queue.id,
    v_queue.attempt_count + 1,
    'dispatching',
    p_local_call_date
  )
  RETURNING id INTO v_attempt_id;

  UPDATE public.outbound_call_queue AS q
  SET
    status = 'dispatching',
    attempt_count = v_queue.attempt_count + 1,
    provider_attempt_count = v_queue.provider_attempt_count + 1,
    current_attempt_id = v_attempt_id,
    updated_at = now()
  WHERE q.id = v_queue.id;

  RETURN QUERY
  SELECT attempt.*
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = v_attempt_id;
END
$$;

CREATE OR REPLACE FUNCTION public.mark_outbound_call_dispatched(
  p_attempt_id uuid,
  p_worker_id text,
  p_elevenlabs_conversation_id text,
  p_twilio_call_sid text,
  p_provider_timeout_seconds integer DEFAULT 7200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.outbound_call_attempts%ROWTYPE;
  v_queue public.outbound_call_queue%ROWTYPE;
  v_contact_name text;
BEGIN
  IF p_attempt_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR NULLIF(btrim(p_elevenlabs_conversation_id), '') IS NULL
     OR NULLIF(btrim(p_twilio_call_sid), '') IS NULL THEN
    RAISE EXCEPTION
      'attempt_id, worker_id, conversation_id and call_sid are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_provider_timeout_seconds IS NULL
     OR p_provider_timeout_seconds < 60
     OR p_provider_timeout_seconds > 14400 THEN
    RAISE EXCEPTION 'provider_timeout_seconds must be between 60 and 14400'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = v_attempt.queue_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_queue.current_attempt_id IS DISTINCT FROM v_attempt.id
     OR v_queue.status <> 'dispatching'
     OR v_queue.claimed_by IS DISTINCT FROM btrim(p_worker_id) THEN
    RAISE EXCEPTION 'attempt is no longer the active dispatch'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.outbound_call_attempts AS attempt
  SET
    status = 'in_progress',
    elevenlabs_conversation_id = btrim(p_elevenlabs_conversation_id),
    twilio_call_sid = btrim(p_twilio_call_sid),
    dispatched_at = COALESCE(attempt.dispatched_at, now()),
    updated_at = now()
  WHERE attempt.id = v_attempt.id;

  UPDATE public.outbound_call_queue AS q
  SET
    status = 'in_progress',
    lease_expires_at = now()
      + make_interval(secs => p_provider_timeout_seconds),
    updated_at = now()
  WHERE q.id = v_queue.id;

  SELECT oc.full_name
  INTO v_contact_name
  FROM public.outbound_contacts AS oc
  WHERE oc.id = v_queue.outbound_contact_id
    AND oc.company_id = v_queue.company_id;

  INSERT INTO public.outbound_calls (
    company_id,
    contact_id,
    campaign_id,
    outbound_contact_id,
    queue_id,
    twilio_call_sid,
    elevenlabs_conversation_id,
    contact_name,
    contact_phone,
    status,
    created_at
  )
  VALUES (
    v_queue.company_id,
    v_queue.contact_id,
    v_queue.campaign_id,
    v_queue.outbound_contact_id,
    v_queue.id,
    btrim(p_twilio_call_sid),
    btrim(p_elevenlabs_conversation_id),
    v_contact_name,
    v_queue.contact_phone_e164,
    'calling',
    now()
  )
  ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL
  DO UPDATE SET
    twilio_call_sid = EXCLUDED.twilio_call_sid,
    elevenlabs_conversation_id = EXCLUDED.elevenlabs_conversation_id,
    status = 'calling';

  UPDATE public.outbound_contacts AS oc
  SET
    status = 'calling',
    call_attempts = COALESCE(oc.call_attempts, 0) + 1,
    last_called_at = now()
  WHERE oc.id = v_queue.outbound_contact_id
    AND oc.company_id = v_queue.company_id
    AND oc.status <> 'anonymized';

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'queue_id', v_queue.id,
    'attempt_id', v_attempt.id,
    'conversation_id', btrim(p_elevenlabs_conversation_id),
    'call_sid', btrim(p_twilio_call_sid)
  );
END
$$;

-- Definite API rejections and ambiguous no-response errors happen before a
-- signed provider callback exists.  Keep those transitions atomic without
-- polluting the signed callback idempotency ledger.
DROP FUNCTION IF EXISTS public.fail_outbound_call_dispatch(
  uuid, text, text, text, timestamptz
);

CREATE OR REPLACE FUNCTION public.fail_outbound_call_dispatch(
  p_attempt_id uuid,
  p_worker_id text,
  p_failure_class text,
  p_error_code text DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL,
  p_elevenlabs_conversation_id text DEFAULT NULL,
  p_twilio_call_sid text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.outbound_call_attempts%ROWTYPE;
  v_queue public.outbound_call_queue%ROWTYPE;
  v_retry_at timestamptz;
  v_queue_status text;
  v_conversation_id text := NULLIF(
    btrim(p_elevenlabs_conversation_id), ''
  );
  v_call_sid text := NULLIF(btrim(p_twilio_call_sid), '');
BEGIN
  IF p_attempt_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR length(p_worker_id) > 200 THEN
    RAISE EXCEPTION 'attempt and worker are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_failure_class NOT IN (
    'retryable_failure', 'failed', 'dispatch_unknown'
  ) THEN
    RAISE EXCEPTION 'invalid failure_class' USING ERRCODE = '22023';
  END IF;

  IF length(COALESCE(v_conversation_id, '')) > 512
     OR length(COALESCE(v_call_sid, '')) > 512 THEN
    RAISE EXCEPTION 'provider identifiers must be at most 512 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = v_attempt.queue_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_queue.current_attempt_id IS DISTINCT FROM v_attempt.id
     OR v_queue.claimed_by IS DISTINCT FROM btrim(p_worker_id)
     OR v_queue.status <> 'dispatching' THEN
    RAISE EXCEPTION 'attempt is no longer the active dispatch'
      USING ERRCODE = '55000';
  END IF;

  IF (
    v_conversation_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.outbound_call_attempts AS other_attempt
        WHERE other_attempt.elevenlabs_conversation_id = v_conversation_id
          AND other_attempt.id <> v_attempt.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.outbound_calls AS outbound_call
        WHERE outbound_call.elevenlabs_conversation_id = v_conversation_id
          AND (
            outbound_call.queue_id IS DISTINCT FROM v_queue.id
            OR outbound_call.company_id IS DISTINCT FROM v_queue.company_id
          )
      )
    )
  ) OR (
    v_call_sid IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.outbound_call_attempts AS other_attempt
        WHERE other_attempt.twilio_call_sid = v_call_sid
          AND other_attempt.id <> v_attempt.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.outbound_calls AS outbound_call
        WHERE outbound_call.twilio_call_sid = v_call_sid
          AND (
            outbound_call.queue_id IS DISTINCT FROM v_queue.id
            OR outbound_call.company_id IS DISTINCT FROM v_queue.company_id
          )
      )
    )
  ) THEN
    RAISE EXCEPTION 'provider dispatch identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF p_failure_class = 'retryable_failure'
     AND v_queue.provider_attempt_count < v_queue.max_attempts THEN
    v_queue_status := 'retry_scheduled';
    v_retry_at := COALESCE(
      p_retry_at,
      now() + make_interval(
        secs => LEAST(
          900,
          30 * power(
            2,
            GREATEST(v_queue.provider_attempt_count - 1, 0)
          )::integer
        )
      )
    );
  ELSIF p_failure_class = 'dispatch_unknown' THEN
    v_queue_status := 'dispatch_unknown';
    v_retry_at := v_queue.next_attempt_at;
  ELSE
    v_queue_status := 'failed';
    v_retry_at := v_queue.next_attempt_at;
  END IF;

  UPDATE public.outbound_call_attempts AS attempt
  SET
    status = CASE
      WHEN v_queue_status = 'retry_scheduled' THEN 'retryable_failure'
      WHEN v_queue_status = 'dispatch_unknown' THEN 'dispatch_unknown'
      ELSE 'failed'
    END,
    elevenlabs_conversation_id = COALESCE(
      v_conversation_id,
      attempt.elevenlabs_conversation_id
    ),
    twilio_call_sid = COALESCE(v_call_sid, attempt.twilio_call_sid),
    error_code = left(NULLIF(btrim(p_error_code), ''), 200),
    ended_at = CASE
      WHEN v_queue_status = 'dispatch_unknown' THEN attempt.ended_at
      ELSE COALESCE(attempt.ended_at, now())
    END,
    updated_at = now()
  WHERE attempt.id = v_attempt.id;

  UPDATE public.outbound_call_queue AS q
  SET
    status = v_queue_status,
    current_attempt_id = CASE
      WHEN v_queue_status = 'retry_scheduled' THEN NULL
      ELSE q.current_attempt_id
    END,
    next_attempt_at = v_retry_at,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    reserved_minutes = CASE
      WHEN v_queue_status = 'dispatch_unknown' THEN q.reserved_minutes ELSE 0 END,
    last_error_code = left(NULLIF(btrim(p_error_code), ''), 200),
    completed_at = CASE
      WHEN v_queue_status = 'failed' THEN now() ELSE NULL END,
    updated_at = now()
  WHERE q.id = v_queue.id;

  UPDATE public.outbound_contacts AS oc
  SET
    status = CASE
      WHEN v_queue_status = 'retry_scheduled' THEN 'pending'
      WHEN v_queue_status = 'dispatch_unknown' THEN 'calling'
      ELSE 'error'
    END,
    outcome_notes = left(NULLIF(btrim(p_error_code), ''), 500)
  WHERE oc.id = v_queue.outbound_contact_id
    AND oc.company_id = v_queue.company_id
    AND oc.status <> 'anonymized';

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'queue_id', v_queue.id,
    'attempt_id', v_attempt.id,
    'status', v_queue_status,
    'next_attempt_at', v_retry_at
  );
END
$$;

-- A provider-side configuration/rate-limit rejection did not create a call.
-- Keep attempt_no monotonic for audit/uniqueness, but refund the provider
-- attempt budget so repeated configuration repairs do not exhaust max_attempts.
CREATE OR REPLACE FUNCTION public.quarantine_outbound_provider_failure(
  p_attempt_id uuid,
  p_worker_id text,
  p_error_code text,
  p_retry_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.outbound_call_attempts%ROWTYPE;
  v_queue public.outbound_call_queue%ROWTYPE;
  v_error_code text := left(NULLIF(btrim(p_error_code), ''), 200);
BEGIN
  IF p_attempt_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR v_error_code IS NULL
     OR p_retry_at IS NULL THEN
    RAISE EXCEPTION 'attempt, worker, error code and retry_at are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = v_attempt.queue_id
    AND q.company_id = v_attempt.company_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.status <> 'dispatching'
     OR v_queue.current_attempt_id IS DISTINCT FROM v_attempt.id
     OR v_queue.status <> 'dispatching'
     OR v_queue.claimed_by IS DISTINCT FROM btrim(p_worker_id) THEN
    RAISE EXCEPTION 'attempt is no longer the active dispatch'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.outbound_call_attempts AS attempt
  SET
    status = 'configuration_failure',
    error_code = v_error_code,
    ended_at = COALESCE(attempt.ended_at, now()),
    updated_at = now()
  WHERE attempt.id = v_attempt.id;

  UPDATE public.outbound_call_queue AS q
  SET
    status = 'retry_scheduled',
    provider_attempt_count = GREATEST(q.provider_attempt_count - 1, 0),
    current_attempt_id = NULL,
    next_attempt_at = p_retry_at,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    reserved_minutes = 0,
    block_reason = NULL,
    last_error_code = v_error_code,
    completed_at = NULL,
    updated_at = now()
  WHERE q.id = v_queue.id;

  UPDATE public.outbound_contacts AS outbound_contact
  SET
    status = 'pending',
    outcome_notes = left(v_error_code, 500)
  WHERE outbound_contact.id = v_queue.outbound_contact_id
    AND outbound_contact.company_id = v_queue.company_id
    AND outbound_contact.status <> 'anonymized';

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'queue_id', v_queue.id,
    'attempt_id', v_attempt.id,
    'status', 'retry_scheduled',
    'next_attempt_at', p_retry_at
  );
END
$$;

-- ============================================================
-- 9. Restart recovery
-- ============================================================

CREATE OR REPLACE FUNCTION public.release_stale_outbound_claims(
  p_batch_size integer DEFAULT 100
)
RETURNS TABLE(requeued integer, dispatch_unknown integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_requeued integer := 0;
  v_unknown integer := 0;
  v_expired record;
  v_expired_queue public.outbound_call_queue%ROWTYPE;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT q.id
    FROM public.outbound_call_queue AS q
    WHERE q.status = 'claimed'
      AND (
        q.lease_expires_at IS NULL
        OR q.lease_expires_at <= now()
      )
    ORDER BY q.lease_expires_at NULLS FIRST, q.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  changed AS (
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'retry_scheduled',
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      next_attempt_at = now(),
      last_error_code = 'worker_lease_expired_before_dispatch',
      updated_at = now()
    FROM candidates
    WHERE q.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_requeued FROM changed;

  -- Attempt first, then parent queue: callbacks and dispatch RPCs use the same
  -- row-lock order, avoiding the former recovery/callback deadlock cycle.
  WITH candidate_attempts AS (
    SELECT attempt.id, attempt.queue_id
    FROM public.outbound_call_attempts AS attempt
    JOIN public.outbound_call_queue AS q
      ON q.id = attempt.queue_id
     AND q.company_id = attempt.company_id
     AND q.current_attempt_id = attempt.id
    WHERE q.status IN ('dispatching', 'in_progress')
      AND (
        q.lease_expires_at IS NULL
        OR q.lease_expires_at <= now()
      )
    ORDER BY q.lease_expires_at NULLS FIRST, q.created_at, attempt.id
    LIMIT p_batch_size
    FOR UPDATE OF attempt SKIP LOCKED
  ),
  changed_attempts AS (
    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = 'dispatch_unknown',
      error_code = COALESCE(
        attempt.error_code,
        'provider_state_unknown_after_restart'
      ),
      updated_at = now()
    FROM candidate_attempts
    WHERE attempt.id = candidate_attempts.id
      AND attempt.queue_id = candidate_attempts.queue_id
    RETURNING attempt.id, attempt.queue_id
  ),
  changed_queue AS (
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'dispatch_unknown',
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error_code = 'provider_state_unknown_after_restart',
      updated_at = now()
    FROM changed_attempts
    WHERE q.id = changed_attempts.queue_id
      AND q.current_attempt_id = changed_attempts.id
      AND q.status IN ('dispatching', 'in_progress')
      AND (
        q.lease_expires_at IS NULL
        OR q.lease_expires_at <= now()
      )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_unknown FROM changed_queue;

  -- Unknown provider state must never be retried blindly. After a full day
  -- (well beyond the four-hour provider timeout), release only the quota
  -- reservation and move to a persistent manual-review quarantine. The phone
  -- uniqueness/claim guards retain the no-redial lock until an administrator
  -- records an explicit provider reconciliation through the resolution RPC.
  FOR v_expired IN
    SELECT
      attempt.id AS attempt_id,
      q.id AS queue_id
    FROM public.outbound_call_attempts AS attempt
    JOIN public.outbound_call_queue AS q
      ON q.id = attempt.queue_id
     AND q.company_id = attempt.company_id
     AND q.current_attempt_id = attempt.id
    WHERE q.status = 'dispatch_unknown'
      AND q.updated_at <= now() - interval '24 hours'
    ORDER BY q.updated_at, q.id, attempt.id
    LIMIT p_batch_size
    FOR UPDATE OF attempt SKIP LOCKED
  LOOP
    UPDATE public.outbound_call_queue AS q
    SET
      status = 'manual_review',
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      last_error_code = 'dispatch_unknown_manual_review',
      completed_at = NULL,
      updated_at = now()
    WHERE q.id = v_expired.queue_id
      AND q.current_attempt_id = v_expired.attempt_id
      AND q.status = 'dispatch_unknown'
      AND q.updated_at <= now() - interval '24 hours'
    RETURNING q.* INTO v_expired_queue;

    IF FOUND THEN
      UPDATE public.outbound_call_attempts AS attempt
      SET
        error_code = 'dispatch_unknown_manual_review',
        updated_at = now()
      WHERE attempt.id = v_expired.attempt_id
        AND attempt.queue_id = v_expired.queue_id;

      UPDATE public.outbound_contacts AS outbound_contact
      SET
        status = 'error',
        outcome_notes = 'dispatch_unknown_manual_review'
      WHERE outbound_contact.id = v_expired_queue.outbound_contact_id
        AND outbound_contact.company_id = v_expired_queue.company_id
        AND outbound_contact.status <> 'anonymized';

      INSERT INTO public.notifications (
        user_id,
        company_id,
        type,
        category,
        title,
        body,
        link
      )
      SELECT DISTINCT
        profile.user_id,
        v_expired_queue.company_id,
        'warning',
        'system',
        'Appel sortant a verifier',
        'Etat fournisseur indetermine depuis 24 h. Une resolution explicite '
          || 'est requise avant toute relance. File: '
          || v_expired_queue.id::text,
        '/outbound'
      FROM public.profiles AS profile
      WHERE profile.user_id IS NOT NULL
        AND profile.status = 'active'
        AND (
          profile.role = 'super_admin'
          OR (
            profile.role = 'company_admin'
            AND profile.company_id = v_expired_queue.company_id
          )
        );

      PERFORM outbound_private.refresh_campaign_state(
        v_expired_queue.campaign_id,
        v_expired_queue.company_id
      );
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_requeued, v_unknown;
END
$$;

-- Resolve an ambiguous dispatch only after an operator verified provider
-- state. The attempt is locked before the queue, matching callbacks/recovery.
CREATE OR REPLACE FUNCTION public.resolve_outbound_manual_review(
  p_queue_id uuid,
  p_resolution text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_attempt_id uuid;
  v_attempt public.outbound_call_attempts%ROWTYPE;
  v_queue public.outbound_call_queue%ROWTYPE;
  v_contact_name text;
  v_record_dispatch boolean := false;
  v_queue_status text;
BEGIN
  IF p_queue_id IS NULL
     OR p_actor_user_id IS NULL
     OR p_resolution NOT IN (
       'confirmed_not_dispatched', 'confirmed_completed', 'confirmed_failed'
     ) THEN
    RAISE EXCEPTION 'invalid manual-review resolution'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_actor_user_id
      AND profile.role = 'super_admin'
      AND profile.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active super administrator is required'
      USING ERRCODE = '42501';
  END IF;

  -- Read only the child identifier before taking locks. The locked queue is
  -- revalidated below, so a concurrent callback/resolution cannot be lost.
  SELECT q.current_attempt_id
  INTO v_attempt_id
  FROM public.outbound_call_queue AS q
  WHERE q.id = p_queue_id;

  IF NOT FOUND OR v_attempt_id IS NULL THEN
    RAISE EXCEPTION 'manual-review queue or attempt not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = v_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual-review attempt not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = p_queue_id
    AND q.company_id = v_attempt.company_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_queue.status <> 'manual_review'
     OR v_queue.current_attempt_id IS DISTINCT FROM v_attempt.id
     OR v_attempt.queue_id IS DISTINCT FROM v_queue.id THEN
    RAISE EXCEPTION 'queue is no longer awaiting manual review'
      USING ERRCODE = '55000';
  END IF;

  IF p_resolution = 'confirmed_not_dispatched' THEN
    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = 'cancelled',
      error_code = 'manual_review_confirmed_not_dispatched',
      ended_at = COALESCE(attempt.ended_at, now()),
      updated_at = now()
    WHERE attempt.id = v_attempt.id;

    UPDATE public.outbound_call_queue AS q
    SET
      status = 'retry_scheduled',
      provider_attempt_count = GREATEST(q.provider_attempt_count - 1, 0),
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      next_attempt_at = now(),
      block_reason = NULL,
      last_error_code = 'manual_review_confirmed_not_dispatched',
      completed_at = NULL,
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      status = 'pending',
      outcome_notes = 'manual_review_confirmed_not_dispatched'
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';

    v_queue_status := 'retry_scheduled';
  ELSE
    v_record_dispatch := v_attempt.dispatched_at IS NULL;
    v_queue_status := CASE
      WHEN p_resolution = 'confirmed_completed' THEN 'completed'
      ELSE 'failed'
    END;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = CASE
        WHEN p_resolution = 'confirmed_completed' THEN 'completed'
        ELSE 'failed'
      END,
      dispatched_at = COALESCE(attempt.dispatched_at, attempt.started_at, now()),
      error_code = CASE
        WHEN p_resolution = 'confirmed_failed'
          THEN 'manual_review_confirmed_failed'
        ELSE NULL
      END,
      ended_at = COALESCE(attempt.ended_at, now()),
      updated_at = now()
    WHERE attempt.id = v_attempt.id;

    UPDATE public.outbound_call_queue AS q
    SET
      status = v_queue_status,
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      last_error_code = CASE
        WHEN p_resolution = 'confirmed_failed'
          THEN 'manual_review_confirmed_failed'
        ELSE NULL
      END,
      completed_at = now(),
      updated_at = now()
    WHERE q.id = v_queue.id;

    SELECT outbound_contact.full_name
    INTO v_contact_name
    FROM public.outbound_contacts AS outbound_contact
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id;

    INSERT INTO public.outbound_calls (
      company_id,
      contact_id,
      campaign_id,
      outbound_contact_id,
      queue_id,
      twilio_call_sid,
      elevenlabs_conversation_id,
      contact_name,
      contact_phone,
      status,
      duration_seconds,
      ended_at,
      created_at
    )
    VALUES (
      v_queue.company_id,
      v_queue.contact_id,
      v_queue.campaign_id,
      v_queue.outbound_contact_id,
      v_queue.id,
      v_attempt.twilio_call_sid,
      v_attempt.elevenlabs_conversation_id,
      v_contact_name,
      v_queue.contact_phone_e164,
      CASE WHEN p_resolution = 'confirmed_completed'
        THEN 'completed' ELSE 'failed' END,
      COALESCE(v_attempt.duration_seconds, 0),
      now(),
      COALESCE(v_attempt.started_at, now())
    )
    ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL
    DO UPDATE SET
      twilio_call_sid = COALESCE(
        EXCLUDED.twilio_call_sid,
        outbound_calls.twilio_call_sid
      ),
      elevenlabs_conversation_id = COALESCE(
        EXCLUDED.elevenlabs_conversation_id,
        outbound_calls.elevenlabs_conversation_id
      ),
      status = EXCLUDED.status,
      duration_seconds = EXCLUDED.duration_seconds,
      ended_at = EXCLUDED.ended_at;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      status = CASE WHEN p_resolution = 'confirmed_completed'
        THEN 'called' ELSE 'error' END,
      call_attempts = COALESCE(outbound_contact.call_attempts, 0)
        + CASE WHEN v_record_dispatch THEN 1 ELSE 0 END,
      last_called_at = CASE
        WHEN v_record_dispatch THEN COALESCE(
          v_attempt.dispatched_at,
          v_attempt.started_at,
          now()
        )
        ELSE outbound_contact.last_called_at
      END,
      outcome_notes = CASE
        WHEN p_resolution = 'confirmed_failed'
          THEN 'manual_review_confirmed_failed'
        ELSE outbound_contact.outcome_notes
      END
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';
  END IF;

  INSERT INTO public.audit_log (
    company_id,
    actor_user_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    details
  )
  VALUES (
    v_queue.company_id,
    p_actor_user_id,
    'super_admin',
    'outbound.manual_review_resolved',
    'outbound_call_queue',
    v_queue.id::text,
    jsonb_build_object(
      'resolution', p_resolution,
      'attempt_id', v_attempt.id,
      'resulting_status', v_queue_status
    )
  );

  INSERT INTO public.notifications (
    user_id,
    company_id,
    type,
    category,
    title,
    body,
    link
  )
  SELECT DISTINCT
    profile.user_id,
    v_queue.company_id,
    'info',
    'system',
    'Verification appel sortant resolue',
    'La file ' || v_queue.id::text || ' a ete resolue: ' || p_resolution,
    '/outbound'
  FROM public.profiles AS profile
  WHERE profile.user_id IS NOT NULL
    AND profile.status = 'active'
    AND (
      profile.role = 'super_admin'
      OR (
        profile.role = 'company_admin'
        AND profile.company_id = v_queue.company_id
      )
    );

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'queue_id', v_queue.id,
    'attempt_id', v_attempt.id,
    'resolution', p_resolution,
    'status', v_queue_status
  );
END
$$;

-- ============================================================
-- 10. Signed callback finalization and event idempotency
-- ============================================================

CREATE OR REPLACE FUNCTION public.finalize_outbound_call(
  p_event_key text,
  p_payload_sha256 text,
  p_event_type text,
  p_attempt_id uuid,
  p_result text,
  p_duration_seconds integer DEFAULT 0,
  p_outcome text DEFAULT NULL,
  p_contact_status text DEFAULT NULL,
  p_ai_summary text DEFAULT NULL,
  p_ai_transcript jsonb DEFAULT NULL,
  p_twilio_call_sid text DEFAULT NULL,
  p_elevenlabs_conversation_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.outbound_call_attempts%ROWTYPE;
  v_queue public.outbound_call_queue%ROWTYPE;
  v_event_id uuid;
  v_existing_event public.outbound_callback_events%ROWTYPE;
  v_attempt_status text;
  v_queue_status text;
  v_contact_status text;
  v_outbound_status text;
  v_retry_at timestamptz;
  v_contact_name text;
  v_is_current boolean;
  v_cleanup_conversation_id text;
  v_cleanup_call_sid text;
  v_dispatch_recorded_at timestamptz;
  v_repaired_dispatch boolean := false;
BEGIN
  IF NULLIF(btrim(p_event_key), '') IS NULL
     OR length(p_event_key) > 512
     OR NULLIF(btrim(p_event_type), '') IS NULL
     OR length(p_event_type) > 128
     OR p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'invalid callback identity'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'payload_sha256 must be lowercase hexadecimal SHA-256'
      USING ERRCODE = '22023';
  END IF;

  IF p_result NOT IN (
    'completed', 'no_answer', 'retryable_failure', 'failed',
    'consent_refused'
  ) THEN
    RAISE EXCEPTION 'invalid callback result' USING ERRCODE = '22023';
  END IF;

  IF p_duration_seconds IS NULL OR p_duration_seconds < 0 THEN
    RAISE EXCEPTION 'duration_seconds must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT q.*
  INTO v_queue
  FROM public.outbound_call_queue AS q
  WHERE q.id = v_attempt.queue_id
    AND q.company_id = v_attempt.company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt queue not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.outbound_callback_events (
    company_id,
    queue_id,
    attempt_id,
    provider,
    event_key,
    event_type,
    payload_sha256
  )
  VALUES (
    v_queue.company_id,
    v_queue.id,
    v_attempt.id,
    'elevenlabs',
    btrim(p_event_key),
    btrim(p_event_type),
    p_payload_sha256
  )
  ON CONFLICT (provider, event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT event.*
    INTO v_existing_event
    FROM public.outbound_callback_events AS event
    WHERE event.provider = 'elevenlabs'
      AND event.event_key = btrim(p_event_key);

    IF v_existing_event.attempt_id IS DISTINCT FROM v_attempt.id
       OR v_existing_event.payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'callback event identity collision'
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'queue_id', v_queue.id,
      'attempt_id', v_attempt.id,
      'status', v_queue.status
    );
  END IF;

  v_cleanup_conversation_id := COALESCE(
    NULLIF(btrim(p_elevenlabs_conversation_id), ''),
    NULLIF(btrim(v_attempt.elevenlabs_conversation_id), '')
  );
  v_cleanup_call_sid := COALESCE(
    NULLIF(btrim(p_twilio_call_sid), ''),
    NULLIF(btrim(v_attempt.twilio_call_sid), '')
  );

  -- The provider may accept the request while the acknowledgement RPC loses
  -- its response. A signed callback carrying a provider identifier repairs the
  -- dispatch timestamp and contact counters exactly once.
  IF v_attempt.dispatched_at IS NULL
     AND (
       v_cleanup_conversation_id IS NOT NULL
       OR v_cleanup_call_sid IS NOT NULL
     ) THEN
    v_dispatch_recorded_at := COALESCE(v_attempt.started_at, now());
    v_repaired_dispatch := true;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      dispatched_at = v_dispatch_recorded_at,
      updated_at = now()
    WHERE attempt.id = v_attempt.id;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      call_attempts = COALESCE(outbound_contact.call_attempts, 0) + 1,
      last_called_at = CASE
        WHEN outbound_contact.last_called_at IS NULL
          OR outbound_contact.last_called_at < v_dispatch_recorded_at
          THEN v_dispatch_recorded_at
        ELSE outbound_contact.last_called_at
      END
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';
  END IF;

  -- A privacy action can race a late provider callback.  Record only the
  -- callback identity/hash, enqueue deletion of provider resources, and
  -- never recreate an outbound_calls row or persist callback content.
  IF v_queue.contact_phone_e164 IS NULL
     OR v_queue.contact_id IS NULL
     OR (
       v_queue.status = 'cancelled'
       AND v_queue.block_reason IN (
         'contact_anonymized', 'outbound_contact_anonymized'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM public.contacts AS contact
       WHERE contact.id = v_queue.contact_id
         AND contact.company_id = v_queue.company_id
         AND (
           contact.anonymized_at IS NOT NULL
           OR contact.status = 'anonymized'
         )
     )
     OR EXISTS (
       SELECT 1
       FROM public.outbound_contacts AS outbound_contact
       WHERE outbound_contact.id = v_queue.outbound_contact_id
         AND outbound_contact.company_id = v_queue.company_id
         AND (
           outbound_contact.anonymized_at IS NOT NULL
           OR outbound_contact.status = 'anonymized'
         )
     ) THEN
    IF v_cleanup_conversation_id IS NOT NULL THEN
      PERFORM public.enqueue_consent_refusal_cleanup(
        v_queue.company_id,
        v_cleanup_conversation_id,
        v_cleanup_call_sid
      );
    ELSIF v_cleanup_call_sid IS NOT NULL THEN
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      VALUES (
        v_queue.company_id,
        v_queue.contact_id,
        'twilio',
        'call',
        v_cleanup_call_sid,
        'system'
      )
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

      IF EXISTS (
        SELECT 1
        FROM public.privacy_external_deletions AS deletion
        WHERE deletion.provider = 'twilio'
          AND deletion.resource_type = 'call'
          AND deletion.external_id = v_cleanup_call_sid
          AND deletion.company_id IS DISTINCT FROM v_queue.company_id
      ) THEN
        RAISE EXCEPTION 'provider resource tenant conflict'
          USING ERRCODE = '23505';
      END IF;
    END IF;

    DELETE FROM public.outbound_calls AS outbound_call
    WHERE outbound_call.queue_id = v_queue.id
      AND outbound_call.company_id = v_queue.company_id;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = 'cancelled',
      elevenlabs_conversation_id = NULL,
      twilio_call_sid = NULL,
      duration_seconds = 0,
      error_code = 'privacy_cancelled',
      ended_at = COALESCE(attempt.ended_at, now()),
      updated_at = now()
    WHERE attempt.id = v_attempt.id;

    UPDATE public.outbound_call_queue AS q
    SET
      status = 'cancelled',
      contact_phone_e164 = NULL,
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      block_reason = COALESCE(q.block_reason, 'privacy_cancelled'),
      completed_at = COALESCE(q.completed_at, now()),
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_callback_events AS event
    SET processed_at = now()
    WHERE event.id = v_event_id;

    PERFORM outbound_private.refresh_campaign_state(
      v_queue.campaign_id,
      v_queue.company_id
    );

    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'privacy_cancelled', true,
      'queue_id', v_queue.id,
      'attempt_id', v_attempt.id,
      'status', 'cancelled'
    );
  END IF;

  -- Refusal of the recording/AI disclosure is terminal and data-minimizing.
  -- The migration-010 helper owns provider deletion/audit idempotency.
  IF p_result = 'consent_refused' THEN
    IF v_cleanup_conversation_id IS NOT NULL THEN
      PERFORM public.enqueue_consent_refusal_cleanup(
        v_queue.company_id,
        v_cleanup_conversation_id,
        v_cleanup_call_sid
      );
    ELSIF v_cleanup_call_sid IS NOT NULL THEN
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      )
      VALUES (
        v_queue.company_id,
        v_queue.contact_id,
        'twilio',
        'call',
        v_cleanup_call_sid,
        'system'
      )
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

      IF EXISTS (
        SELECT 1
        FROM public.privacy_external_deletions AS deletion
        WHERE deletion.provider = 'twilio'
          AND deletion.resource_type = 'call'
          AND deletion.external_id = v_cleanup_call_sid
          AND deletion.company_id IS DISTINCT FROM v_queue.company_id
      ) THEN
        RAISE EXCEPTION 'provider resource tenant conflict'
          USING ERRCODE = '23505';
      END IF;
    END IF;

    DELETE FROM public.outbound_calls AS outbound_call
    WHERE outbound_call.queue_id = v_queue.id
      AND outbound_call.company_id = v_queue.company_id;

    UPDATE public.outbound_call_attempts AS attempt
    SET
      status = 'cancelled',
      elevenlabs_conversation_id = NULL,
      twilio_call_sid = NULL,
      duration_seconds = p_duration_seconds,
      error_code = 'consent_refused',
      ended_at = COALESCE(attempt.ended_at, now()),
      updated_at = now()
    WHERE attempt.id = v_attempt.id;

    UPDATE public.outbound_call_queue AS q
    SET
      status = 'cancelled',
      contact_phone_e164 = NULL,
      current_attempt_id = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      block_reason = 'consent_refused',
      last_error_code = 'consent_refused',
      completed_at = COALESCE(q.completed_at, now()),
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_contacts AS outbound_contact
    SET
      status = 'called',
      outcome_notes = 'consent_refused'
    WHERE outbound_contact.id = v_queue.outbound_contact_id
      AND outbound_contact.company_id = v_queue.company_id
      AND outbound_contact.status <> 'anonymized';

    UPDATE public.outbound_callback_events AS event
    SET processed_at = now()
    WHERE event.id = v_event_id;

    PERFORM outbound_private.refresh_campaign_state(
      v_queue.campaign_id,
      v_queue.company_id
    );

    RETURN jsonb_build_object(
      'success', true,
      'duplicate', false,
      'consent_refused', true,
      'queue_id', v_queue.id,
      'attempt_id', v_attempt.id,
      'status', 'cancelled'
    );
  END IF;

  v_is_current := v_queue.current_attempt_id IS NOT DISTINCT FROM v_attempt.id;

  v_attempt_status := CASE p_result
    WHEN 'completed' THEN 'completed'
    WHEN 'no_answer' THEN 'no_answer'
    WHEN 'retryable_failure' THEN 'retryable_failure'
    ELSE 'failed'
  END;

  UPDATE public.outbound_call_attempts AS attempt
  SET
    status = v_attempt_status,
    elevenlabs_conversation_id = COALESCE(
      NULLIF(btrim(p_elevenlabs_conversation_id), ''),
      attempt.elevenlabs_conversation_id
    ),
    twilio_call_sid = COALESCE(
      NULLIF(btrim(p_twilio_call_sid), ''),
      attempt.twilio_call_sid
    ),
    duration_seconds = p_duration_seconds,
    error_code = left(NULLIF(btrim(p_error_code), ''), 200),
    ended_at = COALESCE(attempt.ended_at, now()),
    updated_at = now()
  WHERE attempt.id = v_attempt.id;

  -- A late callback remains auditable but must not roll back a newer attempt.
  IF NOT v_is_current THEN
    UPDATE public.outbound_callback_events AS event
    SET processed_at = now()
    WHERE event.id = v_event_id;

    -- A stale result cannot alter queue/contact outcome, but an acknowledgement
    -- repair still changes the campaign's durable dispatched-call projection.
    IF v_repaired_dispatch THEN
      PERFORM outbound_private.refresh_campaign_state(
        v_queue.campaign_id,
        v_queue.company_id
      );
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'stale_attempt', true,
      'queue_id', v_queue.id,
      'attempt_id', v_attempt.id,
      'status', v_queue.status
    );
  END IF;

  IF p_result = 'retryable_failure'
     AND v_queue.provider_attempt_count < v_queue.max_attempts THEN
    v_queue_status := 'retry_scheduled';
    v_retry_at := COALESCE(
      p_retry_at,
      now() + make_interval(
        secs => LEAST(
          900,
          30 * power(
            2,
            GREATEST(v_queue.provider_attempt_count - 1, 0)
          )::integer
        )
      )
    );

    UPDATE public.outbound_call_queue AS q
    SET
      status = v_queue_status,
      current_attempt_id = NULL,
      next_attempt_at = v_retry_at,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      last_error_code = left(NULLIF(btrim(p_error_code), ''), 200),
      updated_at = now()
    WHERE q.id = v_queue.id;

    UPDATE public.outbound_calls AS outbound_call
    SET
      -- Queue state lives in outbound_call_queue; this row represents the
      -- completed provider attempt and must respect the legacy status check.
      status = 'failed',
      duration_seconds = p_duration_seconds,
      outcome = NULLIF(btrim(p_outcome), ''),
      ai_summary = NULLIF(btrim(p_ai_summary), ''),
      ai_transcript = p_ai_transcript,
      twilio_call_sid = COALESCE(
        NULLIF(btrim(p_twilio_call_sid), ''), outbound_call.twilio_call_sid
      ),
      elevenlabs_conversation_id = COALESCE(
        NULLIF(btrim(p_elevenlabs_conversation_id), ''),
        outbound_call.elevenlabs_conversation_id
      )
    WHERE outbound_call.queue_id = v_queue.id;

    UPDATE public.outbound_contacts AS oc
    SET
      status = 'pending',
      outcome_notes = left(NULLIF(btrim(p_error_code), ''), 500)
    WHERE oc.id = v_queue.outbound_contact_id
      AND oc.company_id = v_queue.company_id
      AND oc.status <> 'anonymized';
  ELSE
    v_queue_status := CASE
      WHEN p_result IN ('completed', 'no_answer') THEN 'completed'
      ELSE 'failed'
    END;
    v_outbound_status := CASE p_result
      WHEN 'completed' THEN 'completed'
      WHEN 'no_answer' THEN 'no_answer'
      ELSE 'failed'
    END;
    v_contact_status := COALESCE(
      NULLIF(btrim(p_contact_status), ''),
      CASE WHEN p_result = 'no_answer' THEN 'no_answer'
           WHEN p_result = 'failed' OR p_result = 'retryable_failure'
             THEN 'error'
           ELSE 'called' END
    );

    IF v_contact_status NOT IN (
      'called', 'no_answer', 'interested', 'not_interested', 'error', 'dnc'
    ) THEN
      RAISE EXCEPTION 'invalid outbound contact status'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.outbound_call_queue AS q
    SET
      status = v_queue_status,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      reserved_minutes = 0,
      last_error_code = left(NULLIF(btrim(p_error_code), ''), 200),
      completed_at = now(),
      updated_at = now()
    WHERE q.id = v_queue.id;

    SELECT oc.full_name
    INTO v_contact_name
    FROM public.outbound_contacts AS oc
    WHERE oc.id = v_queue.outbound_contact_id
      AND oc.company_id = v_queue.company_id;

    INSERT INTO public.outbound_calls (
      company_id,
      contact_id,
      campaign_id,
      outbound_contact_id,
      queue_id,
      twilio_call_sid,
      elevenlabs_conversation_id,
      contact_name,
      contact_phone,
      status,
      duration_seconds,
      outcome,
      ai_summary,
      ai_transcript,
      ended_at,
      created_at
    )
    VALUES (
      v_queue.company_id,
      v_queue.contact_id,
      v_queue.campaign_id,
      v_queue.outbound_contact_id,
      v_queue.id,
      NULLIF(btrim(p_twilio_call_sid), ''),
      NULLIF(btrim(p_elevenlabs_conversation_id), ''),
      v_contact_name,
      v_queue.contact_phone_e164,
      v_outbound_status,
      p_duration_seconds,
      NULLIF(btrim(p_outcome), ''),
      NULLIF(btrim(p_ai_summary), ''),
      p_ai_transcript,
      now(),
      COALESCE(v_attempt.started_at, now())
    )
    ON CONFLICT (queue_id) WHERE queue_id IS NOT NULL
    DO UPDATE SET
      twilio_call_sid = COALESCE(
        EXCLUDED.twilio_call_sid,
        outbound_calls.twilio_call_sid
      ),
      elevenlabs_conversation_id = COALESCE(
        EXCLUDED.elevenlabs_conversation_id,
        outbound_calls.elevenlabs_conversation_id
      ),
      status = EXCLUDED.status,
      duration_seconds = EXCLUDED.duration_seconds,
      outcome = EXCLUDED.outcome,
      ai_summary = EXCLUDED.ai_summary,
      ai_transcript = EXCLUDED.ai_transcript,
      ended_at = EXCLUDED.ended_at;

    UPDATE public.outbound_contacts AS oc
    SET
      status = v_contact_status,
      outcome = NULLIF(btrim(p_outcome), ''),
      outcome_notes = CASE
        WHEN v_queue_status = 'failed'
          THEN left(NULLIF(btrim(p_error_code), ''), 500)
        ELSE oc.outcome_notes
      END
    WHERE oc.id = v_queue.outbound_contact_id
      AND oc.company_id = v_queue.company_id
      AND oc.status <> 'anonymized';
  END IF;

  PERFORM outbound_private.refresh_campaign_state(
    v_queue.campaign_id,
    v_queue.company_id
  );

  UPDATE public.outbound_callback_events AS event
  SET processed_at = now()
  WHERE event.id = v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'duplicate', false,
    'queue_id', v_queue.id,
    'attempt_id', v_attempt.id,
    'status', v_queue_status,
    'next_attempt_at', v_retry_at
  );
END
$$;

-- ============================================================
-- 11. Durable inbound post-call processing
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_post_call_processing(
  p_company_id uuid,
  p_conversation_id text,
  p_twilio_call_sid text DEFAULT NULL,
  p_caller_phone text DEFAULT NULL,
  p_duration_seconds integer DEFAULT 0,
  p_language_used text DEFAULT 'fr-CA',
  p_transcript text DEFAULT NULL,
  p_provider_summary text DEFAULT NULL,
  p_appointment_requested boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_conversation_id text := NULLIF(btrim(p_conversation_id), '');
  v_call_sid text := NULLIF(btrim(p_twilio_call_sid), '');
  v_phone text;
  v_language text := COALESCE(NULLIF(btrim(p_language_used), ''), 'fr-CA');
  v_contact_id uuid;
  v_call public.calls%ROWTYPE;
  v_job public.post_call_processing_jobs%ROWTYPE;
  v_resource_company_id uuid;
  v_inserted boolean := false;
BEGIN
  IF p_company_id IS NULL
     OR v_conversation_id IS NULL
     OR length(v_conversation_id) > 255
     OR v_conversation_id ~ '[[:cntrl:]]'
     OR p_duration_seconds IS NULL
     OR p_duration_seconds < 0
     OR p_duration_seconds > 86400
     OR length(v_language) > 32
     OR length(COALESCE(v_call_sid, '')) > 512
     OR length(COALESCE(p_transcript, '')) > 200000
     OR length(COALESCE(p_provider_summary, '')) > 20000 THEN
    RAISE EXCEPTION 'invalid post-call payload'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize accepted ingestion with a later consent-refusal tombstone for
  -- this provider conversation, including the no-row-yet race.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('post_call:' || v_conversation_id, 0)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.companies AS company
    WHERE company.id = p_company_id
  ) THEN
    RAISE EXCEPTION 'post-call company not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- A privacy tombstone is authoritative. Never recreate a provider payload
  -- that was already queued for deletion, and never reveal another tenant.
  SELECT deletion.company_id
  INTO v_resource_company_id
  FROM public.privacy_external_deletions AS deletion
  WHERE deletion.provider = 'elevenlabs'
    AND deletion.resource_type = 'conversation'
    AND deletion.external_id = v_conversation_id;

  IF FOUND THEN
    IF v_resource_company_id IS DISTINCT FROM p_company_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'conversation_conflict'
      );
    END IF;
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'privacy_tombstone'
    );
  END IF;

  -- Fast duplicate path. The global key is intentionally not tenant-scoped;
  -- the different-tenant branch returns no identifiers.
  SELECT job.*
  INTO v_job
  FROM public.post_call_processing_jobs AS job
  WHERE job.conversation_id = v_conversation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_job.company_id IS DISTINCT FROM p_company_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'conversation_conflict'
      );
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'job_id', v_job.id,
      'call_id', v_job.call_id,
      'duplicate', true,
      'status', v_job.status
    );
  END IF;

  v_phone := crm_private.normalize_e164(p_caller_phone);

  IF v_phone IS NOT NULL THEN
    SELECT contact.id
    INTO v_contact_id
    FROM public.contacts AS contact
    WHERE contact.company_id = p_company_id
      AND crm_private.normalize_e164(contact.phone) = v_phone
      AND contact.status NOT IN ('archived', 'anonymized')
      AND contact.anonymized_at IS NULL
      AND contact.merged_into_contact_id IS NULL
    ORDER BY contact.created_at, contact.id
    LIMIT 1;
  END IF;

  INSERT INTO public.calls AS call (
    company_id,
    contact_id,
    twilio_call_sid,
    elevenlabs_conversation_id,
    caller_phone,
    duration_seconds,
    status,
    language_used,
    ai_summary,
    ai_transcript,
    ended_at,
    created_at
  )
  VALUES (
    p_company_id,
    v_contact_id,
    v_call_sid,
    v_conversation_id,
    v_phone,
    p_duration_seconds,
    'completed',
    v_language,
    NULLIF(btrim(p_provider_summary), ''),
    CASE WHEN p_transcript IS NULL THEN NULL ELSE to_jsonb(p_transcript) END,
    now(),
    now()
  )
  ON CONFLICT DO NOTHING
  RETURNING call.* INTO v_call;

  IF NOT FOUND THEN
    SELECT call.*
    INTO v_call
    FROM public.calls AS call
    WHERE call.company_id = p_company_id
      AND call.elevenlabs_conversation_id = v_conversation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'conversation_conflict'
      );
    END IF;

    IF v_call.post_call_processed_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'job_id', NULL,
        'call_id', v_call.id,
        'duplicate', true,
        'status', 'completed'
      );
    END IF;

    UPDATE public.calls AS call
    SET
      contact_id = COALESCE(call.contact_id, v_contact_id),
      twilio_call_sid = COALESCE(call.twilio_call_sid, v_call_sid),
      caller_phone = COALESCE(call.caller_phone, v_phone),
      duration_seconds = GREATEST(
        COALESCE(call.duration_seconds, 0),
        p_duration_seconds
      ),
      language_used = COALESCE(call.language_used, v_language),
      ai_summary = COALESCE(
        call.ai_summary,
        NULLIF(btrim(p_provider_summary), '')
      ),
      ai_transcript = COALESCE(
        call.ai_transcript,
        CASE WHEN p_transcript IS NULL THEN NULL ELSE to_jsonb(p_transcript) END
      ),
      ended_at = COALESCE(call.ended_at, now())
    WHERE call.id = v_call.id
      AND call.company_id = p_company_id
    RETURNING call.* INTO v_call;
  ELSE
    v_inserted := true;
  END IF;

  INSERT INTO public.post_call_processing_jobs AS job (
    company_id,
    call_id,
    contact_id,
    conversation_id,
    twilio_call_sid,
    caller_phone_e164,
    duration_seconds,
    language_used,
    transcript,
    provider_summary,
    appointment_requested,
    status,
    next_attempt_at
  )
  VALUES (
    p_company_id,
    v_call.id,
    COALESCE(v_call.contact_id, v_contact_id),
    v_conversation_id,
    v_call_sid,
    v_phone,
    p_duration_seconds,
    v_language,
    p_transcript,
    NULLIF(btrim(p_provider_summary), ''),
    COALESCE(p_appointment_requested, false),
    'pending',
    now()
  )
  ON CONFLICT DO NOTHING
  RETURNING job.* INTO v_job;

  IF NOT FOUND THEN
    SELECT job.*
    INTO v_job
    FROM public.post_call_processing_jobs AS job
    WHERE job.company_id = p_company_id
      AND job.conversation_id = v_conversation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'conversation_conflict'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'job_id', v_job.id,
    'call_id', v_job.call_id,
    'duplicate', NOT v_inserted,
    'status', v_job.status
  );
END
$$;

-- Migration 010 originally queued only provider deletion. Migration 012 also
-- owns transient post-call payloads, so refusal must tombstone ingestion and
-- erase any locally raced job/call/derived effects in the same transaction.
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
  v_input_call_sid text := NULLIF(btrim(p_twilio_call_sid), '');
  v_effective_call_sid text;
  v_request_id text := gen_random_uuid()::text;
  v_job public.post_call_processing_jobs%ROWTYPE;
  v_call public.calls%ROWTYPE;
  v_contact_id uuid;
  v_contact_created boolean := false;
  v_elevenlabs_enqueued integer := 0;
  v_twilio_enqueued integer := 0;
  v_learning_deleted integer := 0;
  v_appointments_deleted integer := 0;
  v_calls_deleted integer := 0;
  v_jobs_scrubbed integer := 0;
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

  IF v_input_call_sid IS NOT NULL
     AND (
       length(v_input_call_sid) > 255
       OR v_input_call_sid !~ '^CA[0-9A-Fa-f]{32}$'
     ) THEN
    RAISE EXCEPTION 'invalid twilio_call_sid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('post_call:' || v_conversation_id, 0)
  );

  SELECT job.*
  INTO v_job
  FROM public.post_call_processing_jobs AS job
  WHERE job.conversation_id = v_conversation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_job.company_id IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'provider resource tenant conflict'
        USING ERRCODE = '23505';
    END IF;
    v_contact_id := v_job.contact_id;
    v_contact_created := v_job.contact_created;
  END IF;

  SELECT call.*
  INTO v_call
  FROM public.calls AS call
  WHERE call.elevenlabs_conversation_id = v_conversation_id
  FOR UPDATE;

  IF FOUND AND v_call.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'provider resource tenant conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_contact_id IS NULL AND FOUND THEN
    v_contact_id := v_call.contact_id;
  END IF;

  v_effective_call_sid := COALESCE(
    v_input_call_sid,
    NULLIF(btrim(v_job.twilio_call_sid), ''),
    NULLIF(btrim(v_call.twilio_call_sid), '')
  );
  IF v_effective_call_sid IS NOT NULL
     AND v_effective_call_sid !~ '^CA[0-9A-Fa-f]{32}$' THEN
    -- Historical inbound rows sometimes used conversation_id as a fallback
    -- call SID. It is not a real Twilio resource and must not be enqueued.
    v_effective_call_sid := NULL;
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
    v_contact_id,
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
    FROM public.privacy_external_deletions AS deletion
    WHERE deletion.provider = 'elevenlabs'
      AND deletion.resource_type = 'conversation'
      AND deletion.external_id = v_conversation_id
      AND deletion.company_id IS DISTINCT FROM p_company_id
  ) THEN
    RAISE EXCEPTION 'provider resource tenant conflict'
      USING ERRCODE = '23505';
  END IF;

  IF v_effective_call_sid IS NOT NULL THEN
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
      v_contact_id,
      'twilio',
      'call',
      v_effective_call_sid,
      NULL,
      'system',
      v_request_id
    )
    ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

    GET DIAGNOSTICS v_twilio_enqueued = ROW_COUNT;

    IF EXISTS (
      SELECT 1
      FROM public.privacy_external_deletions AS deletion
      WHERE deletion.provider = 'twilio'
        AND deletion.resource_type = 'call'
        AND deletion.external_id = v_effective_call_sid
        AND deletion.company_id IS DISTINCT FROM p_company_id
    ) THEN
      RAISE EXCEPTION 'provider resource tenant conflict'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_job.id IS NOT NULL THEN
    DELETE FROM public.learning_suggestions AS suggestion
    WHERE suggestion.company_id = p_company_id
      AND suggestion.post_call_job_id = v_job.id;
    GET DIAGNOSTICS v_learning_deleted = ROW_COUNT;

    DELETE FROM public.appointments AS appointment
    WHERE appointment.company_id = p_company_id
      AND appointment.post_call_job_id = v_job.id;
    GET DIAGNOSTICS v_appointments_deleted = ROW_COUNT;

    UPDATE public.post_call_processing_jobs AS job
    SET
      conversation_id = 'consent-refused:' || job.id::text,
      twilio_call_sid = NULL,
      caller_phone_e164 = NULL,
      transcript = NULL,
      provider_summary = NULL,
      status = 'cancelled',
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error_code = 'consent_refused',
      last_error_message = NULL,
      payload_scrubbed_at = COALESCE(job.payload_scrubbed_at, now()),
      completed_at = COALESCE(job.completed_at, now()),
      updated_at = now()
    WHERE job.id = v_job.id
      AND job.company_id = p_company_id;
    GET DIAGNOSTICS v_jobs_scrubbed = ROW_COUNT;
  END IF;

  DELETE FROM public.calls AS call
  WHERE call.company_id = p_company_id
    AND call.elevenlabs_conversation_id = v_conversation_id;
  GET DIAGNOSTICS v_calls_deleted = ROW_COUNT;

  -- Only a contact created by this job can be erased because of refusal.
  -- Existing CRM contacts are never inferred/deleted from a shared phone.
  IF v_contact_created AND v_contact_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.contacts AS contact
    WHERE contact.id = v_contact_id
      AND contact.company_id = p_company_id
  ) THEN
    PERFORM public.anonymize_contact_data(
      p_company_id,
      v_contact_id,
      NULL,
      'system',
      'consent_refused',
      v_request_id
    );
  END IF;

  v_enqueued := v_elevenlabs_enqueued + v_twilio_enqueued;

  IF v_enqueued > 0
     OR v_jobs_scrubbed > 0
     OR v_calls_deleted > 0
     OR v_learning_deleted > 0
     OR v_appointments_deleted > 0 THEN
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
        'twilio_enqueued', v_twilio_enqueued,
        'post_call_jobs_scrubbed', v_jobs_scrubbed,
        'calls_deleted', v_calls_deleted,
        'learning_suggestions_deleted', v_learning_deleted,
        'appointments_deleted', v_appointments_deleted
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'external_deletions_enqueued', v_enqueued,
    'local_payloads_scrubbed',
      v_jobs_scrubbed + v_calls_deleted
        + v_learning_deleted + v_appointments_deleted,
    'status', CASE
      WHEN v_enqueued > 0 THEN 'queued'
      ELSE 'already_queued'
    END
  );
END
$$;

CREATE OR REPLACE FUNCTION public.claim_post_call_processing_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.post_call_processing_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL
     OR length(p_worker_id) > 200
     OR p_limit IS NULL
     OR p_limit < 1
     OR p_limit > 100
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 30
     OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid post-call claim parameters'
      USING ERRCODE = '22023';
  END IF;

  -- Do not strand an exhausted worker lease forever. Terminalization scrubs
  -- all transient PII before the next claim scan.
  UPDATE public.post_call_processing_jobs AS job
  SET
    status = 'failed',
    twilio_call_sid = NULL,
    caller_phone_e164 = NULL,
    transcript = NULL,
    provider_summary = NULL,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_code = 'post_call_retry_exhausted',
    last_error_message = NULL,
    payload_scrubbed_at = COALESCE(job.payload_scrubbed_at, now()),
    completed_at = COALESCE(job.completed_at, now()),
    updated_at = now()
  WHERE job.status = 'processing'
    AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= now())
    AND job.attempt_count >= job.max_attempts;

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM public.post_call_processing_jobs AS job
    WHERE job.attempt_count < job.max_attempts
      AND (
        (
          job.status IN ('pending', 'retry_scheduled')
          AND job.next_attempt_at <= now()
        )
        OR (
          job.status = 'processing'
          AND (
            job.lease_expires_at IS NULL
            OR job.lease_expires_at <= now()
          )
        )
      )
    ORDER BY job.next_attempt_at, job.created_at, job.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.post_call_processing_jobs AS job
    SET
      status = 'processing',
      attempt_count = job.attempt_count + 1,
      claimed_by = btrim(p_worker_id),
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.*
  )
  SELECT claimed.* FROM claimed;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_post_call_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_analysis jsonb,
  p_create_appointment boolean DEFAULT false,
  p_appointment_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.post_call_processing_jobs%ROWTYPE;
  v_call public.calls%ROWTYPE;
  v_contact_id uuid;
  v_contact_created boolean := false;
  v_summary text;
  v_intent text;
  v_outcome text;
  v_confidence integer;
  v_confidence_text text;
  v_hesitations jsonb := '[]'::jsonb;
  v_hesitation record;
  v_question text;
  v_proposed_answer text;
  v_learning_count integer := 0;
  v_inserted integer := 0;
  v_appointment_id uuid;
  v_appointment_date date;
BEGIN
  IF p_job_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR p_analysis IS NULL
     OR jsonb_typeof(p_analysis) <> 'object' THEN
    RAISE EXCEPTION 'invalid post-call completion parameters'
      USING ERRCODE = '22023';
  END IF;

  v_summary := left(NULLIF(btrim(p_analysis ->> 'summary'), ''), 10000);
  v_intent := left(NULLIF(btrim(p_analysis ->> 'intent'), ''), 50);
  v_outcome := left(NULLIF(btrim(p_analysis ->> 'outcome'), ''), 50);
  v_confidence_text := NULLIF(btrim(p_analysis ->> 'confidence'), '');
  IF v_confidence_text ~ '^[0-9]{1,3}$' THEN
    v_confidence := LEAST(100, GREATEST(0, v_confidence_text::integer));
  END IF;
  IF jsonb_typeof(p_analysis -> 'hesitations') = 'array' THEN
    v_hesitations := p_analysis -> 'hesitations';
  END IF;

  SELECT job.*
  INTO v_job
  FROM public.post_call_processing_jobs AS job
  WHERE job.id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-call job not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'job_id', v_job.id,
      'call_id', v_job.call_id,
      'contact_id', v_job.contact_id,
      'appointment_id', v_job.appointment_id,
      'learning_suggestions_created', v_job.learning_suggestions_created,
      'status', v_job.status
    );
  END IF;

  IF v_job.status <> 'processing'
     OR v_job.claimed_by IS DISTINCT FROM btrim(p_worker_id)
     OR v_job.lease_expires_at IS NULL
     OR v_job.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'post-call job lease is stale or owned by another worker'
      USING ERRCODE = '55000';
  END IF;

  SELECT call.*
  INTO v_call
  FROM public.calls AS call
  WHERE call.id = v_job.call_id
    AND call.company_id = v_job.company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-call call row not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_call.post_call_processed_at IS NOT NULL THEN
    UPDATE public.post_call_processing_jobs AS job
    SET
      status = 'completed',
      twilio_call_sid = NULL,
      caller_phone_e164 = NULL,
      transcript = NULL,
      provider_summary = NULL,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      payload_scrubbed_at = COALESCE(job.payload_scrubbed_at, now()),
      completed_at = COALESCE(job.completed_at, now()),
      updated_at = now()
    WHERE job.id = v_job.id
    RETURNING job.* INTO v_job;

    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'job_id', v_job.id,
      'call_id', v_job.call_id,
      'contact_id', v_call.contact_id,
      'appointment_id', v_job.appointment_id,
      'learning_suggestions_created', v_job.learning_suggestions_created,
      'status', 'completed'
    );
  END IF;

  v_contact_id := COALESCE(v_call.contact_id, v_job.contact_id);
  IF v_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.contacts AS contact
    WHERE contact.id = v_contact_id
      AND contact.company_id = v_job.company_id
      AND contact.status NOT IN ('archived', 'anonymized')
      AND contact.anonymized_at IS NULL
      AND contact.merged_into_contact_id IS NULL
  ) THEN
    v_contact_id := NULL;
  END IF;

  IF v_contact_id IS NULL AND v_job.caller_phone_e164 IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        v_job.company_id::text || ':' || v_job.caller_phone_e164,
        0
      )
    );

    SELECT contact.id
    INTO v_contact_id
    FROM public.contacts AS contact
    WHERE contact.company_id = v_job.company_id
      AND crm_private.normalize_e164(contact.phone) = v_job.caller_phone_e164
      AND contact.status NOT IN ('archived', 'anonymized')
      AND contact.anonymized_at IS NULL
      AND contact.merged_into_contact_id IS NULL
    ORDER BY contact.created_at, contact.id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.contacts (
        company_id,
        full_name,
        phone,
        status,
        source,
        last_interaction_at,
        created_at,
        updated_at
      )
      VALUES (
        v_job.company_id,
        'Appelant ' || v_job.caller_phone_e164,
        v_job.caller_phone_e164,
        'new',
        'inbound_call',
        now(),
        now(),
        now()
      )
      RETURNING id INTO v_contact_id;
      v_contact_created := true;
    END IF;
  END IF;

  IF v_contact_id IS NOT NULL THEN
    UPDATE public.contacts AS contact
    SET
      last_interaction_at = now(),
      updated_at = now()
    WHERE contact.id = v_contact_id
      AND contact.company_id = v_job.company_id;
  END IF;

  UPDATE public.calls AS call
  SET
    contact_id = v_contact_id,
    ai_summary = COALESCE(v_summary, v_job.provider_summary, call.ai_summary),
    intent = v_intent,
    confidence_score = v_confidence,
    outcome = v_outcome,
    post_call_processed_at = now()
  WHERE call.id = v_call.id
    AND call.company_id = v_job.company_id;

  FOR v_hesitation IN
    SELECT item.value, item.item_no
    FROM jsonb_array_elements(v_hesitations)
      WITH ORDINALITY AS item(value, item_no)
    ORDER BY item.item_no
    LIMIT 10
  LOOP
    IF jsonb_typeof(v_hesitation.value) = 'object' THEN
      v_question := left(
        NULLIF(btrim(v_hesitation.value ->> 'question'), ''),
        500
      );
      v_proposed_answer := left(
        COALESCE(
          NULLIF(btrim(v_hesitation.value ->> 'suggested_kb'), ''),
          NULLIF(btrim(v_hesitation.value ->> 'response_given'), ''),
          ''
        ),
        1000
      );

      IF v_question IS NOT NULL THEN
        INSERT INTO public.learning_suggestions (
          company_id,
          type,
          question,
          proposed_answer,
          source,
          occurrences,
          confidence,
          status,
          detected_at,
          post_call_job_id,
          post_call_item_no
        )
        SELECT
          v_job.company_id,
          'kb_gap',
          v_question,
          v_proposed_answer,
          'call:' || v_call.id::text,
          1,
          v_confidence,
          'pending',
          now(),
          v_job.id,
          v_hesitation.item_no::integer
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.learning_suggestions AS existing
          WHERE existing.company_id = v_job.company_id
            AND existing.source = 'call:' || v_call.id::text
            AND existing.question = v_question
        )
        ON CONFLICT (post_call_job_id, post_call_item_no)
          WHERE post_call_job_id IS NOT NULL
        DO NOTHING;

        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_learning_count := v_learning_count + v_inserted;
      END IF;
    END IF;
  END LOOP;

  IF COALESCE(p_create_appointment, false)
     AND p_appointment_date IS NOT NULL THEN
    v_appointment_date := p_appointment_date;
    IF v_appointment_date < current_date - 365
       OR v_appointment_date > current_date + 365 THEN
      RAISE EXCEPTION 'appointment date is outside the accepted range'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.appointments AS appointment (
      company_id,
      contact_id,
      source,
      date,
      type,
      status,
      channel,
      notes,
      post_call_job_id
    )
    VALUES (
      v_job.company_id,
      v_contact_id,
      'post_call_webhook',
      v_appointment_date,
      'phone_request',
      'pending',
      'phone',
      CASE
        WHEN COALESCE(v_summary, v_job.provider_summary) IS NULL
          THEN 'Demande de rendez-vous detectee lors de l''appel.'
        ELSE left(
          'Detecte via post-call webhook. '
            || COALESCE(v_summary, v_job.provider_summary),
          2000
        )
      END,
      v_job.id
    )
    ON CONFLICT (post_call_job_id) WHERE post_call_job_id IS NOT NULL
    DO NOTHING
    RETURNING appointment.id INTO v_appointment_id;

    IF v_appointment_id IS NULL THEN
      SELECT appointment.id
      INTO v_appointment_id
      FROM public.appointments AS appointment
      WHERE appointment.post_call_job_id = v_job.id
        AND appointment.company_id = v_job.company_id;
    END IF;
  END IF;

  -- Une simple intention ou une date absente doit rester une demande à
  -- confirmer. Créer un rendez-vous au jour courant serait une fausse
  -- réservation et contournerait le futur flux Calendly de la tâche 11.
  IF (COALESCE(p_create_appointment, false) OR v_job.appointment_requested)
     AND p_appointment_date IS NULL THEN
    INSERT INTO public.notifications (
      user_id,
      company_id,
      type,
      category,
      title,
      body,
      link
    )
    SELECT DISTINCT
      profile.user_id,
      v_job.company_id,
      'info',
      'system',
      'Demande de rendez-vous a confirmer',
      'Une intention de rendez-vous a ete detectee apres un appel. '
        || 'Confirmez la date et la disponibilite avant de reserver.',
      '/calendar'
    FROM public.profiles AS profile
    WHERE profile.user_id IS NOT NULL
      AND profile.status = 'active'
      AND profile.company_id = v_job.company_id
      AND profile.role = 'company_admin';
  END IF;

  UPDATE public.post_call_processing_jobs AS job
  SET
    contact_id = v_contact_id,
    contact_created = job.contact_created OR v_contact_created,
    appointment_id = v_appointment_id,
    learning_suggestions_created = v_learning_count,
    status = 'completed',
    twilio_call_sid = NULL,
    caller_phone_e164 = NULL,
    transcript = NULL,
    provider_summary = NULL,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL,
    last_error_message = NULL,
    payload_scrubbed_at = now(),
    completed_at = now(),
    updated_at = now()
  WHERE job.id = v_job.id;

  RETURN jsonb_build_object(
    'success', true,
    'duplicate', false,
    'job_id', v_job.id,
    'call_id', v_call.id,
    'contact_id', v_contact_id,
    'appointment_id', v_appointment_id,
    'learning_suggestions_created', v_learning_count,
    'status', 'completed'
  );
END
$$;

CREATE OR REPLACE FUNCTION public.fail_post_call_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL,
  p_terminal boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.post_call_processing_jobs%ROWTYPE;
  v_terminal boolean;
  v_retry_at timestamptz;
  v_error_code text := left(NULLIF(btrim(p_error_code), ''), 128);
  v_error_message text := left(NULLIF(btrim(p_error_message), ''), 500);
  v_status text;
BEGIN
  IF p_job_id IS NULL
     OR NULLIF(btrim(p_worker_id), '') IS NULL
     OR v_error_code IS NULL THEN
    RAISE EXCEPTION 'invalid post-call failure parameters'
      USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO v_job
  FROM public.post_call_processing_jobs AS job
  WHERE job.id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-call job not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_job.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'job_id', v_job.id,
      'status', v_job.status
    );
  END IF;

  IF v_job.status <> 'processing'
     OR v_job.claimed_by IS DISTINCT FROM btrim(p_worker_id) THEN
    RAISE EXCEPTION 'post-call job is owned by another worker'
      USING ERRCODE = '55000';
  END IF;

  v_terminal := COALESCE(p_terminal, false)
    OR v_job.attempt_count >= v_job.max_attempts;

  IF v_terminal THEN
    v_status := 'failed';
  ELSE
    v_status := 'retry_scheduled';
    v_retry_at := COALESCE(
      p_retry_at,
      now() + make_interval(
        secs => LEAST(
          3600,
          30 * power(2, GREATEST(v_job.attempt_count - 1, 0))::integer
        )
      )
    );
    IF v_retry_at < now() OR v_retry_at > now() + interval '24 hours' THEN
      RAISE EXCEPTION 'post-call retry_at must be within 24 hours'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.post_call_processing_jobs AS job
  SET
    status = v_status,
    next_attempt_at = COALESCE(v_retry_at, job.next_attempt_at),
    twilio_call_sid = CASE WHEN v_terminal THEN NULL ELSE job.twilio_call_sid END,
    caller_phone_e164 = CASE
      WHEN v_terminal THEN NULL ELSE job.caller_phone_e164 END,
    transcript = CASE WHEN v_terminal THEN NULL ELSE job.transcript END,
    provider_summary = CASE
      WHEN v_terminal THEN NULL ELSE job.provider_summary END,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_code = v_error_code,
    last_error_message = CASE WHEN v_terminal THEN NULL ELSE v_error_message END,
    payload_scrubbed_at = CASE
      WHEN v_terminal THEN COALESCE(job.payload_scrubbed_at, now())
      ELSE job.payload_scrubbed_at
    END,
    completed_at = CASE WHEN v_terminal THEN now() ELSE NULL END,
    updated_at = now()
  WHERE job.id = v_job.id;

  RETURN jsonb_build_object(
    'success', true,
    'duplicate', false,
    'job_id', v_job.id,
    'status', v_status,
    'next_attempt_at', v_retry_at
  );
END
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_post_call_processing_jobs(
  p_batch_size integer DEFAULT 500,
  p_company_id uuid DEFAULT NULL
)
RETURNS TABLE(company_id uuid, deleted_count integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  -- No unclaimed/retrying payload may outlive its retention clock. Scrub and
  -- terminalize a bounded batch first; its original completion clock makes it
  -- eligible for deletion in the query below during the same retention run.
  WITH stale_nonterminal AS (
    SELECT job.id
    FROM public.post_call_processing_jobs AS job
    WHERE (p_company_id IS NULL OR job.company_id = p_company_id)
      AND job.status IN ('pending', 'processing', 'retry_scheduled')
      AND job.created_at < now() - make_interval(days => job.retention_days)
    ORDER BY job.created_at, job.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.post_call_processing_jobs AS job
  SET
    status = 'cancelled',
    twilio_call_sid = NULL,
    caller_phone_e164 = NULL,
    transcript = NULL,
    provider_summary = NULL,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_code = 'post_call_retention_expired',
    last_error_message = NULL,
    payload_scrubbed_at = COALESCE(job.payload_scrubbed_at, now()),
    completed_at = COALESCE(job.completed_at, job.created_at, now()),
    updated_at = now()
  FROM stale_nonterminal
  WHERE job.id = stale_nonterminal.id;

  RETURN QUERY
  WITH targets AS (
    SELECT job.id
    FROM public.post_call_processing_jobs AS job
    WHERE (p_company_id IS NULL OR job.company_id = p_company_id)
      AND job.status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(job.completed_at, job.updated_at, job.created_at)
        < now() - make_interval(days => job.retention_days)
    ORDER BY COALESCE(job.completed_at, job.updated_at, job.created_at), job.id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.post_call_processing_jobs AS job
    USING targets
    WHERE job.id = targets.id
      AND (p_company_id IS NULL OR job.company_id = p_company_id)
      AND job.status IN ('completed', 'failed', 'cancelled')
    RETURNING job.company_id
  )
  SELECT deleted.company_id, count(*)::integer
  FROM deleted
  GROUP BY deleted.company_id;
END
$$;

-- ============================================================
-- 12. Operational metadata retention
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_expired_outbound_queue_metadata(
  p_batch_size integer DEFAULT 500,
  p_company_id uuid DEFAULT NULL
)
RETURNS TABLE(purged_company_id uuid, affected integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_target_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(target.id), ARRAY[]::uuid[])
  INTO v_target_ids
  FROM (
    SELECT q.id
    FROM public.outbound_call_queue AS q
    WHERE (p_company_id IS NULL OR q.company_id = p_company_id)
      AND q.status IN ('completed', 'failed', 'blocked', 'cancelled')
      AND COALESCE(q.completed_at, q.updated_at, q.created_at)
          < now() - make_interval(days => q.retention_days)
    ORDER BY COALESCE(q.completed_at, q.updated_at, q.created_at)
    LIMIT p_batch_size
  ) AS target;

  IF cardinality(v_target_ids) = 0 THEN
    RETURN;
  END IF;

  -- Child attempts are locked before parent queues, matching callback and
  -- dispatch RPC ordering. The delete rechecks retention after taking locks.
  PERFORM attempt.id
  FROM public.outbound_call_attempts AS attempt
  WHERE attempt.queue_id = ANY(v_target_ids)
  ORDER BY attempt.id
  FOR UPDATE;

  RETURN QUERY
  WITH deleted AS (
    DELETE FROM public.outbound_call_queue AS q
    WHERE q.id = ANY(v_target_ids)
      AND (p_company_id IS NULL OR q.company_id = p_company_id)
      AND q.status IN ('completed', 'failed', 'blocked', 'cancelled')
      AND COALESCE(q.completed_at, q.updated_at, q.created_at)
          < now() - make_interval(days => q.retention_days)
    RETURNING q.company_id
  )
  SELECT deleted.company_id, count(*)::integer
  FROM deleted
  GROUP BY deleted.company_id;
END
$$;

-- ============================================================
-- 12. Function ACLs
-- ============================================================

REVOKE ALL
ON FUNCTION outbound_private.ensure_voice_call_settings()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.refresh_campaign_state(uuid, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.enqueue_outbound_provider_deletion()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.enqueue_outbound_provider_resources(
  uuid, uuid, text, text
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.scrub_queue_for_crm_contact()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.scrub_queue_for_outbound_contact()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.guard_outbound_contact_mutation()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.guard_outbound_campaign_delete()
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION outbound_private.scrub_post_call_jobs_for_contact()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION outbound_private.ensure_voice_call_settings()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.refresh_campaign_state(uuid, uuid)
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.enqueue_outbound_provider_deletion()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.enqueue_outbound_provider_resources(
  uuid, uuid, text, text
)
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.scrub_queue_for_crm_contact()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.scrub_queue_for_outbound_contact()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.guard_outbound_contact_mutation()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.guard_outbound_campaign_delete()
TO service_role;

GRANT EXECUTE
ON FUNCTION outbound_private.scrub_post_call_jobs_for_contact()
TO service_role;

REVOKE ALL
ON FUNCTION public.enqueue_outbound_campaign(uuid, uuid, timestamptz, integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.claim_next_outbound_call(text, integer, numeric)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.transition_claimed_outbound_call(
  uuid, uuid, text, text, text, timestamptz
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.begin_outbound_call_attempt(uuid, text, date, timestamptz)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.mark_outbound_call_dispatched(uuid, text, text, text, integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.fail_outbound_call_dispatch(
  uuid, text, text, text, timestamptz, text, text
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.quarantine_outbound_provider_failure(
  uuid, text, text, timestamptz
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.resolve_outbound_manual_review(uuid, text, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.release_stale_outbound_claims(integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.finalize_outbound_call(
  text, text, text, uuid, text, integer, text, text, text, jsonb,
  text, text, text, timestamptz
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.purge_expired_outbound_queue_metadata(integer, uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.enqueue_post_call_processing(
  uuid, text, text, text, integer, text, text, text, boolean
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.enqueue_consent_refusal_cleanup(uuid, text, text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.claim_post_call_processing_jobs(text, integer, integer)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.complete_post_call_processing_job(
  uuid, text, jsonb, boolean, date
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.fail_post_call_processing_job(
  uuid, text, text, text, timestamptz, boolean
)
FROM PUBLIC, anon, authenticated;

REVOKE ALL
ON FUNCTION public.purge_expired_post_call_processing_jobs(integer, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.enqueue_outbound_campaign(uuid, uuid, timestamptz, integer)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.claim_next_outbound_call(text, integer, numeric)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.transition_claimed_outbound_call(
  uuid, uuid, text, text, text, timestamptz
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.begin_outbound_call_attempt(uuid, text, date, timestamptz)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.mark_outbound_call_dispatched(uuid, text, text, text, integer)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.fail_outbound_call_dispatch(
  uuid, text, text, text, timestamptz, text, text
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.quarantine_outbound_provider_failure(
  uuid, text, text, timestamptz
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.resolve_outbound_manual_review(uuid, text, uuid)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.release_stale_outbound_claims(integer)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.finalize_outbound_call(
  text, text, text, uuid, text, integer, text, text, text, jsonb,
  text, text, text, timestamptz
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.purge_expired_outbound_queue_metadata(integer, uuid)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.enqueue_post_call_processing(
  uuid, text, text, text, integer, text, text, text, boolean
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.enqueue_consent_refusal_cleanup(uuid, text, text)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.claim_post_call_processing_jobs(text, integer, integer)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.complete_post_call_processing_job(
  uuid, text, jsonb, boolean, date
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.fail_post_call_processing_job(
  uuid, text, text, text, timestamptz, boolean
)
TO service_role;

GRANT EXECUTE
ON FUNCTION public.purge_expired_post_call_processing_jobs(integer, uuid)
TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
