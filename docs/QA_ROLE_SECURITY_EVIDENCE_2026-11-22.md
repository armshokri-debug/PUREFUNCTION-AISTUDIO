# Pure Function QA — Restricted Helper Grants & Role-Simulation Evidence (2026-11-22)

**Only QA project:** `nsshdxxdvzzxlmdomixf`. **Production was not changed.**

## Verified in the real QA PostgreSQL database

- Six existing `private.*` function EXECUTE permissions were aligned with read-only observed Production settings. The five user-authorization helpers are executable by `authenticated` only; `private.touch_updated_at()` has no public/Auth/service-role EXECUTE grants.
- Re-ran a **READ ONLY** session as the PostgreSQL `authenticated` role with a nonexistent synthetic JWT subject and user-editable `user_metadata.role=coach`: `private.basic_is_coach()=false`, `private.can_manage_client(...)=false`, visible clients/workouts/private notes/storage objects each `0`. Forging a role label in user metadata did not confer privileges in this check.
- Tested the PostgreSQL `anon` role via a separate READ ONLY transaction: visible profiles/clients/workouts/program templates were all `0`. This tests DB RLS, not GoTrue sign-in.
- QA mail capture remains service-role-only. Four storage buckets remain private; no QA files or messages were sent.
- QA source row counts were unchanged after the migration and tests: **3 existing Auth users; 1 existing client; 0 sandbox emails; 0 Storage objects.** Temporary allowlist fixtures were removed.

## Evidence distinction and remaining blocker

These are **real QA database permission checks with simulated roles and claims**, not real Supabase Auth user creation, OTP redemption, credential login, invitation delivery, or browser acceptance. The 19 real-QA scenarios in `docs/QA_ACCEPTANCE_SCENARIOS.md` remain **unverified**. Do not count them as passed.

The Supabase connector used here offers SQL/migrations/Edge deployments but no direct, scoped Auth Admin test-account workflow. Do not deploy a public unauthenticated service-role test runner as a workaround. Complete real identity tests through a secure, authenticated QA-only execution environment and synthetic `@qa.invalid` accounts; keep existing QA accounts untouched.

Production emails and daily encrypted off-site backup automation are separate remaining release gates; there is no claim of zero security advisories.

## Migration and replay

QA-only SQL: `supabase/qa/migrations/20261122_restrict_private_helpers.sql`, protected by an existing QA-only marker check, not included in Production migration path. It was applied only to QA and verified with read-only queries.
