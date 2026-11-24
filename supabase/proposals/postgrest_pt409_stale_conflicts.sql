-- Reviewed, manually-applied proposal. Not auto-deployed.
-- PostgreSQL 40001 means serialization_failure and triggers indefinite
-- PostgREST 14 transaction retries for deterministic version conflicts.
-- PT409 produces HTTP 409 without changing the logical ownership/version checks.
--
-- Guarded CREATE OR REPLACE preserves the existing function owner, ACL,
-- SECURITY DEFINER, search_path, arguments and all non-conflict SQL.
-- Deliberately fail closed on source drift. Review QA evidence before Production.

DO $safe_conflict$
DECLARE
  item record;
  fn regprocedure;
  ddl_before text;
  ddl_after text;
  seen integer;
  original_owner oid;
  original_acl aclitem[];
  original_security_definer boolean;
  original_config text[];
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      (
        'public.save_workout_results_secure(text,text,timestamp with time zone,jsonb)',
        'RAISE EXCEPTION ''VERSION_CONFLICT'' USING ERRCODE=''40001'';',
        'RAISE SQLSTATE ''PT409'' USING MESSAGE=''VERSION_CONFLICT'';',
        1
      ),
      (
        'public.pf_update_program_template(text,jsonb,jsonb)',
        'USING ERRCODE = ''40001'';',
        'USING ERRCODE = ''PT409'';',
        2
      )
    ) AS v(signature, old_fragment, new_fragment, expected_count)
  LOOP
    fn := to_regprocedure(item.signature);
    IF fn IS NULL THEN
      RAISE EXCEPTION 'BLOCKED: required conflict-protected function is missing: %', item.signature;
    END IF;
    SELECT pg_get_functiondef(fn), proowner, proacl, prosecdef, proconfig
      INTO ddl_before, original_owner, original_acl, original_security_definer, original_config
      FROM pg_proc WHERE oid=fn;
    IF NOT original_security_definer OR NOT ('search_path=""' = ANY(original_config)) THEN
      RAISE EXCEPTION 'BLOCKED: expected function security metadata drift: %', item.signature;
    END IF;
    seen := (length(ddl_before)-length(replace(ddl_before,item.old_fragment,'')))
      / length(item.old_fragment);
    IF seen <> item.expected_count OR position(item.new_fragment IN ddl_before) > 0 THEN
      RAISE EXCEPTION 'BLOCKED: unexpected conflict handler source: %', item.signature;
    END IF;
    EXECUTE replace(ddl_before,item.old_fragment,item.new_fragment);
    SELECT pg_get_functiondef(fn) INTO ddl_after;
    IF position(item.old_fragment IN ddl_after) > 0 OR
       (length(ddl_after)-length(replace(ddl_after,item.new_fragment,'')))
         /length(item.new_fragment) <> item.expected_count THEN
      RAISE EXCEPTION 'BLOCKED: post-change conflict handler verification failed: %', item.signature;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=fn AND
      (proowner IS DISTINCT FROM original_owner OR
       proacl IS DISTINCT FROM original_acl OR
       prosecdef IS DISTINCT FROM original_security_definer OR
       proconfig IS DISTINCT FROM original_config)) THEN
      RAISE EXCEPTION 'BLOCKED: security metadata changed unexpectedly: %', item.signature;
    END IF;
  END LOOP;
END
$safe_conflict$;
