import { describe, expect, it, vi } from 'vitest';
import { resolveAppUrl } from '../../../supabase/functions/_shared/app-url';
import {
  CooldownTracker,
  DEFAULT_FROM,
  layout,
  resolveFromAddress,
  sendEmailWith,
  type SendEmailOptions,
  type SendResult
} from '../../../supabase/functions/_shared/email-core';
type SendEmailFn = (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
import { handleSendInvite, INVITE_COOLDOWN_MS } from '../../../supabase/functions/send-invite/handler';
import { handleSignUp } from '../../../supabase/functions/sign-up/handler';
import { handleResetPassword, RESET_COOLDOWN_MS } from '../../../supabase/functions/reset-password/handler';
import {
  DEFAULT_COACH_TIMEZONE,
  handleDailyReminders,
  resolveTimezone,
  todayIn
} from '../../../supabase/functions/daily-reminders/handler';

const APP_URL = resolveAppUrl();

function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

describe('Shared email-core (_shared/email-core.ts)', () => {
  it('keeps safe test sender fallback until EMAIL_FROM is explicitly configured', () => {
    expect(resolveFromAddress()).toBe(DEFAULT_FROM);
    expect(resolveFromAddress('')).toBe(DEFAULT_FROM);
    expect(resolveFromAddress('   ')).toBe(DEFAULT_FROM);
    expect(resolveFromAddress('  Pure Function Fitness <notifications@notify.pure-function.com>  ')).toBe(
      'Pure Function Fitness <notifications@notify.pure-function.com>'
    );
  });

  it('escapes HTML in layout and drops non-HTTP(S) button URLs', () => {
    const safeHtml = layout('Hi <script>alert(1)</script>', ['Line & "quote"'], {
      text: 'Open <b>App</b>',
      url: `${APP_URL}?join=client%40example.invalid`
    });
    expect(safeHtml).not.toContain('<script>');
    expect(safeHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(safeHtml).toContain('href="https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?join=client%40example.invalid"');

    const unsafeBtn = layout('Hello', ['Test'], {
      text: 'Bad',
      url: 'javascript:alert(1)'
    });
    expect(unsafeBtn).not.toContain('javascript:');
    expect(unsafeBtn).not.toContain('<a ');
  });

  it('sends through Resend with Idempotency-Key and handles 403, 429, 502, missing key, and network failures', async () => {
    // Missing key -> 503 without calling fetch
    const neverFetch = vi.fn();
    const missing = await sendEmailWith({ apiKey: '  ', fetchImpl: neverFetch as typeof fetch }, 'a@example.invalid', 'Sub', '<p>Hi</p>');
    expect(missing).toEqual({ ok: false, status: 503, error: 'Email is not set up yet (RESEND_API_KEY missing).' });
    expect(neverFetch).not.toHaveBeenCalled();

    // Success + Idempotency-Key forwarding
    const okFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('daily-reminder:2026-11-20:c1');
      const payload = JSON.parse(String(init?.body));
      expect(payload.from).toBe('Pure Function Fitness <notifications@notify.pure-function.com>');
      expect(payload.to).toEqual(['client@example.invalid']);
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    });
    const sent = await sendEmailWith(
      {
        apiKey: 'mock-key',
        from: 'Pure Function Fitness <notifications@notify.pure-function.com>',
        fetchImpl: okFetch as typeof fetch
      },
      ' CLIENT@example.invalid ',
      'Test',
      '<p>Hello</p>',
      { idempotencyKey: 'daily-reminder:2026-11-20:c1' }
    );
    expect(sent).toEqual({ ok: true });

    // Resend 403 domain verification error
    const err403 = await sendEmailWith(
      {
        apiKey: 'mock-key',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ message: 'You can only send testing emails to your own email address.' }), {
            status: 403
          })) as typeof fetch
      },
      'client@example.invalid',
      'Test',
      '<p>Hello</p>'
    );
    expect(err403).toEqual({
      ok: false,
      status: 403,
      error: 'Email works only to your own address until a domain is verified in Resend.'
    });

    // Resend 429 rate limit
    const err429 = await sendEmailWith(
      {
        apiKey: 'mock-key',
        fetchImpl: (async () => new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429 })) as typeof fetch
      },
      'client@example.invalid',
      'Test',
      '<p>Hello</p>'
    );
    expect(err429.ok).toBe(false);
    if (!err429.ok) expect(err429.status).toBe(429);

    // Network/timeout error caught safely without throwing
    const netErr = await sendEmailWith(
      {
        apiKey: 'mock-key',
        fetchImpl: (async () => {
          throw new Error('network timeout');
        }) as typeof fetch
      },
      'client@example.invalid',
      'Test',
      '<p>Hello</p>'
    );
    expect(netErr).toEqual({
      ok: false,
      status: 502,
      error: 'Email service could not be reached. Try again.'
    });
  });
});

describe('Route 1: send-invite (client invitation)', () => {
  const baseDeps = () => {
    const sendEmail = vi.fn<SendEmailFn>(async () => ({ ok: true }));
    return {
      appUrl: APP_URL,
      sendEmail,
      cooldown: new CooldownTracker(),
      getUserByToken: vi.fn(async (t: string) => (t === 'coach-jwt' ? { id: 'coach-1' } : null)),
      getCoachProfile: vi.fn(async (uid: string) =>
        uid === 'coach-1' ? { role: 'coach', display_name: 'Coach Armin' } : { role: 'client', display_name: 'Client' }
      ),
      getOwnedClient: vi.fn(async (_t: string, id: string) =>
        id === 'client-1'
          ? { id: 'client-1', email: 'athlete@example.invalid', coach_id: 'coach-1', data: { name: 'Sara Test' } }
          : null
      ),
      isClientAccountConfirmed: vi.fn(async () => false),
      getExistingAccount: vi.fn(async (_email: string) => ({
        data: null as { email: string; confirmed: boolean; hasPassword: boolean; clientId: string | null } | null, error: null
      })),
      generateInviteLink: vi.fn(async (_email: string, _name: string) => ({
        hashedToken: 'invite-hash', userId: 'fresh-invite-uid', error: null
      })),
      generateMagicLink: vi.fn(async (_email: string) => ({ hashedToken: 'magic-hash', error: null })),
      deleteNewUser: vi.fn(async (_id: string) => {})
    };
  };

  it('enforces method, auth, coach role, and owning-coach RLS isolation', async () => {
    const deps = baseDeps();

    const wrongMethod = await handleSendInvite(new Request('https://fn.local/send-invite', { method: 'GET' }), deps);
    expect(wrongMethod.status).toBe(405);

    const noAuth = await handleSendInvite(postJson('https://fn.local/send-invite', { clientId: 'client-1' }), deps);
    expect(noAuth.status).toBe(401);

    deps.getUserByToken.mockResolvedValueOnce({ id: 'client-user' });
    const notCoach = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer client-jwt' }),
      deps
    );
    expect(notCoach.status).toBe(403);

    deps.getOwnedClient.mockResolvedValueOnce({
      id: 'client-2',
      email: 'other@example.invalid',
      coach_id: 'coach-other',
      data: { name: 'Other' }
    });
    const wrongOwner = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-2' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(wrongOwner.status).toBe(403);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('builds the active app invite link, rejects already-confirmed clients, and enforces rapid-duplicate cooldown', async () => {
    let clock = 1_000_000;
    const deps = { ...baseDeps(), now: () => clock };

    // Already confirmed client -> 409
    deps.isClientAccountConfirmed.mockResolvedValueOnce(true);
    const confirmedRes = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(confirmedRes.status).toBe(409);
    expect(deps.sendEmail).not.toHaveBeenCalled();

    // Provider error -> does NOT start cooldown and returns provider error
    deps.sendEmail.mockResolvedValueOnce({ ok: false, status: 403, error: 'Resend domain required' });
    const failedRes = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(failedRes.status).toBe(403);

    // Retry immediately after failure succeeds and uses active PUREFUNCTION-AISTUDIO link
    const okRes = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(okRes.status).toBe(200);
    const [to, subject, html] = deps.sendEmail.mock.calls[1];
    expect(to).toBe('athlete@example.invalid');
    expect(subject).toContain('Coach Armin');
    expect(html).toContain('https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?invite=invite-hash');
    expect(html).not.toContain('verify=');
    expect(deps.deleteNewUser).toHaveBeenCalledWith('fresh-invite-uid');

    // Duplicate click within cooldown -> 429
    clock += 10_000;
    const dupRes = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(dupRes.status).toBe(429);

    // After cooldown expires -> allowed again
    clock += INVITE_COOLDOWN_MS;
    const retryAfterCooldown = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(retryAfterCooldown.status).toBe(200);
  });
  it('resends to an unconfirmed account using magiclink and never creates or deletes another user', async () => {
    const deps = baseDeps();
    deps.getExistingAccount.mockResolvedValueOnce({
      data: { email: 'athlete@example.invalid', confirmed: false, hasPassword: false, clientId: 'client-1' }, error: null
    });
    const response = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(response.status).toBe(200);
    expect(deps.generateMagicLink).toHaveBeenCalledWith('athlete@example.invalid');
    expect(deps.generateInviteLink).not.toHaveBeenCalled();
    expect(deps.deleteNewUser).not.toHaveBeenCalled();
    expect(deps.sendEmail.mock.calls[0][2]).toContain('?invite=magic-hash&amp;inviteType=magiclink');
  });

  it('blocks an existing confirmed account without sending another invitation or changing credentials', async () => {
    const deps = baseDeps();
    deps.getExistingAccount.mockResolvedValueOnce({
      data: { email: 'athlete@example.invalid', confirmed: true, hasPassword: true, clientId: 'client-1' }, error: null
    });
    const response = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(response.status).toBe(409);
    expect(deps.generateInviteLink).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('never invites a Gmail alias already mapped to another client record', async () => {
    const deps = baseDeps();
    deps.getOwnedClient.mockResolvedValueOnce({
      id: 'client-1', email: 'person@gmail.com', coach_id: 'coach-1', data: { name: 'Person' }
    });
    deps.getExistingAccount.mockResolvedValueOnce({ data: null, error: null });
    deps.getExistingAccount.mockResolvedValueOnce({
      data: { email: 'person@googlemail.com', confirmed: false, hasPassword: false, clientId: 'another-client' },
      error: null
    });
    const res = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(res.status).toBe(409);
    expect(deps.generateMagicLink).not.toHaveBeenCalled();
    expect(deps.generateInviteLink).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('checks Gmail alias before creating a second account; fails closed if lookup fails', async () => {
    const deps = baseDeps();
    deps.getOwnedClient.mockResolvedValue({
      id: 'client-1', email: 'person@gmail.com', coach_id: 'coach-1', data: { name: 'Person' }
    });
    deps.getExistingAccount.mockResolvedValueOnce({ data: null, error: null });
    deps.getExistingAccount.mockResolvedValueOnce({ data: null, error: { message: 'db down' } as never });
    const response = await handleSendInvite(
      postJson('https://fn.local/send-invite', { clientId: 'client-1' }, { Authorization: 'Bearer coach-jwt' }),
      deps
    );
    expect(response.status).toBe(503);
    expect(deps.getExistingAccount.mock.calls.map(([email]) => email))
      .toEqual(['person@gmail.com', 'person@googlemail.com']);
    expect(deps.generateInviteLink).not.toHaveBeenCalled();
  });
});

describe('Route 2: sign-up (registration & email verification)', () => {
  const baseDeps = () => ({
    appUrl: APP_URL,
    reserveSignupVerification: vi.fn<(email: string) => Promise<{ data: unknown; error: unknown }>>(async () => ({
      data: true,
      error: null
    })),
    getSignupRole: vi.fn<(email: string) => Promise<{ data: unknown; error: unknown }>>(async (email: string) => ({
      data: email === 'invited@example.invalid' ? 'client' : null,
      error: null
    })),
    isExistingSignupAccount: vi.fn<(email: string) => Promise<{ data: unknown; error: unknown }>>(async () => ({
      data: false,
      error: null
    })),
    generateMagicLink: vi.fn(async () => ({ hashedToken: 'magic-tok-1', error: null })),
    generateSignupLink: vi.fn(async () => ({ hashedToken: 'signup-tok-1', userId: 'usr-1', error: null })),
    deleteUser: vi.fn(async () => {}),
    sendEmail: vi.fn<SendEmailFn>(async () => ({ ok: true })),
    logWarn: vi.fn()
  });

  it('validates input and prevents account enumeration for unknown emails', async () => {
    const deps = baseDeps();

    const badPass = await handleSignUp(
      postJson('https://fn.local/sign-up', { email: 'invited@example.invalid', password: 'short' }),
      deps
    );
    expect(badPass.status).toBe(400);

    const unknown = await handleSignUp(
      postJson('https://fn.local/sign-up', { email: 'stranger@example.invalid', password: 'Password123!' }),
      deps
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true, verificationRequired: true });
    expect(deps.generateSignupLink).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('sends signup verification link to active app URL and rolls back user if Resend fails', async () => {
    const deps = baseDeps();

    const ok = await handleSignUp(
      postJson('https://fn.local/sign-up', {
        email: 'invited@example.invalid',
        password: 'Password123!',
        name: 'Sara'
      }),
      deps
    );
    expect(ok.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , html] = deps.sendEmail.mock.calls[0];
    expect(to).toBe('invited@example.invalid');
    expect(html).toContain('https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?verify=signup-tok-1');
    expect(deps.deleteUser).not.toHaveBeenCalled();

    // Simulate Resend delivery failure -> must delete unconfirmed user & log PII-free warning
    deps.sendEmail.mockResolvedValueOnce({ ok: false, status: 502, error: 'Email service error: down' });
    const fail = await handleSignUp(
      postJson('https://fn.local/sign-up', {
        email: 'invited@example.invalid',
        password: 'Password123!',
        name: 'Sara'
      }),
      deps
    );
    expect(fail.status).toBe(200); // anti-enumeration
    expect(deps.deleteUser).toHaveBeenCalledWith('usr-1');
    expect(deps.logWarn).toHaveBeenCalledTimes(1);
    const logged = deps.logWarn.mock.calls[0][0];
    expect(logged).toContain('signup_verification_failed');
    expect(logged).not.toContain('invited@example.invalid');
    expect(logged).not.toContain('signup-tok-1');
  });

  it('routes existing accounts to resend and enforces fail-closed rate limit via reserve_signup_verification', async () => {
    const deps = baseDeps();
    deps.isExistingSignupAccount.mockResolvedValueOnce({ data: true, error: null });

    const existingRes = await handleSignUp(
      postJson('https://fn.local/sign-up', { email: 'invited@example.invalid', password: 'Password123!' }),
      deps
    );
    expect(existingRes.status).toBe(200);
    expect(deps.reserveSignupVerification).toHaveBeenCalledWith('invited@example.invalid');
    expect(deps.generateSignupLink).not.toHaveBeenCalled();
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail.mock.calls[0][2]).toContain(
      'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?verify=magic-tok-1&amp;verifyType=magiclink'
    );

    // Rate-limited (permitted = false) -> must not generate or send link
    deps.reserveSignupVerification.mockResolvedValueOnce({ data: false, error: null });
    const limitedRes = await handleSignUp(
      postJson('https://fn.local/sign-up', { action: 'resend', email: 'invited@example.invalid' }),
      deps
    );
    expect(limitedRes.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);

    // RPC error -> fail closed
    deps.reserveSignupVerification.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });
    const rpcErrRes = await handleSignUp(
      postJson('https://fn.local/sign-up', { action: 'resend', email: 'invited@example.invalid' }),
      deps
    );
    expect(rpcErrRes.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('Route 3: reset-password (password recovery)', () => {
  it.each([
    ['https://purefunction-live.pages.dev/', 'https://armshokri-debug.github.io', 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/'],
    ['https://purefunction-live.pages.dev/', 'https://purefunction-live.pages.dev', 'https://purefunction-live.pages.dev/'],
    ['https://purefunction-live.pages.dev/', 'https://attacker.example', 'https://purefunction-live.pages.dev/'],
    ['https://purefunction-live.pages.dev/', 'https://armshokri-debug.github.io.attacker.example', 'https://purefunction-live.pages.dev/'],
    ['https://purefunction-live.pages.dev/', '', 'https://purefunction-live.pages.dev/'],
    ['https://purefunction-qa.pages.dev/', 'https://armshokri-debug.github.io', 'https://purefunction-qa.pages.dev/'],
    ['https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/', 'https://purefunction-live.pages.dev', 'https://purefunction-live.pages.dev/']
  ])('uses only trusted recovery destinations (%s, %s)', async (appUrl, origin, expected) => {
    const sendEmail = vi.fn<SendEmailFn>(async () => ({ ok: true }));
    const response = await handleResetPassword(
      postJson('https://fn.local/reset-password', { email: 'member@example.invalid', redirectTo: 'https://attacker.example' }, origin ? { Origin: origin } : {}),
      { appUrl, generateRecoveryLink: async () => ({ hashedToken: 'synthetic-recovery-token' }), sendEmail, logInfo: vi.fn() }
    );
    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][2]).toContain(expected + '?reset=synthetic-recovery-token');
    expect(sendEmail.mock.calls[0][2]).not.toContain('attacker.example');
  });

  it('sends recovery link to active app URL, hides existence, logs no PII, and applies duplicate cooldown', async () => {
    let clock = 2_000_000;
    const sendEmail = vi.fn<SendEmailFn>(async () => ({ ok: true }));
    const generateRecoveryLink = vi.fn(async (email: string) =>
      email === 'member@example.invalid' ? { hashedToken: 'rec-tok-99', error: null } : { error: { message: 'not found' } }
    );
    const logWarn = vi.fn();
    const logInfo = vi.fn();
    const deps = {
      appUrl: APP_URL,
      generateRecoveryLink,
      sendEmail,
      cooldown: new CooldownTracker(),
      now: () => clock,
      logWarn,
      logInfo
    };

    // Invalid email -> 400
    const bad = await handleResetPassword(postJson('https://fn.local/reset-password', { email: 'not-an-email' }), deps);
    expect(bad.status).toBe(400);

    // Unknown account -> generic 200, PII-free warning, no mail sent
    const unknown = await handleResetPassword(
      postJson('https://fn.local/reset-password', { email: 'nobody@example.invalid' }),
      deps
    );
    expect(unknown.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logWarn.mock.calls[0][0]).toContain('link_generation_failed');
    expect(logWarn.mock.calls[0][0]).not.toContain('nobody@example.invalid');

    // Valid account -> sends recovery link with ?reset= token
    const ok = await handleResetPassword(
      postJson('https://fn.local/reset-password', { email: 'MEMBER@example.invalid' }),
      deps
    );
    expect(ok.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][2]).toContain(
      'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?reset=rec-tok-99'
    );

    // Immediate duplicate request within cooldown -> 200 without sending second email
    clock += 15_000;
    const dup = await handleResetPassword(
      postJson('https://fn.local/reset-password', { email: 'member@example.invalid' }),
      deps
    );
    expect(dup.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls.some(([l]) => String(l).includes('password_recovery_cooldown'))).toBe(true);

    // After cooldown expires, provider failure logs classified reason without PII
    clock += RESET_COOLDOWN_MS;
    sendEmail.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'Email works only to your own address until a domain is verified in Resend.'
    });
    const failed = await handleResetPassword(
      postJson('https://fn.local/reset-password', { email: 'member@example.invalid' }),
      deps
    );
    expect(failed.status).toBe(200);
    const lastWarn = logWarn.mock.calls.at(-1)?.[0] ?? '';
    expect(lastWarn).toContain('test_sender_restricted');
    expect(lastWarn).not.toContain('member@example.invalid');
    expect(lastWarn).not.toContain('rec-tok-99');
  });
});

describe('Route 4: daily-reminders (cron auth, timezone, dedup, pause gate)', () => {
  it('computes dates correctly across COACH_TIMEZONE boundaries and falls back safely on invalid TZ', () => {
    // 2026-11-20T04:30:00Z = 08:00 Asia/Tehran (Nov 20), but 23:30 Nov 19 in America/New_York!
    const morningTehranUtc = new Date('2026-11-20T04:30:00Z');
    expect(todayIn('Asia/Tehran', morningTehranUtc)).toBe('2026-11-20');
    expect(todayIn('America/New_York', morningTehranUtc)).toBe('2026-11-19');

    const warn = vi.fn();
    expect(resolveTimezone('  Asia/Tehran  ', warn)).toBe('Asia/Tehran');
    expect(resolveTimezone('Mars/Olympus', warn)).toBe(DEFAULT_COACH_TIMEZONE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthorized requests and respects DAILY_REMINDERS_ENABLED=false while allowing ?dry=1 previews', async () => {
    const sendEmail = vi.fn(async () => ({ ok: true as const }));
    const deps = {
      appUrl: APP_URL,
      coachTimezone: 'Asia/Tehran',
      remindersEnabled: 'false',
      now: () => new Date('2026-11-20T11:00:00Z'),
      verifyCronSecret: vi.fn(async (s: string) => ({ ok: s === 'valid-cron-secret', error: null })),
      getWorkoutsForDate: vi.fn(async () => ({
        data: [{ client_id: 'c1', data: { title: 'Lower A', status: 'planned', blocks: [{ name: 'Squat' }] } }],
        error: null
      })),
      getJoinedClientIds: vi.fn(async () => ({ data: [{ client_id: 'c1' }], error: null })),
      getClientById: vi.fn(async () => ({
        data: { email: 'c1@example.invalid', data: { name: 'Ali', emailReminders: true } },
        error: null
      })),
      sendEmail
    };

    // Wrong HTTP method -> 405
    expect((await handleDailyReminders(new Request('https://fn.local/daily-reminders', { method: 'GET' }), deps)).status).toBe(405);

    // Missing / wrong secret -> 401
    expect((await handleDailyReminders(postJson('https://fn.local/daily-reminders', {}), deps)).status).toBe(401);
    expect(
      (await handleDailyReminders(postJson('https://fn.local/daily-reminders', {}, { 'x-cron-secret': 'wrong' }), deps)).status
    ).toBe(401);

    // Live run paused when DAILY_REMINDERS_ENABLED=false
    const pausedRes = await handleDailyReminders(
      postJson('https://fn.local/daily-reminders', {}, { 'x-cron-secret': 'valid-cron-secret' }),
      deps
    );
    expect(pausedRes.status).toBe(200);
    expect(await pausedRes.json()).toEqual({
      today: '2026-11-20',
      timezone: 'Asia/Tehran',
      paused: true,
      results: []
    });
    expect(sendEmail).not.toHaveBeenCalled();

    // Dry-run (?dry=1) still previews eligible clients without sending emails
    const dryRes = await handleDailyReminders(
      postJson('https://fn.local/daily-reminders?dry=1', {}, { 'x-cron-secret': 'valid-cron-secret' }),
      deps
    );
    expect(dryRes.status).toBe(200);
    expect(await dryRes.json()).toEqual({
      today: '2026-11-20',
      timezone: 'Asia/Tehran',
      dry: true,
      results: [{ client: 'c1', status: 'would send' }]
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips ineligible rows, deduplicates same-day client workouts, sets Resend Idempotency-Key, and isolates per-client errors', async () => {
    const sendEmail = vi.fn<SendEmailFn>(async (to: string) =>
      to === 'c2@example.invalid'
        ? { ok: false, status: 502, error: 'temporary bounce' }
        : { ok: true }
    );
    const clients: Record<string, { email?: string; data?: { name?: string; emailReminders?: boolean } }> = {
      c1: { email: 'c1@example.invalid', data: { name: 'Reza Test', emailReminders: true } },
      c2: { email: 'c2@example.invalid', data: { name: 'Mina Test', emailReminders: true } },
      c3: { email: 'c3@example.invalid', data: { name: 'Off Client', emailReminders: false } },
      c4: { email: 'bad-email', data: { name: 'Bad Email', emailReminders: true } }
    };

    const res = await handleDailyReminders(
      postJson('https://fn.local/daily-reminders', {}, { 'x-cron-secret': 'valid-cron-secret' }),
      {
        appUrl: APP_URL,
        coachTimezone: 'Asia/Tehran',
        now: () => new Date('2026-11-20T11:00:00Z'),
        verifyCronSecret: async () => ({ ok: true, error: null }),
        getWorkoutsForDate: async (date) => {
          expect(date).toBe('2026-11-20');
          return {
            data: [
              { client_id: 'no-acct', data: { title: 'W', status: 'planned', blocks: [{ name: 'A' }] } },
              { client_id: 'done-1', data: { title: 'W', status: 'completed', blocks: [{ name: 'A' }] } },
              { client_id: 'empty-1', data: { title: 'W', status: 'planned', blocks: [] } },
              { client_id: 'c3', data: { title: 'W', status: 'planned', blocks: [{ name: 'A' }] } },
              { client_id: 'c4', data: { title: 'W', status: 'planned', blocks: [{ name: 'A' }] } },
              { client_id: 'c1', data: { title: 'Morning Lower', status: 'planned', blocks: [{ name: 'Split Squat' }] } },
              // Duplicate workout row for c1 on the same date -> must be skipped
              { client_id: 'c1', data: { title: 'Evening Mobility', status: 'planned', blocks: [{ name: '90/90' }] } },
              // c2 fails delivery -> should be recorded without aborting run
              { client_id: 'c2', data: { title: 'Upper', status: 'planned', blocks: [{ name: 'Row' }] } }
            ],
            error: null
          };
        },
        getJoinedClientIds: async () => ({
          data: [
            { client_id: 'done-1' },
            { client_id: 'empty-1' },
            { client_id: 'c1' },
            { client_id: 'c2' },
            { client_id: 'c3' },
            { client_id: 'c4' }
          ],
          error: null
        }),
        getClientById: async (id) => ({ data: clients[id] ?? null, error: null }),
        sendEmail
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { client: 'no-acct', status: 'skip: no account' },
      { client: 'done-1', status: 'skip: done' },
      { client: 'empty-1', status: 'skip: empty' },
      { client: 'c3', status: 'skip: off' },
      { client: 'c4', status: 'skip: invalid email' },
      { client: 'c1', status: 'sent' },
      { client: 'c1', status: 'skip: duplicate' },
      { client: 'c2', status: 'error: temporary bounce' }
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0][0]).toBe('c1@example.invalid');
    expect(sendEmail.mock.calls[0][2]).toContain('https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/');
    expect(sendEmail.mock.calls[0][3]).toEqual({ idempotencyKey: 'daily-reminder:2026-11-20:c1' });
    expect(sendEmail.mock.calls[1][3]).toEqual({ idempotencyKey: 'daily-reminder:2026-11-20:c2' });
  });
});

describe('Durable API budget fail-closed behavior', () => {
  it('does not generate or send a recovery link when the shared budget denies it', async () => {
    const generateRecoveryLink=vi.fn(async()=>({hashedToken:'never-used'}));
    const sendEmail=vi.fn<SendEmailFn>(async()=>({ok:true}));
    const reserveAttempt=vi.fn(async()=>false);
    const res=await handleResetPassword(postJson('https://fn.local/reset-password',{email:'athlete@googlemail.com'}),{
      appUrl:APP_URL,generateRecoveryLink,sendEmail,reserveAttempt
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok:true});
    expect(reserveAttempt).toHaveBeenCalledWith('athlete@gmail.com');
    expect(generateRecoveryLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('does not look up or create an account when the shared signup budget denies it',async()=>{
    const isExistingSignupAccount=vi.fn(async()=>({data:false,error:null}));
    const generateSignupLink=vi.fn(async()=>({hashedToken:'never-used'}));
    const sendEmail=vi.fn<SendEmailFn>(async()=>({ok:true}));
    const res=await handleSignUp(postJson('https://fn.local/sign-up',{email:'athlete@example.invalid',password:'synthetic123'}),{
      appUrl:APP_URL,reserveAttempt:async()=>false,
      reserveSignupVerification:async()=>({data:true,error:null}),getSignupRole:async()=>({data:'client',error:null}),
      isExistingSignupAccount,generateMagicLink:async()=>({}),generateSignupLink,deleteUser:async()=>{},sendEmail
    });
    expect(res.status).toBe(200);
    expect(isExistingSignupAccount).not.toHaveBeenCalled();
    expect(generateSignupLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
