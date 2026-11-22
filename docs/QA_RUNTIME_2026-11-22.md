# Pure Function QA runtime — 2026-11-22

**Project:** `nsshdxxdvzzxlmdomixf` (QA only). **Forbidden target:** `rugwzvztweiffprkxfdc` (Production).

## Safe QA-only runtime deployed
- Diagnostic site: https://nsshdxxdvzzxlmdomixf.supabase.co/functions/v1/qa-portal
- Active QA Edge Functions: `qa-portal`, `sign-up`, `send-invite`, `reset-password`, `invite-trainer`, plus previously existing `delete-client`.
- The four mail-related functions use a **QA-only** `_shared/email.ts` override, rather than the production Resend adapter. It accepts only addresses at `@qa.invalid` and captures messages in the restricted `private.qa_mail_outbox` table via a service-role-only `qa_capture_mail` RPC. **No outbound mail occurs.**
- The active QA override source is copied as `supabase/qa/runtime/email-sink.ts`. The diagnostic portal source is copied as `supabase/qa/runtime/qa-portal.ts`. These are NOT production deploy entrypoints. Any later QA redeployment must bundle the QA override explicitly, never `supabase/functions/_shared/email.ts` from production.
- All schema changes were applied only to QA through the Supabase migration API: `qa_signup_rpc_prerequisites_20261122`, `qa_private_table_rls_hardening_20261122`, `qa_non_delivery_mail_sink_20261122`, `qa_head_coach_invitation_prerequisites_20261122`. Temporary `http` extension enabled for read-only QA HTTP smoke and then removed.

## Evidence and limits
- QA portal HTML and JS returned HTTP 200. Unauthenticated GET against `send-invite` and `invite-trainer` returned 401; GET against `sign-up` and `reset-password` returned 405. These are **transport/auth-gate smoke tests**, not invitation acceptance tests.
- A fake `@qa.invalid` mail-sink insertion succeeded and was deleted. Non-test recipient capture was refused. No real email was sent.
- Nine public/private QA tables present, all nine with RLS enabled, as last checked. The mail outbox was empty after test cleanup.
- Existing QA identities were *not* created/changed/deleted during this step; their email addresses were **not** used for test traffic. QA had three Auth accounts and one client record both before and after.
- Security advisor still reports five informational no-policy RLS notices (fail-closed private/restricted tables), six `SECURITY DEFINER` warnings requiring individual authorization review, and disabled leaked-password protection.
- **Not verified:** full QA schema parity, synthetic QA coach/client accounts, real GoTrue invite redemption/password/login in the QA portal, full production-UI E2E, actual email deliverability and a verified production backup restore. Automated isolated Docker integration passed in PR #22; it does not prove these higher-tier checks.

## Non-negotiable safety rules
1. QA-only changes; never copy user/Storage/Auth rows or secrets from Production.
2. No real mail and no non-`@qa.invalid` test accounts or recipients.
3. Never deploy these QA-only sources to Production; never replace the Resend adapter there.
4. Before full QA acceptance, use proper Supabase Auth Admin APIs to provision isolated synthetic identities, then safely clean them up; do not use existing QA identities or edit `auth.users` directly with SQL.
5. Real delivery tests require a verified sender domain, explicitly permitted recipient, and dedicated QA setup. Do not present mail capture as real email delivery.
6. This documentation-only change does not deploy anything.

