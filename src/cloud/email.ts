import { supabase, supabaseUrl } from './supabase';

/** Coach only: emails the client their invite link. Returns an error message or null. */
export async function sendInviteEmail(clientId: string): Promise<string | null> {
  if (!supabase) return 'Cloud is not configured.';
  if (!clientId.trim()) return 'Save the client before sending an invite.';
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return 'Sign in again.';
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
    if (res.ok && body.ok !== false) return null;
    if (msg) return msg;
    if (res.status === 401) return 'Sign in again.';
    if (res.status === 403) {
      return 'Email delivery is blocked until a verified sender domain is configured in Resend.';
    }
    return 'Could not send the email. Try again.';
  } catch {
    return 'No connection. Check your internet and try again.';
  }
}
