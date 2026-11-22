# Pure Function — QA Schema-Only Baseline Report (2026-11-22)

**Authorized target:** `nsshdxxdvzzxlmdomixf` (QA only). **Never deploy these migrations to Production:** `rugwzvztweiffprkxfdc`.

## Verified result

Read-only Production `pg_catalog` definitions were used to generate QA-specific, schema-only migration files. No Production customer, authentication, or Storage objects were copied.

| Object | Production | QA after rollout | Difference |
|---|---:|---:|---|
| Public + private application tables | 20 | 22 | All 20 Production table definitions present; 2 QA-specific private tables remain |
| Application triggers | 15 | 15 | Exact named trigger inventory matches |
| Application functions | 43 | 47 | All 43 Production function signatures present; four QA-specific functions remain. QA `cron_secret_ok` always rejects because QA has no cron secret |
| Public, private + Storage policies | 60 | 60 | All Production policy definitions present. Legacy `public.messages` grants are fully revoked, so no app role can read/write |
| Storage buckets | 4 | 4 | Four private, empty QA buckets matching the Production bucket configuration |
| QA application tables with RLS disabled | n/a | 0 | All QA application tables have RLS enabled |

Existing `private.settings` in QA deliberately has RLS enabled, stricter than Production. Six previously missing indexes on existing QA tables were reproduced, including the unique nonblank client-email index.

The QA project had three pre-existing Auth users and one existing client record before this rollout and retained the same counts afterward. Storage objects: **0**. Captured sandbox emails: **0**. All four new buckets are private.

## Files staged for review and replay

The eight source files in `supabase/qa/migrations/` are:

1. `20261122_missing_13_base_tables.sql`
2. `20261122_rls_missing_public_policies.sql`
3. `20261122_missing_triggers_and_private_helpers.sql`
4. `20261122_existing_table_index_parity.sql`
5. `20261122_private_storage_buckets.sql`
6. `20261122_storage_object_rls.sql`
7. `20261122_missing_public_rpcs.sql`
8. `20261122_complete_fail_closed_object_inventory.sql`

Each begins with a fail-closed QA-only guard requiring `private.qa_mail_outbox` to exist. Each was applied only to QA through separate Supabase migrations after checking existing objects. **Do not execute on Production.** These staged files do not automatically run on `main`.

## Explicitly retained QA safety differences

- Public `messages` is retired: the four Production policy definitions are present for structural parity, but all table grants to `PUBLIC`, `anon`, and `authenticated` are revoked, so reads and writes fail closed. Active messaging uses `coach_messages`.
- `cron_secret_ok` matches Production code but returns false for all inputs because no QA `cron_secret` exists in Vault. The `pg_cron` extension is not installed in QA and no schedules exist; scheduled email sending remains disabled.
- The public-facing referral RPCs `submit_referral` and `referral_inviter` exist but are restricted to `service_role` in QA until non-real-email acceptance testing is approved.
- QA transactional email Edge Functions use a separate capture-only adapter that rejects recipients outside `@qa.invalid`. They do not contact Resend.
- No QA access tokens, service-role keys, email links, real addresses, or Production configuration secrets are in this report.

## Remaining acceptance gates

1. **Not yet verified:** standard Supabase Auth Admin creation + deletion of synthetic `@qa.invalid` users, actual sign-up/invite verification and password login, UI role isolation, storage upload/signed URL denial tests, and the 19 real-QA acceptance scenarios. Never reuse existing QA identities or manually insert `auth.users` rows.
2. **Not enabled in QA:** `daily-reminders` or `food-parse` functions; the former must not schedule or send, and the latter requires safely configured API credentials before testing.
3. Security advisor still reports informational no-policy RLS notices, `SECURITY DEFINER` function exposure warnings, and leaked-password protection disabled. Each finding needs individual review; do not blindly revoke app-required RPCs.
4. Production real-email deliverability and daily backup scheduling remain separate owner-controlled release gates. No Production schema, data, secrets, deployment or email configuration was changed here.
5. S1/S2/S3 proposal rollouts still require their explicitly separate approvals per `docs/QA_ROLLOUT_PLAN.md`.

**Evidence level:** schema-only QA parity and permission inspection, *not* a completed real-QA end-to-end flow or Production acceptance.
