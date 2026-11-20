// Morning email to each client who has a workout today (coach's time zone).
// Called by pg_cron with the x-cron-secret header (verify_jwt = false).
// Skips: no account yet, workout already done, reminders turned off for the client,
// and duplicate rows/runs for the same client on the same date.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, sendEmail } from '../_shared/email.ts';
import { handleDailyReminders } from './handler.ts';

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  });

  return handleDailyReminders(req, {
    appUrl: APP_URL,
    coachTimezone: Deno.env.get('COACH_TIMEZONE'),
    remindersEnabled: Deno.env.get('DAILY_REMINDERS_ENABLED'),
    sendEmail,
    verifyCronSecret: async (secret) => {
      // secret is kept in Vault (see migration daily_reminders_cron)
      const { data, error } = await admin.rpc('cron_secret_ok', { s: secret });
      return { ok: data === true, error };
    },
    getWorkoutsForDate: async (date) => {
      const { data, error } = await admin.from('workouts').select('client_id, data').eq('date', date);
      return { data, error };
    },
    getJoinedClientIds: async () => {
      const { data, error } = await admin.from('profiles').select('client_id').eq('role', 'client');
      return { data, error };
    },
    getClientById: async (clientId) => {
      const { data, error } = await admin.from('clients').select('email, data').eq('id', clientId).maybeSingle();
      return { data, error };
    }
  });
});
