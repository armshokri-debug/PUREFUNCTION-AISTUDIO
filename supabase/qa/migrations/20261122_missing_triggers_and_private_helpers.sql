-- QA ONLY: trigger parity extracted from read-only production pg_catalog (zero user data).

SET LOCAL search_path=public,pg_catalog;

CREATE OR REPLACE FUNCTION private.assign_new_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF new.coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Client owner mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.coach_client_assignments(coach_id,client_id)
    VALUES(new.coach_id,new.id);
  RETURN new;
END;$function$;

REVOKE ALL ON FUNCTION private.assign_new_client() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.basic_owner_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF new.coach_id IS DISTINCT FROM old.coach_id THEN
    RAISE EXCEPTION 'Client owner is immutable' USING ERRCODE='42501';
  END IF;
  RETURN new;
END;$function$;

REVOKE ALL ON FUNCTION private.basic_owner_immutable() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.basic_set_client_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT private.basic_is_coach() THEN RAISE EXCEPTION 'Verified coach required' USING ERRCODE='42501'; END IF;
  IF new.coach_id IS NOT NULL AND new.coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot create a client for another coach' USING ERRCODE='42501';
  END IF;
  new.coach_id := auth.uid();
  RETURN new;
END;$function$;

REVOKE ALL ON FUNCTION private.basic_set_client_owner() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.email_key(e text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when split_part(lower(trim(e)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(lower(trim(e)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else lower(trim(e))
  end;
$function$;

REVOKE ALL ON FUNCTION private.email_key(text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_client_data()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE old_safe jsonb; new_safe jsonb;
        old_coach jsonb; new_coach jsonb; rec jsonb;
        new_records jsonb;
BEGIN
 IF NOT private.can_manage_client(old.id) THEN
  IF new.email IS DISTINCT FROM old.email OR new.id IS DISTINCT FROM old.id THEN
    RAISE EXCEPTION 'Client identity is coach-owned' USING ERRCODE='42501';
  END IF;
  old_safe := old.data - 'photoUrl' - 'nutrition' - 'manualRecords';
  new_safe := new.data - 'photoUrl' - 'nutrition' - 'manualRecords';
  IF old_safe IS DISTINCT FROM new_safe OR
    (coalesce(old.data->'nutrition','{}'::jsonb) - 'log') IS DISTINCT FROM
    (coalesce(new.data->'nutrition','{}'::jsonb) - 'log') THEN
   RAISE EXCEPTION 'Coach-owned profile or assessment cannot be changed' USING ERRCODE='42501';
  END IF;
  IF (new.data ? 'manualRecords') AND
     jsonb_typeof(new.data->'manualRecords') <> 'array' THEN
   RAISE EXCEPTION 'Invalid manual records' USING ERRCODE='22023';
  END IF;
  new_records := CASE WHEN jsonb_typeof(new.data->'manualRecords')='array'
                      THEN new.data->'manualRecords' ELSE '[]'::jsonb END;
  IF jsonb_array_length(new_records) > 500 THEN
   RAISE EXCEPTION 'Too many manual records' USING ERRCODE='22023';
  END IF;
  -- Coach-created records must survive unchanged, including attribution and IDs.
  SELECT coalesce(jsonb_agg(r.value ORDER BY r.value->>'id'),'[]'::jsonb)
   INTO old_coach FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(old.data->'manualRecords')='array'
         THEN old.data->'manualRecords' ELSE '[]'::jsonb END) r
   WHERE r.value->>'addedBy' IS DISTINCT FROM 'client';
  SELECT coalesce(jsonb_agg(r.value ORDER BY r.value->>'id'),'[]'::jsonb)
   INTO new_coach FROM jsonb_array_elements(new_records) r
   WHERE r.value->>'addedBy' IS DISTINCT FROM 'client';
  IF old_coach IS DISTINCT FROM new_coach THEN
   RAISE EXCEPTION 'Coach-created records cannot be edited or deleted' USING ERRCODE='42501';
  END IF;
  -- No duplicate IDs or malformed client records (prevents collisions with coach IDs).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(new_records) r
    WHERE jsonb_typeof(r.value) <> 'object' OR nullif(r.value->>'id','') IS NULL
       OR length(r.value->>'id') > 120) OR
     (SELECT count(*) FROM jsonb_array_elements(new_records)) <>
     (SELECT count(DISTINCT r.value->>'id') FROM jsonb_array_elements(new_records) r) THEN
   RAISE EXCEPTION 'Invalid or duplicate manual record IDs' USING ERRCODE='22023';
  END IF;
  FOR rec IN SELECT value FROM jsonb_array_elements(new_records)
    WHERE value->>'addedBy'='client' LOOP
   IF (rec - 'id' - 'exerciseId' - 'name' - 'kg' - 'reps' - 'date' - 'note' - 'addedBy') <> '{}'::jsonb
      OR jsonb_typeof(rec->'name') <> 'string' OR length(trim(rec->>'name')) NOT BETWEEN 1 AND 200
      OR jsonb_typeof(rec->'kg') <> 'number' OR (rec->>'kg')::numeric NOT BETWEEN 0 AND 10000
      OR jsonb_typeof(rec->'reps') <> 'number' OR (rec->>'reps')::numeric NOT BETWEEN 1 AND 100
      OR (rec->>'reps')::numeric <> trunc((rec->>'reps')::numeric)
      OR (rec ? 'date' AND (jsonb_typeof(rec->'date') <> 'string' OR rec->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
      OR (rec ? 'note' AND (jsonb_typeof(rec->'note') <> 'string' OR length(rec->>'note') > 2000))
      OR (rec ? 'exerciseId' AND (jsonb_typeof(rec->'exerciseId') <> 'string' OR length(rec->>'exerciseId') > 200)) THEN
    RAISE EXCEPTION 'Invalid client manual record' USING ERRCODE='22023';
   END IF;
  END LOOP;
 END IF;
 RETURN new;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_client_data() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_client_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.is_coach() and new.email is distinct from old.email then
    raise exception 'Only the coach can change a client''s email';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.guard_client_email() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_coach_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.body is distinct from old.body or new.client_id is distinct from old.client_id
     or new.from_coach is distinct from old.from_coach or new.attachment_path is distinct from old.attachment_path then
    raise exception 'Messages cannot be edited';
  end if;
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.guard_coach_message_update() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.body is distinct from old.body or new.sender is distinct from old.sender
     or new.client_id is distinct from old.client_id or new.created_at is distinct from old.created_at then
    raise exception 'Messages can''t be edited';
  end if;
  if new.read_at is distinct from old.read_at
     and ((old.sender = 'coach') = private.is_coach()) then
    raise exception 'Only the receiver marks a message read';
  end if;
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.guard_message_update() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_posture_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF old.assessment_id <> 'draft' THEN RAISE EXCEPTION 'Historical posture report is immutable'; END IF;
 RETURN new;
END;$function$;

REVOKE ALL ON FUNCTION private.guard_posture_frozen() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.on_client_email_set()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  u record;
begin
  if new.email <> '' then
    for u in select id, email from auth.users where private.email_key(email) = private.email_key(new.email) loop
      perform private.link_user(u.id, u.email, null);
    end loop;
  end if;
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.on_client_email_set() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.on_client_referral_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.email <> '' then
    update public.referrals
    set status = 'signed_up', referred_client_id = new.id, updated_at = now()
    where lower(email) = lower(new.email) and status = 'invited';
  end if;
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION private.on_client_referral_match() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.reject_inline_notes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF new.data ? 'coachNotes' THEN
  RAISE EXCEPTION 'Use coach_notes_secure; inline notes are forbidden' USING ERRCODE='42501';
 END IF;
 RETURN new;
END;
$function$;

REVOKE ALL ON FUNCTION private.reject_inline_notes() FROM PUBLIC, anon;

CREATE TRIGGER basic_owner_on_insert BEFORE INSERT ON public.clients FOR EACH ROW EXECUTE FUNCTION private.basic_set_client_owner();

CREATE TRIGGER basic_owner_on_update BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION private.basic_owner_immutable();

CREATE TRIGGER clients_guard BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION private.guard_client_email();

CREATE TRIGGER clients_link_after_write AFTER INSERT OR UPDATE OF email ON public.clients FOR EACH ROW EXECUTE FUNCTION private.on_client_email_set();

CREATE TRIGGER clients_referral_match AFTER INSERT OR UPDATE OF email ON public.clients FOR EACH ROW EXECUTE FUNCTION private.on_client_referral_match();

CREATE TRIGGER t8b_assign_new_client AFTER INSERT ON public.clients FOR EACH ROW EXECUTE FUNCTION private.assign_new_client();

CREATE TRIGGER t8b_guard_client_data BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION private.guard_client_data();

CREATE TRIGGER t8b_reject_inline_notes BEFORE INSERT OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION private.reject_inline_notes();

CREATE TRIGGER coach_messages_guard BEFORE UPDATE ON public.coach_messages FOR EACH ROW EXECUTE FUNCTION private.guard_coach_message_update();

CREATE TRIGGER exercises_touch BEFORE UPDATE ON public.exercises FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at();

CREATE TRIGGER messages_guard BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION private.guard_message_update();

CREATE TRIGGER posture_freeze_guard BEFORE DELETE OR UPDATE ON public.posture_reviews_secure FOR EACH ROW EXECUTE FUNCTION private.guard_posture_frozen();
