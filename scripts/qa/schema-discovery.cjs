'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ALLOWED_QA_PROJECT_REF,
  FORBIDDEN_PRODUCTION_PROJECT_REF,
  QaGuardError
} = require('./qa-guard.cjs');

const DISCOVERY_SCHEMA_VERSION = '1.0.0';
const DISCOVERY_STATEMENT_TIMEOUT_MS = '15000';

/**
 * Strictly allowlisted PostgreSQL catalog relations for metadata-only schema
 * discovery. Explicitly excludes application tables, auth.users, storage.objects,
 * vault.*, private.*, and information_schema (which filters by table grants).
 */
const ALLOWED_DISCOVERY_CATALOG_RELATIONS = Object.freeze(
  new Set([
    'pg_catalog.pg_roles',
    'pg_catalog.pg_class',
    'pg_catalog.pg_namespace',
    'pg_catalog.pg_attribute',
    'pg_catalog.pg_attrdef',
    'pg_catalog.pg_type',
    'pg_catalog.pg_enum',
    'pg_catalog.pg_constraint',
    'pg_catalog.pg_index',
    'pg_catalog.pg_am',
    'pg_catalog.pg_sequence',
    'pg_catalog.pg_proc',
    'pg_catalog.pg_language',
    'pg_catalog.pg_trigger',
    'pg_catalog.pg_policies',
    'pg_catalog.pg_extension',
    'storage.buckets'
  ])
);

/**
 * SQL keywords that must NEVER appear in read-only metadata discovery queries.
 */
const FORBIDDEN_DISCOVERY_KEYWORDS = Object.freeze([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'ANALYZE',
  'CLUSTER',
  'REINDEX',
  'COPY',
  'CALL',
  'DO',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
  'LOCK',
  'SET',
  'RESET',
  'LISTEN',
  'NOTIFY',
  'DISCARD',
  'COMMENT',
  'REFRESH',
  'CHECKPOINT',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'SET_CONFIG',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'DBLINK',
  'LO_IMPORT',
  'LO_EXPORT'
]);

/**
 * Raw DDL extraction functions / columns that can embed emails, project refs,
 * URLs, or hardcoded identifiers in function bodies, defaults, or policies.
 * Prohibited in automated metadata-only discovery; raw DDL requires controlled
 * manual extraction + scanDdlForSensitiveContent + human sign-off.
 */
const FORBIDDEN_RAW_DDL_EXPORTS = Object.freeze([
  'PG_GET_FUNCTIONDEF',
  'PG_GET_TRIGGERDEF',
  'PG_GET_VIEWDEF',
  'PG_GET_INDEXDEF',
  'PG_GET_CONSTRAINTDEF',
  'PROSRC'
]);

/**
 * Strictly metadata-only schema discovery SQL.
 * - Exports ONLY structural catalog metadata and SHA-256 digests of function
 *   bodies / defaults / policy expressions (never raw source text).
 * - Zero rows from application tables, auth.users, storage.objects, private.settings,
 *   or vault.*.
 * - Pooler-compatible (designed to run inside BEGIN TRANSACTION READ ONLY).
 */
const METADATA_ONLY_DISCOVERY_SQL = `
SELECT json_build_object(
  'schema_version', '1.0.0',
  'mode', 'metadata-only',
  'captured_at', now(),
  'session', (
    SELECT json_build_object(
      'current_user', current_user,
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
        'relkind', c.relkind,
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
  'views', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'view', c.relname,
        'relkind', c.relkind,
        'reloptions', c.reloptions
      )
      ORDER BY n.nspname, c.relname
    )
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('v', 'm')
  ), '[]'::json),
  'columns', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'column', a.attname,
        'ordinal', a.attnum,
        'udt_name', t.typname,
        'is_nullable', NOT a.attnotnull,
        'has_default', a.atthasdef,
        'default_sha256', CASE
          WHEN ad.adbin IS NOT NULL
            THEN encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 'UTF8')), 'hex')
          ELSE NULL
        END
      )
      ORDER BY n.nspname, c.relname, a.attnum
    )
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
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
        'contype', con.contype,
        'validated', con.convalidated
      )
      ORDER BY n.nspname, c.relname, con.conname
    )
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
  ), '[]'::json),
  'indexes', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', tc.relname,
        'index', ic.relname,
        'is_unique', i.indisunique,
        'is_primary', i.indisprimary,
        'is_valid', i.indisvalid,
        'method', am.amname
      )
      ORDER BY n.nspname, tc.relname, ic.relname
    )
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
    WHERE n.nspname IN ('public', 'private')
  ), '[]'::json),
  'sequences', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'sequence', c.relname,
        'data_type', t.typname
      )
      ORDER BY n.nspname, c.relname
    )
    FROM pg_catalog.pg_sequence s
    JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = s.seqtypid
    WHERE n.nspname IN ('public', 'private')
  ), '[]'::json),
  'enums', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'type', t.typname,
        'labels', (
          SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
          FROM pg_catalog.pg_enum e
          WHERE e.enumtypid = t.oid
        )
      )
      ORDER BY n.nspname, t.typname
    )
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'private')
      AND t.typtype = 'e'
  ), '[]'::json),
  'functions', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'proname', p.proname,
        'identity_args', pg_catalog.pg_get_function_identity_arguments(p.oid),
        'result_type', pg_catalog.pg_get_function_result(p.oid),
        'language', l.lanname,
        'security_definer', p.prosecdef,
        'volatility', p.provolatile,
        'has_search_path_config', COALESCE('search_path=' = ANY(p.proconfig), false)
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc p2
            WHERE p2.oid = p.oid
              AND array_to_string(COALESCE(p2.proconfig, ARRAY[]::text[]), ',') LIKE '%search_path=%'
          ),
        'anon_execute', pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated_execute', pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'public_execute', pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
      )
      ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)
    )
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname IN ('public', 'private')
      AND p.prokind = 'f'
  ), '[]'::json),
  'triggers', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'name', t.tgname,
        'enabled', t.tgenabled,
        'tgtype', t.tgtype
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
        'schema', p.schemaname,
        'table', p.tablename,
        'policyname', p.policyname,
        'cmd', p.cmd,
        'permissive', p.permissive,
        'roles', p.roles,
        'qual_sha256', CASE
          WHEN p.qual IS NOT NULL THEN encode(pg_catalog.sha256(pg_catalog.convert_to(p.qual, 'UTF8')), 'hex')
          ELSE NULL
        END,
        'with_check_sha256', CASE
          WHEN p.with_check IS NOT NULL THEN encode(pg_catalog.sha256(pg_catalog.convert_to(p.with_check, 'UTF8')), 'hex')
          ELSE NULL
        END
      )
      ORDER BY p.schemaname, p.tablename, p.policyname
    )
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname IN ('public', 'private', 'storage')
  ), '[]'::json),
  'extensions', COALESCE((
    SELECT json_agg(
      json_build_object(
        'extname', e.extname,
        'schema', n.nspname,
        'version', e.extversion
      )
      ORDER BY e.extname
    )
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  ), '[]'::json),
  'table_privileges', COALESCE((
    SELECT json_agg(
      json_build_object(
        'schema', n.nspname,
        'table', c.relname,
        'anon_select', pg_catalog.has_table_privilege('anon', c.oid, 'SELECT'),
        'anon_insert', pg_catalog.has_table_privilege('anon', c.oid, 'INSERT'),
        'anon_update', pg_catalog.has_table_privilege('anon', c.oid, 'UPDATE'),
        'anon_delete', pg_catalog.has_table_privilege('anon', c.oid, 'DELETE'),
        'authenticated_select', pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'),
        'authenticated_insert', pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT'),
        'authenticated_update', pg_catalog.has_table_privilege('authenticated', c.oid, 'UPDATE'),
        'authenticated_delete', pg_catalog.has_table_privilege('authenticated', c.oid, 'DELETE'),
        'public_update', pg_catalog.has_table_privilege('public', c.oid, 'UPDATE')
      )
      ORDER BY n.nspname, c.relname
    )
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  ), '[]'::json)
)::text;
`.trim();

/**
 * Optional metadata-only query for storage.buckets (zero object rows).
 */
const STORAGE_BUCKETS_METADATA_SQL = `
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

function stripCommentsAndStrings(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i + 1 < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new QaGuardError('Blocked: unterminated SQL block comment.');
      out += ' ';
      continue;
    }

    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new QaGuardError('Blocked: unterminated SQL string literal.');
      out += ' __STR__ ';
      continue;
    }

    if (ch === '$') {
      throw new QaGuardError('Blocked: dollar-quoted SQL blocks are not allowed in metadata-only discovery queries.');
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Statically verify that a metadata-only discovery SQL query:
 * 1. Is a single SELECT / WITH statement.
 * 2. Contains zero write/DDL/admin keywords.
 * 3. Contains zero raw DDL body export functions (e.g. pg_get_functiondef, prosrc).
 * 4. Reads ONLY from explicitly schema-qualified allowlisted catalog relations.
 */
function assertMetadataOnlyDiscoverySql(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new QaGuardError('Discovery SQL must be a non-empty string.');
  }

  const cleaned = stripCommentsAndStrings(sql).trim();
  const body = cleaned.endsWith(';') ? cleaned.slice(0, -1).trim() : cleaned;

  if (body.includes(';')) {
    throw new QaGuardError('Blocked: multi-statement SQL is forbidden in metadata-only discovery.');
  }
  if (!/^(SELECT|WITH)\b/i.test(body)) {
    throw new QaGuardError('Blocked: discovery SQL must begin with SELECT or WITH.');
  }

  for (const kw of FORBIDDEN_DISCOVERY_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(body)) {
      throw new QaGuardError(`Blocked: forbidden SQL keyword "${kw}" in metadata-only discovery.`);
    }
  }

  for (const rawFn of FORBIDDEN_RAW_DDL_EXPORTS) {
    if (new RegExp(`\\b${rawFn}\\b`, 'i').test(body)) {
      throw new QaGuardError(
        `Blocked: raw DDL export symbol "${rawFn}" is prohibited in automated metadata-only mode (requires controlled manual review).`
      );
    }
  }

  const commaJoinRe =
    /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s*,/gi;
  if (commaJoinRe.test(body)) {
    throw new QaGuardError('Blocked: comma-separated FROM/JOIN lists are forbidden in discovery SQL.');
  }

  const relationRe =
    /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(\(|"?[a-z_][a-z0-9_]*"?(?:\s*\.\s*"?[a-z_][a-z0-9_]*"?)?)/gi;
  let match;
  let count = 0;
  while ((match = relationRe.exec(body)) !== null) {
    const rawTarget = match[1].trim();
    if (rawTarget === '(') continue;
    count += 1;
    const normalized = rawTarget.replace(/"/g, '').replace(/\s*\.\s*/g, '.').toLowerCase();
    if (!normalized.includes('.')) {
      throw new QaGuardError(
        `Blocked: unschema-qualified relation "${normalized}" is forbidden in discovery SQL.`
      );
    }
    if (!ALLOWED_DISCOVERY_CATALOG_RELATIONS.has(normalized)) {
      throw new QaGuardError(
        `Blocked: relation "${normalized}" is not on the metadata-only catalog allowlist.`
      );
    }
  }

  if (count === 0) {
    throw new QaGuardError('Blocked: discovery SQL must explicitly query allowlisted catalog relations.');
  }

  return true;
}

function buildWrappedReadOnlyDiscoverySql(sql) {
  assertMetadataOnlyDiscoverySql(sql);
  return `BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '${DISCOVERY_STATEMENT_TIMEOUT_MS}';\n${sql}\nROLLBACK;\n`;
}

/**
 * Scan candidate DDL SQL text before it can ever be approved as a QA baseline.
 * Naive search-and-replace is NOT proof of safety; this scanner flags embedded
 * secrets, real emails, Production identifiers, external URLs, Vault/cron calls,
 * and data-modifying statements so a human reviewer must inspect and clean them.
 */
function scanDdlForSensitiveContent(sqlText) {
  const text = String(sqlText ?? '');
  const lines = text.split('\n');
  const findings = [];

  const addFinding = (severity, category, lineNumber, detail) => {
    findings.push({ severity, category, line: lineNumber, detail });
  };

  const emailRe = /\b[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
  const syntheticEmailDomains = new Set(['example.invalid', 'qa.invalid', 'example.com', 'example.org', 'test.invalid']);
  const urlRe = /https?:\/\/[^\s'"<>)]+/gi;
  const tokenRe = /\b(re_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|sb_secret_[A-Za-z0-9_-]{12,}|sbp_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})\b/g;

  let activeDollarTag = null;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const lower = line.toLowerCase();

    if (lower.includes(FORBIDDEN_PRODUCTION_PROJECT_REF)) {
      addFinding('CRITICAL', 'PRODUCTION_PROJECT_REF', lineNo, 'Contains Production Supabase project ref.');
    }

    if (/postgres(?:ql)?:\/\//i.test(line)) {
      addFinding('CRITICAL', 'DATABASE_CONNECTION_STRING', lineNo, 'Contains PostgreSQL connection string.');
    }

    tokenRe.lastIndex = 0;
    let tok;
    while ((tok = tokenRe.exec(line)) !== null) {
      addFinding('CRITICAL', 'EMBEDDED_SECRET_OR_TOKEN', lineNo, `Contains token-like credential prefix (${tok[1].slice(0, 6)}...).`);
    }

    emailRe.lastIndex = 0;
    let em;
    while ((em = emailRe.exec(line)) !== null) {
      const domain = em[1].toLowerCase();
      if (!syntheticEmailDomains.has(domain)) {
        addFinding('HIGH', 'REAL_EMAIL_ADDRESS', lineNo, `Contains non-synthetic email domain "@${domain}".`);
      }
    }

    urlRe.lastIndex = 0;
    let u;
    while ((u = urlRe.exec(line)) !== null) {
      const urlText = u[0].toLowerCase();
      if (!urlText.includes('example.invalid') && !urlText.includes('qa.invalid')) {
        addFinding('HIGH', 'EXTERNAL_URL', lineNo, 'Contains external URL that must be reviewed/parameterized for QA.');
      }
    }

    if (/\b(cron\.schedule|pg_cron|net\.http_post|vault\.decrypted_secrets|vault\.secrets)\b/i.test(line)) {
      addFinding('HIGH', 'CRON_OR_VAULT_REFERENCE', lineNo, 'References pg_cron, net.http_post, or Vault secrets (must not be blindly copied to QA).');
    }

    const trimmedNoComment = line.replace(/--.*$/, '').trim();
    if (!activeDollarTag && /^(INSERT\s+INTO|COPY\s+|UPDATE\s+|DELETE\s+FROM)\b/i.test(trimmedNoComment)) {
      addFinding('CRITICAL', 'DATA_MODIFICATION_STATEMENT', lineNo, 'Contains top-level row-data statement (schema-only baseline must contain DDL only).');
    }

    // Track PostgreSQL dollar-quoted function bodies ($tag$ ... $tag$) across lines.
    const dollarTags = trimmedNoComment.match(/\$[A-Za-z0-9_]*\$/g) || [];
    for (const tag of dollarTags) {
      if (activeDollarTag === null) {
        activeDollarTag = tag;
      } else if (activeDollarTag === tag) {
        activeDollarTag = null;
      }
    }
  });

  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const highCount = findings.filter((f) => f.severity === 'HIGH').length;

  return {
    safeForQaBaseline: findings.length === 0,
    requiresManualReview: true,
    counts: {
      total: findings.length,
      critical: criticalCount,
      high: highCount
    },
    findings
  };
}

function diffKeySets(expectedKeys, actualKeys) {
  const exp = new Set(expectedKeys);
  const act = new Set(actualKeys);
  return {
    missing: [...exp].filter((k) => !act.has(k)).sort(),
    extra: [...act].filter((k) => !exp.has(k)).sort()
  };
}

function normalizeArray(val) {
  return Array.isArray(val) ? val : [];
}

/**
 * Compare two metadata-only schema snapshots (e.g. Production reference metadata
 * vs QA live metadata) and emit a deterministic, machine-readable QA parity report.
 */
function compareSchemaSnapshots(referenceSnapshot, qaSnapshot, options = {}) {
  if (!referenceSnapshot || typeof referenceSnapshot !== 'object') {
    throw new QaGuardError('Reference schema snapshot must be a valid JSON object.');
  }
  if (!qaSnapshot || typeof qaSnapshot !== 'object') {
    throw new QaGuardError('QA schema snapshot must be a valid JSON object.');
  }

  const refTables = normalizeArray(referenceSnapshot.tables);
  const qaTables = normalizeArray(qaSnapshot.tables);
  const refTableMap = new Map(refTables.map((t) => [`${t.schema}.${t.table}`, t]));
  const qaTableMap = new Map(qaTables.map((t) => [`${t.schema}.${t.table}`, t]));
  const tablesDiff = diffKeySets([...refTableMap.keys()], [...qaTableMap.keys()]);

  const rlsDrift = [];
  for (const [key, refT] of refTableMap.entries()) {
    const qaT = qaTableMap.get(key);
    if (!qaT) continue;
    if (Boolean(refT.rls_enabled) !== Boolean(qaT.rls_enabled) || Boolean(refT.rls_forced) !== Boolean(qaT.rls_forced)) {
      rlsDrift.push({
        table: key,
        expected: { rls_enabled: Boolean(refT.rls_enabled), rls_forced: Boolean(refT.rls_forced) },
        actual: { rls_enabled: Boolean(qaT.rls_enabled), rls_forced: Boolean(qaT.rls_forced) }
      });
    }
  }

  const sharedTables = new Set([...refTableMap.keys()].filter((k) => qaTableMap.has(k)));
  const refColMap = new Map();
  for (const c of normalizeArray(referenceSnapshot.columns)) {
    const tKey = `${c.schema ?? c.table_schema}.${c.table ?? c.table_name}`;
    if (!sharedTables.has(tKey)) continue;
    refColMap.set(`${tKey}.${c.column ?? c.column_name}`, {
      udt_name: c.udt_name,
      is_nullable: typeof c.is_nullable === 'boolean' ? c.is_nullable : c.is_nullable === 'YES',
      has_default: Boolean(c.has_default),
      default_sha256: c.default_sha256 ?? null
    });
  }
  const qaColMap = new Map();
  for (const c of normalizeArray(qaSnapshot.columns)) {
    const tKey = `${c.schema ?? c.table_schema}.${c.table ?? c.table_name}`;
    if (!sharedTables.has(tKey)) continue;
    qaColMap.set(`${tKey}.${c.column ?? c.column_name}`, {
      udt_name: c.udt_name,
      is_nullable: typeof c.is_nullable === 'boolean' ? c.is_nullable : c.is_nullable === 'YES',
      has_default: Boolean(c.has_default),
      default_sha256: c.default_sha256 ?? null
    });
  }
  const columnsDiff = diffKeySets([...refColMap.keys()], [...qaColMap.keys()]);
  const columnMismatches = [];
  for (const [k, exp] of refColMap.entries()) {
    const act = qaColMap.get(k);
    if (!act) continue;
    const changes = [];
    if (exp.udt_name !== act.udt_name) changes.push(`udt_name:${exp.udt_name}->${act.udt_name}`);
    if (exp.is_nullable !== act.is_nullable) changes.push(`is_nullable:${exp.is_nullable}->${act.is_nullable}`);
    if (exp.default_sha256 && act.default_sha256 && exp.default_sha256 !== act.default_sha256) {
      changes.push('default_sha256:differs');
    }
    if (changes.length > 0) columnMismatches.push({ column: k, changes });
  }

  const fnKey = (f) => `${f.schema}.${f.proname}(${f.identity_args ?? ''})`;
  const refFnMap = new Map(normalizeArray(referenceSnapshot.functions).map((f) => [fnKey(f), f]));
  const qaFnMap = new Map(normalizeArray(qaSnapshot.functions).map((f) => [fnKey(f), f]));
  const functionsDiff = diffKeySets([...refFnMap.keys()], [...qaFnMap.keys()]);
  const functionAttributeDrift = [];
  for (const [k, exp] of refFnMap.entries()) {
    const act = qaFnMap.get(k);
    if (!act) continue;
    const changes = [];
    if (Boolean(exp.security_definer) !== Boolean(act.security_definer)) {
      changes.push(`security_definer:${Boolean(exp.security_definer)}->${Boolean(act.security_definer)}`);
    }
    if (typeof exp.has_search_path_config === 'boolean' && typeof act.has_search_path_config === 'boolean' && exp.has_search_path_config !== act.has_search_path_config) {
      changes.push(`search_path_pinned:${exp.has_search_path_config}->${act.has_search_path_config}`);
    }
    if (typeof exp.anon_execute === 'boolean' && typeof act.anon_execute === 'boolean' && exp.anon_execute !== act.anon_execute) {
      changes.push(`anon_execute:${exp.anon_execute}->${act.anon_execute}`);
    }
    if (changes.length > 0) functionAttributeDrift.push({ function: k, changes });
  }

  const trigKey = (t) => `${t.schema}.${t.table}::${t.name}`;
  const refTrigs = normalizeArray(referenceSnapshot.triggers);
  const qaTrigs = normalizeArray(qaSnapshot.triggers);
  const triggersDiff = diffKeySets(refTrigs.map(trigKey), qaTrigs.map(trigKey));
  const disabledTriggers = qaTrigs
    .filter((t) => t.enabled === 'D')
    .map(trigKey)
    .sort();

  const polKey = (p) => `${p.schema ?? p.schemaname}.${p.table ?? p.tablename}::${p.policyname}`;
  const refPolMap = new Map(normalizeArray(referenceSnapshot.policies).map((p) => [polKey(p), p]));
  const qaPolMap = new Map(normalizeArray(qaSnapshot.policies).map((p) => [polKey(p), p]));
  const policiesDiff = diffKeySets([...refPolMap.keys()], [...qaPolMap.keys()]);
  const policyDrift = [];
  for (const [k, exp] of refPolMap.entries()) {
    const act = qaPolMap.get(k);
    if (!act) continue;
    const changes = [];
    if (String(exp.cmd || '').toUpperCase() !== String(act.cmd || '').toUpperCase()) {
      changes.push(`cmd:${exp.cmd}->${act.cmd}`);
    }
    const expRoles = [...normalizeArray(exp.roles)].map((r) => String(r).toLowerCase()).sort();
    const actRoles = [...normalizeArray(act.roles)].map((r) => String(r).toLowerCase()).sort();
    if (JSON.stringify(expRoles) !== JSON.stringify(actRoles)) {
      changes.push(`roles:[${expRoles.join(',')}]->[${actRoles.join(',')}]`);
    }
    if (exp.qual_sha256 && act.qual_sha256 && exp.qual_sha256 !== act.qual_sha256) {
      changes.push('qual_sha256:differs');
    }
    if (exp.with_check_sha256 && act.with_check_sha256 && exp.with_check_sha256 !== act.with_check_sha256) {
      changes.push('with_check_sha256:differs');
    }
    if (changes.length > 0) policyDrift.push({ policy: k, changes });
  }

  const conKey = (c) => `${c.schema}.${c.table}::${c.name}`;
  const constraintsDiff = diffKeySets(
    normalizeArray(referenceSnapshot.constraints).map(conKey),
    normalizeArray(qaSnapshot.constraints).map(conKey)
  );

  const idxKey = (i) => `${i.schema}.${i.table}::${i.index}`;
  const indexesDiff = diffKeySets(
    normalizeArray(referenceSnapshot.indexes).map(idxKey),
    normalizeArray(qaSnapshot.indexes).map(idxKey)
  );

  const extKey = (e) => `${e.extname}@${e.schema}`;
  const extensionsDiff = diffKeySets(
    normalizeArray(referenceSnapshot.extensions).map(extKey),
    normalizeArray(qaSnapshot.extensions).map(extKey)
  );

  const storageUnknown =
    qaSnapshot.storage_buckets_status === 'UNKNOWN' ||
    !Array.isArray(qaSnapshot.storage_buckets) ||
    !Array.isArray(referenceSnapshot.storage_buckets);

  const storageBucketsDiff = storageUnknown
    ? { status: 'UNKNOWN', missing: null, extra: null, publicDrift: null }
    : (() => {
        const refB = new Map(referenceSnapshot.storage_buckets.map((b) => [b.id, b]));
        const qaB = new Map(qaSnapshot.storage_buckets.map((b) => [b.id, b]));
        const diff = diffKeySets([...refB.keys()], [...qaB.keys()]);
        const publicDrift = [];
        for (const [id, exp] of refB.entries()) {
          const act = qaB.get(id);
          if (act && Boolean(exp.public) !== Boolean(act.public)) {
            publicDrift.push({ bucket: id, expectedPublic: Boolean(exp.public), actualPublic: Boolean(act.public) });
          }
        }
        return { status: 'VERIFIED', ...diff, publicDrift };
      })();

  const privilegeDrift = [];
  const refPrivMap = new Map(
    normalizeArray(referenceSnapshot.table_privileges).map((p) => [`${p.schema}.${p.table}`, p])
  );
  const qaPrivMap = new Map(
    normalizeArray(qaSnapshot.table_privileges).map((p) => [`${p.schema}.${p.table}`, p])
  );
  for (const [tKey, exp] of refPrivMap.entries()) {
    const act = qaPrivMap.get(tKey);
    if (!act) continue;
    const keys = [
      'anon_select',
      'anon_insert',
      'anon_update',
      'anon_delete',
      'authenticated_select',
      'authenticated_insert',
      'authenticated_update',
      'authenticated_delete',
      'public_update'
    ];
    const diffs = keys.filter((k) => Boolean(exp[k]) !== Boolean(act[k])).map((k) => `${k}:${Boolean(exp[k])}->${Boolean(act[k])}`);
    if (diffs.length > 0) privilegeDrift.push({ table: tKey, changes: diffs });
  }

  const securityFindings = [];
  for (const r of rlsDrift) {
    if (r.expected.rls_enabled && !r.actual.rls_enabled) {
      securityFindings.push(`RLS disabled in QA on table: ${r.table}`);
    }
  }
  for (const d of disabledTriggers) {
    securityFindings.push(`Trigger disabled in QA: ${d}`);
  }
  if (!storageUnknown && storageBucketsDiff.publicDrift.length > 0) {
    for (const b of storageBucketsDiff.publicDrift) {
      if (!b.expectedPublic && b.actualPublic) {
        securityFindings.push(`Storage bucket is public in QA (expected private): ${b.bucket}`);
      }
    }
  }
  for (const p of privilegeDrift) {
    if (p.changes.some((c) => c.includes('anon_') && c.endsWith('->true'))) {
      securityFindings.push(`Unexpected anon privilege in QA on ${p.table}: ${p.changes.join(', ')}`);
    }
    if (p.table === 'public.program_templates' && p.changes.some((c) => c.includes('update') && c.endsWith('->true'))) {
      securityFindings.push(`Direct UPDATE privilege regression on public.program_templates: ${p.changes.join(', ')}`);
    }
  }

  const unknownChecks = [];
  if (storageUnknown) {
    unknownChecks.push('storage.buckets metadata is UNKNOWN in one or both snapshots (not treated as PASS).');
  }

  const hasDrift =
    tablesDiff.missing.length > 0 ||
    rlsDrift.length > 0 ||
    columnsDiff.missing.length > 0 ||
    columnMismatches.length > 0 ||
    functionsDiff.missing.length > 0 ||
    functionAttributeDrift.length > 0 ||
    triggersDiff.missing.length > 0 ||
    disabledTriggers.length > 0 ||
    policiesDiff.missing.length > 0 ||
    policyDrift.length > 0 ||
    constraintsDiff.missing.length > 0 ||
    indexesDiff.missing.length > 0 ||
    extensionsDiff.missing.length > 0 ||
    privilegeDrift.length > 0 ||
    (!storageUnknown && (storageBucketsDiff.missing.length > 0 || storageBucketsDiff.publicDrift.length > 0)) ||
    securityFindings.length > 0;

  const parityStatus = hasDrift
    ? 'DRIFT_OR_GAPS_DETECTED'
    : unknownChecks.length > 0
      ? 'UNKNOWN_INCOMPLETE_VISIBILITY'
      : 'PARITY_VERIFIED';

  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    comparedAt: options.now ? options.now() : new Date().toISOString(),
    targetQaProjectRef: ALLOWED_QA_PROJECT_REF,
    referenceLabel: options.referenceLabel || referenceSnapshot.label || 'production-metadata-snapshot',
    qaLabel: options.qaLabel || qaSnapshot.label || 'qa-metadata-snapshot',
    parityStatus,
    inParity: parityStatus === 'PARITY_VERIFIED',
    summary: {
      tables: { expected: refTableMap.size, actual: qaTableMap.size, missing: tablesDiff.missing.length, extra: tablesDiff.extra.length, rlsDrift: rlsDrift.length },
      columns: { missingOnSharedTables: columnsDiff.missing.length, mismatches: columnMismatches.length },
      functions: { expected: refFnMap.size, actual: qaFnMap.size, missing: functionsDiff.missing.length, extra: functionsDiff.extra.length, attributeDrift: functionAttributeDrift.length },
      triggers: { expected: refTrigs.length, actual: qaTrigs.length, missing: triggersDiff.missing.length, disabled: disabledTriggers.length },
      policies: { expected: refPolMap.size, actual: qaPolMap.size, missing: policiesDiff.missing.length, extra: policiesDiff.extra.length, drift: policyDrift.length },
      constraints: { missing: constraintsDiff.missing.length, extra: constraintsDiff.extra.length },
      indexes: { missing: indexesDiff.missing.length, extra: indexesDiff.extra.length },
      extensions: { missing: extensionsDiff.missing.length, extra: extensionsDiff.extra.length },
      storageBuckets: storageUnknown
        ? { status: 'UNKNOWN', missing: null, publicDrift: null }
        : { status: 'VERIFIED', missing: storageBucketsDiff.missing.length, publicDrift: storageBucketsDiff.publicDrift.length },
      privilegeDrift: privilegeDrift.length,
      securityFindings: securityFindings.length,
      unknownChecks: unknownChecks.length
    },
    objectDiffs: {
      tables: tablesDiff,
      rlsDrift,
      columns: { ...columnsDiff, mismatches: columnMismatches },
      functions: { ...functionsDiff, attributeDrift: functionAttributeDrift },
      triggers: { ...triggersDiff, disabled: disabledTriggers },
      policies: { ...policiesDiff, drift: policyDrift },
      constraints: constraintsDiff,
      indexes: indexesDiff,
      extensions: extensionsDiff,
      storageBuckets: storageBucketsDiff,
      privilegeDrift
    },
    securityFindings,
    unknownChecks
  };
}

function formatComparisonMarkdown(report) {
  const section = (title, items) => {
    if (items === null) return `### ${title}\n- UNKNOWN (not treated as PASS)\n`;
    if (!items || items.length === 0) return `### ${title}\n- None\n`;
    return `### ${title} (${items.length})\n` + items.map((i) => `- \`${typeof i === 'string' ? i : JSON.stringify(i)}\``).join('\n') + '\n';
  };

  return [
    '# Pure Function — Schema-Only QA Parity Comparison Report',
    '',
    `- **QA Project:** \`${report.targetQaProjectRef}\``,
    `- **Reference Snapshot:** \`${report.referenceLabel}\``,
    `- **QA Snapshot:** \`${report.qaLabel}\``,
    `- **Compared At:** \`${report.comparedAt}\``,
    `- **Parity Status:** \`${report.parityStatus}\``,
    '',
    '## Summary',
    `- Tables: expected=${report.summary.tables.expected}, actual=${report.summary.tables.actual}, missing=${report.summary.tables.missing}, rlsDrift=${report.summary.tables.rlsDrift}`,
    `- Functions: expected=${report.summary.functions.expected}, actual=${report.summary.functions.actual}, missing=${report.summary.functions.missing}, attributeDrift=${report.summary.functions.attributeDrift}`,
    `- Triggers: expected=${report.summary.triggers.expected}, actual=${report.summary.triggers.actual}, missing=${report.summary.triggers.missing}, disabled=${report.summary.triggers.disabled}`,
    `- Policies: expected=${report.summary.policies.expected}, actual=${report.summary.policies.actual}, missing=${report.summary.policies.missing}, drift=${report.summary.policies.drift}`,
    `- Storage Buckets: ${report.summary.storageBuckets.status === 'UNKNOWN' ? 'UNKNOWN (not treated as PASS)' : `missing=${report.summary.storageBuckets.missing}, publicDrift=${report.summary.storageBuckets.publicDrift}`}`,
    `- Security Findings: ${report.summary.securityFindings}`,
    '',
    section('Security Findings', report.securityFindings),
    section('Unknown Checks', report.unknownChecks),
    section('Missing Tables', report.objectDiffs.tables.missing),
    section('Missing Functions', report.objectDiffs.functions.missing),
    section('Missing Triggers', report.objectDiffs.triggers.missing),
    section('Missing Policies', report.objectDiffs.policies.missing),
    section('Missing Constraints', report.objectDiffs.constraints.missing),
    section('Missing Indexes', report.objectDiffs.indexes.missing),
    section('Missing Storage Buckets', report.objectDiffs.storageBuckets.missing)
  ].join('\n');
}

function parseArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

function main(argv = process.argv.slice(2)) {
  try {
    assertMetadataOnlyDiscoverySql(METADATA_ONLY_DISCOVERY_SQL);
    assertMetadataOnlyDiscoverySql(STORAGE_BUCKETS_METADATA_SQL);

    if (argv.includes('--validate-only')) {
      console.log(
        `PASS: Schema-only discovery tooling validated locally (schemaVersion=${DISCOVERY_SCHEMA_VERSION}, mode=metadata-only). Zero database calls executed.`
      );
      return;
    }

    if (argv.includes('--print-sql')) {
      console.log('-- METADATA-ONLY CATALOG DISCOVERY (READ-ONLY TRANSACTION)');
      console.log(buildWrappedReadOnlyDiscoverySql(METADATA_ONLY_DISCOVERY_SQL));
      console.log('-- OPTIONAL STORAGE BUCKETS METADATA (RUN ONLY IF storage_buckets_accessible=true)');
      console.log(buildWrappedReadOnlyDiscoverySql(STORAGE_BUCKETS_METADATA_SQL));
      return;
    }

    const scanFile = parseArg(argv, '--scan-ddl');
    if (scanFile) {
      const resolved = path.resolve(scanFile);
      const content = fs.readFileSync(resolved, 'utf8');
      const result = scanDdlForSensitiveContent(content);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safeForQaBaseline) {
        process.exitCode = 1;
      }
      return;
    }

    const compareIdx = argv.indexOf('--compare');
    if (compareIdx !== -1 && compareIdx + 2 < argv.length) {
      const refPath = path.resolve(argv[compareIdx + 1]);
      const qaPath = path.resolve(argv[compareIdx + 2]);
      const refSnap = JSON.parse(fs.readFileSync(refPath, 'utf8'));
      const qaSnap = JSON.parse(fs.readFileSync(qaPath, 'utf8'));
      const report = compareSchemaSnapshots(refSnap, qaSnap);
      const md = formatComparisonMarkdown(report);
      const outJson = parseArg(argv, '--out-json');
      const outMd = parseArg(argv, '--out-md');
      if (outJson) fs.writeFileSync(path.resolve(outJson), JSON.stringify(report, null, 2) + '\n', 'utf8');
      if (outMd) fs.writeFileSync(path.resolve(outMd), md + '\n', 'utf8');
      console.log(md);
      return;
    }

    throw new QaGuardError(
      'Specify --validate-only, --print-sql, --scan-ddl <file>, or --compare <ref.json> <qa.json>.'
    );
  } catch (err) {
    console.error(`FAIL: ${err && err.message ? err.message : 'Schema discovery error.'}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DISCOVERY_SCHEMA_VERSION,
  DISCOVERY_STATEMENT_TIMEOUT_MS,
  ALLOWED_DISCOVERY_CATALOG_RELATIONS,
  FORBIDDEN_DISCOVERY_KEYWORDS,
  FORBIDDEN_RAW_DDL_EXPORTS,
  METADATA_ONLY_DISCOVERY_SQL,
  STORAGE_BUCKETS_METADATA_SQL,
  assertMetadataOnlyDiscoverySql,
  buildWrappedReadOnlyDiscoverySql,
  scanDdlForSensitiveContent,
  compareSchemaSnapshots,
  formatComparisonMarkdown,
  main
};

if (require.main === module) {
  main();
}
