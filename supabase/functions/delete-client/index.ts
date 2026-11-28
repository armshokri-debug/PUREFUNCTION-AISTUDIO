// Coach-only: staged, trackable, idempotent deletion of an owned client (verify_jwt = true).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import {
  type ClientDeletionJob,
  type ClientStorageBucket,
  handleDeleteClient
} from './handler.ts';

function isBucketNotFound(error: unknown): boolean {
  const msg =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '');
  return /bucket not found|not found/i.test(msg);
}

function isUserNotFound(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error && (error as { status?: unknown }).status === 404) {
    return true;
  }
  const msg =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '');
  return /user not found/i.test(msg);
}

async function listBucketPrefix(
  admin: SupabaseClient,
  bucket: ClientStorageBucket,
  prefix: string,
  depth = 0
): Promise<{ paths: string[]; error: unknown }> {
  if (depth > 5) return { paths: [], error: new Error('Storage traversal depth exceeded') };
  const collected: string[] = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) {
      if (isBucketNotFound(error)) return { paths: [], error: null };
      return { paths: [], error };
    }
    const items = data ?? [];
    for (const item of items) {
      const fullPath = `${prefix}/${item.name}`;
      if (item.id === null && !item.metadata) {
        const nested = await listBucketPrefix(admin, bucket, fullPath, depth + 1);
        if (nested.error) return nested;
        collected.push(...nested.paths);
      } else {
        collected.push(fullPath);
      }
    }
    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return { paths: collected, error: null };
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  });

  const callerClient = (token: string) =>
    createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false }
    });

  return handleDeleteClient(req, {
    getUserByToken: async (token) => {
      const { data } = await admin.auth.getUser(token);
      return data.user ? { id: data.user.id } : null;
    },
    getCoachProfile: async (uid) => {
      const { data } = await admin
        .from('profiles')
        .select('role')
        .eq('id', uid)
        .maybeSingle();
      return data;
    },
    getOwnedClient: async (token, clientId) => {
      const caller = callerClient(token);
      const { data, error } = await caller
        .from('clients')
        .select('id, email, coach_id, data')
        .eq('id', clientId)
        .maybeSingle();
      return error ? null : data;
    },
    clientRowExists: async (clientId) => {
      const { data, error } = await admin
        .from('clients')
        .select('id')
        .eq('id', clientId)
        .maybeSingle();
      return { exists: Boolean(data?.id), error };
    },
    getLinkedProfiles: async (clientId) => {
      const { data, error } = await admin
        .from('profiles')
        .select('id, role')
        .eq('client_id', clientId);
      return { data: (data ?? []) as Array<{ id: string; role: string | null }>, error };
    },
    listClientStoragePaths: (bucket, clientId) => listBucketPrefix(admin, bucket, clientId),
    acquireDeletionLease: async (clientId, coachId, leaseId) => {
      const { data, error } = await admin.rpc('pf_deletion_lease_acquire', {
        p_client_id: clientId, p_coach_id: coachId, p_lease_id: leaseId
      });
      return { outcome: data as 'acquired' | 'busy' | 'forbidden' | null, error };
    },
    releaseDeletionLease: async (clientId, leaseId) => {
      return admin.rpc('pf_deletion_lease_release', { p_client_id: clientId, p_lease_id: leaseId });
    },
    getDeletionJob: async (clientId) => {
      const { data, error } = await admin.rpc('pf_deletion_job_get', { p_client_id: clientId });
      return { data: (data as ClientDeletionJob | null) ?? null, error };
    },
    createDeletionJob: async (input) => {
      const { data, error } = await admin.rpc('pf_deletion_job_create', {
        p_client_id: input.clientId,
        p_coach_id: input.coachId,
        p_client_name: input.clientName,
        p_is_test_client: input.isTestClient,
        p_linked_auth_user_ids: input.linkedAuthUserIds,
        p_storage_manifest: input.storageManifest
      });
      return { data: (data as ClientDeletionJob | null) ?? null, error };
    },
    updateDeletionJob: async (clientId, patch) => {
      const { data, error } = await admin.rpc('pf_deletion_job_advance', {
        p_client_id: clientId,
        p_status: patch.status,
        p_last_error: patch.lastError ?? null,
        p_increment_attempts: Boolean(patch.incrementAttempts)
      });
      return { data: (data as ClientDeletionJob | null) ?? null, error };
    },
    setAuthUserBanned: async (uid, banned) => {
      const { error } = await admin.auth.admin.updateUserById(uid, {
        ban_duration: banned ? '876000h' : 'none'
      });
      if (error && isUserNotFound(error)) {
        return { error: null };
      }
      return { error };
    },
    deleteOwnedClientRow: async (token, clientId) => {
      const caller = callerClient(token);
      const { data, error } = await caller
        .from('clients')
        .delete()
        .eq('id', clientId)
        .select('id');
      return { deleted: !error && Array.isArray(data) && data.length === 1, error };
    },
    deleteAuthUser: async (uid) => {
      const { error } = await admin.auth.admin.deleteUser(uid);
      if (error && isUserNotFound(error)) {
        // Idempotent cleanup if the Auth user was already deleted in a prior attempt.
        const cleanup = await admin.from('profiles').delete().eq('id', uid).eq('role', 'client');
        return { error: cleanup.error };
      }
      return { error };
    },
    removeStoragePaths: async (bucket, paths) => {
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const { error } = await admin.storage.from(bucket).remove(chunk);
        if (error) return { error };
      }
      return { error: null };
    }
  });
});
