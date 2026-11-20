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
 * Reads cron_secret strictly read-only in memory via Supabase Management API.
 * Never logs, writes to disk, or exposes the secret in error messages.
 */
async function fetchCronSecretReadOnly({ projectRef, accessToken, fetcher = globalThis.fetch }) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');
  const res = await fetchWithTimeout(
    fetcher,
    `${MANAGEMENT_API_BASE}/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1;",
        read_only: true
      })
    },
    'Failed to read cron_secret from Vault'
  );
  assertSafe(res.ok, `Read-only Vault lookup failed (HTTP ${res.status}).`);

  const rows = await res.json().catch(() => null);
  const secret = Array.isArray(rows) ? String(rows[0]?.decrypted_secret ?? '').trim() : '';
  assertSafe(secret.length >= 16, 'cron_secret could not be retrieved from Vault.');
  return secret;
}

/**
 * Verifies the deployed daily-reminders Edge Function without sending any email:
 * 1. Confirms DAILY_REMINDERS_ENABLED digest is literally SHA-256("false") first.
 * 2. Confirms unauthorized POST (without x-cron-secret) returns HTTP 401.
 * 3. Sends one authorized POST and confirms HTTP 200 with paused === true and results === [].
 */
async function verifyDeployedDailyReminders({
  projectRef = ALLOWED_PROJECT_REF,
  accessToken,
  fetcher = globalThis.fetch,
  log = console.log
}) {
  await verifyPausedSecretDigest({ projectRef, accessToken, fetcher });
  log('PASS: DAILY_REMINDERS_ENABLED="false" confirmed via secret digest before invoking function.');

  const functionUrl = `https://${projectRef}.supabase.co/functions/v1/daily-reminders`;

  // 1) Unauthorized call must be rejected with 401 (proves x-cron-secret check is active).
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

  // 2) Authorized call must return 200 with paused: true and empty results.
  const cronSecret = await fetchCronSecretReadOnly({ projectRef, accessToken, fetcher });
  const authRes = await fetchWithTimeout(
    fetcher,
    functionUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': cronSecret
      },
      body: '{}'
    },
    'Authorized paused-state check against daily-reminders failed'
  );
  assertSafe(authRes.ok, `Authorized daily-reminders check returned HTTP ${authRes.status}.`);

  const body = await authRes.json().catch(() => null);
  assertSafe(body && typeof body === 'object', 'daily-reminders returned a non-JSON response.');
  assertSafe(body.paused === true, 'daily-reminders did NOT return paused: true.');
  assertSafe(
    Array.isArray(body.results) && body.results.length === 0,
    'daily-reminders returned non-empty results instead of an empty paused list.'
  );

  const safeToday = typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : 'unknown';
  const safeTz = typeof body.timezone === 'string' && /^[A-Za-z0-9_/+ -]{1,64}$/.test(body.timezone) ? body.timezone : 'unknown';
  log(`PASS: Authorized POST confirmed paused=true (today=${safeToday}, timezone=${safeTz}, results=0). Zero emails sent.`);

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
  fetchCronSecretReadOnly,
  verifyDeployedDailyReminders,
  main
};

if (require.main === module) {
  main();
}
