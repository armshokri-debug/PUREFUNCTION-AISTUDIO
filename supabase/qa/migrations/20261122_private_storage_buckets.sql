-- QA ONLY: empty private storage buckets; metadata sourced read-only from Production.
-- No storage objects or user files copied. All buckets are private.
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types,avif_autodetection)
VALUES
  ('client-videos','client-videos',false,52428800,ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v']::text[],false),
  ('exercise-videos','exercise-videos',false,52428800,ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v']::text[],false),
  ('inbody-printouts','inbody-printouts',false,10485760,ARRAY['image/jpeg','image/png','image/webp','application/pdf']::text[],false),
  ('message-media','message-media',false,52428800,NULL,false);
