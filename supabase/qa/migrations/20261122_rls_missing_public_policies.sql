-- QA-only policies copied from read-only Production metadata. No Production data.

-- Preserve legacy messages table as deny-all in QA: never grant legacy message writes.

SET LOCAL search_path = public,pg_catalog;

CREATE FUNCTION private.has_profile() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $body$
SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid());
$body$;

REVOKE ALL ON FUNCTION private.has_profile() FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION private.has_profile() TO authenticated;

CREATE POLICY "assignment own read" ON public."coach_client_assignments" AS PERMISSIVE FOR SELECT TO authenticated USING ((coach_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "coach messages scoped insert" ON public."coach_messages" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((private.can_manage_client(client_id) AND from_coach) OR ((client_id = private.my_client_id()) AND (NOT from_coach))));

CREATE POLICY "coach messages scoped read" ON public."coach_messages" AS PERMISSIVE FOR SELECT TO authenticated USING ((private.can_manage_client(client_id) OR (client_id = private.my_client_id())));

CREATE POLICY "coach messages scoped update" ON public."coach_messages" AS PERMISSIVE FOR UPDATE TO authenticated USING (((private.can_manage_client(client_id) AND (NOT from_coach)) OR ((client_id = private.my_client_id()) AND from_coach))) WITH CHECK (((private.can_manage_client(client_id) AND (NOT from_coach)) OR ((client_id = private.my_client_id()) AND from_coach)));

CREATE POLICY "notes coach delete" ON public."coach_notes_secure" AS PERMISSIVE FOR DELETE TO authenticated USING (private.can_manage_client(client_id));

CREATE POLICY "notes coach insert" ON public."coach_notes_secure" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (private.can_manage_client(client_id));

CREATE POLICY "notes coach update" ON public."coach_notes_secure" AS PERMISSIVE FOR UPDATE TO authenticated USING (private.can_manage_client(client_id)) WITH CHECK (private.can_manage_client(client_id));

CREATE POLICY "notes scoped read" ON public."coach_notes_secure" AS PERMISSIVE FOR SELECT TO authenticated USING ((private.can_manage_client(client_id) OR (shared AND (client_id = private.my_client_id()))));

CREATE POLICY "redemptions scoped delete" ON public."credit_redemptions" AS PERMISSIVE FOR DELETE TO authenticated USING (private.can_manage_client(client_id));

CREATE POLICY "redemptions scoped insert" ON public."credit_redemptions" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (private.can_manage_client(client_id));

CREATE POLICY "redemptions scoped read" ON public."credit_redemptions" AS PERMISSIVE FOR SELECT TO authenticated USING ((private.can_manage_client(client_id) OR (client_id = private.my_client_id())));

CREATE POLICY "exercises delete" ON public."exercises" AS PERMISSIVE FOR DELETE TO authenticated USING (( SELECT private.is_coach() AS is_coach));

CREATE POLICY "exercises insert" ON public."exercises" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (( SELECT private.is_coach() AS is_coach));

CREATE POLICY "exercises read" ON public."exercises" AS PERMISSIVE FOR SELECT TO authenticated USING (( SELECT private.has_profile() AS has_profile));

CREATE POLICY "exercises update" ON public."exercises" AS PERMISSIVE FOR UPDATE TO authenticated USING (( SELECT private.is_coach() AS is_coach)) WITH CHECK (( SELECT private.is_coach() AS is_coach));

CREATE POLICY "favorite_meals_client_delete" ON public."favorite_meals" AS PERMISSIVE FOR DELETE TO authenticated USING ((client_id = private.my_client_id()));

CREATE POLICY "favorite_meals_client_insert" ON public."favorite_meals" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((client_id = private.my_client_id()));

CREATE POLICY "favorite_meals_read" ON public."favorite_meals" AS PERMISSIVE FOR SELECT TO authenticated USING (((client_id = private.my_client_id()) OR private.can_manage_client(client_id)));

CREATE POLICY "food_entries_client_delete" ON public."food_entries" AS PERMISSIVE FOR DELETE TO authenticated USING ((client_id = private.my_client_id()));

CREATE POLICY "food_entries_read" ON public."food_entries" AS PERMISSIVE FOR SELECT TO authenticated USING (((client_id = private.my_client_id()) OR private.can_manage_client(client_id)));

CREATE POLICY "food_items_read" ON public."food_items" AS PERMISSIVE FOR SELECT TO authenticated USING (((client_id = private.my_client_id()) OR private.can_manage_client(client_id)));

CREATE POLICY "posture_public_read" ON public."posture_public_reports" AS PERMISSIVE FOR SELECT TO authenticated USING (((client_id = private.my_client_id()) OR private.can_manage_client(client_id)));

CREATE POLICY "posture_review_coach_edit" ON public."posture_reviews_secure" AS PERMISSIVE FOR UPDATE TO authenticated USING ((private.can_manage_client(client_id) AND (assessment_id = 'draft'::text))) WITH CHECK ((private.can_manage_client(client_id) AND (assessment_id = 'draft'::text)));

CREATE POLICY "posture_review_coach_insert" ON public."posture_reviews_secure" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((private.can_manage_client(client_id) AND (assessment_id = 'draft'::text)));

CREATE POLICY "posture_review_coach_read" ON public."posture_reviews_secure" AS PERMISSIVE FOR SELECT TO authenticated USING (private.can_manage_client(client_id));

CREATE POLICY "referral codes scoped read" ON public."referral_codes" AS PERMISSIVE FOR SELECT TO authenticated USING ((private.can_manage_client(client_id) OR (client_id = private.my_client_id())));

CREATE POLICY "referrals scoped delete" ON public."referrals" AS PERMISSIVE FOR DELETE TO authenticated USING (private.can_manage_client(referrer_client_id));

CREATE POLICY "referrals scoped read" ON public."referrals" AS PERMISSIVE FOR SELECT TO authenticated USING ((private.can_manage_client(referrer_client_id) OR (referrer_client_id = private.my_client_id())));

CREATE POLICY "referrals scoped update" ON public."referrals" AS PERMISSIVE FOR UPDATE TO authenticated USING (private.can_manage_client(referrer_client_id)) WITH CHECK (private.can_manage_client(referrer_client_id));

GRANT SELECT ON TABLE public."coach_client_assignments" TO authenticated;

GRANT INSERT, SELECT, UPDATE ON TABLE public."coach_messages" TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public."coach_notes_secure" TO authenticated;

GRANT DELETE, INSERT, SELECT ON TABLE public."credit_redemptions" TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE public."exercises" TO authenticated;

GRANT DELETE, INSERT, SELECT ON TABLE public."favorite_meals" TO authenticated;

GRANT DELETE, SELECT ON TABLE public."food_entries" TO authenticated;

GRANT SELECT ON TABLE public."food_items" TO authenticated;

GRANT SELECT ON TABLE public."posture_public_reports" TO authenticated;

GRANT INSERT, SELECT, UPDATE ON TABLE public."posture_reviews_secure" TO authenticated;

GRANT SELECT ON TABLE public."referral_codes" TO authenticated;

GRANT DELETE, SELECT, UPDATE ON TABLE public."referrals" TO authenticated;
