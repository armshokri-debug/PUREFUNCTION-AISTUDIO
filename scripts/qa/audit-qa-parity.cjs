'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ALLOWED_QA_PROJECT_REF,
  QaGuardError,
  extractSecretCandidatesFromEnv,
  redactSecrets,
  validateQaReadOnlyAuditEnv,
  assertReadOnlySql,
  assertRuntimeReadOnlySession
} = require('./qa-guard.cjs');

const SCHEMA_REFERENCE_REL_PATH = path.join('supabase', 'schema-reference-2026-11-13.json');
const TEMPLATE_MIGRATION_REL_PATH = path.join(
  'supabase',
  'recovered_migrations',
  '20261114064338_secure_program_template_editing.sql'
);

const READONLY_STATEMENT_TIMEOUT_MS = '15000';

/**
 * Strictly read-only catalog inspection SQL backed exclusively by pg_catalog
 * and pg_catalog.has_table_privilege.
 * - Does NOT use information_schema views (which filter rows by table grants).
 * - Does NOT require pg_read_all_data or any SELECT grant on customer tables.
 * - Never queries customer rows, auth.users rows, storage.objects rows, or Vault secrets.
 */
const CATALOG_AUDIT_SQL = `
SELECT json_build_object(
  'session', (
    SELECT json_build_object(
      'current_user', current_user,
      'current_database', current_database(),
      'transaction_read_only', current_setting('transaction_read_only'),
      'statement_timeout', current_setting('statement_timeout'),
      'rolsuper', r.rolsuper,
      'rolcreaterole', r.rolcreaterole,
      'rolcreatedb', r.rolcreatedb,
      'rolbypassrls', r.rolbypassrls,
      'has_pg_read_all_data', CASE
        WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles pr WHERE pr.rolname = 'pg_read_all_data')
          THEN pg_catalog.pg_has_role(current_user, 'pg_read_all_data', 'MEMBER')
        ELSE false
      END,
      'storage_buckets_accessible', CASE
        WHEN pg_catalog.to_regclass('storage.buckets') IS NOT NULL
          AND pg_catalog.has_schema_privilege(current_user, 'storage', 'USAGE')
          THEN pg_catalog.has_table_privilege(current_user, 'storage.buckets', 'SELECT')
        ELSE false
      END
    )
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user
  ),
  'tables', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'rls_enabled', c.relrowsecurity,
        'rls_forced', c.relforcerowsecurity
      )
      ORDER BY n.nspname, c.relname
    )
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  ), '[]'::json),
  'columns', COALESCE((
    SELECT json_agg(
      json_build_object(
        'table_schema', n.nspname,
        'table_name', c.relname,
        'column_name', a.attname,
        'udt_name', t.typname,
        'is_nullable', CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END
      )
      ORDER BY n.nspname, c.relname, a.attnum
    )
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), '[]'::json),
  'constraints', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'name', con.conname,
        'contype', con.contype
      )
      ORDER BY n.nspname, c.relname, con.conname
    )
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
  ), '[]'::json),
  'functions', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'proname', p.proname,
        'security_definer', p.prosecdef,
        'identity_args', pg_catalog.pg_get_function_identity_arguments(p.oid)
      )
      ORDER BY n.nspname, p.proname
    )
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
      AND p.prokind = 'f'
  ), '[]'::json),
  'triggers', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'name', t.tgname,
        'enabled', t.tgenabled
      )
      ORDER BY n.nspname, c.relname, t.tgname
    )
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND (
        n.nspname IN ('public', 'private')
        OR (n.nspname = 'auth' AND c.relname = 'users')
      )
  ), '[]'::json),
  'policies', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schemaname', p.schemaname,
        'tablename', p.tablename,
        'policyname', p.policyname,
        'cmd', p.cmd,
        'permissive', p.permissive,
        'roles', p.roles
      )
      ORDER BY p.schemaname, p.tablename, p.policyname
    )
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname IN ('public', 'private', 'storage')
  ), '[]'::json),
  'program_templates_direct_update_grants', COALESCE((
    SELECT json_agg(
      json_build_object(
        'grantee', g.grantee,
        'privilege_type', 'UPDATE'
      )
      ORDER BY g.grantee
    )
    FROM (
      SELECT r.rolname AS grantee
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.rolname IN ('anon', 'authenticated')
      WHERE n.nspname = 'public'
        AND c.relname = 'program_templates'
        AND pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE')
      UNION ALL
      SELECT 'PUBLIC' AS grantee
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'program_templates'
        AND pg_catalog.has_table_privilege('public', c.oid, 'UPDATE')
    ) g
  ), '[]'::json)
)::text;
`.trim();

/**
 * Separate metadata-only query for storage.buckets. Executed ONLY when the
 * least-privilege audit role actually holds USAGE on schema storage and SELECT
 * on storage.buckets; otherwise storage buckets are reported as UNKNOWN (never PASS).
 */
const STORAGE_BUCKETS_AUDIT_SQL = `
SELECT COALESCE((
  SELECT json_agg(
    json_build_object(
      'id', b.id,
      'name', b.name,
      'public', b.public,
      'file_size_limit', b.file_size_limit,
      'allowed_mime_types', b.allowed_mime_types
    )
    ORDER BY b.id
  )
  FROM storage.buckets b
), '[]'::json)::text;
`.trim();

function stripIdentQuotes(value) {
  return String(value || '').replace(/^"|"$/g, '');
}

function parseTriggerName(definition) {
  const match = String(definition || '').match(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+("?[^"\s]+"?)\s+/i);
  return match ? stripIdentQuotes(match[1]) : null;
}

function parseFunctionsFromSql(sqlText) {
  const results = [];
  const regex = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/gi;
  let match;
  while ((match = regex.exec(sqlText)) !== null) {
    results.push({ schema: match[1].toLowerCase(), proname: match[2].toLowerCase() });
  }
  return results;
}

function parseTriggersFromSql(sqlText) {
  const results = [];
  const regex =
    /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+("?[a-z_][a-z0-9_]*"?)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+[^\n;]+?\s+ON\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = regex.exec(sqlText)) !== null) {
    results.push({
      name: stripIdentQuotes(match[1]),
      schema: match[2].toLowerCase(),
      table: match[3].toLowerCase()
    });
  }
  return results;
}

function parsePoliciesFromSql(sqlText) {
  const results = [];
  const regex =
    /CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([a-z_,\s]+?)(?:\s+USING|\s+WITH\s+CHECK|;)/gi;
  let match;
  while ((match = regex.exec(sqlText)) !== null) {
    const roles = match[5]
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    results.push({
      policyname: match[1],
      schemaname: match[2].toLowerCase(),
      tablename: match[3].toLowerCase(),
      cmd: match[4].toUpperCase(),
      roles
    });
  }
  return results;
}

function extractBucketIdsFromStoragePolicies(policies) {
  const buckets = new Set();
  for (const policy of policies) {
    if (policy.schemaname !== 'storage') continue;
    const expr = `${policy.qual || ''} ${policy.with_check || ''}`;
    const regex = /bucket_id\s*=\s*'([^']+)'/gi;
    let match;
    while ((match = regex.exec(expr)) !== null) {
      buckets.add(match[1]);
    }
  }
  return [...buckets].sort();
}

/**
 * Load canonical Production structural expectations from repository reference
 * artifacts and explicitly label outdated, inferred, or unverified aspects.
 */
function loadReferenceExpectations(repoRoot = process.cwd()) {
  const schemaPath = path.join(repoRoot, SCHEMA_REFERENCE_REL_PATH);
  const templateDeltaPath = path.join(repoRoot, TEMPLATE_MIGRATION_REL_PATH);

  if (!fs.existsSync(schemaPath)) {
    throw new QaGuardError(`Required schema reference file not found: ${SCHEMA_REFERENCE_REL_PATH}`);
  }
  if (!fs.existsSync(templateDeltaPath)) {
    throw new QaGuardError(`Required archived migration delta not found: ${TEMPLATE_MIGRATION_REL_PATH}`);
  }

  const rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const templateDeltaSql = fs.readFileSync(templateDeltaPath, 'utf8');

  const tablesMap = new Map();
  const columns = [];
  for (const col of rawSchema.columns || []) {
    const tableKey = `${col.table_schema}.${col.table_name}`;
    if (!tablesMap.has(tableKey)) {
      tablesMap.set(tableKey, { schema: col.table_schema, table: col.table_name });
    }
    columns.push({
      table_schema: col.table_schema,
      table_name: col.table_name,
      column_name: col.column_name,
      data_type: col.data_type,
      udt_name: col.udt_name,
      is_nullable: col.is_nullable
    });
  }

  const functionsMap = new Map();
  for (const fn of rawSchema.functions || []) {
    const key = `${fn.schema}.${fn.proname}`;
    functionsMap.set(key, { schema: fn.schema, proname: fn.proname, source: 'schema-reference-2026-11-13' });
  }
  for (const fn of parseFunctionsFromSql(templateDeltaSql)) {
    const key = `${fn.schema}.${fn.proname}`;
    functionsMap.set(key, { schema: fn.schema, proname: fn.proname, source: 'recovered-migration-2026-11-14' });
  }

  const triggersMap = new Map();
  for (const tr of rawSchema.triggers || []) {
    const name = parseTriggerName(tr.definition);
    if (!name) continue;
    const key = `${tr.schema}.${tr.table}::${name}`;
    triggersMap.set(key, {
      schema: tr.schema,
      table: tr.table,
      name,
      source: 'schema-reference-2026-11-13'
    });
  }
  for (const tr of parseTriggersFromSql(templateDeltaSql)) {
    const key = `${tr.schema}.${tr.table}::${tr.name}`;
    triggersMap.set(key, {
      schema: tr.schema,
      table: tr.table,
      name: tr.name,
      source: 'recovered-migration-2026-11-14'
    });
  }

  const policiesMap = new Map();
  for (const pol of rawSchema.policies || []) {
    const key = `${pol.schemaname}.${pol.tablename}::${pol.policyname}`;
    policiesMap.set(key, {
      schemaname: pol.schemaname,
      tablename: pol.tablename,
      policyname: pol.policyname,
      cmd: String(pol.cmd || '').toUpperCase(),
      roles: [...(pol.roles || [])].map((r) => String(r).toLowerCase()).sort(),
      source: 'schema-reference-2026-11-13'
    });
  }
  for (const pol of parsePoliciesFromSql(templateDeltaSql)) {
    const key = `${pol.schemaname}.${pol.tablename}::${pol.policyname}`;
    policiesMap.set(key, {
      ...pol,
      roles: [...pol.roles].sort(),
      source: 'recovered-migration-2026-11-14'
    });
  }

  const constraintsMap = new Map();
  for (const con of rawSchema.constraints || []) {
    const key = `${con.schema}.${con.table}::${con.name}`;
    constraintsMap.set(key, {
      schema: con.schema,
      table: con.table,
      name: con.name
    });
  }

  const storageBuckets = extractBucketIdsFromStoragePolicies(rawSchema.policies || []).map((id) => ({
    id,
    expectedPublic: false
  }));

  const referenceProvenance = [
    {
      source: SCHEMA_REFERENCE_REL_PATH,
      status: 'OUTDATED_HISTORICAL_SNAPSHOT',
      capturedAt: rawSchema.capturedAt || 'unknown',
      note: 'Captured 2026-11-13; predates 2026-11-14 template editing and any subsequent Production DDL. Does not record relrowsecurity flags or storage.buckets metadata.'
    },
    {
      source: TEMPLATE_MIGRATION_REL_PATH,
      status: 'ARCHIVED_APPLIED_DELTA',
      capturedAt: '2026-11-14',
      note: 'Applied to Production on 2026-11-14 (pf_update_program_template + direct UPDATE revoke). Does not prove absence of later Production changes.'
    },
    {
      source: 'storage.buckets (inferred from storage.objects policies & 2026-11-13 audit)',
      status: 'PARTIALLY_INFERRED_UNVERIFIED',
      capturedAt: '2026-11-13',
      note: 'Bucket IDs and private (public=false) expectation are corroborated by policies and audit notes; live Production file_size_limit and allowed_mime_types are unverified.'
    },
    {
      source: 'Auth configuration & Edge Functions metadata',
      status: 'UNVERIFIED_OUT_OF_SCOPE',
      capturedAt: null,
      note: 'Not included in SQL catalog reference; Auth settings (Site URL, redirect URLs, email verification, leaked-password protection) and Edge Function deployments must be audited separately.'
    },
    {
      source: 'supabase/migrations/',
      status: 'EXCLUDED_DRIFTED_LEGACY',
      capturedAt: null,
      note: 'Intentionally excluded as reference baseline because filenames drifted from Production and legacy files contain Production-specific URLs and emails.'
    }
  ];

  return {
    capturedAt: rawSchema.capturedAt || 'unknown',
    tables: [...tablesMap.values()].sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`)),
    columns,
    functions: [...functionsMap.values()].sort((a, b) =>
      `${a.schema}.${a.proname}`.localeCompare(`${b.schema}.${b.proname}`)
    ),
    triggers: [...triggersMap.values()].sort((a, b) =>
      `${a.schema}.${a.table}::${a.name}`.localeCompare(`${b.schema}.${b.table}::${b.name}`)
    ),
    policies: [...policiesMap.values()].sort((a, b) =>
      `${a.schemaname}.${a.tablename}::${a.policyname}`.localeCompare(`${b.schemaname}.${b.tablename}::${b.policyname}`)
    ),
    constraints: [...constraintsMap.values()].sort((a, b) =>
      `${a.schema}.${a.table}::${a.name}`.localeCompare(`${b.schema}.${b.table}::${b.name}`)
    ),
    storageBuckets,
    programTemplatesDirectUpdateMustBeRevoked: true,
    referenceProvenance
  };
}

/**
 * Wrap a validated read-only SQL statement in an explicit Pooler-compatible
 * read-only transaction with local statement_timeout (no PGOPTIONS startup params).
 */
function buildReadOnlyTransactionWrapper(sql) {
  assertReadOnlySql(sql);
  return `BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '${READONLY_STATEMENT_TIMEOUT_MS}';\n${sql}\nROLLBACK;\n`;
}

/**
 * Build a minimal, scrubbed child environment for psql.
 * Intentionally omits PGOPTIONS for Supabase Pooler (Supavisor) compatibility
 * and passes credentials via PG* env vars rather than CLI argv.
 */
function buildPsqlChildEnv(dbMeta, password, baseEnv = process.env) {
  return {
    PATH: (baseEnv && baseEnv.PATH) || '/usr/bin:/bin',
    HOME: (baseEnv && baseEnv.HOME) || '/tmp',
    PGHOST: dbMeta.host,
    PGPORT: String(dbMeta.port),
    PGDATABASE: dbMeta.database,
    PGUSER: dbMeta.username,
    PGPASSWORD: password,
    PGSSLMODE: dbMeta.sslmode || 'require',
    PGCONNECT_TIMEOUT: '15'
  };
}

/**
 * Default read-only psql executor.
 * - Passes DB credentials via PG* environment variables only (never in argv).
 * - Does NOT set PGOPTIONS (incompatible with Supabase Pooler / Supavisor).
 * - Wraps query in explicit BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout; ... ROLLBACK;.
 * - Strips all unrelated/privileged environment variables from child process.
 */
function defaultRunPsqlReadOnly({ dbMeta, password, sql, secretCandidates = [] }) {
  const wrappedSql = buildReadOnlyTransactionWrapper(sql);
  const childEnv = buildPsqlChildEnv(dbMeta, password);

  try {
    const stdout = execFileSync(
      'psql',
      ['--no-psqlrc', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
      {
        input: wrappedSql,
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        shell: false
      }
    );
    return stdout;
  } catch (err) {
    const safeMsg = redactSecrets(
      err && err.stderr ? String(err.stderr) : String((err && err.message) || ''),
      [password, ...secretCandidates]
    );
    throw new QaGuardError(`Read-only QA catalog query failed: ${safeMsg.trim() || 'psql execution error'}`);
  }
}

function extractLastJsonValue(rawOutput, expectedPrefix, expectedSuffix) {
  return String(rawOutput || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(expectedPrefix) && line.endsWith(expectedSuffix))
    .pop();
}

/**
 * Inspect live QA PostgreSQL catalog strictly in read-only mode.
 */
function inspectQaCatalog({ env = process.env, runPsql = defaultRunPsqlReadOnly } = {}) {
  const validated = validateQaReadOnlyAuditEnv(env);
  assertReadOnlySql(CATALOG_AUDIT_SQL);
  assertReadOnlySql(STORAGE_BUCKETS_AUDIT_SQL);

  const secretCandidates = extractSecretCandidatesFromEnv(env);
  const parsedUrl = new URL(env.QA_SUPABASE_READONLY_DB_URL.trim());
  const password = decodeURIComponent(parsedUrl.password || '');

  const rawOutput = runPsql({
    dbMeta: validated.db,
    password,
    sql: CATALOG_AUDIT_SQL,
    secretCandidates
  });

  const jsonLine = extractLastJsonValue(rawOutput, '{', '}');
  if (!jsonLine) {
    throw new QaGuardError('Unexpected empty or non-JSON response from read-only QA catalog query.');
  }

  let catalog;
  try {
    catalog = JSON.parse(jsonLine);
  } catch {
    throw new QaGuardError('Failed to parse JSON output from read-only QA catalog query.');
  }

  const verifiedSession = assertRuntimeReadOnlySession(catalog.session);

  if (catalog.session && catalog.session.storage_buckets_accessible === true) {
    const bucketsRaw = runPsql({
      dbMeta: validated.db,
      password,
      sql: STORAGE_BUCKETS_AUDIT_SQL,
      secretCandidates
    });
    const bucketsLine = extractLastJsonValue(bucketsRaw, '[', ']');
    if (!bucketsLine) {
      throw new QaGuardError('Unexpected empty or non-JSON response from read-only storage.buckets query.');
    }
    try {
      catalog.storage_buckets = JSON.parse(bucketsLine);
      catalog.storage_buckets_status = 'VERIFIED';
    } catch {
      throw new QaGuardError('Failed to parse JSON output from read-only storage.buckets query.');
    }
  } else {
    catalog.storage_buckets = null;
    catalog.storage_buckets_status = 'UNKNOWN';
    catalog.storage_buckets_reason =
      'storage.buckets is inaccessible to the least-privilege audit role (no pg_read_all_data or storage.buckets SELECT grant); reported as UNKNOWN, not PASS.';
  }

  return {
    projectRef: validated.projectRef,
    connectionMode: validated.db.connectionMode,
    verifiedSession,
    catalog
  };
}

function diffSets(expectedKeys, actualKeys) {
  const expSet = new Set(expectedKeys);
  const actSet = new Set(actualKeys);
  return {
    missing: [...expSet].filter((k) => !actSet.has(k)).sort(),
    extra: [...actSet].filter((k) => !expSet.has(k)).sort()
  };
}

/**
 * Compare live QA catalog metadata against repository reference expectations.
 * Returns structured exact differences with zero customer data or secrets.
 */
function compareCatalogToReference(liveCatalog, reference) {
  const liveTables = liveCatalog.tables || [];
  const liveColumns = liveCatalog.columns || [];
  const liveFunctions = liveCatalog.functions || [];
  const liveTriggers = liveCatalog.triggers || [];
  const livePolicies = liveCatalog.policies || [];
  const liveConstraints = liveCatalog.constraints || [];
  const liveBuckets = Array.isArray(liveCatalog.storage_buckets) ? liveCatalog.storage_buckets : null;
  const storageBucketsUnknown = liveCatalog.storage_buckets_status === 'UNKNOWN' || liveBuckets === null;
  const livePtUpdateGrants = liveCatalog.program_templates_direct_update_grants || [];

  const expectedTableKeys = reference.tables.map((t) => `${t.schema}.${t.table}`);
  const actualTableKeys = liveTables.map((t) => `${t.schema}.${t.table}`);
  const tablesDiff = diffSets(expectedTableKeys, actualTableKeys);

  const tablesWithoutRls = liveTables
    .filter((t) => expectedTableKeys.includes(`${t.schema}.${t.table}`) && t.rls_enabled !== true)
    .map((t) => `${t.schema}.${t.table}`)
    .sort();

  const sharedTableSet = new Set(expectedTableKeys.filter((k) => actualTableKeys.includes(k)));
  const expectedColMap = new Map();
  for (const col of reference.columns) {
    const tKey = `${col.table_schema}.${col.table_name}`;
    if (!sharedTableSet.has(tKey)) continue;
    expectedColMap.set(`${tKey}.${col.column_name}`, col);
  }
  const actualColMap = new Map();
  for (const col of liveColumns) {
    const tKey = `${col.table_schema}.${col.table_name}`;
    if (!sharedTableSet.has(tKey)) continue;
    actualColMap.set(`${tKey}.${col.column_name}`, col);
  }
  const columnsKeyDiff = diffSets([...expectedColMap.keys()], [...actualColMap.keys()]);
  const columnMismatches = [];
  for (const [colKey, expCol] of expectedColMap.entries()) {
    const actCol = actualColMap.get(colKey);
    if (!actCol) continue;
    const diffs = [];
    if (expCol.udt_name !== actCol.udt_name) {
      diffs.push(`udt_name expected=${expCol.udt_name} actual=${actCol.udt_name}`);
    }
    if (expCol.is_nullable !== actCol.is_nullable) {
      diffs.push(`is_nullable expected=${expCol.is_nullable} actual=${actCol.is_nullable}`);
    }
    if (diffs.length > 0) {
      columnMismatches.push({ column: colKey, details: diffs });
    }
  }

  const expectedFnKeys = reference.functions.map((f) => `${f.schema}.${f.proname}`);
  const actualFnKeys = liveFunctions.map((f) => `${f.schema}.${f.proname}`);
  const functionsDiff = diffSets(expectedFnKeys, actualFnKeys);

  const expectedTrigKeys = reference.triggers.map((t) => `${t.schema}.${t.table}::${t.name}`);
  const actualTrigKeys = liveTriggers.map((t) => `${t.schema}.${t.table}::${t.name}`);
  const triggersDiff = diffSets(expectedTrigKeys, actualTrigKeys);
  const disabledTriggers = liveTriggers
    .filter((t) => expectedTrigKeys.includes(`${t.schema}.${t.table}::${t.name}`) && t.enabled === 'D')
    .map((t) => `${t.schema}.${t.table}::${t.name}`)
    .sort();

  const expectedPolicyMap = new Map(
    reference.policies.map((p) => [`${p.schemaname}.${p.tablename}::${p.policyname}`, p])
  );
  const actualPolicyMap = new Map(
    livePolicies.map((p) => [
      `${p.schemaname}.${p.tablename}::${p.policyname}`,
      {
        ...p,
        cmd: String(p.cmd || '').toUpperCase(),
        roles: [...(p.roles || [])].map((r) => String(r).toLowerCase()).sort()
      }
    ])
  );
  const policiesDiff = diffSets([...expectedPolicyMap.keys()], [...actualPolicyMap.keys()]);
  const policyMismatches = [];
  for (const [polKey, expPol] of expectedPolicyMap.entries()) {
    const actPol = actualPolicyMap.get(polKey);
    if (!actPol) continue;
    const diffs = [];
    if (expPol.cmd !== actPol.cmd) {
      diffs.push(`cmd expected=${expPol.cmd} actual=${actPol.cmd}`);
    }
    if (JSON.stringify(expPol.roles) !== JSON.stringify(actPol.roles)) {
      diffs.push(`roles expected=[${expPol.roles.join(',')}] actual=[${actPol.roles.join(',')}]`);
    }
    if (diffs.length > 0) {
      policyMismatches.push({ policy: polKey, details: diffs });
    }
  }

  const expectedConstraintKeys = reference.constraints.map((c) => `${c.schema}.${c.table}::${c.name}`);
  const actualConstraintKeys = liveConstraints.map((c) => `${c.schema}.${c.table}::${c.name}`);
  const constraintsDiff = diffSets(expectedConstraintKeys, actualConstraintKeys);

  const expectedBucketIds = reference.storageBuckets.map((b) => b.id);
  const storageBucketsDiff = storageBucketsUnknown
    ? { missing: null, extra: null }
    : diffSets(
        expectedBucketIds,
        liveBuckets.map((b) => b.id)
      );
  const publicBuckets = storageBucketsUnknown
    ? null
    : liveBuckets
        .filter((b) => b.public === true)
        .map((b) => b.id)
        .sort();

  const unexpectedProgramTemplatesUpdateGrants = livePtUpdateGrants
    .map((g) => `${g.grantee}:${g.privilege_type}`)
    .sort();

  const criticalSecurityFindings = [];
  for (const table of tablesWithoutRls) {
    criticalSecurityFindings.push(`RLS disabled on expected table: ${table}`);
  }
  if (!storageBucketsUnknown) {
    for (const bucket of publicBuckets) {
      criticalSecurityFindings.push(`Storage bucket is public (expected private): ${bucket}`);
    }
  }
  if (unexpectedProgramTemplatesUpdateGrants.length > 0) {
    criticalSecurityFindings.push(
      `Direct UPDATE privilege still granted on public.program_templates: ${unexpectedProgramTemplatesUpdateGrants.join(', ')}`
    );
  }
  for (const trig of disabledTriggers) {
    criticalSecurityFindings.push(`Expected guard trigger is disabled: ${trig}`);
  }

  const unknownFindings = [];
  if (storageBucketsUnknown) {
    unknownFindings.push(
      liveCatalog.storage_buckets_reason ||
        'UNKNOWN: storage.buckets metadata could not be inspected with least-privilege audit permissions (NOT treated as PASS).'
    );
  }

  const hasKnownDrift =
    tablesDiff.missing.length > 0 ||
    columnsKeyDiff.missing.length > 0 ||
    columnMismatches.length > 0 ||
    functionsDiff.missing.length > 0 ||
    triggersDiff.missing.length > 0 ||
    disabledTriggers.length > 0 ||
    policiesDiff.missing.length > 0 ||
    policyMismatches.length > 0 ||
    constraintsDiff.missing.length > 0 ||
    (!storageBucketsUnknown && storageBucketsDiff.missing.length > 0) ||
    criticalSecurityFindings.length > 0;

  const parityStatus = hasKnownDrift
    ? 'DRIFT_OR_GAPS_DETECTED'
    : unknownFindings.length > 0
      ? 'UNKNOWN_INCOMPLETE_VISIBILITY'
      : 'MATCHES_REFERENCE';

  // Inaccessible checks must NEVER yield inParity === true (never treated as PASS).
  const inParity = parityStatus === 'MATCHES_REFERENCE';

  return {
    auditedAt: new Date().toISOString(),
    targetProjectRef: ALLOWED_QA_PROJECT_REF,
    readOnlyAudit: true,
    parityStatus,
    inParity,
    counts: {
      expectedTables: expectedTableKeys.length,
      actualTables: actualTableKeys.length,
      missingTables: tablesDiff.missing.length,
      extraTables: tablesDiff.extra.length,
      tablesWithoutRls: tablesWithoutRls.length,
      missingColumnsOnSharedTables: columnsKeyDiff.missing.length,
      columnMismatches: columnMismatches.length,
      expectedFunctions: expectedFnKeys.length,
      actualFunctions: actualFnKeys.length,
      missingFunctions: functionsDiff.missing.length,
      extraFunctions: functionsDiff.extra.length,
      expectedTriggers: expectedTrigKeys.length,
      actualTriggers: actualTrigKeys.length,
      missingTriggers: triggersDiff.missing.length,
      disabledTriggers: disabledTriggers.length,
      expectedPolicies: expectedPolicyMap.size,
      actualPolicies: actualPolicyMap.size,
      missingPolicies: policiesDiff.missing.length,
      policyMismatches: policyMismatches.length,
      expectedConstraints: expectedConstraintKeys.length,
      actualConstraints: actualConstraintKeys.length,
      missingConstraints: constraintsDiff.missing.length,
      expectedStorageBuckets: expectedBucketIds.length,
      actualStorageBuckets: storageBucketsUnknown ? null : liveBuckets.length,
      missingStorageBuckets: storageBucketsUnknown ? null : storageBucketsDiff.missing.length,
      publicStorageBuckets: storageBucketsUnknown ? null : publicBuckets.length,
      storageBucketsStatus: storageBucketsUnknown ? 'UNKNOWN' : 'VERIFIED',
      unknownFindings: unknownFindings.length,
      criticalSecurityFindings: criticalSecurityFindings.length
    },
    diffs: {
      tables: tablesDiff,
      tablesWithoutRls,
      columns: {
        ...columnsKeyDiff,
        mismatches: columnMismatches
      },
      functions: functionsDiff,
      triggers: {
        ...triggersDiff,
        disabled: disabledTriggers
      },
      policies: {
        ...policiesDiff,
        mismatches: policyMismatches
      },
      constraints: constraintsDiff,
      storageBuckets: storageBucketsUnknown
        ? {
            status: 'UNKNOWN',
            reason:
              liveCatalog.storage_buckets_reason ||
              'storage.buckets inaccessible to least-privilege audit role',
            missing: null,
            extra: null,
            publicBuckets: null,
            liveMetadata: null
          }
        : {
            status: 'VERIFIED',
            ...storageBucketsDiff,
            publicBuckets,
            liveMetadata: liveBuckets.map((b) => ({
              id: b.id,
              public: Boolean(b.public),
              file_size_limit: b.file_size_limit ?? null,
              allowed_mime_types: b.allowed_mime_types ?? null
            }))
          },
      unexpectedProgramTemplatesUpdateGrants
    },
    unknownFindings,
    criticalSecurityFindings,
    referenceProvenance: reference.referenceProvenance
  };
}

function formatListSection(title, items) {
  if (items === null) return `### ${title}\n- UNKNOWN (inaccessible with least-privilege audit permissions; NOT PASS)\n`;
  if (!items || items.length === 0) return `### ${title}\n- None\n`;
  return `### ${title} (${items.length})\n` + items.map((item) => `- \`${item}\``).join('\n') + '\n';
}

function formatParityReport(report) {
  const storageSummaryLine =
    report.counts.storageBucketsStatus === 'UNKNOWN'
      ? `- Storage Buckets: **UNKNOWN** (expected=${report.counts.expectedStorageBuckets}, actual=UNKNOWN, missing=UNKNOWN, public=UNKNOWN — inaccessible to least-privilege role; NOT treated as PASS)`
      : `- Storage Buckets: expected=${report.counts.expectedStorageBuckets}, actual=${report.counts.actualStorageBuckets}, missing=${report.counts.missingStorageBuckets}, public=${report.counts.publicStorageBuckets}`;

  const lines = [
    '# Pure Function — QA Read-Only Structural Parity Audit',
    '',
    `- **Target QA Project:** \`${report.targetProjectRef}\``,
    `- **Audited At:** \`${report.auditedAt}\``,
    `- **Read-Only Transaction Verified:** \`${report.readOnlyAudit}\``,
    `- **Structural Parity Status:** \`${report.parityStatus}\``,
    '',
    '## Reference Freshness & Unverified Data Labels',
    ...report.referenceProvenance.map(
      (p) => `- **[${p.status}]** \`${p.source}\`${p.capturedAt ? ` (${p.capturedAt})` : ''}: ${p.note}`
    ),
    '',
    '## Summary Counts',
    `- Tables: expected=${report.counts.expectedTables}, actual=${report.counts.actualTables}, missing=${report.counts.missingTables}, extra=${report.counts.extraTables}, rls_disabled=${report.counts.tablesWithoutRls}`,
    `- Columns (shared tables): missing=${report.counts.missingColumnsOnSharedTables}, mismatched=${report.counts.columnMismatches}`,
    `- Functions: expected=${report.counts.expectedFunctions}, actual=${report.counts.actualFunctions}, missing=${report.counts.missingFunctions}, extra=${report.counts.extraFunctions}`,
    `- Triggers: expected=${report.counts.expectedTriggers}, actual=${report.counts.actualTriggers}, missing=${report.counts.missingTriggers}, disabled=${report.counts.disabledTriggers}`,
    `- Policies: expected=${report.counts.expectedPolicies}, actual=${report.counts.actualPolicies}, missing=${report.counts.missingPolicies}, mismatched=${report.counts.policyMismatches}`,
    `- Constraints: expected=${report.counts.expectedConstraints}, actual=${report.counts.actualConstraints}, missing=${report.counts.missingConstraints}`,
    storageSummaryLine,
    '',
    formatListSection('Unknown / Inaccessible Checks (Not Treated as PASS)', report.unknownFindings),
    formatListSection('Critical Security Findings', report.criticalSecurityFindings),
    formatListSection('Missing Tables', report.diffs.tables.missing),
    formatListSection('Extra Tables in QA', report.diffs.tables.extra),
    formatListSection('Missing Columns on Shared Tables', report.diffs.columns.missing),
    formatListSection(
      'Column Type/Nullability Mismatches',
      report.diffs.columns.mismatches.map((m) => `${m.column}: ${m.details.join('; ')}`)
    ),
    formatListSection('Missing Functions', report.diffs.functions.missing),
    formatListSection('Missing Triggers', report.diffs.triggers.missing),
    formatListSection('Missing Policies', report.diffs.policies.missing),
    formatListSection(
      'Policy Mismatches',
      report.diffs.policies.mismatches.map((m) => `${m.policy}: ${m.details.join('; ')}`)
    ),
    formatListSection('Missing Constraints', report.diffs.constraints.missing),
    formatListSection('Missing Storage Buckets', report.diffs.storageBuckets.missing)
  ];

  return lines.join('\n');
}

function parseArgValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

function main(argv = process.argv.slice(2), env = process.env, { inspect = inspectQaCatalog } = {}) {
  const validateOnly = argv.includes('--validate-only');
  const liveMode = argv.includes('--live');
  const outJsonPath = parseArgValue(argv, '--out-json');
  const outMdPath = parseArgValue(argv, '--out-md');
  const secretCandidates = extractSecretCandidatesFromEnv(env);

  try {
    assertReadOnlySql(CATALOG_AUDIT_SQL);
    assertReadOnlySql(STORAGE_BUCKETS_AUDIT_SQL);
    const reference = loadReferenceExpectations(process.cwd());

    if (validateOnly) {
      console.log(
        `PASS: Read-only QA parity tooling validated locally (tables=${reference.tables.length}, functions=${reference.functions.length}, triggers=${reference.triggers.length}, policies=${reference.policies.length}, storageBuckets=${reference.storageBuckets.length}). Zero database calls executed.`
      );
      return;
    }

    if (!liveMode) {
      throw new QaGuardError('Specify --validate-only (offline) or --live (read-only QA audit).');
    }

    const inspection = inspect({ env });
    const report = compareCatalogToReference(inspection.catalog, reference);
    const markdown = formatParityReport(report);

    if (outJsonPath) {
      fs.writeFileSync(path.resolve(outJsonPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
    }
    if (outMdPath) {
      fs.writeFileSync(path.resolve(outMdPath), markdown + '\n', 'utf8');
    }

    console.log(markdown);
  } catch (err) {
    const rawMessage = err && err.message ? err.message : 'Unexpected QA audit failure.';
    const message = redactSecrets(rawMessage, secretCandidates);
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CATALOG_AUDIT_SQL,
  STORAGE_BUCKETS_AUDIT_SQL,
  READONLY_STATEMENT_TIMEOUT_MS,
  SCHEMA_REFERENCE_REL_PATH,
  TEMPLATE_MIGRATION_REL_PATH,
  loadReferenceExpectations,
  buildReadOnlyTransactionWrapper,
  buildPsqlChildEnv,
  defaultRunPsqlReadOnly,
  inspectQaCatalog,
  compareCatalogToReference,
  formatParityReport,
  main
};

if (require.main === module) {
  main();
}
