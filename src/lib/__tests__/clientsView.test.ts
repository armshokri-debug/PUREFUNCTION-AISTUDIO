import { describe, expect, it } from 'vitest';
import { getClientStatus } from '../../components/coach/ClientsView';
import {
  createClientProfile,
  duplicateClientEmailMessage,
  evaluateClientAttention,
  findDuplicateClientByEmail,
  getClientSnapshotStats
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

describe('Needs Attention evaluation (real assessment & workout signals)', () => {
  const today = '2026-11-22';

  it('returns null for archived clients or clients who are fully on track', () => {
    const onTrack = makeClient({
      nextAssessmentDays: 14,
      adherenceCompleted: 3,
      adherenceTotal: 4,
      workouts: [
        {
          id: 'w1',
          date: '2026-11-20',
          title: 'Strength A',
          focus: 'Lower',
          status: 'completed',
          blocks: []
        },
        {
          id: 'w2',
          date: '2026-11-23',
          title: 'Strength B',
          focus: 'Upper',
          status: 'planned',
          blocks: []
        }
      ]
    });
    expect(evaluateClientAttention(onTrack, today)).toBeNull();

    const archived = makeClient({ archived: true, nextAssessmentDays: 0 });
    expect(evaluateClientAttention(archived, today)).toBeNull();
  });

  it('prioritizes urgent pain reports and missed workouts ahead of assessment warnings', () => {
    const client = makeClient({
      nextAssessmentDays: 3,
      adherenceCompleted: 1,
      adherenceTotal: 4,
      workouts: [
        {
          id: 'w1',
          date: '2026-11-19',
          title: 'Lower A',
          focus: 'Lower',
          status: 'completed',
          blocks: [
            {
              id: 'b1',
              exerciseId: 'ex-1',
              name: 'Goblet Squat',
              sets: 3,
              reps: '8',
              loadKg: 20,
              restSec: 90,
              notes: '',
              loggedSets: [],
              pain: true
            }
          ]
        },
        {
          id: 'w2',
          date: '2026-11-20',
          title: 'Upper A',
          focus: 'Upper',
          status: 'missed',
          blocks: []
        }
      ]
    });

    const summary = evaluateClientAttention(client, today);
    expect(summary).not.toBeNull();
    expect(summary?.severity).toBe('urgent');
    expect(summary?.primarySection).toBe('exercises');
    expect(summary?.reasons.map((r) => r.code)).toEqual([
      'pain_reported',
      'missed_workouts',
      'assessment_due',
      'low_adherence'
    ]);
    expect(summary?.reasons[0].label).toContain('Goblet Squat');
  });

  it('flags brand-new clients with no assessments or scheduled workouts accurately', () => {
    const fresh = makeClient();
    const summary = evaluateClientAttention(fresh, today);
    expect(summary?.severity).toBe('warning');
    expect(summary?.reasons.map((r) => r.code)).toEqual(['assessment_missing', 'no_workouts']);
  });
});

describe('Client profile snapshot stats', () => {
  it('extracts real counts and avoids fabricating missing values', () => {
    const empty = makeClient();
    expect(getClientSnapshotStats(empty)).toEqual({
      completedWorkouts: 0,
      totalWorkouts: 0,
      lastCompletedWorkoutDate: null,
      completedAssessments: 0,
      lastAssessmentDate: null,
      goalsCount: 0,
      notesCount: 0,
      progressPointsCount: 0,
      nutritionCalories: null,
      nutritionProtein: null,
      weightKg: null,
      bodyFatPercent: null
    });

    const populated = makeClient({
      inBody: { ...empty.inBody, weight: 78, bodyFatPercent: 16.5 },
      nutrition: { calories: 2450, protein: 175 },
      coachNotes: [{ id: 'n1', date: '2026-11-20', text: 'Good hip control' }],
      workouts: [
        {
          id: 'w1',
          date: '2026-11-18',
          title: 'Day 1',
          focus: 'Lower',
          status: 'completed',
          blocks: []
        },
        {
          id: 'w2',
          date: '2026-11-21',
          title: 'Day 2',
          focus: 'Upper',
          status: 'completed',
          blocks: []
        }
      ]
    });
    const stats = getClientSnapshotStats(populated);
    expect(stats.completedWorkouts).toBe(2);
    expect(stats.lastCompletedWorkoutDate).toBe('2026-11-21');
    expect(stats.weightKg).toBe(78);
    expect(stats.bodyFatPercent).toBe(16.5);
    expect(stats.nutritionCalories).toBe(2450);
    expect(stats.nutritionProtein).toBe(175);
    expect(stats.notesCount).toBe(1);
  });
});
