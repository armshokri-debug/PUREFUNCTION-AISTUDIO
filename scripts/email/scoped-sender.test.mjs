import { expect, it, vi } from 'vitest';

it('uses the transactional sender only for transactional calls and preserves the shared fallback', async () => {
  const env = {
    RESEND_API_KEY: 'mock-key',
    EMAIL_FROM: 'Shared <shared@example.invalid>',
    TRANSACTIONAL_EMAIL_FROM: 'Transactional <transactional@example.invalid>'
  };
  const fromAddresses = [];
  vi.stubGlobal('Deno', { env: { get: (name) => env[name] } });
  vi.stubGlobal('fetch', async (_url, options) => {
    fromAddresses.push(JSON.parse(options.body).from);
    return new Response(null, { status: 200 });
  });

  try {
    const { sendEmail, sendTransactionalEmail } = await import('../../supabase/functions/_shared/email.ts');
    const args = ['student@example.invalid', 'Test', '<p>Test</p>'];
    expect(await sendEmail(...args)).toEqual({ ok: true });
    expect(await sendTransactionalEmail(...args)).toEqual({ ok: true });
    delete env.TRANSACTIONAL_EMAIL_FROM;
    expect(await sendTransactionalEmail(...args)).toEqual({ ok: true });
    expect(fromAddresses).toEqual([
      'Shared <shared@example.invalid>',
      'Transactional <transactional@example.invalid>',
      'Shared <shared@example.invalid>'
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
