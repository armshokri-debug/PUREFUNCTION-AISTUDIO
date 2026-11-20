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

  it('verifies HTTP 401 unauthorized + HTTP 200 paused=true and never prints tokens or Vault secrets', async () => {
    const secretToken = 'sbp_top_secret_token_xyz987';
    const vaultCronSecret = 'vault_cron_secret_abcdef0123456789';
    const logs = [];

    const fetcher = async (url, init = {}) => {
      if (url === `https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/secrets`) {
        return new Response(
          JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]),
          { status: 200 }
        );
      }
      if (url === `https://api.supabase.com/v1/projects/${ALLOWED_PROJECT_REF}/database/query`) {
        const body = JSON.parse(String(init.body));
        expect(body.read_only).toBe(true);
        expect(body.query).toContain("name = 'cron_secret'");
        return new Response(JSON.stringify([{ decrypted_secret: vaultCronSecret }]), { status: 201 });
      }
      if (url === `https://${ALLOWED_PROJECT_REF}.supabase.co/functions/v1/daily-reminders`) {
        const headers = init.headers || {};
        if (!headers['x-cron-secret']) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        }
        expect(headers['x-cron-secret']).toBe(vaultCronSecret);
        return new Response(
          JSON.stringify({ today: '2026-11-20', timezone: 'Asia/Tehran', paused: true, results: [] }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyDeployedDailyReminders({
      projectRef: ALLOWED_PROJECT_REF,
      accessToken: secretToken,
      fetcher,
      log: (line) => logs.push(line)
    });

    expect(result).toEqual({ paused: true, today: '2026-11-20', timezone: 'Asia/Tehran', resultCount: 0 });
    const allLogs = logs.join('\n');
    expect(allLogs).toContain('HTTP 401');
    expect(allLogs).toContain('paused=true');
    expect(allLogs).not.toContain(secretToken);
    expect(allLogs).not.toContain(vaultCronSecret);
    expect(allLogs).not.toContain(EXPECTED_FALSE_SHA256);
  });

  it('fails cleanly if unauthorized POST is not rejected with 401 or if response is not paused=true', async () => {
    const baseFetcher = (unauthStatus, authBody) => async (url, init = {}) => {
      if (url.endsWith('/secrets')) {
        return new Response(JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: EXPECTED_FALSE_SHA256 }]), {
          status: 200
        });
      }
      if (url.endsWith('/database/query')) {
        return new Response(JSON.stringify([{ decrypted_secret: 'vault_cron_secret_abcdef0123456789' }]), {
          status: 201
        });
      }
      if (!init.headers?.['x-cron-secret']) {
        return new Response('{}', { status: unauthStatus });
      }
      return new Response(JSON.stringify(authBody), { status: 200 });
    };

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: baseFetcher(200, { paused: true, results: [] }),
        log: () => {}
      })
    ).rejects.toThrow(/Expected HTTP 401/i);

    await expect(
      verifyDeployedDailyReminders({
        projectRef: ALLOWED_PROJECT_REF,
        accessToken: 'sbp_mock',
        fetcher: baseFetcher(401, { today: '2026-11-20', timezone: 'Asia/Tehran', results: [] }),
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
