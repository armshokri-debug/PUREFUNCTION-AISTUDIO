import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ALLOWED_QA_PROJECT_REF,
  FORBIDDEN_PRODUCTION_PROJECT_REF,
  ALLOWED_REPOSITORY,
  FORBIDDEN_PRIVILEGED_ENV_VARS,
  QaGuardError,
  extractSecretCandidatesFromEnv,
  redactSecrets,
  assertQaProjectRef,
  validateQaApiUrl,
  validateQaReadOnlyDbUrl,
  validateQaReadOnlyAuditEnv,
  assertReadOnlySql,
  assertRuntimeReadOnlySession
} = require('./qa-guard.cjs');

const {
  CATALOG_AUDIT_SQL,
  STORAGE_BUCKETS_AUDIT_SQL,
  loadReferenceExpectations,
  buildReadOnlyTransactionWrapper,
  buildPsqlChildEnv,
  inspectQaCatalog,
  compareCatalogToReference,
  formatParityReport,
  main
} = require('./audit-qa-parity.cjs');

const workflowPath = path.resolve(process.cwd(), '.github/workflows/qa-audit.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');

const VALID_DIRECT_RO_URL = `postgresql://qa_readonly:qa_test_secret_123@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
const VALID_POOLER_RO_URL = `postgresql://qa_readonly.${ALLOWED_QA_PROJECT_REF}:qa_test_secret_123@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
const VALID_QA_API_URL = `https://${ALLOWED_QA_PROJECT_REF}.supabase.co`;

function buildMatchingLiveCatalog(reference, { storageBucketsAccessible = true } = {}) {
  return {
    session: {
      current_user: 'qa_readonly',
      current_database: 'postgres',
      transaction_read_only: 'on',
      statement_timeout: '15s',
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      has_pg_read_all_data: false,
      storage_buckets_accessible: storageBucketsAccessible
    },
    tables: reference.tables.map((t) => ({
      schema: t.schema,
      table: t.table,
      rls_enabled: true,
      rls_forced: false
    })),
    columns: reference.columns.map((c) => ({ ...c })),
    constraints: reference.constraints.map((c) => ({ ...c, contype: 'c' })),
    functions: reference.functions.map((f) => ({
      schema: f.schema,
      proname: f.proname,
      security_definer: false,
      identity_args: ''
    })),
    triggers: reference.triggers.map((t) => ({
      schema: t.schema,
      table: t.table,
      name: t.name,
      enabled: 'O'
    })),
    policies: reference.policies.map((p) => ({
      schemaname: p.schemaname,
      tablename: p.tablename,
      policyname: p.policyname,
      cmd: p.cmd,
      permissive: 'PERMISSIVE',
      roles: [...p.roles]
    })),
    program_templates_direct_update_grants: [],
    storage_buckets: reference.storageBuckets.map((b) => ({
      id: b.id,
      name: b.id,
      public: false,
      file_size_limit: null,
      allowed_mime_types: null
    }))
  };
}

describe('qa-guard — strict QA targeting and Production rejection', () => {
  it('accepts only the approved QA project ref and rejects Production or unknown refs', () => {
    expect(assertQaProjectRef(ALLOWED_QA_PROJECT_REF)).toBe(ALLOWED_QA_PROJECT_REF);

    expect(() => assertQaProjectRef(FORBIDDEN_PRODUCTION_PROJECT_REF)).toThrow(/Production/i);
    expect(() => assertQaProjectRef(FORBIDDEN_PRODUCTION_PROJECT_REF.toUpperCase())).toThrow(/Production/i);
    expect(() => assertQaProjectRef('someotherprojectref0')).toThrow(QaGuardError);
    expect(() => assertQaProjectRef('')).toThrow(QaGuardError);
    expect(() => assertQaProjectRef(undefined)).toThrow(QaGuardError);
  });

  it('rejects Production URLs, mismatched hosts, privileged roles, insecure SSL, and missing passwords', () => {
    const directMeta = validateQaReadOnlyDbUrl(VALID_DIRECT_RO_URL);
    expect(directMeta).toMatchObject({
      projectRef: ALLOWED_QA_PROJECT_REF,
      baseRole: 'qa_readonly',
      connectionMode: 'direct',
      sslmode: 'require'
    });
    expect(directMeta.password).toBeUndefined();

    const poolerMeta = validateQaReadOnlyDbUrl(VALID_POOLER_RO_URL);
    expect(poolerMeta).toMatchObject({
      projectRef: ALLOWED_QA_PROJECT_REF,
      baseRole: 'qa_readonly',
      connectionMode: 'pooler'
    });

    // Reject Production direct & pooler URLs
    const prodDirect = `postgresql://supabase_read_only_user:secret@db.${FORBIDDEN_PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
    const prodPooler = `postgresql://supabase_read_only_user.${FORBIDDEN_PRODUCTION_PROJECT_REF}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
    expect(() => validateQaReadOnlyDbUrl(prodDirect)).toThrow(/Production/i);
    expect(() => validateQaReadOnlyDbUrl(prodPooler)).toThrow(/Production/i);

    // Reject privileged database roles (never fall back to postgres / admin roles)
    for (const role of ['postgres', 'supabase_admin', 'service_role', 'authenticator', 'supabase_auth_admin']) {
      const privDirect = `postgresql://${role}:secret@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
      const privPooler = `postgresql://${role}.${ALLOWED_QA_PROJECT_REF}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
      expect(() => validateQaReadOnlyDbUrl(privDirect)).toThrow(/privileged database role/i);
      expect(() => validateQaReadOnlyDbUrl(privPooler)).toThrow(/privileged database role/i);
    }

    // Reject unknown non-readonly role
    const randomRole = `postgresql://app_writer:secret@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
    expect(() => validateQaReadOnlyDbUrl(randomRole)).toThrow(/not an approved read-only audit role/i);

    // Reject pooler username for another project
    const wrongPooler = `postgresql://supabase_read_only_user.wrongprojectref0000:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
    expect(() => validateQaReadOnlyDbUrl(wrongPooler)).toThrow(/scoped to QA project/i);

    // Reject arbitrary host
    const wrongHost = 'postgresql://supabase_read_only_user:secret@localhost:5432/postgres?sslmode=require';
    expect(() => validateQaReadOnlyDbUrl(wrongHost)).toThrow(/database host must target QA/i);

    // Reject insecure sslmode and empty password
    const noSsl = `postgresql://supabase_read_only_user:secret@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres?sslmode=disable`;
    const noPass = `postgresql://supabase_read_only_user@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
    expect(() => validateQaReadOnlyDbUrl(noSsl)).toThrow(/insecure sslmode/i);
    expect(() => validateQaReadOnlyDbUrl(noPass)).toThrow(/must include a password/i);

    // Ensure errors never leak credentials
    const secretMarker = 'super_secret_qa_password_999';
    try {
      validateQaReadOnlyDbUrl(`postgresql://postgres:${secretMarker}@db.${ALLOWED_QA_PROJECT_REF}.supabase.co:5432/postgres`);
    } catch (err) {
      expect(err.message).not.toContain(secretMarker);
    }
  });

  it('validates optional QA API URL and rejects Production or mismatched URLs', () => {
    expect(validateQaApiUrl(VALID_QA_API_URL)).toBe(VALID_QA_API_URL);
    expect(() => validateQaApiUrl(`https://${FORBIDDEN_PRODUCTION_PROJECT_REF}.supabase.co`)).toThrow(/Production/i);
    expect(() => validateQaApiUrl(`http://${ALLOWED_QA_PROJECT_REF}.supabase.co`)).toThrow(/https/i);
    expect(() => validateQaApiUrl(`https://${ALLOWED_QA_PROJECT_REF}.supabase.co/rest/v1`)).toThrow(/bare QA project origin/i);
  });

  it('refuses to run if any Production or privileged env var is provided (zero fallback)', () => {
    const validEnv = {
      GITHUB_REPOSITORY: ALLOWED_REPOSITORY,
      QA_SUPABASE_PROJECT_REF: ALLOWED_QA_PROJECT_REF,
      QA_SUPABASE_READONLY_DB_URL: VALID_DIRECT_RO_URL,
      QA_SUPABASE_URL: VALID_QA_API_URL
    };
    expect(validateQaReadOnlyAuditEnv(validEnv).projectRef).toBe(ALLOWED_QA_PROJECT_REF);

    // Missing required config fails safely
    expect(() => validateQaReadOnlyAuditEnv({})).toThrow(/Missing QA_SUPABASE_PROJECT_REF/i);
    expect(() =>
      validateQaReadOnlyAuditEnv({ QA_SUPABASE_PROJECT_REF: ALLOWED_QA_PROJECT_REF })
    ).toThrow(/Missing QA_SUPABASE_READONLY_DB_URL/i);

    // Wrong repository fails safely
    expect(() =>
      validateQaReadOnlyAuditEnv({ ...validEnv, GITHUB_REPOSITORY: 'other-org/other-repo' })
    ).toThrow(/repository must be/i);

    // Any privileged/fallback env var causes immediate fail-closed abort
    for (const forbiddenVar of FORBIDDEN_PRIVILEGED_ENV_VARS) {
      expect(() =>
        validateQaReadOnlyAuditEnv({
          ...validEnv,
          [forbiddenVar]: 'some-value'
        })
      ).toThrow(new RegExp(`forbidden or privileged credential variable "${forbiddenVar}"`, 'i'));
    }
  });

  it('redacts database URLs, standalone passwords without URL prefix, and secret tokens cleanly', () => {
    const secretCandidates = extractSecretCandidatesFromEnv({
      QA_SUPABASE_READONLY_DB_URL: VALID_POOLER_RO_URL,
      SOME_API_TOKEN: 'tok_secret_value'
    });
    expect(secretCandidates).toContain('qa_test_secret_123');

    const output = redactSecrets(
      `Connection failed for ${VALID_DIRECT_RO_URL}; password auth failed for qa_test_secret_123; PGPASSWORD=qa_test_secret_123; token tok_secret_value`,
      secretCandidates
    );
    expect(output).not.toContain('qa_test_secret_123');
    expect(output).not.toContain('tok_secret_value');
    expect(output).toContain('[REDACTED_DB_URL]');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts standalone password even when main() catches an unexpected non-QaGuardError', () => {
    const errors = [];
    const origError = console.error;
    const origExitCode = process.exitCode;
    console.error = (msg) => errors.push(String(msg));
    try {
      main(
        ['--live'],
        {
          QA_SUPABASE_PROJECT_REF: ALLOWED_QA_PROJECT_REF,
          QA_SUPABASE_READONLY_DB_URL: `postgresql://qa_readonly.${ALLOWED_QA_PROJECT_REF}:standalone%23pw_leak_test@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`
        },
        {
          inspect: () => {
            throw new Error('Unexpected driver crash echoing standalone#pw_leak_test and standalone%23pw_leak_test');
          }
        }
      );
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).not.toContain('standalone#pw_leak_test');
    expect(errors.join('\n')).not.toContain('standalone%23pw_leak_test');
    expect(errors.join('\n')).toContain('[REDACTED]');
  });
});

describe('read-only SQL, Pooler compatibility, & runtime session safety guarantees', () => {
  it('approves CATALOG_AUDIT_SQL and STORAGE_BUCKETS_AUDIT_SQL using pg_catalog only (no information_schema)', () => {
    expect(assertReadOnlySql(CATALOG_AUDIT_SQL)).toBe(true);
    expect(assertReadOnlySql(STORAGE_BUCKETS_AUDIT_SQL)).toBe(true);

    // Must use pg_catalog + has_table_privilege instead of privilege-filtered information_schema views
    expect(CATALOG_AUDIT_SQL).not.toMatch(/\binformation_schema\./i);
    expect(CATALOG_AUDIT_SQL).toContain('pg_catalog.pg_attribute');
    expect(CATALOG_AUDIT_SQL).toContain('pg_catalog.pg_type');
    expect(CATALOG_AUDIT_SQL).toContain('pg_catalog.has_table_privilege');

    // Must never query customer tables, Auth user rows, storage objects, or Vault secrets
    expect(CATALOG_AUDIT_SQL).not.toMatch(/\b(?:FROM|JOIN)\s+(?:public|private|auth|vault)\./i);
    expect(CATALOG_AUDIT_SQL).not.toMatch(/\bstorage\.objects\b/i);
  });

  it('uses Pooler-compatible BEGIN TRANSACTION READ ONLY + SET LOCAL statement_timeout with no PGOPTIONS', () => {
    const wrapped = buildReadOnlyTransactionWrapper(CATALOG_AUDIT_SQL);
    expect(wrapped.startsWith("BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '15000';\n")).toBe(true);
    expect(wrapped.endsWith('\nROLLBACK;\n')).toBe(true);

    const dbMeta = validateQaReadOnlyDbUrl(VALID_POOLER_RO_URL);
    const childEnv = buildPsqlChildEnv(dbMeta, 'qa_test_secret_123', {
      PATH: '/usr/bin',
      HOME: '/tmp',
      PGOPTIONS: '-c default_transaction_read_only=off',
      SUPABASE_SERVICE_ROLE_KEY: 'should-not-leak'
    });
    expect(childEnv.PGOPTIONS).toBeUndefined();
    expect(childEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(childEnv.PGHOST).toBe('aws-0-eu-central-1.pooler.supabase.com');
    expect(childEnv.PGUSER).toBe(`qa_readonly.${ALLOWED_QA_PROJECT_REF}`);
    expect(childEnv.PGSSLMODE).toBe('require');
  });

  it('rejects mutating, DDL, DCL, multi-statement, unqualified table names, comma-joins, and dangerous functions', () => {
    const dangerousQueries = [
      'INSERT INTO public.clients VALUES (1)',
      'UPDATE public.clients SET data = \'{}\'',
      'DELETE FROM public.clients',
      'DROP TABLE public.clients',
      'ALTER TABLE public.clients DISABLE ROW LEVEL SECURITY',
      'CREATE TABLE public.evil(id int)',
      'TRUNCATE public.workouts',
      'GRANT ALL ON public.clients TO anon',
      'REVOKE ALL ON public.clients FROM authenticated',
      'SET ROLE postgres',
      'DO $$ BEGIN RAISE NOTICE \'x\'; END $$',
      'SELECT 1 FROM pg_catalog.pg_class; DROP TABLE public.clients',
      '/* comment */ DELETE FROM pg_catalog.pg_class',
      'SELECT * FROM public.clients',
      'SELECT * FROM auth.users',
      'SELECT * FROM storage.objects',
      'SELECT * FROM vault.decrypted_secrets',
      // Unschema-qualified table names (bypass defense)
      'SELECT * FROM clients',
      'SELECT * FROM "clients"',
      'SELECT * FROM pg_catalog.pg_class JOIN clients ON true',
      'SELECT * FROM ONLY clients',
      // Quoted forbidden schema-qualified relation
      'SELECT * FROM "public"."clients"',
      // Comma-join injection
      'SELECT * FROM pg_catalog.pg_class c, clients',
      'SELECT * FROM pg_catalog.pg_class c, public.clients',
      // Removed information_schema views
      'SELECT * FROM information_schema.columns',
      'SELECT * FROM information_schema.role_table_grants',
      // Dangerous functions
      'SELECT set_config(\'transaction_read_only\', \'off\', true) FROM pg_catalog.pg_roles',
      'SELECT pg_read_file(\'/etc/passwd\') FROM pg_catalog.pg_roles'
    ];

    for (const sql of dangerousQueries) {
      expect(() => assertReadOnlySql(sql)).toThrow(QaGuardError);
    }
  });

  it('verifies runtime PostgreSQL session confirms read-only transaction, non-privileged role, and NO pg_read_all_data', () => {
    expect(
      assertRuntimeReadOnlySession({
        current_user: 'qa_readonly',
        transaction_read_only: 'on',
        statement_timeout: '15s',
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        has_pg_read_all_data: false
      })
    ).toEqual({
      currentUser: 'qa_readonly',
      transactionReadOnly: 'on',
      statementTimeout: '15s',
      hasPgReadAllData: false
    });

    expect(() =>
      assertRuntimeReadOnlySession({
        current_user: 'qa_readonly',
        transaction_read_only: 'off',
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        has_pg_read_all_data: false
      })
    ).toThrow(/transaction_read_only=on/i);

    expect(() =>
      assertRuntimeReadOnlySession({
        current_user: 'qa_readonly',
        transaction_read_only: 'on',
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        has_pg_read_all_data: true
      })
    ).toThrow(/pg_read_all_data/i);

    expect(() =>
      assertRuntimeReadOnlySession({
        current_user: 'postgres',
        transaction_read_only: 'on',
        rolsuper: true,
        rolcreaterole: true,
        rolcreatedb: true,
        has_pg_read_all_data: false
      })
    ).toThrow(/privileged attributes/i);
  });

  it('executes inspectQaCatalog with read-only SQL only, handles inaccessible storage.buckets as UNKNOWN, and never calls runner on invalid env', () => {
    const reference = loadReferenceExpectations(process.cwd());
    const catalogWithBuckets = buildMatchingLiveCatalog(reference, { storageBucketsAccessible: true });
    const bucketsPayload = catalogWithBuckets.storage_buckets;
    const seenCalls = [];

    const resultWithBuckets = inspectQaCatalog({
      env: {
        QA_SUPABASE_PROJECT_REF: ALLOWED_QA_PROJECT_REF,
        QA_SUPABASE_READONLY_DB_URL: VALID_POOLER_RO_URL
      },
      runPsql: ({ dbMeta, sql }) => {
        seenCalls.push({ host: dbMeta.host, baseRole: dbMeta.baseRole, sql });
        assertReadOnlySql(sql);
        if (sql === STORAGE_BUCKETS_AUDIT_SQL) {
          return JSON.stringify(bucketsPayload);
        }
        return JSON.stringify(catalogWithBuckets);
      }
    });

    expect(seenCalls).toHaveLength(2);
    expect(seenCalls[0].host).toBe('aws-0-eu-central-1.pooler.supabase.com');
    expect(seenCalls[0].baseRole).toBe('qa_readonly');
    expect(resultWithBuckets.verifiedSession.transactionReadOnly).toBe('on');
    expect(resultWithBuckets.verifiedSession.hasPgReadAllData).toBe(false);
    expect(resultWithBuckets.catalog.storage_buckets_status).toBe('VERIFIED');

    // When storage.buckets is inaccessible, do NOT execute Query 2 and mark UNKNOWN (never PASS)
    const catalogNoBucketAccess = buildMatchingLiveCatalog(reference, { storageBucketsAccessible: false });
    const noBucketCalls = [];
    const resultUnknownBuckets = inspectQaCatalog({
      env: {
        QA_SUPABASE_PROJECT_REF: ALLOWED_QA_PROJECT_REF,
        QA_SUPABASE_READONLY_DB_URL: VALID_POOLER_RO_URL
      },
      runPsql: ({ sql }) => {
        noBucketCalls.push(sql);
        assertReadOnlySql(sql);
        return JSON.stringify(catalogNoBucketAccess);
      }
    });

    expect(noBucketCalls).toHaveLength(1);
    expect(resultUnknownBuckets.catalog.storage_buckets_status).toBe('UNKNOWN');
    expect(resultUnknownBuckets.catalog.storage_buckets).toBeNull();

    const unknownReport = compareCatalogToReference(resultUnknownBuckets.catalog, reference);
    expect(unknownReport.parityStatus).toBe('UNKNOWN_INCOMPLETE_VISIBILITY');
    expect(unknownReport.inParity).toBe(false);
    expect(unknownReport.counts.storageBucketsStatus).toBe('UNKNOWN');
    expect(unknownReport.unknownFindings.length).toBeGreaterThan(0);

    const formattedUnknown = formatParityReport(unknownReport);
    expect(formattedUnknown).toContain('UNKNOWN_INCOMPLETE_VISIBILITY');
    expect(formattedUnknown).toContain('NOT treated as PASS');

    // Invalid Production env aborts BEFORE runner is invoked
    let calledOnProd = false;
    expect(() =>
      inspectQaCatalog({
        env: {
          QA_SUPABASE_PROJECT_REF: FORBIDDEN_PRODUCTION_PROJECT_REF,
          QA_SUPABASE_READONLY_DB_URL: VALID_DIRECT_RO_URL
        },
        runPsql: () => {
          calledOnProd = true;
          return '{}';
        }
      })
    ).toThrow(/Production/i);
    expect(calledOnProd).toBe(false);
  });
});

describe('audit-qa-parity — reference loading, provenance labels, and diff accuracy', () => {
  it('loads canonical Production reference (2026-11-13 + 2026-11-14 delta) with explicit staleness labels', () => {
    const reference = loadReferenceExpectations(process.cwd());
    expect(reference.tables).toHaveLength(20);
    expect(reference.functions).toHaveLength(40);
    expect(reference.triggers).toHaveLength(15);
    expect(reference.policies).toHaveLength(60);
    expect(reference.storageBuckets.map((b) => b.id)).toEqual([
      'client-videos',
      'exercise-videos',
      'inbody-printouts',
      'message-media'
    ]);

    const statuses = reference.referenceProvenance.map((p) => p.status);
    expect(statuses).toContain('OUTDATED_HISTORICAL_SNAPSHOT');
    expect(statuses).toContain('ARCHIVED_APPLIED_DELTA');
    expect(statuses).toContain('PARTIALLY_INFERRED_UNVERIFIED');
    expect(statuses).toContain('UNVERIFIED_OUT_OF_SCOPE');
    expect(statuses).toContain('EXCLUDED_DRIFTED_LEGACY');
  });

  it('reports zero drift on a matching synthetic QA catalog', () => {
    const reference = loadReferenceExpectations(process.cwd());
    const matching = buildMatchingLiveCatalog(reference);
    const report = compareCatalogToReference(matching, reference);

    expect(report.inParity).toBe(true);
    expect(report.criticalSecurityFindings).toHaveLength(0);
    expect(report.counts.missingTables).toBe(0);
    expect(report.counts.missingFunctions).toBe(0);
    expect(report.counts.missingTriggers).toBe(0);
    expect(report.counts.missingPolicies).toBe(0);
    expect(report.counts.missingStorageBuckets).toBe(0);
  });

  it('detects missing tables, functions, disabled RLS, public buckets, and direct UPDATE grants', () => {
    const reference = loadReferenceExpectations(process.cwd());
    const drifted = buildMatchingLiveCatalog(reference);

    drifted.tables = drifted.tables.filter((t) => !(t.schema === 'public' && t.table === 'coach_notes_secure'));
    drifted.tables.find((t) => t.schema === 'public' && t.table === 'clients').rls_enabled = false;
    drifted.functions = drifted.functions.filter((f) => f.proname !== 'pf_update_program_template');
    drifted.triggers = drifted.triggers.filter((t) => t.name !== 'program_templates_guard_update');
    drifted.policies = drifted.policies.filter((p) => p.policyname !== 'coach templates deny direct update');
    drifted.program_templates_direct_update_grants = [{ grantee: 'authenticated', privilege_type: 'UPDATE' }];
    drifted.storage_buckets = drifted.storage_buckets
      .filter((b) => b.id !== 'message-media')
      .map((b) => (b.id === 'inbody-printouts' ? { ...b, public: true } : b));

    const report = compareCatalogToReference(drifted, reference);
    expect(report.inParity).toBe(false);
    expect(report.diffs.tables.missing).toEqual(['public.coach_notes_secure']);
    expect(report.diffs.tablesWithoutRls).toEqual(['public.clients']);
    expect(report.diffs.functions.missing).toEqual(['public.pf_update_program_template']);
    expect(report.diffs.triggers.missing).toEqual(['public.program_templates::program_templates_guard_update']);
    expect(report.diffs.policies.missing).toEqual(['public.program_templates::coach templates deny direct update']);
    expect(report.diffs.storageBuckets.missing).toEqual(['message-media']);
    expect(report.diffs.storageBuckets.publicBuckets).toEqual(['inbody-printouts']);
    expect(report.diffs.unexpectedProgramTemplatesUpdateGrants).toEqual(['authenticated:UPDATE']);
    expect(report.criticalSecurityFindings.length).toBeGreaterThanOrEqual(3);

    const formatted = formatParityReport(report);
    expect(formatted).toContain('OUTDATED_HISTORICAL_SNAPSHOT');
    expect(formatted).toContain('UNVERIFIED_OUT_OF_SCOPE');
    expect(formatted).toContain('public.coach_notes_secure');
    expect(formatted).toContain('inbody-printouts');
    expect(formatted).not.toContain(FORBIDDEN_PRODUCTION_PROJECT_REF);
  });
});

describe('.github/workflows/qa-audit.yml — workflow security policy', () => {
  it('is manual-only, QA-locked, read-only, and free of Production or privileged credentials', () => {
    expect(workflowText).toContain('workflow_dispatch:');
    expect(workflowText).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(workflowText).toContain(ALLOWED_REPOSITORY);
    expect(workflowText).toContain(ALLOWED_QA_PROJECT_REF);
    expect(workflowText).toContain('QA_SUPABASE_READONLY_DB_URL');
    expect(workflowText).toContain('scripts/qa/qa-audit.test.mjs');
    expect(workflowText).toContain('scripts/qa/audit-qa-parity.cjs');

    const activeLines = workflowText
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(activeLines).not.toContain(FORBIDDEN_PRODUCTION_PROJECT_REF);
    expect(activeLines).not.toMatch(
      /\b(SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|QA_SUPABASE_DB_URL|QA_SUPABASE_SERVICE_ROLE_KEY|QA_SUPABASE_ACCESS_TOKEN)\b/
    );
    expect(activeLines).not.toMatch(/\b(functions\s+deploy|db\s+push|db\s+reset|migration\s+up|psql\s+-f)\b/i);
  });
});
