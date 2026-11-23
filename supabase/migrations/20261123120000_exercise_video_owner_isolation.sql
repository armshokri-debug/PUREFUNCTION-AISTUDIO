-- Pure Function: isolate coach-authored exercises and their uploaded media.
-- Apply in QA first; do not run in Production without a reviewed deployment window.
-- Existing public catalog JSON is unaffected. Legacy ownerless rows remain readable,
-- but cannot be edited/deleted until ownership is explicitly reconciled.
ALTER TABLE public.exercises
  ADD COLUMN IF NOT EXISTS owner_id uuid;

ALTER TABLE public.exercises
  ALTER COLUMN owner_id SET DEFAULT auth.uid();

-- The trusted owner is the DB column, not a JSON key supplied by the browser.
DROP POLICY IF EXISTS "exercises insert" ON public.exercises;
CREATE POLICY "exercises insert" ON public.exercises
  FOR INSERT TO authenticated
  WITH CHECK (private.is_coach() AND owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "exercises update" ON public.exercises;
CREATE POLICY "exercises update" ON public.exercises
  FOR UPDATE TO authenticated
  USING (private.is_coach() AND owner_id = (SELECT auth.uid()))
  WITH CHECK (private.is_coach() AND owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "exercises delete" ON public.exercises;
CREATE POLICY "exercises delete" ON public.exercises
  FOR DELETE TO authenticated
  USING (private.is_coach() AND owner_id = (SELECT auth.uid()));

-- Keep "exercises read" unchanged: coaches and signed-in clients still use
-- the shared library for workout display and planning.

-- New uploads must use <coach-uid>/<exercise-id>/<unique-file> paths.
-- The first folder segment is checked on the server; the client never grants
-- itself permissions by choosing an arbitrary path.
DROP POLICY IF EXISTS "exercise videos upload" ON storage.objects;
CREATE POLICY "exercise videos upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'exercise-videos'
    AND private.is_coach()
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "exercise videos update" ON storage.objects;
CREATE POLICY "exercise videos update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'exercise-videos'
    AND private.is_coach()
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'exercise-videos'
    AND private.is_coach()
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "exercise videos delete" ON storage.objects;
CREATE POLICY "exercise videos delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'exercise-videos'
    AND private.is_coach()
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- "exercise videos read" remains unchanged: training media is shared read-only.
-- The other three private Storage buckets are unchanged.
