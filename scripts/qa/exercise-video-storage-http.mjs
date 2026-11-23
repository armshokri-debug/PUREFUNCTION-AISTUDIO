#!/usr/bin/env node
// Live HTTP integration for exercise Storage on disposable local Supabase only.
// Does not touch QA cloud, Production, users, email, or deployed services.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const statusFile = process.argv[2];
assert(statusFile, 'Local Supabase status JSON path required');
const s = JSON.parse(readFileSync(statusFile, 'utf8'));
const read = (...keys) => keys.map(k => s[k]).find(v => typeof v === 'string' && v.length);
const api = read('API_URL', 'api_url');
const db = read('DB_URL', 'db_url');
const anon = read('ANON_KEY', 'anon_key', 'PUBLISHABLE_KEY', 'publishable_key');
const service = read('SERVICE_ROLE_KEY', 'service_role_key', 'SECRET_KEY', 'secret_key');
for (const endpoint of [api, db]) {
  assert(endpoint && ['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname),
    'Blocked: only disposable local Docker endpoints allowed');
}
assert(anon && service, 'Local synthetic test keys required');
assert(!JSON.stringify(s).includes('rugwzvztweiffprkxfdc') &&
  !JSON.stringify(s).includes('nsshdxxdvzzxlmdomixf'),
'Blocked: remote Supabase projects not allowed');

const sql = (statement) => execFileSync('psql',
  [db, '-X', '-v', 'ON_ERROR_STOP=1', '-c', statement],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const client = (key) => createClient(api, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const admin = client(service);
const must = async (promise, description) => {
  const { data, error } = await promise;
  if (error) throw new Error(description + ': ' + String(error.code || error.status || 'API error'));
  return data;
};
const key = randomUUID().replaceAll('-', '').slice(0, 10);
const bucket = 'exercise-videos';
const passwd = 'SyntheticLocalOnly_9!' + key;
const emails = ['pf-ex-owner-a-' + key + '@example.test','pf-ex-owner-b-' + key + '@example.test'];
const users = [];

try {
  // Build an isolated copy of the relevant app schema and the production-style
  // allowlist/verified-coach predicate. The PR migration is applied verbatim.
  sql(`
    CREATE SCHEMA IF NOT EXISTS private;
    CREATE TABLE public.exercises (
      id text PRIMARY KEY, data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.exercises ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY REFERENCES auth.users(id), role text NOT NULL
    );
    CREATE TABLE private.coach_allowlist (email text PRIMARY KEY);
    CREATE FUNCTION private.is_coach() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
      AS $$ SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        JOIN auth.users u ON u.id = p.id
        JOIN private.coach_allowlist a ON a.email = lower(u.email)
        WHERE p.id = auth.uid() AND p.role = 'coach' AND u.email_confirmed_at IS NOT NULL
      ); $$;
    CREATE FUNCTION private.has_profile() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
      AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()); $$;
    GRANT USAGE ON SCHEMA private TO authenticated;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.exercises TO authenticated;
    CREATE POLICY "exercises read" ON public.exercises
      FOR SELECT TO authenticated USING (private.has_profile());
    CREATE POLICY "exercise videos read" ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'exercise-videos' AND private.has_profile());
  `);
  execFileSync('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-f',
    'supabase/migrations/20261123120000_exercise_video_owner_isolation.sql'],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  sql("NOTIFY pgrst, 'reload schema'");
  await must(admin.storage.createBucket(bucket, { public: false }), 'Create synthetic bucket');

  for (const email of emails) {
    // Admin API creates confirmed synthetic accounts without sending invitation email.
    const created = await must(admin.auth.admin.createUser({
      email, password: passwd, email_confirm: true
    }), 'Create fake coach');
    const uid = created.user.id;
    assert(/^[0-9a-f-]{36}$/i.test(uid), 'Invalid synthetic UUID');
    users.push(uid);
    const escapedEmail = email.replaceAll("'", "''");
    sql(`INSERT INTO private.coach_allowlist(email) VALUES ('${escapedEmail}');
         INSERT INTO public.profiles(id,role) VALUES ('${uid}','coach');`);
  }

  const accounts = [];
  for (let i = 0; i < users.length; i++) {
    const c = client(anon);
    const login = await must(c.auth.signInWithPassword({
      email: emails[i], password: passwd
    }), 'Sign in synthetic coach');
    assert.equal(login.user.id, users[i], 'Session identity mismatch');
    accounts.push(c);
  }
  const [owner, other] = accounts;
  const exercise = 'pf-qa-ex-' + key;
  const path = users[0] + '/' + exercise + '/sample.mp4';
  const forbidden = users[0] + '/' + exercise + '/intruder.mp4';

  const inserted = await must(owner.from('exercises')
    .insert({ id: exercise, data: { name: 'Synthetic exercise' } })
    .select('owner_id'), 'Owner creates exercise');
  assert.equal(inserted[0]?.owner_id, users[0], 'DB assigned wrong owner');
  const shared = await must(other.from('exercises').select('id').eq('id',exercise),
    'Other coach reads shared library');
  assert.equal(shared.length, 1, 'Shared exercise should be readable');
  const blockedUpdate = await must(other.from('exercises')
    .update({ data: { name: 'Attacker' } }).eq('id',exercise).select('id'),
  'Other coach attempts exercise edit');
  assert.equal(blockedUpdate.length,0, 'SECURITY: other coach modified exercise');

  const uploaded = await must(owner.storage.from(bucket).upload(
    path, Buffer.from('isolated-video-test-' + key),
    { contentType: 'video/mp4', upsert: false }), 'Owner video upload');
  assert.equal(uploaded.path, path, 'Unexpected upload path');
  const forbiddenUpload = await other.storage.from(bucket).upload(
    forbidden, Buffer.from('blocked'), { contentType:'video/mp4', upsert:false });
  assert(forbiddenUpload.error, 'SECURITY: cross-owner video upload succeeded');

  const nonOwnerDelete = await other.storage.from(bucket).remove([path]);
  // RLS may return an error OR a successful empty result; neither deletes the file.
  const deletedByOther = !nonOwnerDelete.error &&
    Array.isArray(nonOwnerDelete.data) &&
    nonOwnerDelete.data.some((item) => item.name === path);
  assert(!deletedByOther, 'SECURITY: non-owner deletion returned a deleted object');
  const stillThere = await must(admin.storage.from(bucket).download(path),
    'Verify cross-owner deletion did not remove video');
  assert.equal(await stillThere.text(), 'isolated-video-test-' + key,
    'SECURITY: other coach actually removed or changed the video');

  const ownerDelete = await must(owner.storage.from(bucket).remove([path]),
    'Owner video deletion');
  assert(ownerDelete.some((item) => item.name === path),
    'Owner removal result did not confirm requested path');
  const finalRead = await admin.storage.from(bucket).download(path);
  assert(finalRead.error, 'Deleted video still downloadable');
  console.log('PASS: authenticated Storage HTTP upload, cross-owner upload/delete denied, owner delete successful, object gone');
  console.log('PASS: actual PR SQL ownership migration and REST sharing work against isolated local Supabase');
} catch (e) {
  console.error('FAIL: disposable Storage API integration: ' +
    (e instanceof Error ? e.message.split(api).join('[local-api]').slice(0,220) : 'unknown'));
  process.exitCode = 1;
} finally {
  for (const uid of users) {
    try { await admin.auth.admin.deleteUser(uid); } catch { /* local container is destroyed */ }
  }
}
