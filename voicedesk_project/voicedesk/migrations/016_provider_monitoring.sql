-- Migration 016 — Monitoring interne (aucune donnée client, aucun appel réseau).
-- Préparée uniquement : validation SQL en environnement de test avant production.
BEGIN;

CREATE TABLE IF NOT EXISTS public.provider_monitor_state (
  provider text PRIMARY KEY CHECK (provider IN ('twilio','elevenlabs','groq','supabase','stripe','resend')),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','down','unauthorized','not_configured','unknown')),
  detail text,
  latency_ms integer CHECK (latency_ms >= 0),
  checked_at timestamptz,
  down_since timestamptz,
  incident_id uuid,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  check_token uuid,
  lease_expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.provider_monitor_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES public.provider_monitor_state(provider),
  status text NOT NULL CHECK (status IN ('ok','down','unauthorized','not_configured','unknown')),
  latency_ms integer CHECK (latency_ms >= 0),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_checks_time ON public.provider_monitor_checks(checked_at, provider);

CREATE TABLE IF NOT EXISTS public.provider_monitor_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES public.provider_monitor_state(provider),
  incident_id uuid NOT NULL UNIQUE,
  down_since timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_alert_due ON public.provider_monitor_alerts(next_attempt_at)
  WHERE status IN ('pending','processing');

INSERT INTO public.provider_monitor_state(provider)
VALUES ('twilio'),('elevenlabs'),('groq'),('supabase'),('stripe'),('resend')
ON CONFLICT (provider) DO NOTHING;

ALTER TABLE public.provider_monitor_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_monitor_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_monitor_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_monitor_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provider_monitor_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_monitor_alerts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_monitor_state, public.provider_monitor_checks,
  public.provider_monitor_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_monitor_state,
  public.provider_monitor_checks, public.provider_monitor_alerts TO service_role;
DROP POLICY IF EXISTS service_role_bypass ON public.provider_monitor_state;
CREATE POLICY service_role_bypass ON public.provider_monitor_state FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_bypass ON public.provider_monitor_checks;
CREATE POLICY service_role_bypass ON public.provider_monitor_checks FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_bypass ON public.provider_monitor_alerts;
CREATE POLICY service_role_bypass ON public.provider_monitor_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.claim_provider_checks()
RETURNS SETOF public.provider_monitor_state
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $function$
  WITH due AS (
    SELECT provider FROM public.provider_monitor_state
    WHERE next_check_at <= clock_timestamp()
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    ORDER BY provider FOR UPDATE SKIP LOCKED
  )
  UPDATE public.provider_monitor_state AS state
  SET check_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '30 seconds'
  FROM due WHERE state.provider = due.provider RETURNING state.*;
$function$;

CREATE OR REPLACE FUNCTION public.record_provider_check(
  p_provider text, p_token uuid, p_status text, p_latency_ms integer, p_detail text
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  state public.provider_monitor_state;
  observed_at timestamptz := clock_timestamp();
  failed boolean := p_status IN ('down','unauthorized');
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok','down','unauthorized','not_configured','unknown')
     OR p_latency_ms < 0 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
  SELECT * INTO state FROM public.provider_monitor_state
  WHERE provider = p_provider AND check_token = p_token AND lease_expires_at > observed_at FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A monitoring gap is not evidence of continuous failure.
  IF failed THEN
    IF state.status NOT IN ('down','unauthorized') OR state.down_since IS NULL
       OR state.checked_at < observed_at - interval '150 seconds' THEN
      state.down_since := observed_at;
      state.incident_id := gen_random_uuid();
    END IF;
  ELSE
    state.down_since := NULL;
    state.incident_id := NULL;
  END IF;
  UPDATE public.provider_monitor_state SET status = p_status, detail = left(p_detail, 100),
    latency_ms = p_latency_ms, checked_at = observed_at, down_since = state.down_since,
    incident_id = state.incident_id, check_token = NULL, lease_expires_at = NULL,
    next_check_at = observed_at + interval '55 seconds'
  WHERE provider = p_provider;
  INSERT INTO public.provider_monitor_checks(provider,status,latency_ms,checked_at)
  VALUES (p_provider,p_status,p_latency_ms,observed_at);
  IF failed AND state.down_since < observed_at - interval '5 minutes' THEN
    INSERT INTO public.provider_monitor_alerts(provider,incident_id,down_since)
    VALUES (p_provider,state.incident_id,state.down_since)
    ON CONFLICT (incident_id) DO NOTHING;
  END IF;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_provider_alerts()
RETURNS SETOF public.provider_monitor_alerts
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  -- An observed incident remains deliverable after recovery, especially when
  -- Resend itself was down. The immutable email describes the past observation.
  -- Keep all ambiguous delivery retries within Resend's 24-hour idempotency window.
  UPDATE public.provider_monitor_alerts SET status = 'failed', last_error = 'delivery_window_expired', updated_at = clock_timestamp()
  WHERE status IN ('pending','processing') AND created_at < clock_timestamp() - interval '23 hours'
    AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp());
  RETURN QUERY
  WITH due AS (
    SELECT alert.id FROM public.provider_monitor_alerts AS alert
    WHERE alert.status IN ('pending','processing') AND alert.next_attempt_at <= clock_timestamp()
      AND (alert.lease_expires_at IS NULL OR alert.lease_expires_at <= clock_timestamp())
    ORDER BY alert.created_at FOR UPDATE OF alert SKIP LOCKED LIMIT 6
  )
  UPDATE public.provider_monitor_alerts AS alert
  SET status = 'processing', attempts = attempts + 1, claim_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '120 seconds', updated_at = clock_timestamp()
  FROM due WHERE alert.id = due.id RETURNING alert.*;
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_provider_alert(p_id uuid, p_token uuid, p_message_id text, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE affected integer;
BEGIN
  UPDATE public.provider_monitor_alerts AS alert
  SET status = CASE WHEN NULLIF(p_message_id,'') IS NOT NULL THEN 'sent' ELSE 'pending' END,
    provider_message_id = left(p_message_id,200), last_error = left(p_error,100),
    claim_token = NULL, lease_expires_at = NULL,
    next_attempt_at = clock_timestamp() + make_interval(secs => least(900, 60 * power(2,least(alert.attempts,4)))::integer),
    updated_at = clock_timestamp()
  WHERE id = p_id AND claim_token = p_token AND status = 'processing' AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.provider_monitor_history()
RETURNS TABLE(provider text, bucket timestamptz, status text, sample_count bigint, latency_ms numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  SELECT checks.provider,
    date_bin(interval '15 minutes', checks.checked_at, timestamptz '2000-01-01') AS bucket,
    CASE WHEN bool_or(checks.status = 'down') THEN 'down'
      WHEN bool_or(checks.status = 'unauthorized') THEN 'unauthorized'
      WHEN bool_or(checks.status = 'unknown') THEN 'unknown'
      WHEN bool_or(checks.status = 'not_configured') THEN 'not_configured' ELSE 'ok' END,
    count(*), round(avg(checks.latency_ms))
  FROM public.provider_monitor_checks AS checks WHERE checks.checked_at >= now() - interval '24 hours'
  GROUP BY checks.provider, bucket ORDER BY checks.provider, bucket;
$function$;

CREATE OR REPLACE FUNCTION public.purge_provider_monitoring()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  DELETE FROM public.provider_monitor_checks WHERE id IN (
    SELECT id FROM public.provider_monitor_checks WHERE checked_at < now() - interval '48 hours'
    ORDER BY checked_at LIMIT 5000 FOR UPDATE SKIP LOCKED
  );
  DELETE FROM public.provider_monitor_alerts WHERE id IN (
    SELECT id FROM public.provider_monitor_alerts WHERE updated_at < now() - interval '30 days'
      AND status IN ('sent','failed','suppressed') ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED
  );
END
$function$;

REVOKE ALL ON FUNCTION public.claim_provider_checks(), public.record_provider_check(text,uuid,text,integer,text),
  public.claim_provider_alerts(), public.finish_provider_alert(uuid,uuid,text,text),
  public.provider_monitor_history(), public.purge_provider_monitoring() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_provider_checks(), public.record_provider_check(text,uuid,text,integer,text),
  public.claim_provider_alerts(), public.finish_provider_alert(uuid,uuid,text,text),
  public.provider_monitor_history(), public.purge_provider_monitoring() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
