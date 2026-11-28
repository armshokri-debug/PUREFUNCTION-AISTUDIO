-- PROPOSAL ONLY — DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT OWNER APPROVAL.
-- Staged, trackable, idempotent client deletion job table & service-role-only RPCs.
-- Apply first to QA Supabase after backup, verify end-to-end, then obtain explicit
-- owner approval before applying to Production Supabase.

create schema if not exists private;

create table if not exists private.client_deletion_jobs (
  client_id text primary key,
  coach_id uuid not null,
  client_name text not null,
  is_test_client boolean not null default false,
  status text not null check (status in ('pending', 'auth_disabled', 'db_deleted', 'auth_deleted', 'completed')),
  linked_auth_user_ids uuid[] not null default '{}',
  storage_manifest jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(storage_manifest) = 'array'),
  last_error text,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists client_deletion_jobs_coach_status_idx
  on private.client_deletion_jobs (coach_id, status);

alter table private.client_deletion_jobs enable row level security;
revoke all on table private.client_deletion_jobs from public, anon, authenticated;
grant select, insert, update on table private.client_deletion_jobs to service_role;

-- Service-role-only RPC: read an existing deletion job by client_id.
create or replace function public.pf_deletion_job_get(p_client_id text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'clientId', j.client_id,
    'coachId', j.coach_id,
    'clientName', j.client_name,
    'isTestClient', j.is_test_client,
    'status', j.status,
    'linkedAuthUserIds', j.linked_auth_user_ids,
    'storageManifest', j.storage_manifest,
    'attempts', j.attempts,
    'lastError', j.last_error
  )
  from private.client_deletion_jobs j
  where j.client_id = p_client_id
  limit 1;
$$;
revoke all on function public.pf_deletion_job_get(text) from public, anon, authenticated;
grant execute on function public.pf_deletion_job_get(text) to service_role;

-- Service-role-only RPC: create a new pending deletion job (idempotent on conflict).
create or replace function public.pf_deletion_job_create(
  p_client_id text,
  p_coach_id uuid,
  p_client_name text,
  p_is_test_client boolean,
  p_linked_auth_user_ids uuid[],
  p_storage_manifest jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row private.client_deletion_jobs%rowtype;
begin
  insert into private.client_deletion_jobs (
    client_id,
    coach_id,
    client_name,
    is_test_client,
    status,
    linked_auth_user_ids,
    storage_manifest,
    attempts
  )
  values (
    p_client_id,
    p_coach_id,
    p_client_name,
    coalesce(p_is_test_client, false),
    'pending',
    coalesce(p_linked_auth_user_ids, '{}'::uuid[]),
    coalesce(p_storage_manifest, '[]'::jsonb),
    1
  )
  on conflict (client_id) do nothing
  returning * into v_row;

  if v_row.client_id is null then
    select * into v_row
    from private.client_deletion_jobs
    where client_id = p_client_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'clientId', v_row.client_id,
    'coachId', v_row.coach_id,
    'clientName', v_row.client_name,
    'isTestClient', v_row.is_test_client,
    'status', v_row.status,
    'linkedAuthUserIds', v_row.linked_auth_user_ids,
    'storageManifest', v_row.storage_manifest,
    'attempts', v_row.attempts,
    'lastError', v_row.last_error
  );
end;
$$;
revoke all on function public.pf_deletion_job_create(text, uuid, text, boolean, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.pf_deletion_job_create(text, uuid, text, boolean, uuid[], jsonb) to service_role;

-- Service-role-only RPC: advance or record error on an existing deletion job.
create or replace function public.pf_deletion_job_advance(
  p_client_id text,
  p_status text,
  p_last_error text default null,
  p_increment_attempts boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row private.client_deletion_jobs%rowtype;
begin
  update private.client_deletion_jobs
  set
    status = p_status,
    last_error = p_last_error,
    attempts = case when coalesce(p_increment_attempts, false) then attempts + 1 else attempts end,
    updated_at = now(),
    completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else completed_at end
  where client_id = p_client_id
  returning * into v_row;

  if v_row.client_id is null then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'clientId', v_row.client_id,
    'coachId', v_row.coach_id,
    'clientName', v_row.client_name,
    'isTestClient', v_row.is_test_client,
    'status', v_row.status,
    'linkedAuthUserIds', v_row.linked_auth_user_ids,
    'storageManifest', v_row.storage_manifest,
    'attempts', v_row.attempts,
    'lastError', v_row.last_error
  );
end;
$$;
revoke all on function public.pf_deletion_job_advance(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.pf_deletion_job_advance(text, text, text, boolean) to service_role;

-- A persistent lease serializes the multi-service deletion workflow. Do not shorten
-- the 15-minute expiry below the maximum Edge Function execution lifetime.
create table if not exists private.client_deletion_leases (
  client_id text primary key,
  lease_id uuid not null,
  expires_at timestamptz not null
);
alter table private.client_deletion_leases enable row level security;
revoke all on private.client_deletion_leases from public, anon, authenticated;

create or replace function public.pf_deletion_lease_acquire(
  p_client_id text, p_coach_id uuid, p_lease_id uuid
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_lease uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = p_coach_id and p.role = 'coach')
    or not (
      exists (select 1 from private.client_deletion_jobs j where j.client_id = p_client_id and j.coach_id = p_coach_id)
      or (not exists (select 1 from private.client_deletion_jobs j where j.client_id = p_client_id)
          and exists (select 1 from public.clients c where c.id = p_client_id and c.coach_id = p_coach_id))
    ) then
    return 'forbidden';
  end if;
  insert into private.client_deletion_leases as l (client_id, lease_id, expires_at)
  values (p_client_id, p_lease_id, pg_catalog.clock_timestamp() + interval '15 minutes')
  on conflict (client_id) do update
    set lease_id = excluded.lease_id, expires_at = excluded.expires_at
    where l.expires_at <= pg_catalog.clock_timestamp()
  returning lease_id into v_lease;
  if v_lease is null then return 'busy'; end if;
  return 'acquired';
end;
$$;
revoke all on function public.pf_deletion_lease_acquire(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pf_deletion_lease_acquire(text, uuid, uuid) to service_role;

create or replace function public.pf_deletion_lease_release(
  p_client_id text, p_lease_id uuid
) returns void
language sql security definer set search_path = ''
as $$
  delete from private.client_deletion_leases
  where client_id = p_client_id and lease_id = p_lease_id;
$$;
revoke all on function public.pf_deletion_lease_release(text, uuid) from public, anon, authenticated;
grant execute on function public.pf_deletion_lease_release(text, uuid) to service_role;

-- Safe deletion must be the ONLY path for deleting a cloud client. The caller
-- has already been authenticated by the Edge Function; the DB checks role,
-- ownership, durable stage and unexpired lease again in the same transaction.
create or replace function public.pf_delete_client_row_with_lease(
  p_client_id text, p_coach_id uuid, p_lease_id uuid
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_deleted integer;
begin
  if not exists (
    select 1 from private.client_deletion_leases l
    join private.client_deletion_jobs j on j.client_id=l.client_id
    join public.profiles p on p.id=j.coach_id
    where l.client_id=p_client_id and l.lease_id=p_lease_id
      and l.expires_at>pg_catalog.clock_timestamp()
      and j.coach_id=p_coach_id and j.status='auth_disabled'
      and p.role='coach'
  ) then
    raise exception 'Deletion lease or ownership invalid' using errcode='42501';
  end if;
  delete from public.clients where id=p_client_id and coach_id=p_coach_id;
  get diagnostics v_deleted = row_count;
  return v_deleted=1;
end;
$$;
revoke all on function public.pf_delete_client_row_with_lease(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.pf_delete_client_row_with_lease(text,uuid,uuid) to service_role;
revoke delete on public.clients from public,anon,authenticated;
