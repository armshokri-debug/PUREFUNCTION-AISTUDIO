import { supabase, supabaseUrl } from './supabase';

export interface DeleteClientInput {
  clientId: string;
  confirm: boolean;
  confirmName?: string;
}

/**
 * Coach only: requests verified server-side deletion of a client, its dependent
 * records, stored media, and linked Auth account. Returns an error message or null.
 */
export async function deleteClientRemote(input: DeleteClientInput): Promise<string | null> {
  if (!supabase) return 'Cloud is not configured.';
  if (!input.clientId.trim()) return 'Invalid client identifier.';
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return 'Sign in again.';

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/delete-client`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        clientId: input.clientId,
        confirm: input.confirm,
        confirmName: input.confirmName
      })
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      msg?: string;
    };
    const msg = (body.error || body.message || body.msg || '').trim();
    if (res.ok && body.ok === true) return null;
    if (msg) return msg;
    if (res.status === 401) return 'Sign in again.';
    if (res.status === 403) return 'Only the owning coach may delete this client.';
    if (res.status === 404) return 'Client deletion service is not available yet. Please try again later.';
    return 'Could not delete this client safely. No changes were saved locally.';
  } catch {
    return 'No connection. Check your internet and try again.';
  }
}
