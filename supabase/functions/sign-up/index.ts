// Pure Function 2 sign-up (deployed as Edge Function "sign-up", verify_jwt = false).
// Only the coach's email or an invited client's email may sign up.
// A one-time verification link is sent via Resend before any login is possible.
// Never auto-confirm a new user's email.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, sendTransactionalEmail } from '../_shared/email.ts';
import { handleSignUp } from './handler.ts';

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return handleSignUp(req, {
    appUrl: APP_URL,
    reserveAttempt: async (subject) => {
      const { data, error } = await admin.rpc('pf_reserve_api_budget', { p_scope: 'signup', p_subject: subject });
      return !error && data === true;
    },
    sendEmail: sendTransactionalEmail,
    reserveSignupVerification: (email) => admin.rpc('reserve_signup_verification', { p_email: email }),
    getSignupRole: (email) => admin.rpc('signup_role', { p_email: email }),
    isExistingSignupAccount: (email) => admin.rpc('is_existing_signup_account', { p_email: email }),
    generateMagicLink: async (email) => {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      return { hashedToken: data.properties?.hashed_token, error };
    },
    generateSignupLink: async (email, password, displayName) => {
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'signup',
        email,
        password,
        options: { data: { display_name: displayName } }
      });
      return {
        hashedToken: data.properties?.hashed_token,
        userId: data.user?.id,
        error
      };
    },
    deleteUser: async (userId) => {
      await admin.auth.admin.deleteUser(userId);
    }
  });
});
