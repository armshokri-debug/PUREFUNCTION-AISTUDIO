import { describe, expect, it } from 'vitest';
import { canCreateTestClient, createTestClient } from '../testClient';

describe('Test Client fixture', () => {
  it('creates an unjoined, clearly labeled demo with data and no real email', () => {
    const client = createTestClient('2026-11-02');
    expect(client.isTestClient).toBe(true);
    expect(client.name).toContain('TEST CLIENT');
    expect(client.email).toContain('@example.invalid');
    expect(client.workouts?.length).toBeGreaterThan(0);
    expect(client.assessments?.length).toBe(1);
    expect(client.coachNotes?.length).toBe(1);
    expect(client.spectrumTests?.['hip-ir']).toEqual({ left: 28, right: 38 });
  });
});

describe('Test Client environment gating', () => {
  it('always hides Test Client in Production Supabase builds', () => {
    expect(
      canCreateTestClient({
        isCloud: true,
        supabaseUrl: 'https://rugwzvztweiffprkxfdc.supabase.co'
      })
    ).toBe(false);

    // Even if an explicit flag is set, never allow against Production Supabase.
    expect(
      canCreateTestClient({
        isCloud: true,
        supabaseUrl: 'https://rugwzvztweiffprkxfdc.supabase.co',
        enableFlag: 'true'
      })
    ).toBe(false);
  });

  it('hides Test Client in cloud builds without an explicit test flag', () => {
    expect(
      canCreateTestClient({
        isCloud: true,
        supabaseUrl: 'https://mock.supabase.co'
      })
    ).toBe(false);

    expect(
      canCreateTestClient({
        isCloud: true,
        supabaseUrl: 'https://nsshdxxdvzzxlmdomixf.supabase.co'
      })
    ).toBe(false);
  });

  it('shows Test Client in local demo mode and explicit non-prod test/QA builds', () => {
    expect(canCreateTestClient({ isCloud: false })).toBe(true);
    expect(
      canCreateTestClient({
        isCloud: true,
        supabaseUrl: 'https://nsshdxxdvzzxlmdomixf.supabase.co',
        enableFlag: 'true'
      })
    ).toBe(true);
  });
});
