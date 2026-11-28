-- QA-first durable request budget. Fixed UTC hour windows; no raw subject stored.
create table if not exists private.pf_api_budgets (
 scope text not null,
 subject_digest text not null,
 hour_start bigint not null,
 attempts integer not null check (attempts > 0),
 last_attempt timestamptz not null,
 primary key (scope,subject_digest,hour_start)
);
alter table private.pf_api_budgets enable row level security;
revoke all on private.pf_api_budgets from public,anon,authenticated;
create index if not exists pf_api_budgets_hour_idx on private.pf_api_budgets(hour_start);
create or replace function public.pf_reserve_api_budget(p_scope text,p_subject text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
 v_subject text;
 v_now timestamptz;
 v_hour bigint;
 v_max integer;
 v_global integer;
 v_cooldown integer;
 v_count integer;
 v_last timestamptz;
 v_total integer;
begin
 case p_scope
  when 'password_reset' then v_max:=3; v_global:=100; v_cooldown:=60;
  when 'signup' then v_max:=5; v_global:=100; v_cooldown:=30;
  when 'client_invite' then v_max:=4; v_global:=100; v_cooldown:=60;
  when 'trainer_invite' then v_max:=4; v_global:=50; v_cooldown:=60;
  when 'food_parse' then v_max:=10; v_global:=100; v_cooldown:=5;
  else return false;
 end case;
 if p_subject is null or char_length(p_subject) not between 1 and 512 then return false; end if;
 v_subject := encode(pg_catalog.sha256(pg_catalog.convert_to(p_scope || ':' || p_subject,'UTF8')),'hex');
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pf_api_budget:'||p_scope,0));
 v_now := pg_catalog.clock_timestamp();
 v_hour := floor(extract(epoch from v_now)/3600)::bigint;
 select attempts into v_total from private.pf_api_budgets where scope=p_scope and subject_digest='global' and hour_start=v_hour;
 if coalesce(v_total,0)>=v_global then return false; end if;
 select attempts into v_count from private.pf_api_budgets where scope=p_scope and subject_digest=v_subject and hour_start=v_hour;
 if coalesce(v_count,0)>=v_max then return false; end if;
 select max(last_attempt) into v_last from private.pf_api_budgets where scope=p_scope and subject_digest=v_subject and hour_start>=v_hour-1;
 if v_last is not null and v_now-v_last<pg_catalog.make_interval(secs=>v_cooldown) then return false; end if;
 insert into private.pf_api_budgets(scope,subject_digest,hour_start,attempts,last_attempt)
 values(p_scope,v_subject,v_hour,1,v_now),(p_scope,'global',v_hour,1,v_now)
 on conflict(scope,subject_digest,hour_start) do update set attempts=private.pf_api_budgets.attempts+1,last_attempt=excluded.last_attempt;
 if coalesce(v_total,0)=0 or coalesce(v_total,0)%32=0 then
   delete from private.pf_api_budgets where scope=p_scope and hour_start<v_hour-1;
 end if;
 return true;
end;
$$;
revoke all on function public.pf_reserve_api_budget(text,text) from public,anon,authenticated;
grant execute on function public.pf_reserve_api_budget(text,text) to service_role;
