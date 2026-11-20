import {
  classifyMailFailure,
  cors,
  isValidEmail,
  json,
  layout,
  type SendEmailOptions,
  type SendResult
} from '../_shared/email-core.ts';

export interface SignUpDeps {
  appUrl: string;
  reserveSignupVerification: (email: string) => Promise<{ data: unknown; error: unknown }>;
  getSignupRole: (email: string) => Promise<{ data: unknown; error: unknown }>;
  isExistingSignupAccount: (email: string) => Promise<{ data: unknown; error: unknown }>;
  generateMagicLink: (email: string) => Promise<{ hashedToken?: string; error?: { message: string } | null }>;
  generateSignupLink: (
    email: string,
    password: string,
    displayName: string
  ) => Promise<{ hashedToken?: string; userId?: string; error?: { message: string } | null }>;
  deleteUser: (userId: string) => Promise<void>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  logWarn?: (line: string) => void;
}

export async function handleSignUp(req: Request, deps: SignUpDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body: { email?: unknown; password?: unknown; name?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const name = String(body.name ?? '').trim().slice(0, 80);
  const action = body.action === 'resend' ? 'resend' : 'signup';

  if (!isValidEmail(email)) {
    return json(400, { error: 'Enter a valid email address.' });
  }
  // Resends need no password; the email itself is the verification credential.
  if (action !== 'resend' && (password.length < 8 || password.length > 72)) {
    return json(400, { error: 'Password must be 8 to 72 characters.' });
  }

  const warn = deps.logWarn ?? console.warn;
  const report = (event: string, reason: string, status?: number) =>
    warn(JSON.stringify({ event, reason, ...(status === undefined ? {} : { status }) }));

  // Identical response for unknown, confirmed and unconfirmed addresses: no enumeration.
  const generic = () => json(200, { ok: true, verificationRequired: true });

  const sendLink = async (token: string, type: 'signup' | 'magiclink') => {
    const link = new URL(deps.appUrl);
    link.searchParams.set('verify', token);
    if (type === 'magiclink') link.searchParams.set('verifyType', 'magiclink');
    return deps.sendEmail(
      email,
      'Verify your Pure Function email',
      layout(
        'Verify your email',
        ['Please verify that you own this email before signing in.'],
        { text: 'Verify email', url: link.toString() }
      )
    );
  };

  const resend = async () => {
    // Fail closed if the reservation RPC errors or denies the attempt.
    const { data: permitted, error: limitError } = await deps.reserveSignupVerification(email);
    if (limitError || permitted !== true) return generic();
    const { hashedToken, error } = await deps.generateMagicLink(email);
    if (!error && hashedToken) {
      const sent = await sendLink(hashedToken, 'magiclink');
      if (!sent.ok) report('signup_resend_failed', classifyMailFailure(sent), sent.status);
    } else if (error) {
      report('signup_resend_failed', 'link_generation_failed');
    }
    return generic();
  };

  if (action === 'resend') return resend();

  const { data: role, error: roleError } = await deps.getSignupRole(email);
  if (roleError) return json(503, { error: 'Verification is temporarily unavailable.' });
  if (!role) return generic();

  const { data: existing, error: lookupError } = await deps.isExistingSignupAccount(email);
  if (!lookupError && existing === true) return resend();

  const { hashedToken, userId, error } = await deps.generateSignupLink(email, password, name);
  if (error) {
    if (/already|registered|exists/i.test(error.message)) return resend();
    return json(503, { error: 'Verification is temporarily unavailable.' });
  }
  if (!hashedToken || !userId) return generic();

  const sent = await sendLink(hashedToken, 'signup');
  if (!sent.ok) {
    report('signup_verification_failed', classifyMailFailure(sent), sent.status);
    // Roll back this unconfirmed registration so the person can retry cleanly.
    try {
      await deps.deleteUser(userId);
    } catch {
      report('signup_rollback_failed', 'delete_user_failed');
    }
    return generic(); // provider failure is not an account-existence oracle
  }
  return generic();
}
