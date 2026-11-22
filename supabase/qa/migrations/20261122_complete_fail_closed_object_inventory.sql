-- QA ONLY: the remaining schema names without activating Cron or legacy message access.

DO $qa_lock$ BEGIN IF to_regclass('private.qa_mail_outbox') IS NULL THEN RAISE EXCEPTION 'QA ONLY'; END IF; END $qa_lock$;

-- A QA Vault cron secret does not exist; pg_cron is not installed. All cron_secret_ok calls therefore return false.

CREATE OR REPLACE FUNCTION public.cron_secret_ok(s text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = s);
$function$;

REVOKE ALL ON FUNCTION public.cron_secret_ok(text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.cron_secret_ok(text) TO service_role;

-- RLS policy definitions match Production, but no role is granted access to the obsolete table.

REVOKE ALL ON TABLE public.messages FROM PUBLIC,anon,authenticated;

CREATE POLICY "messages delete" ON public.messages AS PERMISSIVE FOR DELETE TO authenticated USING (( SELECT private.is_coach() AS is_coach));

CREATE POLICY "messages insert" ON public.messages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((( SELECT private.is_coach() AS is_coach) AND (sender = 'coach'::text)) OR ((client_id = ( SELECT private.my_client_id() AS my_client_id)) AND (sender = 'client'::text))));

CREATE POLICY "messages read" ON public.messages AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT private.is_coach() AS is_coach) OR (client_id = ( SELECT private.my_client_id() AS my_client_id))));

CREATE POLICY "messages update" ON public.messages AS PERMISSIVE FOR UPDATE TO authenticated USING ((( SELECT private.is_coach() AS is_coach) OR (client_id = ( SELECT private.my_client_id() AS my_client_id)))) WITH CHECK ((( SELECT private.is_coach() AS is_coach) OR (client_id = ( SELECT private.my_client_id() AS my_client_id))));
