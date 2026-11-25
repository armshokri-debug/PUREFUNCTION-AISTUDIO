-- Isolated CI only. Synthetic minimal schema; not a Supabase Auth/RLS integration test.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA private;
CREATE FUNCTION private.my_client_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('pf.test_client',true),'') $$;
CREATE TABLE public.referral_codes(client_id text PRIMARY KEY,code text UNIQUE NOT NULL);
CREATE TABLE public.referrals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),referrer_client_id text NOT NULL,name text NOT NULL,email text NOT NULL,location text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX referrals_one_per_email ON public.referrals(referrer_client_id,lower(email));
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.my_referral_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cid text := private.my_client_id();
  c text;
begin
  if cid is null then
    return null;
  end if;
  select code into c from public.referral_codes where client_id = cid;
  if c is null then
    loop
      c := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      begin
        insert into public.referral_codes (client_id, code) values (cid, c);
        exit;
      exception when unique_violation then
      end;
    end loop;
  end if;
  return c;
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
  if cid is null then
    raise exception 'Invalid invite link';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email';
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

REVOKE ALL ON FUNCTION public.my_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_referral(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_referral_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_referral(text,text,text,text,text) TO anon,authenticated;
