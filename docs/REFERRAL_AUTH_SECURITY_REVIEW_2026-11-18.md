# Pure Function — Referral & Auth Security Review (2026-11-18)

## Scope and status

**Assessment only — no production migration, RLS edits, Auth setting changes, or user-data writes.** Reviewed the connected production project's Supabase advisor results, read-only function definitions and aggregate counts, and the current GitHub UI/migration implementation. This is not a penetration test or proof of exploitability.

Production observation: the referral system currently has **0 referral codes, 0 referrals, and 0 credit-redemption records**, at the time of this read-only inspection.

## Finding A — Anonymous referral RPCs (intentional access, guardrails needed)

- `public.referral_inviter(p_code text)`: `SECURITY DEFINER`, executable by `anon` and `authenticated`. Resolves a referral code to a **first name** for the public landing page (`src/components/ReferralLanding.tsx`). Removing anonymous access would break that flow.
- `public.submit_referral(p_code text, p_name text, p_email text, p_location text, p_note text)`: `SECURITY DEFINER`, executable by `anon` and `authenticated`. Inserts referral leads when the code is valid. It checks email syntax and a **20 submissions per referrer per rolling day** threshold. Duplicate emails for the same referrer are ignored by a unique index.
- A shared threshold per referral code does **not** impose an independent caller/IP/bot limit. An attacker with a valid shared code could consume that code's capacity or submit unwanted leads. Public first-name display also discloses an inviter's first name to anyone holding the link; this is the present product design.
- `referrals` table RLS restricts reads to the linked client or a coach, and changes to a coach. The public function's privileges still need independent scrutiny, since `SECURITY DEFINER` may bypass table RLS.

**Before release of any hardening migration:**

1. Decide the desired public user experience and whether showing inviter first names is acceptable. Preserve anonymous landing and submission flows.
2. Design a server-side, abuse-resistant limit that does not let one anonymous caller block all legitimate invitees by exhausting a shared referrer quota. Evaluate IP-based throttling and bot protection (not a public-client-only guard); account for shared IPs, privacy, proxy headers, and rate-limit bypasses. Consider a privileged Edge Function for validation and optional CAPTCHA verification, with the existing RPC appropriately restricted **only after** a tested cutover.
3. Keep field-length checks, ownership isolation and coach-only credit/status transitions. Validate that unauthenticated users cannot read arbitrary referrals, credits, or client records.
4. Test: public landing with a valid/invalid code; anonymous legitimate submission; duplicate submission; malicious/burst submission; joined client sees only their own referrals; coaches see authorized leads; no leaking of private notes, emails, or unapproved PII.
5. Back up relevant production state and rehearse the changes in an isolated branch/staging DB; get owner approval for SQL/RLS changes. Do not replay the historical migrations against production.

## Finding B — Auth leaked-password protection

The Supabase security advisor flagged `auth_leaked_password_protection` (WARN). Supabase documentation describes HaveIBeenPwned/Pwned Passwords integration. Assess availability for this project's plan and whether enabling it affects existing password/reset workflows. After the email domain issue is resolved, explicitly test password reset and account creation with a permitted test user. Do **not** alter existing Auth users or passwords.

Documentation: https://supabase.com/docs/guides/auth/password-security

## Finding C — Other advisor notices (review; do not bulk-fix)

- `pg_net` installed in `public` (WARN).
- 13 authenticated-access `SECURITY DEFINER` findings. Example: `pf_manage_trainer` explicitly gates access using `pf_head_coach()`; being executable is not by itself proof of an authorization bypass.
- Unindexed FKs and RLS initialization-plan inefficiencies (performance rather than an observed data-loss issue).
- Do **not** revoke shared functions or change policy semantics based only on advisory labels. Review each function's internal checks and all callers first.

## Acceptance gate

The currently deployed client/coach experience must remain intact. No security migration should merge without a reviewed backup/rollback plan, controlled abuse tests, authenticated and anonymous authorization tests, and explicit authorization. Keep the email/domain work separate.
