-- Task 19. Apply after 018, with operator approval. No legacy completion is
-- converted into proof of a received call. Backend-only RPCs; no Auth writes.
BEGIN;

ALTER TABLE public.onboarding_progress
  ADD COLUMN IF NOT EXISTS setup_data jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS activation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_phone text,
  ADD COLUMN IF NOT EXISTS test_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL;

-- The authenticated backend supplies only validated, whitelisted values.
-- Lock the progress row before changing config, so retries cannot skip steps
-- or rewrite a configuration already handed to the provisioning service.
CREATE OR REPLACE FUNCTION public.save_onboarding_step(
  p_company_id uuid, p_step integer, p_data jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  p public.onboarding_progress%ROWTYPE;
  v public.voice_library%ROWTYPE;
  s record;
  v_company_name text;
BEGIN
  IF p_step IS NULL OR p_step NOT BETWEEN 1 AND 3 OR p_data IS NULL
     OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_step' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.onboarding_progress(company_id) VALUES(p_company_id) ON CONFLICT DO NOTHING;
  SELECT * INTO p FROM public.onboarding_progress WHERE company_id=p_company_id FOR UPDATE;
  IF p.activation_requested_at IS NOT NULL OR p.provisioning_status IN ('in_progress','done')
     OR EXISTS (SELECT 1 FROM public.assistant_configs WHERE company_id=p_company_id AND elevenlabs_agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'setup_locked' USING ERRCODE = '22023';
  END IF;
  IF p_step = ANY(COALESCE(p.completed_steps,'{}')) THEN
    IF p.setup_data->p_step::text = p_data THEN RETURN to_jsonb(p); END IF;
    RAISE EXCEPTION 'step_already_saved' USING ERRCODE = '22023';
  END IF;
  IF p_step > 1 AND NOT ((p_step-1)=ANY(COALESCE(p.completed_steps,'{}'))) THEN
    RAISE EXCEPTION 'previous_step_required' USING ERRCODE = '22023';
  END IF;
  IF p_step = 1 THEN
    IF length(btrim(COALESCE(p_data->>'assistant_name',''))) NOT BETWEEN 1 AND 80
       OR COALESCE(p_data->>'tone','') NOT IN ('professional','warm','casual','formal') THEN
      RAISE EXCEPTION 'invalid_assistant' USING ERRCODE = '22023';
    END IF;
    SELECT name INTO STRICT v_company_name FROM public.companies WHERE id=p_company_id;
    UPDATE public.companies SET assistant_name=p_data->>'assistant_name',
      preferred_language='fr-CA', updated_at=now() WHERE id=p_company_id;
    INSERT INTO public.assistant_configs(company_id,assistant_name,assistant_gender,tone,language_primary,greeting_inbound_fr,greeting_inbound_en)
      VALUES(p_company_id,p_data->>'assistant_name','feminine',p_data->>'tone','fr-CA',p_data->>'greeting_inbound_fr',p_data->>'greeting_inbound_en')
    ON CONFLICT (company_id) DO UPDATE SET assistant_name=EXCLUDED.assistant_name,
      tone=EXCLUDED.tone,language_primary=EXCLUDED.language_primary,
      greeting_inbound_fr=EXCLUDED.greeting_inbound_fr,greeting_inbound_en=EXCLUDED.greeting_inbound_en,updated_at=now();
  ELSIF p_step = 2 THEN
    SELECT * INTO v FROM public.voice_library WHERE id=(p_data->>'voice_library_id')::uuid AND is_active=true;
    IF NOT FOUND OR NULLIF(v.external_voice_id,'') IS NULL THEN
      RAISE EXCEPTION 'voice_unavailable' USING ERRCODE = '22023';
    END IF;
    UPDATE public.assistant_configs SET voice_id=v.external_voice_id,
      voice_stability=COALESCE((v.default_settings->>'stability')::numeric,0.8),
      voice_similarity=COALESCE((v.default_settings->>'similarity_boost')::numeric,0.9),
      voice_speed=COALESCE((v.default_settings->>'speed')::numeric,1),updated_at=now()
      WHERE company_id=p_company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'config_required' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.services(company_id,code,name_fr,name_en,icon,color,display_order,is_active)
      VALUES (p_company_id,'reception','Réception','Reception','Phone','#3B82F6',1,true),
        (p_company_id,'appointments','Rendez-vous','Appointments','Calendar','#8B5CF6',2,true),
        (p_company_id,'support','Support client','Customer support','MessageCircle','#10B981',3,true),
        (p_company_id,'outbound','Appels sortants','Outbound calls','PhoneOutgoing','#F59E0B',4,true)
      ON CONFLICT(company_id,code) DO NOTHING;
    FOR s IN SELECT id,code FROM public.services WHERE company_id=p_company_id LOOP
      INSERT INTO public.voice_assignments(company_id,voice_library_id,service_id,language,is_default)
        VALUES(p_company_id,v.id,s.id,'fr-CA',s.code='reception') ON CONFLICT DO NOTHING;
    END LOOP;
  ELSE
    -- Save the exact FAQ payload BEFORE embeddings. A partial external failure
    -- resumes this same payload, without silently dropping already indexed FAQ.
    IF jsonb_typeof(p_data->'knowledge_entries') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_data->'knowledge_entries') > 20 THEN
      RAISE EXCEPTION 'invalid_faq' USING ERRCODE = '22023';
    END IF;
    IF p.setup_data ? '3' AND p.setup_data->'3' <> p_data THEN
      RAISE EXCEPTION 'resume_saved_faq' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.onboarding_progress SET setup_data=jsonb_set(setup_data,ARRAY[p_step::text],p_data),
    completed_steps=CASE WHEN p_step=3 THEN completed_steps ELSE array_append(COALESCE(completed_steps,'{}'),p_step) END,
    current_step=CASE WHEN p_step=3 THEN 3 ELSE p_step+1 END,updated_at=now()
    WHERE company_id=p_company_id RETURNING * INTO p;
  RETURN to_jsonb(p);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_onboarding_knowledge(p_company_id uuid, p_data jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.onboarding_progress SET completed_steps=ARRAY[1,2,3],current_step=4,updated_at=now()
    WHERE company_id=p_company_id AND setup_data->'3'=p_data
      AND 2=ANY(completed_steps) AND activation_requested_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'setup_changed' USING ERRCODE='22023'; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_onboarding_activation(p_company_id uuid, p_area_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_config public.assistant_configs%ROWTYPE;
BEGIN
  IF p_area_code IS NULL OR p_area_code NOT IN ('581','418','514') THEN
    RAISE EXCEPTION 'invalid_area_code' USING ERRCODE='22023';
  END IF;
  UPDATE public.onboarding_progress SET activation_requested_at=COALESCE(activation_requested_at,now()),
    setup_data=jsonb_set(setup_data,'{area_code}',to_jsonb(p_area_code)),updated_at=now()
    WHERE company_id=p_company_id AND completed_steps @> ARRAY[1,2,3];
  IF NOT FOUND THEN RAISE EXCEPTION 'previous_step_required' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_config FROM public.assistant_configs WHERE company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR NULLIF(v_config.voice_id,'') IS NULL THEN
    RAISE EXCEPTION 'config_required' USING ERRCODE='22023';
  END IF;
  -- Do NOT mark provisioning in_progress here. Only provisionNewClient owns it.
  RETURN jsonb_build_object('assistant_name',v_config.assistant_name,'voice_id',v_config.voice_id,
    'system_prompt_voice_fr',v_config.system_prompt_voice_fr);
END;
$$;

-- A second settings tab cannot change the voice/greeting between the snapshot
-- handed to provisioning and provider creation. Technical binding/rollback
-- updates (phone/agent IDs) remain allowed. A lock conflict fails, never skips.
CREATE OR REPLACE FUNCTION public.guard_onboarding_config_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE p public.onboarding_progress%ROWTYPE;
BEGIN
  IF ROW(NEW.assistant_name,NEW.assistant_gender,NEW.tone,NEW.voice_id,NEW.greeting_inbound_fr,NEW.greeting_inbound_en,
         NEW.system_prompt_voice_fr,NEW.voice_stability,NEW.voice_similarity,NEW.voice_speed)
     IS NOT DISTINCT FROM
     ROW(OLD.assistant_name,OLD.assistant_gender,OLD.tone,OLD.voice_id,OLD.greeting_inbound_fr,OLD.greeting_inbound_en,
         OLD.system_prompt_voice_fr,OLD.voice_stability,OLD.voice_similarity,OLD.voice_speed) THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.onboarding_progress WHERE company_id=NEW.company_id FOR UPDATE;
  IF FOUND AND p.activation_requested_at IS NOT NULL AND p.provisioning_status IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'onboarding_activation_locked' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS onboarding_config_guard ON public.assistant_configs;
CREATE TRIGGER onboarding_config_guard BEFORE UPDATE ON public.assistant_configs
  FOR EACH ROW EXECUTE FUNCTION public.guard_onboarding_config_changes();
REVOKE ALL ON FUNCTION public.guard_onboarding_config_changes() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_onboarding_config_changes() TO service_role;

CREATE OR REPLACE FUNCTION public.arm_onboarding_test(p_company_id uuid,p_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE p public.onboarding_progress%ROWTYPE;
BEGIN
  IF p_phone IS NULL OR p_phone !~ '^[+][1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'invalid_phone' USING ERRCODE='22023';
  END IF;
  SELECT * INTO p FROM public.onboarding_progress WHERE company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR p.provisioning_status IS DISTINCT FROM 'done'
    OR NOT EXISTS(SELECT 1 FROM public.assistant_configs c JOIN public.phone_numbers n
      ON n.company_id=c.company_id AND n.phone_number=c.twilio_number AND n.elevenlabs_agent_id=c.elevenlabs_agent_id
      WHERE c.company_id=p_company_id AND n.status='active') THEN
    RAISE EXCEPTION 'activation_required' USING ERRCODE='22023';
  END IF;
  IF p.test_verified_at IS NOT NULL OR (p.test_phone=p_phone AND p.test_expires_at>now()) THEN RETURN to_jsonb(p); END IF;
  UPDATE public.onboarding_progress SET test_phone=p_phone,test_started_at=now(),
    test_expires_at=now()+interval '20 minutes',current_step=5,updated_at=now()
    WHERE company_id=p_company_id RETURNING * INTO p;
  RETURN to_jsonb(p);
END;
$$;

-- Called ONLY by the verified post-call webhook, never by a client route.
-- Provider timestamps (not webhook arrival time) exclude replayed old calls.
CREATE OR REPLACE FUNCTION public.confirm_onboarding_test_call(
  p_company_id uuid,p_call_id uuid,p_from text,p_to text,p_started_at timestamptz,p_duration integer
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_duration IS NULL OR p_duration<5 OR p_duration>1200 OR p_started_at IS NULL
     OR p_started_at>now() THEN RETURN false; END IF;
  UPDATE public.onboarding_progress p SET test_verified_at=now(),test_call_id=p_call_id,
    completed_at=now(),completed_steps=ARRAY[1,2,3,4,5],current_step=5,
    test_phone=NULL,updated_at=now()
    WHERE p.company_id=p_company_id AND p.provisioning_status='done' AND p.test_verified_at IS NULL
      AND p.test_phone=p_from AND p_started_at>=p.test_started_at
      AND p_started_at<=p.test_expires_at AND now()<=p.test_expires_at+interval '24 hours'
      AND EXISTS(SELECT 1 FROM public.phone_numbers n JOIN public.assistant_configs a ON a.company_id=n.company_id
        AND a.twilio_number=n.phone_number AND a.elevenlabs_agent_id=n.elevenlabs_agent_id
        WHERE n.company_id=p.company_id AND n.phone_number=p_to AND n.status='active')
      AND EXISTS(SELECT 1 FROM public.calls c JOIN public.post_call_processing_jobs j ON j.call_id=c.id AND j.company_id=c.company_id
        WHERE c.id=p_call_id AND c.company_id=p.company_id AND c.caller_phone=p_from
          AND c.status='completed' AND j.duration_seconds>=5
          AND j.twilio_call_sid ~ '^CA[0-9a-fA-F]{32}$'
          AND j.conversation_id=c.elevenlabs_conversation_id);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.save_onboarding_step(uuid,integer,jsonb),
  public.finish_onboarding_knowledge(uuid,jsonb),public.prepare_onboarding_activation(uuid,text),
  public.arm_onboarding_test(uuid,text),public.confirm_onboarding_test_call(uuid,uuid,text,text,timestamptz,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_onboarding_step(uuid,integer,jsonb),
  public.finish_onboarding_knowledge(uuid,jsonb),public.prepare_onboarding_activation(uuid,text),
  public.arm_onboarding_test(uuid,text),public.confirm_onboarding_test_call(uuid,uuid,text,text,timestamptz,integer)
  TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.onboarding_progress,public.services,public.voice_assignments,public.assistant_configs TO service_role;
GRANT SELECT,UPDATE ON public.companies TO service_role;
GRANT SELECT ON public.voice_library,public.phone_numbers,public.calls,public.post_call_processing_jobs TO service_role;
COMMIT;
