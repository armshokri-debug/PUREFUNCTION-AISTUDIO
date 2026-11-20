'use strict';

const ALLOWED_QA_PROJECT_REF = 'nsshdxxdvzzxlmdomixf';
const FORBIDDEN_PRODUCTION_PROJECT_REF = 'rugwzvztweiffprkxfdc';
const ALLOWED_REPOSITORY = 'armshokri-debug/PUREFUNCTION-AISTUDIO';

/**
 * Environment variables that must NEVER be used as fallbacks or injected into
 * the read-only QA audit execution environment.
 */
const FORBIDDEN_PRIVILEGED_ENV_VARS = Object.freeze([
  'SUPABASE_PROJECT_REF',
  'SUPABASE_DB_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'QA_SUPABASE_DB_URL',
  'QA_SUPABASE_SERVICE_ROLE_KEY',
  'QA_SUPABASE_ACCESS_TOKEN',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY'
]);

/**
 * PostgreSQL roles that are privileged, write-capable, or unsuitable for a
 * strictly read-only catalog audit.
 */
const FORBIDDEN_PRIVILEGED_DB_ROLES = Object.freeze(
  new Set([
    'postgres',
    'root',
    'admin',
    'supabase_admin',
    'supabase_auth_admin',
    'supabase_storage_admin',
    'supabase_functions_admin',
    'supabase_replication_admin',
    'supabase_read_only_user',
    'service_role',
    'authenticator',
    'dashboard_user',
    'pgbouncer',
    'pgsodium_keyholder',
    'pgsodium_keymaker',
    'anon',
    'authenticated'
  ])
);

/**
 * Explicitly permitted base role names for the read-only QA audit connection.
 * supabase_read_only_user is explicitly excluded and forbidden because in
 * Supabase it carries BYPASSRLS and pg_read_all_data.
 */
const ALLOWED_READONLY_ROLE_PATTERN = /^(qa_readonly(?:_user)?|qa_catalog_readonly|readonly(?:_user)?)$/i;

/**
 * Allowed TLS modes for PostgreSQL read-only connections.
 */
const FORBIDDEN_SSL_MODES = Object.freeze(new Set(['disable', 'allow', 'prefer']));

/**
 * Strict allowlist of pg_catalog and bucket-metadata relations that the
 * read-only parity audit SQL may reference in FROM / JOIN clauses.
 * information_schema views are intentionally excluded because PostgreSQL
 * filters them by table privileges.
 */
const ALLOWED_AUDIT_SQL_RELATIONS = Object.freeze(
  new Set([
    'pg_catalog.pg_roles',
    'pg_catalog.pg_class',
    'pg_catalog.pg_namespace',
    'pg_catalog.pg_attribute',
    'pg_catalog.pg_type',
    'pg_catalog.pg_constraint',
    'pg_catalog.pg_proc',
    'pg_catalog.pg_trigger',
    'pg_catalog.pg_policies',
    'storage.buckets'
  ])
);

/**
 * SQL keywords and dangerous functions that are forbidden anywhere in a
 * read-only audit statement (evaluated after stripping comments and
 * single-quoted string literals).
 */
const FORBIDDEN_SQL_KEYWORDS = Object.freeze([
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

class QaGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QaGuardError';
  }
}

function assertGuard(condition, message) {
  if (!condition) {
    throw new QaGuardError(message);
  }
}

/**
 * Extract independent secret candidates (including raw and decoded DB passwords
 * and any sensitive env values) so error redaction catches standalone secrets
 * even when they appear without a postgres:// URL prefix.
 */
function extractSecretCandidatesFromEnv(env = {}) {
  const candidates = new Set();
  if (!env || typeof env !== 'object') return [];

  const addCandidate = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 4) {
      candidates.add(trimmed);
      try {
        const decoded = decodeURIComponent(trimmed);
        if (decoded.length >= 4) candidates.add(decoded);
      } catch {
        // Ignore malformed percent-encoding
      }
      try {
        const encoded = encodeURIComponent(trimmed);
        if (encoded.length >= 4) candidates.add(encoded);
      } catch {
        // Ignore encoding errors
      }
    }
  };

  for (const [key, rawValue] of Object.entries(env)) {
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) continue;
    if (/(?:PASSWORD|SECRET|TOKEN|KEY|DB_URL)/i.test(key)) {
      addCandidate(rawValue);
      // Extract embedded password from URL even if URL parsing fails
      const dsnPassMatch = rawValue.match(/:\/\/[^:@/\s]+:([^@/\s]+)@/);
      if (dsnPassMatch && dsnPassMatch[1]) {
        addCandidate(dsnPassMatch[1]);
      }
      try {
        const parsed = new URL(rawValue.trim());
        if (parsed.password) addCandidate(parsed.password);
      } catch {
        // Ignore non-URL values
      }
    }
  }

  return [...candidates].sort((a, b) => b.length - a.length);
}

/**
 * Redact known secret values, standalone passwords, and PostgreSQL connection
 * strings before printing or returning any diagnostic text.
 */
function redactSecrets(text, secretValues = []) {
  let out = String(text ?? '');
  out = out.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[REDACTED_DB_URL]');
  out = out.replace(/(PGPASSWORD\s*=\s*)[^\s"'`]+/gi, '$1[REDACTED]');
  const normalized = [];
  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret.trim().length < 4) continue;
    normalized.push(secret);
    const trimmed = secret.trim();
    if (trimmed !== secret) normalized.push(trimmed);
    try {
      const decoded = decodeURIComponent(trimmed);
      if (decoded.length >= 4) normalized.push(decoded);
    } catch {
      // Ignore malformed percent-encoding
    }
  }
  const uniqueSorted = [...new Set(normalized)].sort((a, b) => b.length - a.length);
  for (const secret of uniqueSorted) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/**
 * Reject any input containing the Production Supabase project ref.
 */
function assertNoProductionReference(value, label = 'configuration value') {
  if (value === undefined || value === null) return;
  const text = String(value).toLowerCase();
  assertGuard(
    !text.includes(FORBIDDEN_PRODUCTION_PROJECT_REF),
    `Blocked: ${label} references the forbidden Production project.`
  );
}

/**
 * Strictly enforce that the target project ref is the approved QA project.
 */
function assertQaProjectRef(projectRef) {
  assertGuard(
    typeof projectRef === 'string' && projectRef.trim().length > 0,
    'Missing QA_SUPABASE_PROJECT_REF. Explicit QA project ref is required.'
  );
  const trimmed = projectRef.trim();
  assertNoProductionReference(trimmed, 'QA_SUPABASE_PROJECT_REF');
  assertGuard(
    trimmed === ALLOWED_QA_PROJECT_REF,
    `Blocked: project ref must be the approved QA project (${ALLOWED_QA_PROJECT_REF}).`
  );
  return trimmed;
}

/**
 * Validate an optional QA Supabase API URL (must match the QA project exactly).
 */
function validateQaApiUrl(rawUrl, expectedProjectRef = ALLOWED_QA_PROJECT_REF) {
  assertQaProjectRef(expectedProjectRef);
  assertGuard(typeof rawUrl === 'string' && rawUrl.trim().length > 0, 'QA_SUPABASE_URL is empty.');
  const trimmed = rawUrl.trim();
  assertNoProductionReference(trimmed, 'QA_SUPABASE_URL');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new QaGuardError('QA_SUPABASE_URL is not a valid URL.');
  }

  assertGuard(parsed.protocol === 'https:', 'QA_SUPABASE_URL must use https://.');
  assertGuard(!parsed.username && !parsed.password, 'QA_SUPABASE_URL must not contain embedded credentials.');
  assertGuard(
    parsed.hostname.toLowerCase() === `${expectedProjectRef}.supabase.co`,
    'Blocked: QA_SUPABASE_URL host does not match the approved QA project.'
  );
  assertGuard(
    (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash,
    'QA_SUPABASE_URL must be the bare QA project origin.'
  );

  return `https://${expectedProjectRef}.supabase.co`;
}

/**
 * Validate a strictly read-only PostgreSQL connection string locked to QA.
 * Never includes credentials or the raw DSN in thrown errors or return values.
 */
function validateQaReadOnlyDbUrl(rawUrl, expectedProjectRef = ALLOWED_QA_PROJECT_REF) {
  assertQaProjectRef(expectedProjectRef);
  assertGuard(
    typeof rawUrl === 'string' && rawUrl.trim().length > 0,
    'Missing QA_SUPABASE_READONLY_DB_URL. A dedicated read-only QA database URL is required.'
  );

  const trimmed = rawUrl.trim();
  assertNoProductionReference(trimmed, 'QA_SUPABASE_READONLY_DB_URL');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new QaGuardError('QA_SUPABASE_READONLY_DB_URL is not a valid PostgreSQL connection URL.');
  }

  assertGuard(
    parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:',
    'QA_SUPABASE_READONLY_DB_URL must use postgres:// or postgresql://.'
  );

  const host = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username || '').trim();
  const password = decodeURIComponent(parsed.password || '');
  const database = decodeURIComponent((parsed.pathname || '/postgres').replace(/^\/+/, '')) || 'postgres';
  const port = parsed.port ? Number(parsed.port) : 5432;

  assertGuard(Boolean(host), 'QA_SUPABASE_READONLY_DB_URL is missing a database host.');
  assertGuard(Number.isInteger(port) && port >= 1 && port <= 65535, 'QA_SUPABASE_READONLY_DB_URL has an invalid port.');
  assertGuard(Boolean(username), 'QA_SUPABASE_READONLY_DB_URL is missing a database username.');
  assertGuard(password.length > 0, 'QA_SUPABASE_READONLY_DB_URL must include a password for the read-only role.');

  assertNoProductionReference(host, 'database host');
  assertNoProductionReference(username, 'database username');

  const directHost = `db.${expectedProjectRef}.supabase.co`;
  const isDirectQaHost = host === directHost;
  const isPoolerHost = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);

  let connectionMode;
  let baseRole;

  if (isDirectQaHost) {
    connectionMode = 'direct';
    baseRole = username.toLowerCase();
  } else if (isPoolerHost) {
    const suffix = `.${expectedProjectRef}`;
    assertGuard(
      username.toLowerCase().endsWith(suffix) && username.length > suffix.length,
      `Blocked: pooler username must be scoped to QA project (${expectedProjectRef}).`
    );
    connectionMode = 'pooler';
    baseRole = username.slice(0, -suffix.length).toLowerCase();
  } else {
    throw new QaGuardError(
      `Blocked: database host must target QA direct (${directHost}) or Supabase pooler scoped to ${expectedProjectRef}.`
    );
  }

  assertGuard(
    !FORBIDDEN_PRIVILEGED_DB_ROLES.has(baseRole),
    `Blocked: privileged database role "${baseRole}" is forbidden for read-only QA audits.`
  );
  assertGuard(
    ALLOWED_READONLY_ROLE_PATTERN.test(baseRole),
    `Blocked: database role "${baseRole}" is not an approved read-only audit role (expected qa_readonly or qa_catalog_readonly).`
  );

  const sslmode = (parsed.searchParams.get('sslmode') || '').trim().toLowerCase();
  if (sslmode) {
    assertGuard(
      !FORBIDDEN_SSL_MODES.has(sslmode),
      `Blocked: insecure sslmode "${sslmode}" is forbidden. Use sslmode=require or verify-full.`
    );
  }

  return {
    projectRef: expectedProjectRef,
    host,
    port,
    database,
    username,
    baseRole,
    connectionMode,
    sslmode: sslmode || 'require'
  };
}

/**
 * Validate the full environment for running a live read-only QA audit.
 * Fails closed if any Production or privileged fallback env var is present.
 */
function validateQaReadOnlyAuditEnv(env = process.env) {
  assertGuard(env && typeof env === 'object', 'Invalid environment object.');

  if (env.GITHUB_REPOSITORY) {
    assertGuard(
      String(env.GITHUB_REPOSITORY).trim() === ALLOWED_REPOSITORY,
      `Blocked: repository must be ${ALLOWED_REPOSITORY}.`
    );
  }

  for (const forbiddenVar of FORBIDDEN_PRIVILEGED_ENV_VARS) {
    const raw = env[forbiddenVar];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      throw new QaGuardError(
        `Blocked: forbidden or privileged credential variable "${forbiddenVar}" must not be supplied to the read-only QA audit.`
      );
    }
  }

  const projectRef = assertQaProjectRef(env.QA_SUPABASE_PROJECT_REF);
  const db = validateQaReadOnlyDbUrl(env.QA_SUPABASE_READONLY_DB_URL, projectRef);

  let apiUrl = null;
  if (typeof env.QA_SUPABASE_URL === 'string' && env.QA_SUPABASE_URL.trim().length > 0) {
    apiUrl = validateQaApiUrl(env.QA_SUPABASE_URL, projectRef);
  }

  return {
    projectRef,
    db,
    apiUrl
  };
}

/**
 * Strip SQL comments and single-quoted literals for static safety inspection.
 */
function stripSqlCommentsAndLiterals(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // Single-line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // Block comment
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
      assertGuard(closed, 'Blocked: unterminated SQL block comment.');
      out += ' ';
      continue;
    }

    // Single-quoted string literal
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
      assertGuard(closed, 'Blocked: unterminated SQL string literal.');
      out += ' __STR__ ';
      continue;
    }

    // Dollar-quoted strings are forbidden in static catalog audit SQL
    if (ch === '$') {
      throw new QaGuardError('Blocked: dollar-quoted SQL blocks are not allowed in read-only audit queries.');
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Statically enforce that an audit query is a single read-only SELECT/WITH
 * statement referencing only approved catalog / bucket-metadata relations.
 */
function assertReadOnlySql(sql, { enforceCatalogAllowlist = true } = {}) {
  assertGuard(typeof sql === 'string' && sql.trim().length > 0, 'Audit SQL must be a non-empty string.');

  const cleaned = stripSqlCommentsAndLiterals(sql).trim();
  const withoutTrailingSemicolon = cleaned.endsWith(';') ? cleaned.slice(0, -1).trim() : cleaned;

  assertGuard(
    !withoutTrailingSemicolon.includes(';'),
    'Blocked: multi-statement SQL is forbidden in read-only audit queries.'
  );
  assertGuard(
    /^(SELECT|WITH)\b/i.test(withoutTrailingSemicolon),
    'Blocked: read-only audit SQL must begin with SELECT or WITH.'
  );

  for (const keyword of FORBIDDEN_SQL_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    assertGuard(
      !re.test(withoutTrailingSemicolon),
      `Blocked: forbidden SQL keyword "${keyword}" detected in read-only audit query.`
    );
  }

  if (enforceCatalogAllowlist) {
    // Reject comma-separated FROM/JOIN lists (e.g., "FROM pg_catalog.pg_class c, clients")
    const commaJoinRegex =
      /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s*,/gi;
    assertGuard(
      !commaJoinRegex.test(withoutTrailingSemicolon),
      'Blocked: comma-separated FROM/JOIN targets are forbidden in read-only audit queries.'
    );

    // Inspect EVERY FROM / JOIN target, including unschema-qualified and quoted identifiers.
    const relationRegex =
      /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(\(|"?[a-z_][a-z0-9_]*"?(?:\s*\.\s*"?[a-z_][a-z0-9_]*"?)?)/gi;
    let match;
    let foundRelation = false;
    while ((match = relationRegex.exec(withoutTrailingSemicolon)) !== null) {
      const rawTarget = match[1].trim();
      if (rawTarget === '(') {
        // Parenthesized subquery: its own inner FROM/JOIN clauses are inspected by this loop.
        continue;
      }
      foundRelation = true;
      const normalized = rawTarget.replace(/"/g, '').replace(/\s*\.\s*/g, '.').toLowerCase();
      assertGuard(
        normalized.includes('.'),
        `Blocked: unschema-qualified relation "${normalized}" is forbidden; explicit allowlisted schema.table is required.`
      );
      assertGuard(
        ALLOWED_AUDIT_SQL_RELATIONS.has(normalized),
        `Blocked: relation "${normalized}" is not on the read-only catalog allowlist.`
      );
    }
    assertGuard(foundRelation, 'Blocked: catalog audit query must explicitly read from allowlisted catalog relations.');
  }

  return true;
}

/**
 * Verify runtime database session metadata returned by PostgreSQL itself.
 * Enforces transaction_read_only=on, non-privileged role attributes, and
 * absence of pg_read_all_data so the audit role cannot read arbitrary customer data.
 */
function assertRuntimeReadOnlySession(sessionInfo) {
  assertGuard(sessionInfo && typeof sessionInfo === 'object', 'Missing runtime PostgreSQL session verification.');
  assertGuard(
    String(sessionInfo.transaction_read_only || '').toLowerCase() === 'on',
    'Blocked: PostgreSQL session did not confirm transaction_read_only=on.'
  );
  assertGuard(
    sessionInfo.rolsuper === false &&
      sessionInfo.rolcreaterole === false &&
      sessionInfo.rolcreatedb === false,
    'Blocked: live database role holds privileged attributes (superuser/createrole/createdb).'
  );
  assertGuard(
    sessionInfo.rolbypassrls === false,
    'Blocked: live audit role must explicitly confirm rolbypassrls=false (BYPASSRLS or unknown value is forbidden).'
  );
  assertGuard(
    sessionInfo.has_pg_read_all_data === false,
    'Blocked: live audit role must NOT hold pg_read_all_data; use a least-privilege catalog-only role.'
  );

  const currentUser = String(sessionInfo.current_user || '').trim().toLowerCase();
  assertGuard(Boolean(currentUser), 'Missing current_user in runtime session check.');
  const baseRole = currentUser.endsWith(`.${ALLOWED_QA_PROJECT_REF}`)
    ? currentUser.slice(0, -(`.${ALLOWED_QA_PROJECT_REF}`).length)
    : currentUser;

  assertGuard(
    !FORBIDDEN_PRIVILEGED_DB_ROLES.has(baseRole) && ALLOWED_READONLY_ROLE_PATTERN.test(baseRole),
    `Blocked: live PostgreSQL role "${baseRole}" is not an approved read-only role.`
  );

  return {
    currentUser: baseRole,
    transactionReadOnly: 'on',
    statementTimeout: sessionInfo.statement_timeout || null,
    rolbypassrls: false,
    hasPgReadAllData: false
  };
}

module.exports = {
  ALLOWED_QA_PROJECT_REF,
  FORBIDDEN_PRODUCTION_PROJECT_REF,
  ALLOWED_REPOSITORY,
  FORBIDDEN_PRIVILEGED_ENV_VARS,
  FORBIDDEN_PRIVILEGED_DB_ROLES,
  ALLOWED_READONLY_ROLE_PATTERN,
  ALLOWED_AUDIT_SQL_RELATIONS,
  QaGuardError,
  extractSecretCandidatesFromEnv,
  redactSecrets,
  assertNoProductionReference,
  assertQaProjectRef,
  validateQaApiUrl,
  validateQaReadOnlyDbUrl,
  validateQaReadOnlyAuditEnv,
  assertReadOnlySql,
  assertRuntimeReadOnlySession
};
