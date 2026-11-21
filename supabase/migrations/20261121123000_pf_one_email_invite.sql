-- Invites are service-role only. Never let a public caller enumerate accounts.
create or replace function public.pf_invite_existing_account(p_email text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'email', u.email,
    'confirmed', u.email_confirmed_at is not null,
    'hasPassword', length(coalesce(u.encrypted_password, '')) > 0,
    'clientId', (select p.client_id from public.profiles p where p.id = u.id and p.role = 'client' limit 1)
  )
  from auth.users u
  where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
  limit 1;
$$;
revoke execute on function public.pf_invite_existing_account(text) from public, anon, authenticated;
grant execute on function public.pf_invite_existing_account(text) to service_role;

-- A created Auth profile does not prove a client finished onboarding.
-- Expose only confirmed, password-enabled records owned by the calling coach.
create or replace function public.pf_joined_client_ids()
returns setof text
language sql stable security definer
set search_path = ''
as $$
  select c.id
  from public.clients c
  join public.profiles p on p.client_id = c.id and p.role = 'client'
  join auth.users u on u.id = p.id
  where c.coach_id = (select auth.uid())
    and private.basic_is_coach()
    and u.email_confirmed_at is not null
    and pg_catalog.length(coalesce(u.encrypted_password, '')) > 0;
$$;
revoke execute on function public.pf_joined_client_ids() from public, anon;
grant execute on function public.pf_joined_client_ids() to authenticated;

-- A confirmed email without a chosen password must not bypass the
-- invitation screen by opening the app in a separate tab.
create or replace function public.pf_my_password_ready()
returns boolean
language sql stable security definer
set search_path = ''
as $password_ready$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and pg_catalog.length(coalesce(u.encrypted_password, '')) > 0
  );
$password_ready$;
revoke execute on function public.pf_my_password_ready() from public, anon;
grant execute on function public.pf_my_password_ready() to authenticated;
