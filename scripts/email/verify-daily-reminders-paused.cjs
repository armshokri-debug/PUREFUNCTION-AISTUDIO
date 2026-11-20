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
  try {
    return await fetcher(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new SafeCheckError(failureMessage + ' (network or timeout error)');
  }
}

/**
 * Read-only verification of Edge Function secret metadata. The Management API
 * returns a digest; never request, print, or expose a secret value.
 */
async function verifyPausedSecretDigest({ projectRef, accessToken, fetcher = globalThis.fetch }) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');
  assertSafe(typeof accessToken === 'string' && accessToken.trim().length > 0, 'SUPABASE_ACCESS_TOKEN is missing.');

  const res = await fetchWithTimeout(
    fetcher,
    MANAGEMENT_API_BASE + '/projects/' + projectRef + '/secrets',
    { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken.trim() } },
    'Unable to read Edge Function secret metadata'
  );
  assertSafe(res.ok, 'Secret metadata read failed (HTTP ' + res.status + ').');
  const list = await res.json().catch(() => null);
  assertSafe(Array.isArray(list), 'Unexpected secret metadata response.');
  const entry = list.find((x) => x && x.name === 'DAILY_REMINDERS_ENABLED');
  assertSafe(entry, 'DAILY_REMINDERS_ENABLED is missing.');
  const digest = String(entry.value ?? entry.digest ?? '').trim().toLowerCase();
  assertSafe(digest === EXPECTED_FALSE_SHA256, 'Daily reminders are not explicitly paused. Aborting.');
  return true;
}

/**
 * Read-only verification of current deployed function configuration.
 */
async function verifyFunctionMetadata({ projectRef, accessToken, fetcher = globalThis.fetch }) {
  assertSafe(projectRef === ALLOWED_PROJECT_REF, 'Project ref does not match the approved Production project.');
  assertSafe(typeof accessToken === 'string' && accessToken.trim().length > 0, 'SUPABASE_ACCESS_TOKEN is missing.');
  const res = await fetchWithTimeout(
    fetcher,
    MANAGEMENT_API_BASE + '/projects/' + projectRef + '/functions/daily-reminders',
    { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken.trim() } },
    'Unable to read deployed function metadata'
  );
  assertSafe(res.ok, 'Deployed function metadata read failed (HTTP ' + res.status + ').');
  const meta = await res.json().catch(() => null);
  assertSafe(meta && typeof meta === 'object', 'Unexpected function metadata response.');
  assertSafe(meta.status === 'ACTIVE', 'daily-reminders is not ACTIVE.');
  assertSafe(meta.verify_jwt === false, 'daily-reminders is not configured for cron authentication.');
  return { status: 'ACTIVE', verifyJwt: false, version: Number(meta.version ?? 0) };
}

/**
 * Safe post-deploy checks: require explicit pause configuration, an active
 * deployed function, and a rejecting auth gate. No database query, Vault read,
 * pg_net call, authorized cron request, or email send can occur in this probe.
 *
 * These checks establish a safe configuration, NOT a runtime "paused:true"
 * result. Such a claim requires an authorized execution and must be reported
 * separately rather than silently inferred.
 */
async function verifyDeployedDailyReminders({
  projectRef = ALLOWED_PROJECT_REF,
  accessToken,
  fetcher = globalThis.fetch,
  log = console.log
}) {
  await verifyPausedSecretDigest({ projectRef, accessToken, fetcher });
  log('PASS: DAILY_REMINDERS_ENABLED=false digest matches on target project.');

  const meta = await verifyFunctionMetadata({ projectRef, accessToken, fetcher });
  log('PASS: daily-reminders is ACTIVE with verify_jwt=false (version=' + meta.version + ').');

  const res = await fetchWithTimeout(
    fetcher,
    'https://' + projectRef + '.supabase.co/functions/v1/daily-reminders',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    'Unauthorized function gate request failed'
  );
  assertSafe(res.status === 401, 'daily-reminders did not reject unauthorized POST (HTTP ' + res.status + ').');
  log('PASS: Unauthorized POST rejected with HTTP 401.');
  log('SAFE: Read-only pause configuration verified. Runtime paused:true was NOT asserted; zero emails sent.');
  return { pauseConfigured: true, active: true, unauthorizedRejected: true, runtimePauseProven: false };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv.includes('--pre-deploy') ? 'pre-deploy'
    : argv.includes('--post-deploy') ? 'post-deploy' : null;
  const projectRef = (env.SUPABASE_PROJECT_REF || ALLOWED_PROJECT_REF).trim();
  const accessToken = env.SUPABASE_ACCESS_TOKEN || '';
  try {
    if (mode === 'pre-deploy') {
      await verifyPausedSecretDigest({ projectRef, accessToken });
      console.log('PASS: Pre-deploy pause configuration verified.');
    } else if (mode === 'post-deploy') {
      await verifyDeployedDailyReminders({ projectRef, accessToken });
    } else {
      throw new SafeCheckError('Choose --pre-deploy or --post-deploy.');
    }
  } catch (err) {
    console.error('FAIL: ' + (err instanceof SafeCheckError ? err.message : 'Unexpected verification failure.'));
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_PROJECT_REF,
  EXPECTED_FALSE_SHA256,
  SafeCheckError,
  verifyPausedSecretDigest,
  verifyFunctionMetadata,
  verifyDeployedDailyReminders,
  main
};

if (require.main === module) main();
