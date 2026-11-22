# Pure Function — Live QA Security & Release Gates (22 November 2026)

**Only authorized repository:** `armshokri-debug/PUREFUNCTION-AISTUDIO`  
**QA Supabase:** `nsshdxxdvzzxlmdomixf`  
**Production:** `rugwzvztweiffprkxfdc` — **NO WRITES, NO DEPLOYMENTS, NO REAL EMAILS** in this test session.

## Result and evidence tier

**Do not claim the entire product is accepted.** Only QA-04 of the 19 exact scenarios in `docs/QA_ACCEPTANCE_SCENARIOS.md` is fully proven by an HTTP request to the live QA `sign-up` Edge Function plus a before/after Auth count. The 18 other scenarios need real, disposable GoTrue credentials, positive and cross-coach workflows and (for UI cases) a controllable browser. Do not equate simulated role checks with these scenarios.

### 1. Eight independently executed real-PostgreSQL negative access checks

The source-controlled, replayable file `supabase/qa/tests/negative_access_rollback_20261122.sql` was run successfully on the real QA Postgres database. It uses a fictitious JWT subject with forged coach metadata, `SET LOCAL ROLE authenticated`, a fail-closed QA marker, temporary result collection, and `ROLLBACK`; no lasting fixtures are created.

All eight independently returned **SQLSTATE `42501` (permission denied)**:

| Test | Verified result |
|---|---|
| Create client without verified coach | Denied |
| Create exercise without verified coach | Denied |
| Write private note without client ownership | Denied |
| Edit program template directly | Denied |
| Invoke head-coach management RPC | Denied |
| Invoke template update RPC without ownership | Denied |
| Invoke workout-result RPC without ownership | Denied |
| Upload metadata to private Storage bucket without ownership | Denied |

**Limit:** This proves real database privilege enforcement for an unauthorized identity, **not** a successful client/coach workflow, real JWT validation, positive access, OTP verification or object upload through the Storage HTTP API. Therefore none of QA-03, QA-08, QA-10, QA-14, QA-15, QA-16 or QA-17 is marked as fully passed solely from this suite.

### 2. Live Edge HTTP acceptance: QA-04 PASS

Live QA `POST /functions/v1/sign-up` with uninvited `pfqa-unauthorized-smoke-20261122@qa.invalid` returned HTTP **200**, `{"ok":true,"verificationRequired":true}`; no Auth user was created. Anonymous `send-invite` and `invite-trainer` calls returned HTTP **401**; unknown-email `reset-password` returned **200** without creating a user. The temporary HTTP testing extension was removed afterward. No mail was sent.

### 3. QA cleanup & users protected

After every test, QA counts were: 3 preexisting Auth users, 1 preexisting client, 4 preexisting workout records, **0** captured test emails, **0** Storage objects, **0** temporary HTTP extensions and **0** temporary `@qa.invalid` coaches. Existing accounts were not used as test personas or modified.

### 4. Backup — new verified evidence

On **2026-11-22**, [GitHub Actions run 44988680112](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/actions/runs/44988680112), live `run-encrypted-backup` job **SUCCESS**. The log explicitly confirms AES-256-GCM encryption with immediate decryption verification and encrypted archive upload to private Google Drive (`210123` bytes, 1 Storage file, 0 pruned files). `ENABLE_SUPABASE_BACKUP=true` was recorded by this workflow, and the `03:17 UTC` daily schedule is now present in `.github/workflows/supabase-backup.yml`.

**Distinction:** The last known ephemeral PostgreSQL recovery drill [run 44885726470](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/actions/runs/44885726470) passed for a prior backup on 2026-11-21. Recovery of the **new 2026-11-22** archive and a full Auth/Storage service recovery have **not** been proven. A successful **scheduled** backup run has not been separately observed; this new success was manually triggered. Do not call this complete operational disaster recovery.

### 5. Open release gates

1. **18/19 real-QA scenarios not fully verified:** Real, disposable `@qa.invalid` GoTrue users, invite verification, password change, cross-coach access, successful workouts/templates/notes, Storage signed URLs, and UI tests need a secure Auth Admin test executor plus browser automation. Current connector exposes SQL, migrations and Edge deployment but no scoped Auth Admin create/delete flow; do **not** work around this with a public service-role admin runner, raw inserts to `auth.users` or existing QA accounts.
2. S1/S2/S3 security proposals need their explicit separate rollout decision before applying them, even to QA. QA-18 depends on S3 changes (current `exercises` schema has no `owner_id`).
3. Real sender domain and real email deliverability have not been verified. The QA mail adapter accepts only `@qa.invalid` and is intentionally non-delivering.
4. Backups: require first successful daily **schedule** run plus separate restoration validation of the latest archive and Auth/Storage service recovery.
5. QA security advisor still flags 13 callable SECURITY DEFINER RPCs for individual intent review and leaked-password protection disabled; five RLS no-policy findings are on intentionally fail-closed tables.

**Conclusion:** Safe negative-path verification and manual live backup **passed**. Product is **NOT READY FOR FINAL DELIVERY**. No claim of 19/19 acceptance is authorized by this evidence.
