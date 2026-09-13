-- Task 20: transactional in-app events. Existing ticket email outbox unchanged.
-- Apply after 019 with operator approval; no backfill or subscription mutation.
BEGIN;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS payload_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scrubbed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS notification_event_once ON public.notifications(user_id,event_key) WHERE event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_tenant_inbox ON public.notifications(user_id,company_id,created_at DESC,id DESC);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notifications TO service_role;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_preferences FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.notification_preferences TO service_role;

CREATE OR REPLACE FUNCTION public.set_notification_retention()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_days integer;
BEGIN
  SELECT retention_days INTO v_days FROM public.company_settings WHERE company_id=NEW.company_id;
  NEW.payload_expires_at:=now()+make_interval(days=>COALESCE(v_days,90));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS product_notification_retention ON public.notifications;
CREATE TRIGGER product_notification_retention BEFORE INSERT ON public.notifications FOR EACH ROW
  EXECUTE FUNCTION public.set_notification_retention();
CREATE INDEX IF NOT EXISTS product_notification_expiry ON public.notifications(payload_expires_at)
  WHERE scrubbed_at IS NULL AND payload_expires_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.scrub_expired_product_notifications(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE affected integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit'; END IF;
  WITH expired AS (
    SELECT id FROM public.notifications WHERE payload_expires_at<=now() AND scrubbed_at IS NULL
      ORDER BY payload_expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE public.notifications n SET title='Notification archivée',body=NULL,payload='{}',link=NULL,
      read=true,read_at=COALESCE(n.read_at,now()),dismissed_at=COALESCE(n.dismissed_at,now()),scrubbed_at=now()
    FROM expired WHERE n.id=expired.id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  -- Keep technical event keys as deduplication tombstones, not caller content.
  RETURN affected;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_product_notification(
  p_company uuid,p_key text,p_event text,p_type text,p_title text,p_body text,p_link text,
  p_payload jsonb,p_audience text,p_exclude uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF p_company IS NULL OR p_key IS NULL OR length(p_key)>300
    OR p_audience NOT IN ('tenant','admins','all') THEN RAISE EXCEPTION 'invalid_notification'; END IF;
  INSERT INTO public.notifications(user_id,company_id,event_type,event_key,type,category,title,body,link,payload,read)
  SELECT p.user_id,p_company,p_event,p_company::text||'/'||p_key,p_type,
    CASE WHEN p_event LIKE 'ticket_%' THEN 'ticket' WHEN p_event IN ('payment_failed','quota_reached') THEN 'billing' ELSE 'system' END,
    left(p_title,200),left(p_body,1000),p_link,COALESCE(p_payload,'{}'),false
  FROM public.profiles p WHERE p.status='active' AND p.user_id IS DISTINCT FROM p_exclude
    AND ((p_audience IN ('tenant','all') AND p.company_id=p_company AND p.role IN ('company_admin','company_user'))
      OR (p_audience IN ('admins','all') AND p.role='super_admin'))
  ON CONFLICT (user_id,event_key) WHERE event_key IS NOT NULL DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_ticket_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_ticket public.tickets%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='tickets' THEN
    PERFORM public.emit_product_notification(NEW.company_id,'ticket/new/'||NEW.id,'ticket_created','info',
      'Nouveau ticket support','Un ticket vient d’être ouvert.','/support?ticket='||NEW.id,
      jsonb_build_object('ticket_id',NEW.id),'all',NULL);
  ELSE
    IF NEW.is_internal IS TRUE THEN RETURN NEW; END IF;
    -- Creation already has its own notification; do not duplicate first message.
    IF NOT EXISTS(SELECT 1 FROM public.ticket_messages m WHERE m.ticket_id=NEW.ticket_id
      AND m.company_id=NEW.company_id AND m.id<>NEW.id) THEN RETURN NEW; END IF;
    SELECT * INTO v_ticket FROM public.tickets WHERE id=NEW.ticket_id AND company_id=NEW.company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_tenant_mismatch'; END IF;
    PERFORM public.emit_product_notification(NEW.company_id,'ticket/reply/'||NEW.id,'ticket_reply','info',
      'Réponse à un ticket','Une nouvelle réponse publique est disponible.','/support?ticket='||NEW.ticket_id,
      jsonb_build_object('ticket_id',NEW.ticket_id,'message_id',NEW.id),
      CASE WHEN NEW.author_role='exevori_agent' THEN 'tenant' ELSE 'admins' END,NEW.author_user_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS product_ticket_created ON public.tickets;
CREATE TRIGGER product_ticket_created AFTER INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.notify_ticket_event();
DROP TRIGGER IF EXISTS product_ticket_reply ON public.ticket_messages;
CREATE TRIGGER product_ticket_reply AFTER INSERT ON public.ticket_messages FOR EACH ROW EXECUTE FUNCTION public.notify_ticket_event();

CREATE OR REPLACE FUNCTION public.notify_provisioning_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.provisioning_status IN ('done','failed') AND NEW.provisioning_status IS DISTINCT FROM OLD.provisioning_status THEN
    PERFORM public.emit_product_notification(NEW.company_id,
      'provisioning/'||COALESCE(NEW.provisioning_started_at::text,'legacy')||'/'||NEW.provisioning_status,
      CASE WHEN NEW.provisioning_status='done' THEN 'provisioning_completed' ELSE 'provisioning_failed' END,
      CASE WHEN NEW.provisioning_status='done' THEN 'success' ELSE 'error' END,
      CASE WHEN NEW.provisioning_status='done' THEN 'Assistante activée' ELSE 'Activation à vérifier' END,
      CASE WHEN NEW.provisioning_status='done' THEN 'Le numéro est configuré. Reprenez votre appel test.' ELSE 'Une activation a échoué. Consultez le suivi ou contactez le support.' END,
      '/onboarding','{}','all',NULL);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS product_provisioning_event ON public.onboarding_progress;
CREATE TRIGGER product_provisioning_event AFTER UPDATE OF provisioning_status ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.notify_provisioning_event();

CREATE OR REPLACE FUNCTION public.check_notification_quota(p_company uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.subscriptions%ROWTYPE; v_start timestamptz; v_end timestamptz; v_used numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('notification-quota/'||p_company::text,0));
  SELECT * INTO s FROM public.subscriptions WHERE company_id=p_company;
  IF NOT FOUND OR s.minutes_included IS NULL OR s.minutes_included<0 THEN RETURN; END IF;
  v_start:=COALESCE(s.current_period_start::timestamptz,date_trunc('month',now()));
  v_end:=COALESCE(s.current_period_end::timestamptz,date_trunc('month',now())+interval '1 month');
  SELECT GREATEST(COALESCE(s.minutes_used_current_period,0),
    (COALESCE((SELECT sum(GREATEST(COALESCE(duration_seconds,0),0)) FROM public.calls WHERE company_id=p_company AND created_at>=v_start AND created_at<v_end),0)
    +COALESCE((SELECT sum(GREATEST(COALESCE(duration_seconds,0),0)) FROM public.outbound_calls WHERE company_id=p_company AND created_at>=v_start AND created_at<v_end),0))/60.0)
  INTO v_used;
  IF v_used>=s.minutes_included THEN
    PERFORM public.emit_product_notification(p_company,'quota/'||v_start::text,'quota_reached','warning',
      'Quota de minutes atteint','Le volume inclus est atteint. Consultez la consommation et la politique de dépassement.',
      '/billing',jsonb_build_object('period_start',v_start,'minutes_included',s.minutes_included),'all',NULL);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_subscription_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.payment_status='overdue' AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    PERFORM public.emit_product_notification(NEW.company_id,'payment/'||txid_current()::text,'payment_failed','error',
      'Paiement non confirmé','Un paiement a échoué. Vérifiez votre moyen de paiement et vos factures.',
      '/billing','{}','all',NULL);
  END IF;
  PERFORM public.check_notification_quota(NEW.company_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS product_subscription_event ON public.subscriptions;
CREATE TRIGGER product_subscription_event AFTER UPDATE OF payment_status,minutes_used_current_period,minutes_included,current_period_start
  ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.notify_subscription_event();

CREATE OR REPLACE FUNCTION public.notify_call_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  -- All recorded missed/failed inbound calls are actionable in V1; do not infer
  -- importance from a transcript or expose a caller phone in the notification.
  IF TG_TABLE_NAME='calls' AND NEW.status IN ('abandoned','failed','missed','no_answer','busy','cancelled') THEN
    PERFORM public.emit_product_notification(NEW.company_id,'missed/'||COALESCE(NEW.twilio_call_sid,NEW.id::text),'important_missed_call','warning',
      'Appel entrant à reprendre','Un appel entrant n’a pas abouti. Consultez sa fiche pour assurer le suivi.',
      '/calls',jsonb_build_object('call_id',NEW.id),'tenant',NULL);
  END IF;
  IF COALESCE(NEW.duration_seconds,0)>0 THEN PERFORM public.check_notification_quota(NEW.company_id); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS product_inbound_event ON public.calls;
CREATE TRIGGER product_inbound_event AFTER INSERT OR UPDATE OF status,duration_seconds ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.notify_call_event();
DROP TRIGGER IF EXISTS product_outbound_event ON public.outbound_calls;
CREATE TRIGGER product_outbound_event AFTER INSERT OR UPDATE OF duration_seconds ON public.outbound_calls
  FOR EACH ROW EXECUTE FUNCTION public.notify_call_event();

-- Twilio may fail before an ElevenLabs conversation/call row exists. The
-- signed callback can still notify the owning tenant without inventing a call.
CREATE OR REPLACE FUNCTION public.record_missed_call_notification(p_sid text,p_to text,p_from text,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_company uuid; v_call public.calls%ROWTYPE; v_phone text;
BEGIN
  IF p_sid IS NULL OR p_sid !~ '^CA[0-9a-fA-F]{32}$' OR p_to IS NULL OR p_to !~ '^[+][1-9][0-9]{7,14}$'
     OR p_status IS NULL OR p_status NOT IN ('busy','no-answer','failed','canceled') THEN
    RAISE EXCEPTION 'invalid_missed_call';
  END IF;
  SELECT company_id INTO v_company FROM public.phone_numbers WHERE phone_number=p_to AND status='active';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('missed-call/'||p_sid,0));
  SELECT * INTO v_call FROM public.calls WHERE company_id=v_company AND twilio_call_sid=p_sid
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  -- Late/replayed status cannot downgrade a known successful conversation.
  IF FOUND AND v_call.status IN ('completed','transferred') THEN RETURN false; END IF;
  v_phone:=CASE WHEN p_from ~ '^[+][1-9][0-9]{7,14}$' THEN p_from ELSE NULL END;
  PERFORM public.emit_product_notification(v_company,'missed/'||p_sid,'important_missed_call','warning',
    'Appel entrant à reprendre','Un appel entrant n’a pas abouti. '||CASE WHEN v_phone IS NULL
      THEN 'Numéro appelant indisponible.' ELSE 'Téléphone de rappel : '||v_phone||'. Vérifiez le consentement avant tout rappel.' END,
    '/calls',jsonb_build_object('call_id',v_call.id,'twilio_call_sid',p_sid,'caller_phone',v_phone),'tenant',NULL);
  IF v_call.id IS NOT NULL THEN
    UPDATE public.calls SET status=CASE WHEN p_status='failed' THEN 'failed' ELSE 'abandoned' END,
      ended_at=COALESCE(ended_at,now()) WHERE id=v_call.id AND company_id=v_company
      AND status NOT IN ('completed','transferred');
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_product_notification(uuid,text,text,text,text,text,text,jsonb,text,uuid),
  public.notify_ticket_event(),public.notify_provisioning_event(),public.check_notification_quota(uuid),
  public.notify_subscription_event(),public.notify_call_event(),public.record_missed_call_notification(text,text,text,text),
  public.set_notification_retention(),public.scrub_expired_product_notifications(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.emit_product_notification(uuid,text,text,text,text,text,text,jsonb,text,uuid),
  public.notify_ticket_event(),public.notify_provisioning_event(),public.check_notification_quota(uuid),
  public.notify_subscription_event(),public.notify_call_event(),public.record_missed_call_notification(text,text,text,text),
  public.set_notification_retention(),public.scrub_expired_product_notifications(integer) TO service_role;
COMMIT;
