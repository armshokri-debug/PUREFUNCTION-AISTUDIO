import { describe, expect, it, vi } from 'vitest';
import {
  alternateGoogleMailDomain, emailCooldownKey, signInWithGoogleEmailFallback
} from '../../../supabase/functions/_shared/google-email-alias';
import { CooldownTracker } from '../../../supabase/functions/_shared/email-core';
import { handleSignUp } from '../../../supabase/functions/sign-up/handler';
import { handleResetPassword } from '../../../supabase/functions/reset-password/handler';

const url = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const post = (route: string, data: unknown) => new Request('https://fn.example/' + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
});

describe('Google email domain aliases', () => {
  it('maps gmail.com and googlemail.com in either direction, preserving plus tags and dots', () => {
    expect(alternateGoogleMailDomain('  P.User+tag@GMAIL.COM  ')).toBe('p.user+tag@googlemail.com');
    expect(alternateGoogleMailDomain('P.User@GOOGLEMAIL.COM')).toBe('p.user@gmail.com');
    expect(emailCooldownKey('P.User@googlemail.com')).toBe('p.user@gmail.com');
    expect(emailCooldownKey('P.User@gmail.com')).toBe('p.user@gmail.com');
  });

  it('never guesses aliases for other mail providers or similar-looking domains', () => {
    for (const address of [
      'person@google.com', 'person@notgmail.com', 'person@gmail.com.attacker.org',
      'person@outlook.com', 'person@yahoo.com', 'person@company.io'
    ]) {
      expect(alternateGoogleMailDomain(address)).toBeNull();
    }
    expect(alternateGoogleMailDomain('@gmail.com')).toBeNull();
    expect(emailCooldownKey('Person@company.io')).toBe('person@company.io');
  });

  it('first tries the exact login address and falls back to the Google domain only on invalid credentials', async () => {
    const attempt = vi.fn(async (email: string) => ({
      error: email === 'client@googlemail.com' ? null : { message: 'Invalid login credentials' },
      userId: email === 'client@googlemail.com' ? 'client-uid' : null
    }));
    const result = await signInWithGoogleEmailFallback('client@gmail.com', attempt);
    expect(result.userId).toBe('client-uid');
    expect(attempt.mock.calls.map(([email]) => email)).toEqual([
      'client@gmail.com', 'client@googlemail.com'
    ]);
  });

  it('never overrides exact-address success or retries unconfirmed/other-provider accounts', async () => {
    const ok = vi.fn(async () => ({ error: null, userId: 'exact' }));
    expect((await signInWithGoogleEmailFallback('client@gmail.com', ok)).userId).toBe('exact');
    expect(ok).toHaveBeenCalledTimes(1);

    const blocked = vi.fn(async () => ({ error: { message: 'Email not confirmed' }, userId: null }));
    await signInWithGoogleEmailFallback('client@gmail.com', blocked);
    expect(blocked).toHaveBeenCalledTimes(1);

    const stranger = vi.fn(async () => ({ error: { message: 'Invalid login credentials' } }));
    await signInWithGoogleEmailFallback('client@outlook.com', stranger);
    expect(stranger).toHaveBeenCalledTimes(1);
  });
});

describe('Gmail alias support for recovery', () => {
  it('recovers the existing googlemail.com identity through gmail.com input and shares cooldown', async () => {
    const generateRecoveryLink = vi.fn(async (email: string) =>
      email === 'client@googlemail.com'
        ? { hashedToken: 'recovery-token', error: null }
        : { hashedToken: undefined, error: { message: 'not found' } }
    );
    const sendEmail = vi.fn(async () => ({ ok: true as const }));
    const deps = {
      appUrl: url, generateRecoveryLink, sendEmail, cooldown: new CooldownTracker(),
      now: () => 1_000_000, logWarn: vi.fn(), logInfo: vi.fn()
    };
    const result = await handleResetPassword(post('reset-password', { email: 'CLIENT@gmail.com' }), deps);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(generateRecoveryLink.mock.calls.map(([email]) => email)).toEqual([
      'client@gmail.com', 'client@googlemail.com'
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('client@googlemail.com');

    await handleResetPassword(post('reset-password', { email: 'client@googlemail.com' }), deps);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.logInfo.mock.calls.some(([m]) => String(m).includes('password_recovery_cooldown'))).toBe(true);
  });

  it('keeps generic responses and does not send to nonexistent Gmail or other-provider accounts', async () => {
    const generateRecoveryLink = vi.fn(async () => ({
      hashedToken: undefined, error: { message: 'not found' }
    }));
    const sendEmail = vi.fn(async () => ({ ok: true as const }));
    const deps = { appUrl: url, generateRecoveryLink, sendEmail, logWarn: vi.fn() };
    const result = await handleResetPassword(post('reset-password', { email: 'nobody@gmail.com' }), deps);
    expect(await result.json()).toEqual({ ok: true });
    expect(generateRecoveryLink).toHaveBeenCalledTimes(2);
    expect(sendEmail).not.toHaveBeenCalled();
    await handleResetPassword(post('reset-password', { email: 'nobody@outlook.com' }), deps);
    expect(generateRecoveryLink).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(deps.logWarn.mock.calls)).not.toContain('nobody@gmail.com');
  });
});

describe('Gmail alias support for sign-up & verification', () => {
  const deps = () => ({
    appUrl: url,
    reserveSignupVerification: vi.fn(async () => ({ data: true as unknown, error: null })),
    getSignupRole: vi.fn(async (email: string) => ({
      data: email === 'invited@googlemail.com' ? 'client' as unknown : null, error: null
    })),
    isExistingSignupAccount: vi.fn(async (_email: string) => ({ data: false as unknown, error: null })),
    generateMagicLink: vi.fn(async () => ({ hashedToken: 'magic-hash', error: null })),
    generateSignupLink: vi.fn(async () => ({ hashedToken: 'signup-hash', userId: 'new-user', error: null })),
    deleteUser: vi.fn(async () => {}),
    sendEmail: vi.fn(async () => ({ ok: true as const })),
    logWarn: vi.fn()
  });

  it('uses the invited Google address so server-owned profile linkage is preserved', async () => {
    const d = deps();
    const result = await handleSignUp(post('sign-up', {
      email: 'INVITED@gmail.com', password: 'Password_123456', name: 'Invited'
    }), d);
    expect(await result.json()).toEqual({ ok: true, verificationRequired: true });
    expect(d.getSignupRole.mock.calls.map(([email]) => email)).toEqual([
      'invited@gmail.com', 'invited@googlemail.com'
    ]);
    expect(d.generateSignupLink).toHaveBeenCalledWith('invited@googlemail.com', 'Password_123456', 'Invited');
    expect(d.sendEmail.mock.calls[0][0]).toBe('invited@googlemail.com');
  });

  it('reuses existing Google alias account rather than creating a duplicate', async () => {
    const d = deps();
    d.isExistingSignupAccount.mockImplementation(async (email: string) => ({
      data: email === 'invited@googlemail.com', error: null
    }));
    const result = await handleSignUp(post('sign-up', {
      email: 'invited@gmail.com', password: 'Password_123456'
    }), d);
    expect(result.status).toBe(200);
    expect(d.generateSignupLink).not.toHaveBeenCalled();
    expect(d.reserveSignupVerification).toHaveBeenCalledWith('invited@googlemail.com');
    expect(d.generateMagicLink).toHaveBeenCalledWith('invited@googlemail.com');
    expect(d.sendEmail.mock.calls[0][0]).toBe('invited@googlemail.com');
  });

  it('does not create accounts when either alias lookup fails, and never exposes account presence', async () => {
    const d = deps();
    d.isExistingSignupAccount.mockResolvedValueOnce({
      data: false, error: null
    }).mockResolvedValueOnce({ data: false, error: { message: 'RPC offline' } as never });
    const result = await handleSignUp(post('sign-up', {
      email: 'invited@gmail.com', password: 'Password_123456'
    }), d);
    expect(result.status).toBe(503);
    expect(d.generateSignupLink).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });
});
