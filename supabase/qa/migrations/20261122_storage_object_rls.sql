-- QA ONLY: storage object access policies from Production metadata (no objects copied).

-- No bucket is public. Never run on Production.

CREATE POLICY "client videos scoped delete" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'client-videos'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "client videos scoped read" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'client-videos'::text) AND (private.can_manage_client((storage.foldername(name))[1]) OR ((storage.foldername(name))[1] = private.my_client_id()))));

CREATE POLICY "client videos scoped update" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'client-videos'::text) AND private.can_manage_client((storage.foldername(name))[1]))) WITH CHECK (((bucket_id = 'client-videos'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "client videos scoped upload" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'client-videos'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "exercise videos delete" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'exercise-videos'::text) AND ( SELECT private.is_coach() AS is_coach)));

CREATE POLICY "exercise videos read" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'exercise-videos'::text) AND ( SELECT private.has_profile() AS has_profile)));

CREATE POLICY "exercise videos update" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'exercise-videos'::text) AND ( SELECT private.is_coach() AS is_coach))) WITH CHECK (((bucket_id = 'exercise-videos'::text) AND ( SELECT private.is_coach() AS is_coach)));

CREATE POLICY "exercise videos upload" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'exercise-videos'::text) AND ( SELECT private.is_coach() AS is_coach)));

CREATE POLICY "inbody scoped delete" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'inbody-printouts'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "inbody scoped read" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'inbody-printouts'::text) AND (private.can_manage_client((storage.foldername(name))[1]) OR ((storage.foldername(name))[1] = private.my_client_id()))));

CREATE POLICY "inbody scoped update" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'inbody-printouts'::text) AND private.can_manage_client((storage.foldername(name))[1]))) WITH CHECK (((bucket_id = 'inbody-printouts'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "inbody scoped upload" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'inbody-printouts'::text) AND private.can_manage_client((storage.foldername(name))[1])));

CREATE POLICY "message media scoped read" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'message-media'::text) AND (private.can_manage_client((storage.foldername(name))[1]) OR ((storage.foldername(name))[1] = private.my_client_id()))));

CREATE POLICY "message media scoped upload" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'message-media'::text) AND (private.can_manage_client((storage.foldername(name))[1]) OR ((storage.foldername(name))[1] = private.my_client_id()))));
