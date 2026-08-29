-- Migration 013 — Calendly OAuth, durable webhooks and appointment reminders
--
-- Apply only after migrations 009, 010, 011 and 012. OAuth credentials and
-- invitee payloads are backend-only: anon/authenticated never receive direct
-- Data API privileges on the operational tables created below.

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
    'companies',
    'contact_notes',
    'contacts',
    'dnc_list',
    'post_call_processing_jobs',
    'privacy_external_deletions',
    'profiles'
  ]::text[]) AS required(table_name)
  WHERE to_regclass('public.' || quote_ident(required.table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 013 aborted — missing tables: %',
      array_to_string(missing_tables, ', ');
  END IF;

  SELECT array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.column_name
  )
  INTO missing_columns
  FROM (
    VALUES
      ('appointments', 'company_id'),
      ('appointments', 'contact_id'),
      ('appointments', 'date'),
      ('appointments', 'external_id'),
      ('appointments', 'id'),
      ('appointments', 'notes'),
      ('appointments', 'post_call_job_id'),
      ('appointments', 'source'),
      ('appointments', 'source_direction'),
      ('appointments', 'status'),
      ('appointments', 'time'),
      ('appointments', 'type'),
      ('companies', 'id'),
      ('contact_notes', 'company_id'),
      ('contact_notes', 'contact_id'),
      ('contact_notes', 'created_by'),
      ('contact_notes', 'direction'),
      ('contact_notes', 'note'),
      ('contacts', 'anonymized_at'),
      ('contacts', 'company_id'),
      ('contacts', 'email'),
      ('contacts', 'full_name'),
      ('contacts', 'id'),
      ('contacts', 'last_interaction_at'),
      ('contacts', 'next_action'),
      ('contacts', 'next_action_date'),
      ('contacts', 'next_action_note'),
      ('contacts', 'phone'),
      ('contacts', 'status'),
      ('privacy_external_deletions', 'company_id'),
      ('privacy_external_deletions', 'external_id'),
      ('privacy_external_deletions', 'provider'),
      ('privacy_external_deletions', 'resource_type'),
      ('privacy_external_deletions', 'target_contact_id'),
      ('profiles', 'company_id'),
      ('profiles', 'user_id')
  ) AS required(table_name, column_name)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required.table_name
   AND actual.column_name = required.column_name
  WHERE actual.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 013 aborted — missing required columns: %',
      array_to_string(missing_columns, ', ');
  END IF;

  IF to_regprocedure('private.current_company_id()') IS NULL
     OR to_regprocedure('private.is_super_admin()') IS NULL
     OR to_regprocedure(
       'public.anonymize_contact_data(uuid,uuid,uuid,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Migration 013 requires migrations 009 through 012';
  END IF;
END
$$;

-- Composite keys let every new foreign key carry company_id. The primary keys
-- already guarantee uniqueness, so these constraints cannot reject valid rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass
      AND conname = 'contacts_id_company_unique'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_id_company_unique UNIQUE (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_id_company_unique'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_id_company_unique UNIQUE (id, company_id);
  END IF;
END
$$;

-- ============================================================
-- 2. OAuth connections and one-time PKCE state
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendly_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL UNIQUE
                               REFERENCES public.companies(id) ON DELETE CASCADE,
  calendly_user_uri          text,
  calendly_organization_uri  text,
  calendly_user_name         text,
  calendly_user_email        text,
  default_event_type_uri     text,
  granted_scopes             text[] NOT NULL DEFAULT '{}'::text[],
  access_token_ciphertext    text,
  access_token_iv            text,
  access_token_tag           text,
  refresh_token_ciphertext   text,
  refresh_token_iv           text,
  refresh_token_tag          text,
  token_expires_at           timestamptz,
  token_version              bigint NOT NULL DEFAULT 0,
  refresh_lock_token         uuid,
  refresh_locked_until       timestamptz,
  webhook_subscription_uri   text,
  webhook_scope              text NOT NULL DEFAULT 'user'
                               CHECK (webhook_scope IN ('user', 'organization')),
  webhook_status             text NOT NULL DEFAULT 'pending'
                               CHECK (webhook_status IN ('pending', 'active', 'error', 'disabled')),
  webhook_error              text,
  status                     text NOT NULL DEFAULT 'connecting'
                               CHECK (status IN ('connecting', 'connected', 'reconnect_required', 'disconnected', 'error')),
  connected_by               uuid,
  connected_at               timestamptz,
  disconnected_at            timestamptz,
  last_refreshed_at          timestamptz,
  last_error                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendly_connections_id_company_unique UNIQUE (id, company_id),
  CONSTRAINT calendly_connection_token_version_check
    CHECK (token_version >= 0),
  CONSTRAINT calendly_connection_refresh_lock_pair CHECK (
    (refresh_lock_token IS NULL) = (refresh_locked_until IS NULL)
  ),
  CONSTRAINT calendly_connection_token_triplets CHECK (
    (access_token_ciphertext IS NULL AND access_token_iv IS NULL AND access_token_tag IS NULL)
    OR
    (access_token_ciphertext IS NOT NULL AND access_token_iv IS NOT NULL AND access_token_tag IS NOT NULL)
  ),
  CONSTRAINT calendly_connection_refresh_triplets CHECK (
    (refresh_token_ciphertext IS NULL AND refresh_token_iv IS NULL AND refresh_token_tag IS NULL)
    OR
    (refresh_token_ciphertext IS NOT NULL AND refresh_token_iv IS NOT NULL AND refresh_token_tag IS NOT NULL)
  ),
  CONSTRAINT calendly_connection_connected_material CHECK (
    status <> 'connected'
    OR (
      access_token_ciphertext IS NOT NULL
      AND refresh_token_ciphertext IS NOT NULL
      AND token_expires_at IS NOT NULL
      AND calendly_user_uri IS NOT NULL
      AND calendly_organization_uri IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.calendly_oauth_states (
  state_hash                 text PRIMARY KEY,
  company_id                 uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  initiated_by               uuid NOT NULL,
  verifier_ciphertext        text NOT NULL,
  verifier_iv                text NOT NULL,
  verifier_tag               text NOT NULL,
  return_path                text NOT NULL DEFAULT '/calendar',
  expires_at                 timestamptz NOT NULL,
  consumed_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendly_oauth_state_hash_format
    CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT calendly_oauth_return_path_safe
    CHECK (
      return_path IN ('/calendar', '/settings', '/settings/integrations')
      AND char_length(return_path) <= 64
    )
);

-- ============================================================
-- 3. Durable provider operations
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendly_webhook_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         uuid NOT NULL,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_key             text NOT NULL,
  event_type            text,
  payload               jsonb NOT NULL,
  signature_timestamp   bigint,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'ignored', 'retry_scheduled', 'failed')),
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  claimed_by            text,
  claimed_at            timestamptz,
  lease_expires_at      timestamptz,
  processed_at          timestamptz,
  last_error            text,
  received_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, event_key),
  CONSTRAINT calendly_webhook_connection_tenant_fk
    FOREIGN KEY (connection_id, company_id)
    REFERENCES public.calendly_connections(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT calendly_webhook_event_key_length
    CHECK (char_length(event_key) BETWEEN 16 AND 256),
  CONSTRAINT calendly_webhook_processing_claim CHECK (
    status <> 'processing'
    OR (
      claimed_by IS NOT NULL
      AND btrim(claimed_by) <> ''
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.calendar_booking_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_id            uuid NOT NULL,
  contact_id               uuid,
  idempotency_key          text NOT NULL,
  event_type_uri           text NOT NULL,
  requested_start_at       timestamptz NOT NULL,
  invitee_name             text,
  invitee_email            text,
  invitee_phone            text,
  invitee_timezone         text,
  dispatch_token           uuid,
  dispatch_started_at      timestamptz,
  provider_event_uri       text,
  provider_invitee_uri     text,
  provider_response        jsonb,
  appointment_id           uuid,
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'dispatching', 'provider_succeeded', 'committed', 'reconciliation_required', 'failed')),
  last_error               text,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (appointment_id, company_id),
  CONSTRAINT calendar_booking_connection_tenant_fk
    FOREIGN KEY (connection_id, company_id)
    REFERENCES public.calendly_connections(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT calendar_booking_contact_tenant_fk
    FOREIGN KEY (contact_id, company_id)
    REFERENCES public.contacts(id, company_id)
    ON DELETE SET NULL (contact_id),
  CONSTRAINT calendar_booking_idempotency_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CONSTRAINT calendar_booking_dispatch_pair CHECK (
    (dispatch_token IS NULL) = (dispatch_started_at IS NULL)
  ),
  CONSTRAINT calendar_booking_dispatch_state CHECK (
    status NOT IN ('dispatching', 'provider_succeeded', 'committed', 'reconciliation_required')
    OR (dispatch_token IS NOT NULL AND dispatch_started_at IS NOT NULL)
  ),
  CONSTRAINT calendar_booking_invitee_required CHECK (
    status NOT IN ('pending', 'dispatching')
    OR (
      invitee_name IS NOT NULL
      AND invitee_email IS NOT NULL
      AND invitee_timezone IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.calendar_email_outbox (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  appointment_id        uuid NOT NULL,
  email_kind            text NOT NULL CHECK (email_kind IN ('confirmation', 'reminder')),
  recipient_email       text NOT NULL,
  recipient_name        text,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at                timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'sent', 'retry_scheduled', 'failed', 'cancelled')),
  attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  claimed_by            text,
  claimed_at            timestamptz,
  lease_expires_at      timestamptz,
  provider_message_id   text,
  sent_at               timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, email_kind),
  CONSTRAINT calendar_email_appointment_tenant_fk
    FOREIGN KEY (appointment_id, company_id)
    REFERENCES public.appointments(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT calendar_email_processing_claim CHECK (
    status <> 'processing'
    OR (
      claimed_by IS NOT NULL
      AND btrim(claimed_by) <> ''
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

-- ============================================================
-- 4. Canonical Calendly fields on appointments
-- ============================================================

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS calendly_connection_id uuid,
  ADD COLUMN IF NOT EXISTS calendly_event_id text,
  ADD COLUMN IF NOT EXISTS calendly_event_uri text,
  ADD COLUMN IF NOT EXISTS calendly_invitee_uri text,
  ADD COLUMN IF NOT EXISTS calendly_event_type_uri text,
  ADD COLUMN IF NOT EXISTS calendly_cancel_url text,
  ADD COLUMN IF NOT EXISTS calendly_reschedule_url text,
  ADD COLUMN IF NOT EXISTS start_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_at timestamptz,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS meet_link text,
  ADD COLUMN IF NOT EXISTS confirmation_sent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invitee_name text,
  ADD COLUMN IF NOT EXISTS invitee_email text,
  ADD COLUMN IF NOT EXISTS invitee_phone text,
  ADD COLUMN IF NOT EXISTS contact_match_status text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Preserve the historical Calendly URI only when it is recognizably a
-- Calendly scheduled-event URI. Non-URI legacy identifiers remain untouched.
UPDATE public.appointments
SET calendly_event_uri = calendly_event_id
WHERE calendly_event_uri IS NULL
  AND calendly_event_id ~ '^https://api\.calendly\.com/scheduled_events/[A-Za-z0-9_-]+$';

DO $$
BEGIN
  ALTER TABLE public.appointments
    DROP CONSTRAINT IF EXISTS appointments_calendly_connection_fk;

  ALTER TABLE public.appointments
    ADD CONSTRAINT appointments_calendly_connection_fk
    FOREIGN KEY (calendly_connection_id, company_id)
    REFERENCES public.calendly_connections(id, company_id)
    ON DELETE SET NULL (calendly_connection_id)
    NOT VALID;

  ALTER TABLE public.appointments
    DROP CONSTRAINT IF EXISTS appointments_contact_tenant_fk;

  ALTER TABLE public.appointments
    ADD CONSTRAINT appointments_contact_tenant_fk
    FOREIGN KEY (contact_id, company_id)
    REFERENCES public.contacts(id, company_id)
    ON DELETE SET NULL (contact_id)
    NOT VALID;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_contact_match_status_check'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_contact_match_status_check
      CHECK (
        contact_match_status IS NULL
        OR contact_match_status IN ('explicit', 'phone', 'email', 'unmatched', 'ambiguous')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointments'::regclass
      AND conname = 'appointments_calendar_time_check'
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_calendar_time_check
      CHECK (
        end_at IS NULL
        OR start_at IS NULL
        OR end_at > start_at
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.calendar_booking_requests
  DROP CONSTRAINT IF EXISTS calendar_booking_requests_appointment_fk;

ALTER TABLE public.calendar_booking_requests
  ADD CONSTRAINT calendar_booking_requests_appointment_fk
  FOREIGN KEY (appointment_id, company_id)
  REFERENCES public.appointments(id, company_id)
  ON DELETE SET NULL (appointment_id);

-- ============================================================
-- 5. Indexes and idempotency constraints
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_calendly_connections_company_status
  ON public.calendly_connections(company_id, status);

CREATE INDEX IF NOT EXISTS idx_calendly_oauth_states_expiry
  ON public.calendly_oauth_states(expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_webhook_due
  ON public.calendly_webhook_events(status, next_attempt_at, received_at)
  WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_calendar_booking_company_created
  ON public.calendar_booking_requests(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendar_email_due
  ON public.calendar_email_outbox(status, due_at, next_attempt_at)
  WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_appointments_company_start
  ON public.appointments(company_id, start_at);

CREATE INDEX IF NOT EXISTS idx_appointments_contact_start
  ON public.appointments(company_id, contact_id, start_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_calendly_invitee
  ON public.appointments(company_id, calendly_invitee_uri);

CREATE INDEX IF NOT EXISTS idx_appointments_calendly_event
  ON public.appointments(company_id, calendly_event_uri)
  WHERE calendly_event_uri IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_oauth_states_company
  ON public.calendly_oauth_states(company_id);

CREATE INDEX IF NOT EXISTS idx_calendly_webhook_company
  ON public.calendly_webhook_events(company_id);

CREATE INDEX IF NOT EXISTS idx_calendly_webhook_processing_lease
  ON public.calendly_webhook_events(lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_calendar_booking_connection
  ON public.calendar_booking_requests(connection_id);

CREATE INDEX IF NOT EXISTS idx_calendar_booking_contact
  ON public.calendar_booking_requests(company_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_booking_appointment
  ON public.calendar_booking_requests(company_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_email_company
  ON public.calendar_email_outbox(company_id);

CREATE INDEX IF NOT EXISTS idx_calendar_email_processing_lease
  ON public.calendar_email_outbox(lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_appointments_calendly_connection
  ON public.appointments(company_id, calendly_connection_id)
  WHERE calendly_connection_id IS NOT NULL;

-- ============================================================
-- 6. Atomic claims used by the backend workers
-- ============================================================

CREATE OR REPLACE FUNCTION public.consume_calendly_oauth_state(
  p_state_hash text
)
RETURNS SETOF public.calendly_oauth_states
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid OAuth state hash' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.calendly_oauth_states AS oauth_state
  SET consumed_at = clock_timestamp()
  WHERE oauth_state.state_hash = p_state_hash
    AND oauth_state.consumed_at IS NULL
    AND oauth_state.expires_at > clock_timestamp()
  RETURNING oauth_state.*;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_calendly_token_refresh(
  p_company_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer DEFAULT 30
)
RETURNS SETOF public.calendly_connections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company_id IS NULL OR p_lock_token IS NULL THEN
    RAISE EXCEPTION 'company_id and lock token are required'
      USING ERRCODE = '22004';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 120 THEN
    RAISE EXCEPTION 'refresh lease must be between 10 and 120 seconds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.calendly_connections AS connection
  SET refresh_lock_token = p_lock_token,
      refresh_locked_until = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 10), 120)),
      updated_at = clock_timestamp()
  WHERE connection.company_id = p_company_id
    AND connection.status = 'connected'
    AND connection.refresh_token_ciphertext IS NOT NULL
    AND (
      connection.refresh_lock_token IS NULL
      OR connection.refresh_locked_until IS NULL
      OR connection.refresh_locked_until <= clock_timestamp()
    )
  RETURNING connection.*;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_calendly_token_refresh(
  p_company_id uuid,
  p_lock_token uuid,
  p_access_token_ciphertext text,
  p_access_token_iv text,
  p_access_token_tag text,
  p_refresh_token_ciphertext text,
  p_refresh_token_iv text,
  p_refresh_token_tag text,
  p_token_expires_at timestamptz,
  p_granted_scopes text[]
)
RETURNS SETOF public.calendly_connections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company_id IS NULL OR p_lock_token IS NULL
     OR p_access_token_ciphertext IS NULL OR p_access_token_iv IS NULL
     OR p_access_token_tag IS NULL OR p_refresh_token_ciphertext IS NULL
     OR p_refresh_token_iv IS NULL OR p_refresh_token_tag IS NULL
     OR p_token_expires_at IS NULL THEN
    RAISE EXCEPTION 'complete refresh requires all token fields'
      USING ERRCODE = '22004';
  END IF;
  IF p_token_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'refreshed token expiry must be in the future'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.calendly_connections AS connection
  SET access_token_ciphertext = p_access_token_ciphertext,
      access_token_iv = p_access_token_iv,
      access_token_tag = p_access_token_tag,
      refresh_token_ciphertext = p_refresh_token_ciphertext,
      refresh_token_iv = p_refresh_token_iv,
      refresh_token_tag = p_refresh_token_tag,
      token_expires_at = p_token_expires_at,
      token_version = connection.token_version + 1,
      granted_scopes = CASE
        WHEN cardinality(COALESCE(p_granted_scopes, '{}'::text[])) > 0
          THEN p_granted_scopes
        ELSE connection.granted_scopes
      END,
      refresh_lock_token = NULL,
      refresh_locked_until = NULL,
      last_refreshed_at = clock_timestamp(),
      last_error = NULL,
      updated_at = clock_timestamp()
  WHERE connection.company_id = p_company_id
    AND connection.status = 'connected'
    AND connection.refresh_lock_token = p_lock_token
    AND connection.refresh_locked_until > clock_timestamp()
  RETURNING connection.*;
END
$$;

CREATE OR REPLACE FUNCTION public.invalidate_calendly_token_refresh(
  p_company_id uuid,
  p_lock_token uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed integer;
BEGIN
  IF p_company_id IS NULL OR p_lock_token IS NULL THEN
    RAISE EXCEPTION 'company_id and lock token are required'
      USING ERRCODE = '22004';
  END IF;

  UPDATE public.calendly_connections AS connection
  SET status = 'reconnect_required',
      access_token_ciphertext = NULL,
      access_token_iv = NULL,
      access_token_tag = NULL,
      refresh_token_ciphertext = NULL,
      refresh_token_iv = NULL,
      refresh_token_tag = NULL,
      token_expires_at = NULL,
      refresh_lock_token = NULL,
      refresh_locked_until = NULL,
      last_error = left(COALESCE(NULLIF(btrim(p_reason), ''), 'oauth_refresh_uncertain'), 500),
      updated_at = clock_timestamp()
  WHERE connection.company_id = p_company_id
    AND connection.refresh_lock_token = p_lock_token;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.release_calendly_token_refresh(
  p_company_id uuid,
  p_lock_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed integer;
BEGIN
  IF p_company_id IS NULL OR p_lock_token IS NULL THEN
    RAISE EXCEPTION 'company_id and lock token are required'
      USING ERRCODE = '22004';
  END IF;

  UPDATE public.calendly_connections AS connection
  SET refresh_lock_token = NULL,
      refresh_locked_until = NULL,
      updated_at = clock_timestamp()
  WHERE connection.company_id = p_company_id
    AND connection.refresh_lock_token = p_lock_token;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_calendar_booking_dispatch(
  p_company_id uuid,
  p_request_id uuid,
  p_dispatch_token uuid
)
RETURNS SETOF public.calendar_booking_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_company_id IS NULL OR p_request_id IS NULL OR p_dispatch_token IS NULL THEN
    RAISE EXCEPTION 'company_id, request_id and dispatch token are required'
      USING ERRCODE = '22004';
  END IF;

  RETURN QUERY
  UPDATE public.calendar_booking_requests AS request
  SET status = 'dispatching',
      dispatch_token = p_dispatch_token,
      dispatch_started_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE request.id = p_request_id
    AND request.company_id = p_company_id
    AND request.status = 'pending'
    AND request.dispatch_token IS NULL
    AND request.dispatch_started_at IS NULL
  RETURNING request.*;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_calendly_webhook_events(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF public.calendly_webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22004';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 600 THEN
    RAISE EXCEPTION 'invalid webhook claim limits' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM public.calendly_webhook_events AS event
    WHERE (
      event.status IN ('pending', 'retry_scheduled')
      AND event.next_attempt_at <= clock_timestamp()
    ) OR (
      event.status = 'processing'
      AND event.lease_expires_at <= clock_timestamp()
    )
    ORDER BY event.received_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE public.calendly_webhook_events AS event
  SET status = 'processing',
      attempts = event.attempts + 1,
      claimed_by = left(p_worker_id, 200),
      claimed_at = clock_timestamp(),
      lease_expires_at = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 15), 600)),
      updated_at = clock_timestamp()
  FROM candidates
  WHERE event.id = candidates.id
  RETURNING event.*;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_calendar_email_outbox(
  p_worker_id text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF public.calendar_email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22004';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 600 THEN
    RAISE EXCEPTION 'invalid email claim limits' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT email.id
    FROM public.calendar_email_outbox AS email
    WHERE email.due_at <= clock_timestamp()
      AND (
        (
          email.status IN ('pending', 'retry_scheduled')
          AND email.next_attempt_at <= clock_timestamp()
        ) OR (
          email.status = 'processing'
          AND email.lease_expires_at <= clock_timestamp()
        )
      )
    ORDER BY email.due_at, email.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE public.calendar_email_outbox AS email
  SET status = 'processing',
      attempts = email.attempts + 1,
      claimed_by = left(p_worker_id, 200),
      claimed_at = clock_timestamp(),
      lease_expires_at = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 15), 600)),
      updated_at = clock_timestamp()
  FROM candidates
  WHERE email.id = candidates.id
  RETURNING email.*;
END
$$;

-- ============================================================
-- 7. Privacy hooks and bounded retention
-- ============================================================

CREATE OR REPLACE FUNCTION private.scrub_calendar_appointment_on_anonymization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_email text;
  v_external_id text;
BEGIN
  IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL THEN
    v_email := lower(NULLIF(btrim(OLD.invitee_email), ''));
    IF v_email IS NOT NULL THEN
      -- Prefix with company_id because migration 010 intentionally has a
      -- provider-global uniqueness key, while the same invitee can appear in
      -- two independent Calendly accounts.
      v_external_id := OLD.company_id::text || ':' || v_email;
      INSERT INTO public.privacy_external_deletions (
        company_id,
        target_contact_id,
        provider,
        resource_type,
        external_id,
        requested_by_role
      ) VALUES (
        OLD.company_id,
        OLD.contact_id,
        'calendly',
        'invitee_email',
        v_external_id,
        'system'
      )
      ON CONFLICT (provider, resource_type, external_id) DO NOTHING;
    END IF;

    DELETE FROM public.calendar_email_outbox AS outbox
    WHERE outbox.company_id = OLD.company_id
      AND outbox.appointment_id = OLD.id;

    UPDATE public.calendar_booking_requests AS request
    SET status = CASE
          WHEN request.status = 'pending' THEN 'failed'
          WHEN request.status = 'dispatching' THEN 'reconciliation_required'
          ELSE request.status
        END,
        last_error = CASE
          WHEN request.status IN ('pending', 'dispatching')
            THEN 'privacy_anonymization_interrupted_booking'
          ELSE request.last_error
        END,
        contact_id = NULL,
        invitee_name = NULL,
        invitee_email = NULL,
        invitee_phone = NULL,
        invitee_timezone = NULL,
        provider_invitee_uri = NULL,
        provider_event_uri = NULL,
        provider_response = NULL,
        updated_at = clock_timestamp()
    WHERE request.company_id = OLD.company_id
      AND (
        request.appointment_id = OLD.id
        OR (
          OLD.calendly_invitee_uri IS NOT NULL
          AND request.provider_invitee_uri = OLD.calendly_invitee_uri
        )
      );

    DELETE FROM public.calendly_webhook_events AS event
    WHERE event.company_id = OLD.company_id
      AND OLD.calendly_invitee_uri IS NOT NULL
      AND event.payload #>> '{payload,uri}' = OLD.calendly_invitee_uri;

    NEW.calendly_event_id := NULL;
    NEW.calendly_event_uri := NULL;
    NEW.calendly_invitee_uri := NULL;
    NEW.calendly_cancel_url := NULL;
    NEW.calendly_reschedule_url := NULL;
    NEW.invitee_name := NULL;
    NEW.invitee_email := NULL;
    NEW.invitee_phone := NULL;
    NEW.meet_link := NULL;
    NEW.notes := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_scrub_calendar_appointment_on_anonymization
  ON public.appointments;

CREATE TRIGGER trg_scrub_calendar_appointment_on_anonymization
BEFORE UPDATE OF contact_id ON public.appointments
FOR EACH ROW
EXECUTE FUNCTION private.scrub_calendar_appointment_on_anonymization();

CREATE OR REPLACE FUNCTION private.scrub_calendar_contact_on_anonymization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN
    INSERT INTO public.privacy_external_deletions (
      company_id,
      target_contact_id,
      provider,
      resource_type,
      external_id,
      requested_by_role
    )
    SELECT
      request.company_id,
      OLD.id,
      'calendly',
      'invitee_email',
      request.company_id::text || ':' || lower(btrim(request.invitee_email)),
      'system'
    FROM public.calendar_booking_requests AS request
    WHERE request.company_id = OLD.company_id
      AND request.contact_id = OLD.id
      AND NULLIF(btrim(request.invitee_email), '') IS NOT NULL
    ON CONFLICT (provider, resource_type, external_id) DO NOTHING;

    UPDATE public.calendar_booking_requests AS request
    SET status = CASE
          WHEN request.status = 'pending' THEN 'failed'
          WHEN request.status = 'dispatching' THEN 'reconciliation_required'
          ELSE request.status
        END,
        last_error = CASE
          WHEN request.status IN ('pending', 'dispatching')
            THEN 'privacy_anonymization_interrupted_booking'
          ELSE request.last_error
        END,
        contact_id = NULL,
        invitee_name = NULL,
        invitee_email = NULL,
        invitee_phone = NULL,
        invitee_timezone = NULL,
        provider_invitee_uri = NULL,
        provider_event_uri = NULL,
        provider_response = NULL,
        updated_at = clock_timestamp()
    WHERE request.company_id = OLD.company_id
      AND request.contact_id = OLD.id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_scrub_calendar_contact_on_anonymization
  ON public.contacts;

CREATE TRIGGER trg_scrub_calendar_contact_on_anonymization
AFTER UPDATE OF anonymized_at ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION private.scrub_calendar_contact_on_anonymization();

CREATE OR REPLACE FUNCTION public.purge_expired_calendar_data(
  p_batch_size integer DEFAULT 500,
  p_appointment_retention_days integer DEFAULT 730
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch integer;
  v_oauth_states integer := 0;
  v_webhooks integer := 0;
  v_outbox integer := 0;
  v_bookings integer := 0;
  v_dispatches integer := 0;
  v_appointments integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 5000'
      USING ERRCODE = '22023';
  END IF;
  IF p_appointment_retention_days IS NULL
     OR p_appointment_retention_days NOT BETWEEN 30 AND 3650 THEN
    RAISE EXCEPTION 'appointment retention must be between 30 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  v_batch := p_batch_size;

  WITH candidates AS (
    SELECT state_hash
    FROM public.calendly_oauth_states
    WHERE expires_at < clock_timestamp() - interval '1 day'
       OR consumed_at < clock_timestamp() - interval '1 day'
    ORDER BY created_at
    LIMIT v_batch
  ), deleted AS (
    DELETE FROM public.calendly_oauth_states AS state
    USING candidates
    WHERE state.state_hash = candidates.state_hash
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_oauth_states FROM deleted;

  WITH candidates AS (
    SELECT id
    FROM public.calendly_webhook_events
    WHERE (
      status IN ('completed', 'ignored')
      AND processed_at < clock_timestamp() - interval '30 days'
    ) OR (
      status = 'failed'
      AND updated_at < clock_timestamp() - interval '90 days'
    )
    ORDER BY received_at
    LIMIT v_batch
  ), deleted AS (
    DELETE FROM public.calendly_webhook_events AS event
    USING candidates
    WHERE event.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_webhooks FROM deleted;

  WITH candidates AS (
    SELECT id
    FROM public.calendar_email_outbox
    WHERE (
      status IN ('sent', 'cancelled')
      AND updated_at < clock_timestamp() - interval '30 days'
    ) OR (
      status = 'failed'
      AND updated_at < clock_timestamp() - interval '90 days'
    )
    ORDER BY created_at
    LIMIT v_batch
  ), deleted AS (
    DELETE FROM public.calendar_email_outbox AS email
    USING candidates
    WHERE email.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_outbox FROM deleted;

  UPDATE public.calendar_booking_requests AS request
  SET status = 'reconciliation_required',
      last_error = COALESCE(request.last_error, 'dispatch_interrupted'),
      updated_at = clock_timestamp()
  WHERE request.id IN (
    SELECT stale.id
    FROM public.calendar_booking_requests AS stale
    WHERE stale.status = 'dispatching'
      AND stale.dispatch_started_at < clock_timestamp() - interval '15 minutes'
    ORDER BY stale.dispatch_started_at
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_dispatches = ROW_COUNT;

  WITH candidates AS (
    SELECT id
    FROM public.calendar_booking_requests
    WHERE (
      status IN ('committed', 'failed')
      AND updated_at < clock_timestamp() - interval '90 days'
    ) OR (
      status = 'reconciliation_required'
      AND updated_at < clock_timestamp() - interval '365 days'
    )
    ORDER BY created_at
    LIMIT v_batch
  ), deleted AS (
    DELETE FROM public.calendar_booking_requests AS request
    USING candidates
    WHERE request.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_bookings FROM deleted;

  UPDATE public.appointments AS appointment
  SET contact_id = NULL,
      external_id = NULL,
      updated_at = clock_timestamp()
  WHERE appointment.id IN (
    SELECT expired.id
    FROM public.appointments AS expired
    WHERE expired.contact_id IS NOT NULL
      AND expired.status IN ('completed', 'cancelled')
      AND COALESCE(expired.end_at, expired.start_at, expired.date::timestamptz)
          < clock_timestamp() - make_interval(days => p_appointment_retention_days)
    ORDER BY COALESCE(expired.end_at, expired.start_at, expired.date::timestamptz)
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_appointments = ROW_COUNT;

  RETURN jsonb_build_object(
    'oauth_states_deleted', v_oauth_states,
    'webhooks_deleted', v_webhooks,
    'email_outbox_deleted', v_outbox,
    'booking_requests_deleted', v_bookings,
    'dispatches_quarantined', v_dispatches,
    'appointments_anonymized', v_appointments
  );
END
$$;

-- ============================================================
-- 8. RLS and explicit backend-only privileges
-- ============================================================

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'calendly_connections',
    'calendly_oauth_states',
    'calendly_webhook_events',
    'calendar_booking_requests',
    'calendar_email_outbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);

    -- Only replace the policy owned by this migration. Never remove policies
    -- installed by a later migration when 013 is replayed.
    EXECUTE format(
      'DROP POLICY IF EXISTS service_role_bypass ON public.%I',
      table_name
    );

    EXECUTE format(
      'CREATE POLICY service_role_bypass ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      table_name
    );

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role',
      table_name
    );
  END LOOP;
END
$$;

REVOKE ALL
ON FUNCTION public.consume_calendly_oauth_state(text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.claim_calendly_token_refresh(uuid, uuid, integer)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.complete_calendly_token_refresh(
  uuid, uuid, text, text, text, text, text, text, timestamptz, text[]
)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.invalidate_calendly_token_refresh(uuid, uuid, text)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.release_calendly_token_refresh(uuid, uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.claim_calendar_booking_dispatch(uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.claim_calendly_webhook_events(text, integer, integer)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.claim_calendar_email_outbox(text, integer, integer)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION public.purge_expired_calendar_data(integer, integer)
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION private.scrub_calendar_appointment_on_anonymization()
FROM PUBLIC, anon, authenticated;
REVOKE ALL
ON FUNCTION private.scrub_calendar_contact_on_anonymization()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.consume_calendly_oauth_state(text)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.claim_calendly_token_refresh(uuid, uuid, integer)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.complete_calendly_token_refresh(
  uuid, uuid, text, text, text, text, text, text, timestamptz, text[]
)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.invalidate_calendly_token_refresh(uuid, uuid, text)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.release_calendly_token_refresh(uuid, uuid)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.claim_calendar_booking_dispatch(uuid, uuid, uuid)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.claim_calendly_webhook_events(text, integer, integer)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.claim_calendar_email_outbox(text, integer, integer)
TO service_role;
GRANT EXECUTE
ON FUNCTION public.purge_expired_calendar_data(integer, integer)
TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
