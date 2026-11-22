-- QA-ONLY SOURCE FROM PRODUCTION METADATA, NO DATA OR SECRETS.

SET LOCAL search_path = public,pg_catalog;

CREATE TABLE public."coach_client_assignments" (
  "coach_id" uuid NOT NULL,
  "client_id" text NOT NULL,
  CONSTRAINT "coach_client_assignments_pkey" PRIMARY KEY (coach_id, client_id)
);

ALTER TABLE public."coach_client_assignments" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."coach_client_assignments" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."coach_client_assignments" TO service_role;

CREATE TABLE public."coach_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL,
  "from_coach" boolean NOT NULL,
  "body" text NOT NULL DEFAULT ''::text,
  "attachment_path" text,
  "attachment_type" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "read_at" timestamp with time zone,
  CONSTRAINT "coach_messages_attachment_type_check" CHECK ((attachment_type = ANY (ARRAY['image'::text, 'video'::text]))),
  CONSTRAINT "coach_messages_body_check" CHECK ((char_length(body) <= 4000)),
  CONSTRAINT "coach_messages_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."coach_messages" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."coach_messages" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."coach_messages" TO service_role;

CREATE TABLE public."coach_notes_secure" (
  "id" text NOT NULL,
  "client_id" text NOT NULL,
  "date" text NOT NULL DEFAULT ''::text,
  "text" text NOT NULL DEFAULT ''::text,
  "shared" boolean NOT NULL DEFAULT false,
  "pinned" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "coach_notes_secure_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."coach_notes_secure" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."coach_notes_secure" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."coach_notes_secure" TO service_role;

CREATE TABLE public."credit_redemptions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL,
  "amount" numeric(10,2) NOT NULL,
  "note" text NOT NULL DEFAULT ''::text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_redemptions_amount_check" CHECK ((amount > (0)::numeric)),
  CONSTRAINT "credit_redemptions_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."credit_redemptions" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."credit_redemptions" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."credit_redemptions" TO service_role;

CREATE TABLE public."exercises" (
  "id" text NOT NULL,
  "data" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "exercises_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."exercises" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."exercises" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."exercises" TO service_role;

CREATE TABLE public."favorite_meals" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL,
  "name" text NOT NULL,
  "items" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "favorite_meals_items_check" CHECK ((jsonb_typeof(items) = 'array'::text)),
  CONSTRAINT "favorite_meals_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 300))),
  CONSTRAINT "favorite_meals_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."favorite_meals" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."favorite_meals" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."favorite_meals" TO service_role;

CREATE TABLE public."food_entries" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL,
  "date" date NOT NULL,
  "description" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "food_entries_description_check" CHECK (((length(description) >= 1) AND (length(description) <= 2000))),
  CONSTRAINT "food_entries_status_check" CHECK ((status = ANY (ARRAY['estimate'::text, 'confirmed'::text, 'incomplete'::text]))),
  CONSTRAINT "food_entries_pkey" PRIMARY KEY (id),
  CONSTRAINT "food_entries_client_id_idempotency_key_key" UNIQUE (client_id, idempotency_key),
  CONSTRAINT "food_entries_id_client_id_key" UNIQUE (id, client_id)
);

ALTER TABLE public."food_entries" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."food_entries" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."food_entries" TO service_role;

CREATE TABLE public."food_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "entry_id" uuid NOT NULL,
  "client_id" text NOT NULL,
  "name" text NOT NULL,
  "quantity" numeric NOT NULL,
  "unit" text NOT NULL,
  "grams" numeric,
  "state" text NOT NULL,
  "kcal" numeric,
  "protein" numeric,
  "source" text NOT NULL,
  "sourceId" text,
  "assumptions" text NOT NULL DEFAULT ''::text,
  "version" text NOT NULL DEFAULT 'food-v1'::text,
  "kcalPerGram" numeric,
  "proteinPerGram" numeric,
  CONSTRAINT "food_items_grams_check" CHECK ((grams >= (0)::numeric)),
  CONSTRAINT "food_items_kcalPerGram_check" CHECK (("kcalPerGram" >= (0)::numeric)),
  CONSTRAINT "food_items_kcal_check" CHECK ((kcal >= (0)::numeric)),
  CONSTRAINT "food_items_name_check" CHECK (((length(name) >= 1) AND (length(name) <= 200))),
  CONSTRAINT "food_items_proteinPerGram_check" CHECK (("proteinPerGram" >= (0)::numeric)),
  CONSTRAINT "food_items_protein_check" CHECK ((protein >= (0)::numeric)),
  CONSTRAINT "food_items_quantity_check" CHECK (((quantity > (0)::numeric) AND (quantity < (100000)::numeric))),
  CONSTRAINT "food_items_source_check" CHECK ((source = ANY (ARRAY['label'::text, 'restaurant'::text, 'USDA'::text, 'generic'::text, 'manual'::text]))),
  CONSTRAINT "food_items_state_check" CHECK ((state = ANY (ARRAY['raw'::text, 'cooked'::text, 'unknown'::text]))),
  CONSTRAINT "food_items_unit_check" CHECK ((unit = ANY (ARRAY['g'::text, 'oz'::text, 'cup'::text, 'tbsp'::text, 'piece'::text, 'serving'::text]))),
  CONSTRAINT "food_items_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."food_items" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."food_items" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."food_items" TO service_role;

CREATE TABLE public."messages" (
  "id" text NOT NULL,
  "client_id" text NOT NULL,
  "sender" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "read_at" timestamp with time zone,
  CONSTRAINT "messages_body_check" CHECK (((length(body) >= 1) AND (length(body) <= 4000))),
  CONSTRAINT "messages_sender_check" CHECK ((sender = ANY (ARRAY['coach'::text, 'client'::text]))),
  CONSTRAINT "messages_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."messages" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."messages" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."messages" TO service_role;

CREATE TABLE public."posture_public_reports" (
  "client_id" text NOT NULL,
  "assessment_id" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "posture_public_reports_data_check" CHECK ((jsonb_typeof(data) = 'object'::text)),
  CONSTRAINT "posture_public_reports_pkey" PRIMARY KEY (client_id, assessment_id)
);

ALTER TABLE public."posture_public_reports" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."posture_public_reports" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."posture_public_reports" TO service_role;

CREATE TABLE public."posture_reviews_secure" (
  "client_id" text NOT NULL,
  "assessment_id" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "posture_reviews_secure_data_check" CHECK ((jsonb_typeof(data) = 'object'::text)),
  CONSTRAINT "posture_reviews_secure_pkey" PRIMARY KEY (client_id, assessment_id)
);

ALTER TABLE public."posture_reviews_secure" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."posture_reviews_secure" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."posture_reviews_secure" TO service_role;

CREATE TABLE public."referral_codes" (
  "client_id" text NOT NULL,
  "code" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY (client_id),
  CONSTRAINT "referral_codes_code_key" UNIQUE (code)
);

ALTER TABLE public."referral_codes" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."referral_codes" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."referral_codes" TO service_role;

CREATE TABLE public."referrals" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "referrer_client_id" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "location" text NOT NULL DEFAULT ''::text,
  "note" text NOT NULL DEFAULT ''::text,
  "status" text NOT NULL DEFAULT 'invited'::text,
  "referred_client_id" text,
  "credit" numeric(10,2) NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referrals_credit_check" CHECK ((credit >= (0)::numeric)),
  CONSTRAINT "referrals_email_check" CHECK (((char_length(email) >= 3) AND (char_length(email) <= 200))),
  CONSTRAINT "referrals_location_check" CHECK ((char_length(location) <= 120)),
  CONSTRAINT "referrals_name_check" CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
  CONSTRAINT "referrals_note_check" CHECK ((char_length(note) <= 1000)),
  CONSTRAINT "referrals_status_check" CHECK ((status = ANY (ARRAY['invited'::text, 'signed_up'::text, 'paying'::text, 'declined'::text]))),
  CONSTRAINT "referrals_pkey" PRIMARY KEY (id)
);

ALTER TABLE public."referrals" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."referrals" FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public."referrals" TO service_role;

-- Foreign-key dependencies

-- Stage 2: constraints on empty tables

ALTER TABLE public."coach_client_assignments" ADD CONSTRAINT "coach_client_assignments_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."coach_client_assignments" ADD CONSTRAINT "coach_client_assignments_coach_id_fkey" FOREIGN KEY (coach_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public."coach_messages" ADD CONSTRAINT "coach_messages_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."coach_notes_secure" ADD CONSTRAINT "coach_notes_secure_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."credit_redemptions" ADD CONSTRAINT "credit_redemptions_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."favorite_meals" ADD CONSTRAINT "favorite_meals_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."food_entries" ADD CONSTRAINT "food_entries_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."food_items" ADD CONSTRAINT "food_items_entry_id_client_id_fkey" FOREIGN KEY (entry_id, client_id) REFERENCES public.food_entries(id, client_id) ON DELETE CASCADE;

ALTER TABLE public."messages" ADD CONSTRAINT "messages_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."posture_public_reports" ADD CONSTRAINT "posture_public_reports_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."posture_reviews_secure" ADD CONSTRAINT "posture_reviews_secure_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."referral_codes" ADD CONSTRAINT "referral_codes_client_id_fkey" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

ALTER TABLE public."referrals" ADD CONSTRAINT "referrals_referred_client_id_fkey" FOREIGN KEY (referred_client_id) REFERENCES public.clients(id) ON DELETE SET NULL;

ALTER TABLE public."referrals" ADD CONSTRAINT "referrals_referrer_client_id_fkey" FOREIGN KEY (referrer_client_id) REFERENCES public.clients(id) ON DELETE CASCADE;

-- Secondary indexes

CREATE UNIQUE INDEX basic_one_coach_per_client ON public.coach_client_assignments USING btree (client_id);

CREATE INDEX coach_messages_client_created_idx ON public.coach_messages USING btree (client_id, created_at);

CREATE INDEX coach_notes_secure_client_idx ON public.coach_notes_secure USING btree (client_id);

CREATE INDEX credit_redemptions_client_idx ON public.credit_redemptions USING btree (client_id);

CREATE INDEX food_entries_client_day_idx ON public.food_entries USING btree (client_id, date DESC);

CREATE INDEX food_items_entry_idx ON public.food_items USING btree (entry_id);

CREATE INDEX messages_client_created_idx ON public.messages USING btree (client_id, created_at);

CREATE INDEX referrals_referrer_idx ON public.referrals USING btree (referrer_client_id);

CREATE INDEX referrals_email_idx ON public.referrals USING btree (lower(email));

CREATE UNIQUE INDEX referrals_one_per_email ON public.referrals USING btree (referrer_client_id, lower(email));
