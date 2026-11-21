# Pure Function — Safe Production Schema-Only Discovery & QA Parity Process

Status: **Tooling Implemented & Locally Validated — NOT Executed Against Production or QA**

## 1. Purpose

QA (`nsshdxxdvzzxlmdomixf`) currently has a major structural gap compared to Production (`rugwzvztweiffprkxfdc`):
- Production live observation: `20` tables, `40` functions, `14` triggers, `46` RLS policies, `4` private Storage buckets, `6` Edge Functions.
- QA live observation: `5` tables, `10` functions, `2` triggers, `13` RLS policies, `0` Storage buckets, `0` Edge Functions.

Historical repository files (`supabase/schema-reference-2026-11-13.json` and `supabase/migrations/`) are **not** sufficient on their own as an authoritative QA baseline because:
1. `schema-reference-2026-11-13.json` predates 2026-11-14+ Production changes and omits `relrowsecurity`, indexes, sequences, extensions, and `storage.buckets` metadata.
2. `supabase/migrations/` drifted from Production history and contains legacy Production-specific values.

## 2. Why Automated Raw-DDL Sanitization Is Prohibited

Function bodies (`pg_get_functiondef` / `prosrc`), column defaults, and RLS expressions in PostgreSQL can embed real email addresses, Production URLs (`rugwzvztweiffprkxfdc.supabase.co`), Vault secret names, or `pg_cron` jobs.

A blind regex search-and-replace over raw DDL is **not** proof of safety. Therefore, `scripts/qa/schema-discovery.cjs` separates discovery into two strict stages:

### Stage 1 — Automated Metadata-Only Discovery (Safe by Construction)
- Run only via an explicit, owner-approved read-only catalog session (`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15000'; ... ROLLBACK;`).
- Exports **only** `pg_catalog` structural metadata and SHA-256 digests (`default_sha256`, `qual_sha256`, `with_check_sha256`).
- **Never** queries application rows (`public.*`), `auth.users`, `storage.objects`, `private.settings`, `private.coach_allowlist`, or `vault.*`.
- **Never** exports raw function bodies (`pg_get_functiondef`, `prosrc`), trigger bodies, or view definitions.
- Generates a machine-readable JSON snapshot that can be safely compared against QA via:
  ```bash
  node scripts/qa/schema-discovery.cjs --compare prod-metadata.json qa-metadata.json --out-json qa-parity.json --out-md qa-parity.md
  ```

### Stage 2 — Controlled Manual DDL Review (Human Sign-Off Required)
When building the actual QA SQL baseline for missing objects:
1. An authorized owner/maintainer extracts schema-only DDL definitions for the missing objects from Production (`--schema-only`, zero data, zero `auth.users`, zero `storage.objects`, zero `private.settings`, zero `pg_cron`).
2. Before any candidate DDL file is saved to the repository or applied to QA, run the static sensitive-content scanner:
   ```bash
   node scripts/qa/schema-discovery.cjs --scan-ddl path/to/candidate-qa-baseline.sql
   ```
3. The scanner **fails closed** on:
   - Production project ref (`rugwzvztweiffprkxfdc`)
   - Database connection strings or token/secret prefixes
   - Non-synthetic email domains (anything outside `.invalid` / `example.com`)
   - External URLs
   - `pg_cron` / `net.http_post` / `vault.*` references
   - Row-data statements (`INSERT INTO`, `COPY`, `UPDATE`, `DELETE FROM`)
4. A human reviewer inspects every remaining DDL block and confirms zero customer data, zero real emails, zero secrets, and zero Production references before approving QA execution.

## 3. Local Offline Commands (Zero Network / Zero DB Access)

```bash
# Validate all discovery SQL against the strict catalog allowlist
node scripts/qa/schema-discovery.cjs --validate-only

# Print the reviewed read-only transaction-wrapped metadata-only SQL
node scripts/qa/schema-discovery.cjs --print-sql

# Scan a candidate DDL file for sensitive content before review
node scripts/qa/schema-discovery.cjs --scan-ddl supabase/proposals/<file>.sql

# Compare two schema-only metadata snapshots offline
node scripts/qa/schema-discovery.cjs --compare prod-metadata.json qa-metadata.json
```

## 4. Approval Gate

- **NOT executed in this session.** Any live read-only Production metadata capture requires explicit owner approval and a least-privilege read-only role (`rolsuper=false`, `rolbypassrls=false`, no `pg_read_all_data`).
