import { ClientProfile, MonthlyReportData } from '../types';
import { WEIGHT_UNIT } from './units';
import { alternateGoogleMailDomain, emailCooldownKey } from '../../supabase/functions/_shared/google-email-alias';

const zero = (unit: string) => ({ week0: 0, current: 0, unit });

/**
 * Matches duplicate client emails including Google's gmail.com / googlemail.com
 * domain equivalence, without altering dots, plus-tags, or other domains.
 */
export function findDuplicateClientByEmail<T extends Pick<ClientProfile, 'id' | 'email'>>(
  clients: readonly T[],
  rawEmail: string,
  excludeClientId?: string
): T | undefined {
  const targetKey = emailCooldownKey(rawEmail);
  if (!targetKey) return undefined;
  return clients.find((client) => {
    if (excludeClientId && client.id === excludeClientId) return false;
    const existingKey = emailCooldownKey(client.email ?? '');
    return Boolean(existingKey) && existingKey === targetKey;
  });
}

export function duplicateClientEmailMessage(rawEmail: string, existingEmail?: string): string {
  const clean = rawEmail.trim().toLowerCase();
  const existing = (existingEmail ?? '').trim().toLowerCase();
  if (clean !== existing && alternateGoogleMailDomain(clean) === existing) {
    return 'This Gmail/Googlemail address already belongs to another client.';
  }
  return 'A client with this email already exists.';
}

export interface ClientDeletionEnv {
  isCloud: boolean;
  enableSafeDeleteFlag?: string;
}

/**
 * Permanent deletion of real clients in cloud mode stays disabled by default
 * until the staged, idempotent deletion function and durable job table are
 * deployed, verified, and explicitly opted in via VITE_ENABLE_SAFE_CLIENT_DELETE=true.
 * Archiving always remains available without deleting records.
 */
export function canPermanentlyDeleteClient(
  env: ClientDeletionEnv = {
    isCloud: Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY),
    enableSafeDeleteFlag: import.meta.env.VITE_ENABLE_SAFE_CLIENT_DELETE as string | undefined
  }
): boolean {
  if (!env.isCloud) return true;
  return env.enableSafeDeleteFlag === 'true';
}

function emptyReport(month: 1 | 2 | 3): MonthlyReportData {
  return {
    month,
    weeksLabel: `Weeks ${(month - 1) * 4}–${month * 4}`,
    phaseCompleted: '',
    nextPhase: '',
    coachSummary: '',
    nextPhaseFocus: [],
    metrics: {
      weightKg: zero(WEIGHT_UNIT),
      muscleMassKg: zero(WEIGHT_UNIT),
      bodyFatPct: zero('%'),
      hipIrAsymmetryPct: zero('%'),
      squat1RmKg: zero(WEIGHT_UNIT),
      adherencePct: zero('%')
    }
  };
}

/** A real new client: no sample numbers, ready for the first assessment. */
export function createClientProfile(input: {
  name: string;
  email: string;
  phaseNumber: ClientProfile['phaseNumber'];
  phaseName: ClientProfile['phaseName'];
}): ClientProfile {
  return {
    id: `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    avatarId: '',
    phaseNumber: input.phaseNumber,
    phaseName: input.phaseName,
    currentWeek: 0,
    adherenceCompleted: 0,
    adherenceTotal: 0,
    nextAssessmentDays: 0,
    unreadMessages: 0,
    inBody: {
      weight: 0,
      skeletalMuscleMass: 0,
      bodyFatMass: 0,
      bodyFatPercent: 0,
      visceralFatLevel: 0,
      bmr: 0,
      inBodyScore: 0,
      segments: { leftArm: 0, rightArm: 0, trunk: 0, leftLeg: 0, rightLeg: 0 },
      printoutUploaded: false
    },
    rom: [
      { id: 'rom-1', name: 'Hip internal rotation', left: 0, right: 0, normalMax: 45 },
      { id: 'rom-2', name: 'Hip external rotation', left: 0, right: 0, normalMax: 45 },
      { id: 'rom-3', name: 'Shoulder flexion', left: 0, right: 0, normalMax: 180 },
      { id: 'rom-4', name: 'Shoulder internal rotation', left: 0, right: 0, normalMax: 70 },
      { id: 'rom-5', name: 'Ankle dorsiflexion', left: 0, right: 0, normalMax: 20 }
    ],
    priTests: [],
    gaitPosture: [],
    strengthTests: [],
    videos: [],
    workouts: [],
    progressHistory: [],
    monthlyReports: { 1: emptyReport(1), 2: emptyReport(2), 3: emptyReport(3) }
  };
}
