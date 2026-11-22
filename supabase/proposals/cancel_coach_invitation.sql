-- PROPOSAL ONLY: REVIEW AND TEST IN QA BEFORE PRODUCTION.
-- Cancels an unused coach invitation grant without deleting Auth users, profiles,
-- clients, workouts, or any other data. Must be applied BEFORE deploying the
-- frontend "Cancel invitation" action. Never allow automatic role promotion.
CREATE OR REPLACE FUNCTION public.pf_cancel_trainer_invite(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  addr text := lower(btrim(p_email));
  removed boolean;
BEGIN
  IF NOT public.pf_head_coach() THEN
    RAISE EXCEPTION 'Head coach only' USING ERRCODE = '42501';
  END IF;
  IF addr IS NULL OR addr = '' THEN
    RAISE EXCEPTION 'Invalid email' USING ERRCODE = '22023';
  END IF;

  -- Never revoke access for the head coach or any account whose profile is coach.
  IF EXISTS (
    SELECT 1 FROM private.settings s
    WHERE s.key = 'coach_email' AND lower(s.value) = addr
  ) OR EXISTS (
    SELECT 1 FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
    WHERE lower(u.email) = addr AND p.role = 'coach'
  ) THEN
    RAISE EXCEPTION 'An existing coach account cannot be cancelled as an invitation'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM private.coach_allowlist WHERE email = addr;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

REVOKE ALL ON FUNCTION public.pf_cancel_trainer_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pf_cancel_trainer_invite(text) TO authenticated;
