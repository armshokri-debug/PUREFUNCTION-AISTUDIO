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

const workflow = fs.readFileSync(
  path.resolve(process.cwd(), '.github/workflows/deploy-daily-reminders.yml'), 'utf8'
);

const management = 'https://api.supabase.com/v1/projects/' + ALLOWED_PROJECT_REF;
const fnUrl = 'https://' + ALLOWED_PROJECT_REF + '.supabase.co/functions/v1/daily-reminders';
const mockToken = 'sbp_mock_token_never_logged';

function responder({ digest = EXPECTED_FALSE_SHA256, active = true, verifyJwt = false, unauthorizedStatus = 401 } = {}) {
  const called = [];
  return {
    called,
    fetcher: async (url, init = {}) => {
      called.push({ url, method: init.method ?? 'GET' });
      if (url === management + '/secrets') {
        return new Response(JSON.stringify([{ name: 'DAILY_REMINDERS_ENABLED', value: digest }]), { status: 200 });
      }
      if (url === management + '/functions/daily-reminders') {
        return new Response(JSON.stringify({ status: active ? 'ACTIVE' : 'INACTIVE', verify_jwt: verifyJwt, version: 10 }), { status: 200 });
      }
      if (url === fnUrl) {
        expect(init.headers?.['x-cron-secret']).toBeUndefined();
        expect(init.method).toBe('POST');
        return new Response('{}', { status: unauthorizedStatus });
      }
      throw new Error('Unexpected network endpoint');
    }
  };
}

describe('daily-reminders safe deploy verification', () => {
  it('checks SHA-256 false digest; denies another project and any non-false value', async () => {
    const a = responder();
    await expect(verifyPausedSecretDigest({
      projectRef: ALLOWED_PROJECT_REF, accessToken: mockToken, fetcher: a.fetcher
    })).resolves.toBe(true);
    const b = responder();
    await expect(verifyPausedSecretDigest({
      projectRef: 'otherprojectref00000', accessToken: mockToken, fetcher: b.fetcher
    })).rejects.toThrow(/approved Production project/);
    expect(b.called).toHaveLength(0);
    const wrong = responder({ digest: crypto.createHash('sha256').update('true').digest('hex') });
    await expect(verifyPausedSecretDigest({
      projectRef: ALLOWED_PROJECT_REF, accessToken: mockToken, fetcher: wrong.fetcher
    })).rejects.toThrow(/not explicitly paused/);
  });

  it('requires ACTIVE status and verify_jwt=false on the deployed function', async () => {
    const ok = responder();
    await expect(verifyFunctionMetadata({
      projectRef: ALLOWED_PROJECT_REF, accessToken: mockToken, fetcher: ok.fetcher
    })).resolves.toEqual({ status: 'ACTIVE', verifyJwt: false, version: 10 });
    const inactive = responder({ active: false });
    await expect(verifyFunctionMetadata({
      projectRef: ALLOWED_PROJECT_REF, accessToken: mockToken, fetcher: inactive.fetcher
    })).rejects.toThrow(/not ACTIVE/);
    const jwt = responder({ verifyJwt: true });
    await expect(verifyFunctionMetadata({
      projectRef: ALLOWED_PROJECT_REF, accessToken: mockToken, fetcher: jwt.fetcher
    })).rejects.toThrow(/cron authentication/);
  });

  it('checks pause configuration, metadata, and 401 without Vault access or any authorized call', async () => {
    const a = responder();
    const logs = [];
    const result = await verifyDeployedDailyReminders({
      projectRef: ALLOWED_PROJECT_REF,
      accessToken: mockToken,
      fetcher: a.fetcher,
      log: (line) => logs.push(line)
    });
    expect(result).toEqual({ pauseConfigured: true, active: true, unauthorizedRejected: true, runtimePauseProven: false });
    expect(a.called.map(x => x.url)).toEqual([management + '/secrets', management + '/functions/daily-reminders', fnUrl]);
    expect(a.called.every(x => !x.url.includes('/database/query'))).toBe(true);
    const messages = logs.join('\n');
    expect(messages).toContain('HTTP 401');
    expect(messages).toContain('NOT asserted');
    expect(messages).not.toContain(mockToken);
    expect(messages).not.toContain(EXPECTED_FALSE_SHA256);
  });

  it('fails safely if auth gate is not enforced, with no email-triggering calls', async () => {
    const a = responder({ unauthorizedStatus: 200 });
    await expect(verifyDeployedDailyReminders({
      projectRef: ALLOWED_PROJECT_REF,
      accessToken: mockToken,
      fetcher: a.fetcher,
      log: () => {}
    })).rejects.toThrow(/did not reject unauthorized POST/);
    expect(a.called.map(x => x.url)).toEqual([management + '/secrets', management + '/functions/daily-reminders', fnUrl]);
  });

  it('keeps the deploy workflow manual-only, SHA gated, and without unrelated deployments', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(workflow).toContain('armshokri-debug/PUREFUNCTION-AISTUDIO');
    expect(workflow).toContain(ALLOWED_PROJECT_REF);
    expect(workflow).toContain('reviewed_sha');
    expect(workflow).toContain('DEPLOY_DAILY_REMINDERS');
    expect(workflow).toContain('supabase functions deploy daily-reminders');
    expect(workflow).toContain('--no-verify-jwt');
    expect(workflow).toContain('--yes');
    expect(workflow).toContain('verify-daily-reminders-paused.cjs --pre-deploy');
    expect(workflow).toContain('verify-daily-reminders-paused.cjs --post-deploy');
    const active = workflow.split('\n').filter(x => !x.trim().startsWith('#')).join('\n');
    expect(active).not.toMatch(/functions deploy\s+(send-invite|sign-up|reset-password|invite-trainer|food-parse)/);
    expect(active).not.toMatch(/SUPABASE_DB_URL|EMAIL_FROM|SMTP/i);
  });
});
