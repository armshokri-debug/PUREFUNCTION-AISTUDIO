#!/usr/bin/env node
// Synthetic-only security regression for the current Pure Function database schema.
// Runs exclusively against ephemeral loopback Supabase CLI Docker. No network email or Production writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const status = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const read = (...keys) => keys.map(k => status[k]).find(x => typeof x === 'string' && x.length > 0);
const api = read('API_URL', 'api_url'), db = read('DB_URL', 'db_url');
const anon = read('ANON_KEY', 'anon_key', 'PUBLISHABLE_KEY', 'publishable_key');
const service = read('SERVICE_ROLE_KEY', 'service_role_key', 'SECRET_KEY', 'secret_key');
for (const u of [api, db]) {
  assert(u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname),
    'BLOCKED: only local Docker endpoints are permitted');
}
assert(anon && service, 'BLOCKED: synthetic local keys are missing');
assert(!JSON.stringify(status).includes('rugwzvztweiffprkxfdc'),
  'BLOCKED: production project identity must never appear');
const q = sql => execFileSync('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
  encoding: 'utf8', timeout: 20000, stdio: ['ignore','pipe','pipe']
}).trim();
const client = key => createClient(api, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const admin = client(service);
const ok = async value => {
  const { data, error } = await value;
  if (error) throw new Error('Local API: ' + String(error.code || error.status || 'error'));
  return data;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retry = async fn => {
  let last;
  for(let n = 0; n < 15; n++){
    try { return await fn(); } catch(e) { last = e; await delay(800); }
  }
  throw last;
};
const t = randomUUID().replace(/-/g,'').slice(0,12);
const emails = {
  coachA: 'pf-coach-a-' + t + '@example.test',
  coachB: 'pf-coach-b-' + t + '@example.test',
  member: 'pf-client-' + t + '@example.test',
  outsider: 'pf-outsider-' + t + '@example.test'
};
const password = 'SYNTHETIC_LocalOnly_7!' + t;
const ids = [];
const cid = 'pf-synthetic-' + t, workout = 'pf-workout-' + t;
async function createUser(email) {
  const a = await ok(admin.auth.admin.createUser({email,password,email_confirm:true}));
  ids.push(a.user.id);
  const user = client(anon);
  await ok(user.auth.signInWithPassword({email,password}));
  const identity = await ok(user.auth.getUser());
  assert.equal(identity.user.id, a.user.id);
  return {user, uid:a.user.id};
}
async function fetchRows(user, table, key, value) {
  return ok(user.from(table).select(key).eq(key,value));
}
async function ensureDenied(promise, label) {
  const { data, error } = await promise;
  if (!error && (!Array.isArray(data) || data.length !== 0))
    throw Error('SECURITY FAILURE: ' + label + ' permitted');
}
try {
  // pg_restore --no-acl avoids platform-owned role mismatch. Set the same
  // table operation grants as production in this ephemeral local test only.
  q("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;"+
    "GRANT USAGE ON SCHEMA private TO authenticated;"+
    "NOTIFY pgrst, 'reload schema';");
  q("INSERT INTO private.coach_allowlist(email) VALUES ('" + emails.coachA + "'),('" + emails.coachB + "');");

  const coachA = await createUser(emails.coachA);
  const coachB = await createUser(emails.coachB);
  const outsider = await createUser(emails.outsider);
  assert.equal((await retry(() => ok(coachA.user.from('profiles').select('role').eq('id',coachA.uid)))).at(0)?.role, 'coach');
  assert.equal((await ok(coachB.user.from('profiles').select('role').eq('id',coachB.uid))).at(0)?.role, 'coach');
  assert.equal((await ok(outsider.user.from('profiles').select('role').eq('id',outsider.uid))).length,0);
  console.log('PASS: fake coach allowlist / Auth sessions / outsider without profile');

  await retry(() => ok(coachA.user.from('clients').insert({
    id:cid,email:emails.member,coach_id:coachA.uid,
    data:{name:'synthetic client'}
  })));
  const member = await createUser(emails.member);
  assert.equal((await retry(() => ok(member.user.from('profiles').select('role,client_id').eq('id',member.uid)))).at(0)?.client_id,cid);
  assert.equal((await fetchRows(coachA.user,'clients','id',cid)).length,1);
  assert.equal((await fetchRows(member.user,'clients','id',cid)).length,1);
  assert.equal((await fetchRows(coachB.user,'clients','id',cid)).length,0);
  assert.equal((await fetchRows(outsider.user,'clients','id',cid)).length,0);
  console.log('PASS: client ownership / assigned client read / other coach and outsider isolated');

  await ok(coachA.user.from('workouts').insert({
    id:workout,client_id:cid,date:'2026-11-22',
    data:{name:'synthetic workout',exercises:[]}
  }));
  assert.equal((await fetchRows(member.user,'workouts','id',workout)).length,1);
  assert.equal((await fetchRows(coachB.user,'workouts','id',workout)).length,0);
  await ensureDenied(coachB.user.from('workouts').insert({
    id:'foreign-workout-'+t,client_id:cid,date:'2026-11-23',data:{name:'unauthorized'}
  }).select('id'), 'other coach inserting a workout');
  await ensureDenied(member.user.from('clients').delete().eq('id',cid).select('id'), 'client deleting own record');
  await ensureDenied(coachB.user.from('clients').delete().eq('id',cid).select('id'), 'other coach deleting record');
  await ensureDenied(coachA.user.from('clients').update({coach_id:coachB.uid}).eq('id',cid).select('id'),
    'moving ownership to another coach');
  console.log('PASS: workout persistence and rejected cross-tenant create/delete/ownership reassignment');

  // Deletion is tested only against ephemeral, wholly synthetic records.
  const deleted = await ok(coachA.user.from('clients').delete().eq('id',cid).select('id'));
  assert.equal(deleted.length,1);
  assert.equal((await fetchRows(coachA.user,'clients','id',cid)).length,0);
  assert.equal((await fetchRows(coachA.user,'workouts','id',workout)).length,0);
  console.log('PASS: owner cleanup and cascading workout delete verified');
  console.log('PASS: real-schema synthetic coach/client security exercise complete');
} catch(e) {
  console.error('FAIL: isolated coach/client security: ' +
    (e instanceof Error ? e.message.replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,200) : 'unknown error'));
  process.exitCode = 1;
} finally {
  for (const uid of ids) {
    try { await ok(admin.auth.admin.deleteUser(uid)); } catch {}
  }
}
