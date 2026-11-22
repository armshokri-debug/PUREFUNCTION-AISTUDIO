import { supabase, supabaseUrl } from './supabase';

export type SendInviteErrorKind =
  | 'validation'
  | 'auth'
  | 'ownership'
  | 'already_active'
  | 'cooldown'
  | 'expired'
  | 'delivery'
  | 'network';

export type SendInviteResult =
  | { ok: true }
  | { ok: false; kind: SendInviteErrorKind; error: string };

/**
 * Coach only: requests the server-side `send-invite` Edge Function to send a
 * verified one-link client invitation. Never reports success unless the server
 * explicitly confirms `{ ok: true }`.
 */
export async function sendInviteEmailResult(clientId: string): Promise<SendInviteResult> {
  if (!supabase) {
    return { ok: false, kind: 'validation', error: 'Cloud is not configured.' };
  }
  if (!clientId.trim()) {
    return { ok: false, kind: 'validation', error: 'Save the client before sending an invite.' };
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return { ok: false, kind: 'auth', error: 'Sign in again.' };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId })
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      msg?: string;
    };
    const msg = (body.error || body.message || body.msg || '').trim();

    if (res.ok && body.ok === true) {
      return { ok: true };
    }

    if (res.status === 401) {
      return { ok: false, kind: 'auth', error: msg || 'Your session expired. Sign in again.' };
    }
    if (res.status === 409) {
      return {
        ok: false,
        kind: 'already_active',
        error:
          msg ||
          'This client already has an active account. Ask them to sign in or use Forgot password.'
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        kind: 'cooldown',
        error: msg || 'An invite was just sent. Please wait a minute before resending.'
      };
    }
    if (res.status === 410 || /expired/i.test(msg)) {
      return {
        ok: false,
        kind: 'expired',
        error: msg || 'The previous invitation expired. Try resending a fresh invitation.'
      };
    }
    if (res.status === 403) {
      const isOwnership = /owning coach|only the coach/i.test(msg);
      return {
        ok: false,
        kind: isOwnership ? 'ownership' : 'delivery',
        error:
          msg ||
          'Email delivery is blocked until a verified sender domain is configured in Resend.'
      };
    }
    if (msg) {
      return { ok: false, kind: res.status >= 500 ? 'delivery' : 'validation', error: msg };
    }
    return {
      ok: false,
      kind: 'delivery',
      error: 'Could not confirm email delivery. Please try again.'
    };
  } catch {
    return {
      ok: false,
      kind: 'network',
      error: 'No connection. Check your internet and try again.'
    };
  }
}

/** Backward-compatible helper: returns null on confirmed `{ ok: true }`, or an error string. */
export async function sendInviteEmail(clientId: string): Promise<string | null> {
  const result = await sendInviteEmailResult(clientId);
  return result.ok ? null : result.error;
}
