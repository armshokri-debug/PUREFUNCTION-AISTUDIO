import { cors, isValidEmail, json, layout, type SendEmailOptions, type SendResult } from '../_shared/email-core.ts';

export const DEFAULT_COACH_TIMEZONE = 'America/New_York';

export function resolveTimezone(configured?: string, logWarn: (line: string) => void = console.warn): string {
  const candidate = configured?.trim();
  if (!candidate) return DEFAULT_COACH_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    logWarn(JSON.stringify({ event: 'daily_reminders_invalid_timezone', fallback: DEFAULT_COACH_TIMEZONE }));
    return DEFAULT_COACH_TIMEZONE;
  }
}

export function todayIn(tz: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date); // YYYY-MM-DD
}

export interface DailyWorkoutRow {
  client_id: string;
  data: { title?: string; status?: string; blocks?: { name: string }[] } | null;
}

export interface DailyClientRow {
  email?: string | null;
  data?: { name?: unknown; emailReminders?: boolean } | null;
}

export interface DailyRemindersDeps {
  appUrl: string;
  coachTimezone?: string;
  remindersEnabled?: string;
  now?: () => Date;
  verifyCronSecret: (secret: string) => Promise<{ ok: boolean; error?: unknown }>;
  getWorkoutsForDate: (date: string) => Promise<{ data: DailyWorkoutRow[] | null; error?: unknown }>;
  getJoinedClientIds: () => Promise<{ data: { client_id: string | null }[] | null; error?: unknown }>;
  getClientById: (clientId: string) => Promise<{ data: DailyClientRow | null; error?: unknown }>;
  sendEmail: (to: string, subject: string, html: string, options?: SendEmailOptions) => Promise<SendResult>;
  logWarn?: (line: string) => void;
}

export async function handleDailyReminders(req: Request, deps: DailyRemindersDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const given = (req.headers.get('x-cron-secret') ?? '').trim();
  if (!given) return json(401, { error: 'unauthorized' });

  const secretCheck = await deps.verifyCronSecret(given);
  if (secretCheck.error || secretCheck.ok !== true) {
    return json(401, { error: 'unauthorized' });
  }

  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const timezone = resolveTimezone(deps.coachTimezone, deps.logWarn);
  const today = todayIn(timezone, deps.now ? deps.now() : new Date());

  // Optional kill-switch so the owner can pause live daily reminders via secret
  // without editing pg_cron SQL, while keeping ?dry=1 available for previews.
  const paused = deps.remindersEnabled?.trim().toLowerCase() === 'false';
  if (paused && !dry) {
    return json(200, { today, timezone, paused: true, results: [] });
  }

  const workoutsRes = await deps.getWorkoutsForDate(today);
  if (workoutsRes.error) return json(500, { error: 'Failed to load scheduled workouts.' });

  const joinedRes = await deps.getJoinedClientIds();
  if (joinedRes.error) return json(500, { error: 'Failed to load client accounts.' });

  const joinedIds = new Set(
    (joinedRes.data ?? []).map((p) => p.client_id).filter((id): id is string => Boolean(id))
  );
  const processedClients = new Set<string>();
  const results: { client: string; status: string }[] = [];

  for (const w of workoutsRes.data ?? []) {
    const wo = w.data ?? {};
    if (!joinedIds.has(w.client_id)) {
      results.push({ client: w.client_id, status: 'skip: no account' });
      continue;
    }
    if (wo.status === 'completed') {
      results.push({ client: w.client_id, status: 'skip: done' });
      continue;
    }
    if (!wo.blocks?.length) {
      results.push({ client: w.client_id, status: 'skip: empty' });
      continue;
    }
    if (processedClients.has(w.client_id)) {
      results.push({ client: w.client_id, status: 'skip: duplicate' });
      continue;
    }

    const clientRes = await deps.getClientById(w.client_id);
    const c = clientRes.error ? null : clientRes.data;
    const clientEmail = String(c?.email ?? '').trim().toLowerCase();
    if (!c || c.data?.emailReminders === false || !clientEmail) {
      results.push({ client: w.client_id, status: 'skip: off' });
      continue;
    }
    if (!isValidEmail(clientEmail)) {
      results.push({ client: w.client_id, status: 'skip: invalid email' });
      continue;
    }

    processedClients.add(w.client_id);
    if (dry) {
      results.push({ client: w.client_id, status: 'would send' });
      continue;
    }

    const name = String(c.data?.name ?? '').trim().split(/\s+/)[0] || 'there';
    const list = wo.blocks.slice(0, 8).map((b) => `• ${b.name}`).join('  ');
    const r = await deps.sendEmail(
      clientEmail,
      `Today: ${wo.title || 'your workout'}`,
      layout(
        `Good morning ${name}`,
        [`Today’s workout: ${wo.title || 'Workout'} (${wo.blocks.length} exercises).`, list],
        { text: 'Open today’s workout', url: deps.appUrl }
      ),
      // 24h provider-side deduplication prevents duplicate reminders if cron retries on the same day.
      { idempotencyKey: `daily-reminder:${today}:${w.client_id}` }
    );
    results.push({ client: w.client_id, status: r.ok ? 'sent' : `error: ${r.error}` });
  }

  return json(200, { today, timezone, ...(dry ? { dry: true } : {}), results });
}
