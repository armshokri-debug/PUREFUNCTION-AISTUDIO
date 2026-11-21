'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');

const ORIGIN = 'https://rugwzvztweiffprkxfdc.supabase.co';
const APP = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const PUBLIC_KEY = 'sb_publishable_Z0naU2LSCJJNEUFWqkoyHg_0AJo4yiw';
let stage = 'setup', ephemeralId, browser, admin, verified = false;
const pass = label => console.log('PASS ' + label);
const fail = label => { throw new Error(label); };
const random = () => randomBytes(30).toString('base64url');

async function run() {
  try {
    assert(process.env.SUPABASE_SERVICE_ROLE_KEY, 'Missing authorized service secret');
    admin = createClient(ORIGIN, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const anon = createClient(ORIGIN, PUBLIC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    stage = 'read prior client';
    const { data: profiles, error: roleError } =
      await admin.from('profiles').select('id').eq('role', 'client').limit(2);
    assert(!roleError && profiles.length === 1, 'Expected exactly one existing client profile');
    const { data: existing, error: existingError } = await admin.auth.admin.getUserById(profiles[0].id);
    assert(!existingError && existing.user && existing.user.email && existing.user.email_confirmed_at, 'Existing client not eligible for recovery');
    const clientEmail = existing.user.email;
    pass('Existing confirmed client account checked, credentials untouched');

    stage = 'create ephemeral recovery identity';
    const fakeEmail = 'pf-recovery-test-' + randomBytes(10).toString('hex') + '@example.com';
    const oldPassword = random(), newPassword = random();
    const create = await admin.auth.admin.createUser({
      email: fakeEmail, password: oldPassword, email_confirm: true,
      user_metadata: { display_name: 'Ephemeral QA Recovery' }
    });
    assert(!create.error && create.data.user, 'Ephemeral Auth creation failed');
    ephemeralId = create.data.user.id;
    pass('Ephemeral confirmed account created');

    stage = 'request reset in published frontend';
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.getByRole('button', { name: 'Forgot password?' }).click({ timeout: 25000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(fakeEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click({ timeout: 25000 });
    await page.getByRole('status').getByText('If this email has an account', { exact: false }).waitFor({ timeout: 30000 });
    pass('Published Forgot Password UI posted to real reset Edge Function');

    stage = 'generate independent one-time token for same identity';
    const recovery = await admin.auth.admin.generateLink({ type: 'recovery', email: fakeEmail });
    const token = recovery.data && recovery.data.properties && recovery.data.properties.hashed_token;
    assert(!recovery.error && token, 'Supabase did not create an OTP');
    pass('Supabase Auth generated recovery OTP');

    stage = 'verify recovery token in published UI';
    await page.goto(APP + '?reset=' + encodeURIComponent(token), {
      waitUntil: 'domcontentloaded', timeout: 40000
    });
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor({ timeout: 30000 });
    pass('Published frontend verified real recovery token');

    stage = 'update ephemeral account password using frontend';
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.getByText('Password updated successfully').waitFor({ timeout: 30000 });
    pass('Published password update completed');

    stage = 'independent credentials proof';
    const changed = await anon.auth.signInWithPassword({ email: fakeEmail, password: newPassword });
    assert(!changed.error && changed.data.user && changed.data.user.id === ephemeralId, 'New password cannot sign in');
    await anon.auth.signOut();
    const previous = await anon.auth.signInWithPassword({ email: fakeEmail, password: oldPassword });
    assert(previous.error, 'Old password incorrectly still works');
    const replay = await anon.auth.verifyOtp({ type: 'recovery', token_hash: token });
    assert(replay.error, 'Recovery token replay was unexpectedly accepted');
    pass('New password login succeeds; old password and reused token rejected');

    stage = 'existing client reset email request';
    const response = await fetch(ORIGIN + '/functions/v1/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail }),
      signal: AbortSignal.timeout(25000)
    });
    const body = await response.json().catch(() => ({}));
    assert(response.status === 200 && body.ok === true, 'Client reset request rejected');
    pass('Original client live reset request accepted (mail delivery requires separate verification)');
    verified = true;
  } catch (error) {
    console.error('BLOCKED at ' + stage);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (admin && ephemeralId) {
      try {
        const removal = await admin.auth.admin.deleteUser(ephemeralId);
        assert(!removal.error, 'Could not remove ephemeral identity');
        const lookup = await admin.auth.admin.getUserById(ephemeralId);
        assert(lookup.error, 'Ephemeral identity still exists');
        pass('Ephemeral account deleted and verified absent');
      } catch {
        console.error('BLOCKED cleanup: ephemeral user may require manual deletion');
        process.exitCode = 1;
      }
    }
    if (verified && !process.exitCode) pass('Live recovery flow proven; verify original client mailbox separately');
  }
}

run().catch(() => { console.error('BLOCKED unexpected failure'); process.exitCode = 1; });
