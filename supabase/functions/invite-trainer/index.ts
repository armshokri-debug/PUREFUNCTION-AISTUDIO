import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { APP_URL, cors, json, layout, sendTransactionalEmail } from '../_shared/email.ts';
import { coachSignupLink } from '../_shared/app-url.ts';
import { emailCooldownKey } from '../_shared/google-email-alias.ts';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const user = await admin.auth.getUser(jwt);
  if (!user.data.user) return json(401, { error: 'Sign in required' });
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false }
  });
  const head = await caller.rpc('pf_head_coach');
  if (head.error || head.data !== true) return json(403, { error: 'Head coach only' });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(400, { error: 'Invalid email' });
  // A prior explicit allowlist grant is mandatory. Never allowlist within this public edge function.
  const allowed = await caller.rpc('pf_trainer_is_allowed', { p_email: email });
  if (allowed.error || allowed.data !== true) return json(403, { error: 'Trainer not allowlisted' });
  const budget = await admin.rpc('pf_reserve_api_budget', { p_scope: 'trainer_invite', p_subject: emailCooldownKey(email) });
  if (budget.error) return json(503, { error: 'Invitation temporarily unavailable.' });
  if (budget.data !== true) return json(429, { error: 'Invitation limit reached. Wait before trying again.' });
  const result = await sendTransactionalEmail(email, 'Your Pure Function trainer invitation',
    layout('Set up your trainer account', ['Your head coach invited you to Pure Function. Register using this email and verify ownership. If you already have an account, sign in instead.'], { text: 'Set up trainer login', url: coachSignupLink(APP_URL) }));
  return result.ok ? json(200, { ok: true }) : json(result.status, { error: result.error });
});
