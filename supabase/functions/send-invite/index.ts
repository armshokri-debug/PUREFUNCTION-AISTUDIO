// Coach-only: email a client their invite link (verify_jwt = true).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, CooldownTracker, sendTransactionalEmail } from '../_shared/email.ts';
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
    reserveAttempt: async (subject) => {
      const { data, error } = await admin.rpc('pf_reserve_api_budget', { p_scope: 'client_invite', p_subject: subject });
      if (error) throw error;
      return data === true;
    },
    sendEmail: sendTransactionalEmail,
    getExistingAccount: async (email) => {
      // Restricted service-role lookup. A client JWT must never enumerate users.
      const { data, error } = await admin.rpc('pf_invite_existing_account', { p_email: email });
      return { data: data as { email: string; confirmed: boolean; hasPassword: boolean; clientId: string | null } | null, error };
    },
    generateInviteLink: async (email, name) => {
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'invite', email,
        options: { data: { display_name: name } }
      });
      return { hashedToken: data.properties?.hashed_token, userId: data.user?.id, error };
    },
    generateMagicLink: async (email) => {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      return { hashedToken: data.properties?.hashed_token, error };
    },
    deleteNewUser: async (id) => {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    },
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
      if (!data.user?.email || !data.user.email_confirmed_at) return false;
      const { data: state, error } = await admin.rpc('pf_invite_existing_account', {
        p_email: data.user.email
      });
      if (error) throw error; // fail closed rather than claim account readiness
      return state?.confirmed === true && state?.hasPassword === true;
    }
  });
});
