import { CooldownTracker, cors, isValidEmail, json, layout, type SendEmailOptions, type SendResult } from '../_shared/email-core.ts';
import { alternateGoogleMailDomain, emailCooldownKey } from '../_shared/google-email-alias.ts';

export const INVITE_COOLDOWN_MS = 60_000;

export interface SendInviteClientRow {
  id: string;
  email: string | null;
  coach_id: string;
  data?: { name?: unknown } | null;
}

export interface ExistingInviteAccount {
  email: string;
  confirmed: boolean;
  hasPassword: boolean;
  clientId: string | null;
}

/** The one email is the ownership proof; no second sign-up verification is required. */
export interface SendInviteDeps {
  appUrl: string;
  getUserByToken: (token: string) => Promise<{ id: string } | null>;
  getCoachProfile: (uid: string) => Promise<{ role?: string | null; display_name?: string | null } | null>;
  getOwnedClient: (token: string, clientId: string) => Promise<SendInviteClientRow | null>;
  isClientAccountConfirmed: (clientId: string) => Promise<boolean>;
  getExistingAccount: (email: string) => Promise<{ data: ExistingInviteAccount | null; error: unknown }>;
  generateInviteLink: (email: string, name: string) => Promise<{ hashedToken?: string; userId?: string; error?: { message: string } | null }>;
  generateMagicLink: (email: string) => Promise<{ hashedToken?: string; error?: { message: string } | null }>;
  deleteNewUser: (id: string) => Promise<void>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  cooldown?: CooldownTracker;
  reserveAttempt?: (subject: string) => Promise<boolean>;
  now?: () => number;
}

export async function handleSendInvite(req: Request, deps: SendInviteDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Sign in again.' });

  const user = await deps.getUserByToken(token);
  const uid = user?.id;
  if (!uid) return json(401, { error: 'Sign in again.' });

  const me = await deps.getCoachProfile(uid);
  if (me?.role !== 'coach') return json(403, { error: 'Only the coach can send invites.' });

  const body = (await req.json().catch(() => ({}))) as { clientId?: unknown };
  const clientId = String(body.clientId ?? '').trim();
  if (!clientId) return json(400, { error: 'Save the client before sending an invite.' });

  // Read only via the caller's JWT and recheck ownership, not service-role visibility.
  const client = await deps.getOwnedClient(token, clientId);
  if (!client || client.coach_id !== uid) {
    return json(403, { error: 'Only the owning coach may invite this client.' });
  }

  const clientEmail = String(client.email ?? '').trim().toLowerCase();
  if (!clientEmail || !isValidEmail(clientEmail)) {
    return json(400, { error: 'This client needs a valid email address.' });
  }
  if (await deps.isClientAccountConfirmed(client.id)) {
    return json(409, { error: 'This client already has an active account.' });
  }

  const now = deps.now ? deps.now() : Date.now();
  const cooldownKey = `${uid}:${client.id}:${emailCooldownKey(clientEmail)}`;
  if (deps.cooldown?.isActive(cooldownKey, INVITE_COOLDOWN_MS, now)) {
    return json(429, { error: 'An invite was just sent. Wait a minute before sending again.' });
  }

  if (deps.reserveAttempt) {
    try {
      if (!(await deps.reserveAttempt(emailCooldownKey(clientEmail)))) return json(429, { error: 'Invitation limit reached. Wait before trying again.' });
    } catch { return json(503, { error: 'Invitation temporarily unavailable.' }); }
  }

  // Fail closed on lookup errors; never create a second user for the other Gmail spelling.
  let existing = await deps.getExistingAccount(clientEmail);
  if (existing.error) return json(503, { error: 'Could not check this invitation. Try again.' });
  const alias = alternateGoogleMailDomain(clientEmail);
  if (!existing.data && alias) {
    existing = await deps.getExistingAccount(alias);
    if (existing.error) return json(503, { error: 'Could not check this invitation. Try again.' });
  }
  if (existing.data && existing.data.clientId !== client.id) {
    // Even the Gmail/googlemail spelling of another linked account must
    // never be re-used to activate an unrelated client profile.
    return json(409, { error: 'This address is linked to a different client record. Review duplicate client emails before inviting.' });
  }
  if (existing.data?.confirmed && existing.data.hasPassword) {
    return json(409, {
      error: 'An account already exists for this email. Ask the client to sign in. Contact support if their training is missing.'
    });
  }

  const recipient = existing.data?.email ?? clientEmail;
  const name = String(client.data?.name ?? '').trim().split(/\s+/)[0] || 'there';
  const coach = String(me.display_name ?? '').trim() || 'Your coach';

  // Supabase generates an expiring, single-use ownership proof. The coach cannot
  // choose a password, and the server never returns the token to the coach.
  const generated = existing.data
    ? await deps.generateMagicLink(recipient) // re-invite an unconfirmed account
    : await deps.generateInviteLink(recipient, String(client.data?.name ?? '').trim());
  if (generated.error || !generated.hashedToken) {
    return json(503, { error: 'Could not create a secure invitation. Please try again.' });
  }

  const link = new URL(deps.appUrl);
  link.searchParams.set('invite', generated.hashedToken);
  if (existing.data) link.searchParams.set('inviteType', 'magiclink');

  const sent = await deps.sendEmail(
    recipient,
    `${coach} invited you to Pure Function`,
    layout(
      `Hi ${name}, your training is ready`,
      [
        `${coach} invited you to Pure Function.`,
        'Open this secure invitation once, choose your password, and start training. No separate verification email is needed.'
      ],
      { text: 'Accept invitation', url: link.toString() }
    )
  );

  if (!sent.ok) {
    // Roll back ONLY an account created by this invocation, never an existing user.
    if (!existing.data && 'userId' in generated && typeof generated.userId === 'string') {
      try { await deps.deleteNewUser(generated.userId); } catch {
        console.warn(JSON.stringify({ event: 'invite_cleanup_failed' }));
      }
    }
    return json(sent.status, { error: sent.error });
  }

  deps.cooldown?.mark(cooldownKey, INVITE_COOLDOWN_MS, now);
  return json(200, { ok: true });
}
