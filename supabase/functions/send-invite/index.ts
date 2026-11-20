// Coach-only: email a client their invite link (verify_jwt = true).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, CooldownTracker, sendEmail } from '../_shared/email.ts';
import { handleSendInvite } from './handler.ts';

const inviteCooldown = new CooldownTracker();

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  });

  return handleSendInvite(req, {
    appUrl: APP_URL,
    cooldown: inviteCooldown,
    sendEmail,
    getUserByToken: async (token) => {
      const { data } = await admin.auth.getUser(token);
      return data.user ? { id: data.user.id } : null;
    },
    getCoachProfile: async (uid) => {
      const { data } = await admin.from('profiles').select('role, display_name').eq('id', uid).maybeSingle();
      return data;
    },
    getOwnedClient: async (token, clientId) => {
      // Use the caller's JWT for row access so revoked/unverified coaches also fail RLS.
      const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false }
      });
      const { data, error } = await caller
        .from('clients')
        .select('id, email, data, coach_id')
        .eq('id', clientId)
        .maybeSingle();
      return error ? null : data;
    },
    isClientAccountConfirmed: async (clientId) => {
      const { data: profile } = await admin
        .from('profiles')
        .select('id')
        .eq('client_id', clientId)
        .eq('role', 'client')
        .maybeSingle();
      if (!profile?.id) return false;
      const { data } = await admin.auth.admin.getUserById(profile.id);
      return Boolean(data.user?.email_confirmed_at);
    }
  });
});
