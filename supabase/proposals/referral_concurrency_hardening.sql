-- QA-tested function definitions. Proposal only: no automated Production application.
-- Requires explicit approval and verified concurrency acceptance.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.my_referral_code()'::regprocedure)) <> '1d0a1b040f26f6b533ef63d637ec3dd8'
 OR md5(pg_get_functiondef('public.submit_referral(text,text,text,text,text)'::regprocedure)) <> '9d2dec30193243c489ccf698226d104e' THEN
 RAISE EXCEPTION 'Referral function source drift';
 END IF;
END $guard$;
CREATE TEMP TABLE pf_referral_acl_before ON COMMIT DROP AS
 SELECT oid,proacl,proowner,prosecdef,proconfig,provolatile FROM pg_proc
 WHERE oid IN ('public.my_referral_code()'::regprocedure,'public.submit_referral(text,text,text,text,text)'::regprocedure);
CREATE OR REPLACE FUNCTION public.my_referral_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 cid text := private.my_client_id();
 c text;
 candidate text;
begin
 if cid is null then return null; end if;
 select code into c from public.referral_codes where client_id = cid;
 if c is not null then return c; end if;
 for attempt in 1..8 loop
   candidate := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
   insert into public.referral_codes (client_id, code) values (cid, candidate)
     on conflict do nothing returning code into c;
   if c is not null then return c; end if;
   select code into c from public.referral_codes where client_id = cid;
   if c is not null then return c; end if;
 end loop;
 raise exception 'Could not create invite code. Please retry.' using errcode='PT409';
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_referral(p_code text, p_name text, p_email text, p_location text, p_note text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 cid text;
 e text := lower(trim(p_email));
begin
 select client_id into cid from public.referral_codes where code = lower(trim(p_code));
 if cid is null then raise exception 'Invalid invite link'; end if;
 if e is null or char_length(e) > 200 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
   raise exception 'Please enter a valid email';
 end if;
 if p_name is null or trim(p_name) = '' then
   raise exception 'Please enter your name';
 end if;
 -- One transaction at a time per referrer; do not queue concurrent public callers.
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('pf.referral.submit:' || cid, 0)) then
   raise exception 'Another invite is being processed. Please retry.' using errcode='PT409';
 end if;
 -- The API uses READ COMMITTED. Fail closed if a caller changes isolation.
 if current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'Please retry your invite' using errcode='PT409';
 end if;
 if (select count(*) from public.referrals where referrer_client_id = cid and created_at > now() - interval '1 day') >= 20 then
   raise exception 'Too many invites today, please try again tomorrow';
 end if;
 insert into public.referrals (referrer_client_id, name, email, location, note)
 values (cid, left(trim(p_name), 120), e, left(trim(coalesce(p_location, '')), 120), left(trim(coalesce(p_note, '')), 1000))
 on conflict (referrer_client_id, lower(email)) do nothing;
 return true;
end;
$function$;

DO $verify$
BEGIN
 IF EXISTS (SELECT 1 FROM pf_referral_acl_before b LEFT JOIN pg_proc p USING(oid)
 WHERE (p.proacl,p.proowner,p.prosecdef,p.proconfig,p.provolatile) IS DISTINCT FROM (b.proacl,b.proowner,b.prosecdef,b.proconfig,b.provolatile))
 OR md5(pg_get_functiondef('public.my_referral_code()'::regprocedure)) <> '1600a6f8ba35872b75cc5d1c3b00d3a4'
 OR md5(pg_get_functiondef('public.submit_referral(text,text,text,text,text)'::regprocedure)) <> 'b92b39f6789526c360fedcb4190b58e0'
 THEN RAISE EXCEPTION 'Referral function verification failed'; END IF;
END $verify$;
COMMIT;
