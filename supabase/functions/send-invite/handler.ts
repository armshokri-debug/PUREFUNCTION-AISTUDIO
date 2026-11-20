import { CooldownTracker, cors, isValidEmail, json, layout, type SendEmailOptions, type SendResult } from '../_shared/email-core.ts';

export const INVITE_COOLDOWN_MS = 60_000;

export interface SendInviteClientRow {
  id: string;
  email: string | null;
  coach_id: string;
  data?: { name?: unknown } | null;
}

export interface SendInviteDeps {
  appUrl: string;
  getUserByToken: (token: string) => Promise<{ id: string } | null>;
  getCoachProfile: (uid: string) => Promise<{ role?: string | null; display_name?: string | null } | null>;
  getOwnedClient: (token: string, clientId: string) => Promise<SendInviteClientRow | null>;
  isClientAccountConfirmed: (clientId: string) => Promise<boolean>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  cooldown?: CooldownTracker;
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

  const client = await deps.getOwnedClient(token, clientId);
  if (!client || client.coach_id !== uid) {
    return json(403, { error: 'Only the owning coach may invite this client.' });
  }

  const clientEmail = String(client.email ?? '').trim().toLowerCase();
  if (!clientEmail) return json(400, { error: 'This client has no email yet.' });
  if (!isValidEmail(clientEmail)) return json(400, { error: 'This client has an invalid email address.' });

  if (await deps.isClientAccountConfirmed(client.id)) {
    return json(409, { error: 'This client already has an active account.' });
  }

  const now = deps.now ? deps.now() : Date.now();
  const cooldownKey = `${uid}:${client.id}:${clientEmail}`;
  if (deps.cooldown?.isActive(cooldownKey, INVITE_COOLDOWN_MS, now)) {
    return json(429, { error: 'An invite was just sent to this client. Wait a minute before sending again.' });
  }

  const name = String(client.data?.name ?? '').trim().split(/\s+/)[0] || 'there';
  const coach = String(me.display_name ?? '').trim() || 'Your coach';
  const link = new URL(deps.appUrl);
  link.searchParams.set('join', clientEmail);

  const r = await deps.sendEmail(
    clientEmail,
    `${coach} invited you to Pure Function`,
    layout(
      `Hi ${name}, your training is ready`,
      [
        `${coach} set up your program in Pure Function.`,
        `Tap the button, choose a password, and you’ll see your workouts. Your email (${clientEmail}) is already filled in.`
      ],
      { text: 'Set up my account', url: link.toString() }
    )
  );

  if (r.ok) {
    deps.cooldown?.mark(cooldownKey, INVITE_COOLDOWN_MS, now);
    return json(200, { ok: true });
  }
  return json(r.status, { error: r.error });
}
