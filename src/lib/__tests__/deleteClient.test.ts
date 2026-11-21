import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_STORAGE_BUCKETS,
  handleDeleteClient,
  type DeleteClientDeps,
  type DeleteClientRow
} from '../../../supabase/functions/delete-client/handler';

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

function makeDeps(overrides: Partial<DeleteClientDeps> = {}) {
  const client: DeleteClientRow = {
    id: 'client-1',
    email: 'alex@example.invalid',
    coach_id: 'coach-1',
    data: { name: 'Alex Morgan' }
  };

  const deps: DeleteClientDeps = {
    getUserByToken: vi.fn(async (token) => (token === 'coach-jwt' ? { id: 'coach-1' } : null)),
    getCoachProfile: vi.fn(async (uid) => (uid === 'coach-1' ? { role: 'coach' } : null)),
    getOwnedClient: vi.fn(async (_token, id) => (id === 'client-1' ? client : null)),
    getLinkedProfiles: vi.fn(async () => ({
      data: [{ id: 'auth-client-1', role: 'client' }],
      error: null
    })),
    listClientStoragePaths: vi.fn(async (bucket, clientId) => ({
      paths: bucket === 'client-videos' ? [`${clientId}/clip.mp4`] : [],
      error: null
    })),
    deleteAuthUser: vi.fn(async () => ({ error: null })),
    deleteOwnedClientRow: vi.fn(async () => ({ deleted: true, error: null })),
    removeStoragePaths: vi.fn(async () => ({ error: null })),
    ...overrides
  };

  return { deps, client };
}

describe('handleDeleteClient security and cleanup', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { deps } = makeDeps();
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }),
      deps
    );
    expect(res.status).toBe(401);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('rejects non-coach callers with 403', async () => {
    const { deps } = makeDeps({
      getCoachProfile: vi.fn(async () => ({ role: 'client' }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(403);
    expect(deps.getOwnedClient).not.toHaveBeenCalled();
  });

  it('rejects another coach who does not own the client (403)', async () => {
    const { deps } = makeDeps({
      getOwnedClient: vi.fn(async () => ({
        id: 'client-1',
        email: 'alex@example.invalid',
        coach_id: 'other-coach',
        data: { name: 'Alex Morgan' }
      }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(403);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('rejects invalid/path-traversal client IDs and missing confirmation (400)', async () => {
    const { deps } = makeDeps();

    const traversal = await handleDeleteClient(
      postDelete({ clientId: '../other', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(traversal.status).toBe(400);

    const noConfirm = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: false, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(noConfirm.status).toBe(400);

    const wrongName = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Wrong Name' }, 'coach-jwt'),
      deps
    );
    expect(wrongName.status).toBe(400);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('refuses deletion if any linked profile belongs to a coach account (409)', async () => {
    const { deps } = makeDeps({
      getLinkedProfiles: vi.fn(async () => ({
        data: [{ id: 'coach-2', role: 'coach' }],
        error: null
      }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(409);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('fails closed without mutating anything when storage preflight listing fails', async () => {
    const { deps } = makeDeps({
      listClientStoragePaths: vi.fn(async () => ({ paths: [], error: { message: 'storage down' } }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(503);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
  });

  it('does not delete the client DB row if deleting the linked Auth account fails', async () => {
    const { deps } = makeDeps({
      deleteAuthUser: vi.fn(async () => ({ error: { message: 'auth error' } }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(503);
    expect(deps.deleteOwnedClientRow).not.toHaveBeenCalled();
    expect(deps.removeStoragePaths).not.toHaveBeenCalled();
  });

  it('never reports silent success if media cleanup fails after DB deletion', async () => {
    const { deps } = makeDeps({
      removeStoragePaths: vi.fn(async () => ({ error: { message: 'storage delete failed' } }))
    });
    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: 'Alex Morgan' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { partialCleanup?: boolean };
    expect(body.partialCleanup).toBe(true);
  });

  it('deletes linked Auth account, owned client row via caller JWT, and client storage files in order', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      deleteAuthUser: vi.fn(async (uid) => {
        order.push(`auth:${uid}`);
        return { error: null };
      }),
      deleteOwnedClientRow: vi.fn(async (_token, id) => {
        order.push(`db:${id}`);
        return { deleted: true, error: null };
      }),
      removeStoragePaths: vi.fn(async (bucket, paths) => {
        order.push(`storage:${bucket}:${paths.join(',')}`);
        return { error: null };
      })
    });

    const res = await handleDeleteClient(
      postDelete({ clientId: 'client-1', confirm: true, confirmName: '  alex morgan  ' }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deletedClientId: string;
      deletedAuthUsers: number;
      deletedFiles: number;
    };
    expect(body).toEqual({
      ok: true,
      deletedClientId: 'client-1',
      deletedAuthUsers: 1,
      deletedFiles: 1
    });
    expect(order).toEqual([
      'auth:auth-client-1',
      'db:client-1',
      'storage:client-videos:client-1/clip.mp4'
    ]);
    expect(deps.listClientStoragePaths).toHaveBeenCalledTimes(CLIENT_STORAGE_BUCKETS.length);
  });

  it('allows confirmed deletion of a test client without typing its full name', async () => {
    const { deps } = makeDeps({
      getOwnedClient: vi.fn(async () => ({
        id: 'test-1',
        email: 'test@example.invalid',
        coach_id: 'coach-1',
        data: { name: 'TEST CLIENT — Sample', isTestClient: true }
      })),
      getLinkedProfiles: vi.fn(async () => ({ data: [], error: null })),
      listClientStoragePaths: vi.fn(async () => ({ paths: [], error: null }))
    });

    const res = await handleDeleteClient(
      postDelete({ clientId: 'test-1', confirm: true }, 'coach-jwt'),
      deps
    );
    expect(res.status).toBe(200);
    expect(deps.deleteOwnedClientRow).toHaveBeenCalledWith('coach-jwt', 'test-1');
  });
});
