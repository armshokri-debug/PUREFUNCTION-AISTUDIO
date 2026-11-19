'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runConnectivity } = require('./check-connectivity.cjs');
const { EXPECTED_BUCKETS } = require('./backup-lib.cjs');

const ref = 'abcdefghijklmnopqrst';
const env = {
  ENABLE_SUPABASE_BACKUP: 'false',
  SUPABASE_PROJECT_REF: ref,
  SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_DB_URL: `postgresql://postgres.${ref}:sample%40password@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require`,
  SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
  BACKUP_GDRIVE_CLIENT_ID: 'mock-client',
  BACKUP_GDRIVE_CLIENT_SECRET: 'mock-client-secret',
  BACKUP_GDRIVE_REFRESH_TOKEN: 'mock-refresh'
};

function fixture({ scope = 'https://www.googleapis.com/auth/drive.file', dbStatus = 0, dbPrivileges = 't', dbDiagnostic = 'private SQL diagnostic', objectStatus = 200 } = {}) {
  const calls = [];
  const log = [];
  return {
    calls,
    log,
    env,
    logLine: line => log.push(line),
    run(command, args, options) {
      calls.push(['postgres', command]);
      assert.equal(command, 'psql');
      assert.equal(args[args.indexOf('-c') + 1], 'BEGIN READ ONLY');
      assert.equal(args.at(-1), 'ROLLBACK');
      assert.equal(options.env.PGPASSWORD, 'sample@password');
      assert.ok(args.includes("SET LOCAL statement_timeout = '12s'"));
      assert.ok(!args.join(' ').includes('sample@password'));
      return { status: dbStatus, stdout: 'connected\n' + dbPrivileges + '\n', stderr: dbDiagnostic };
    },
    async fetcher(url, options) {
      const parsed = new URL(url);
      calls.push([options.method, parsed.hostname, parsed.pathname]);
      assert.equal(options.redirect, 'error');
      switch (parsed.hostname) {
        case 'oauth2.googleapis.com':
          assert.equal(options.body.get('grant_type'), 'refresh_token');
          return Response.json({ access_token: 'mock-access', scope });
        case 'www.googleapis.com':
          assert.equal(parsed.searchParams.get('fields'), 'kind');
          return Response.json({ kind: 'drive#fileList' });
        case `${ref}.supabase.co`:
          if (parsed.pathname === '/storage/v1/bucket') return Response.json(EXPECTED_BUCKETS.map(id => ({ id })));
          if (parsed.pathname.startsWith('/storage/v1/object/list/')) {
            const { prefix } = JSON.parse(options.body);
            return Response.json(prefix ? [{ id: 'object-id', name: 'private-name' }] : [{ id: null, name: 'private-folder' }]);
          }
          assert.equal(options.method, 'HEAD');
          return new Response(null, { status: objectStatus });
        default:
          throw Error('Unexpected network destination');
      }
    }
  };
}

test('uses only the expected operations and prints no private data', async () => {
  const inputs = fixture();
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine }), true);
  assert.deepEqual(inputs.log.map(line => line.split(':')[0]), [
    'PASS Google Drive', 'PASS PostgreSQL', 'PASS Supabase Storage'
  ]);
  assert.ok(!inputs.log.join('\n').match(/mock-|private-|sample@/));
  assert.equal(inputs.calls.filter(([method]) => method === 'HEAD').length, EXPECTED_BUCKETS.length);
  assert.ok(inputs.calls.filter(([method]) => method === 'POST').every(
    ([, host, path]) => host === 'oauth2.googleapis.com' || path.startsWith('/storage/v1/object/list/')
  ));
  assert.ok(inputs.calls.every(([method]) => ['GET', 'POST', 'HEAD', 'postgres'].includes(method)));
});

test('blocks all network activity when backups are enabled', async () => {
  const inputs = fixture();
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine, env: { ...env, ENABLE_SUPABASE_BACKUP: 'true' } }), false);
  assert.equal(inputs.calls.length, 0);
});

test('records independent failures and never prints underlying errors', async () => {
  const inputs = fixture({ scope: 'https://www.googleapis.com/auth/drive', dbStatus: 2, objectStatus: 403 });
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine }), false);
  assert.deepEqual(inputs.log.map(line => line.split(':')[0]), [
    'FAIL Google Drive', 'FAIL PostgreSQL', 'FAIL Supabase Storage'
  ]);
  assert.ok(!inputs.log.join('\n').includes('private SQL diagnostic'));
  assert.ok(!inputs.calls.some(([, host]) => host === 'www.googleapis.com'));
});

test('rejects credentials targeting other database and Storage hosts', async () => {
  const inputs = fixture();
  const mismatched = { ...env, SUPABASE_DB_URL: 'postgresql://postgres:example@other.example/postgres?sslmode=require', SUPABASE_URL: 'https://other.example' };
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine, env: mismatched }), false);
  assert.equal(inputs.calls.length, 2);
});

test('classifies a PostgreSQL authentication failure without exposing its diagnostic', async () => {
  const inputs = fixture({ dbStatus: 2, dbDiagnostic: 'FATAL: password authentication failed for user private-name' });
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine }), false);
  assert.ok(inputs.log.includes('FAIL PostgreSQL: PostgreSQL authentication rejected the configured credentials'));
  assert.ok(!inputs.log.join('\n').includes('private-name'));
});

test('reports malformed database URLs without logging the URL', async () => {
  const inputs = fixture();
  const invalid = 'postgresql://someone:private%K1@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require';
  assert.equal(await runConnectivity({ ...inputs, log: inputs.logLine, env: { ...env, SUPABASE_DB_URL: invalid } }), false);
  assert.ok(inputs.log.includes('FAIL PostgreSQL: Database URI contains invalid percent-encoding'));
  assert.ok(!inputs.log.join('\n').includes('private%K1'));
  assert.ok(!inputs.calls.some(([method]) => method === 'postgres'));
});
