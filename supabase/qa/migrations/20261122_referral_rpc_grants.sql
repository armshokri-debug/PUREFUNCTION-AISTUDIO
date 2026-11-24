-- QA-ONLY: restore intentional public referral RPC grants to match Production.
-- This file is NOT in supabase/migrations; never apply to Production.
-- Confirmed definitions SHA256 match exact live Production definitions on 2026-11-22.
DO $qa$
BEGIN
  IF to_regclass('private.qa_mail_outbox') IS NULL THEN
    RAISE EXCEPTION 'QA marker missing; refuse to change function privileges';
  END IF;
  IF current_database() IS NULL THEN
    RAISE EXCEPTION 'Missing database identification';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('referral_inviter','submit_referral')
        AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""'::text]) <> 2 THEN
    RAISE EXCEPTION 'Unexpected RPC definitions';
  END IF;
  IF encode(extensions.digest(pg_get_functiondef('public.referral_inviter(text)'::regprocedure),'sha256'),'hex')
      <> '58fc44d094fa1db0a19d1152e1105f079c84ea27980a92488b678deb8b19cca6'
     OR encode(extensions.digest(pg_get_functiondef('public.submit_referral(text,text,text,text,text)'::regprocedure),'sha256'),'hex')
      <> '517a583556e1a273d4497fb2b556b55c1379120fc0804b74e36fb35c58f8d797' THEN
    RAISE EXCEPTION 'Function body differs from reviewed Production function';
  END IF;
END $qa$;
GRANT EXECUTE ON FUNCTION public.referral_inviter(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_referral(text,text,text,text,text) TO anon, authenticated;
