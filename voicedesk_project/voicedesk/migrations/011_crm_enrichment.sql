-- Migration 011 — CRM enrichment, consent and atomic duplicate merge
-- The visible pipeline is new -> qualified -> client -> lost -> archived.
-- `anonymized` remains an internal terminal state required by migration 010.

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
    'audit_log',
    'calls',
    'contact_notes',
    'contacts',
    'dnc_list',
    'email_drafts',
    'emails',
    'outbound_calls'
  ]::text[]) AS required(table_name)
  WHERE to_regclass('public.' || quote_ident(required.table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 011 aborted — missing tables: %',
      array_to_string(missing_tables, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dnc_list'
      AND column_name = 'reason'
  ) THEN
    RAISE EXCEPTION
      'Migration 011 aborted — public.dnc_list.reason is required';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- CREATE EXTENSION ... IF NOT EXISTS keeps an extension in its current schema.
-- Keep every reference deterministic even when pg_trgm was installed earlier.
DO $$
DECLARE
  extension_schema text;
BEGIN
  SELECT n.nspname
  INTO extension_schema
  FROM pg_extension AS e
  JOIN pg_namespace AS n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  IF extension_schema IS DISTINCT FROM 'extensions' THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS crm_private;

REVOKE ALL ON SCHEMA crm_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA crm_private, extensions TO service_role;

-- ============================================================
-- 2. Contact fields and DNC provenance
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS next_action_date timestamptz,
  ADD COLUMN IF NOT EXISTS next_action_note text,
  ADD COLUMN IF NOT EXISTS email_consent boolean,
  ADD COLUMN IF NOT EXISTS email_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_consent boolean,
  ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS call_consent boolean,
  ADD COLUMN IF NOT EXISTS call_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS merged_into_contact_id uuid;

ALTER TABLE public.dnc_list
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Fail before data rewrites or function replacement if production drifted
-- from any column contract used below. This is intentionally exhaustive for
-- the contact updates, child reassignment and audit insert performed by merge.
DO $$
DECLARE
  missing_columns text[];
BEGIN
  SELECT array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.column_name
  )
  INTO missing_columns
  FROM (
    VALUES
      ('appointments', 'company_id'),
      ('appointments', 'contact_id'),
      ('audit_log', 'action'),
      ('audit_log', 'actor_role'),
      ('audit_log', 'actor_user_id'),
      ('audit_log', 'company_id'),
      ('audit_log', 'details'),
      ('audit_log', 'entity_id'),
      ('audit_log', 'entity_type'),
      ('calls', 'company_id'),
      ('calls', 'contact_id'),
      ('contact_notes', 'company_id'),
      ('contact_notes', 'contact_id'),
      ('contacts', 'archived_at'),
      ('contacts', 'archived_by'),
      ('contacts', 'budget'),
      ('contacts', 'call_consent'),
      ('contacts', 'call_consent_at'),
      ('contacts', 'company'),
      ('contacts', 'company_id'),
      ('contacts', 'created_at'),
      ('contacts', 'email'),
      ('contacts', 'email_consent'),
      ('contacts', 'email_consent_at'),
      ('contacts', 'first_name'),
      ('contacts', 'full_name'),
      ('contacts', 'id'),
      ('contacts', 'last_interaction_at'),
      ('contacts', 'last_name'),
      ('contacts', 'main_need'),
      ('contacts', 'merged_into_contact_id'),
      ('contacts', 'next_action'),
      ('contacts', 'next_action_date'),
      ('contacts', 'next_action_note'),
      ('contacts', 'notes'),
      ('contacts', 'phone'),
      ('contacts', 'sms_consent'),
      ('contacts', 'sms_consent_at'),
      ('contacts', 'source'),
      ('contacts', 'status'),
      ('contacts', 'tags'),
      ('contacts', 'updated_at'),
      ('contacts', 'urgency'),
      ('dnc_list', 'company_id'),
      ('dnc_list', 'phone'),
      ('dnc_list', 'reason'),
      ('dnc_list', 'source'),
      ('email_drafts', 'company_id'),
      ('email_drafts', 'contact_id'),
      ('emails', 'company_id'),
      ('emails', 'contact_id'),
      ('outbound_calls', 'company_id'),
      ('outbound_calls', 'contact_id')
  ) AS required(table_name, column_name)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
   AND actual.table_name = required.table_name
   AND actual.column_name = required.column_name
  WHERE actual.column_name IS NULL;

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 011 aborted — missing required columns: %',
      array_to_string(missing_columns, ', ');
  END IF;
END
$$;

UPDATE public.contacts
SET next_action_note = next_action
WHERE next_action_note IS NULL
  AND NULLIF(btrim(next_action), '') IS NOT NULL;

-- Remove only prior status constraints so the historical values can be mapped.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'public.contacts'::regclass
      AND con.contype = 'c'
      AND position('status' IN lower(pg_get_constraintdef(con.oid))) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE public.contacts DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;

UPDATE public.contacts
SET status = CASE lower(COALESCE(status, 'new'))
  WHEN 'new'               THEN 'new'
  WHEN 'nouveau'           THEN 'new'
  WHEN 'hot'               THEN 'qualified'
  WHEN 'warm'              THEN 'qualified'
  WHEN 'hot_lead'          THEN 'qualified'
  WHEN 'callback_required' THEN 'qualified'
  WHEN 'appointment_set'   THEN 'qualified'
  WHEN 'qualified'         THEN 'qualified'
  WHEN 'qualifie'          THEN 'qualified'
  WHEN 'qualifié'          THEN 'qualified'
  WHEN 'customer'          THEN 'client'
  WHEN 'client'            THEN 'client'
  WHEN 'cold'              THEN 'lost'
  WHEN 'not_interested'    THEN 'lost'
  WHEN 'lost'              THEN 'lost'
  WHEN 'perdu'             THEN 'lost'
  WHEN 'archived'          THEN 'archived'
  WHEN 'archive'           THEN 'archived'
  WHEN 'archivé'           THEN 'archived'
  WHEN 'anonymized'        THEN 'anonymized'
  ELSE 'new'
END;

UPDATE public.contacts
SET archived_at = COALESCE(archived_at, updated_at, created_at, now())
WHERE status = 'archived'
  AND archived_at IS NULL;

CREATE OR REPLACE FUNCTION crm_private.normalize_e164(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  normalized text := NULLIF(btrim(p_phone), '');
BEGIN
  IF normalized IS NULL THEN
    RETURN NULL;
  END IF;

  normalized := regexp_replace(normalized, '[[:space:]()./-]', '', 'g');

  IF normalized LIKE '00%' THEN
    normalized := '+' || substring(normalized FROM 3);
  ELSIF normalized ~ '^[0-9]{10}$' THEN
    normalized := '+1' || normalized;
  ELSIF normalized ~ '^1[0-9]{10}$' THEN
    normalized := '+' || normalized;
  END IF;

  IF normalized !~ '^[+][1-9][0-9]{7,14}$' THEN
    RETURN NULL;
  END IF;

  RETURN normalized;
END
$$;

REVOKE ALL
ON FUNCTION crm_private.normalize_e164(text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION crm_private.normalize_e164(text)
TO service_role;

-- Normalize every recoverable legacy value without silently discarding any
-- value that cannot be converted. The NOT VALID constraint below protects all
-- new/updated active contacts while legacy cleanup can be reviewed separately.
UPDATE public.contacts
SET phone = crm_private.normalize_e164(phone)
WHERE phone IS NOT NULL
  AND crm_private.normalize_e164(phone) IS NOT NULL
  AND phone IS DISTINCT FROM crm_private.normalize_e164(phone);

CREATE OR REPLACE FUNCTION crm_private.prepare_contact_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  normalized_phone text;
  normalized_status text := lower(COALESCE(NEW.status, 'new'));
BEGIN
  NEW.status := CASE normalized_status
    WHEN 'new'               THEN 'new'
    WHEN 'nouveau'           THEN 'new'
    WHEN 'hot'               THEN 'qualified'
    WHEN 'warm'              THEN 'qualified'
    WHEN 'hot_lead'          THEN 'qualified'
    WHEN 'callback_required' THEN 'qualified'
    WHEN 'appointment_set'   THEN 'qualified'
    WHEN 'qualified'         THEN 'qualified'
    WHEN 'qualifie'          THEN 'qualified'
    WHEN 'qualifié'          THEN 'qualified'
    WHEN 'customer'          THEN 'client'
    WHEN 'client'            THEN 'client'
    WHEN 'cold'              THEN 'lost'
    WHEN 'not_interested'    THEN 'lost'
    WHEN 'lost'              THEN 'lost'
    WHEN 'perdu'             THEN 'lost'
    WHEN 'archived'          THEN 'archived'
    WHEN 'archive'           THEN 'archived'
    WHEN 'archivé'           THEN 'archived'
    WHEN 'anonymized'        THEN 'anonymized'
    ELSE NULL
  END;

  IF NEW.status IS NULL THEN
    RAISE EXCEPTION 'invalid CRM pipeline status'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'archived'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'archived') THEN
    NEW.archived_at := COALESCE(NEW.archived_at, now());
  END IF;

  normalized_phone := crm_private.normalize_e164(NEW.phone);
  IF NEW.status NOT IN ('archived', 'anonymized') THEN
    IF normalized_phone IS NULL THEN
      RAISE EXCEPTION 'active CRM contact phone must use E.164 format'
        USING ERRCODE = '23514';
    END IF;
    NEW.phone := normalized_phone;
  ELSIF normalized_phone IS NOT NULL THEN
    NEW.phone := normalized_phone;
  END IF;

  NEW.email := lower(NULLIF(btrim(NEW.email), ''));

  IF TG_OP = 'INSERT' THEN
    IF NEW.email_consent IS NOT NULL AND NEW.email_consent_at IS NULL THEN
      NEW.email_consent_at := now();
    END IF;
    IF NEW.sms_consent IS NOT NULL AND NEW.sms_consent_at IS NULL THEN
      NEW.sms_consent_at := now();
    END IF;
    IF NEW.call_consent IS NOT NULL AND NEW.call_consent_at IS NULL THEN
      NEW.call_consent_at := now();
    END IF;
  ELSE
    IF NEW.email_consent IS DISTINCT FROM OLD.email_consent THEN
      NEW.email_consent_at := CASE
        WHEN NEW.email_consent IS NULL THEN NULL
        WHEN NEW.email_consent_at IS NOT NULL
         AND NEW.email_consent_at IS DISTINCT FROM OLD.email_consent_at
          THEN NEW.email_consent_at
        ELSE now()
      END;
    END IF;
    IF NEW.sms_consent IS DISTINCT FROM OLD.sms_consent THEN
      NEW.sms_consent_at := CASE
        WHEN NEW.sms_consent IS NULL THEN NULL
        WHEN NEW.sms_consent_at IS NOT NULL
         AND NEW.sms_consent_at IS DISTINCT FROM OLD.sms_consent_at
          THEN NEW.sms_consent_at
        ELSE now()
      END;
    END IF;
    IF NEW.call_consent IS DISTINCT FROM OLD.call_consent THEN
      NEW.call_consent_at := CASE
        WHEN NEW.call_consent IS NULL THEN NULL
        WHEN NEW.call_consent_at IS NOT NULL
         AND NEW.call_consent_at IS DISTINCT FROM OLD.call_consent_at
          THEN NEW.call_consent_at
        ELSE now()
      END;
    END IF;
  END IF;

  -- Migration 010 predates these fields. Keep its anonymization complete.
  IF NEW.status = 'anonymized' THEN
    NEW.next_action_date := NULL;
    NEW.next_action_note := NULL;
    NEW.email_consent := NULL;
    NEW.email_consent_at := NULL;
    NEW.sms_consent := NULL;
    NEW.sms_consent_at := NULL;
    NEW.call_consent := NULL;
    NEW.call_consent_at := NULL;
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL
ON FUNCTION crm_private.prepare_contact_write()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_prepare_contact_write ON public.contacts;
CREATE TRIGGER crm_prepare_contact_write
BEFORE INSERT OR UPDATE ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION crm_private.prepare_contact_write();

CREATE OR REPLACE FUNCTION crm_private.sync_contact_dnc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.call_consent IS FALSE
     AND OLD.phone IS NOT NULL
     AND (
       NEW.call_consent IS DISTINCT FROM FALSE
       OR NEW.phone IS DISTINCT FROM OLD.phone
     ) THEN
    DELETE FROM public.dnc_list AS d
    WHERE d.company_id = OLD.company_id
      AND d.phone = OLD.phone
      AND d.source = 'crm_consent'
      AND d.reason = 'crm_call_consent_revoked'
      AND NOT EXISTS (
        SELECT 1
        FROM public.contacts AS remaining
        WHERE remaining.company_id = OLD.company_id
          AND remaining.phone = OLD.phone
          AND remaining.call_consent IS FALSE
          AND remaining.status <> 'anonymized'
          -- A merged duplicate no longer carries an independent consent for
          -- the same number. A normally archived contact still does.
          AND remaining.merged_into_contact_id IS NULL
      );
  END IF;

  IF NEW.call_consent IS FALSE
     AND NEW.phone IS NOT NULL
     AND NEW.status <> 'anonymized' THEN
    INSERT INTO public.dnc_list (company_id, phone, reason, source)
    VALUES (
      NEW.company_id,
      NEW.phone,
      'crm_call_consent_revoked',
      'crm_consent'
    )
    ON CONFLICT (company_id, phone) DO NOTHING;
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL
ON FUNCTION crm_private.sync_contact_dnc()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_sync_contact_dnc ON public.contacts;
CREATE TRIGGER crm_sync_contact_dnc
AFTER INSERT OR UPDATE OF phone, call_consent, status ON public.contacts
FOR EACH ROW
EXECUTE FUNCTION crm_private.sync_contact_dnc();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass
      AND conname = 'contacts_pipeline_phone_check'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_pipeline_phone_check
      CHECK (
        status IN (
          'new', 'qualified', 'client', 'lost', 'archived', 'anonymized'
        )
        AND (
          status IN ('archived', 'anonymized')
          OR phone ~ '^[+][1-9][0-9]{7,14}$'
        )
        AND (status <> 'archived' OR archived_at IS NOT NULL)
      ) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_contacts_company_pipeline
  ON public.contacts(company_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_company_phone_active
  ON public.contacts(company_id, phone)
  WHERE status NOT IN ('archived', 'anonymized');
CREATE INDEX IF NOT EXISTS idx_contacts_company_email_active
  ON public.contacts(company_id, lower(email))
  WHERE email IS NOT NULL
    AND status NOT IN ('archived', 'anonymized');
CREATE INDEX IF NOT EXISTS idx_contacts_next_action
  ON public.contacts(company_id, next_action_date)
  WHERE next_action_date IS NOT NULL
    AND status NOT IN ('archived', 'anonymized');
CREATE INDEX IF NOT EXISTS idx_contacts_merged_into
  ON public.contacts(merged_into_contact_id)
  WHERE merged_into_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON public.contacts
  USING gin ((lower(full_name)) extensions.gin_trgm_ops)
  WHERE status NOT IN ('archived', 'anonymized');
CREATE INDEX IF NOT EXISTS idx_contacts_company_name_trgm
  ON public.contacts
  USING gin ((lower(company)) extensions.gin_trgm_ops)
  WHERE company IS NOT NULL
    AND status NOT IN ('archived', 'anonymized');

-- ============================================================
-- 3. Tenant-scoped duplicate detection
-- ============================================================

CREATE OR REPLACE FUNCTION public.find_crm_contact_duplicates(
  p_company_id uuid,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_company text DEFAULT NULL,
  p_exclude_contact_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  full_name text,
  phone text,
  email text,
  company text,
  status text,
  similarity_score double precision,
  match_reasons text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH input AS (
    SELECT
      crm_private.normalize_e164(p_phone) AS phone,
      lower(NULLIF(btrim(p_email), '')) AS email,
      lower(NULLIF(btrim(p_full_name), '')) AS full_name,
      lower(NULLIF(btrim(p_company), '')) AS company
  ), candidates AS (
    SELECT
      c.id,
      c.full_name,
      c.phone,
      c.email,
      c.company,
      c.status,
      (i.phone IS NOT NULL AND c.phone = i.phone) AS phone_match,
      (
        i.email IS NOT NULL
        AND lower(c.email) = i.email
      ) AS email_match,
      CASE
        WHEN i.full_name IS NULL THEN 0::real
        ELSE extensions.similarity(lower(c.full_name), i.full_name)
      END AS name_similarity,
      CASE
        WHEN i.company IS NULL OR c.company IS NULL THEN 0::real
        ELSE extensions.similarity(lower(c.company), i.company)
      END AS company_similarity
    FROM public.contacts AS c
    CROSS JOIN input AS i
    WHERE c.company_id = p_company_id
      AND (p_exclude_contact_id IS NULL OR c.id <> p_exclude_contact_id)
      AND c.status NOT IN ('archived', 'anonymized')
  )
  SELECT
    c.id,
    c.full_name,
    c.phone,
    c.email,
    c.company,
    c.status,
    GREATEST(
      CASE WHEN c.phone_match THEN 1.0 ELSE 0.0 END,
      CASE WHEN c.email_match THEN 0.98 ELSE 0.0 END,
      CASE
        WHEN c.name_similarity >= 0.72
         AND c.company_similarity >= 0.55
        THEN (
          (c.name_similarity::double precision * 0.7)
          + (c.company_similarity::double precision * 0.3)
        )
        ELSE 0.0
      END
    ) AS similarity_score,
    array_remove(ARRAY[
      CASE WHEN c.phone_match THEN 'phone' END,
      CASE WHEN c.email_match THEN 'email' END,
      CASE
        WHEN c.name_similarity >= 0.72
         AND c.company_similarity >= 0.55
        THEN 'name_company_fuzzy'
      END
    ]::text[], NULL) AS match_reasons
  FROM candidates AS c
  WHERE c.phone_match
     OR c.email_match
     OR (
       c.name_similarity >= 0.72
       AND c.company_similarity >= 0.55
     )
  ORDER BY similarity_score DESC, c.full_name ASC
  LIMIT 20;
$$;

REVOKE ALL
ON FUNCTION public.find_crm_contact_duplicates(uuid, text, text, text, text, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.find_crm_contact_duplicates(uuid, text, text, text, text, uuid)
TO service_role;

-- ============================================================
-- 4. Atomic manual merge
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_crm_contacts(
  p_company_id uuid,
  p_primary_contact_id uuid,
  p_duplicate_contact_id uuid,
  p_actor_user_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  primary_contact public.contacts%ROWTYPE;
  duplicate_contact public.contacts%ROWTYPE;
  merged_contact jsonb;
  moved_notes integer := 0;
  moved_calls integer := 0;
  moved_outbound_calls integer := 0;
  moved_emails integer := 0;
  moved_email_drafts integer := 0;
  moved_appointments integer := 0;
BEGIN
  IF p_company_id IS NULL
     OR p_primary_contact_id IS NULL
     OR p_duplicate_contact_id IS NULL THEN
    RAISE EXCEPTION 'company_id and both contact ids are required'
      USING ERRCODE = '22004';
  END IF;

  IF p_primary_contact_id = p_duplicate_contact_id THEN
    RAISE EXCEPTION 'a contact cannot be merged into itself'
      USING ERRCODE = '22023';
  END IF;

  -- Deterministic lock order prevents reciprocal merge deadlocks.
  PERFORM c.id
  FROM public.contacts AS c
  WHERE c.id IN (p_primary_contact_id, p_duplicate_contact_id)
  ORDER BY c.id
  FOR UPDATE;

  SELECT c.*
  INTO primary_contact
  FROM public.contacts AS c
  WHERE c.id = p_primary_contact_id
    AND c.company_id = p_company_id;

  SELECT c.*
  INTO duplicate_contact
  FROM public.contacts AS c
  WHERE c.id = p_duplicate_contact_id
    AND c.company_id = p_company_id;

  IF primary_contact.id IS NULL OR duplicate_contact.id IS NULL THEN
    RAISE EXCEPTION 'contacts must exist in the same tenant'
      USING ERRCODE = '42501';
  END IF;

  IF primary_contact.status IN ('archived', 'anonymized')
     OR primary_contact.merged_into_contact_id IS NOT NULL
     OR duplicate_contact.status IN ('archived', 'anonymized')
     OR duplicate_contact.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'terminal or previously merged contacts cannot be merged'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contact_notes AS n
    WHERE n.contact_id = p_duplicate_contact_id
      AND n.company_id IS DISTINCT FROM p_company_id
  ) OR EXISTS (
    SELECT 1 FROM public.calls AS c
    WHERE c.contact_id = p_duplicate_contact_id
      AND c.company_id IS DISTINCT FROM p_company_id
  ) OR EXISTS (
    SELECT 1 FROM public.outbound_calls AS c
    WHERE c.contact_id = p_duplicate_contact_id
      AND c.company_id IS DISTINCT FROM p_company_id
  ) OR EXISTS (
    SELECT 1 FROM public.emails AS e
    WHERE e.contact_id = p_duplicate_contact_id
      AND e.company_id IS DISTINCT FROM p_company_id
  ) OR EXISTS (
    SELECT 1 FROM public.email_drafts AS e
    WHERE e.contact_id = p_duplicate_contact_id
      AND e.company_id IS DISTINCT FROM p_company_id
  ) OR EXISTS (
    SELECT 1 FROM public.appointments AS a
    WHERE a.contact_id = p_duplicate_contact_id
      AND a.company_id IS DISTINCT FROM p_company_id
  ) THEN
    RAISE EXCEPTION 'cross-tenant child relationship detected'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.contact_notes
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_notes = ROW_COUNT;

  UPDATE public.calls
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_calls = ROW_COUNT;

  UPDATE public.outbound_calls
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_outbound_calls = ROW_COUNT;

  UPDATE public.emails
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_emails = ROW_COUNT;

  UPDATE public.email_drafts
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_email_drafts = ROW_COUNT;

  UPDATE public.appointments
  SET contact_id = p_primary_contact_id
  WHERE company_id = p_company_id
    AND contact_id = p_duplicate_contact_id;
  GET DIAGNOSTICS moved_appointments = ROW_COUNT;

  UPDATE public.contacts AS c
  SET
    full_name = COALESCE(NULLIF(btrim(c.full_name), ''), duplicate_contact.full_name),
    first_name = COALESCE(NULLIF(btrim(c.first_name), ''), duplicate_contact.first_name),
    last_name = COALESCE(NULLIF(btrim(c.last_name), ''), duplicate_contact.last_name),
    email = COALESCE(NULLIF(btrim(c.email), ''), duplicate_contact.email),
    phone = COALESCE(NULLIF(btrim(c.phone), ''), duplicate_contact.phone),
    company = COALESCE(NULLIF(btrim(c.company), ''), duplicate_contact.company),
    source = COALESCE(NULLIF(btrim(c.source), ''), duplicate_contact.source),
    main_need = COALESCE(NULLIF(btrim(c.main_need), ''), duplicate_contact.main_need),
    budget = COALESCE(NULLIF(btrim(c.budget), ''), duplicate_contact.budget),
    urgency = COALESCE(NULLIF(btrim(c.urgency), ''), duplicate_contact.urgency),
    notes = COALESCE(NULLIF(btrim(c.notes), ''), duplicate_contact.notes),
    next_action = COALESCE(NULLIF(btrim(c.next_action), ''), duplicate_contact.next_action),
    next_action_date = COALESCE(c.next_action_date, duplicate_contact.next_action_date),
    next_action_note = COALESCE(
      NULLIF(btrim(c.next_action_note), ''),
      duplicate_contact.next_action_note
    ),
    tags = ARRAY(
      SELECT DISTINCT tag
      FROM unnest(
        COALESCE(c.tags, ARRAY[]::text[])
        || COALESCE(duplicate_contact.tags, ARRAY[]::text[])
      ) AS tag
      WHERE NULLIF(btrim(tag), '') IS NOT NULL
      ORDER BY tag
    ),
    email_consent = CASE
      WHEN c.email_consent IS FALSE OR duplicate_contact.email_consent IS FALSE THEN FALSE
      WHEN c.email_consent IS TRUE AND duplicate_contact.email_consent IS TRUE THEN TRUE
      ELSE NULL
    END,
    email_consent_at = CASE
      WHEN c.email_consent IS FALSE OR duplicate_contact.email_consent IS FALSE
        THEN GREATEST(
          CASE WHEN c.email_consent IS FALSE THEN c.email_consent_at END,
          CASE WHEN duplicate_contact.email_consent IS FALSE THEN duplicate_contact.email_consent_at END
        )
      WHEN c.email_consent IS TRUE AND duplicate_contact.email_consent IS TRUE
        THEN GREATEST(c.email_consent_at, duplicate_contact.email_consent_at)
      ELSE NULL
    END,
    sms_consent = CASE
      WHEN c.sms_consent IS FALSE OR duplicate_contact.sms_consent IS FALSE THEN FALSE
      WHEN c.sms_consent IS TRUE AND duplicate_contact.sms_consent IS TRUE THEN TRUE
      ELSE NULL
    END,
    sms_consent_at = CASE
      WHEN c.sms_consent IS FALSE OR duplicate_contact.sms_consent IS FALSE
        THEN GREATEST(
          CASE WHEN c.sms_consent IS FALSE THEN c.sms_consent_at END,
          CASE WHEN duplicate_contact.sms_consent IS FALSE THEN duplicate_contact.sms_consent_at END
        )
      WHEN c.sms_consent IS TRUE AND duplicate_contact.sms_consent IS TRUE
        THEN GREATEST(c.sms_consent_at, duplicate_contact.sms_consent_at)
      ELSE NULL
    END,
    call_consent = CASE
      WHEN c.call_consent IS FALSE OR duplicate_contact.call_consent IS FALSE THEN FALSE
      WHEN c.call_consent IS TRUE AND duplicate_contact.call_consent IS TRUE THEN TRUE
      ELSE NULL
    END,
    call_consent_at = CASE
      WHEN c.call_consent IS FALSE OR duplicate_contact.call_consent IS FALSE
        THEN GREATEST(
          CASE WHEN c.call_consent IS FALSE THEN c.call_consent_at END,
          CASE WHEN duplicate_contact.call_consent IS FALSE THEN duplicate_contact.call_consent_at END
        )
      WHEN c.call_consent IS TRUE AND duplicate_contact.call_consent IS TRUE
        THEN GREATEST(c.call_consent_at, duplicate_contact.call_consent_at)
      ELSE NULL
    END,
    last_interaction_at = GREATEST(c.last_interaction_at, duplicate_contact.last_interaction_at),
    updated_at = now()
  WHERE c.id = p_primary_contact_id
    AND c.company_id = p_company_id;

  UPDATE public.contacts AS c
  SET
    status = 'archived',
    archived_at = now(),
    archived_by = p_actor_user_id,
    merged_into_contact_id = p_primary_contact_id,
    next_action = NULL,
    next_action_date = NULL,
    next_action_note = NULL,
    updated_at = now()
  WHERE c.id = p_duplicate_contact_id
    AND c.company_id = p_company_id;

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
    p_company_id,
    p_actor_user_id,
    p_actor_role,
    'crm.contact_merged',
    'contact',
    p_primary_contact_id::text,
    jsonb_build_object(
      'primary_contact_id', p_primary_contact_id,
      'archived_contact_id', p_duplicate_contact_id,
      'moved_contact_notes', moved_notes,
      'moved_calls', moved_calls,
      'moved_outbound_calls', moved_outbound_calls,
      'moved_emails', moved_emails,
      'moved_email_drafts', moved_email_drafts,
      'moved_appointments', moved_appointments
    )
  );

  SELECT to_jsonb(c.*)
  INTO merged_contact
  FROM public.contacts AS c
  WHERE c.id = p_primary_contact_id
    AND c.company_id = p_company_id;

  RETURN jsonb_build_object(
    'success', true,
    'contact', merged_contact,
    'archived_contact_id', p_duplicate_contact_id,
    'moved', jsonb_build_object(
      'contact_notes', moved_notes,
      'calls', moved_calls,
      'outbound_calls', moved_outbound_calls,
      'emails', moved_emails,
      'email_drafts', moved_email_drafts,
      'appointments', moved_appointments
    )
  );
END
$$;

REVOKE ALL
ON FUNCTION public.merge_crm_contacts(uuid, uuid, uuid, uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.merge_crm_contacts(uuid, uuid, uuid, uuid, text)
TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
