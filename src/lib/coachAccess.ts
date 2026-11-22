/**
 * A verified email is not proof of coach access.
 * coach_id is populated by pf_list_trainers only for actual coach profiles.
 */
export interface CoachInviteRow {
  email: string;
  coach_id: string | null;
  display_name: string;
  verified: boolean;
}

export type CoachInviteState = 'active' | 'verification_needed' | 'existing_non_coach' | 'invited';

export function coachInviteState(row: CoachInviteRow): CoachInviteState {
  if (row.coach_id) return row.verified ? 'active' : 'verification_needed';
  return row.verified ? 'existing_non_coach' : 'invited';
}

/** Only grants without a coach profile may be cancelled. Accounts and data stay intact. */
export function canCancelInvite(row: CoachInviteRow): boolean {
  return !row.coach_id;
}
