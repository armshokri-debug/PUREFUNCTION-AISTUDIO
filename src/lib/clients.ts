import { ClientProfile, ClientSection, MonthlyReportData } from '../types';
import { WEIGHT_UNIT } from './units';
import { addDays, startOfWeek, todayISO } from './workouts';
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

export type AttentionSeverity = 'urgent' | 'warning';

export type AttentionReasonCode =
  | 'pain_reported'
  | 'missed_workouts'
  | 'assessment_missing'
  | 'assessment_due'
  | 'low_adherence'
  | 'no_workouts';

export interface ClientAttentionReason {
  code: AttentionReasonCode;
  severity: AttentionSeverity;
  label: string;
  targetSection: ClientSection;
}

export interface ClientAttentionSummary {
  clientId: string;
  severity: AttentionSeverity;
  reasons: ClientAttentionReason[];
  primarySection: ClientSection;
}

/**
 * Evaluates whether an active client needs coach attention based solely on
 * real available assessment and workout data (never fabricated metrics).
 */
export function evaluateClientAttention(
  client: ClientProfile,
  today: string = todayISO()
): ClientAttentionSummary | null {
  if (client.archived) return null;

  const reasons: ClientAttentionReason[] = [];
  const workouts = client.workouts ?? [];
  const assessments = client.assessments ?? [];
  const fourteenDaysAgo = addDays(today, -14);
  const weekStart = startOfWeek(today);

  // 1. Pain reported in a workout logged within the last 14 days
  const recentWorkoutsDesc = [...workouts]
    .filter((w) => w.date >= fourteenDaysAgo && w.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date));

  let painExercise: string | null = null;
  for (const w of recentWorkoutsDesc) {
    const painBlock = w.blocks.find((b) => b.pain === true);
    if (painBlock) {
      painExercise = painBlock.name;
      break;
    }
  }
  if (painExercise) {
    reasons.push({
      code: 'pain_reported',
      severity: 'urgent',
      label: `Pain reported · ${painExercise}`,
      targetSection: 'exercises'
    });
  }

  // 2. Missed workouts in the last 14 days or overdue planned sessions this week
  const missedCount = workouts.filter(
    (w) =>
      (w.status === 'missed' && w.date >= fourteenDaysAgo && w.date <= today) ||
      (w.status === 'planned' && w.date >= weekStart && w.date < today)
  ).length;

  if (missedCount > 0) {
    reasons.push({
      code: 'missed_workouts',
      severity: 'urgent',
      label: `${missedCount} missed ${missedCount === 1 ? 'workout' : 'workouts'}`,
      targetSection: 'exercises'
    });
  }

  // 3. Assessment due soon or no completed assessment recorded yet
  if (assessments.length === 0 && client.nextAssessmentDays <= 0) {
    reasons.push({
      code: 'assessment_missing',
      severity: 'warning',
      label: 'Initial assessment needed',
      targetSection: 'assessment'
    });
  } else if (client.nextAssessmentDays <= 0) {
    reasons.push({
      code: 'assessment_due',
      severity: 'warning',
      label: 'Assessment due now',
      targetSection: 'assessment'
    });
  } else if (client.nextAssessmentDays <= 5) {
    reasons.push({
      code: 'assessment_due',
      severity: 'warning',
      label: `Assessment in ${client.nextAssessmentDays}d`,
      targetSection: 'assessment'
    });
  }

  // 4. Low weekly workout adherence or no upcoming workouts scheduled
  if (client.adherenceTotal >= 2 && client.adherenceCompleted / client.adherenceTotal < 0.5) {
    reasons.push({
      code: 'low_adherence',
      severity: 'warning',
      label: `${client.adherenceCompleted}/${client.adherenceTotal} workouts this week`,
      targetSection: 'exercises'
    });
  } else if (client.adherenceTotal === 0 && !workouts.some((w) => w.date >= today)) {
    reasons.push({
      code: 'no_workouts',
      severity: 'warning',
      label: 'No workouts scheduled',
      targetSection: 'exercises'
    });
  }

  if (reasons.length === 0) return null;

  reasons.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'urgent' ? -1 : 1;
  });

  const severity: AttentionSeverity = reasons.some((r) => r.severity === 'urgent')
    ? 'urgent'
    : 'warning';

  return {
    clientId: client.id,
    severity,
    reasons,
    primarySection: reasons[0].targetSection
  };
}

export interface ClientSnapshotStats {
  completedWorkouts: number;
  totalWorkouts: number;
  lastCompletedWorkoutDate: string | null;
  completedAssessments: number;
  lastAssessmentDate: string | null;
  goalsCount: number;
  notesCount: number;
  progressPointsCount: number;
  nutritionCalories: number | null;
  nutritionProtein: number | null;
  weightKg: number | null;
  bodyFatPercent: number | null;
}

/** Extracts factual summary values from an existing ClientProfile without fabricating missing data. */
export function getClientSnapshotStats(client: ClientProfile): ClientSnapshotStats {
  const workouts = client.workouts ?? [];
  const completed = workouts
    .filter((w) => w.status === 'completed')
    .sort((a, b) => b.date.localeCompare(a.date));

  const assessments = [...(client.assessments ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  return {
    completedWorkouts: completed.length,
    totalWorkouts: workouts.length,
    lastCompletedWorkoutDate: completed[0]?.date ?? null,
    completedAssessments: assessments.length,
    lastAssessmentDate: assessments[0]?.date ?? null,
    goalsCount: (client.goals ?? []).length,
    notesCount: (client.coachNotes ?? []).length,
    progressPointsCount: (client.progressHistory ?? []).length,
    nutritionCalories:
      client.nutrition?.calories && client.nutrition.calories > 0 ? client.nutrition.calories : null,
    nutritionProtein:
      client.nutrition?.protein && client.nutrition.protein > 0 ? client.nutrition.protein : null,
    weightKg: client.inBody?.weight > 0 ? client.inBody.weight : null,
    bodyFatPercent: client.inBody?.bodyFatPercent > 0 ? client.inBody.bodyFatPercent : null
  };
}
