-- Pure Function invite onboarding: read-only service checks and verified membership.
-- The existing account and client rows are never changed by this migration.

create or replace function public.pf_invite_account_state(p_email text)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
        and u.email_confirmed_at is not null
    ) then 'confirmed'
    when exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
    ) then 'pending'
    else 'absent'
  end;
$$;
revoke all on function public.pf_invite_account_state(text) from public, anon, authenticated;
grant execute on function public.pf_invite_account_state(text) to service_role;

-- A profile created by the Auth insert trigger is NOT proof that email
-- ownership has been verified. Show "active" only for confirmed users.
create or replace function public.pf_confirmed_client_ids()
returns table (client_id text)
language sql stable security definer set search_path = ''
as $$
  select c.id
  from public.clients c
  join public.profiles p on p.client_id = c.id and p.role = 'client'
  join auth.users u on u.id = p.id
  where private.basic_is_coach()
    and c.coach_id = auth.uid()
    and u.email_confirmed_at is not null;
$$;
revoke all on function public.pf_confirmed_client_ids() from public, anon;
grant execute on function public.pf_confirmed_client_ids() to authenticated;
