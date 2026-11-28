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
import { alternateGoogleMailDomain, emailCooldownKey } from '../_shared/google-email-alias.ts';

export const RESET_COOLDOWN_MS = 60_000;

const GITHUB_APP = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const CLOUDFLARE_APP = 'https://purefunction-live.pages.dev/';

// Select only fixed, trusted production destinations. Never copy an arbitrary
// Origin, Referer or request-body URL into a recovery link. Preserve QA and
// other explicitly configured deployments.
function recoveryAppUrl(configured: string, origin: string | null): string {
  const base = configured.endsWith('/') ? configured : configured + '/';
  if (base !== GITHUB_APP && base !== CLOUDFLARE_APP) return configured;
  if (origin === 'https://armshokri-debug.github.io') return GITHUB_APP;
  if (origin === 'https://purefunction-live.pages.dev') return CLOUDFLARE_APP;
  return configured;
}


export interface ResetPasswordDeps {
  appUrl: string;
  generateRecoveryLink: (email: string) => Promise<{ hashedToken?: string; error?: unknown }>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  cooldown?: CooldownTracker;
  reserveAttempt?: (subject: string) => Promise<boolean>;
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
  if (deps.cooldown?.isActive(emailCooldownKey(addr), RESET_COOLDOWN_MS, now)) {
    info(JSON.stringify({ event: 'password_recovery_cooldown' }));
    return json(200, { ok: true });
  }

  try {
    if (deps.reserveAttempt && !(await deps.reserveAttempt(emailCooldownKey(addr)))) return json(200, { ok: true });
    // Existing users may have registered with googlemail.com instead of gmail.com.
    // Generate a link for the stored address, not a new or guessed identity.
    let recipient = addr;
    let { hashedToken, error } = await deps.generateRecoveryLink(recipient);
    const alternate = alternateGoogleMailDomain(addr);
    if ((!hashedToken || error) && alternate) {
      const retry = await deps.generateRecoveryLink(alternate);
      if (!retry.error && retry.hashedToken) {
        recipient = alternate;
        hashedToken = retry.hashedToken;
        error = null;
      }
    }
    if (!error && hashedToken) {
      const link = new URL(recoveryAppUrl(deps.appUrl, req.headers.get('Origin')));
      link.searchParams.set('reset', hashedToken);
      // Distinguish each request in mail clients that group identical subjects
      // or hide repeated message content. No token or account data in the subject.
      const requestedAt = new Date(now).toISOString();
      const r = await deps.sendEmail(
        recipient,
        `Reset your Pure Function password — ${requestedAt}`,
        layout(
          'Reset your password',
          [
            `Recovery requested at ${requestedAt} (UTC). Use only the newest recovery email.`,
            'Tap the button to choose a new password. The link works once and expires in 1 hour.',
            'If you didn’t ask for this, ignore this email.'
          ],
          { text: 'Choose a new password', url: link.toString() }
        )
      );
      if (!r.ok) {
        report(classifyMailFailure(r), r.status);
      } else {
        deps.cooldown?.mark(emailCooldownKey(addr), RESET_COOLDOWN_MS, now);
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
