import { describe, expect, it } from 'vitest';
import { getClientStatus } from '../../components/coach/ClientsView';
import {
  createClientProfile,
  duplicateClientEmailMessage,
  findDuplicateClientByEmail
} from '../clients';

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

describe('Duplicate client email detection (Gmail & Googlemail)', () => {
  it('blocks googlemail.com when gmail.com already exists and vice versa', () => {
    const gmailClient = makeClient({ id: 'c1', email: 'alex.smith@gmail.com' });
    const googlemailClient = makeClient({ id: 'c2', email: 'sam@googlemail.com' });

    const hit1 = findDuplicateClientByEmail([gmailClient], '  ALEX.SMITH@googlemail.com ');
    expect(hit1?.id).toBe('c1');
    expect(duplicateClientEmailMessage('alex.smith@googlemail.com', hit1?.email)).toContain('Gmail/Googlemail');

    const hit2 = findDuplicateClientByEmail([googlemailClient], 'sam@gmail.com');
    expect(hit2?.id).toBe('c2');
    expect(duplicateClientEmailMessage('sam@gmail.com', hit2?.email)).toContain('Gmail/Googlemail');
  });

  it('preserves dots, plus-tags, and non-Google domains', () => {
    const clients = [
      makeClient({ id: 'c1', email: 'alex.smith@gmail.com' }),
      makeClient({ id: 'c2', email: 'alex@example.com' })
    ];

    expect(findDuplicateClientByEmail(clients, 'alexsmith@gmail.com')).toBeUndefined();
    expect(findDuplicateClientByEmail(clients, 'alex.smith+2@gmail.com')).toBeUndefined();
    expect(findDuplicateClientByEmail(clients, 'alex@example.org')).toBeUndefined();
    expect(findDuplicateClientByEmail(clients, 'alex@example.com')?.id).toBe('c2');
  });

  it('excludes the client currently being edited', () => {
    const client = makeClient({ id: 'c1', email: 'alex@gmail.com' });
    expect(findDuplicateClientByEmail([client], 'alex@googlemail.com', 'c1')).toBeUndefined();
  });
});
