import { cors, json } from '../_shared/email-core.ts';

export const CLIENT_STORAGE_BUCKETS = ['client-videos', 'inbody-printouts', 'message-media'] as const;
export type ClientStorageBucket = (typeof CLIENT_STORAGE_BUCKETS)[number];

export interface DeleteClientRow {
  id: string;
  email: string | null;
  coach_id: string;
  data?: { name?: unknown; isTestClient?: unknown } | null;
}

export interface LinkedProfileRow {
  id: string;
  role: string | null;
}

export interface DeleteClientDeps {
  getUserByToken: (token: string) => Promise<{ id: string } | null>;
  getCoachProfile: (uid: string) => Promise<{ role?: string | null } | null>;
  getOwnedClient: (token: string, clientId: string) => Promise<DeleteClientRow | null>;
  getLinkedProfiles: (clientId: string) => Promise<{ data: LinkedProfileRow[]; error: unknown }>;
  listClientStoragePaths: (
    bucket: ClientStorageBucket,
    clientId: string
  ) => Promise<{ paths: string[]; error: unknown }>;
  deleteAuthUser: (uid: string) => Promise<{ error: unknown }>;
  deleteOwnedClientRow: (
    token: string,
    clientId: string
  ) => Promise<{ deleted: boolean; error: unknown }>;
  removeStoragePaths: (
    bucket: ClientStorageBucket,
    paths: string[]
  ) => Promise<{ error: unknown }>;
}

function isSafeClientId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !/[\u0000-\u001f]/.test(id)
  );
}

export async function handleDeleteClient(req: Request, deps: DeleteClientDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Sign in again.' });

  const user = await deps.getUserByToken(token);
  const uid = user?.id;
  if (!uid) return json(401, { error: 'Sign in again.' });

  const me = await deps.getCoachProfile(uid);
  if (me?.role !== 'coach') return json(403, { error: 'Only the coach can delete a client.' });

  const body = (await req.json().catch(() => null)) as {
    clientId?: unknown;
    confirm?: unknown;
    confirmName?: unknown;
  } | null;
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'Invalid deletion request.' });
  }

  const clientId = String(body.clientId ?? '').trim();
  if (!isSafeClientId(clientId)) {
    return json(400, { error: 'Invalid client identifier.' });
  }

  if (body.confirm !== true) {
    return json(400, { error: 'Explicit coach confirmation is required before deleting a client.' });
  }

  // Read via caller JWT so RLS verifies allowlisted, confirmed coach ownership.
  const client = await deps.getOwnedClient(token, clientId);
  if (!client || client.coach_id !== uid) {
    return json(403, { error: 'Only the owning coach may delete this client.' });
  }

  const isTestClient = Boolean(client.data?.isTestClient);
  const storedName = String(client.data?.name ?? '').trim();
  if (!isTestClient) {
    const providedName = String(body.confirmName ?? '').trim();
    if (!storedName || providedName.toLowerCase() !== storedName.toLowerCase()) {
      return json(400, { error: 'Type the client’s full name to confirm permanent deletion.' });
    }
  }

  // Preflight 1: resolve all Auth accounts linked to this client before mutating anything.
  const linked = await deps.getLinkedProfiles(client.id);
  if (linked.error) {
    return json(503, { error: 'Could not verify linked client accounts. No data was deleted.' });
  }
  const linkedProfiles = linked.data ?? [];
  if (linkedProfiles.some((p) => p.role !== 'client' || p.id === uid)) {
    return json(409, { error: 'Refused: this client record is linked to a coach account.' });
  }

  // Preflight 2: list client storage objects before mutating Auth or DB so errors fail closed.
  const storagePlan: Array<{ bucket: ClientStorageBucket; paths: string[] }> = [];
  for (const bucket of CLIENT_STORAGE_BUCKETS) {
    const listed = await deps.listClientStoragePaths(bucket, client.id);
    if (listed.error) {
      return json(503, { error: 'Could not verify client media files. No data was deleted.' });
    }
    if (listed.paths.length > 0) {
      storagePlan.push({ bucket, paths: listed.paths });
    }
  }

  // Step 1: Delete linked client Auth user(s) first (cascades public.profiles & revokes sessions).
  // If this fails, the client row and all training/media records remain completely intact.
  const uniqueAuthIds = [...new Set(linkedProfiles.map((p) => p.id))];
  for (const authUserId of uniqueAuthIds) {
    const deletedAuth = await deps.deleteAuthUser(authUserId);
    if (deletedAuth.error) {
      return json(503, {
        error: 'Could not remove the client’s sign-in account. Please retry.'
      });
    }
  }

  // Step 2: Delete the client row via caller's JWT (enforces RLS DELETE policy and
  // atomically cascades workouts, messages, notes, food diary, posture, referrals, etc.).
  const deletedRow = await deps.deleteOwnedClientRow(token, client.id);
  if (deletedRow.error || !deletedRow.deleted) {
    return json(500, {
      error: 'Could not complete client deletion in the database. Please refresh and contact support if needed.'
    });
  }

  // Step 3: Remove client-scoped storage objects across all client buckets.
  for (const item of storagePlan) {
    const removed = await deps.removeStoragePaths(item.bucket, item.paths);
    if (removed.error) {
      return json(502, {
        error: 'Client profile was removed, but some stored media files could not be cleaned up. Refresh and contact support if needed.',
        partialCleanup: true
      });
    }
  }

  return json(200, {
    ok: true,
    deletedClientId: client.id,
    deletedAuthUsers: uniqueAuthIds.length,
    deletedFiles: storagePlan.reduce((sum, item) => sum + item.paths.length, 0)
  });
}
