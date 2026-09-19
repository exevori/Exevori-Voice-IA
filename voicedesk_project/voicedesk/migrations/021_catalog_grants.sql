-- Migration 021 — read-only public catalogues and fixed function search paths.
-- Approved pre-merge hardening. No row data, RLS policy, function body,
-- SECURITY INVOKER/DEFINER setting or function EXECUTE grant is changed.

BEGIN;

REVOKE ALL ON TABLE public.plan_limits FROM anon, authenticated;
REVOKE ALL ON TABLE public.plan_pricing FROM anon, authenticated;
REVOKE ALL ON TABLE public.voice_library FROM anon, authenticated;

GRANT SELECT ON TABLE public.plan_limits TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.plan_pricing TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.voice_library TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.plan_limits TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.plan_pricing TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.voice_library TO service_role;

-- These five bodies use only pg_catalog built-ins and trigger NEW records.
-- ALTER FUNCTION preserves their identity, ownership, body and privileges.
ALTER FUNCTION public.current_company_id() SET search_path = '';
ALTER FUNCTION public.is_super_admin() SET search_path = '';
ALTER FUNCTION public.currency_for_country(text) SET search_path = '';
ALTER FUNCTION public.installation_fee_for_country(text) SET search_path = '';
ALTER FUNCTION public.trg_set_updated_at() SET search_path = '';

COMMIT;
