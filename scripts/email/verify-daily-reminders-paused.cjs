'use strict';

const crypto = require('node:crypto');

const ALLOWED_PROJECT_REF = 'rugwzvztweiffprkxfdc';
const EXPECTED_FALSE_SHA256 = crypto.createHash('sha256').update('false', 'utf8').digest('hex');
const MANAGEMENT_API_BASE = 'https://api.supabase.com/v1';

class SafeCheckError extends Error {}

function assertSafe(condition, message) {
  if (!condition) throw new SafeCheckError(message);
}

async function fetchWithTimeout(fetcher, url, options, failureMessage) {
  let res;
  try {
    res = await fetcher(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new SafeCheckError(`${failureMessage} (network or timeout error)`);
  }
  return res;
}

/**
 * Classifies a Management API SQL error into a fixed secret-free reason.
 * Never echoes raw SQL, Vault data, or response payload text.
 */
async function classifyManagementQueryError(res, stepLabel) {
  if (res.status === 401) {
    return `${stepLabel} failed: SUPABASE_ACCESS_TOKEN was rejected (HTTP 401).`;
  }
  if (res.status === 403) {
    return `${stepLabel} failed: SUPABASE_ACCESS_TOKEN lacks database query permission (HTTP 403).`;
  }
  const text = await res.text().catch(() => '');
  if (/42501|permission denied/i.test(text)) {
    return `${stepLabel} failed: database role lacked required privilege (HTTP ${res.status}, SQLSTATE 42501).`;
  }
  if (/25006|read-only transaction/i.test(text)) {
    return `${stepLabel} failed: query was blocked by a read-only transaction (HTTP ${res.status}, SQLSTATE 25006).`;
  }
  if (/42883|42P01|3F000|does not exist/i.test(text)) {
    return `${stepLabel} failed: required pg_net or Vault object was not found (HTTP ${res.status}).`;
  }
  if (/should not exist|must be a|validation/i.test(text)) {
    return `${stepLabel} failed: Management API rejected request payload format (HTTP ${res.status}).`;
  }
  return `${stepLabel} failed (HTTP ${res.status}).`;
}

/**
 * Verifies via Supabase Management API that DAILY_REMINDERS_ENABLED exists on
 * the target project AND its SHA-256 digest equals SHA-256("false").
 * Never logs any token, secret value, or digest.
 */
async function verifyPausedSecretDigest({ projectRef, accessToken, fetcher = globalThis.fetch }) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');
  assertSafe(typeof accessToken === 'string' && accessToken.trim().length > 0, 'SUPABASE_ACCESS_TOKEN is missing.');

  const res = await fetchWithTimeout(
    fetcher,
    `${MANAGEMENT_API_BASE}/projects/${projectRef}/secrets`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken.trim()}` }
    },
    'Failed to read Supabase Edge Function secret metadata'
  );
  if (res.status === 401 || res.status === 403) {
    throw new SafeCheckError(`Supabase secrets metadata access denied (HTTP ${res.status}).`);
  }
  assertSafe(res.ok, `Supabase secrets metadata request failed (HTTP ${res.status}).`);

  const list = await res.json().catch(() => null);
  assertSafe(Array.isArray(list), 'Unexpected response format from Supabase secrets metadata endpoint.');

  const entry = list.find((item) => item && item.name === 'DAILY_REMINDERS_ENABLED');
  assertSafe(entry, 'DAILY_REMINDERS_ENABLED secret is not set on Supabase Production.');

  const remoteDigest = String(entry.value ?? entry.digest ?? '').trim().toLowerCase();
  assertSafe(
    remoteDigest === EXPECTED_FALSE_SHA256,
    'DAILY_REMINDERS_ENABLED is not set to exact value "false". Aborting to prevent live email sends.'
  );
  return true;
}

/**
 * Verifies deployed daily-reminders metadata via Management API:
 * confirms the function is ACTIVE and has verify_jwt === false (--no-verify-jwt).
 */
async function verifyFunctionMetadata({ projectRef, accessToken, fetcher = globalThis.fetch }) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');
  const res = await fetchWithTimeout(
    fetcher,
    `${MANAGEMENT_API_BASE}/projects/${projectRef}/functions/daily-reminders`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken.trim()}` }
    },
    'Failed to read daily-reminders Edge Function metadata'
  );
  if (res.status === 401 || res.status === 403) {
    throw new SafeCheckError(`Edge Function metadata access denied (HTTP ${res.status}).`);
  }
  assertSafe(res.ok, `Edge Function metadata request failed (HTTP ${res.status}).`);

  const meta = await res.json().catch(() => null);
  assertSafe(meta && typeof meta === 'object', 'Unexpected response format from Edge Function metadata endpoint.');
  assertSafe(meta.status === 'ACTIVE', `Expected daily-reminders status ACTIVE, got ${String(meta.status ?? 'unknown')}.`);
  assertSafe(meta.verify_jwt === false, 'Expected daily-reminders verify_jwt to be false (--no-verify-jwt).');
  return { status: meta.status, verifyJwt: meta.verify_jwt, version: Number(meta.version ?? 0) };
}

/**
 * Triggers daily-reminders from inside PostgreSQL using pg_net (same path as pg_cron)
 * and reads ONLY the non-secret HTTP response from net._http_response.
 * The Vault cron_secret NEVER leaves PostgreSQL and NEVER enters Node.js memory or logs.
 */
async function invokePausedCheckInsidePostgres({
  projectRef,
  accessToken,
  fetcher = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPollAttempts = 12,
  pollIntervalMs = 1000
}) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');

  const queryUrl = `${MANAGEMENT_API_BASE}/projects/${projectRef}/database/query`;
  const headers = {
    Authorization: `Bearer ${accessToken.trim()}`,
    'Content-Type': 'application/json'
  };

  // Uses standard Management API body ({ query }) without read_only so Vault + pg_net execute
  // under the postgres role, returning ONLY an integer request_id (zero secret exposure).
  const enqueueSql = [
    'SELECT net.http_post(',
    `  url := 'https://${projectRef}.supabase.co/functions/v1/daily-reminders',`,
    '  headers := jsonb_build_object(',
    "    'Content-Type', 'application/json',",
    "    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)",
    '  ),',
    "  body := '{}'::jsonb",
    ') AS request_id;'
  ].join('\n');

  const enqueueRes = await fetchWithTimeout(
    fetcher,
    queryUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: enqueueSql })
    },
    'Failed to trigger in-database paused-state check'
  );
  if (!enqueueRes.ok) {
    throw new SafeCheckError(await classifyManagementQueryError(enqueueRes, 'In-database pg_net paused check'));
  }

  const enqueueRows = await enqueueRes.json().catch(() => null);
  const rawId = Array.isArray(enqueueRows) ? enqueueRows[0]?.request_id : null;
  const requestId = Number(rawId);
  assertSafe(
    Number.isSafeInteger(requestId) && requestId > 0,
    'pg_net did not return a valid positive integer request_id.'
  );

  // Poll net._http_response for that exact integer request_id (read-only SELECT).
  const pollSql = `SELECT status_code, content, timed_out FROM net._http_response WHERE id = ${requestId} LIMIT 1;`;
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    const pollRes = await fetchWithTimeout(
      fetcher,
      queryUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: pollSql })
      },
      'Failed to read pg_net HTTP response'
    );
    if (!pollRes.ok) {
      throw new SafeCheckError(await classifyManagementQueryError(pollRes, 'Reading pg_net response'));
    }

    const rows = await pollRes.json().catch(() => null);
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      assertSafe(row.timed_out !== true, 'In-database request to daily-reminders timed out.');
      assertSafe(
        Number(row.status_code) === 200,
        `Authorized daily-reminders check returned HTTP ${String(row.status_code ?? 'unknown')}.`
      );
      let body = null;
      try {
        body = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
      } catch {
        throw new SafeCheckError('daily-reminders returned a non-JSON response.');
      }
      return body;
    }

    if (attempt < maxPollAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  throw new SafeCheckError('Timed out waiting for pg_net response from daily-reminders.');
}

/**
 * Verifies the deployed daily-reminders Edge Function without reading Vault secrets
 * into GitHub Actions and without sending any email:
 * 1. Confirms DAILY_REMINDERS_ENABLED digest is literally SHA-256("false") first.
 * 2. Confirms deployed function metadata is ACTIVE with verify_jwt === false.
 * 3. Confirms unauthorized POST (without x-cron-secret) returns HTTP 401.
 * 4. Triggers one authorized POST via in-DB pg_net (secret stays inside Postgres)
 *    and confirms HTTP 200 with paused === true and results === [].
 */
async function verifyDeployedDailyReminders({
  projectRef = ALLOWED_PROJECT_REF,
  accessToken,
  fetcher = globalThis.fetch,
  sleep,
  maxPollAttempts,
  pollIntervalMs,
  log = console.log
}) {
  await verifyPausedSecretDigest({ projectRef, accessToken, fetcher });
  log('PASS: DAILY_REMINDERS_ENABLED="false" confirmed via secret digest before invoking function.');

  const meta = await verifyFunctionMetadata({ projectRef, accessToken, fetcher });
  log(`PASS: daily-reminders metadata confirmed (status=${meta.status}, verify_jwt=${String(meta.verifyJwt)}).`);

  const functionUrl = `https://${projectRef}.supabase.co/functions/v1/daily-reminders`;

  // Unauthorized call must be rejected with 401 (proves x-cron-secret check is active).
  const unauthRes = await fetchWithTimeout(
    fetcher,
    functionUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    },
    'Unauthorized check against daily-reminders failed'
  );
  assertSafe(
    unauthRes.status === 401,
    `Expected HTTP 401 for unauthorized daily-reminders request, got HTTP ${unauthRes.status}.`
  );
  log('PASS: Unauthorized POST to daily-reminders rejected with HTTP 401.');

  // Authorized check runs via pg_net inside Postgres so cron_secret never leaves Vault/DB.
  const body = await invokePausedCheckInsidePostgres({
    projectRef,
    accessToken,
    fetcher,
    sleep,
    maxPollAttempts,
    pollIntervalMs
  });

  assertSafe(body && typeof body === 'object', 'daily-reminders returned a non-JSON response.');
  assertSafe(body.paused === true, 'daily-reminders did NOT return paused: true.');
  assertSafe(
    Array.isArray(body.results) && body.results.length === 0,
    'daily-reminders returned non-empty results instead of an empty paused list.'
  );

  const safeToday = typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : 'unknown';
  const safeTz = typeof body.timezone === 'string' && /^[A-Za-z0-9_/+ -]{1,64}$/.test(body.timezone) ? body.timezone : 'unknown';
  log(
    `PASS: Authorized in-DB pg_net POST confirmed paused=true (today=${safeToday}, timezone=${safeTz}, results=0). Vault secret never left Postgres; zero emails sent.`
  );

  return { paused: true, today: safeToday, timezone: safeTz, resultCount: 0 };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv.includes('--pre-deploy')
    ? 'pre-deploy'
    : argv.includes('--post-deploy')
    ? 'post-deploy'
    : null;

  const projectRef = (env.SUPABASE_PROJECT_REF || ALLOWED_PROJECT_REF).trim();
  const accessToken = env.SUPABASE_ACCESS_TOKEN || '';

  try {
    if (mode === 'pre-deploy') {
      await verifyPausedSecretDigest({ projectRef, accessToken });
      console.log('PASS: Pre-deploy gate confirmed DAILY_REMINDERS_ENABLED="false" on target project.');
      return;
    }
    if (mode === 'post-deploy') {
      await verifyDeployedDailyReminders({ projectRef, accessToken });
      return;
    }
    console.error('Usage: node scripts/email/verify-daily-reminders-paused.cjs <--pre-deploy|--post-deploy>');
    process.exitCode = 2;
  } catch (err) {
    const safeMsg = err instanceof SafeCheckError ? err.message : 'Verification failed due to an unexpected error.';
    console.error(`FAIL: ${safeMsg}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_PROJECT_REF,
  EXPECTED_FALSE_SHA256,
  SafeCheckError,
  verifyPausedSecretDigest,
  verifyFunctionMetadata,
  invokePausedCheckInsidePostgres,
  verifyDeployedDailyReminders,
  main
};

if (require.main === module) {
  main();
}
