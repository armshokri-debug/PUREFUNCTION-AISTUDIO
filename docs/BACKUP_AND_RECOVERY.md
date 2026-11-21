# Pure Function — Backup & Isolated Recovery Guide

**Target production Supabase project:** `rugwzvztweiffprkxfdc` (Free plan — no scheduled Supabase backups or PITR)  
**Active repository:** `armshokri-debug/PUREFUNCTION-AISTUDIO`  
**Status (2026-11-21):** **ONE LIVE ENCRYPTED BACKUP VERIFIED; EPHEMERAL POSTGRESQL RESTORE PASSED; DAILY AUTOMATION NOT ENABLED.**  
The 2026-11-19 encrypted Google Drive archive and its manifest were verified. GitHub Actions successfully decrypted the archive and restored the database into an ephemeral isolated PostgreSQL instance on 2026-11-21. This is not a full Supabase service-level recovery drill. The repository variable `ENABLE_SUPABASE_BACKUP` is currently `false`, so the daily backup job skips execution. Do not claim continuous backup coverage until the owner enables the gate, an approved new backup is verified, and scheduled runs are confirmed.

---

## Verified evidence (as of 2026-11-21)

- **Live read-only encrypted backup created, 2026-11-19:** [GitHub Actions run 44571268249](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/actions/runs/44571268249). The private Google Drive folder contains the 209,258-byte encrypted archive and a separate integrity manifest. No user data appears in GitHub artifacts.
- **Drive download, decryption, checksum and inventory verified:** [Run 44573705661](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/actions/runs/44573705661).
- **Database restore to an ephemeral isolated PostgreSQL instance passed, 2026-11-21:** [Run 44885726470](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/actions/runs/44885726470). Full live Supabase Auth/Storage service recovery is **not** covered by this test.
- **Fail-closed daily schedule/approval fix merged:** [PR #15](https://github.com/armshokri-debug/PUREFUNCTION-AISTUDIO/pull/15). The job cannot start when `ENABLE_SUPABASE_BACKUP` is unset or false, including on schedule.
- **Remaining release gates:** owner enables the repository variable when approved, new scheduled/backup runs observed, encrypted archive/manifests independently verified, and a complete Supabase service-level recovery drill planned.

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

## 3. Supported External Storage Destinations

The backup system supports two external storage destinations via `BACKUP_STORAGE_PROVIDER`:
- **`gdrive`** — **Google Drive (Personal Gmail, Free 15 GB, No Payment Card Required)**
- **`s3`** — **S3-Compatible Object Storage (Cloudflare R2 / Backblaze B2 / AWS S3)**

### Option A — Google Drive with Personal Gmail (`BACKUP_STORAGE_PROVIDER=gdrive`)

#### Why OAuth 2.0 Refresh Token (and NOT a Service Account)?
- Google Cloud Service Accounts have **0 bytes of Drive storage quota** on personal Gmail accounts (`storageQuotaExceeded`), so Service Accounts cannot upload files to a personal My Drive folder.
- Instead, this backup system uses an **OAuth 2.0 Refresh Token** scoped strictly to **`https://www.googleapis.com/auth/drive.file`** (least privilege: the backup runner can **only** see, upload, and prune files/folders created by this backup app — it can **never** read or modify any of your other personal Drive files).
- Large archives (> 5 MB, including videos) are uploaded via **Google Drive v3 Resumable Uploads** in 8 MiB chunks.

#### Critical Setup Requirements for Unattended GitHub Actions
1. **No payment card required:** Create a free Google Cloud project at `https://console.cloud.google.com/` and enable **Google Drive API**.
2. **OAuth Consent Screen (`In Production` is REQUIRED):**
   - Go to **APIs & Services → OAuth consent screen**.
   - Choose User Type **External**, fill in an app name (e.g. `PureFunction Backup`) and your email.
   - Add scope `https://www.googleapis.com/auth/drive.file` (non-sensitive scope).
   - **CRITICAL:** Click **Publish App** to switch Publishing Status from `Testing` to **`In Production`**.
     - *Why:* Refresh tokens issued while an app is in `Testing` mode **automatically expire after 7 days**, which breaks unattended backups. Switching to `In Production` for personal use does **not** require Google verification — during the one-time authorization, click **Advanced → Go to PureFunction Backup (unsafe)** to approve your own app.
3. **Create OAuth 2.0 Client ID:**
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Choose **Web application**, add `https://developers.google.com/oauthplayground` as an **Authorized redirect URI**, and copy the **Client ID** and **Client Secret**.
4. **Generate your Refresh Token once (via Google OAuth 2.0 Playground):**
   - Open `https://developers.google.com/oauthplayground`.
   - Click the gear icon (⚙️) → check **Use your own OAuth credentials** → paste your Client ID and Client Secret.
   - In Step 1, enter `https://www.googleapis.com/auth/drive.file` and click **Authorize APIs** using your personal Gmail account (click **Advanced → Continue** on the personal unverified app screen).
   - In Step 2, click **Exchange authorization code for tokens** and copy the **`Refresh token`** (starts with `1//...`).
5. **Important note about `PureFunction-Encrypted-Backups` folder ownership:**
   - Under the least-privilege `drive.file` scope, Google Drive API **cannot** write into a folder created manually in the Drive web UI (Google returns `404 Not Found` because the app did not create that folder).
   - **Recommended:** Delete or rename your empty manually-created `PureFunction-Encrypted-Backups` folder in Google Drive, and leave `BACKUP_GDRIVE_FOLDER_ID` **empty** with `BACKUP_GDRIVE_FOLDER_NAME=PureFunction-Encrypted-Backups`. On the first approved live backup, the script automatically creates `PureFunction-Encrypted-Backups` (owned by the app under your Drive) and reuses it on every future run.

### Option B — S3-Compatible Bucket (`BACKUP_STORAGE_PROVIDER=s3`)

- **Cloudflare R2** (10 GB/month free tier, $0 egress; requires card on file), **Backblaze B2**, or **AWS S3**.
- Create a **private** bucket (e.g. `purefunction-prod-backups`) with public access disabled and a bucket-scoped Read/Write key.

---

## 4. Credentials, Secrets & Variables Requiring Owner Approval Before Activation

Configure these in **GitHub → `armshokri-debug/PUREFUNCTION-AISTUDIO` → Settings → Secrets and variables → Actions** only after you approve activation.

### Common Repository Secrets (Required for BOTH Google Drive and S3)
| Secret Name | Value / Purpose |
| --- | --- |
| `SUPABASE_DB_URL` | PostgreSQL Direct or Session Pooler URI for `rugwzvztweiffprkxfdc` ending with `?sslmode=require`. (Tip: for IPv4 GitHub Actions runners, use Supabase **Session Pooler** port `5432` with `?sslmode=require`.) |
| `SUPABASE_URL` | `https://rugwzvztweiffprkxfdc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key — used **only** inside the private Actions runner for read-only Storage export. **Never** put in `VITE_*` variables. |
| `BACKUP_ENCRYPTION_KEY` | Random high-entropy passphrase (at least 32 characters, e.g. `openssl rand -base64 48`). **Save a copy offline in your password manager.** |

### Provider-Specific Repository Secrets

#### If using Google Drive (`BACKUP_STORAGE_PROVIDER=gdrive`):
| Secret Name | Value / Purpose |
| --- | --- |
| `BACKUP_GDRIVE_CLIENT_ID` | Google OAuth Client ID (`*.apps.googleusercontent.com`). |
| `BACKUP_GDRIVE_CLIENT_SECRET` | Google OAuth Client Secret. |
| `BACKUP_GDRIVE_REFRESH_TOKEN` | Long-lived OAuth Refresh Token (`1//...`) issued with `drive.file` scope while Consent Screen is `In Production`. |

#### If using S3 / R2 / B2 (`BACKUP_STORAGE_PROVIDER=s3`):
| Secret Name | Value / Purpose |
| --- | --- |
| `BACKUP_S3_ENDPOINT` | External S3 endpoint URL (e.g. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). |
| `BACKUP_S3_BUCKET` | Private external bucket name (e.g. `purefunction-prod-backups`). |
| `BACKUP_S3_ACCESS_KEY_ID` | Bucket-scoped S3/R2 access key ID. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Bucket-scoped S3/R2 secret access key. |

### Repository Variables (non-secret configuration)
| Variable Name | Recommended Value | Purpose |
| --- | --- | --- |
| `BACKUP_STORAGE_PROVIDER` | `gdrive` (or `s3`) | Selects Google Drive or S3/R2 upload backend. |
| `SUPABASE_PROJECT_REF` | `rugwzvztweiffprkxfdc` | Safety guard matching `SUPABASE_URL` hostname. |
| `BACKUP_GDRIVE_FOLDER_NAME` | `PureFunction-Encrypted-Backups` | Target folder name in Google Drive (used when `BACKUP_GDRIVE_FOLDER_ID` is empty). |
| `BACKUP_GDRIVE_FOLDER_ID` | *(leave empty initially)* | Optional explicit ID of an app-created Drive folder. |
| `BACKUP_S3_REGION` | `auto` | Only needed for `s3` provider (`auto` for Cloudflare R2). |
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
# Download the matching .tar.gz.enc and .manifest.json files from:
# - Google Drive: private folder "PureFunction-Encrypted-Backups" (via Drive web UI), OR
# - Cloudflare R2 / S3: using aws CLI (--endpoint-url ...)
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
3. Run one manual `live-backup` (entering `RUN_BACKUP`) and verify both the encrypted `.tar.gz.enc` archive and `.manifest.json` appear in your Google Drive `PureFunction-Encrypted-Backups` folder (or external S3/R2 bucket).
4. Download that encrypted archive and run `verify-and-decrypt.cjs` locally (and perform an isolated restore drill on a separate test Supabase project).
5. The `schedule:` block is **already enabled** in `.github/workflows/supabase-backup.yml` (`03:17 UTC`), but actual scheduled backup execution is protected by the `ENABLE_SUPABASE_BACKUP=true` repository-variable kill-switch. After the owner deliberately enables that variable, verify the first scheduled run and its new encrypted archive/manifest in the private Drive folder. Do not bypass the kill-switch.
