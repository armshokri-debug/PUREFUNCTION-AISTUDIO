import { supabase, supabaseUrl } from './supabase';

export interface DeleteClientInput {
  clientId: string;
  confirm: boolean;
  confirmName?: string;
}

export type DeleteClientResult =
  | {
      ok: true;
      status: 'completed';
      alreadyCompleted?: boolean;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      stage?: string;
      authRestored?: boolean;
    };

/**
 * Coach only: requests staged, trackable, idempotent server-side deletion of an owned
 * client, its dependent records, linked Auth account, and stored media.
 */
export async function deleteClientRemote(input: DeleteClientInput): Promise<DeleteClientResult> {
  if (!supabase) {
    return { ok: false, error: 'Cloud is not configured.', retryable: false };
  }
  if (!input.clientId.trim()) {
    return { ok: false, error: 'Invalid client identifier.', retryable: false };
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return { ok: false, error: 'Sign in again.', retryable: false };
  }

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
      status?: string;
      alreadyCompleted?: boolean;
      error?: string;
      message?: string;
      msg?: string;
      retryable?: boolean;
      stage?: string;
      authRestored?: boolean;
    };
    const msg = (body.error || body.message || body.msg || '').trim();
    if (res.ok && body.ok === true && body.status === 'completed') {
      return {
        ok: true,
        status: 'completed',
        alreadyCompleted: Boolean(body.alreadyCompleted)
      };
    }
    if (msg) {
      return {
        ok: false,
        error: msg,
        retryable: body.retryable === true || res.status >= 500,
        stage: body.stage,
        authRestored: body.authRestored
      };
    }
    if (res.status === 401) {
      return { ok: false, error: 'Sign in again.', retryable: false };
    }
    if (res.status === 403) {
      return { ok: false, error: 'Only the owning coach may delete this client.', retryable: false };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: 'Safe client deletion service is not deployed yet. Use Archive instead.',
        retryable: false
      };
    }
    return {
      ok: false,
      error: 'Could not confirm safe client deletion. Retry safely or use Archive instead.',
      retryable: res.status >= 500
    };
  } catch {
    return {
      ok: false,
      error: 'Connection interrupted before deletion finished. Check your internet and click Retry Delete to resume safely.',
      retryable: true,
      stage: 'network'
    };
  }
}
