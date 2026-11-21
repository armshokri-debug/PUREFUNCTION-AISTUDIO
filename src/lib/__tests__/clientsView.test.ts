import { describe, expect, it } from 'vitest';
import { getClientStatus } from '../../components/coach/ClientsView';
import { createClientProfile } from '../clients';

function makeClient(overrides: Partial<ReturnType<typeof createClientProfile>> = {}) {
  return {
    ...createClientProfile({
      name: 'Jordan Taylor',
      email: 'jordan@example.invalid',
      phaseNumber: 1,
      phaseName: 'Reposition'
    }),
    ...overrides
  };
}

describe('ClientsView status classification', () => {
  it('returns Active in demo mode when joinedIds is undefined', () => {
    const client = makeClient();
    expect(getClientStatus(client, undefined).label).toBe('Active');
  });

  it('distinguishes Pending, Invited, and Active in cloud mode', () => {
    const client = makeClient();
    expect(getClientStatus(client, new Set()).label).toBe('Pending');

    const invited = makeClient({ invitedAt: '2026-11-21T00:00:00.000Z' });
    expect(getClientStatus(invited, new Set()).label).toBe('Invited');

    expect(getClientStatus(invited, new Set([invited.id])).label).toBe('Active');
  });

  it('prioritizes Archived and Demo statuses clearly', () => {
    const archived = makeClient({ archived: true, invitedAt: '2026-11-21T00:00:00.000Z' });
    expect(getClientStatus(archived, new Set([archived.id])).label).toBe('Archived');

    const demo = makeClient({ isTestClient: true });
    expect(getClientStatus(demo, new Set()).label).toBe('Demo');
  });
});
