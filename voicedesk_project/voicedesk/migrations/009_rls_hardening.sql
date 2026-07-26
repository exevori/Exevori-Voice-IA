-- Migration 009 — RLS hardening
-- VoiceDesk V1: backend-only Data API access + tenant defense in depth.
-- Validated against Supabase project yptsvqhcnksjxufziech.

BEGIN;

-- ============================================================
-- 1. Verify that the expected production schema is present
-- ============================================================

DO $$
DECLARE
  missing_tables text[];
BEGIN
  SELECT array_agg(table_name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'activity_logs',
    'agent_profiles',
    'ai_usage_logs',
    'appointments',
    'assistant_configs',
    'call_events',
    'call_recordings',
    'calls',
    'companies',
    'contact_notes',
    'contacts',
    'credit_grants',
    'dnc_list',
    'email_accounts',
    'email_drafts',
    'emails',
    'imap_configs',
    'integration_configs',
    'invitations',
    'invoices',
    'knowledge_base',
    'knowledge_chunks',
    'knowledge_sources',
    'learning_suggestions',
    'missions',
    'notification_preferences',
    'notifications',
    'onboarding_progress',
    'outbound_calls',
    'outbound_campaigns',
    'outbound_contacts',
    'payment_methods',
    'phone_numbers',
    'profiles',
    'services',
    'stripe_webhook_events',
    'subscriptions',
    'ticket_attachments',
    'ticket_messages',
    'tickets',
    'twilio_configs',
    'usage_records',
    'voice_assignments'
  ]::text[]) AS required(table_name)
  WHERE to_regclass('public.' || quote_ident(table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 009 aborted — missing tables: %',
      array_to_string(missing_tables, ', ');
  END IF;
END
$$;

-- ============================================================
-- 2. Reliable tenant helpers in a non-exposed schema
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.current_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.company_id
  FROM public.profiles AS p
  WHERE p.user_id = (SELECT auth.uid())
    AND p.status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION private.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT p.role = 'super_admin'
      FROM public.profiles AS p
      WHERE p.user_id = (SELECT auth.uid())
        AND p.status = 'active'
      LIMIT 1
    ),
    false
  )
$$;

REVOKE ALL ON FUNCTION private.current_company_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_super_admin() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION private.current_company_id()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_super_admin()
  TO authenticated, service_role;

-- ============================================================
-- 3. Indexes used by tenant policies
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_contact_notes_company_id
  ON public.contact_notes(company_id);

CREATE INDEX IF NOT EXISTS idx_invitations_company_id
  ON public.invitations(company_id);

CREATE INDEX IF NOT EXISTS idx_missions_company_id
  ON public.missions(company_id);

CREATE INDEX IF NOT EXISTS idx_notifications_company_id
  ON public.notifications(company_id);

CREATE INDEX IF NOT EXISTS idx_outbound_contacts_company_id
  ON public.outbound_contacts(company_id);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_company_id
  ON public.ticket_messages(company_id);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_id
  ON public.ticket_attachments(ticket_id);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_message_id
  ON public.ticket_attachments(message_id);

-- ============================================================
-- 4. Remove historical policies on covered tables
-- ============================================================

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'activity_logs',
        'agent_profiles',
        'ai_usage_logs',
        'appointments',
        'assistant_configs',
        'call_events',
        'call_recordings',
        'calls',
        'companies',
        'contact_notes',
        'contacts',
        'credit_grants',
        'dnc_list',
        'email_accounts',
        'email_drafts',
        'emails',
        'imap_configs',
        'integration_configs',
        'invitations',
        'invoices',
        'knowledge_base',
        'knowledge_chunks',
        'knowledge_sources',
        'learning_suggestions',
        'missions',
        'notification_preferences',
        'notifications',
        'onboarding_progress',
        'outbound_calls',
        'outbound_campaigns',
        'outbound_contacts',
        'payment_methods',
        'phone_numbers',
        'profiles',
        'services',
        'stripe_webhook_events',
        'subscriptions',
        'ticket_attachments',
        'ticket_messages',
        'tickets',
        'twilio_configs',
        'usage_records',
        'voice_assignments'
      ]::text[])
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  END LOOP;
END
$$;

-- ============================================================
-- 5. Tables carrying company_id directly
-- ============================================================

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'activity_logs',
    'agent_profiles',
    'ai_usage_logs',
    'appointments',
    'assistant_configs',
    'call_events',
    'call_recordings',
    'calls',
    'contact_notes',
    'contacts',
    'credit_grants',
    'dnc_list',
    'email_accounts',
    'email_drafts',
    'emails',
    'imap_configs',
    'integration_configs',
    'invitations',
    'invoices',
    'knowledge_base',
    'knowledge_chunks',
    'knowledge_sources',
    'learning_suggestions',
    'missions',
    'onboarding_progress',
    'outbound_calls',
    'outbound_campaigns',
    'outbound_contacts',
    'payment_methods',
    'phone_numbers',
    'services',
    'subscriptions',
    'tickets',
    'twilio_configs',
    'usage_records',
    'voice_assignments'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      tenant_table
    );

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

    -- service_role already bypasses RLS; this explicit policy documents
    -- the intended privileged backend access required by the V1 brief.
    EXECUTE format(
      'CREATE POLICY service_role_bypass
       ON public.%I
       FOR ALL
       TO service_role
       USING (true)
       WITH CHECK (true)',
      tenant_table
    );

    -- V1 architecture: business data is accessed through the backend.
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I
       FROM PUBLIC, anon, authenticated',
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
-- 6. Tenant root: companies
-- ============================================================

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.companies
FOR ALL
TO authenticated
USING (
  id = (SELECT private.current_company_id())
  OR (SELECT private.is_super_admin())
)
WITH CHECK (
  id = (SELECT private.current_company_id())
  OR (SELECT private.is_super_admin())
);

CREATE POLICY service_role_bypass
ON public.companies
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.companies
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.companies
TO service_role;

-- ============================================================
-- 7. Profiles: current user or super admin
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.profiles
FOR ALL
TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT private.is_super_admin())
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  OR (SELECT private.is_super_admin())
);

CREATE POLICY service_role_bypass
ON public.profiles
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.profiles
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.profiles
TO service_role;

-- ============================================================
-- 8. Notifications: coherent user and tenant ownership
-- ============================================================

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.notifications
FOR ALL
TO authenticated
USING (
  (
    user_id = (SELECT auth.uid())
    AND company_id = (SELECT private.current_company_id())
  )
  OR (SELECT private.is_super_admin())
)
WITH CHECK (
  (
    user_id = (SELECT auth.uid())
    AND company_id = (SELECT private.current_company_id())
  )
  OR (SELECT private.is_super_admin())
);

CREATE POLICY service_role_bypass
ON public.notifications
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.notifications
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.notifications
TO service_role;

-- ============================================================
-- 9. Notification preferences: user ownership
-- ============================================================

ALTER TABLE public.notification_preferences
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.notification_preferences
FOR ALL
TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT private.is_super_admin())
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  OR (SELECT private.is_super_admin())
);

CREATE POLICY service_role_bypass
ON public.notification_preferences
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES
ON TABLE public.notification_preferences
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.notification_preferences
TO service_role;

-- ============================================================
-- 10. Ticket messages: tenant and internal-note visibility
-- ============================================================

ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.ticket_messages
FOR ALL
TO authenticated
USING (
  (
    company_id = (SELECT private.current_company_id())
    AND is_internal IS NOT TRUE
  )
  OR (SELECT private.is_super_admin())
)
WITH CHECK (
  (
    company_id = (SELECT private.current_company_id())
    AND is_internal IS NOT TRUE
  )
  OR (SELECT private.is_super_admin())
);

CREATE POLICY service_role_bypass
ON public.ticket_messages
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.ticket_messages
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.ticket_messages
TO service_role;

-- ============================================================
-- 11. Ticket attachments: derive tenant from parent ticket
-- ============================================================

ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
ON public.ticket_attachments
FOR ALL
TO authenticated
USING (
  (SELECT private.is_super_admin())
  OR EXISTS (
    SELECT 1
    FROM public.tickets AS t
    WHERE t.id = ticket_attachments.ticket_id
      AND t.company_id = (SELECT private.current_company_id())
  )
)
WITH CHECK (
  (SELECT private.is_super_admin())
  OR EXISTS (
    SELECT 1
    FROM public.tickets AS t
    WHERE t.id = ticket_attachments.ticket_id
      AND t.company_id = (SELECT private.current_company_id())
  )
);

CREATE POLICY service_role_bypass
ON public.ticket_attachments
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE public.ticket_attachments
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.ticket_attachments
TO service_role;

-- ============================================================
-- 12. Stripe events: service role only
-- ============================================================

ALTER TABLE public.stripe_webhook_events
  ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_bypass
ON public.stripe_webhook_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL PRIVILEGES
ON TABLE public.stripe_webhook_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.stripe_webhook_events
TO service_role;

-- ============================================================
-- 13. RAG RPC: no direct anon/authenticated execution
-- ============================================================

REVOKE ALL
ON FUNCTION public.match_kb_chunks(
  uuid,
  vector,
  integer,
  double precision
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.match_kb_chunks(
  uuid,
  vector,
  integer,
  double precision
)
TO service_role;

-- ============================================================
-- 14. KB Storage: mandatory company_id/ prefix
-- ============================================================

DROP POLICY IF EXISTS kb_uploads_company_read
  ON storage.objects;
DROP POLICY IF EXISTS kb_uploads_company_insert
  ON storage.objects;
DROP POLICY IF EXISTS kb_uploads_company_update
  ON storage.objects;
DROP POLICY IF EXISTS kb_uploads_company_delete
  ON storage.objects;

CREATE POLICY kb_uploads_company_read
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'kb-uploads'
  AND (
    (SELECT private.is_super_admin())
    OR (storage.foldername(name))[1]
       = (SELECT private.current_company_id())::text
  )
);

CREATE POLICY kb_uploads_company_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'kb-uploads'
  AND (
    (SELECT private.is_super_admin())
    OR (storage.foldername(name))[1]
       = (SELECT private.current_company_id())::text
  )
);

CREATE POLICY kb_uploads_company_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'kb-uploads'
  AND (
    (SELECT private.is_super_admin())
    OR (storage.foldername(name))[1]
       = (SELECT private.current_company_id())::text
  )
)
WITH CHECK (
  bucket_id = 'kb-uploads'
  AND (
    (SELECT private.is_super_admin())
    OR (storage.foldername(name))[1]
       = (SELECT private.current_company_id())::text
  )
);

CREATE POLICY kb_uploads_company_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'kb-uploads'
  AND (
    (SELECT private.is_super_admin())
    OR (storage.foldername(name))[1]
       = (SELECT private.current_company_id())::text
  )
);

-- ============================================================
-- 15. Safe defaults for future public-schema migrations
-- ============================================================

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
REVOKE ALL ON TABLES
FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
REVOKE ALL ON SEQUENCES
FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS
FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
GRANT USAGE, SELECT, UPDATE
ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES
FOR ROLE postgres
IN SCHEMA public
GRANT EXECUTE
ON FUNCTIONS TO service_role;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
REVOKE ALL ON TABLES
FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
REVOKE ALL ON SEQUENCES
FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS
FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
GRANT USAGE, SELECT, UPDATE
ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES
FOR ROLE supabase_admin
IN SCHEMA public
GRANT EXECUTE
ON FUNCTIONS TO service_role;

COMMIT;
