# Pure Function — QA Acceptance Scenarios & Evidence Separation

Target QA Supabase Project: `nsshdxxdvzzxlmdomixf`  
Forbidden Target (NEVER use for test writes): `rugwzvztweiffprkxfdc` (Production)

## 1. Evidence Tier Separation (Strict Policy)

Every check MUST be labeled with its actual evidence tier. Passing a lower tier NEVER proves a higher tier:

| Evidence Tier | What It Proves | What It Does NOT Prove | Current Status |
|---|---|---|---|
| **Tier 1: Unit Tests (`vitest`)** | Pure functions, Edge Function handlers, SQL query construction, security guard logic, DDL scanners | Live PostgreSQL RLS, GoTrue OTP/JWT behavior, real Storage policies | **VERIFIED** locally |
| **Tier 2: Mock Integration (`e2e/cloud-flow.cjs`, `e2e/mock-supabase.cjs`)** | End-to-end React UI state, portal guards, sync conflict UI, responsive layout against in-memory mock | Real Supabase RLS, real GoTrue token expiry/confirmation, real Storage signed URLs | **VERIFIED** in CI (`main`) |
| **Tier 3: Real QA Acceptance (`nsshdxxdvzzxlmdomixf`)** | Real PostgreSQL RLS/triggers/RPCs, real GoTrue confirmation/recovery, real Storage private bucket enforcement, real Edge Functions with synthetic `@qa.invalid` users | Production data integrity or Production email domain deliverability | **SCHEMA READY; REAL AUTH/BROWSER TESTS NOT YET EXECUTED** |
| **Tier 4: Production Acceptance (`rugwzvztweiffprkxfdc`)** | Live production smoke, read-only health/RLS checks, live transactional email verification with owner consent | Never tested with destructive or synthetic write fixtures | **PROPOSED / MANUAL** |

---

## 2. Synthetic QA Identities (Use `.invalid` RFC 2606 Addresses ONLY)

Never copy real user accounts, emails, phone numbers, or client profiles into QA.

1. `head.coach@qa.invalid` — Head Coach (`private.settings['coach_email']` + `private.coach_allowlist`)
2. `coach.a@qa.invalid` — Independent Coach A (`private.coach_allowlist`)
3. `coach.b@qa.invalid` — Independent Coach B (`private.coach_allowlist`)
4. `client.a1@qa.invalid` — Client assigned to Coach A
5. `client.b1@qa.invalid` — Client assigned to Coach B
6. `unverified.a2@qa.invalid` — Invited by Coach A, `email_confirmed_at IS NULL`
7. `stranger@qa.invalid` — Not in `coach_allowlist`, not in `public.clients`

---

## 3. Real-QA Acceptance Test Scenarios (Prepared for Phase 6 Execution)

### Domain 1 — Coach / Client Role Isolation
- **QA-01**: Sign in as `coach.a@qa.invalid` on Client portal -> MUST be rejected cleanly with zero workspace mount and local sign-out.
- **QA-02**: Sign in as `client.a1@qa.invalid` on Coach portal -> MUST be rejected cleanly with zero workspace mount and local sign-out.
- **QA-03**: Using `client.a1@qa.invalid` JWT, attempt `UPDATE public.profiles SET role='coach'`, `INSERT INTO public.clients`, `INSERT INTO public.exercises` -> MUST return PostgreSQL RLS denial (`42501` / 0 rows).

### Domain 2 — Unverified Accounts & S1 Takeover Verification
- **QA-04**: `stranger@qa.invalid` calls `sign-up` -> returns generic `200 { ok: true, verificationRequired: true }`, creates ZERO `auth.users` rows.
- **QA-05**: `unverified.a2@qa.invalid` has `email_confirmed_at IS NULL` -> `private.my_client_id()` returns `NULL`; direct PostgREST queries to `clients`, `workouts`, `coach_messages`, `coach_notes_secure` return `0` rows.
- **QA-06 (S1 Live GoTrue Proof)**: Attacker calls `sign-up` for `unverified.a2@qa.invalid` with `AttackerPass123!`. Legitimate user then calls `sign-up` with `LegitPass456!`. Verify:
  1. First token is invalidated.
  2. Confirming the second token enables login ONLY with `LegitPass456!`.
  3. Login with `AttackerPass123!` returns `Invalid login credentials`.
  4. Re-calling `sign-up` after confirmation NEVER modifies or deletes the confirmed user.

### Domain 3 — Password Recovery
- **QA-07**: Request password reset for `client.a1@qa.invalid` -> verify `?reset=` token enters `NewPasswordScreen` (`recoveryGate` active), page refresh stays on `NewPasswordScreen` (never mounts client workspace), saving new password signs out locally, old password fails, new password succeeds on a fresh browser context, reusing reset token fails.

### Domain 4 — Multi-Coach Ownership Boundaries & S2 Linking
- **QA-08**: `coach.b@qa.invalid` queries `clients`, `workouts`, `coach_notes_secure`, `coach_messages`, `food_entries`, `posture_public_reports` -> MUST see ZERO records belonging to `client.a1@qa.invalid`.
- **QA-09 (S2 Live Proof after S2 SQL applied to QA)**: `coach.b@qa.invalid` attempts to insert `public.clients` with `email = 'client.a1@qa.invalid'` or `email = 'coach.a@qa.invalid'` -> MUST fail with unique violation (`23505`).

### Domain 5 — Workout Assignment & Result Persistence
- **QA-10**: `coach.a@qa.invalid` creates workout for `client.a1@qa.invalid`. `client.a1@qa.invalid` attempts direct `PATCH /rest/v1/workouts` to change prescription `title` / `loadKg` -> MUST be denied by RLS.
- **QA-11**: `client.a1@qa.invalid` calls `save_workout_results_secure` with valid `p_expected_version` -> persists `loggedSets`, `sessionRpe`, `status`, returns new `updated_version`, preserves coach prescription fields intact.

### Domain 6 — Version Conflicts
- **QA-12**: `client.a1@qa.invalid` calls `save_workout_results_secure` with stale `p_expected_version` -> MUST fail with `40001` (`VERSION_CONFLICT`) without modifying the row.
- **QA-13**: `coach.a@qa.invalid` attempts conditional `UPDATE` on `clients` or `workouts` with stale `updated_at` -> updates `0` rows; app blocks further writes until reload.

### Domain 7 — Program Template Editing
- **QA-14**: `coach.a@qa.invalid` attempts direct `PATCH /rest/v1/program_templates` -> MUST fail with `42501` (direct `UPDATE` revoked from `PUBLIC`, `anon`, `authenticated`).
- **QA-15**: `coach.a@qa.invalid` calls `pf_update_program_template` with matching `p_expected_data` -> succeeds; stale `p_expected_data` -> fails with `40001`; `coach.b@qa.invalid` calling on Coach A's template -> fails with `42501`; `anon` calling RPC -> fails with `42501`.

### Domain 8 — Private Notes & Storage Authorization (Including S3)
- **QA-16**: `coach.a@qa.invalid` saves a private note (`shared=false`) in `coach_notes_secure`. `client.a1@qa.invalid` queries `coach_notes_secure` and `clients` -> private note is invisible in both; attempting to put `coachNotes` inside `clients.data` is rejected by `t8b_reject_inline_notes` trigger.
- **QA-17**: `client.b1@qa.invalid` and `coach.b@qa.invalid` request signed URLs or uploads under `client-videos/<client_a1_id>/...`, `inbody-printouts/<client_a1_id>/...`, `message-media/<client_a1_id>/...` -> MUST be denied by Storage RLS.
- **QA-18 (S3 Live Proof after S3 SQL applied to QA)**: `coach.a@qa.invalid` creates custom exercise (`owner_id = coach_a`) and uploads video under `coaches/<coach_a>/...`. Verify:
  - `coach.a@qa.invalid` can read/update/delete.
  - `client.a1@qa.invalid` can read ONLY (cannot update/delete).
  - `coach.b@qa.invalid` and `client.b1@qa.invalid` CANNOT read, update, or delete Coach A's exercise or video.
  - Neither `coach.a@qa.invalid` nor `coach.b@qa.invalid` can overwrite or delete shared system exercises (`owner_id IS NULL`); only `head.coach@qa.invalid` can.

### Domain 9 — Messaging Pagination & Isolation
- **QA-19**: Seed `560` synthetic rows in QA `coach_messages` for `client.a1@qa.invalid`. Verify `useMessages` loads messages `#61..#560` (newest 500) in chronological ascending order (`#61` first, `#560` last), `hasMore === true`, and `loadOlder()` loads `#1..#60` without duplicates while `client.b1@qa.invalid` sees `0` rows.
