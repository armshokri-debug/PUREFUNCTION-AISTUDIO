// Integration test of actual Pure Function invitation handler, Supabase Auth and RLS.
// Uses actual current DDL restored into local Docker; emails are captured in memory.
// No actual email, real account, network mail provider, QA DB write or Production write.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { handleSendInvite } from '../../supabase/functions/send-invite/handler.ts';
import { CooldownTracker } from '../../supabase/functions/_shared/email-core.ts';

const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const value = (...keys) => keys.map(k => s[k]).find(x => typeof x === 'string' && x.length);
const api = value('API_URL','api_url'), db = value('DB_URL','db_url');
const anon = value('ANON_KEY','anon_key','PUBLISHABLE_KEY','publishable_key');
const secret = value('SERVICE_ROLE_KEY','service_role_key','SECRET_KEY','secret_key');
for (const url of [api, db]) {
  assert(url && ['localhost','127.0.0.1'].includes(new URL(url).hostname),
    'STOP: non-local Supabase endpoint');
}
assert(anon && secret, 'STOP: local Supabase keys unavailable');
assert(!JSON.stringify(s).includes('rugwzvztweiffprkxfdc'), 'STOP: production ID detected');

const sql = text => execFileSync('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-tAc', text], {
  encoding: 'utf8', timeout: 20000, stdio: ['ignore','pipe','pipe']
}).trim();
const client = key => createClient(api,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const admin = client(secret);
const read = async req => {
  const {data,error} = await req;
  if(error) throw Error('Local Supabase: ' + (error.code || error.status || 'error'));
  return data;
};
const id = randomUUID().replace(/-/g,'').slice(0,12);
const coachEmail = 'pf-invite-coach-' + id + '@example.test';
const otherEmail = 'pf-invite-other-' + id + '@example.test';
const strangerEmail = 'pf-invite-stranger-' + id + '@example.test';
const athleteEmail = 'pf-invite-athlete-' + id + '@example.test';
const clientId = 'pf-invite-client-' + id;
const workoutId = 'pf-invite-workout-' + id;
const password = 'SyntheticOnly-9!' + id;
const ids = [];
let invitedUid;
const staging = 'https://qa.purefunction.invalid/';
const mail = [];
const cooldown = new CooldownTracker();
let simulateProviderFailure = true;

async function actor(email) {
  const created = await read(admin.auth.admin.createUser({email,password,email_confirm:true}));
  ids.push(created.user.id);
  const app = client(anon);
  await read(app.auth.signInWithPassword({email,password}));
  const session = (await read(app.auth.getSession())).session;
  assert(session?.access_token, 'No local user session');
  return {app, uid:created.user.id, jwt:session.access_token};
}
function makeReq(jwt) {
  return new Request('https://functions.qa.invalid/send-invite', {
    method:'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+jwt},
    body:JSON.stringify({clientId})
  });
}
const deps = {
  appUrl:staging,
  cooldown,
  getUserByToken:async token=>{
    const result=await admin.auth.getUser(token);
    return result.data.user ? {id:result.data.user.id} : null;
  },
  getCoachProfile:async uid=>{
    const data=await read(admin.from('profiles').select('role,display_name').eq('id',uid).maybeSingle());
    return data;
  },
  getOwnedClient:async (token,id)=>{
    const caller=createClient(api,anon,{
      global:{headers:{Authorization:'Bearer '+token}},
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const result=await caller.from('clients').select('id,email,data,coach_id').eq('id',id).maybeSingle();
    return result.error ? null : result.data;
  },
  isClientAccountConfirmed:async id=>{
    const profile=await read(admin.from('profiles').select('id').eq('client_id',id).eq('role','client').maybeSingle());
    if(!profile?.id) return false;
    const account=await read(admin.auth.admin.getUserById(profile.id));
    if(!account.user?.email_confirmed_at) return false;
    const accountState=await read(admin.rpc('pf_invite_existing_account',{p_email:account.user.email}));
    return accountState?.confirmed === true && accountState?.hasPassword === true;
  },
  getExistingAccount:async email=>{
    const result=await admin.rpc('pf_invite_existing_account',{p_email:email});
    return {data:result.data,error:result.error};
  },
  generateInviteLink:async (email,name)=>{
    const result=await admin.auth.admin.generateLink({
      type:'invite',email,options:{data:{display_name:name}}
    });
    if(result.data.user?.id) invitedUid=result.data.user.id;
    return {
      hashedToken:result.data.properties?.hashed_token,
      userId:result.data.user?.id,
      error:result.error
    };
  },
  generateMagicLink:async email=>{
    const result=await admin.auth.admin.generateLink({type:'magiclink',email});
    return {hashedToken:result.data.properties?.hashed_token,error:result.error};
  },
  deleteNewUser:async uid=>{
    await read(admin.auth.admin.deleteUser(uid));
  },
  sendEmail:async (to,subject,html)=>{
    assert.equal(to,athleteEmail);
    assert(subject.includes('Pure Function'));
    assert(html.includes('qa.purefunction.invalid'));
    assert(!html.includes('armshokri-debug.github.io'));
    mail.push({to,subject,html});
    return simulateProviderFailure ?
      {ok:false,status:502,error:'Simulated provider failure'} : {ok:true};
  }
};

try {
  // All SQL writes are to localhost Docker. Production data not exported.
  sql("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;"+
      "GRANT USAGE ON SCHEMA private TO authenticated;"+
      "NOTIFY pgrst, 'reload schema';");
  sql("INSERT INTO private.coach_allowlist(email) VALUES ('"+coachEmail+"'),('"+otherEmail+"')");
  const coach=await actor(coachEmail);
  const other=await actor(otherEmail);
  const stranger=await actor(strangerEmail);
  await read(coach.app.from('clients').insert({
    id:clientId,email:athleteEmail,coach_id:coach.uid,data:{name:'Synthetic Invitation Athlete'}
  }));
  await read(coach.app.from('workouts').insert({
    id:workoutId,client_id:clientId,date:'2026-11-23',
    data:{name:'Synthetic Invitation Workout',exercises:[]}
  }));
  console.log('PASS: fake coaches and client/workout stored in real app schema');

  const foreign=await handleSendInvite(makeReq(other.jwt),deps);
  assert.equal(foreign.status,403);
  const strangerResponse=await handleSendInvite(makeReq(stranger.jwt),deps);
  assert.equal(strangerResponse.status,403);
  assert.equal(mail.length,0);
  console.log('PASS: other coach and stranger denied before email generation');

  // Provider error must not strand a new Auth user and must not start cooldown.
  const mailFailure=await handleSendInvite(makeReq(coach.jwt),deps);
  assert.equal(mailFailure.status,502,'Invitation provider error must propagate safely');
  const missing=await read(admin.rpc('pf_invite_existing_account',{p_email:athleteEmail}));
  assert.equal(missing,null,'Failed email must roll back only freshly created invite user');
  assert.equal(mail.length,1);
  console.log('PASS: simulated provider failure safely rolls back new account');

  simulateProviderFailure=false;
  const accepted=await handleSendInvite(makeReq(coach.jwt),deps);
  assert.equal(accepted.status,200);
  assert.deepEqual(await accepted.json(),{ok:true});
  assert.equal(mail.length,2);
  const match=mail[1].html.match(/invite=([^"&\s]+)/);
  assert(match && match[1].length > 10,'No one-time invite token in captured local message');
  const token=match[1]; // token stays in memory; never printed or persisted
  assert(invitedUid);
  const created=await read(admin.from('profiles').select('role,client_id').eq('id',invitedUid).maybeSingle());
  assert.equal(created?.role,'client');
  assert.equal(created?.client_id,clientId);
  console.log('PASS: owner-only invitation and auth trigger create linked client');

  const doubleClick=await handleSendInvite(makeReq(coach.jwt),deps);
  assert.equal(doubleClick.status,429);
  assert.equal(mail.length,2);
  console.log('PASS: duplicate invitations blocked by cooldown');

  const athlete=client(anon);
  const verified=await athlete.auth.verifyOtp({token_hash:token,type:'invite'});
  if(verified.error) throw Error('Invite token redemption failed: '+(verified.error.code || verified.error.status || 'unknown'));
  assert(verified.data.session?.access_token,'Invite token did not create client session');
  await read(athlete.auth.updateUser({password:'New-Synthetic-8!'+id}));
  await read(athlete.auth.signOut());
  const relogged=client(anon);
  await read(relogged.auth.signInWithPassword({email:athleteEmail,password:'New-Synthetic-8!'+id}));
  const own=await read(relogged.from('clients').select('id').eq('id',clientId));
  const sessionWorkouts=await read(relogged.from('workouts').select('id').eq('id',workoutId));
  const otherCoachWorkouts=await read(other.app.from('workouts').select('id').eq('id',workoutId));
  assert.equal(own.length,1);
  assert.equal(sessionWorkouts.length,1);
  assert.equal(otherCoachWorkouts.length,0);
  console.log('PASS: one-time invitation redemption, password selection, sign-in and tenant isolation');

  const alreadyActive=await handleSendInvite(makeReq(coach.jwt),deps);
  assert.equal(alreadyActive.status,409);
  assert.equal(mail.length,2);
  console.log('PASS: active client cannot receive a second signup invite');

  // Verify real local GoTrue recovery semantics against a confirmed, linked
  // synthetic account. This never generates email or uses hosted QA/Production.
  const oldPassword = 'New-Synthetic-8!' + id;
  const recoveryPassword = 'Recovered-Synthetic-9!' + id;
  await read(relogged.auth.signOut());
  const generatedRecovery = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: athleteEmail
  });
  assert.ifError(generatedRecovery.error);
  const recoveryHash = generatedRecovery.data.properties?.hashed_token;
  assert(recoveryHash && recoveryHash.length > 10, 'No local recovery token');
  const freshRecovery = client(anon);
  const recoveryResult = await read(freshRecovery.auth.verifyOtp({
    token_hash: recoveryHash,
    type: 'recovery'
  }));
  assert.equal(recoveryResult.user?.email, athleteEmail);
  assert(recoveryResult.session?.access_token, 'Recovery token did not make local session');
  await read(freshRecovery.auth.updateUser({password: recoveryPassword}));
  await read(freshRecovery.auth.signOut());
  const oldLogin = await client(anon).auth.signInWithPassword({
    email: athleteEmail, password: oldPassword
  });
  assert(oldLogin.error, 'Old password remained usable after recovery');
  const recovered = client(anon);
  await read(recovered.auth.signInWithPassword({
    email: athleteEmail, password: recoveryPassword
  }));
  assert.equal((await read(recovered.from('clients').select('id').eq('id', clientId))).length, 1);
  const replay = await client(anon).auth.verifyOtp({
    token_hash: recoveryHash, type: 'recovery'
  });
  assert(replay.error, 'Recovery token unexpectedly reusable');
  await read(recovered.auth.signOut());
  console.log('PASS: real local GoTrue recovery, password rotation, old password denial, token replay denial');

  console.log('PASS: real-schema invitation, recovery and signup integration with zero real emails');
} catch (e) {
  console.error('FAIL: isolated invitation integration: ' +
    (e instanceof Error ? e.message.replace(/https?:\/\/\S+/g,'[url]').slice(0,160) : 'unknown'));
  process.exitCode=1;
} finally {
  // All deleted assets are synthetic local Docker users and records.
  if(invitedUid) try{await read(admin.auth.admin.deleteUser(invitedUid))}catch{}
  try{await read(admin.from('clients').delete().eq('id',clientId))}catch{}
  for(const uid of ids) try{await read(admin.auth.admin.deleteUser(uid))}catch{}
}
