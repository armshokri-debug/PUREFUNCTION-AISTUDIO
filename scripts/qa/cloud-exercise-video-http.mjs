#!/usr/bin/env node
/**
 * Cloud QA-only real Storage HTTP acceptance.
 * Requires two EXISTING, confirmed, allowlisted synthetic coaches (@qa.invalid).
 * This runner NEVER signs up accounts, invokes email functions, edits Production,
 * changes policies or creates/updates exercise records.
 *
 * PF_QA_STORAGE_ACCEPT=RUN_QA_ONLY
 * QA_COACH_A_EMAIL, QA_COACH_A_PASSWORD
 * QA_COACH_B_EMAIL, QA_COACH_B_PASSWORD
 * QA_SUPABASE_PUBLISHABLE_KEY
 * node scripts/qa/cloud-exercise-video-http.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'nsshdxxdvzzxlmdomixf';
const QA_URL = `https://${PROJECT_REF}.supabase.co`;
const BUCKET = 'exercise-videos';
assert.equal(process.env.PF_QA_STORAGE_ACCEPT, 'RUN_QA_ONLY',
  'BLOCKED: explicit QA-only confirmation required');
const publishableKey = process.env.QA_SUPABASE_PUBLISHABLE_KEY;
assert(publishableKey?.startsWith('sb_publishable_'),
  'BLOCKED: only QA publishable key is supported; no service role key');
const creds = [
  [process.env.QA_COACH_A_EMAIL, process.env.QA_COACH_A_PASSWORD],
  [process.env.QA_COACH_B_EMAIL, process.env.QA_COACH_B_PASSWORD]
];
for (const [email,password] of creds) {
  assert(/^[a-z0-9._+\-]+@qa\.invalid$/i.test(email ?? ''),
    'BLOCKED: credentials must belong to synthetic @qa.invalid users');
  assert(password?.length, 'BLOCKED: QA synthetic user password required');
}
assert.notEqual(creds[0][0]?.toLowerCase(),creds[1][0]?.toLowerCase(),
  'BLOCKED: two different QA coach accounts required');

function newClient() {
  return createClient(QA_URL,publishableKey,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
  });
}
const [a,b] = [newClient(),newClient()];
let path;
let forbiddenPath;
let ownerId;
let uploaded = false;
let cleared = false;
let forbiddenUploadCreated = false;
let passed = false;
async function ok(promise,label) {
  const {data,error}=await promise;
  if (error) throw Error(`${label}: ${error.code || error.status || 'API error'}`);
  return data;
}
async function verifyCoach(client,email,password,label) {
  const session=await ok(client.auth.signInWithPassword({email,password}),label+' login');
  assert(session.user?.id,'BLOCKED: authenticated identity missing');
  const profile=await ok(client.from('profiles').select('role').eq('id',session.user.id).single(),label+' profile');
  assert.equal(profile.role,'coach','BLOCKED: synthetic account is not a coach');
  assert.equal(session.user.email?.toLowerCase(),email.toLowerCase(),'BLOCKED: mismatched QA login');
  return session.user.id;
}
try {
  ownerId=await verifyCoach(a,...creds[0],'owner');
  const secondId=await verifyCoach(b,...creds[1],'second coach');
  assert.notEqual(ownerId,secondId,'BLOCKED: same account twice');
  path=`${ownerId}/qa-storage-accept-${randomUUID()}/sample.mp4`;
  forbiddenPath=`${ownerId}/qa-storage-accept-${randomUUID()}/forbidden.mp4`;
  const payload=Buffer.from('PUREFUNCTION_QA_HTTP_STORAGE_SYNTHETIC_ONLY');
  await ok(a.storage.from(BUCKET).upload(path,payload,{
    contentType:'video/mp4',upsert:false
  }),'owner upload');
  uploaded=true;
  const attemptedUpload=await b.storage.from(BUCKET).upload(forbiddenPath,payload,{
    contentType:'video/mp4',upsert:false
  });
  forbiddenUploadCreated=!attemptedUpload.error;
  assert(attemptedUpload.error,'SECURITY FAILURE: other coach uploaded into owner folder');
  const otherRead=await ok(b.storage.from(BUCKET).download(path),'second coach read shared video');
  assert.deepEqual(Buffer.from(await otherRead.arrayBuffer()),payload,
    'Cross-coach shared video data was corrupted');
  const attemptedDelete=await b.storage.from(BUCKET).remove([path]);
  const claimsDeletion=!attemptedDelete.error && attemptedDelete.data?.some(x=>x.name===path);
  assert(!claimsDeletion,'SECURITY FAILURE: other coach deleted video');
  const afterAttack=await ok(a.storage.from(BUCKET).download(path),'verify non-owner did not delete');
  assert.deepEqual(Buffer.from(await afterAttack.arrayBuffer()),payload,
    'SECURITY FAILURE: non-owner deletion removed/changed the video');
  const removed=await ok(a.storage.from(BUCKET).remove([path]),'owner delete');
  assert(removed?.some(x=>x.name===path),'Owner delete did not confirm the file path');
  const downloadAfter=await a.storage.from(BUCKET).download(path);
  assert(downloadAfter.error,'SECURITY FAILURE: deleted video is still available');
  cleared=true;
  passed=true;
  console.log('PASS: cloud QA actual authenticated Storage HTTP (two synthetic coaches)');
  console.log('PASS: owner upload/delete, cross-coach upload/delete rejected, shared read, object gone');
} catch (e) {
  console.error('FAIL: QA HTTP acceptance: '+(e instanceof Error?e.message:'unknown'));
  process.exitCode=1;
} finally {
  // Only this run's random synthetic paths can be removed. Never touch existing videos.
  if (forbiddenUploadCreated && forbiddenPath) {
    const accidental = await a.storage.from(BUCKET).remove([forbiddenPath]);
    const absent = await a.storage.from(BUCKET).download(forbiddenPath);
    if (accidental.error || !absent.error) {
      console.error('BLOCKED: unexpected cross-owner fixture cleanup failed: '+forbiddenPath);
      process.exitCode=1;
    }
  }
  if (uploaded && !cleared && path) {
    try {
      const removed=await a.storage.from(BUCKET).remove([path]);
      const check=await a.storage.from(BUCKET).download(path);
      cleared=Boolean(!removed.error && check.error);
    } catch { cleared=false; }
    if (!cleared) {
      console.error('BLOCKED: synthetic QA video cleanup could not be verified: '+path);
      process.exitCode=1;
    }
  }
  await Promise.allSettled([a.auth.signOut(),b.auth.signOut()]);
}
if (passed && !cleared) process.exitCode=1;
