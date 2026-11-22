-- QA ONLY: missing business RPCs. No cron/Vault secret, no production data.

-- QA public referral form remains DISABLED: two public submit/lookup RPCs are service-role-only in QA.

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

REVOKE ALL ON FUNCTION public.my_referral_code() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.my_referral_code() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pf_list_trainers()
 RETURNS TABLE(email text, coach_id uuid, display_name text, verified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF NOT public.pf_head_coach() THEN RAISE EXCEPTION 'Head coach only' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT a.email,p.id,coalesce(p.display_name,''),u.email_confirmed_at IS NOT NULL
 FROM private.coach_allowlist a LEFT JOIN auth.users u ON lower(u.email)=a.email
 LEFT JOIN public.profiles p ON p.id=u.id AND p.role='coach'
 ORDER BY a.email;
END;$function$;

REVOKE ALL ON FUNCTION public.pf_list_trainers() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.pf_list_trainers() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pf_manage_trainer(p_action text, p_email text, p_client_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE addr text:=lower(trim(p_email));
BEGIN
  IF NOT public.pf_head_coach() THEN RAISE EXCEPTION 'Head coach only' USING ERRCODE='42501'; END IF;
  IF p_action IS DISTINCT FROM 'invite' THEN
    RAISE EXCEPTION 'Client assignments are automatic and cannot be transferred' USING ERRCODE='42501';
  END IF;
  IF addr !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(addr)>254 THEN
    RAISE EXCEPTION 'Invalid email' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.coach_allowlist(email) VALUES(addr) ON CONFLICT DO NOTHING;
  RETURN true;
END;$function$;

REVOKE ALL ON FUNCTION public.pf_manage_trainer(p_action text, p_email text, p_client_id text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.pf_manage_trainer(p_action text, p_email text, p_client_id text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pf_publish_posture_review(p_client_id text, p_assessment_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE doc jsonb; clean jsonb; chosen jsonb;
BEGIN
 IF NOT private.can_manage_client(p_client_id) THEN RAISE EXCEPTION 'Not assigned' USING ERRCODE='42501'; END IF;
 IF p_assessment_id IS NULL OR p_assessment_id NOT LIKE 'as-%' OR NOT EXISTS (
   SELECT 1 FROM public.clients c, jsonb_array_elements(coalesce(c.data->'assessments','[]'::jsonb)) a
   WHERE c.id=p_client_id AND a->>'id'=p_assessment_id) THEN
   RAISE EXCEPTION 'Save dated assessment first'; END IF;
 SELECT data INTO doc FROM public.posture_reviews_secure WHERE client_id=p_client_id AND assessment_id='draft';
 IF doc IS NULL OR doc->>'summaryApprovedByCoach' <> 'true' OR trim(coalesce(doc->>'summary',''))='' THEN
  RAISE EXCEPTION 'Coach-approved summary required'; END IF;
 INSERT INTO public.posture_reviews_secure(client_id,assessment_id,data)
 VALUES(p_client_id,p_assessment_id,doc) ON CONFLICT DO NOTHING;
 SELECT data INTO chosen FROM public.posture_reviews_secure WHERE client_id=p_client_id AND assessment_id=p_assessment_id;
 IF chosen->>'summaryApprovedByCoach' <> 'true' THEN RAISE EXCEPTION 'Historical snapshot is not approved'; END IF;
 -- Explicit client whitelist. NEVER include private interpretation, conflicts, reviewer notes, rule internals.
 SELECT coalesce(jsonb_agg(o),'[]'::jsonb) INTO clean FROM jsonb_array_elements(coalesce(chosen->'observations','[]'::jsonb)) o
 WHERE o->>'confirmed'='true';
 INSERT INTO public.posture_public_reports(client_id,assessment_id,data)
 VALUES(p_client_id,p_assessment_id,jsonb_build_object(
  'recordedAt',chosen->>'recordedAt','measurements',coalesce(chosen->'measurements','[]'::jsonb),
  'observations',clean,'summary',chosen->>'summary','summaryApprovedByCoach',true,
  'visualSettings',coalesce(chosen->'visualSettings','{}'::jsonb))) ON CONFLICT DO NOTHING;
 RETURN true;
END;$function$;

REVOKE ALL ON FUNCTION public.pf_publish_posture_review(p_client_id text, p_assessment_id text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.pf_publish_posture_review(p_client_id text, p_assessment_id text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pf_save_food_entry(p_client_id text, p_existing_id uuid, p_date date, p_description text, p_key uuid, p_status text, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE eid uuid; item jsonb;
BEGIN
 IF auth.uid() IS NULL OR p_client_id IS DISTINCT FROM private.my_client_id() THEN
  RAISE EXCEPTION 'Own food records only' USING ERRCODE='42501'; END IF;
 IF p_date IS NULL OR p_date > current_date + 1 OR p_description IS NULL OR length(trim(p_description)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'Invalid entry' USING ERRCODE='22023'; END IF;
 IF p_status NOT IN ('estimate','confirmed','incomplete') OR jsonb_typeof(p_items)<>'array' OR
   jsonb_array_length(p_items) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Invalid meal items'; END IF;
 IF p_existing_id IS NOT NULL THEN
   SELECT id INTO eid FROM public.food_entries WHERE id=p_existing_id AND client_id=p_client_id FOR UPDATE;
   IF eid IS NULL THEN RAISE EXCEPTION 'Meal not found or access denied' USING ERRCODE='42501'; END IF;
 ELSE
   SELECT id INTO eid FROM public.food_entries WHERE client_id=p_client_id AND idempotency_key=p_key FOR UPDATE;
 END IF;
 IF eid IS NULL THEN
   INSERT INTO public.food_entries(client_id,date,description,idempotency_key,status)
     VALUES(p_client_id,p_date,trim(p_description),p_key,p_status) RETURNING id INTO eid;
 ELSE
   UPDATE public.food_entries SET date=p_date,description=trim(p_description),status=p_status WHERE id=eid;
 END IF;
 DELETE FROM public.food_items WHERE entry_id=eid AND client_id=p_client_id;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
   IF length(trim(coalesce(item->>'name',''))) NOT BETWEEN 1 AND 200
      OR coalesce((item->>'quantity')::numeric,0) <= 0 THEN RAISE EXCEPTION 'Invalid food'; END IF;
   INSERT INTO public.food_items(entry_id,client_id,name,quantity,unit,grams,state,kcal,protein,source,"sourceId",assumptions,version,"kcalPerGram","proteinPerGram")
   VALUES(eid,p_client_id,trim(item->>'name'),(item->>'quantity')::numeric,item->>'unit',
     NULLIF(item->>'grams','')::numeric,coalesce(item->>'state','unknown'),
     NULLIF(item->>'kcal','')::numeric,NULLIF(item->>'protein','')::numeric,
     coalesce(item->>'source','manual'),item->>'sourceId',coalesce(item->>'assumptions',''),
     coalesce(item->>'version','food-v1'),NULLIF(item->>'kcalPerGram','')::numeric,NULLIF(item->>'proteinPerGram','')::numeric);
 END LOOP;
 RETURN eid;
END;$function$;

REVOKE ALL ON FUNCTION public.pf_save_food_entry(p_client_id text, p_existing_id uuid, p_date date, p_description text, p_key uuid, p_status text, p_items jsonb) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.pf_save_food_entry(p_client_id text, p_existing_id uuid, p_date date, p_description text, p_key uuid, p_status text, p_items jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.referral_credit_amount()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(nullif(value, '')::numeric, 0) from private.settings where key = 'referral_credit';
$function$;

REVOKE ALL ON FUNCTION public.referral_credit_amount() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.referral_credit_amount() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.referral_inviter(p_code text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select split_part(coalesce(c.data->>'name', ''), ' ', 1)
  from public.referral_codes r join public.clients c on c.id = r.client_id
  where r.code = lower(trim(p_code));
$function$;

REVOKE ALL ON FUNCTION public.referral_inviter(p_code text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.referral_inviter(p_code text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_referral_status(p_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE amount numeric; cid text;
BEGIN
 SELECT referrer_client_id INTO cid FROM public.referrals WHERE id=p_id;
 IF cid IS NULL OR NOT private.can_manage_client(cid) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN ('invited','signed_up','paying','declined') THEN
  RAISE EXCEPTION 'Unknown status' USING ERRCODE='22023'; END IF;
 SELECT coalesce(nullif(value,'')::numeric,0) INTO amount FROM private.settings WHERE key='referral_credit';
 UPDATE public.referrals SET status=p_status,
  credit=CASE WHEN p_status='paying' THEN CASE WHEN credit>0 THEN credit ELSE coalesce(amount,0) END ELSE 0 END,
  updated_at=now() WHERE id=p_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_referral_status(p_id uuid, p_status text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.set_referral_status(p_id uuid, p_status text) TO authenticated,service_role;

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

REVOKE ALL ON FUNCTION public.submit_referral(p_code text, p_name text, p_email text, p_location text, p_note text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.submit_referral(p_code text, p_name text, p_email text, p_location text, p_note text) TO service_role;
