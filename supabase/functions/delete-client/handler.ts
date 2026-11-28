import { cors, json } from '../_shared/email-core.ts';

export const CLIENT_STORAGE_BUCKETS = ['client-videos', 'inbody-printouts', 'message-media'] as const;
export type ClientStorageBucket = (typeof CLIENT_STORAGE_BUCKETS)[number];

export type DeletionJobStatus =
  | 'pending'
  | 'auth_disabled'
  | 'db_deleted'
  | 'auth_deleted'
  | 'completed';

export interface StorageManifestEntry {
  bucket: ClientStorageBucket;
  paths: string[];
}

export interface ClientDeletionJob {
  clientId: string;
  coachId: string;
  clientName: string;
  isTestClient: boolean;
  status: DeletionJobStatus;
  linkedAuthUserIds: string[];
  storageManifest: StorageManifestEntry[];
  attempts: number;
  lastError?: string | null;
}

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
  clientRowExists: (clientId: string) => Promise<{ exists: boolean; error: unknown }>;
  getLinkedProfiles: (clientId: string) => Promise<{ data: LinkedProfileRow[]; error: unknown }>;
  listClientStoragePaths: (
    bucket: ClientStorageBucket,
    clientId: string
  ) => Promise<{ paths: string[]; error: unknown }>;
  acquireDeletionLease: (clientId: string, coachId: string, leaseId: string) => Promise<{ outcome: 'acquired' | 'busy' | 'forbidden' | null; error: unknown }>;
  releaseDeletionLease: (clientId: string, leaseId: string) => Promise<unknown>;
  getDeletionJob: (clientId: string) => Promise<{ data: ClientDeletionJob | null; error: unknown }>;
  createDeletionJob: (input: {
    clientId: string;
    coachId: string;
    clientName: string;
    isTestClient: boolean;
    linkedAuthUserIds: string[];
    storageManifest: StorageManifestEntry[];
  }) => Promise<{ data: ClientDeletionJob | null; error: unknown }>;
  updateDeletionJob: (
    clientId: string,
    patch: {
      status: DeletionJobStatus;
      lastError?: string | null;
      incrementAttempts?: boolean;
    }
  ) => Promise<{ data: ClientDeletionJob | null; error: unknown }>;
  /** Reversible lock/unlock of a client Auth account before DB deletion. */
  setAuthUserBanned: (uid: string, banned: boolean) => Promise<{ error: unknown }>;
  deleteOwnedClientRow: (
    token: string,
    clientId: string
  ) => Promise<{ deleted: boolean; error: unknown }>;
  /** Permanent Auth deletion — invoked ONLY after the client DB row is deleted. */
  deleteAuthUser: (uid: string) => Promise<{ error: unknown }>;
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

function countManifestFiles(manifest: StorageManifestEntry[]): number {
  return manifest.reduce((sum, entry) => sum + entry.paths.length, 0);
}

function confirmNameMatches(expectedName: string, providedName: unknown): boolean {
  const expected = expectedName.trim().toLowerCase();
  const provided = String(providedName ?? '').trim().toLowerCase();
  return expected.length > 0 && provided === expected;
}

/**
 * Staged, trackable, idempotent permanent client deletion:
 *   Preflight (auth + ownership + confirmation + coach-link protection + storage manifest)
 *   -> Persist durable job (`pending`)
 *   -> Stage 1: Reversible Auth lockout (`auth_disabled`)
 *   -> Stage 2: Atomic DB cascade delete via caller JWT (`db_deleted`), with automatic
 *               Auth unlock rollback if DB deletion fails
 *   -> Stage 3: Permanent Auth account deletion (`auth_deleted`) — NEVER before DB delete
 *   -> Stage 4: Stored media cleanup (`completed`)
 *
 * Every failure leaves durable job metadata intact so retrying resumes safely from the
 * exact unfinished stage, and retrying a completed deletion returns 200 idempotently.
 */
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

  const leaseId = crypto.randomUUID();
  const lease = await deps.acquireDeletionLease(clientId, uid, leaseId);
  if (lease.error || !lease.outcome) {
    return json(503, { error: 'Safe deletion tracking is unavailable. No data was deleted.', retryable: true });
  }
  if (lease.outcome === 'forbidden') {
    return json(403, { error: 'Only the owning coach may delete this client.' });
  }
  if (lease.outcome !== 'acquired') {
    return json(409, { error: 'A deletion is already in progress. Retry after it finishes.', retryable: true });
  }

  try {
    return await runDeletion(clientId, uid, token, body.confirmName, deps);
  } finally {
    // A lost release response must not turn a confirmed deletion into a failure.
    // The database lease expires if the worker is interrupted.
    await deps.releaseDeletionLease(clientId, leaseId).catch(() => {});
  }
}

async function runDeletion(
  clientId: string, uid: string, token: string, confirmName: unknown, deps: DeleteClientDeps
): Promise<Response> {
  // Check durable deletion tracking first (fail closed if tracking store is unavailable).
  const existingJobRes = await deps.getDeletionJob(clientId);
  if (existingJobRes.error) {
    return json(503, {
      error: 'Safe deletion tracking is not ready yet. No data was deleted; use Archive instead.',
      retryable: false
    });
  }

  let job = existingJobRes.data;

  if (job) {
    // Ownership & confirmation checks are enforced on every retry as well.
    if (job.coachId !== uid) {
      return json(403, { error: 'Only the owning coach may delete this client.' });
    }
    if (!job.isTestClient && !confirmNameMatches(job.clientName, confirmName)) {
      return json(400, { error: 'Type the client’s full name to confirm permanent deletion.' });
    }
    if (job.status === 'completed') {
      return json(200, {
        ok: true,
        status: 'completed',
        alreadyCompleted: true,
        deletedClientId: job.clientId,
        deletedAuthUsers: job.linkedAuthUserIds.length,
        deletedFiles: countManifestFiles(job.storageManifest)
      });
    }
    const bumped = await deps.updateDeletionJob(job.clientId, {
      status: job.status,
      lastError: job.lastError ?? null,
      incrementAttempts: true
    });
    if (bumped.error || !bumped.data) {
      return json(503, {
        error: 'Could not update deletion tracking state. Please retry.',
        stage: job.status,
        retryable: true
      });
    }
    job = bumped.data;
  } else {
    // Fresh deletion: verify ownership through caller's JWT (RLS) before any preflight.
    const client = await deps.getOwnedClient(token, clientId);
    if (!client || client.coach_id !== uid) {
      return json(403, { error: 'Only the owning coach may delete this client.' });
    }

    const isTestClient = Boolean(client.data?.isTestClient);
    const storedName = String(client.data?.name ?? '').trim();
    if (!isTestClient && !confirmNameMatches(storedName, confirmName)) {
      return json(400, { error: 'Type the client’s full name to confirm permanent deletion.' });
    }

    // Preflight 1: resolve linked Auth accounts and refuse if any coach account is linked.
    const linked = await deps.getLinkedProfiles(client.id);
    if (linked.error) {
      return json(503, {
        error: 'Could not verify linked client accounts. No data was deleted.',
        stage: 'preflight',
        retryable: true
      });
    }
    const linkedProfiles = linked.data ?? [];
    if (linkedProfiles.some((p) => p.role !== 'client' || p.id === uid)) {
      return json(409, { error: 'Refused: this client record is linked to a coach account.' });
    }

    // Preflight 2: snapshot storage manifest before any mutation.
    const storageManifest: StorageManifestEntry[] = [];
    for (const bucket of CLIENT_STORAGE_BUCKETS) {
      const listed = await deps.listClientStoragePaths(bucket, client.id);
      if (listed.error) {
        return json(503, {
          error: 'Could not verify client media files. No data was deleted.',
          stage: 'preflight',
          retryable: true
        });
      }
      if (listed.paths.length > 0) {
        storageManifest.push({ bucket, paths: listed.paths });
      }
    }

    const uniqueAuthIds = [...new Set(linkedProfiles.map((p) => p.id))];
    const created = await deps.createDeletionJob({
      clientId: client.id,
      coachId: uid,
      clientName: storedName || client.id,
      isTestClient,
      linkedAuthUserIds: uniqueAuthIds,
      storageManifest
    });
    if (created.error || !created.data) {
      return json(503, {
        error: 'Could not start a trackable deletion job. No data was deleted.',
        stage: 'preflight',
        retryable: true
      });
    }
    job = created.data;
    if (job.coachId !== uid) {
      return json(403, { error: 'Only the owning coach may delete this client.' });
    }
    if (!job.isTestClient && !confirmNameMatches(job.clientName, confirmName)) {
      return json(400, { error: 'Type the client’s full name to confirm permanent deletion.' });
    }
  }

  // Stage 1: Reversible Auth lockout (prevents concurrent client writes without destroying Auth yet).
  if (job.status === 'pending') {
    const lockedIds: string[] = [];
    for (const authUserId of job.linkedAuthUserIds) {
      const locked = await deps.setAuthUserBanned(authUserId, true);
      if (locked.error) {
        // Roll back any locks acquired earlier in this loop.
        for (const prevId of lockedIds) {
          await deps.setAuthUserBanned(prevId, false).catch(() => {});
        }
        await deps.updateDeletionJob(job.clientId, {
          status: 'pending',
          lastError: 'auth_disable_failed'
        });
        return json(503, {
          error: 'Could not temporarily pause the client sign-in account. No data was deleted; you can retry safely.',
          stage: 'auth_disable',
          retryable: true
        });
      }
      lockedIds.push(authUserId);
    }

    const advanced = await deps.updateDeletionJob(job.clientId, {
      status: 'auth_disabled',
      lastError: null
    });
    if (advanced.error || !advanced.data) {
      for (const prevId of lockedIds) {
        await deps.setAuthUserBanned(prevId, false).catch(() => {});
      }
      return json(503, {
        error: 'Could not record deletion progress before removing data. No data was deleted; retry safely.',
        stage: 'auth_disable',
        retryable: true
      });
    }
    job = advanced.data;
  }

  // Stage 2: Atomic DB cascade delete via caller's JWT (RLS-enforced).
  // Auth is NOT permanently deleted yet; if DB deletion fails, Auth lock is reversed.
  if (job.status === 'auth_disabled') {
    const deletedRow = await deps.deleteOwnedClientRow(token, job.clientId);
    let dbGone = !deletedRow.error && deletedRow.deleted;

    if (!dbGone) {
      // Handle crash recovery: a prior attempt may have deleted the DB row before persisting db_deleted.
      const existsCheck = await deps.clientRowExists(job.clientId);
      if (!existsCheck.error && !existsCheck.exists) {
        dbGone = true;
      }
    }

    if (!dbGone) {
      let allRestored = true;
      for (const authUserId of job.linkedAuthUserIds) {
        const restored = await deps.setAuthUserBanned(authUserId, false);
        if (restored.error) allRestored = false;
      }
      await deps.updateDeletionJob(job.clientId, {
        status: allRestored ? 'pending' : 'auth_disabled',
        lastError: 'db_delete_failed'
      });
      return json(503, {
        error: allRestored
          ? 'Could not delete the client record from the database. The client account was restored and nothing was permanently deleted. You can retry safely.'
          : 'Could not delete the client record from the database. Retry to safely resume or restore.',
        stage: 'db_delete',
        retryable: true,
        authRestored: allRestored
      });
    }

    const advanced = await deps.updateDeletionJob(job.clientId, {
      status: 'db_deleted',
      lastError: null
    });
    if (advanced.error || !advanced.data) {
      return json(503, {
        error: 'Client data was deleted, but progress could not be recorded. Retry to complete Auth and file cleanup.',
        stage: 'db_delete',
        retryable: true
      });
    }
    job = advanced.data;
  }

  // Stage 3: Permanent Auth deletion — strictly AFTER DB deletion succeeded.
  if (job.status === 'db_deleted') {
    for (const authUserId of job.linkedAuthUserIds) {
      const deletedAuth = await deps.deleteAuthUser(authUserId);
      if (deletedAuth.error) {
        await deps.updateDeletionJob(job.clientId, {
          status: 'db_deleted',
          lastError: 'auth_delete_failed'
        });
        return json(503, {
          error: 'Client records were removed and sign-in is locked, but deleting the sign-in account failed. Retry to finish cleanup safely.',
          stage: 'auth_delete',
          retryable: true
        });
      }
    }

    const advanced = await deps.updateDeletionJob(job.clientId, {
      status: 'auth_deleted',
      lastError: null
    });
    if (advanced.error || !advanced.data) {
      return json(503, {
        error: 'Client account was removed, but progress could not be recorded. Retry to finish media cleanup.',
        stage: 'auth_delete',
        retryable: true
      });
    }
    job = advanced.data;
  }

  // Stage 4: Idempotent storage media cleanup.
  if (job.status === 'auth_deleted') {
    // Re-list after Auth and DB deletion: catch files added since the initial snapshot.
    // Never report success when inventory cannot be verified.
    const cleanup = new Map<ClientStorageBucket, Set<string>>();
    for (const entry of job.storageManifest) {
      cleanup.set(entry.bucket, new Set(entry.paths));
    }
    for (const bucket of CLIENT_STORAGE_BUCKETS) {
      const listed = await deps.listClientStoragePaths(bucket, job.clientId);
      if (listed.error) {
        return json(503, { error: 'Could not verify remaining client media. Retry cleanup.', stage: 'storage_cleanup', retryable: true });
      }
      const paths = cleanup.get(bucket) ?? new Set<string>();
      for (const path of listed.paths) paths.add(path);
      cleanup.set(bucket, paths);
    }
    for (const [bucket, paths] of cleanup) {
      const entry = { bucket, paths: [...paths] };
      if (entry.paths.length === 0) continue;
      const removed = await deps.removeStoragePaths(entry.bucket, entry.paths);
      if (removed.error) {
        await deps.updateDeletionJob(job.clientId, {
          status: 'auth_deleted',
          lastError: `storage_cleanup_failed:${entry.bucket}`
        });
        return json(503, {
          error: 'Client records and account were removed, but media file cleanup did not finish. Retry to complete cleanup.',
          stage: 'storage_cleanup',
          retryable: true
        });
      }
    }

    const completed = await deps.updateDeletionJob(job.clientId, {
      status: 'completed',
      lastError: null
    });
    if (completed.error || !completed.data) {
      return json(503, {
        error: 'Cleanup succeeded, but finalizing the deletion record failed. Retry to confirm completion.',
        stage: 'storage_cleanup',
        retryable: true
      });
    }
    job = completed.data;
  }

  if (job.status !== 'completed') {
    return json(503, { error: 'Deletion completion could not be verified. Retry safely.', retryable: true });
  }
  return json(200, {
    ok: true,
    status: 'completed',
    deletedClientId: job.clientId,
    deletedAuthUsers: job.linkedAuthUserIds.length,
    deletedFiles: countManifestFiles(job.storageManifest)
  });
}
