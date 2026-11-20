import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ALLOWED_PROJECT_REF,
  EXPECTED_FALSE_SHA256,
  verifyPausedSecretDigest,
  verifyFunctionMetadata,
  verifyDeployedDailyReminders
} = require('./verify-daily-reminders-paused.cjs');

const WORKFLOW_PATH = path.resolve(process.cwd(), '.github', 'workflows', 'deploy-daily-reminders.yml');

describe('daily-reminders safe deploy & paused verification script', () => {
  it('accepts DAILY_REMINDERS_ENABLED only when SHA-256 digest equals "false" and rejects any other value or project ref', async () => {
    const okFetch = async (url) => {
      expect(url).toBe(`https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/secrets`);
      return new Response(
        JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]),
        { status: 200 }
      );
    };
    await expect(
      verifyPausedSecretDigest({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock_secret_token_never_logged',
        fetcher: okFetch
      })
    ).resolves.toBe(true);

    // Wrong project ref rejected before network call
    let called = false;
    await expect(
      verifyPausedSecretDigest({
        projectRef: 'otherprojectref00000',
        accessToken: 'sbp_mock_secret_token_never_logged',
        fetcher: async () => {
          called = true;
          return new Response('[]', { status: 200 });
        }
      })
    ).rejects.toThrow(/approved Production project/i);
    expect(called).toBe(false);

    // Value "true" rejected
    const trueHash = crypto.createHash('sha256').update('true', 'utf8').digest('hex');
    await expect(
      verifyPausedSecretDigest({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock_secret_token_never_logged',
        fetcher: async () =>
          new Response(JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: trueHash }]), { status: 200 })
      })
    ).rejects.toThrow(/not set to exact value "false"/i);
  });

  it('verifies deployed function metadata requires ACTIVE status and verify_jwt=false', async () => {
    await expect(
      verifyFunctionMetadata({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: async () =>
          new Response(JSON.stringify({ slug: 'daily-reminders', status: 'ACTIVE', verify_jwt: false, version: 5 }), {
            status: 200
          })
      })
    ).resolves.toEqual({ status: 'ACTIVE', verifyJwt: false, version: 5 });

    await expect(
      verifyFunctionMetadata({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: async () =>
          new Response(JSON.stringify({ slug: 'daily-reminders', status: 'ACTIVE', verify_jwt: true, version: 5 }), {
            status: 200
          })
      })
    ).rejects.toThrow(/verify_jwt to be false/i);
  });

  it('verifies paused=true via in-DB pg_net without ever extracting Vault secrets or logging tokens', async () => {
    const secretToken = 'sbp_top_secret_token_xyz987';
    const logs = [];
    let pollCalls = 0;

    const fetcher = async (url, init = {}) => {
      if (url === `https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/secrets`) {
        return new Response(
          JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]),
          { status: 200 }
        );
      }
      if (url === `https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/functions/daily-reminders`) {
        return new Response(
          JSON.stringify({ slug: 'daily-reminders', status: 'ACTIVE', verify_jwt: false, version: 4 }),
          { status: 200 }
        );
      }
      if (url === `https://${ALLOWED_PROJECT_REF}.supabase.co/functions/v1/daily-reminders`) {
        // Only the unauthorized check calls the function directly from Node.js
        expect(init.headers?.['x-cron-secret']).toBeUndefined();
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (url === `https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/database/query`) {
        const body = JSON.parse(String(init.body));
        // Must NOT send read_only property (which caused HTTP 400 under supabase_read_only_user)
        expect(Object.keys(body)).toEqual(['query']);
        if (body.query.includes('net.http_post')) {
          expect(body.query).toContain('vault.decrypted_secrets');
          // Returns ONLY integer request_id — never the Vault secret
          return new Response(JSON.stringify([{ request_id: 12345 }]), { status: 201 });
        }
        if (body.query.includes('net._http_response')) {
          expect(body.query).toContain('WHERE id = 12345');
          pollCalls++;
          if (pollCalls === 1) {
            return new Response(JSON.stringify([]), { status: 201 });
          }
          return new Response(
            JSON.stringify([
              {
                status_code: 200,
                timed_out: false,
                content: JSON.stringify({
                  today: '2026-11-20',
                  timezone: 'Asia/Tehran',
                  paused: true,
                  results: []
                })
              }
            ]),
            { status: 201 }
          );
        }
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyDeployedDailyReminders({
      projectRef: ALLOWED_PROJECT_REF,
      accessToken: secretToken,
      fetcher,
      sleep: async () => {},
      maxPollAttempts: 3,
      pollIntervalMs: 1,
      log: (line) => logs.push(line)
    });

    expect(result).toEqual({ paused: true, today: '2026-11-20', timezone: 'Asia/Tehran', resultCount: 0 });
    expect(pollCalls).toBe(2);
    const allLogs = logs.join('\n');
    expect(allLogs).toContain('HTTP 401');
    expect(allLogs).toContain('paused=true');
    expect(allLogs).not.toContain(secretToken);
    expect(allLogs).not.toContain(EXPECTED_FALSE_SHA256);
  });

  it('classifies HTTP 403 token permission errors and HTTP 400 SQL errors cleanly without leaking raw payload text', async () => {
    const makeFetcher = (dbStatus, dbText) => async (url) => {
      if (url.endsWith('/secrets')) {
        return new Response(JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]), {
          status: 200
        });
      }
      if (url.endsWith('/functions/daily-reminders')) {
        return new Response(JSON.stringify({ status: 'ACTIVE', verify_jwt: false, version: 4 }), { status: 200 });
      }
      if (url.includes('.supabase.co/functions/v1/daily-reminders')) {
        return new Response('{}', { status: 401 });
      }
      return new Response(dbText, { status: dbStatus });
    };

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: makeFetcher(403, 'secret-raw-403-detail'),
        sleep: async () => {},
        log: () => {}
      })
    ).rejects.toThrow(/lacks database query permission \(HTTP 403\)/i);

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: makeFetcher(400, 'ERROR: 42501 permission denied for secret_internal_table'),
        sleep: async () => {},
        log: () => {}
      })
    ).rejects.toThrow(/SQLSTATE 42501/i);
  });

  it('fails cleanly if unauthorized POST is not rejected with 401 or if in-DB response is not paused=true', async () => {
    const baseFetcher = (unauthStatus, authBody) => async (url, init = {}) => {
      if (url.endsWith('/secrets')) {
        return new Response(JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]), {
          status: 200
        });
      }
      if (url.endsWith('/functions/daily-reminders')) {
        return new Response(JSON.stringify({ status: 'ACTIVE', verify_jwt: false, version: 4 }), { status: 200 });
      }
      if (url.includes('.supabase.co/functions/v1/daily-reminders')) {
        return new Response('{}', { status: unauthStatus });
      }
      if (url.endsWith('/database/query')) {
        const body = JSON.parse(String(init.body));
        if (body.query.includes('net.http_post')) {
          return new Response(JSON.stringify([{ request_id: 77 }]), { status: 201 });
        }
        return new Response(
          JSON.stringify([{ status_code: 200, timed_out: false, content: JSON.stringify(authBody) }]),
          { status: 201 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: baseFetcher(200, { paused: true, results: [] }),
        sleep: async () => {},
        log: () => {}
      })
    ).rejects.toThrow(/Expected HTTP 401/i);

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: baseFetcher(401, { today: '2026-11-20', timezone: 'Asia/Tehran', results: [] }),
        sleep: async () => {},
        log: () => {}
      })
    ).rejects.toThrow(/did NOT return paused: true/i);
  });
});

describe('deploy-daily-reminders.yml workflow safety invariants', () => {
  it('stays manual-only, locked to PUREFUNCTION-AISTUDIO and rugwzvztweiffprkxfdc, deploys only daily-reminders with --no-verify-jwt, and avoids SUPABASE_DB_URL', () => {
    const yaml = fs.readFileSync(WORKFLOW_PATH, 'utf8');

    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(yaml).toContain('armshokri-debug/PUREFUNCTION-AISTUDIO');
    expect(yaml).toContain('rugwzvztweiffprkxfdc');
    expect(yaml).toContain('reviewed_sha');
    expect(yaml).toContain('DEPLOY_DAILY_REMINDERS');
    expect(yaml).toContain('supabase functions deploy daily-reminders');
    expect(yaml).toContain('--no-verify-jwt');
    expect(yaml).toContain('--yes');
    expect(yaml).toContain('verify-daily-reminders-paused.cjs --pre-deploy');
    expect(yaml).toContain('verify-daily-reminders-paused.cjs --post-deploy');

    const activeYaml = yaml
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    // Must not deploy any other Edge Function or touch DB URL / EMAIL_FROM / SMTP
    expect(activeYaml).not.toMatch(/functions deploy\s+(send-invite|sign-up|reset-password|invite-trainer|food-parse)/);
    expect(activeYaml).not.toMatch(/SUPABASE_DB_URL/);
    expect(activeYaml).not.toMatch(/EMAIL_FROM/);
    expect(activeYaml).not.toMatch(/SMTP/i);
  });
});
