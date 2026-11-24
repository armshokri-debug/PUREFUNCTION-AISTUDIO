#!/usr/bin/env node
// Synthetic-only security regression for the current Pure Function database schema.
// Runs exclusively against ephemeral loopback Supabase CLI Docker. No network email or Production writes.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
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

  const blockId='pf-block-'+t;
  const prescribedData={
    name:'synthetic workout', title:'Coach-owned prescription',
    status:'planned',
    blocks:[{
      id:blockId,name:'Synthetic strength block',prescribedReps:8,
      loggedSets:[{setNumber:1,kg:null,reps:null,completed:false}]
    }]
  };
  await ok(coachA.user.from('workouts').insert({
    id:workout,client_id:cid,date:'2026-11-22',
    data:prescribedData
  }));
  assert.equal((await fetchRows(member.user,'workouts','id',workout)).length,1);
  assert.equal((await fetchRows(coachB.user,'workouts','id',workout)).length,0);

  // Client logs results using the actual production RPC, then signs in from a
  // second client session (fresh Supabase client) to verify durable DB state.
  const baseline=await ok(member.user.from('workouts').select('id,data,updated_at').eq('id',workout).single());
  const results={
    status:'completed',completedAt:'2026-11-24T09:00:00.000Z',
    sessionRpe:7,clientFeedback:'Synthetic session finished',
    blocks:[{
      id:blockId,loggedSets:[{setNumber:1,kg:40,reps:8,completed:true}],
      rpe:7,pain:false,clientNote:'Synthetic result'
    }]
  };
  const response=await ok(member.user.rpc('save_workout_results_secure',{
    p_workout_id:workout,p_client_id:cid,
    p_expected_version:baseline.updated_at,p_results:results
  }));
  assert.equal(response.length,1,'Secure result RPC must return one version');
  assert(response[0]?.updated_version&&response[0].updated_version!==baseline.updated_at,
    'Result save must advance the workout version');
  const secondDevice=client(anon);
  await ok(secondDevice.auth.signInWithPassword({email:emails.member,password}));
  const reloaded=await ok(secondDevice.from('workouts').select('data,updated_at').eq('id',workout).single());
  assert.equal(reloaded.updated_at,response[0].updated_version,'Fresh-session read differs from saved version');
  assert.equal(reloaded.data.status,'completed','Completed status was not persisted');
  assert.equal(reloaded.data.sessionRpe,7,'Session RPE was not persisted');
  assert.equal(reloaded.data.blocks[0].loggedSets[0].reps,8,'Logged reps were not persisted');
  assert.equal(reloaded.data.blocks[0].loggedSets[0].kg,40,'Logged load was not persisted');
  assert.equal(reloaded.data.title,prescribedData.title,'Client changed coach-owned title');
  assert.equal(reloaded.data.blocks[0].prescribedReps,8,'Client changed prescription');
  const coachView=await ok(coachA.user.from('workouts').select('data').eq('id',workout).single());
  assert.equal(coachView.data.status,'completed','Coach could not see saved client result');
  console.log('PASS: client secure workout result saved; fresh login sees persisted result and coach sees completion');

  const stale=await member.user.rpc('save_workout_results_secure',{
    p_workout_id:workout,p_client_id:cid,
    p_expected_version:baseline.updated_at,p_results:results
  });
  assert(stale.error && stale.error.code==='40001','Stale client version must fail with VERSION_CONFLICT');
  const afterStale=await ok(member.user.from('workouts').select('data,updated_at').eq('id',workout).single());
  assert.equal(afterStale.updated_at,reloaded.updated_at,'Stale save mutated workout version');
  await ensureDenied(member.user.from('workouts').update({
    data:{...reloaded.data,title:'Unauthorized prescription'}
  }).eq('id',workout).select('id'),'client directly rewriting coach prescription');
  const foreign=await coachB.user.rpc('save_workout_results_secure',{
    p_workout_id:workout,p_client_id:cid,p_expected_version:reloaded.updated_at,p_results:results
  });
  assert(foreign.error && foreign.error.code==='42501','Another coach cannot log this client result');
  console.log('PASS: version conflicts fail closed; direct client prescription edits and foreign result writes denied');
  await ensureDenied(coachB.user.from('workouts').insert({
    id:'foreign-workout-'+t,client_id:cid,date:'2026-11-23',data:{name:'unauthorized'}
  }).select('id'), 'other coach inserting a workout');
  await ensureDenied(member.user.from('clients').delete().eq('id',cid).select('id'), 'client deleting own record');
  await ensureDenied(coachB.user.from('clients').delete().eq('id',cid).select('id'), 'other coach deleting record');
  await ensureDenied(coachA.user.from('clients').update({coach_id:coachB.uid}).eq('id',cid).select('id'),
    'moving ownership to another coach');
  console.log('PASS: workout persistence and rejected cross-tenant create/delete/ownership reassignment');

  // Disaster rollback rehearsal: only fake rows in the loopback Docker instance.
  // This verifies scoped PostgreSQL data recovery, NOT a full Supabase service failover.
  const snapshot = (process.env.RUNNER_TEMP || '/tmp') + '/pf-fake-rollback-' + t + '.dump';
  try {
    execFileSync('pg_dump', [
      db, '--data-only', '--format=custom', '--no-owner', '--no-acl',
      '--table=public.clients', '--table=public.workouts', '--file', snapshot
    ], { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('PASS: local synthetic clients/workouts snapshot created');
    const wiped = await ok(coachA.user.from('clients').delete().eq('id',cid).select('id'));
    assert.equal(wiped.length, 1, 'Expected local accidental-delete simulation to remove one synthetic client');
    assert.equal((await fetchRows(coachA.user,'workouts','id',workout)).length,0,
      'Expected local cascading delete before rollback');
    try {
      execFileSync('pg_restore', [
        '--dbname',db,'--data-only','--no-owner','--no-acl',
        '--exit-on-error','--single-transaction',snapshot
      ], {
        timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        // Real owner-validation triggers stay enabled; restore acts as the synthetic coach.
        // PGOPTIONS is scoped to this one local PostgreSQL connection.
        env: { ...process.env, PGOPTIONS: '-c request.jwt.claim.sub=' + coachA.uid }
      });
    } catch (err) {
      // Only the error classification from the synthetic local restore is printed.
      const raw = String(err?.stderr || '');
      const line = raw.split('\n').find(l => /pg_restore: error:|ERROR:|FATAL:/.test(l)) || '';
      const classified = /duplicate key|already exists/i.test(line) ? 'duplicate-key' :
        /foreign key|violates.*constraint/i.test(line) ? 'foreign-key' :
        /permission denied|must be owner/i.test(line) ? 'ownership-permissions' :
        /role.*does not exist/i.test(line) ? 'missing-role' :
        /does not exist/i.test(line) ? 'missing-object' :
        /trigger/i.test(line) ? 'trigger' : 'other';
      console.error('ROLLBACK_RESTORE_FAILURE_CATEGORY: ' + classified);
      throw new Error('isolated synthetic pg_restore failed (' + classified + ')');
    }
    assert.equal((await fetchRows(coachA.user,'clients','id',cid)).length,1);
    assert.equal((await fetchRows(coachA.user,'workouts','id',workout)).length,1);
    assert.equal((await fetchRows(member.user,'workouts','id',workout)).length,1);
    assert.equal((await fetchRows(coachB.user,'workouts','id',workout)).length,0);
    assert.equal(q("select count(*) from public.coach_client_assignments where client_id='"+cid+"'"),'1', 'Owner mapping must be recreated by insert trigger');
    console.log('PASS: synthetic accidental-delete database rollback restored rows and tenant isolation');
  } finally {
    rmSync(snapshot, { force: true });
  }

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
