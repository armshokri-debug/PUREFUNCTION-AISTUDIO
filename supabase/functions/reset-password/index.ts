// Forgot password (verify_jwt = false). Emails a one-time link back to the app;
// the app verifies it and lets the user choose a new password. Always answers
// the same way so it never reveals which emails have accounts.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, CooldownTracker, sendEmail } from '../_shared/email.ts';
import { handleResetPassword } from './handler.ts';

const resetCooldown = new CooldownTracker();

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  });

  return handleResetPassword(req, {
    appUrl: APP_URL,
    cooldown: resetCooldown,
    sendEmail,
    generateRecoveryLink: async (email) => {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
      return { hashedToken: data?.properties?.hashed_token, error };
    }
  });
});
