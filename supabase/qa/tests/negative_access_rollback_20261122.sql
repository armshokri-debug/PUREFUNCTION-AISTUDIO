-- QA-only security regression checks. No persistent writes; all operations are rolled back.
-- Target: nsshdxxdvzzxlmdomixf (QA). Never run this in Production.
-- Run with a QA database owner role capable of SET ROLE authenticated.
BEGIN;
DO $safety$
BEGIN
  IF to_regclass('private.qa_mail_outbox') IS NULL THEN
    RAISE EXCEPTION 'Refusing to run: QA mail-sink marker absent';
  END IF;
END $safety$;

CREATE TEMP TABLE qa_negative_cases(test_name text NOT NULL, outcome text NOT NULL, code text) ON COMMIT DROP;
GRANT INSERT, SELECT ON qa_negative_cases TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-202611220001","role":"authenticated","user_metadata":{"role":"coach"},"app_metadata":{"role":"coach"}}',
  true
);

DO $cases$
BEGIN
  BEGIN
    INSERT INTO public.clients (id,email,data,coach_id)
      VALUES ('qa-never-created-client-20261122','qa-never-created@qa.invalid','{"name":"Synthetic"}'::jsonb,auth.uid());
    INSERT INTO qa_negative_cases VALUES ('forge_client_insert','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_client_insert','DENIED',SQLSTATE); END;

  BEGIN
    INSERT INTO public.exercises(id,data)
      VALUES ('qa-never-created-exercise-20261122','{"name":"Synthetic"}'::jsonb);
    INSERT INTO qa_negative_cases VALUES ('forge_exercise_insert','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_exercise_insert','DENIED',SQLSTATE); END;

  BEGIN
    INSERT INTO public.coach_notes_secure(id,client_id,date,text,shared)
      VALUES ('qa-never-created-note-20261122','qa-never-created-client-20261122','2026-11-22','Synthetic note',false);
    INSERT INTO qa_negative_cases VALUES ('forge_private_note_insert','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_private_note_insert','DENIED',SQLSTATE); END;

  BEGIN
    UPDATE public.program_templates SET data='{"tampered":true}'::jsonb
      WHERE id='qa-never-created-template-20261122';
    INSERT INTO qa_negative_cases VALUES ('direct_template_edit','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('direct_template_edit','DENIED',SQLSTATE); END;

  BEGIN
    PERFORM public.pf_manage_trainer('invite','qa-never-created-trainer@qa.invalid',NULL);
    INSERT INTO qa_negative_cases VALUES ('forge_head_coach_rpc','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_head_coach_rpc','DENIED',SQLSTATE); END;

  BEGIN
    PERFORM public.pf_update_program_template('qa-never-created-template-20261122','{"tampered":true}'::jsonb,'{}'::jsonb);
    INSERT INTO qa_negative_cases VALUES ('forge_template_rpc','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_template_rpc','DENIED',SQLSTATE); END;

  BEGIN
    PERFORM public.save_workout_results_secure(
      'qa-never-created-workout-20261122','qa-never-created-client-20261122',
      '2026-11-22T00:00:00Z'::timestamptz,'{"status":"complete"}'::jsonb
    );
    INSERT INTO qa_negative_cases VALUES ('forge_workout_results_rpc','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_workout_results_rpc','DENIED',SQLSTATE); END;

  BEGIN
    INSERT INTO storage.objects(bucket_id,name)
      VALUES ('client-videos','qa-never-created-client-20261122/forbidden.txt');
    INSERT INTO qa_negative_cases VALUES ('forge_storage_upload','UNEXPECTED_ALLOWED','');
  EXCEPTION WHEN others THEN INSERT INTO qa_negative_cases VALUES ('forge_storage_upload','DENIED',SQLSTATE); END;
END $cases$;
RESET ROLE;

-- Run fails closed on an unexpected grant, allowed write, or non-permission error.
DO $verify$
BEGIN
  IF (SELECT count(*) FROM qa_negative_cases) <> 8
     OR EXISTS (SELECT 1 FROM qa_negative_cases WHERE outcome <> 'DENIED' OR code <> '42501') THEN
    RAISE EXCEPTION 'QA permission regression: 8 expected 42501 denials';
  END IF;
END $verify$;

SELECT test_name, outcome, code FROM qa_negative_cases ORDER BY test_name;
ROLLBACK;
