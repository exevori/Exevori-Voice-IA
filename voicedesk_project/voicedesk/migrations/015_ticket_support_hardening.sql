-- ============================================================================
-- EXEVORI VOICE IA — Migration 015
-- Support tickets professionnel : intégrité tenant, transactions et courriels
-- durables avec alertes SLA idempotentes.
--
-- IMPORTANT
--   * Cette migration est préparée pour déploiement, mais n'est pas exécutée ici.
--   * Les courriels sont mis en file dans la même transaction que le ticket ou
--     le message. Aucun appel réseau n'est effectué dans une transaction SQL.
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 1. Garde de schéma : échouer avant toute mutation si la base attendue diverge
-- --------------------------------------------------------------------------

DO $migration$
DECLARE
  missing_columns text[];
BEGIN
  IF to_regprocedure('private.current_company_id()') IS NULL
     OR to_regprocedure('private.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION
      'Migration 015 aborted — migration 009 tenant helpers are missing';
  END IF;

  SELECT array_agg(required.table_name || '.' || required.column_name)
  INTO missing_columns
  FROM (VALUES
    ('tickets', 'id'),
    ('tickets', 'company_id'),
    ('tickets', 'ticket_number'),
    ('tickets', 'subject'),
    ('tickets', 'description'),
    ('tickets', 'category'),
    ('tickets', 'priority'),
    ('tickets', 'status'),
    ('tickets', 'created_by_user_id'),
    ('tickets', 'created_by_name'),
    ('tickets', 'created_by_email'),
    ('tickets', 'assigned_to_user_id'),
    ('tickets', 'assigned_to_name'),
    ('tickets', 'sla_first_response_due'),
    ('tickets', 'sla_resolution_due'),
    ('tickets', 'first_response_at'),
    ('tickets', 'resolved_at'),
    ('tickets', 'closed_at'),
    ('tickets', 'resolution_summary'),
    ('tickets', 'satisfaction_rating'),
    ('tickets', 'internal_notes'),
    ('tickets', 'created_at'),
    ('tickets', 'updated_at'),
    ('ticket_messages', 'id'),
    ('ticket_messages', 'ticket_id'),
    ('ticket_messages', 'company_id'),
    ('ticket_messages', 'author_user_id'),
    ('ticket_messages', 'author_name'),
    ('ticket_messages', 'author_role'),
    ('ticket_messages', 'body'),
    ('ticket_messages', 'is_internal'),
    ('ticket_messages', 'attachments'),
    ('ticket_messages', 'created_at'),
    ('ticket_attachments', 'id'),
    ('ticket_attachments', 'ticket_id'),
    ('ticket_attachments', 'message_id'),
    ('profiles', 'user_id'),
    ('profiles', 'company_id'),
    ('profiles', 'full_name'),
    ('profiles', 'email'),
    ('profiles', 'role'),
    ('profiles', 'status'),
    ('notification_preferences', 'user_id'),
    ('notification_preferences', 'ticket_email')
  ) AS required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS existing
    WHERE existing.table_schema = 'public'
      AND existing.table_name = required.table_name
      AND existing.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 015 aborted — missing required columns: %',
      array_to_string(missing_columns, ', ');
  END IF;
END
$migration$;

-- --------------------------------------------------------------------------
-- 2. Contraintes tenant et indexes des accès réels
-- --------------------------------------------------------------------------

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tickets'::regclass
      AND conname = 'tickets_id_company_unique'
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_id_company_unique UNIQUE (id, company_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ticket_messages'::regclass
      AND conname = 'ticket_messages_id_ticket_unique'
  ) THEN
    ALTER TABLE public.ticket_messages
      ADD CONSTRAINT ticket_messages_id_ticket_unique UNIQUE (id, ticket_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ticket_messages'::regclass
      AND conname = 'ticket_messages_ticket_company_fk'
  ) THEN
    ALTER TABLE public.ticket_messages
      ADD CONSTRAINT ticket_messages_ticket_company_fk
      FOREIGN KEY (ticket_id, company_id)
      REFERENCES public.tickets(id, company_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ticket_attachments'::regclass
      AND conname = 'ticket_attachments_message_ticket_fk'
  ) THEN
    ALTER TABLE public.ticket_attachments
      ADD CONSTRAINT ticket_attachments_message_ticket_fk
      FOREIGN KEY (message_id, ticket_id)
      REFERENCES public.ticket_messages(id, ticket_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tickets'::regclass
      AND conname = 'tickets_required_identity_check'
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_required_identity_check
      CHECK (company_id IS NOT NULL AND ticket_number IS NOT NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ticket_messages'::regclass
      AND conname = 'ticket_messages_required_content_check'
  ) THEN
    ALTER TABLE public.ticket_messages
      ADD CONSTRAINT ticket_messages_required_content_check
      CHECK (
        ticket_id IS NOT NULL
        AND company_id IS NOT NULL
        AND author_role IS NOT NULL
        AND NULLIF(btrim(body), '') IS NOT NULL
      )
      NOT VALID;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_tickets_company_status_updated
  ON public.tickets(company_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_active_sla_response
  ON public.tickets(sla_first_response_due, id)
  WHERE first_response_at IS NULL
    AND status IN ('open', 'in_progress', 'waiting_client');

CREATE INDEX IF NOT EXISTS idx_tickets_active_sla_resolution
  ON public.tickets(sla_resolution_due, id)
  WHERE resolved_at IS NULL
    AND status IN ('open', 'in_progress', 'waiting_client');

CREATE INDEX IF NOT EXISTS idx_ticket_messages_company_ticket_created
  ON public.ticket_messages(company_id, ticket_id, created_at);

-- Numéro lisible, monotone et sans course entre deux créations concurrentes.
CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number_seq AS bigint;

DO $migration$
DECLARE
  max_existing bigint;
BEGIN
  SELECT max((regexp_match(ticket_number, '^T-[0-9]{4}-([0-9]+)$'))[1]::bigint)
  INTO max_existing
  FROM public.tickets
  WHERE ticket_number ~ '^T-[0-9]{4}-[0-9]+$';

  IF max_existing IS NULL THEN
    PERFORM setval('public.support_ticket_number_seq', 1, false);
  ELSE
    PERFORM setval(
      'public.support_ticket_number_seq',
      GREATEST(max_existing, last_value),
      true
    )
    FROM public.support_ticket_number_seq;
  END IF;
END
$migration$;

REVOKE ALL ON SEQUENCE public.support_ticket_number_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.support_ticket_number_seq
  TO service_role;

-- --------------------------------------------------------------------------
-- 3. Outbox transactionnelle sans copie du contenu client
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ticket_email_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  ticket_id          uuid NOT NULL,
  message_id         uuid,
  email_kind         text NOT NULL CHECK (email_kind IN (
                       'new_ticket', 'client_reply', 'agent_reply',
                       'sla_at_risk', 'sla_breached'
                     )),
  recipient_kind     text NOT NULL CHECK (recipient_kind IN (
                       'profile', 'ticket_creator'
                     )),
  recipient_user_id  uuid,
  context            jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key    text NOT NULL UNIQUE
                       CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'processing', 'retry_scheduled',
                       'sent', 'suppressed', 'failed'
                     )),
  attempts           smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  claimed_by         text,
  claimed_at         timestamptz,
  lease_expires_at   timestamptz,
  provider_message_id text,
  last_error         text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_email_outbox_ticket_company_fk
    FOREIGN KEY (ticket_id, company_id)
    REFERENCES public.tickets(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT ticket_email_outbox_message_ticket_fk
    FOREIGN KEY (message_id, ticket_id)
    REFERENCES public.ticket_messages(id, ticket_id)
    ON DELETE CASCADE,
  CONSTRAINT ticket_email_outbox_recipient_check CHECK (
    recipient_kind = 'ticket_creator'
    OR recipient_user_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_ticket_email_outbox_claim
  ON public.ticket_email_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry_scheduled', 'processing');

CREATE INDEX IF NOT EXISTS idx_ticket_email_outbox_ticket
  ON public.ticket_email_outbox(company_id, ticket_id, created_at DESC);

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_email_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON public.ticket_email_outbox;
CREATE POLICY service_role_bypass
  ON public.ticket_email_outbox
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.ticket_email_outbox
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ticket_email_outbox
  TO service_role;

-- --------------------------------------------------------------------------
-- 4. Création atomique du ticket, du premier message et des notifications
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_support_ticket(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_email text,
  p_actor_role text,
  p_subject text,
  p_description text,
  p_category text,
  p_priority text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  ticket public.tickets%ROWTYPE;
  message public.ticket_messages%ROWTYPE;
  created_at timestamptz := clock_timestamp();
  first_response_hours integer;
  resolution_hours integer;
BEGIN
  IF p_company_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'company and actor are required' USING ERRCODE = '22004';
  END IF;
  IF p_actor_role IS NULL OR p_actor_role NOT IN ('client', 'exevori_agent') THEN
    RAISE EXCEPTION 'invalid actor role' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(COALESCE(p_subject, ''))) NOT BETWEEN 1 AND 200
     OR char_length(btrim(COALESCE(p_description, ''))) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid ticket content' USING ERRCODE = '22023';
  END IF;
  IF p_category IS NULL OR p_category NOT IN (
    'general', 'billing', 'technical', 'feature_request', 'bug', 'onboarding'
  ) OR p_priority IS NULL
     OR p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'invalid category or priority' USING ERRCODE = '22023';
  END IF;

  IF p_actor_role = 'client' AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_actor_user_id
      AND profile.company_id = p_company_id
      AND profile.status = 'active'
  ) THEN
    RAISE EXCEPTION 'client actor does not belong to company'
      USING ERRCODE = '42501';
  ELSIF p_actor_role = 'exevori_agent' AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_actor_user_id
      AND profile.role = 'super_admin'
      AND profile.status = 'active'
  ) THEN
    RAISE EXCEPTION 'agent actor is not active super admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    CASE p_priority
      WHEN 'urgent' THEN 1 WHEN 'high' THEN 4
      WHEN 'normal' THEN 24 ELSE 48
    END,
    CASE p_priority
      WHEN 'urgent' THEN 4 WHEN 'high' THEN 24
      WHEN 'normal' THEN 72 ELSE 168
    END
  INTO first_response_hours, resolution_hours;

  INSERT INTO public.tickets (
    company_id,
    ticket_number,
    subject,
    description,
    category,
    priority,
    status,
    created_by_user_id,
    created_by_name,
    created_by_email,
    sla_first_response_due,
    sla_resolution_due,
    created_at,
    updated_at
  ) VALUES (
    p_company_id,
    'T-' || to_char(created_at, 'YYYY') || '-'
      || lpad(nextval('public.support_ticket_number_seq')::text, 6, '0'),
    btrim(p_subject),
    btrim(p_description),
    p_category,
    p_priority,
    'open',
    p_actor_user_id,
    left(NULLIF(btrim(p_actor_name), ''), 200),
    left(NULLIF(lower(btrim(p_actor_email)), ''), 320),
    created_at + make_interval(hours => first_response_hours),
    created_at + make_interval(hours => resolution_hours),
    created_at,
    created_at
  )
  RETURNING * INTO ticket;

  INSERT INTO public.ticket_messages (
    ticket_id,
    company_id,
    author_user_id,
    author_name,
    author_role,
    body,
    is_internal,
    attachments,
    created_at
  ) VALUES (
    ticket.id,
    ticket.company_id,
    p_actor_user_id,
    left(NULLIF(btrim(p_actor_name), ''), 200),
    p_actor_role,
    btrim(p_description),
    false,
    '[]'::jsonb,
    created_at
  )
  RETURNING * INTO message;

  INSERT INTO public.ticket_email_outbox (
    company_id,
    ticket_id,
    message_id,
    email_kind,
    recipient_kind,
    recipient_user_id,
    idempotency_key,
    next_attempt_at
  )
  SELECT
    ticket.company_id,
    ticket.id,
    message.id,
    'new_ticket',
    'profile',
    profile.user_id,
    'ticket/new/' || ticket.id::text || '/' || profile.user_id::text,
    created_at
  FROM public.profiles AS profile
  WHERE profile.role = 'super_admin'
    AND profile.status = 'active'
    AND NULLIF(btrim(profile.email), '') IS NOT NULL
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'ticket', to_jsonb(ticket),
    'message', to_jsonb(message)
  );
END
$function$;

-- --------------------------------------------------------------------------
-- 5. Réponse atomique : message, transition et notification
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.append_support_ticket_message(
  p_ticket_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_role text,
  p_body text,
  p_is_internal boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  ticket public.tickets%ROWTYPE;
  message public.ticket_messages%ROWTYPE;
  created_at timestamptz := clock_timestamp();
  next_status text;
  next_first_response_at timestamptz;
  assigned_agent_active boolean;
BEGIN
  IF p_ticket_id IS NULL OR p_company_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'ticket, company and actor are required' USING ERRCODE = '22004';
  END IF;
  IF p_actor_role IS NULL OR p_actor_role NOT IN ('client', 'exevori_agent') THEN
    RAISE EXCEPTION 'invalid actor role' USING ERRCODE = '22023';
  END IF;
  IF p_is_internal IS TRUE AND p_actor_role <> 'exevori_agent' THEN
    RAISE EXCEPTION 'internal notes require an agent' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(COALESCE(p_body, ''))) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid message body' USING ERRCODE = '22023';
  END IF;

  IF p_actor_role = 'client' AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_actor_user_id
      AND profile.company_id = p_company_id
      AND profile.status = 'active'
  ) THEN
    RAISE EXCEPTION 'client actor does not belong to company'
      USING ERRCODE = '42501';
  ELSIF p_actor_role = 'exevori_agent' AND NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_actor_user_id
      AND profile.role = 'super_admin'
      AND profile.status = 'active'
  ) THEN
    RAISE EXCEPTION 'agent actor is not active super admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT existing.*
  INTO ticket
  FROM public.tickets AS existing
  WHERE existing.id = p_ticket_id
    AND existing.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket not found' USING ERRCODE = 'P0002';
  END IF;
  IF ticket.status = 'closed' AND p_is_internal IS NOT TRUE THEN
    RAISE EXCEPTION 'closed ticket cannot receive public replies'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ticket_messages (
    ticket_id,
    company_id,
    author_user_id,
    author_name,
    author_role,
    body,
    is_internal,
    attachments,
    created_at
  ) VALUES (
    ticket.id,
    ticket.company_id,
    p_actor_user_id,
    left(NULLIF(btrim(p_actor_name), ''), 200),
    p_actor_role,
    btrim(p_body),
    p_is_internal IS TRUE,
    '[]'::jsonb,
    created_at
  )
  RETURNING * INTO message;

  next_status := ticket.status;
  next_first_response_at := ticket.first_response_at;

  IF p_is_internal IS NOT TRUE THEN
    IF p_actor_role = 'exevori_agent' THEN
      IF next_first_response_at IS NULL THEN
        next_first_response_at := created_at;
      END IF;
      IF ticket.status = 'open' THEN
        next_status := 'in_progress';
      END IF;
    ELSIF ticket.status IN ('waiting_client', 'resolved') THEN
      next_status := 'in_progress';
    END IF;
  END IF;

  UPDATE public.tickets AS updated
  SET status = next_status,
      first_response_at = next_first_response_at,
      resolved_at = CASE
        WHEN next_status = 'resolved' THEN updated.resolved_at
        ELSE NULL
      END,
      closed_at = CASE
        WHEN next_status = 'closed' THEN updated.closed_at
        ELSE NULL
      END,
      updated_at = created_at
  WHERE updated.id = ticket.id
    AND updated.company_id = ticket.company_id
  RETURNING updated.* INTO ticket;

  IF p_is_internal IS NOT TRUE AND p_actor_role = 'exevori_agent' THEN
    INSERT INTO public.ticket_email_outbox (
      company_id,
      ticket_id,
      message_id,
      email_kind,
      recipient_kind,
      recipient_user_id,
      idempotency_key,
      next_attempt_at
    ) VALUES (
      ticket.company_id,
      ticket.id,
      message.id,
      'agent_reply',
      'ticket_creator',
      ticket.created_by_user_id,
      'ticket/agent-reply/' || message.id::text || '/creator',
      created_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  ELSIF p_is_internal IS NOT TRUE AND p_actor_role = 'client' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = ticket.assigned_to_user_id
        AND profile.role = 'super_admin'
        AND profile.status = 'active'
        AND NULLIF(btrim(profile.email), '') IS NOT NULL
    )
    INTO assigned_agent_active;

    INSERT INTO public.ticket_email_outbox (
      company_id,
      ticket_id,
      message_id,
      email_kind,
      recipient_kind,
      recipient_user_id,
      idempotency_key,
      next_attempt_at
    )
    SELECT
      ticket.company_id,
      ticket.id,
      message.id,
      'client_reply',
      'profile',
      profile.user_id,
      'ticket/client-reply/' || message.id::text || '/' || profile.user_id::text,
      created_at
    FROM public.profiles AS profile
    WHERE profile.role = 'super_admin'
      AND profile.status = 'active'
      AND NULLIF(btrim(profile.email), '') IS NOT NULL
      AND (
        assigned_agent_active IS NOT TRUE
        OR profile.user_id = ticket.assigned_to_user_id
      )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'ticket', to_jsonb(ticket),
    'message', to_jsonb(message)
  );
END
$function$;

-- --------------------------------------------------------------------------
-- 6. Alertes SLA idempotentes et file avec bail de traitement
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_ticket_sla_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  inserted_count integer;
BEGIN
  WITH milestones AS (
    SELECT
      ticket.id AS ticket_id,
      ticket.company_id,
      'first_response'::text AS milestone,
      ticket.sla_first_response_due AS deadline,
      interval '1 hour' AS risk_window
    FROM public.tickets AS ticket
    WHERE ticket.status IN ('open', 'in_progress', 'waiting_client')
      AND ticket.first_response_at IS NULL
      AND ticket.sla_first_response_due IS NOT NULL

    UNION ALL

    SELECT
      ticket.id,
      ticket.company_id,
      'resolution'::text,
      ticket.sla_resolution_due,
      interval '4 hours'
    FROM public.tickets AS ticket
    WHERE ticket.status IN ('open', 'in_progress', 'waiting_client')
      AND ticket.resolved_at IS NULL
      AND ticket.sla_resolution_due IS NOT NULL
  ), due_alerts AS (
    SELECT
      milestone.*,
      CASE
        WHEN milestone.deadline <= clock_timestamp() THEN 'sla_breached'
        WHEN milestone.deadline <= clock_timestamp() + milestone.risk_window
          THEN 'sla_at_risk'
        ELSE NULL
      END AS email_kind
    FROM milestones AS milestone
  )
  INSERT INTO public.ticket_email_outbox (
    company_id,
    ticket_id,
    email_kind,
    recipient_kind,
    recipient_user_id,
    context,
    idempotency_key,
    next_attempt_at
  )
  SELECT
    alert.company_id,
    alert.ticket_id,
    alert.email_kind,
    'profile',
    profile.user_id,
    jsonb_build_object(
      'sla_milestone', alert.milestone,
      'sla_deadline', alert.deadline
    ),
    'ticket/' || replace(alert.email_kind, '_', '-') || '/'
      || alert.ticket_id::text || '/' || alert.milestone || '/'
      || floor(extract(epoch FROM alert.deadline))::bigint::text || '/'
      || profile.user_id::text,
    clock_timestamp()
  FROM due_alerts AS alert
  CROSS JOIN public.profiles AS profile
  WHERE alert.email_kind IS NOT NULL
    AND profile.role = 'super_admin'
    AND profile.status = 'active'
    AND NULLIF(btrim(profile.email), '') IS NOT NULL
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_ticket_email_outbox(
  p_worker_id text,
  p_limit integer DEFAULT 20,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.ticket_email_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NULLIF(btrim(p_worker_id), '') IS NULL THEN
    RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22004';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid ticket email claim limits' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT email.id
    FROM public.ticket_email_outbox AS email
    WHERE (
      email.status IN ('pending', 'retry_scheduled')
      AND email.next_attempt_at <= clock_timestamp()
    ) OR (
      email.status = 'processing'
      AND email.lease_expires_at <= clock_timestamp()
    )
    ORDER BY email.next_attempt_at, email.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE public.ticket_email_outbox AS email
  SET status = 'processing',
      attempts = email.attempts + 1,
      claimed_by = left(p_worker_id, 200),
      claimed_at = clock_timestamp(),
      lease_expires_at = clock_timestamp()
        + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 600)),
      last_error = NULL,
      updated_at = clock_timestamp()
  FROM candidates
  WHERE email.id = candidates.id
  RETURNING email.*;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_ticket_email_outbox(
  p_job_id uuid,
  p_worker_id text,
  p_provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.ticket_email_outbox AS email
  SET status = 'sent',
      provider_message_id = left(NULLIF(btrim(p_provider_message_id), ''), 500),
      sent_at = clock_timestamp(),
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      updated_at = clock_timestamp()
  WHERE email.id = p_job_id
    AND email.status = 'processing'
    AND email.claimed_by = p_worker_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.suppress_ticket_email_outbox(
  p_job_id uuid,
  p_worker_id text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.ticket_email_outbox AS email
  SET status = 'suppressed',
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error = left(COALESCE(p_reason, 'recipient_suppressed'), 1000),
      updated_at = clock_timestamp()
  WHERE email.id = p_job_id
    AND email.status = 'processing'
    AND email.claimed_by = p_worker_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.fail_ticket_email_outbox(
  p_job_id uuid,
  p_worker_id text,
  p_error text,
  p_retry_delay_seconds integer DEFAULT 60
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  next_status text;
BEGIN
  IF p_retry_delay_seconds IS NULL
     OR p_retry_delay_seconds NOT BETWEEN 30 AND 86400 THEN
    RAISE EXCEPTION 'invalid ticket email retry delay' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ticket_email_outbox AS email
  SET status = CASE WHEN email.attempts >= 8 THEN 'failed' ELSE 'retry_scheduled' END,
      next_attempt_at = CASE
        WHEN email.attempts >= 8 THEN email.next_attempt_at
        ELSE clock_timestamp() + make_interval(secs => p_retry_delay_seconds)
      END,
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error = left(COALESCE(p_error, 'ticket_email_failed'), 1000),
      updated_at = clock_timestamp()
  WHERE email.id = p_job_id
    AND email.status = 'processing'
    AND email.claimed_by = p_worker_id
  RETURNING email.status INTO next_status;

  RETURN next_status;
END
$function$;

CREATE OR REPLACE FUNCTION public.purge_ticket_email_outbox(
  p_batch_size integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'invalid purge batch size' USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT email.id
    FROM public.ticket_email_outbox AS email
    WHERE (
      email.status IN ('sent', 'suppressed')
      AND email.updated_at < clock_timestamp() - interval '30 days'
    ) OR (
      email.status = 'failed'
      AND email.updated_at < clock_timestamp() - interval '90 days'
    )
    ORDER BY email.updated_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  DELETE FROM public.ticket_email_outbox AS email
  USING expired
  WHERE email.id = expired.id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$function$;

-- --------------------------------------------------------------------------
-- 7. Privilèges RPC minimaux
-- --------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_support_ticket(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(
  uuid, uuid, text, text, text, text, text, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.append_support_ticket_message(
  uuid, uuid, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_support_ticket_message(
  uuid, uuid, uuid, text, text, text, boolean
) TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_ticket_sla_alerts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_ticket_sla_alerts()
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_ticket_email_outbox(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ticket_email_outbox(text, integer, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.complete_ticket_email_outbox(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ticket_email_outbox(uuid, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.suppress_ticket_email_outbox(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suppress_ticket_email_outbox(uuid, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fail_ticket_email_outbox(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_ticket_email_outbox(uuid, text, text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.purge_ticket_email_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ticket_email_outbox(integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
