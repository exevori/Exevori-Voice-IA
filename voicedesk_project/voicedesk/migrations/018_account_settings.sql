-- Task 18. PREPARED ONLY: review and apply after migrations 009..017.
-- No backfill of owners, no modification of auth.users/companies/subscriptions.
BEGIN;

CREATE TABLE IF NOT EXISTS public.company_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  owner_user_id uuid,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  transcript_retention_days integer NOT NULL DEFAULT 90 CHECK (transcript_retention_days BETWEEN 1 AND 3650),
  recordings_visible boolean NOT NULL DEFAULT true,
  transactional_name text NOT NULL DEFAULT '' CHECK (length(transactional_name) <= 100),
  transactional_reply_to text NOT NULL DEFAULT '' CHECK (length(transactional_reply_to) <= 254),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.account_preferences (
  user_id uuid PRIMARY KEY,
  avatar_data text CHECK (avatar_data IS NULL OR
    (length(avatar_data) <= 180000 AND avatar_data ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_settings, public.account_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_settings, public.account_preferences TO service_role;
DROP POLICY IF EXISTS service_role_bypass ON public.company_settings;
CREATE POLICY service_role_bypass ON public.company_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_bypass ON public.account_preferences;
CREATE POLICY service_role_bypass ON public.account_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.assistant_configs ADD COLUMN IF NOT EXISTS rag_min_similarity double precision
  NOT NULL DEFAULT 0.25 CHECK (rag_min_similarity BETWEEN 0 AND 1);

-- Read-only, narrow bridge to Supabase Auth. Backend verifies the JWT before
-- supplying p_user_id/p_session_id. No direct Auth schema privileges are granted.
CREATE OR REPLACE FUNCTION public.account_session_active(p_user_id uuid, p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = p_user_id
    AND ((to_jsonb(s)->>'not_after') IS NULL OR (to_jsonb(s)->>'not_after')::timestamptz > now()));
$$;
CREATE OR REPLACE FUNCTION public.account_sessions(p_user_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.account_session_active(p_user_id, p_session_id) THEN
    RAISE EXCEPTION 'session_revoked' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(row_data ORDER BY row_data->>'created_at' DESC), '[]'::jsonb)
    FROM (SELECT jsonb_build_object('id', s.id, 'current', s.id = p_session_id,
      'created_at', to_jsonb(s)->>'created_at', 'updated_at', to_jsonb(s)->>'updated_at',
      'user_agent', left(to_jsonb(s)->>'user_agent', 300)) AS row_data
      FROM auth.sessions s WHERE s.user_id = p_user_id
      AND ((to_jsonb(s)->>'not_after') IS NULL OR (to_jsonb(s)->>'not_after')::timestamptz > now())
      ORDER BY to_jsonb(s)->>'created_at' DESC, s.id LIMIT 100) q);
END;
$$;

-- Serialize all membership/ownership transitions for a company. The canonical
-- profile roles remain company_admin/company_user; owner is separate authority.
CREATE OR REPLACE FUNCTION public.manage_company_member(
  p_company_id uuid, p_actor_id uuid, p_target_id uuid,
  p_role text DEFAULT NULL, p_status text DEFAULT NULL, p_transfer_owner boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE actor public.profiles; member public.profiles; owner_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('team:' || p_company_id::text, 0));
  SELECT * INTO actor FROM public.profiles WHERE user_id = p_actor_id AND status = 'active';
  IF actor.user_id IS NULL OR actor.role NOT IN ('super_admin','company_admin')
    OR (actor.role <> 'super_admin' AND actor.company_id IS DISTINCT FROM p_company_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO member FROM public.profiles WHERE user_id = p_target_id AND company_id = p_company_id FOR UPDATE;
  IF member.user_id IS NULL OR member.role = 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_member' USING ERRCODE = '42501';
  END IF;
  SELECT owner_user_id INTO owner_id FROM public.company_settings WHERE company_id = p_company_id;
  IF p_transfer_owner THEN
    IF actor.role <> 'super_admin' AND owner_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
    END IF;
    IF member.status <> 'active' OR member.role <> 'company_admin' THEN
      RAISE EXCEPTION 'active_admin_required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.company_settings(company_id, owner_user_id) VALUES(p_company_id, p_target_id)
    ON CONFLICT(company_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, updated_at = now();
  ELSE
    IF (p_role IS NOT NULL AND p_role NOT IN ('company_admin','company_user'))
      OR (p_status IS NOT NULL AND p_status NOT IN ('active','inactive'))
      OR (p_role IS NULL AND p_status IS NULL) THEN
      RAISE EXCEPTION 'invalid_member_change' USING ERRCODE = '22023';
    END IF;
    IF p_target_id = p_actor_id OR p_target_id = owner_id THEN
      RAISE EXCEPTION 'protected_member' USING ERRCODE = '42501';
    END IF;
    IF member.role = 'company_admin' AND member.status = 'active'
      AND (coalesce(p_role, member.role) <> 'company_admin' OR coalesce(p_status, member.status) <> 'active')
      AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE company_id = p_company_id
        AND user_id <> p_target_id AND role = 'company_admin' AND status = 'active') THEN
      RAISE EXCEPTION 'last_admin' USING ERRCODE = '22023';
    END IF;
    UPDATE public.profiles SET role = coalesce(p_role, role), status = coalesce(p_status, status)
    WHERE user_id = p_target_id AND company_id = p_company_id;
  END IF;
  INSERT INTO public.audit_log(company_id, actor_user_id, actor_role, action, entity_type, entity_id, details)
  VALUES(p_company_id, p_actor_id, actor.role,
    CASE WHEN p_transfer_owner THEN 'team.owner_transferred' ELSE 'team.member_updated' END,
    'profile', p_target_id::text, jsonb_build_object('role', p_role, 'status', p_status));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- Atomically consume the invitation and create a profile. No company activation.
CREATE OR REPLACE FUNCTION public.accept_team_invitation(p_token text, p_user_id uuid, p_full_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE invitation public.invitations;
BEGIN
  SELECT * INTO invitation FROM public.invitations WHERE token = p_token FOR UPDATE;
  IF invitation.id IS NULL OR invitation.status <> 'pending' OR invitation.expires_at <= now()
    OR invitation.role NOT IN ('company_admin','company_user') THEN
    RAISE EXCEPTION 'invalid_invitation' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.profiles(user_id, company_id, full_name, email, role, status)
  VALUES(p_user_id, invitation.company_id, left(p_full_name, 120), invitation.email, invitation.role, 'active');
  UPDATE public.invitations SET status = 'accepted', accepted_at = now() WHERE id = invitation.id;
  RETURN jsonb_build_object('success', true, 'company_id', invitation.company_id, 'user_id', p_user_id);
END;
$$;

-- Retention settings apply to newly inserted rows. Existing clocks are preserved;
-- reducing them retroactively would be a separate destructive operation.
CREATE OR REPLACE FUNCTION public.apply_company_retention()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE settings public.company_settings;
BEGIN
  SELECT * INTO settings FROM public.company_settings WHERE company_id = NEW.company_id;
  IF FOUND THEN
    NEW.retention_days := settings.retention_days;
    NEW.transcript_retention_days := settings.transcript_retention_days;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS company_retention_defaults ON public.calls;
CREATE TRIGGER company_retention_defaults BEFORE INSERT ON public.calls FOR EACH ROW EXECUTE FUNCTION public.apply_company_retention();
DROP TRIGGER IF EXISTS company_retention_defaults ON public.outbound_calls;
CREATE TRIGGER company_retention_defaults BEFORE INSERT ON public.outbound_calls FOR EACH ROW EXECUTE FUNCTION public.apply_company_retention();
DROP TRIGGER IF EXISTS company_retention_defaults ON public.call_recordings;
CREATE TRIGGER company_retention_defaults BEFORE INSERT ON public.call_recordings FOR EACH ROW EXECUTE FUNCTION public.apply_company_retention();

REVOKE ALL ON FUNCTION public.account_session_active(uuid, uuid), public.account_sessions(uuid, uuid),
  public.manage_company_member(uuid, uuid, uuid, text, text, boolean),
  public.accept_team_invitation(text, uuid, text), public.apply_company_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_session_active(uuid, uuid), public.account_sessions(uuid, uuid),
  public.manage_company_member(uuid, uuid, uuid, text, text, boolean),
  public.accept_team_invitation(text, uuid, text), public.apply_company_retention() TO service_role;
-- A short lease serializes settings saves and their provider synchronization.
-- A failed/unknown provider outcome is visible and can be retried with the same values.
ALTER TABLE public.assistant_configs
  ADD COLUMN IF NOT EXISTS settings_sync_status text NOT NULL DEFAULT 'not_synced'
    CHECK (settings_sync_status IN ('not_synced','in_progress','synced','failed','not_provisioned')),
  ADD COLUMN IF NOT EXISTS settings_sync_token uuid,
  ADD COLUMN IF NOT EXISTS settings_sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS settings_sync_error text;
CREATE OR REPLACE FUNCTION public.save_assistant_settings(p_company_id uuid, p_token uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result public.assistant_configs;
BEGIN
  IF p_token IS NULL OR p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'invalid_settings' USING ERRCODE = '22023';
  END IF;
  IF p_patch = '{}'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) AS keys(key) WHERE key NOT IN (
      'assistant_name','assistant_gender','voice_id','tone','greeting_inbound_fr','greeting_inbound_en',
      'greeting_outbound_fr','voicemail_message_fr','signature_email_fr','system_prompt_voice_fr','rag_min_similarity'
    )) THEN RAISE EXCEPTION 'invalid_settings' USING ERRCODE = '22023'; END IF;
  UPDATE public.assistant_configs SET
    assistant_name = CASE WHEN p_patch ? 'assistant_name' THEN p_patch->>'assistant_name' ELSE assistant_name END,
    assistant_gender = CASE WHEN p_patch ? 'assistant_gender' THEN p_patch->>'assistant_gender' ELSE assistant_gender END,
    voice_id = CASE WHEN p_patch ? 'voice_id' THEN p_patch->>'voice_id' ELSE voice_id END,
    tone = CASE WHEN p_patch ? 'tone' THEN p_patch->>'tone' ELSE tone END,
    greeting_inbound_fr = CASE WHEN p_patch ? 'greeting_inbound_fr' THEN p_patch->>'greeting_inbound_fr' ELSE greeting_inbound_fr END,
    greeting_inbound_en = CASE WHEN p_patch ? 'greeting_inbound_en' THEN p_patch->>'greeting_inbound_en' ELSE greeting_inbound_en END,
    greeting_outbound_fr = CASE WHEN p_patch ? 'greeting_outbound_fr' THEN p_patch->>'greeting_outbound_fr' ELSE greeting_outbound_fr END,
    voicemail_message_fr = CASE WHEN p_patch ? 'voicemail_message_fr' THEN p_patch->>'voicemail_message_fr' ELSE voicemail_message_fr END,
    signature_email_fr = CASE WHEN p_patch ? 'signature_email_fr' THEN p_patch->>'signature_email_fr' ELSE signature_email_fr END,
    system_prompt_voice_fr = CASE WHEN p_patch ? 'system_prompt_voice_fr' THEN p_patch->>'system_prompt_voice_fr' ELSE system_prompt_voice_fr END,
    rag_min_similarity = CASE WHEN p_patch ? 'rag_min_similarity' THEN (p_patch->>'rag_min_similarity')::double precision ELSE rag_min_similarity END,
    settings_sync_status = CASE WHEN elevenlabs_agent_id IS NULL THEN 'not_provisioned' ELSE 'in_progress' END,
    settings_sync_token = p_token, settings_sync_started_at = now(), settings_sync_error = NULL, updated_at = now()
  WHERE company_id = p_company_id
    AND (settings_sync_status <> 'in_progress' OR settings_sync_started_at < now() - interval '2 minutes')
  RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'settings_busy_or_missing' USING ERRCODE = '22023'; END IF;
  RETURN to_jsonb(result);
END;
$$;
REVOKE ALL ON FUNCTION public.save_assistant_settings(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_assistant_settings(uuid, uuid, jsonb) TO service_role;
COMMIT;
