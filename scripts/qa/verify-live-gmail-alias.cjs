'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');

const BASE = 'https://rugwzvztweiffprkxfdc.supabase.co';
const APP = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const stageResult = (label) => process.stdout.write('PASS ' + label + '\n');
let stage = 'begin', tempId, admin, browser;

async function run() {
  try {
    assert(process.env.SUPABASE_SERVICE_ROLE_KEY, 'Service-role secret unavailable');
    admin = createClient(BASE, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    stage = 'create disposable Googlemail identity';
    const local = 'pf-alias-qa-' + randomBytes(8).toString('hex');
    const storedEmail = local + '@googlemail.com';
    const enteredEmail = local + '@gmail.com';
    const password = randomBytes(36).toString('base64url');
    const created = await admin.auth.admin.createUser({
      email: storedEmail, password, email_confirm: true,
      user_metadata: { display_name: 'Temporary Alias QA' }
    });
    assert(!created.error && created.data.user, 'Could not create disposable test account');
    tempId = created.data.user.id;
    stageResult('Disposable Googlemail account created');

    stage = 'browser login using opposite Google domain';
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    stage = 'navigate to published site';
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
    stage = 'fill login email';
    await page.getByRole('textbox', { name: 'Email' }).fill(enteredEmail);
    stage = 'fill login password';
    await page.getByLabel('Password', { exact: true }).fill(password);
    stage = 'submit login';
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    stage = 'await authenticated no-access screen';
    await page.getByRole('heading', { name: 'Almost there' }).waitFor({ timeout: 30000 });
    stage = 'verify authenticated browser session';
    const sessionEstablished = await page.evaluate(() => Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k)));
    assert(sessionEstablished, 'Authenticated Supabase browser session not persisted');
    stageResult('Published app signs into existing Googlemail account using Gmail spelling');

    stage = 'existing client forgot-password alias request';
    const p = await admin.from('profiles').select('id').eq('role', 'client').limit(2);
    assert(!p.error && p.data.length === 1, 'Exactly one real client must exist');
    const existing = await admin.auth.admin.getUserById(p.data[0].id);
    assert(!existing.error && existing.data.user && existing.data.user.email, 'Cannot locate original confirmed client');
    const realEmail = existing.data.user.email.toLowerCase();
    assert(realEmail.endsWith('@googlemail.com'), 'Original client is not registered with Googlemail domain');
    const requested = realEmail.replace(/@googlemail\.com$/, '@gmail.com');
    const res = await fetch(BASE + '/functions/v1/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: requested }), signal: AbortSignal.timeout(25000)
    });
    const data = await res.json().catch(() => ({}));
    assert(res.status === 200 && data.ok === true, 'Aliased password reset endpoint rejected request');
    stageResult('Real original client reset request accepted with Gmail alias (no password changed)');
  } catch (err) {
    console.error('BLOCKED at ' + stage);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (admin && tempId) {
      try {
        const removed = await admin.auth.admin.deleteUser(tempId);
        assert(!removed.error, 'Removal rejected');
        const check = await admin.auth.admin.getUserById(tempId);
        assert(check.error, 'Disposable account still exists');
        stageResult('Disposable Auth identity deleted and verified absent');
      } catch {
        console.error('BLOCKED: temporary test user cleanup failed');
        process.exitCode = 1;
      }
    }
  }
}
run().catch(() => { console.error('BLOCKED unexpected live test failure'); process.exitCode = 1; });
