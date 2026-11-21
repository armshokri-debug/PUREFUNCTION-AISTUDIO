import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import discovery from './schema-discovery.cjs';

const {
  METADATA_ONLY_DISCOVERY_SQL,
  STORAGE_BUCKETS_METADATA_SQL,
  assertMetadataOnlyDiscoverySql,
  buildWrappedReadOnlyDiscoverySql,
  scanDdlForSensitiveContent,
  compareSchemaSnapshots,
  formatComparisonMarkdown
} = discovery;

describe('TASK B: Schema-only discovery SQL safety & zero-data guarantees', () => {
  it('validates both metadata-only discovery SQL queries against strict catalog allowlist', () => {
    expect(assertMetadataOnlyDiscoverySql(METADATA_ONLY_DISCOVERY_SQL)).toBe(true);
    expect(assertMetadataOnlyDiscoverySql(STORAGE_BUCKETS_METADATA_SQL)).toBe(true);

    const wrapped = buildWrappedReadOnlyDiscoverySql(METADATA_ONLY_DISCOVERY_SQL);
    expect(wrapped).toMatch(/^BEGIN TRANSACTION READ ONLY;/);
    expect(wrapped).toContain("SET LOCAL statement_timeout = '15000';");
    expect(wrapped.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });

  it('blocks raw DDL body exports, write SQL, and application/auth/vault/storage.objects reads', () => {
    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p')
    ).toThrow(/raw DDL export/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT p.prosrc FROM pg_catalog.pg_proc p')
    ).toThrow(/raw DDL export/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM public.clients')
    ).toThrow(/not on the metadata-only catalog allowlist/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM auth.users')
    ).toThrow(/not on the metadata-only catalog allowlist/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM storage.objects')
    ).toThrow(/not on the metadata-only catalog allowlist/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM vault.decrypted_secrets')
    ).toThrow(/not on the metadata-only catalog allowlist/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM private.settings')
    ).toThrow(/not on the metadata-only catalog allowlist/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('DELETE FROM pg_catalog.pg_class')
    ).toThrow(/must begin with SELECT or WITH/i);

    expect(() =>
      assertMetadataOnlyDiscoverySql('SELECT * FROM pg_class')
    ).toThrow(/unschema-qualified relation/i);
  });

  it('passes CLI --validate-only with zero database execution', () => {
    const scriptPath = path.resolve(process.cwd(), 'scripts/qa/schema-discovery.cjs');
    const out = execFileSync(process.execPath, [scriptPath, '--validate-only'], { encoding: 'utf8' });
    expect(out).toContain('PASS: Schema-only discovery tooling validated locally');
    expect(out).toContain('Zero database calls executed');
  });
});

describe('TASK B: Controlled manual DDL sensitive-content scanner', () => {
  it('flags Production project ref, real emails, external URLs, tokens, cron/Vault refs, and data inserts', () => {
    const unsafeDdl = [
      '-- Candidate baseline',
      "CREATE TABLE public.test_t (id uuid DEFAULT gen_random_uuid());",
      "CREATE FUNCTION private.bad_fn() RETURNS text AS $$ SELECT 'https://rugwzvztweiffprkxfdc.supabase.co'; $$ LANGUAGE sql;",
      "-- owner email: realperson@gmail.com",
      "SELECT cron.schedule('daily', '0 8 * * *', 'SELECT net.http_post(...)');",
      "SELECT decrypted_secret FROM vault.decrypted_secrets;",
      "INSERT INTO private.coach_allowlist VALUES ('coach@realdomain.org');",
      "-- leaked key re_live_1234567890abcdef"
    ].join('\n');

    const scan = scanDdlForSensitiveContent(unsafeDdl);
    expect(scan.safeForQaBaseline).toBe(false);
    expect(scan.requiresManualReview).toBe(true);
    const categories = new Set(scan.findings.map((f) => f.category));
    expect(categories.has('PRODUCTION_PROJECT_REF')).toBe(true);
    expect(categories.has('REAL_EMAIL_ADDRESS')).toBe(true);
    expect(categories.has('EXTERNAL_URL')).toBe(true);
    expect(categories.has('CRON_OR_VAULT_REFERENCE')).toBe(true);
    expect(categories.has('DATA_MODIFICATION_STATEMENT')).toBe(true);
    expect(categories.has('EMBEDDED_SECRET_OR_TOKEN')).toBe(true);
  });

  it('passes clean schema-only DDL with synthetic .invalid placeholders only', () => {
    const cleanDdl = [
      'CREATE SCHEMA IF NOT EXISTS private;',
      'CREATE TABLE public.example_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL);',
      'ALTER TABLE public.example_items ENABLE ROW LEVEL SECURITY;',
      '-- Synthetic placeholder only: coach@qa.invalid'
    ].join('\n');

    const scan = scanDdlForSensitiveContent(cleanDdl);
    expect(scan.safeForQaBaseline).toBe(true);
    expect(scan.counts.total).toBe(0);
  });
});

describe('TASK B: Machine-readable QA parity comparator', () => {
  const baseProd = {
    label: 'prod-metadata-2026-11-20',
    tables: [
      { schema: 'public', table: 'clients', rls_enabled: true, rls_forced: false },
      { schema: 'public', table: 'workouts', rls_enabled: true, rls_forced: false },
      { schema: 'public', table: 'program_templates', rls_enabled: true, rls_forced: false }
    ],
    columns: [
      { schema: 'public', table: 'clients', column: 'id', udt_name: 'text', is_nullable: false, has_default: false, default_sha256: null },
      { schema: 'public', table: 'clients', column: 'coach_id', udt_name: 'uuid', is_nullable: false, has_default: false, default_sha256: null }
    ],
    functions: [
      { schema: 'private', proname: 'link_user', identity_args: 'uid uuid, user_email text, user_name text', security_definer: true, has_search_path_config: true, anon_execute: false },
      { schema: 'public', proname: 'pf_update_program_template', identity_args: 'p_id text, p_data jsonb, p_expected_data jsonb', security_definer: true, has_search_path_config: true, anon_execute: false }
    ],
    triggers: [
      { schema: 'public', table: 'clients', name: 'trg_guard_client_email', enabled: 'O' }
    ],
    policies: [
      { schema: 'public', table: 'clients', policyname: 'clients scoped read', cmd: 'SELECT', roles: ['authenticated'], qual_sha256: 'abc123', with_check_sha256: null }
    ],
    constraints: [
      { schema: 'public', table: 'clients', name: 'clients_pkey', contype: 'p' }
    ],
    indexes: [
      { schema: 'public', table: 'clients', index: 'clients_pkey', is_unique: true }
    ],
    extensions: [
      { extname: 'pgcrypto', schema: 'extensions' }
    ],
    storage_buckets_status: 'VERIFIED',
    storage_buckets: [
      { id: 'exercise-videos', public: false },
      { id: 'client-videos', public: false }
    ],
    table_privileges: [
      {
        schema: 'public',
        table: 'program_templates',
        anon_select: false,
        anon_insert: false,
        anon_update: false,
        anon_delete: false,
        authenticated_select: true,
        authenticated_insert: true,
        authenticated_update: false,
        authenticated_delete: true,
        public_update: false
      }
    ]
  };

  it('reports PARITY_VERIFIED when QA metadata matches Production reference completely', () => {
    const report = compareSchemaSnapshots(baseProd, structuredClone(baseProd), {
      now: () => '2026-11-20T00:00:00.000Z'
    });
    expect(report.parityStatus).toBe('PARITY_VERIFIED');
    expect(report.inParity).toBe(true);
    expect(report.securityFindings).toEqual([]);
    const md = formatComparisonMarkdown(report);
    expect(md).toContain('PARITY_VERIFIED');
  });

  it('detects missing tables, RLS disabled, public bucket, privilege regressions, and policy hash drift', () => {
    const qaDrifted = structuredClone(baseProd);
    qaDrifted.tables = [
      { schema: 'public', table: 'clients', rls_enabled: false, rls_forced: false },
      { schema: 'public', table: 'program_templates', rls_enabled: true, rls_forced: false }
    ];
    qaDrifted.policies[0].qual_sha256 = 'different-hash';
    qaDrifted.storage_buckets = [{ id: 'exercise-videos', public: true }];
    qaDrifted.table_privileges[0].authenticated_update = true;

    const report = compareSchemaSnapshots(baseProd, qaDrifted);
    expect(report.parityStatus).toBe('DRIFT_OR_GAPS_DETECTED');
    expect(report.inParity).toBe(false);
    expect(report.objectDiffs.tables.missing).toEqual(['public.workouts']);
    expect(report.objectDiffs.rlsDrift).toHaveLength(1);
    expect(report.objectDiffs.policies.drift).toHaveLength(1);
    expect(report.objectDiffs.storageBuckets.missing).toEqual(['client-videos']);
    expect(report.securityFindings.some((f) => f.includes('RLS disabled in QA on table: public.clients'))).toBe(true);
    expect(report.securityFindings.some((f) => f.includes('Storage bucket is public in QA'))).toBe(true);
    expect(report.securityFindings.some((f) => f.includes('Direct UPDATE privilege regression'))).toBe(true);
  });

  it('reports UNKNOWN_INCOMPLETE_VISIBILITY (never PARITY_VERIFIED) when storage buckets are inaccessible', () => {
    const qaUnknownBuckets = structuredClone(baseProd);
    qaUnknownBuckets.storage_buckets = null;
    qaUnknownBuckets.storage_buckets_status = 'UNKNOWN';

    const report = compareSchemaSnapshots(baseProd, qaUnknownBuckets);
    expect(report.parityStatus).toBe('UNKNOWN_INCOMPLETE_VISIBILITY');
    expect(report.inParity).toBe(false);
    expect(report.summary.storageBuckets.status).toBe('UNKNOWN');
  });
});
