'use strict';

/**
 * One-time live recovery acceptance: uses a fresh, disposable Auth account,
 * and only sends a recovery message (never changes the password) for the existing client.
 * No passwords, tokens, addresses, or personal data are written to logs.
 */
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');

const BASE = 'https://rugwzvztweiffprkxfdc.supabase.co';
const APP = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const ANON = 'sb_publishable_Z0naU2LSCJJNEUFWqkoyHg_0AJo4yiw';
const ADMIN_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;
let stage = 'init';
let temporaryUserId = null;
let admin;
let browser;
let success = false;

function secret() { return crypto.randomBytes(32).toString('base64url'); }
function result(label) { process.stdout.write('PASS: ' + label + '\n'); }

(async () => {
  try {
    assert(ADMIN_SECRET && ADMIN_SECRET.length > 40, 'Admin connection unavailable');
    admin = createClient(BASE, ADMIN_SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
    const anon = createClient(BASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

    stage = 'verify existing client';
    const [clientProfiles, coachProfiles] = await Promise.all([
      admin.from('profiles').select('id').eq('role', 'client').limit(5),
      admin.from('profiles').select('id').eq('role', 'coach').limit(5)
    ]);
    assert(!clientProfiles.error && clientProfiles.data?.length === 1, 'Client role missing or ambiguous');
    assert(!coachProfiles.error && coachProfiles.data?.length === 1, 'Coach role missing or ambiguous');
    const [clientResponse, coachResponse] = await Promise.all([
      admin.auth.admin.getUserById(clientProfiles.data[0].id),
      admin.auth.admin.getUserById(coachProfiles.data[0].id)
    ]);
    const clientAccount = clientResponse.data?.user;
    const coachAccount = coachResponse.data?.user;
    assert(clientAccount?.email_confirmed_at && clientAccount?.email && clientAccount?.last_sign_in_at, 'Existing client is not a confirmed active Auth account');
    assert(coachAccount?.email && coachAccount.email.endsWith('@gmail.com'), 'Test mailbox must be a configured Gmail account');
    result('Original client exists, confirmed, and has logged in');

    stage = 'create isolated synthetic identity';
    const coachLocalPart = coachAccount.email.split('@')[0];
    const testEmail = coachLocalPart + '+pf-recovery-check-' + crypto.randomBytes(6).toString('hex') + '@gmail.com';
    const oldPassword = secret();
    const newPassword = secret();
    const created = await admin.auth.admin.createUser({
      email: testEmail,
      password: oldPassword,
      email_confirm: true,
      user_metadata: { display_name: 'Temporary Recovery QA' }
    });
    assert(!created.error && created.data?.user?.id, 'Could not provision temporary account');
    temporaryUserId = created.data.user.id;
    result('Disposable Auth account created');

    stage = 'live Forgot Password browser request';
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.getByRole('button', { name: 'Forgot password?' }).click({ timeout: 20000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(testEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await page.getByRole('status').getByText('If this email has an account', { exact: false }).waitFor({ timeout: 25000 });
    result('Live Forgot Password screen accepted a real test account');

    stage = 'issue independent recovery token';
    const generated = await admin.auth.admin.generateLink({ type: 'recovery', email: testEmail });
    const token = generated.data?.properties?.hashed_token;
    assert(!generated.error && token && /^[A-Za-z0-9_-]{10,}$/.test(token), 'Could not generate recovery link');
    // This link exercises the exact same Supabase verifyOtp path as the emailed link.

    stage = 'live recovery link in browser';
    await page.goto(APP + '?reset=' + encodeURIComponent(token), { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor({ timeout: 30000 });
    result('Recovery link verified by live Supabase Auth and opened password-change screen');

    stage = 'change password in live browser';
    await page.getByRole('textbox', { name: 'New password' }).fill(newPassword);
    await page.getByRole('textbox', { name: 'Confirm new password' }).fill(newPassword);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.getByText('Password updated successfully').waitFor({ timeout: 30000 });
    result('Password successfully changed in live app');

    stage = 'verify new password sign-in';
    const newSignIn = await anon.auth.signInWithPassword({ email: testEmail, password: newPassword });
    assert(!newSignIn.error && newSignIn.data?.user?.id === temporaryUserId, 'New password failed independent sign-in');
    await anon.auth.signOut();
    const oldSignIn = await anon.auth.signInWithPassword({ email: testEmail, password: oldPassword });
    assert(oldSignIn.error, 'Old password incorrectly accepted');
    result('New password login succeeds; old password is rejected');

    stage = 'request reset for existing client without changing credentials';
    const request = await fetch(BASE + '/functions/v1/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientAccount.email }),
      signal: AbortSignal.timeout(25000)
    });
    const response = await request.json().catch(() => ({}));
    assert(request.status === 200 && response.ok === true, 'Existing-client reset request not accepted');
    result('Existing client reset request accepted by deployed endpoint; credentials untouched');
    success = true;
  } catch (e) {
    process.stderr.write('BLOCKED: Live password recovery at step ' + stage + '\n');
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (admin && temporaryUserId) {
      stage = 'cleanup';
      try {
        const deletion = await admin.auth.admin.deleteUser(temporaryUserId);
        if (deletion.error) throw Error('Delete failed');
        const check = await admin.auth.admin.getUserById(temporaryUserId);
        assert(check.error, 'Temporary account still exists');
        result('Temporary test identity removed from production');
      } catch {
        process.stderr.write('BLOCKED: Temporary test identity cleanup failed; manual cleanup required\n');
        process.exitCode = 1;
      }
    }
    if (success && !process.exitCode) result('Live recovery acceptance finished; confirm email delivery independently');
  }
})();