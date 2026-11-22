-- QA ONLY: six missing indexes on existing QA tables, definition parity with Production.

CREATE INDEX clients_basic_coach_idx ON public.clients USING btree (coach_id);

CREATE UNIQUE INDEX clients_basic_unique_email ON public.clients USING btree (lower(email)) WHERE (email <> ''::text);

CREATE INDEX clients_email_idx ON public.clients USING btree (lower(email));

CREATE INDEX profiles_client_id_idx ON public.profiles USING btree (client_id);

CREATE INDEX program_templates_owner_created_idx ON public.program_templates USING btree (owner_id, created_at DESC);

CREATE INDEX workouts_client_date_idx ON public.workouts USING btree (client_id, date);
