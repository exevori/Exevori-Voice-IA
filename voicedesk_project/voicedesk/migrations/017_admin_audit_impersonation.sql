-- Task 17. PREPARED ONLY: review and apply after migration 010.
-- No data/schema changes to auth.users, profiles, companies or subscriptions.
BEGIN;

CREATE TABLE public.admin_impersonation_sessions (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('user_exit','sign_out','replaced','expired')),
  CHECK (expires_at > started_at),
  CHECK (ended_at IS NULL OR ended_at BETWEEN started_at AND expires_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX uq_admin_impersonation_open_actor
  ON public.admin_impersonation_sessions(actor_user_id) WHERE ended_at IS NULL;
CREATE INDEX idx_admin_impersonation_history
  ON public.admin_impersonation_sessions(started_at DESC, id DESC);
CREATE INDEX idx_admin_impersonation_company_history
  ON public.admin_impersonation_sessions(company_id, started_at DESC, id DESC);

ALTER TABLE public.admin_impersonation_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_impersonation_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_impersonation_sessions TO service_role;
CREATE POLICY admin_impersonation_backend_read ON public.admin_impersonation_sessions
  FOR SELECT TO service_role USING (true);

ALTER TABLE public.audit_log ADD COLUMN impersonation_session_id uuid;
-- Deliberately no cascading FK: the append-only ledger survives session retention.
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_orphan_retention_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_orphan_retention_check CHECK (
  company_id IS NOT NULL
  OR COALESCE(actor_role = 'system' AND entity_type = 'retention_batch', false)
  OR COALESCE(actor_role = 'super_admin' AND entity_type = 'admin_request', false)
);
CREATE INDEX idx_audit_page ON public.audit_log(created_at DESC, id DESC);
CREATE INDEX idx_audit_company_page ON public.audit_log(company_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_action_page ON public.audit_log(action, created_at DESC, id DESC);
CREATE INDEX idx_audit_session_page ON public.audit_log(impersonation_session_id, created_at DESC, id DESC)
  WHERE impersonation_session_id IS NOT NULL;
-- Preserve the append-only ACL from 010, including after default grants.
REVOKE ALL ON TABLE public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.audit_log TO service_role;

CREATE FUNCTION public.end_admin_impersonation(
  p_session_id uuid, p_actor_user_id uuid, p_reason text, p_request_id text
) RETURNS public.admin_impersonation_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.admin_impersonation_sessions;
BEGIN
  IF p_actor_user_id IS NULL OR p_session_id IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('user_exit','sign_out','replaced','expired') THEN
    RAISE EXCEPTION 'invalid_impersonation_request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_user_id::text, 17017));
  SELECT * INTO s FROM public.admin_impersonation_sessions
    WHERE id = p_session_id AND actor_user_id = p_actor_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'impersonation_forbidden'; END IF;
  IF s.ended_at IS NOT NULL THEN RETURN s; END IF;
  UPDATE public.admin_impersonation_sessions
    SET ended_at = LEAST(now(), expires_at),
        end_reason = CASE WHEN expires_at <= now() THEN 'expired' ELSE p_reason END
    WHERE id = s.id RETURNING * INTO s;
  INSERT INTO public.audit_log(company_id, actor_user_id, actor_role, action,
    entity_type, entity_id, request_id, impersonation_session_id, details)
  VALUES(s.company_id, s.actor_user_id, 'super_admin', 'admin_impersonation_ended',
    'impersonation_session', s.id::text, p_request_id, s.id,
    jsonb_build_object('end_reason', s.end_reason, 'duration_seconds',
      floor(extract(epoch FROM s.ended_at - s.started_at))));
  RETURN s;
END;
$$;

CREATE FUNCTION public.start_admin_impersonation(
  p_session_id uuid, p_company_id uuid, p_actor_user_id uuid,
  p_reason text, p_request_id text
) RETURNS public.admin_impersonation_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.admin_impersonation_sessions; old_id uuid;
BEGIN
  IF p_session_id IS NULL OR p_company_id IS NULL OR p_actor_user_id IS NULL
     OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'invalid_impersonation_request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_user_id::text, 17017));
  SELECT * INTO s FROM public.admin_impersonation_sessions WHERE id = p_session_id;
  IF FOUND THEN
    IF s.actor_user_id <> p_actor_user_id OR s.company_id <> p_company_id THEN
      RAISE EXCEPTION 'impersonation_forbidden';
    END IF;
    RETURN s; -- Retry of the same request never creates or extends a session.
  END IF;
  FOR old_id IN SELECT id FROM public.admin_impersonation_sessions
    WHERE actor_user_id = p_actor_user_id AND ended_at IS NULL
  LOOP
    PERFORM public.end_admin_impersonation(old_id, p_actor_user_id, 'replaced', p_request_id);
  END LOOP;
  INSERT INTO public.admin_impersonation_sessions(id, actor_user_id, company_id, reason)
    VALUES(p_session_id, p_actor_user_id, p_company_id, trim(p_reason)) RETURNING * INTO s;
  INSERT INTO public.audit_log(company_id, actor_user_id, actor_role, action,
    entity_type, entity_id, request_id, impersonation_session_id, details)
  VALUES(s.company_id, s.actor_user_id, 'super_admin', 'admin_impersonation_started',
    'impersonation_session', s.id::text, p_request_id, s.id,
    jsonb_build_object('reason', s.reason, 'expires_at', s.expires_at));
  RETURN s;
END;
$$;

REVOKE ALL ON FUNCTION public.start_admin_impersonation(uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.end_admin_impersonation(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_admin_impersonation(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_admin_impersonation(uuid,uuid,text,text) TO service_role;

-- Retention matches the default audit ledger (730 days); active sessions are
-- logically expired after 30 minutes even when the browser disappears.
CREATE FUNCTION public.purge_expired_admin_impersonations(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
  DELETE FROM public.admin_impersonation_sessions WHERE id IN (
    SELECT id FROM public.admin_impersonation_sessions
    WHERE expires_at < now() - interval '730 days'
    ORDER BY expires_at LIMIT LEAST(GREATEST(COALESCE(p_limit,500),1),1000)
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_admin_impersonations(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_admin_impersonations(integer) TO service_role;
COMMIT;
