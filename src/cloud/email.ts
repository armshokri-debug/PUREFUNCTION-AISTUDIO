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

/** Resending skips the allowlist write. The Edge Function checks the grant itself. */
export async function sendCoachInvite(email: string, alreadyAllowed: boolean): Promise<string | null> {
  if (!supabase) return 'Cloud is not configured.';
  const address = email.trim().toLowerCase();
  try {
    if (!alreadyAllowed) {
      const { error } = await supabase.rpc('pf_manage_trainer', {
        p_action: 'invite', p_email: address, p_client_id: null
      });
      if (error) return error.message;
    }

    const { data, error } = await supabase.functions.invoke('invite-trainer', { body: { email: address } });
    if (error) {
      const response: unknown = error.context;
      if (response instanceof Response) {
        const payload = await response.json().catch(() => null);
        const detail = payload?.error ?? payload?.message;
        if (typeof detail === 'string' && detail.trim()) return detail;
        return `Coach invitation failed (HTTP ${response.status}).`;
      }
      return error.message;
    }
    return data?.ok === true ? null : 'The server did not confirm that the invitation was sent.';
  } catch (error) {
    return error instanceof Error ? error.message : 'Coach invitation could not be completed.';
  }
}
