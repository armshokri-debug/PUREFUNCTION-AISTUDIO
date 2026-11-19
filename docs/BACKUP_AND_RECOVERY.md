# Pure Function — Backup & Isolated Recovery Guide

**Target production Supabase project:** `rugwzvztweiffprkxfdc` (Free plan — no scheduled Supabase backups or PITR)  
**Active repository:** `armshokri-debug/PUREFUNCTION-AISTUDIO`  
**Status:** **PREPARED ONLY — NOT YET ACTIVATED OR LIVE-VERIFIED.**  
Backup coverage must **not** be considered complete until external storage and secrets are configured with owner approval, a real backup runs successfully, and an isolated restore drill succeeds on a separate Supabase project.

---

## 1. Current Backup Coverage vs. Gaps

### Already backed up in this repository
- **`.github/workflows/offline-backup.yml`**: Exports a Git history bundle (`*.bundle`), source ZIP snapshot, commit history, and SHA-256 checksums as a 30-day GitHub Actions artifact.
- **`supabase/schema-reference-2026-11-13.json`** and **`supabase/recovered_migrations/`**: Metadata-only catalog reference and archived ownership/template SQL. **Not** a full restorable database backup.
- **`supabase/functions/`**: Source code for Edge Functions.

### Previously missing (now addressed by the prepared backup tooling)
1. **PostgreSQL application schema & live rows** (`public` and `private` schemas, including `clients`, `workouts`, `profiles`, `coach_client_assignments`, `coach_messages`, `coach_notes_secure`, `posture_reviews_secure`, `posture_public_reports`, `program_templates`, `food_entries`, `food_items`, `favorite_meals`, `exercises`, `referrals`, `referral_codes`, `credit_redemptions`, `signup_verification_resends`, `private.coach_allowlist`, `private.settings`, plus `supabase_migrations`).
2. **Supabase Auth users & authentication state** (`auth` schema: `auth.users` UUIDs & password hashes, `auth.identities`, `auth.mfa_*`, confirmation state) — required so user accounts remain linked to `public.profiles`.
3. **Supabase Storage metadata & binary files** (`storage` schema dump + read-only export of all bucket objects across `exercise-videos`, `client-videos`, `inbody-printouts`, `message-media`, plus dynamic discovery of any additional bucket).
4. **Encrypted external off-site storage with retention & failure alerts** (GitHub Actions artifacts expire and are not durable off-site storage for private user data).

### Items that still live outside database/storage dumps (store securely in owner's password manager)
- Supabase Dashboard Auth settings (Site URL, Redirect URLs, SMTP/Resend settings)
- Edge Function secrets (`RESEND_API_KEY`, `APP_URL`, etc.)
- The `BACKUP_ENCRYPTION_KEY` passphrase itself (critical: without it, encrypted backups cannot be decrypted)

---

## 2. Architecture & Safety Guarantees

- **Read-only against production**:
  - Every `pg_dump` and `psql` command runs with `PGOPTIONS="-c default_transaction_read_only=on"`, `sslmode=require`, and `--lock-wait-timeout=30000`.
  - Storage export (`scripts/backup/export-storage.cjs`) uses only read-only `GET /storage/v1/bucket`, `POST /storage/v1/object/list/*`, and `GET /storage/v1/object/authenticated/*`.
  - Zero DDL, RLS, grant, function, trigger, or row changes are ever executed on production.
- **Client-side authenticated encryption before upload**:
  - Archives are encrypted locally in the ephemeral runner using **AES-256-GCM + scrypt** (`PFBK1` streaming format) via `scripts/backup/backup-lib.cjs`.
  - Immediately after encryption, `run-backup.cjs` decrypts the `.tar.gz.enc` file into a temporary check and verifies its SHA-256 matches the plaintext tarball **before uploading**.
  - Only the encrypted archive (`.tar.gz.enc`) and a non-PII sidecar `.manifest.json` (hashes, counts, and byte sizes only) are uploaded to the external bucket.
  - Sensitive backups are **never** uploaded as GitHub Actions artifacts.
- **Safe retention policy**:
  - Default retention is `30` days (`BACKUP_RETENTION_DAYS=30`).
  - A hard safety floor (`BACKUP_MIN_KEEP_COUNT=7`) guarantees the 7 newest backups are **never** pruned even if backups fail for more than 30 days.
- **Disabled by default**:
  - `.github/workflows/supabase-backup.yml` has **no active `schedule:` trigger** (commented out).
  - Live execution requires BOTH GitHub Repository Variable `ENABLE_SUPABASE_BACKUP=true` AND manual confirmation `RUN_BACKUP`.
- **Safe failure reporting**:
  - If a live backup fails, the workflow opens/updates a GitHub Issue labeled `backup-alert` with only the run link and timestamp. Secrets are redacted and zero client data is printed.

---

## 3. Recommended Low-Cost External Storage Provider

**Recommended:** **Cloudflare R2** (S3-compatible)
- **Cost:** Free tier includes **10 GB/month storage** and **$0 egress fees** (downloads for verification/restore drills are free).
- **Security setup:**
  1. Create a **private** bucket (e.g. `purefunction-prod-backups`) with public access disabled.
  2. Create a scoped R2 API Token with **Object Read & Write** permissions limited **only** to that single bucket.
  3. (Optional extra hardening) Enable Bucket Versioning or Object Lock if desired.

**Alternatives supported without code changes:** Backblaze B2 (S3-compatible API) or AWS S3.

---

## 4. Credentials, Secrets & Variables Requiring Owner Approval Before Activation

Configure these in **GitHub → `armshokri-debug/PUREFUNCTION-AISTUDIO` → Settings → Secrets and variables → Actions** only after you approve the storage provider.

### Repository Secrets (sensitive — never commit to repo or `.env*`)
| Secret Name | Value / Purpose |
| --- | --- |
| `SUPABASE_DB_URL` | PostgreSQL Direct or Session Pooler URI for `rugwzvztweiffprkxfdc` ending with `?sslmode=require`. (Tip: if GitHub Actions runner uses IPv4, use the Supabase **Session Pooler** URI port `5432` with `?sslmode=require`.) |
| `SUPABASE_URL` | `https://rugwzvztweiffprkxfdc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — used **only** inside the private Actions runner for read-only Storage export. **Never** put in `VITE_*` variables. |
| `BACKUP_ENCRYPTION_KEY` | Random high-entropy passphrase (at least 32 characters, e.g. `openssl rand -base64 48`). **Save a copy offline in your password manager.** |
| `BACKUP_S3_ENDPOINT` | External S3 endpoint URL (for Cloudflare R2: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). |
| `BACKUP_S3_BUCKET` | Private external bucket name (e.g. `purefunction-prod-backups`). |
| `BACKUP_S3_ACCESS_KEY_ID` | Bucket-scoped S3/R2 access key ID. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Bucket-scoped S3/R2 secret access key. |

### Repository Variables (non-secret configuration)
| Variable Name | Initial Value | Purpose |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | `rugwzvztweiffprkxfdc` | Safety guard matching `SUPABASE_URL` hostname. |
| `BACKUP_S3_REGION` | `auto` | `auto` for Cloudflare R2 (or bucket region for B2/AWS S3). |
| `BACKUP_RETENTION_DAYS` | `30` | Days to retain backups (minimum 7). |
| `BACKUP_MIN_KEEP_COUNT` | `7` | Safety floor: minimum newest backups always preserved. |
| `ENABLE_SUPABASE_BACKUP` | `false` | Master kill-switch. Keep `false` until approved and validated. |

---

## 5. Non-Destructive Validation (Safe to Run Anytime)

### Local unit & safety tests (no production access)
```bash
npx vitest run scripts/backup/backup.test.mjs
```

### Offline backup verification & decryption check (for any downloaded archive)
```bash
export BACKUP_ENCRYPTION_KEY="<your-passphrase-from-password-manager>"
node scripts/backup/verify-and-decrypt.cjs ./backup-YYYY-MM-DDTHH-MM-SSZ.tar.gz.enc \
  --manifest ./backup-YYYY-MM-DDTHH-MM-SSZ.manifest.json
```
This verifies:
1. Encrypted file SHA-256 matches the manifest.
2. AES-256-GCM authentication tag + decryption succeeds with your key.
3. Decrypted tarball SHA-256 matches the manifest.
4. All required components (`public-private-schema.sql`, `public-private-full.dump`, `auth-full.dump`, `storage-schema-full.dump`, `storage/buckets.json`, `storage/storage-inventory.json`) exist inside the archive.
5. Automatically deletes the temporary decrypted copy unless `--out <file>` is explicitly provided.

### Safe GitHub Actions dry-run (after adding secrets, while `ENABLE_SUPABASE_BACKUP=false`)
1. Open **Actions → Supabase Encrypted Backup (Disabled Until Approved) → Run workflow**.
2. Keep `mode = validate-only` and leave `confirm_live_backup` blank.
3. Confirm all secret format checks and AES-256-GCM self-test pass with zero production access.

---

## 6. Isolated Recovery Runbook (NEVER Test Against Production)

> **CRITICAL RULE:** Never run `pg_restore` or Storage uploads against production project `rugwzvztweiffprkxfdc`. Always perform recovery drills against a **brand-new isolated Supabase project**.

### Step 1 — Download and decrypt the backup locally on a trusted private machine
```bash
# Download from Cloudflare R2 / S3 using aws CLI (--endpoint-url ...)
export BACKUP_ENCRYPTION_KEY="<passphrase-from-password-manager>"
mkdir -p ./restore-drill && chmod 700 ./restore-drill
node scripts/backup/verify-and-decrypt.cjs \
  ./backup-YYYY-MM-DDTHH-MM-SSZ.tar.gz.enc \
  --manifest ./backup-YYYY-MM-DDTHH-MM-SSZ.manifest.json \
  --out ./restore-drill/backup.tar.gz
tar -xzf ./restore-drill/backup.tar.gz -C ./restore-drill
```

### Step 2 — Provision a separate isolated recovery Supabase project
1. Create a new Supabase project in the Supabase Dashboard (different project ref from `rugwzvztweiffprkxfdc`).
2. Confirm its database connection string (`RECOVERY_DB_URL` with `?sslmode=require`) belongs to the **new recovery project**, NOT `rugwzvztweiffprkxfdc`.
3. Compare installed extensions in `restore-drill/db/db-inventory.json` and enable any missing extensions in the recovery project first.

### Step 3 — Restore PostgreSQL schemas in safe dependency order
```bash
# Double-check RECOVERY_DB_URL is NOT rugwzvztweiffprkxfdc before proceeding!
# 1) Restore Auth users & identities (data-only into Supabase's pre-created auth schema)
pg_restore --dbname="$RECOVERY_DB_URL" --data-only --disable-triggers --no-owner \
  ./restore-drill/db/auth-full.dump

# 2) Restore public & private schemas (tables, RLS policies, functions, triggers, data)
pg_restore --dbname="$RECOVERY_DB_URL" --no-owner --clean --if-exists \
  ./restore-drill/db/public-private-full.dump

# 3) Restore Storage bucket definitions & object metadata
pg_restore --dbname="$RECOVERY_DB_URL" --data-only --disable-triggers --no-owner \
  ./restore-drill/db/storage-schema-full.dump
```
*(Note: review any warnings from `pg_restore` carefully — especially Supabase-managed sequences or internal constraints in `auth`/`storage` — and inspect `restore-drill/db/public-private-schema.sql` if schema reconciliation is needed.)*

### Step 4 — Restore Storage binary files to the isolated recovery project
1. Confirm every bucket listed in `restore-drill/storage/buckets.json` exists with `public: false` and matching file size / MIME limits.
2. Upload each file from `restore-drill/storage/files/<bucket>/<path>` to the recovery project's Storage API using the recovery project's service-role key, verifying SHA-256 against `restore-drill/storage/storage-inventory.json`.

### Step 5 — Redeploy Edge Functions & secrets on the recovery project
1. Deploy all Edge Functions from `supabase/functions/` to the recovery project.
2. Re-enter Edge Function secrets (`RESEND_API_KEY`, `APP_URL`, etc.) and Auth redirect URLs from your offline password manager.

### Step 6 — Post-restore verification checklist (on the isolated recovery project)
- [ ] Row counts in `public.clients`, `public.workouts`, `public.profiles`, `public.coach_notes_secure`, `public.coach_messages`, `public.program_templates`, and `auth.users` match `restore-drill/db/db-inventory.json`.
- [ ] RLS is enabled on all private/user tables and coach/client access isolation works.
- [ ] Existing coach and client accounts can sign in using their existing passwords.
- [ ] Private videos/printouts generate valid signed URLs and play/open correctly.
- [ ] Delete local `./restore-drill` directory (`rm -rf ./restore-drill`) after verification so unencrypted data does not remain on disk.

---

## 7. Enabling Scheduled Daily Backups (Only After Approval & First Verified Run)

1. Confirm the `validate-only` workflow run passes.
2. Set GitHub Repository Variable `ENABLE_SUPABASE_BACKUP` to `true`.
3. Run one manual `live-backup` (entering `RUN_BACKUP`) and verify the encrypted archive appears in your external bucket.
4. Download that encrypted archive and run `verify-and-decrypt.cjs` locally (and perform an isolated restore drill on a separate test Supabase project).
5. Only then uncomment the `schedule:` block in `.github/workflows/supabase-backup.yml` so daily backups run automatically.
