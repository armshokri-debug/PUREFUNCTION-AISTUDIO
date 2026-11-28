import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_STORAGE_BUCKETS,
  handleDeleteClient,
  type ClientDeletionJob,
  type DeleteClientDeps,
  type DeleteClientRow
} from '../../../supabase/functions/delete-client/handler';
import { canPermanentlyDeleteClient } from '../clients';

vi.mock('../../cloud/supabase', () => ({
  supabaseUrl: 'https://synthetic.supabase.invalid',
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'synthetic-coach-jwt' } }
      }))
    }
  }
}));

import { deleteClientRemote } from '../../cloud/deleteClient';

function postDelete(body: unknown, token?: string): Request {
  return new Request('https://example.supabase.co/functions/v1/delete-client', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function createSyntheticHarness(overrides: Partial<DeleteClientDeps> = {}) {
  const client: DeleteClientRow = {
    id: 'client-1',
    email: 'alex@example.invalid',
    coach_id: 'coach-1',
    data: { name: 'Alex Morgan' }
  };

  const state = {
    clientExists: true,
    authUsers: new Map<string, { banned: boolean; deleted: boolean }>([
      ['auth-client-1', { banned: false, deleted: false }]
    ]),
    storage: new Map<string, Set<string>>([
      ['client-videos', new Set(['client-1/clip.mp4'])],
      ['inbody-printouts', new Set(['client-1/scan.pdf'])],
      ['message-media', new Set()]
    ]),
    jobs: new Map<string, ClientDeletionJob>(),
    events: [] as string[]
  };

  const deps: DeleteClientDeps = {
    getUserByToken: vi.fn(async (token) => {
      if (token === 'coach-jwt') return { id: 'coach-1' };
      if (token === 'other-coach-jwt') return { id: 'coach-2' };
      return null;
    }),
    getCoachProfile: vi.fn(async (uid) =>
      uid === 'coach-1' || uid === 'coach-2' ? { role: 'coach' } : null
    ),
    getOwnedClient: vi.fn(async (token, id) => {
      if (!state.clientExists || id !== client.id) return null;
      return token === 'coach-jwt' ? client : null;
    }),
    clientRowExists: vi.fn(async (id) => ({
      exists: state.clientExists && id === client.id,
      error: null
    })),
    getLinkedProfiles: vi.fn(async () => ({
      data: [...state.authUsers.entries()]
        .filter(([, u]) => !u.deleted)
        .map(([id]) => ({ id, role: 'client' })),
      error: null
    })),
    listClientStoragePaths: vi.fn(async (bucket, clientId) => ({
      paths: [...(state.storage.get(bucket) ?? [])].filter((p) => p.startsWith(`${clientId}/`)),
      error: null
    })),
    acquireDeletionLease: vi.fn(async () => ({ outcome: 'acquired' as const, error: null })),
    releaseDeletionLease: vi.fn(async () => ({})),
    getDeletionJob: vi.fn(async (clientId) => ({
      data: state.jobs.get(clientId) ? structuredClone(state.jobs.get(clientId)!) : null,
      error: null
    })),
    createDeletionJob: vi.fn(async (input) => {
      const created: ClientDeletionJob = {
        clientId: input.clientId,
        coachId: input.coachId,
        clientName: input.clientName,
        isTestClient: input.isTestClient,
        status: 'pending',
        linkedAuthUserIds: [...input.linkedAuthUserIds],
        storageManifest: structuredClone(input.storageManifest),
        attempts: 1,
        lastError: null
      };
      state.jobs.set(input.clientId, created);
      state.events.push(`job:create:${input.clientId}`);
      return { data: structuredClone(created), error: null };
    }),
    updateDeletionJob: vi.fn(async (clientId, patch) => {
      const cur = state.jobs.get(clientId);
      if (!cur) return { data: null, error: { message: 'missing job' } };
      cur.status = patch.status;
      cur.lastError = patch.lastError ?? null;
      if (patch.incrementAttempts) cur.attempts += 1;
      state.events.push(`job:status:${patch.status}`);
      return { data: structuredClone(cur), error: null };
    }),
    setAuthUserBanned: vi.fn(async (uid, banned) => {
      const user = state.authUsers.get(uid);
      if (user) user.banned = banned;
      state.events.push(`auth:${banned ? 'lock' : 'unlock'}:${uid}`);
      return { error: null };
    }),
    deleteOwnedClientRow: vi.fn(async (token, id) => {
      if (token !== 'coach-jwt' || !state.clientExists || id !== client.id) {
        return { deleted: false, error: null };
      }
      state.clientExists = false;
      state.events.push(`db:delete:${id}`);
      return { deleted: true, error: null };
    }),
    deleteAuthUser: vi.fn(async (uid) => {
      const user = state.authUsers.get(uid);
      if (user) user.deleted = true;
      state.events.push(`auth:delete:${uid}`);
      return { error: null };
    }),
    removeStoragePaths: vi.fn(async (bucket, paths: string[]) => {
      const set = state.storage.get(bucket);
      if (set) paths.forEach((p: string) => set.delete(p));
      state.events.push(`storage:delete:${bucket}:${paths.join(',')}`);
      return { error: null };
    }),
    ...overrides
  };

  return { deps, state, client };
}

describe('Staged, trackable, idempotent handleDeleteClient', () => {
  it('fails closed while another request holds the deletion lease', async () => {
    const { deps, state } = createSyntheticHarness({
      acquireDeletionLease: vi.fn(async () => ({ outcome: 'busy' as const, error: null }))
    });
    const res = await handleDeleteClient(postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'), deps);
    expect(res.status).toBe(409);
    expect(state.clientExists).toBe(true);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.releaseDeletionLease).not.toHaveBeenCalled();
  });

  it('releases its lease on an interrupted deletion and never reports success', async () => {
    const { deps } = createSyntheticHarness({
      getDeletionJob: vi.fn(async () => ({ data: null, error: { message: 'unavailable' } }))
    });
    const res = await handleDeleteClient(postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'), deps);
    expect(res.status).toBe(503);
    expect(deps.releaseDeletionLease).toHaveBeenCalledTimes(1);
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('removes media added after the initial inventory', async () => {
    const { deps, state } = createSyntheticHarness();
    const base = deps.deleteOwnedClientRow;
    deps.deleteOwnedClientRow = vi.fn(async (token, id, coachId, leaseId) => {
      const result = await base(token, id, coachId, leaseId);
      state.storage.get('client-videos')!.add('client-1/late.mp4');
      return result;
    });
    const res = await handleDeleteClient(postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'), deps);
    expect(res.status).toBe(200);
    expect(state.storage.get('client-videos')!.size).toBe(0);
  });

  it('deletes in strict safe order: reversible Auth lock -> DB delete -> Auth delete -> Storage cleanup', async () => {
    const { deps, state } = createSyntheticHarness();
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: '  alex morgan  ' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      deletedClientId: string;
      deletedAuthUsers: number;
      deletedFiles: number;
    };
    expect(body).toEqual({
      ok: true,
      status: 'completed',
      deletedClientId: 'client-1',
      deletedAuthUsers: 1,
      deletedFiles: 2
    });

    // Critical invariant: DB deletion happens STRICTLY BEFORE permanent Auth deletion.
    const lockIdx = state.events.indexOf('auth:lock:auth-client-1');
    const dbIdx = state.events.indexOf('db:delete:client-1');
    const authDelIdx = state.events.indexOf('auth:delete:auth-client-1');
    const storageIdx = state.events.indexOf('storage:delete:client-videos:client-1/clip.mp4');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(lockIdx);
    expect(authDelIdx).toBeGreaterThan(dbIdx);
    expect(storageIdx).toBeGreaterThan(authDelIdx);

    expect(state.clientExists).toBe(false);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(true);
    expect(state.storage.get('client-videos')?.size).toBe(0);
    expect(state.storage.get('inbody-printouts')?.size).toBe(0);
    expect(state.jobs.get('client-1')?.status).toBe('completed');
    expect(deps.listClientStoragePaths).toHaveBeenCalledTimes(CLIENT_STORAGE_BUCKETS.length * 2);
  });

  it('rolls back Auth lock and NEVER deletes Auth or Storage if DB deletion fails, then succeeds on retry', async () => {
    let failDb = true;
    const { deps, state } = createSyntheticHarness();
    const baseDeleteRow = deps.deleteOwnedClientRow;
    deps.deleteOwnedClientRow = vi.fn(async (token, id, coachId, leaseId) => {
      if (failDb) return { deleted: false, error: { message: 'db timeout' } };
      return baseDeleteRow(token, id, coachId, leaseId);
    });

    // Attempt 1: DB fails -> Auth MUST NOT be deleted and MUST be unlocked back to active.
    const first = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(first.status).toBe(503);
    const firstBody = (await first.json()) as { stage: string; retryable: boolean; authRestored: boolean };
    expect(firstBody.stage).toBe('db_delete');
    expect(firstBody.retryable).toBe(true);
    expect(firstBody.authRestored).toBe(true);
    expect(state.clientExists).toBe(true);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(false);
    expect(state.authUsers.get('auth-client-1')?.banned).toBe(false);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.removeStoragePaths).not.toHaveBeenCalled();
    expect(state.jobs.get('client-1')?.status).toBe('pending');

    // Attempt 2: DB recovers -> retry completes all stages cleanly.
    failDb = false;
    const second = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(second.status).toBe(200);
    expect(state.clientExists).toBe(false);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(true);
    expect(state.storage.get('client-videos')?.size).toBe(0);
    expect(state.jobs.get('client-1')?.status).toBe('completed');
    expect(state.jobs.get('client-1')?.attempts).toBe(2);
  });

  it('resumes cleanly from db_deleted if Auth permanent deletion fails, keeping Auth locked until retry succeeds', async () => {
    let failAuthDelete = true;
    const { deps, state } = createSyntheticHarness();
    const baseDeleteAuth = deps.deleteAuthUser;
    deps.deleteAuthUser = vi.fn(async (uid) => {
      if (failAuthDelete) return { error: { message: 'auth service 503' } };
      return baseDeleteAuth(uid);
    });

    // Attempt 1: DB deleted, Auth delete fails -> Auth stays locked, job preserves Auth ID & storage manifest.
    const first = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(first.status).toBe(503);
    const firstBody = (await first.json()) as { stage: string; retryable: boolean };
    expect(firstBody.stage).toBe('auth_delete');
    expect(firstBody.retryable).toBe(true);
    expect(state.clientExists).toBe(false);
    expect(state.authUsers.get('auth-client-1')?.banned).toBe(true);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(false);
    expect(state.jobs.get('client-1')?.status).toBe('db_deleted');
    expect(state.jobs.get('client-1')?.linkedAuthUserIds).toEqual(['auth-client-1']);

    // Attempt 2: Auth recovers -> resumes at Stage 3 without repeating DB delete or Auth lock.
    failAuthDelete = false;
    const second = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(second.status).toBe(200);
    expect(deps.deleteOwnedClientRow).toHaveBeenCalledTimes(1);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(true);
    expect(state.storage.get('client-videos')?.size).toBe(0);
    expect(state.jobs.get('client-1')?.status).toBe('completed');
  });

  it('resumes cleanly from auth_deleted if storage cleanup fails, then completes idempotently on retry', async () => {
    let failStorage = true;
    const { deps, state } = createSyntheticHarness();
    const baseRemove = deps.removeStoragePaths;
    deps.removeStoragePaths = vi.fn(async (bucket, paths) => {
      if (failStorage) return { error: { message: 'storage timeout' } };
      return baseRemove(bucket, paths);
    });

    const first = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(first.status).toBe(503);
    const firstBody = (await first.json()) as { stage: string; retryable: boolean };
    expect(firstBody.stage).toBe('storage_cleanup');
    expect(firstBody.retryable).toBe(true);
    expect(state.jobs.get('client-1')?.status).toBe('auth_deleted');

    // Retry finishes storage cleanup without repeating Auth or DB deletion.
    failStorage = false;
    const second = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(second.status).toBe(200);
    expect(deps.deleteOwnedClientRow).toHaveBeenCalledTimes(1);
    expect(deps.deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(state.storage.get('client-videos')?.size).toBe(0);
    expect(state.storage.get('inbody-printouts')?.size).toBe(0);

    // Network-disconnect replay after completion returns 200 idempotently with zero extra mutations.
    const replay = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { ok: boolean; status: string; alreadyCompleted: boolean };
    expect(replayBody.ok).toBe(true);
    expect(replayBody.status).toBe('completed');
    expect(replayBody.alreadyCompleted).toBe(true);
    expect(deps.deleteOwnedClientRow).toHaveBeenCalledTimes(1);
    expect(deps.deleteAuthUser).toHaveBeenCalledTimes(1);
  });

  it('recovers from a crash right after DB deletion before job status updated to db_deleted', async () => {
    const { deps, state } = createSyntheticHarness();
    // Simulate prior run crashed after deleting DB row while job was still recorded as auth_disabled.
    state.clientExists = false;
    state.authUsers.get('auth-client-1')!.banned = true;
    state.jobs.set('client-1', {
      clientId: 'client-1',
      coachId: 'coach-1',
      clientName: 'Alex Morgan',
      isTestClient: false,
      status: 'auth_disabled',
      linkedAuthUserIds: ['auth-client-1'],
      storageManifest: [{ bucket: 'client-videos', paths: ['client-1/clip.mp4'] }],
      attempts: 1,
      lastError: null
    });

    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(200);
    expect(state.authUsers.get('auth-client-1')?.deleted).toBe(true);
    expect(state.storage.get('client-videos')?.size).toBe(0);
    expect(state.jobs.get('client-1')?.status).toBe('completed');
  });

  it('enforces auth, coach role, ownership on both initial and retry attempts, and confirmation', async () => {
    const { deps, state } = createSyntheticHarness();

    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }),
          deps
        )
      ).status
    ).toBe(401);

    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'other-coach-jwt'),
          deps
        )
      ).status
    ).toBe(403);

    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: '../other', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
          deps
        )
      ).status
    ).toBe(400);

    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: 'client-1', confirm: false, confirmName: 'Alex Morgan' }, 'coach-jwt'),
          deps
        )
      ).status
    ).toBe(400);

    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Wrong Name' }, 'coach-jwt'),
          deps
        )
      ).status
    ).toBe(400);

    // Even when a job already exists in progress, a different coach is strictly refused (403).
    state.jobs.set('client-1', {
      clientId: 'client-1',
      coachId: 'coach-1',
      clientName: 'Alex Morgan',
      isTestClient: false,
      status: 'db_deleted',
      linkedAuthUserIds: ['auth-client-1'],
      storageManifest: [],
      attempts: 1
    });
    expect(
      (
        await handleDeleteClient(
          postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'other-coach-jwt'),
          deps
        )
      ).status
    ).toBe(403);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it('rolls back earlier Auth locks if locking a second linked Auth account fails (0 deletions)', async () => {
    const { deps, state } = createSyntheticHarness();
    state.authUsers.set('auth-client-2', { banned: false, deleted: false });
    const baseBan = deps.setAuthUserBanned;
    deps.setAuthUserBanned = vi.fn(async (uid, banned) => {
      if (uid === 'auth-client-2' && banned) return { error: { message: 'auth rate limit' } };
      return baseBan(uid, banned);
    });

    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(503);
    expect(state.authUsers.get('auth-client-1')?.banned).toBe(false);
    expect(state.clientExists).toBe(true);
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it('refuses deletion when a linked profile is a coach account (409) or tracking table is unavailable (503)', async () => {
    const coachLinked = createSyntheticHarness({
      getLinkedProfiles: vi.fn(async () => ({
        data: [{ id: 'coach-2', role: 'coach' }],
        error: null
      }))
    });
    const res409 = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      coachLinked.deps
    );
    expect(res409.status).toBe(409);
    expect(coachLinked.deps.setAuthUserBanned).not.toHaveBeenCalled();
    expect(coachLinked.deps.deleteOwnedClientRow).not.toHaveBeenCalled();
    expect(coachLinked.deps.deleteAuthUser).not.toHaveBeenCalled();

    const noTracking = createSyntheticHarness({
      getDeletionJob: vi.fn(async () => ({ data: null, error: { message: 'function pf_deletion_job_get does not exist' } }))
    });
    const res503 = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      noTracking.deps
    );
    expect(res503.status).toBe(503);
    expect(noTracking.deps.setAuthUserBanned).not.toHaveBeenCalled();
    expect(noTracking.deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });
});

describe('Permanent Delete safety gate (canPermanentlyDeleteClient)', () => {
  it('keeps Permanent Delete disabled by default in cloud mode until explicitly enabled', () => {
    expect(canPermanentlyDeleteClient({ isCloud: true })).toBe(false);
    expect(canPermanentlyDeleteClient({ isCloud: true, enableSafeDeleteFlag: 'false' })).toBe(false);
    expect(canPermanentlyDeleteClient({ isCloud: true, enableSafeDeleteFlag: 'true' })).toBe(true);
    expect(canPermanentlyDeleteClient({ isCloud: false })).toBe(true);
  });
});

describe('deleteClientRemote disconnect and retry handling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns retryable network failure on disconnect and completes cleanly on retry', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: 'Could not delete client records cleanly.',
            stage: 'db_delete',
            retryable: true,
            authRestored: true
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, status: 'completed', alreadyCompleted: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    globalThis.fetch = fetchMock;

    const disconnected = await deleteClientRemote({
      clientId: 'client-1',
      confirm: true,
      confirmName: 'Alex Morgan'
    });
    expect(disconnected).toMatchObject({
      ok: false,
      retryable: true,
      stage: 'network'
    });

    const transient503 = await deleteClientRemote({
      clientId: 'client-1',
      confirm: true,
      confirmName: 'Alex Morgan'
    });
    expect(transient503).toMatchObject({
      ok: false,
      retryable: true,
      stage: 'db_delete',
      authRestored: true
    });

    const retried = await deleteClientRemote({
      clientId: 'client-1',
      confirm: true,
      confirmName: 'Alex Morgan'
    });
    expect(retried).toEqual({
      ok: true,
      status: 'completed',
      alreadyCompleted: true
    });
  });

  it('returns non-retryable guidance when delete-client service is not deployed (404)', async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } })
    );

    const res = await deleteClientRemote({
      clientId: 'client-1',
      confirm: true,
      confirmName: 'Alex Morgan'
    });
    expect(res).toMatchObject({
      ok: false,
      retryable: false
    });
    if (!res.ok) {
      expect(res.error).toContain('Archive');
    }
  });
});
