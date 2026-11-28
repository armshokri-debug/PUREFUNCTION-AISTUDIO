-- Verified on QA: all confirmed synthetic users have identical visible client/template rows before and after. No production change.
alter policy "clients coach insert" on public.clients with check ((select private.basic_is_coach()) and coach_id=(select auth.uid()));
alter policy "clients scoped read" on public.clients using (((select private.basic_is_coach()) and coach_id=(select auth.uid())) or id=(select private.my_client_id()));
alter policy "coach templates read" on public.program_templates using ((select private.is_coach()) and owner_id=(select auth.uid()));
alter policy "coach templates insert" on public.program_templates with check ((select private.is_coach()) and owner_id=(select auth.uid()));
alter policy "coach templates delete" on public.program_templates using ((select private.is_coach()) and owner_id=(select auth.uid()));
