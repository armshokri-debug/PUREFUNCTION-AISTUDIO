# Pure Function — Dependency-Ordered QA Rollout Plan

Status: **PLAN ONLY — NOT EXECUTED**  
Approved QA Target: `nsshdxxdvzzxlmdomixf`  
Forbidden Target: `rugwzvztweiffprkxfdc` (Production — NEVER modified by QA rollout)

---

## 1. Verified Current Structural Gap (Live Observation)

| Component | Production (`rugwzvztweiffprkxfdc`) | QA (`nsshdxxdvzzxlmdomixf`) | Gap to Close |
|---|---:|---:|---:|
| Database Tables (`public` + `private`) | `20` | `5` | `+15` tables |
| Functions (`public` + `private`) | `40` | `10` | `+30` functions |
| Triggers (`public`, `private`, `auth.users`) | `14` | `2` | `+12` triggers |
| RLS Policies (`public`, `private`, `storage`) | `46` | `13` | `+33` policies |
| Private Storage Buckets | `4` | `0` | `+4` private buckets |
| Edge Functions | `6` | `0` | `+6` functions |
| Cron Jobs (`pg_cron`) | Active (paused) | `0` | **KEEP DISABLED (`0`) IN QA** |
| Real Customer Data / Real Emails | Live | `0` | **MUST REMAIN `0` IN QA** |

> **Important:** Historical `supabase/schema-reference-2026-11-13.json` and drifted `supabase/migrations/` are **NOT** applied blindly. Every object definition entering QA must come from an owner-approved, scanned, schema-only Production reference.

---

## 2. Non-Negotiable QA Safety Safeguards

1. **Hard Project Lock**: Every script and workflow must verify `QA_SUPABASE_PROJECT_REF === 'nsshdxxdvzzxlmdomixf'` and reject any occurrence of `rugwzvztweiffprkxfdc`.
2. **Least-Privilege Read-Only Audit Role**: QA parity audits must use a dedicated read-only role (`qa_catalog_readonly` / `qa_readonly`) with `rolsuper=false`, `rolbypassrls=false`, and NO `pg_read_all_data`. `supabase_read_only_user` is permanently blocked.
3. **Zero Production Data**: Never run `pg_dump` with data, never copy `auth.users`, `public.*` rows, `storage.objects`, `private.settings`, or `vault.*`.
4. **Zero Automated Cron / Real Email Delivery in QA**:
   - Do **NOT** schedule `pg_cron` jobs in QA.
   - Set `DAILY_REMINDERS_ENABLED=false` in QA Edge Function secrets.
   - Do **NOT** configure a live production Resend domain/key for arbitrary recipients in QA; use synthetic `.invalid` addresses or an isolated mail sink/sandbox.
5. **Legacy Table Rule**: Never repurpose `public.messages` for application writes; active messaging uses `public.coach_messages`.

---

## 3. Dependency-Ordered Rollout Sequence

### Step 0 — Authorized Read-Only Production Metadata & Controlled DDL Capture
- **Owner Approval Required:** Yes (read-only access to Production schema metadata).
- **Actions:**
  1. Run the read-only metadata-only query (`node scripts/qa/schema-discovery.cjs --print-sql`) inside `BEGIN TRANSACTION READ ONLY` against Production to capture `prod-metadata.json` (zero rows, zero raw function bodies).
  2. Run the same metadata-only query against QA (`qa-metadata-before.json`) and run `node scripts/qa/schema-discovery.cjs --compare prod-metadata.json qa-metadata-before.json` to list every exact missing table, column, constraint, index, function, trigger, policy, extension, and privilege.
  3. Extract schema-only DDL for missing objects from Production into a staging file, remove any Production URLs/emails/cron/Vault entries, run `node scripts/qa/schema-discovery.cjs --scan-ddl <candidate.sql>`, and complete manual human sign-off (`safeForQaBaseline: true`).
- **Exit Criteria:** Machine-readable gap inventory matches live counts (`20 tables / 40 functions / 14 triggers / 46 policies / 4 buckets`); candidate QA baseline SQL passes `--scan-ddl` with `0` findings.

### Step 1 — QA Database Schema Baseline (Dependency Order Inside SQL)
- **Owner Approval Required:** Yes (QA database DDL execution).
- **Strict Dependency Order:**
  1. **Extensions & Schemas**: Verify required extensions (`pgcrypto`, etc.) and create `private` schema (`REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated`).
  2. **Base Tables & Sequences** (without circular FKs first):
     - `private.settings`, `private.coach_allowlist`
     - `public.profiles` (FK -> `auth.users(id) ON DELETE CASCADE`)
     - `public.clients` (FK -> `public.profiles(id)`)
     - `public.coach_client_assignments`, `public.workouts`, `public.exercises`, `public.coach_messages`, `public.coach_notes_secure`, `public.food_entries`, `public.food_items`, `public.favorite_meals`, `public.posture_reviews_secure`, `public.posture_public_reports`, `public.program_templates`, `public.referral_codes`, `public.referrals`, `public.credit_redemptions`, `public.signup_verification_resends`, `public.messages` (structural parity only, unused).
  3. **Constraints & Indexes**: Primary keys, foreign keys, check constraints, unique constraints (`workouts_client_id_date_key`, etc.).
  4. **Helper & RPC Functions**:
     - `private.*` helpers (`basic_is_coach`, `is_coach`, `has_profile`, `can_manage_client`, `my_client_id`, `email_key`, `link_user`, trigger functions) — all `SECURITY DEFINER` with `SET search_path = ''`.
     - `public.*` RPCs (`pf_head_coach`, `signup_role`, `is_existing_signup_account`, `reserve_signup_verification`, `save_workout_results_secure`, `pf_save_food_entry`, `pf_update_program_template`, referral RPCs, etc.) with exact `REVOKE ALL FROM PUBLIC, anon` and minimal `GRANT EXECUTE`.
  5. **Triggers**: All `14` triggers on `public.*` and `auth.users` (`on_auth_user_created`, `clients_guard`, `clients_link_after_write`, `t8b_reject_inline_notes`, `t8b_guard_client_data`, `coach_messages_guard`, `posture_freeze_guard`, `basic_owner_on_insert`, `basic_owner_on_update`, etc.).
  6. **Row-Level Security & Table Privileges**:
     - `ENABLE ROW LEVEL SECURITY` on every `public.*` and `private.*` table.
     - Apply all table RLS policies.
     - Verify `REVOKE UPDATE ON TABLE public.program_templates FROM PUBLIC, anon, authenticated`.
  7. **Least-Privilege QA Audit Role**: Create/verify `qa_catalog_readonly` with `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, no `pg_read_all_data`, and `USAGE` on `storage` + `SELECT` on `storage.buckets` only if bucket parity visibility is desired (never `storage.objects`).
- **Exit Criteria:** `audit-qa-parity.cjs --live` and `schema-discovery.cjs --compare` report `0` missing tables/functions/triggers/policies/constraints and `0` critical security findings.

### Step 2 — QA Private Storage Buckets & Storage Policies
- **Owner Approval Required:** Yes.
- **Actions:**
  1. Create all 4 buckets in QA with **`public = false`**:
     - `exercise-videos`
     - `client-videos`
     - `inbody-printouts`
     - `message-media`
  2. Configure `file_size_limit` (50 MB for videos/media) and `allowed_mime_types` matching Production metadata.
  3. Apply all `storage.objects` RLS policies for the 4 buckets.
- **Exit Criteria:** All 4 buckets exist in QA, all have `public = false`, zero objects exist initially, and `audit-qa-parity.cjs` reports `storageBucketsStatus = VERIFIED` with `missing = 0`, `public = 0`.

### Step 3 — QA Edge Functions Deployment & Safe QA Secrets
- **Owner Approval Required:** Yes.
- **Actions:**
  1. Configure QA-scoped Edge Function secrets ONLY on `nsshdxxdvzzxlmdomixf`:
     - `APP_URL` = QA / local preview URL (NEVER Production if testing isolated QA links)
     - `DAILY_REMINDERS_ENABLED=false` (mandatory safety lock)
     - `COACH_TIMEZONE` = matching timezone
     - `RESEND_API_KEY` = omit or point to non-delivering test/sink configuration so real emails are NEVER sent
     - `EMAIL_FROM` = sandbox sender only
  2. Deploy all 6 Edge Functions to QA (`--project-ref nsshdxxdvzzxlmdomixf`) with exact JWT flags:
     - `sign-up` (`--no-verify-jwt`)
     - `reset-password` (`--no-verify-jwt`)
     - `daily-reminders` (`--no-verify-jwt`; still requires `x-cron-secret` and returns `paused: true`)
     - `send-invite` (default `verify_jwt = true`)
     - `invite-trainer` (default `verify_jwt = true`)
     - `food-parse` (default `verify_jwt = true`)
- **Exit Criteria:** All 6 functions active in QA; `POST daily-reminders` with wrong secret returns `401`, with valid QA secret returns `200 { paused: true, results: [] }` and sends `0` emails.

### Step 4 — QA Auth Settings Parity
- **Owner Approval Required:** Yes (Supabase QA Auth dashboard/API).
- **Actions:**
  1. Enable email confirmation (`mailer_autoconfirm = false`).
  2. Enable leaked password protection & minimum password length (`>= 8`).
  3. Set Site URL and Redirect URLs strictly to QA / localhost origins.
  4. Keep external SMTP disabled or pointed at a non-delivering sink so QA never emails real people.
- **Exit Criteria:** Unconfirmed accounts cannot sign in with password; GoTrue rejects weak/unconfirmed sign-ins as expected.

### Step 5 — Synthetic QA Seed Identities (Zero Real Data)
- **Owner Approval Required:** Yes.
- **Actions:**
  1. Insert synthetic `head.coach@qa.invalid` into QA `private.settings` (`coach_email`) and `head.coach@qa.invalid`, `coach.a@qa.invalid`, `coach.b@qa.invalid` into QA `private.coach_allowlist`.
  2. Create synthetic `@qa.invalid` accounts listed in `docs/QA_ACCEPTANCE_SCENARIOS.md` via QA Auth API / standard flows.
- **Exit Criteria:** All 7 synthetic test identities exist cleanly in QA with zero overlap with any real email address.

### Step 6 — Real-QA Parity & Acceptance Execution
- **Actions:**
  1. Run `qa-audit.yml` against QA -> confirm `PARITY_VERIFIED` (`0` missing objects, `0` critical findings, `0` unknown checks).
  2. Execute all 19 real-QA scenarios (`QA-01` through `QA-19`) in `docs/QA_ACCEPTANCE_SCENARIOS.md`.
- **Exit Criteria:** 100% pass on Tier 3 (Real QA) scenarios with zero cross-coach or client privilege leaks.

### Step 7 — Separate Security Hardening Evaluation on QA (S1, S2, S3)
- **Owner Approval Required:** Explicit separate approval BEFORE applying any security proposal, even to QA!
- **Proposals Ready for Review:**
  1. `supabase/proposals/s1_unconfirmed_signup_hardening.sql` + updated `sign-up` Edge Function (test `QA-06` live against real GoTrue; evaluate architectural follow-up for Attack Path 2).
  2. `supabase/proposals/s2_deterministic_client_linking.sql` (test `QA-09` live on QA; run read-only duplicate-email preflight check on Production before ever considering Production migration).
  3. `supabase/proposals/s3_exercise_and_video_isolation.sql` + companion `uploadExerciseVideo` path update (test `QA-18` live on QA; verify existing system exercises & videos remain 100% readable).
- **Exit Criteria:** All S1/S2/S3 proposals pass live QA acceptance + zero regressions before being proposed for Production.
