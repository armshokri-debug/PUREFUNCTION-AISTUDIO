import { describe, expect, it } from 'vitest';
import { canCancelInvite, coachInviteState, type CoachInviteRow } from '../coachAccess';

const row = (coach_id: string | null, verified: boolean): CoachInviteRow => ({
  email: 'example@sample.invalid', coach_id, display_name: '', verified
});

describe('coach invitation lifecycle', () => {
  it('treats a verified coach profile as active', () => {
    expect(coachInviteState(row('coach-123', true))).toBe('active');
    expect(canCancelInvite(row('coach-123', true))).toBe(false);
  });
  it('does not mistake a verified client account for a coach', () => {
    expect(coachInviteState(row(null, true))).toBe('existing_non_coach');
    expect(canCancelInvite(row(null, true))).toBe(true);
  });
  it('shows a pending invitation when there is no account', () => {
    expect(coachInviteState(row(null, false))).toBe('invited');
    expect(canCancelInvite(row(null, false))).toBe(true);
  });
  it('never removes a coach profile just because email verification is pending', () => {
    expect(coachInviteState(row('coach-123', false))).toBe('verification_needed');
    expect(canCancelInvite(row('coach-123', false))).toBe(false);
  });
});
