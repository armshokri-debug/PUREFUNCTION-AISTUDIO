-- Pure Function QA-only permission convergence. NEVER deploy to Production.

DO $qa_lock$ BEGIN IF to_regclass('private.qa_mail_outbox') IS NULL THEN RAISE EXCEPTION 'QA ONLY: marker missing'; END IF; END $qa_lock$;

REVOKE ALL ON FUNCTION private.basic_is_coach() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.basic_is_coach() TO authenticated;

REVOKE ALL ON FUNCTION private.can_manage_client(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.can_manage_client(text) TO authenticated;

REVOKE ALL ON FUNCTION private.can_see_profile(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.can_see_profile(uuid,text) TO authenticated;

REVOKE ALL ON FUNCTION private.is_coach() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.is_coach() TO authenticated;

REVOKE ALL ON FUNCTION private.my_client_id() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.my_client_id() TO authenticated;

REVOKE ALL ON FUNCTION private.touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
