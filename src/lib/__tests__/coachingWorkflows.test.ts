import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientProfile } from '../clients';
import { blankWorkout, copyWeek, hasResults, upsertWorkout } from '../workouts';
import { applyProgramTemplate, createProgramTemplate, duplicateProgramTemplate } from '../programTemplates';

describe('Task 1: client invitation email error handling (mocked fetch/supabase)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('never reports success when Resend/Edge Function returns HTTP 403 or provider message errors', async () => {
    vi.doMock('../../cloud/supabase', () => ({
      supabaseUrl: 'https://example.supabase.co',
      supabase: {
        auth: {
          getSession: vi.fn(async () => ({
            data: { session: { access_token: 'tok-123' } }
          }))
        }
      }
    }));

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'Email works only to your own address until a domain is verified in Resend.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch;

    const { sendInviteEmail } = await import('../../cloud/email');
    const err = await sendInviteEmail('client-1');
    expect(err).toBe('Email works only to your own address until a domain is verified in Resend.');

    // Gateway-style message payload without `error` key
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Forbidden by mail provider' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
    ) as typeof fetch;
    expect(await sendInviteEmail('client-1')).toBe('Forbidden by mail provider');

    // HTTP 200 with ok: false should never silently succeed
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'Delivery rejected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    ) as typeof fetch;
    expect(await sendInviteEmail('client-1')).toBe('Delivery rejected');

    // Empty client id is rejected before hitting Edge Function
    expect(await sendInviteEmail('   ')).toBe('Save the client before sending an invite.');
  });

  it('returns null only when Edge Function succeeds with ok response', async () => {
    vi.doMock('../../cloud/supabase', () => ({
      supabaseUrl: 'https://example.supabase.co',
      supabase: {
        auth: {
          getSession: vi.fn(async () => ({
            data: { session: { access_token: 'tok-123' } }
          }))
        }
      }
    }));

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    ) as typeof fetch;

    const { sendInviteEmail } = await import('../../cloud/email');
    expect(await sendInviteEmail('client-1')).toBeNull();
  });
});

describe('Task 3: workout & template persistence safety and client result protection', () => {
  const mkClient = (name: string) =>
    createClientProfile({
      name,
      email: `${name.toLowerCase()}@example.invalid`,
      phaseNumber: 1,
      phaseName: 'Reposition'
    });

  it('protects workouts with partial logged reps, pain flags, or notes from template/week overwrites', () => {
    const templateSource = upsertWorkout(mkClient('Source'), {
      ...blankWorkout('2026-11-02'),
      title: 'Updated Monday Program'
    });
    const template = createProgramTemplate(templateSource, 'Safe Week', 'week', '2026-11-02');

    const partialWorkout = {
      ...blankWorkout('2026-11-09'),
      title: 'Client Partially Logged Day',
      status: 'planned' as const,
      blocks: [
        {
          id: 'blk-partial',
          exerciseId: 'ex-squat',
          name: 'Goblet Squat',
          sets: 3,
          reps: '8',
          loadKg: 25,
          restSec: 90,
          notes: '',
          loggedSets: [
            { setNumber: 1, kg: 25, reps: 8, completed: false },
            { setNumber: 2, kg: 25, reps: null, completed: false },
            { setNumber: 3, kg: 25, reps: null, completed: false }
          ]
        }
      ]
    };

    expect(hasResults(partialWorkout)).toBe(true);

    const client = upsertWorkout(mkClient('Athlete'), partialWorkout);
    const applied = applyProgramTemplate([client], template, [client.id], '2026-11-09');
    expect(applied.copied).toBe(0);
    expect(applied.skipped).toBe(1);
    expect(applied.clients[0].workouts?.[0].title).toBe('Client Partially Logged Day');
    expect(applied.clients[0].workouts?.[0].blocks[0].loggedSets[0].reps).toBe(8);

    const weekCopied = copyWeek(
      upsertWorkout(client, { ...blankWorkout('2026-11-02'), title: 'Prev Week' }),
      '2026-11-02',
      '2026-11-09'
    );
    expect(weekCopied.skipped).toBe(1);
    expect(weekCopied.copied).toBe(0);
  });

  it('keeps duplicated templates independent and free of client workout results', () => {
    const sourceClient = upsertWorkout(mkClient('Src'), {
      ...blankWorkout('2026-11-02'),
      title: 'Heavy Lower',
      status: 'completed',
      sessionRpe: 9,
      clientFeedback: 'Tough',
      blocks: [
        {
          id: 'b1',
          exerciseId: 'ex-rdl',
          name: 'Romanian Deadlift',
          sets: 3,
          reps: '6',
          loadKg: 80,
          restSec: 120,
          notes: 'Hinge cleanly',
          rpe: 9,
          pain: false,
          clientNote: 'Good stretch',
          loggedSets: [
            { setNumber: 1, kg: 80, reps: 6, completed: true },
            { setNumber: 2, kg: 80, reps: 6, completed: true },
            { setNumber: 3, kg: 80, reps: 6, completed: true }
          ]
        }
      ]
    });

    const original = createProgramTemplate(sourceClient, 'Lower Base', 'week', '2026-11-02');
    const copy = duplicateProgramTemplate(original, 'Lower Base v2');

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Lower Base v2');
    expect(copy.days[0].workout.id).not.toBe(original.days[0].workout.id);
    expect(copy.days[0].workout.status).toBe('planned');
    expect(copy.days[0].workout.blocks[0].rpe).toBeUndefined();
    expect(copy.days[0].workout.blocks[0].loggedSets.every((s) => !s.completed && s.reps === null)).toBe(true);
  });
});
