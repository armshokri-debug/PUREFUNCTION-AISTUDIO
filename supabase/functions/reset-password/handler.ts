import {
  classifyMailFailure,
  CooldownTracker,
  cors,
  isValidEmail,
  json,
  layout,
  type SendEmailOptions,
  type SendResult
} from '../_shared/email-core.ts';

export const RESET_COOLDOWN_MS = 60_000;

export interface ResetPasswordDeps {
  appUrl: string;
  generateRecoveryLink: (email: string) => Promise<{ hashedToken?: string; error?: unknown }>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  cooldown?: CooldownTracker;
  now?: () => number;
  logWarn?: (line: string) => void;
  logInfo?: (line: string) => void;
}

export async function handleResetPassword(req: Request, deps: ResetPasswordDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const { email } = (await req.json().catch(() => ({}))) as { email?: unknown };
  const addr = String(email ?? '').trim().toLowerCase();
  if (!isValidEmail(addr)) return json(400, { error: 'Enter a valid email address.' });

  const warn = deps.logWarn ?? console.warn;
  const info = deps.logInfo ?? console.info;

  // Public replies stay identical for valid addresses. Operational logs contain
  // only fixed reason codes: never email addresses, recovery links/tokens or keys.
  const report = (reason: string, status?: number) =>
    warn(JSON.stringify({ event: 'password_recovery_failed', reason, ...(status === undefined ? {} : { status }) }));

  const now = deps.now ? deps.now() : Date.now();
  if (deps.cooldown?.isActive(addr, RESET_COOLDOWN_MS, now)) {
    info(JSON.stringify({ event: 'password_recovery_cooldown' }));
    return json(200, { ok: true });
  }

  try {
    const { hashedToken, error } = await deps.generateRecoveryLink(addr);
    if (!error && hashedToken) {
      const link = new URL(deps.appUrl);
      link.searchParams.set('reset', hashedToken);
      const r = await deps.sendEmail(
        addr,
        'Reset your Pure Function password',
        layout(
          'Reset your password',
          [
            'Tap the button to choose a new password. The link works once and expires in 1 hour.',
            'If you didn’t ask for this, ignore this email.'
          ],
          { text: 'Choose a new password', url: link.toString() }
        )
      );
      if (!r.ok) {
        report(classifyMailFailure(r), r.status);
      } else {
        deps.cooldown?.mark(addr, RESET_COOLDOWN_MS, now);
        info(JSON.stringify({ event: 'password_recovery_mail_accepted' }));
      }
    } else {
      report('link_generation_failed');
    }
  } catch {
    report('request_failed');
  }

  return json(200, { ok: true });
}
