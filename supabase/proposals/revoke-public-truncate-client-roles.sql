-- PURE FUNCTION — reviewed least-privilege proposal (NOT automatically deployed)
-- QA verification on project nsshdxxdvzzxlmdomixf: PASS, 2026-11-21.
-- Production project rugwzvztweiffprkxfdc: DO NOT APPLY without explicit owner approval.
-- Scope: TRUNCATE privilege only. Does not modify any table rows, RLS policies or Auth users.
-- Future tables created by supabase_admin retain provider-managed default grants;
-- audit future tables and coordinate their grant hardening separately.
BEGIN;

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

DO $audit$
DECLARE
  still_allowed integer;
BEGIN
  SELECT count(*) INTO still_allowed
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND (
      has_table_privilege('anon', c.oid, 'TRUNCATE')
      OR has_table_privilege('authenticated', c.oid, 'TRUNCATE')
    );

  IF still_allowed <> 0 THEN
    RAISE EXCEPTION 'Least-privilege audit failed: % public tables still permit TRUNCATE', still_allowed;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.clients', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.clients', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.clients', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'Least-privilege audit failed: legitimate app/service grants changed';
  END IF;
END
$audit$;

COMMIT;
