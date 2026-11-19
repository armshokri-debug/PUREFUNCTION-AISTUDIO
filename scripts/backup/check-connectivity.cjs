'use strict';

const { spawnSync } = require('node:child_process');
const { EXPECTED_BUCKETS } = require('./backup-lib.cjs');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCHEMAS = "('public', 'private', 'auth', 'storage', 'supabase_migrations')";
const PRIVILEGE_SQL = `
SELECT
  (SELECT count(*) = 5 AND bool_and(has_schema_privilege(oid, 'USAGE'))
   FROM pg_namespace WHERE nspname IN ${SCHEMAS})
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ${SCHEMAS} AND c.relkind IN ('r', 'p', 'm', 'S')
      AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege(c.oid, 'SELECT')
               ELSE NOT has_table_privilege(c.oid, 'SELECT') OR row_security_active(c.oid) END
  );
`;
const DB_STATEMENTS = [
  'BEGIN READ ONLY',
  "SET LOCAL statement_timeout = '12s'",
  "SELECT 'connected'",
  PRIVILEGE_SQL,
  'SELECT 1 FROM public.clients LIMIT 0',
  'SELECT 1 FROM auth.users LIMIT 0',
  'SELECT 1 FROM storage.objects LIMIT 0',
  'ROLLBACK'
];

class ProbeFailure extends Error {}

function requireProbe(condition, reason) {
  if (!condition) throw new ProbeFailure(reason);
}

async function request(fetcher, url, options, failure) {
  const response = await fetcher(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(12000)
  });
  requireProbe(response.ok, `${failure} (HTTP ${response.status})`);
  return response;
}

async function checkDrive(env, fetcher) {
  requireProbe(
    env.BACKUP_GDRIVE_CLIENT_ID && env.BACKUP_GDRIVE_CLIENT_SECRET && env.BACKUP_GDRIVE_REFRESH_TOKEN,
    'OAuth configuration is incomplete'
  );
  const tokenResponse = await request(fetcher, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.BACKUP_GDRIVE_CLIENT_ID.trim(),
      client_secret: env.BACKUP_GDRIVE_CLIENT_SECRET.trim(),
      refresh_token: env.BACKUP_GDRIVE_REFRESH_TOKEN.trim(),
      grant_type: 'refresh_token'
    })
  }, 'OAuth refresh rejected');

  const { access_token: token, scope } = await tokenResponse.json();
  requireProbe(typeof token === 'string' && token.length > 0, 'OAuth access token was unavailable');
  const granted = typeof scope === 'string' ? scope.trim().split(/\s+/) : [];
  requireProbe(granted.length === 1 && granted[0] === DRIVE_SCOPE, 'Exclusive drive.file grant could not be verified');

  await request(fetcher, 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=kind', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  }, 'Drive file listing rejected');
  return 'Refresh Token, drive.file scope and Drive API read access verified';
}

function postgresFailure(result, connected) {
  const diagnostic = result.stderr ?? '';
  if (result.error?.code === 'ENOENT') return 'PostgreSQL client is unavailable';
  if (result.error?.code === 'ETIMEDOUT' || /timeout expired|connection timed out/i.test(diagnostic)) return 'PostgreSQL connection or query timed out';
  if (/password authentication failed|28P01|wrong password|authentication failed/i.test(diagnostic)) return 'PostgreSQL authentication rejected the configured credentials';
  if (/tenant or user not found|role .* does not exist|28000/i.test(diagnostic)) return 'PostgreSQL did not recognize the configured pooler user or project';
  if (/42501|permission denied|row-level security/i.test(diagnostic)) return 'PostgreSQL authentication worked but read privileges are incomplete';
  if (/42P01|3F000|relation .* does not exist/i.test(diagnostic)) return 'A required PostgreSQL table or schema is unavailable';
  if (/could not translate host|name or service not known|connection refused|network is unreachable|no route to host/i.test(diagnostic)) return 'PostgreSQL host could not be reached';
  if (/certificate|SSL error|TLS error/i.test(diagnostic)) return 'PostgreSQL TLS connection failed';
  return connected ? 'PostgreSQL authenticated but the read-only query failed' : 'PostgreSQL connection or read-only query failed';
}

function checkPostgres(env, run) {
  const ref = env.SUPABASE_PROJECT_REF;
  let raw = env.SUPABASE_DB_URL?.trim();
  if (raw) {
    raw = raw.replace(/^(?:SUPABASE_DB_URL\s*=\s*|psql\s+)/i, '').trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  }
  requireProbe(raw, 'Database URI secret is empty');
  requireProbe(/^postgres(?:ql)?:\/\//i.test(raw), 'Database secret does not contain a recognized PostgreSQL URI');
  let uri;
  try {
    uri = new URL(raw);
  } catch {
    throw new ProbeFailure('Database URI is malformed; check percent-encoding of reserved password characters');
  }
  let user, password;
  try {
    user = decodeURIComponent(uri.username);
    password = decodeURIComponent(uri.password);
  } catch {
    throw new ProbeFailure('Database URI contains invalid percent-encoding');
  }
  requireProbe(password, 'Database URI password field is empty');
  requireProbe(!/^\[YOUR-(?:DATABASE-)?PASSWORD\]$/i.test(password), 'Database URI password field still contains the Supabase placeholder');
  requireProbe(!password.includes('\0') && !user.includes('\0'), 'Database URI contains an invalid encoded character');
  const direct = uri.hostname === `db.${ref}.supabase.co`;
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(uri.hostname) && user.endsWith(`.${ref}`);
  const sslmode = uri.searchParams.get('sslmode');
  requireProbe(['postgres:', 'postgresql:'].includes(uri.protocol), 'Database URI is not a PostgreSQL URI');
  requireProbe(direct || /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(uri.hostname), 'Database URI hostname is not the expected Supabase endpoint');
  requireProbe(direct || pooler, 'Database Session Pooler username does not end with the project reference');
  requireProbe(!uri.port || uri.port === '5432', 'Database URI must use Session Pooler port 5432');
  requireProbe(uri.pathname === '/postgres', 'Database URI path must be /postgres');
  requireProbe(!uri.hash, 'Database URI contains a fragment; check password encoding or remove a trailing fragment');
  requireProbe(['require', 'verify-ca', 'verify-full'].includes(sslmode), 'Database URI lacks a supported sslmode');
  requireProbe([...uri.searchParams.keys()].every(key => key === 'sslmode'), 'Database URI contains parameters other than sslmode');

  const result = run('psql', [
    '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    ...DB_STATEMENTS.flatMap(statement => ['-c', statement])
  ], {
    encoding: 'utf8',
    timeout: 25000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      PGHOST: uri.hostname,
      PGPORT: '5432',
      PGDATABASE: 'postgres',
      PGUSER: user,
      PGPASSWORD: password,
      PGSSLMODE: sslmode,
      PGCONNECT_TIMEOUT: '10',
      LC_ALL: 'C'
    }
  });
  const [connectionMarker, privileges] = (result.stdout ?? '').trim().split('\n');
  if (result.status !== 0) throw new ProbeFailure(postgresFailure(result, connectionMarker === 'connected'));
  requireProbe(connectionMarker === 'connected' && privileges === 't', 'PostgreSQL read privileges are incomplete');
  return 'PostgreSQL connection and read privileges on backup schemas verified';
}

async function checkStorage(env, fetcher) {
  const base = `https://${env.SUPABASE_PROJECT_REF}.supabase.co`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  requireProbe(env.SUPABASE_URL?.replace(/\/$/, '') === base && key, 'Storage configuration is incomplete or points to another project');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const bucketsResponse = await request(fetcher, `${base}/storage/v1/bucket`, {
    method: 'GET', headers
  }, 'Storage bucket listing rejected');
  const buckets = await bucketsResponse.json();
  requireProbe(
    Array.isArray(buckets) && EXPECTED_BUCKETS.every(id => buckets.some(bucket => bucket.id === id)),
    'Expected Storage buckets were not visible'
  );

  let objectChecked = false;
  for (const id of EXPECTED_BUCKETS) {
    const bucket = encodeURIComponent(id);
    const prefixes = [''];
    for (let attempt = 0; attempt < 5 && prefixes.length; attempt++) {
      const prefix = prefixes.shift();
      const list = await request(fetcher, `${base}/storage/v1/object/list/${bucket}`, {
        method: 'POST', // Storage uses POST for this read-only listing operation.
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 20, offset: 0 })
      }, 'Storage object listing rejected');
      const entries = await list.json();
      requireProbe(Array.isArray(entries), 'Storage object listing returned an unexpected response');

      const object = entries.find(item => item?.id && item.name && item.name !== '.emptyFolderPlaceholder');
      if (object) {
        const objectPath = [prefix, object.name].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
        await request(fetcher, `${base}/storage/v1/object/authenticated/${bucket}/${objectPath}`, {
          method: 'HEAD', headers
        }, 'Storage object read access rejected');
        objectChecked = true;
        break;
      }
      for (const item of entries) {
        if (item && !item.id && item.name) prefixes.push([prefix, item.name].filter(Boolean).join('/'));
      }
    }
  }
  requireProbe(objectChecked, 'Storage listings worked but no object was available to verify read access');
  return 'Storage bucket and object listing plus authenticated object HEAD verified';
}

async function runConnectivity({
  env = process.env,
  fetcher = globalThis.fetch,
  run = spawnSync,
  log = console.log
} = {}) {
  if (env.ENABLE_SUPABASE_BACKUP !== 'false' ||
      !/^[a-z0-9]{20}$/.test(env.SUPABASE_PROJECT_REF ?? '')) {
    log('BLOCKED: backup must be disabled and the Supabase project ref must be configured');
    return false;
  }
  const probes = [
    ['Google Drive', () => checkDrive(env, fetcher)],
    ['PostgreSQL', () => checkPostgres(env, run)],
    ['Supabase Storage', () => checkStorage(env, fetcher)]
  ];
  let passed = true;
  for (const [service, probe] of probes) {
    try {
      log(`PASS ${service}: ${await probe()}`);
    } catch (error) {
      const reason = error instanceof ProbeFailure ? error.message : 'connection or response validation failed';
      log(`FAIL ${service}: ${reason}`);
      passed = false;
    }
  }
  return passed;
}

module.exports = { runConnectivity };

if (require.main === module) {
  runConnectivity().then(passed => {
    process.exitCode = passed ? 0 : 1;
  });
}
