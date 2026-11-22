// Cloud end-to-end: coach and client on separate devices against the in-memory Supabase.
// Usage: node e2e/cloud-flow.cjs <dist dir built with VITE_SUPABASE_URL=https://mock.supabase.co> [shots dir]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const createMock = require('./mock-supabase.cjs');

const root = process.argv[2];
const shots = process.argv[3];
const PORT = 4193;
const srv = http
  .createServer((q, r) => {
    let f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': type });
    r.end(fs.readFileSync(f));
  })
  .listen(PORT);

let failures = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  if (!c) failures++;
};
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = iso(new Date());

(async () => {
  const mock = createMock({ coachEmail: 'coach@example.com' });
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  const open = async (viewport) => {
    const ctx = await b.newContext({ viewport });
    await ctx.route('https://mock.supabase.co/**', mock.handler);
    await ctx.routeWebSocket(/wss:\/\/mock\.supabase\.co\/.*/, mock.wsHandler);
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`http://localhost:${PORT}/`);
    return p;
  };
  const verify = async (p, email) => {
    const mail = [...mock.db.emails].reverse().find(e => e.kind === 'verify' && e.to === email.toLowerCase());
    if (mail) await p.goto(`http://localhost:${PORT}/?verify=${mail.token}`);
  };
  const signUp = async (p, name, email, pw, who = 'client') => {
    await p.getByRole('tab', { name: who === 'coach' ? 'I’m the coach' : 'I’m a client' }).click();
    await p.getByRole('button', { name: who === 'coach' ? 'Create coach account' : 'Set up your account' }).click();
    if (name) await p.getByLabel('Your name').fill(name);
    await p.getByLabel('Email').fill(email);
    await p.getByLabel('Password').fill(pw);
    await p.locator('form button[type=submit]').click();
    await p.waitForTimeout(300);
    await verify(p, email);
  };
  const shot = (p, n) => shots && p.screenshot({ path: `${shots}/${n}.png` });

  /* ---------------- stranger can't sign up ---------------- */
  const S = await open({ width: 390, height: 844 });
  await S.getByRole('heading', { name: 'Client sign in' }).waitFor();
  ok(true, 'signed-out visitor sees client sign-in by default');
  await S.getByRole('tab', { name: 'I’m the coach' }).click();
  ok(await S.getByRole('heading', { name: 'Coach sign in' }).isVisible(), 'separate coach sign-in');
  await signUp(S, 'Eve', 'eve@example.com', 'password123');
  ok(!mock.db.users.some(u => u.email === 'eve@example.com'), 'unknown email cannot create an account');
  await shot(S, 'cloud-signup-blocked');

  /* ---------------- coach ---------------- */
  const C = await open({ width: 1440, height: 900 });
  await signUp(C, 'Armin', 'Coach@Example.com', 'coachpass1', 'coach');
  await C.getByRole('heading', { name: 'Clients' }).waitFor();
  ok(await C.getByText(/No clients yet/).isVisible(), 'new coach starts with an empty roster (no sample data)');
  ok(mock.db.profiles.some((p) => p.role === 'coach'), 'coach profile created for the coach email');
  await shot(C, 'cloud-coach-empty');

  // add a client
  await C.getByRole('button', { name: 'Add client' }).click();
  // Regression: starting phase guidance follows the coach's chosen phase.
  const startingPhase = C.locator('select').filter({ has: C.locator('option[value="1-Reposition"]') });
  await startingPhase.selectOption('2-Integrate');
  ok(await C.getByText(/Integrate: use coordinated, functional movement/).isVisible(), 'phase 2 shows Integrate guidance during onboarding');
  await startingPhase.selectOption('1-Reposition');
  ok(await C.getByText(/Reposition: start with breathing, positioning/).isVisible(), 'phase 1 shows Reposition guidance during onboarding');
  await C.getByPlaceholder('e.g., Jordan Taylor').fill('Ryan Lee');
  await C.getByPlaceholder('jordan.taylor@example.com').fill('ryan.typo@example.com');
  await C.locator('form button[type=submit]').click();
  await C.waitForTimeout(800);
  ok(await C.getByText('Not joined yet — send them a secure invitation below.').isVisible(), 'after adding a client the invite sheet opens (no jump to Assessment)');
  await C.getByRole('button', { name: 'Close', exact: true }).last().click();
  await C.waitForTimeout(800);
  // Edit Client and Send Invite are clearly separated actions
  ok(await C.getByRole('button', { name: 'Send Invite', exact: true }).isVisible(), 'unjoined never-invited client shows Send Invite');
  await C.getByRole('button', { name: 'Edit Client', exact: true }).click();
  const emailBox = C.locator('input[type=email]');
  await emailBox.fill('Ryan@Example.com');
  await C.getByRole('button', { name: 'Save changes' }).click();
  await C.waitForTimeout(1500);
  const ryanRow = mock.db.clients.find((c) => c.email === 'ryan@example.com');
  ok(!!ryanRow, 'coach corrected the email; saved lower-cased');
  ok(ryanRow && ryanRow.data && ryanRow.data.inBody.weight === 0, 'new client has empty assessment data (no sample numbers)');

  // Send Invite, confirm Resend Invite appears afterwards, and edit reminders in Edit Client
  await C.getByRole('button', { name: 'Send Invite', exact: true }).click();
  await C.getByRole('dialog').getByRole('button', { name: 'Send Invite', exact: true }).click();
  await C.getByText(/Invitation request accepted by the mail service/).waitFor({ timeout: 5000 });
  ok(mock.db.emails.some((e) => e.kind === 'invite' && e.to === 'ryan@example.com'), 'coach emails the invite in one tap');
  await C.getByRole('button', { name: 'Close', exact: true }).last().click();
  await C.waitForTimeout(500);
  ok(await C.getByRole('button', { name: 'Resend Invite', exact: true }).isVisible(), 'invited-not-joined client shows Resend Invite');
  await C.getByRole('button', { name: 'Edit Client', exact: true }).click();
  await C.getByLabel('Morning email on workout days').uncheck();
  await C.getByRole('button', { name: 'Save changes' }).click();
  await C.waitForTimeout(1200);
  ok(mock.db.clients.find((c) => c.id === ryanRow.id).data.emailReminders === false, 'coach can turn off morning emails for a client');

  // build a workout for today
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('heading', { name: 'Workout Builder' }).waitFor({ timeout: 5000 }).catch(() => {});
  ok(await C.getByRole('heading', { name: 'Workout Builder' }).isVisible(), 'clicking a client opens their workouts');
  await C.getByRole('button', { name: 'Create workout' }).click();
  await C.getByPlaceholder(/Search name or muscle/).fill('goblet squat');
  await C.waitForTimeout(300);
  await C.getByRole('button', { name: 'Add Goblet Squat' }).first().click();
  await C.locator('input[placeholder="8-10"]').first().fill('8-10');
  await C.locator('label:has-text("lb") input[type=number]').first().fill('40');
  await C.waitForTimeout(1500);
  const w = mock.db.workouts.find((x) => x.client_id === ryanRow.id && x.date === today);
  ok(!!w && w.data.blocks.length === 1 && Math.abs(w.data.blocks[0].loadKg - 18.1437) < 0.05, '40 lb displayed and kg persisted to the cloud (one row per workout)');
  ok(await C.getByText('Saved', { exact: true }).first().isVisible(), 'sync badge shows Saved');
  // The explicit save control must use the existing cloud store and remain usable.
  const saveNow = C.getByRole('button', { name: 'Save now', exact: true });
  ok(await saveNow.isVisible(), 'workout editor exposes an explicit Save now action');
  await saveNow.click();
  await C.getByText('All changes saved', { exact: true }).waitFor({ timeout: 5000 });
  ok(mock.db.workouts.some(x => x.id === w.id), 'manual save retains the existing cloud workout');
  // Repeated clean saves must release the single-flight lock. The next Sets
  // edits below must still reach the server after these no-op flushes.
  for (let attempt = 0; attempt < 2; attempt++) {
    await saveNow.click();
    await C.getByText('All changes saved', { exact: true }).waitFor({ timeout: 5000 });
  }
  ok(await saveNow.isEnabled(), 'repeated no-op saves release the save lock');
  // Regression: clearing Sets must not immediately force zero, and commit must persist.
  const setsField = C.getByLabel('Sets', { exact: true }).first();
  await setsField.fill('');
  ok(await setsField.inputValue() === '', 'Sets field can be cleared while typing (no forced zero)');
  await setsField.fill('12');
  await setsField.blur();
  await C.waitForTimeout(1000);
  ok(mock.db.workouts.find(x => x.id === w.id)?.data.blocks[0].sets === 12, 'replacing Sets persists 12 in cloud mock');
  await setsField.fill('4');
  await setsField.blur();
  await C.waitForTimeout(1000);
  ok(mock.db.workouts.find(x => x.id === w.id)?.data.blocks[0].sets === 4, 'replacing Sets persists 4 in cloud mock');

  const repsField = C.getByLabel('Reps', { exact: true }).first();
  await repsField.fill('');
  ok(await repsField.inputValue() === '', 'Reps field can be cleared while typing');
  await repsField.fill('AMRAP');
  await repsField.blur();
  await C.waitForTimeout(1000);
  ok(mock.db.workouts.find(x => x.id === w.id)?.data.blocks[0].reps === 'AMRAP', 'repetition text AMRAP persists');
  await repsField.fill('8-10');
  await repsField.blur();
  await C.waitForTimeout(1000);
  ok(mock.db.workouts.find(x => x.id === w.id)?.data.blocks[0].reps === '8-10', 'repetition range persists');

  // Regression: returning to the client's program preserves the selected week.
  await C.getByRole('button', { name: 'Next week', exact: true }).click();
  await C.getByRole('button', { name: 'All clients' }).click();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  ok(await C.getByRole('button', { name: 'This week' }).isVisible(), 'workout calendar retains selected future week when reopening client');
  await C.getByRole('button', { name: 'This week' }).click();

  await shot(C, 'cloud-coach-builder');

  // Private notes use the secure table and never enter clients.data.
  await C.getByRole('button', { name: 'Notes', exact: true }).click();
  await C.getByPlaceholder(/Left knee tight/).fill('Private recovery note');
  await C.getByRole('button', { name: 'Save note', exact: true }).click();
  await C.getByText('Private recovery note', { exact: true }).waitFor();
  ok(mock.db.coach_notes_secure.length === 1, 'coach note persists in secure table');
  ok(!mock.db.clients.find(c => c.id === ryanRow.id).data.coachNotes, 'private note is absent from client JSON');
  await C.getByRole('button', { name: 'Exercises', exact: true }).click();

  /* ---------------- client ---------------- */
  const R = await open({ width: 375, height: 812 });
  const invitation = [...mock.db.emails].reverse().find(e => e.kind === 'invite' && e.to === 'ryan@example.com');
  ok(!!invitation?.token, 'one-time invite email contains a signed verification token');
  ok(!mock.db.users.find(u => u.email === 'ryan@example.com').password, 'pending invite cannot be used for password login');
  ok(!mock.db.emails.some(e => e.to === 'ryan@example.com' && e.kind === 'verify'), 'no extra verification email');
  await R.goto(`http://localhost:${PORT}/?invite=${encodeURIComponent(invitation.token)}`);
  await R.getByRole('heading', { name: 'Accept your invitation' }).waitFor();
  ok(await R.getByText(/No second email needed/).isVisible(), 'one-email onboarding shown to client');
  await R.reload();
  await R.getByRole('heading', { name: 'Accept your invitation' }).waitFor();
  ok(true, 'unfinished invitation remains safely password-gated after refresh');
  // A second tab shares Supabase localStorage but must not bypass password selection.
  const OtherTab = await R.context().newPage();
  await OtherTab.goto(`http://localhost:${PORT}/`);
  await OtherTab.getByRole('heading', { name: 'Accept your invitation' }).waitFor({ timeout: 10000 });
  ok(await OtherTab.getByText('Goblet Squat').count() === 0, 'new tab cannot open client workspace before invite password is set');
  await OtherTab.close();
  await R.getByLabel('Create password').fill('ryanpass1');
  await R.getByLabel('Confirm password').fill('ryanpass1');
  await R.getByRole('button', { name: 'Create password & continue' }).click();
  await R.getByRole('heading', { name: /Goblet Squat/ }).first().waitFor({ timeout: 10000 });
  ok(true, 'client accepts invite, creates password and enters workouts without another email');
  const Replay = await open({ width: 375, height: 812 });
  await Replay.goto(`http://localhost:${PORT}/?invite=${encodeURIComponent(invitation.token)}`);
  await Replay.getByText('This invitation has expired or was already used. Ask your coach to resend it.').waitFor({ timeout: 10000 });
  ok(await Replay.getByRole('heading', { name: 'Client sign in' }).isVisible(), 'spent invitation cannot re-enter workspace');
  await Replay.close();
  ok((await R.getByRole('button', { name: 'Coach' }).count()) === 0, 'client has no coach switch');
  ok((await R.getByText(/Workouts this week/).count()) === 0, 'client cannot see the coach screens');
  await shot(R, 'cloud-client-today');
  ok(!(await R.getByText('Private recovery note', { exact: true }).count()), 'private coach note is not rendered for client');
  await R.getByLabel('Food and portion', { exact: true }).fill('Yogurt, one serving');
  await R.getByLabel('Calories (kcal)', { exact: true }).fill('120');
  await R.getByLabel('Protein (g)', { exact: true }).fill('15');
  await R.getByRole('button', { name: 'Save meal', exact: true }).click();
  await R.getByText(/120 kcal/).waitFor();
  ok(mock.db.food_entries.length === 1 && mock.db.food_items[0].protein === 15, 'client food diary uses normalized secure RPC');

  ok(!(await R.evaluate(() => location.search.includes('invite='))), 'invite parameter removed after sign-in');
  // live: coach adds an exercise -> appears on client without reload
  await C.getByPlaceholder(/Search name or muscle/).fill('romanian deadlift');
  await C.waitForTimeout(300);
  await C.getByRole('button', { name: /^Add Romanian Deadlift$/ }).first().click();
  await R.getByRole('heading', { name: 'Romanian Deadlift' }).waitFor({ timeout: 8000 }).catch(() => {});
  ok(await R.getByRole('heading', { name: 'Romanian Deadlift' }).isVisible(), 'coach change appears live on the client’s phone');

  // client logs and finishes
  const postsBefore = mock.log.filter((l) => l.startsWith('POST /rest/v1/workouts')).length;
  await R.locator('[aria-label="Complete set 1"]').first().click();
  await R.getByRole('button', { name: 'Skip' }).click().catch(() => {});
  await R.getByRole('button', { name: '8', exact: true }).first().click();
  await R.getByRole('button', { name: 'Finish workout' }).click();
  await R.getByRole('button', { name: '7', exact: true }).last().click();
  await R.getByPlaceholder(/How did it feel/).fill('Felt strong');
  await R.getByRole('button', { name: /^Finish workout \(/ }).click();
  await R.waitForTimeout(1500);
  const wAfter = mock.db.workouts.find((x) => x.client_id === ryanRow.id && x.date === today);
  ok(wAfter.data.status === 'completed' && wAfter.data.sessionRpe === 7, 'client results saved to the cloud');
  ok(mock.log.filter((l) => l.startsWith('POST /rest/v1/workouts')).length - postsBefore <= 6, 'client sends only small, changed-row writes');

  // coach sees it live
  await C.getByText('Felt strong').waitFor({ timeout: 8000 }).catch(() => {});
  ok(await C.getByText('Felt strong').isVisible(), 'coach sees the client’s feedback live');
  ok(await C.getByText(/Session RPE 7\/10/).isVisible(), 'coach sees session RPE');

  // no echo loop: wait and make sure the coach did not re-upload what it received
  const coachPosts = mock.log.filter((l) => l.startsWith('POST /rest/v1/workouts')).length;
  await C.waitForTimeout(2500);
  ok(mock.log.filter((l) => l.startsWith('POST /rest/v1/workouts')).length === coachPosts, 'no echo uploads after live updates');

  // client photo syncs to the coach
  await R.locator('input[type=file][accept^="image"]').setInputFiles(path.join(__dirname, 'fixtures', 'face.png'));
  await R.waitForTimeout(1500);
  ok(!!mock.db.clients.find((c) => c.id === ryanRow.id).data.photoUrl, 'client photo saved to the cloud');
  await C.getByRole('button', { name: 'Clients' }).first().click();
  await C.waitForTimeout(800);
  ok((await C.locator('main img').count()) >= 1, 'coach sees the client’s photo');
  ok(
    (await C.getByRole('button', { name: /^(Send Invite|Resend Invite)$/ }).count()) === 0,
    'joined client no longer shows Send Invite or Resend Invite'
  );
  // Active client shows Account Access guidance (sign-in + Forgot password) without invite-send button
  await C.getByRole('button', { name: /More actions for Ryan Lee/i }).click();
  await C.getByRole('menuitem', { name: 'Account Access', exact: true }).click();
  ok(
    await C.getByText(/Forgot password/i).isVisible() &&
      (await C.getByRole('dialog').getByRole('button', { name: /^(Send Invite|Resend Invite)$/ }).count()) === 0,
    'active client shows sign-in and Forgot password recovery guidance without a new invite button'
  );
  await C.getByRole('button', { name: 'Close', exact: true }).last().click();

  // reload: data comes back from the cloud, session kept
  await R.reload();
  await R.getByText('Workout completed').waitFor({ timeout: 10000 }).catch(() => {});
  ok(await R.getByText('Workout completed').isVisible(), 'after reload the client is still signed in and sees saved results');

  /* ---------------- coach uploads a video, client can play it ---------------- */
  await C.getByRole('button', { name: 'Library' }).first().click();
  await C.getByRole('button', { name: 'New exercise' }).click();
  await C.locator('input[type=file][accept^="video"]').setInputFiles(path.join(__dirname, 'fixtures', 'demo.webm'));
  await C.getByText(/checked, plays fine/).waitFor({ timeout: 15000 });
  await C.getByPlaceholder('e.g. Left AIC Split Squat').fill('Ryan Wall Drill');
  await C.getByRole('button', { name: 'Save' }).click();
  await C.waitForTimeout(2000);
  const files = Object.keys(mock.db.files);
  ok(files.length === 1, 'video uploaded to cloud storage (' + files.join(',') + ')');
  const exRow = mock.db.exercises.find((e) => e.data.name === 'Ryan Wall Drill');
  ok(exRow && exRow.data.video.kind === 'storage', 'exercise with cloud video saved to the database');
  // Playwright can't read the bytes of an uploaded File body, so check the chain instead:
  // upload -> signed link requested -> the player loads that private link.
  const src = await C.locator('video[controls]').getAttribute('src');
  ok(/\/storage\/v1\/object\/sign\/exercise-videos\/.+\?token=/.test(src || ''), 'player uses a short-lived signed link to the private video');
  ok(mock.log.some((l) => l.startsWith('GET /storage/v1/object/sign/exercise-videos/')), 'browser fetched the video through that link');

  // Failed library writes keep the editor open and preserve existing media.
  await C.getByRole('button', { name: 'New exercise' }).click();
  await C.getByPlaceholder('e.g. Left AIC Split Squat').fill('Unconfirmed exercise');
  mock.db.failNextExerciseWrite = true;
  await C.getByRole('button', { name: 'Save', exact: true }).click();
  await C.getByText(/Exercise was not saved/).waitFor();
  ok(!mock.db.exercises.some(e => e.data.name === 'Unconfirmed exercise'), 'failed exercise write is not presented as saved');
  ok(Object.keys(mock.db.files).length === 1, 'failed edit preserves existing video');
  await C.getByRole('button', { name: 'Close', exact: true }).click();

  /* ---------------- private assessment video for Ryan ---------------- */
  await C.getByRole('button', { name: 'Clients' }).first().click();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: 'Confirm & next' }).click();
  for (let i = 0; i < 4; i++) await C.getByRole('button', { name: 'Save & next' }).click();
  await C.locator('input[type=file][accept^="video"]').setInputFiles(path.join(__dirname, 'fixtures', 'demo.webm'));
  await C.getByText('Overhead squat · Front').waitFor({ timeout: 15000 });
  const clipKeys = Object.keys(mock.db.clientFiles);
  ok(clipKeys.length === 1 && clipKeys[0].startsWith(ryanRow.id + '/'), 'assessment video stored in the client’s private folder (' + clipKeys.join(',') + ')');
  await C.getByRole('button', { name: 'Complete Assessment' }).click();
  await C.waitForTimeout(1500);
  await R.getByRole('button', { name: 'Progress', exact: true }).click();
  await R.locator('section', { hasText: 'Before / after' }).waitFor({ timeout: 8000 }).catch(() => {});
  ok(await R.locator('section', { hasText: 'Before / after' }).isVisible(), 'client sees their assessment video');
  ok(mock.log.some((l) => l.startsWith('POST /storage/v1/object/sign/client-videos/' + ryanRow.id)), 'client got a signed link to their own video');
  await R.getByRole('button', { name: /Today/ }).click();

  /* ---------------- client cannot write exercises / others' data ---------------- */
  const tokenR = mock.db.profiles.find((p) => p.role === 'client').id;
  const res = await R.evaluate(async (tok) => {
    const h = { apikey: 'x', Authorization: 'Bearer tok-' + tok, 'Content-Type': 'application/json' };
    const a = await fetch('https://mock.supabase.co/rest/v1/exercises', { method: 'POST', headers: h, body: JSON.stringify({ id: 'x', data: {} }) });
    return a.status;
  }, tokenR);
  ok(res === 403, 'client cannot add exercises (403)');

  /* ---------------- sign out ---------------- */
  await R.getByRole('button', { name: 'Sign out' }).first().click();
  await R.getByRole('heading', { name: 'Client sign in' }).waitFor({ timeout: 5000 }).catch(() => {});
  ok(await R.getByRole('heading', { name: 'Client sign in' }).isVisible(), 'client can sign out (back to client sign-in)');

  // Correct credentials on the wrong portal must never mount any workspace.
  await R.getByRole('tab', { name: 'I’m the coach' }).click();
  await R.getByLabel('Email').fill('ryan@example.com');
  await R.getByLabel('Password').fill('ryanpass1');
  await R.getByRole('button', { name: 'Sign in', exact: true }).click();
  await R.getByText('This is a client account. Choose “I’m a client” to sign in.', { exact: true }).waitFor();
  ok(await R.getByRole('heading', { name: 'Coach sign in', exact: true }).isVisible(), 'client credentials are refused on Coach portal');
  ok((await R.getByText('Workout completed', { exact: true }).count()) === 0, 'wrong-portal login mounts no client workspace');
  await R.reload();
  await R.getByRole('heading', { name: 'Coach sign in', exact: true }).waitFor();
  ok(true, 'refused login leaves no persistent authenticated session');
  await R.getByRole('tab', { name: 'I’m a client' }).click();
  await R.getByLabel('Email').fill('coach@example.com');
  await R.getByLabel('Password').fill('coachpass1');
  await R.getByRole('button', { name: 'Sign in', exact: true }).click();
  await R.getByText('This is a coach account. Choose “I’m the coach” to sign in.', { exact: true }).waitFor();
  ok(await R.getByRole('heading', { name: 'Client sign in', exact: true }).isVisible(), 'coach credentials are refused on Client portal');
  ok((await R.getByRole('heading', { name: 'Clients', exact: true }).count()) === 0, 'wrong-portal login mounts no coach workspace');
  ok(await C.getByRole('button', { name: 'Sign out' }).first().isVisible(), 'refusal signs out only this device, retaining coach session elsewhere');

  // wrong password
  await R.getByLabel('Email').fill('ryan@example.com');
  await R.getByLabel('Password').fill('wrongpass');
  await R.getByRole('button', { name: 'Sign in' }).click();
  await R.getByText('Email or password is not correct.').waitFor({ timeout: 8000 }).catch(() => {});
  ok(await R.getByText('Email or password is not correct.').isVisible(), 'wrong password shows a clear message');
  await R.getByLabel('Password').fill('ryanpass1');
  await R.getByRole('button', { name: 'Sign in' }).click();
  await R.getByText('Workout completed').waitFor({ timeout: 10000 }).catch(() => {});
  ok(await R.getByText('Workout completed').isVisible(), 'client can sign back in');

  // Messaging is exercised through the real UI and active table, never legacy messages.
  await C.getByRole('button', { name: 'Messages', exact: true }).first().click();
  await C.getByRole('button', { name: /Ryan Lee/ }).first().click();
  await R.getByRole('button', { name: 'Chat', exact: true }).click();
  await R.getByPlaceholder('Message Coach…').fill('Ready for the next session');
  await R.getByRole('button', { name: 'Send', exact: true }).click();
  await C.getByText('Ready for the next session', { exact: true }).last().waitFor();
  ok(mock.db.coach_messages.some(m => m.body === 'Ready for the next session' && !m.from_coach), 'client message persists in active coach_messages table');
  await C.getByPlaceholder('Message Ryan…').fill('See you at training');
  await C.getByRole('button', { name: 'Send', exact: true }).click();
  await R.getByText('See you at training', { exact: true }).waitFor();
  ok(true, 'coach reply arrives on client device');
  await R.getByRole('button', { name: 'Today', exact: true }).click();

  // forgot password -> email link -> new password
  const F = await open({ width: 390, height: 844 });
  await F.getByRole('button', { name: 'Forgot password?' }).click();
  await F.getByLabel('Email').fill('ryan@example.com');
  await F.getByRole('button', { name: 'Send reset link' }).click();
  await F.getByText('a reset link is on its way').waitFor({ timeout: 5000 }).catch(() => {});
  ok(await F.getByText('a reset link is on its way').isVisible(), 'forgot password confirms the email');
  const mail = mock.db.emails.find((e) => e.kind === 'reset' && e.to === 'ryan@example.com');
  ok(!!mail, 'reset email sent');
  await F.goto(`http://localhost:${PORT}/?reset=${mail.token}`);
  await F.getByRole('heading', { name: 'Choose a new password' }).waitFor({ timeout: 8000 }).catch(() => {});
  ok(await F.getByRole('heading', { name: 'Choose a new password' }).isVisible(), 'reset link opens the new password screen');
  ok(!(await F.evaluate(() => location.search.includes('reset='))), 'reset token removed from the address bar');
  // Receiving a reset session must NOT count as a password change or normal sign-in.
  const previousPassword = mock.db.users.find((u) => u.email === 'ryan@example.com').password;
  await F.getByLabel('New password', { exact: true }).fill('newpass99');
  await F.getByLabel('Confirm new password').fill('not-matching');
  await F.getByRole('button', { name: 'Save new password' }).click();
  await F.getByText('Passwords do not match.').waitFor();
  ok(mock.db.users.find((u) => u.email === 'ryan@example.com').password === previousPassword, 'mismatched confirmation cannot change password');

  await F.getByLabel('Confirm new password').fill('newpass99');
  await F.getByLabel('Confirm new password').press('Enter');
  ok(mock.db.users.find((u) => u.email === 'ryan@example.com').password === previousPassword, 'mobile keyboard Enter does not implicitly submit password change');
  await F.reload();
  await F.getByRole('heading', { name: 'Choose a new password' }).waitFor({ timeout: 8000 });
  ok(!(await F.getByText('Workout completed').isVisible()), 'reloading an unfinished recovery stays out of the workspace');
  ok(mock.db.users.find((u) => u.email === 'ryan@example.com').password === previousPassword, 'reload cannot save password');

  await F.getByLabel('New password', { exact: true }).fill('newpass99');
  await F.getByLabel('Confirm new password').fill('newpass99');
  await F.getByRole('button', { name: 'Save new password' }).click();
  await F.getByText('Password updated successfully').waitFor({ timeout: 10000 });
  ok(!(await F.getByText('Workout completed').isVisible()), 'successful reset displays confirmation, not auto-login');
  ok(mock.db.users.find((u) => u.email === 'ryan@example.com').password === 'newpass99', 'new password saved by Auth API');
  await F.reload();
  await F.getByRole('heading', { name: 'Client sign in', exact: true }).waitFor({ timeout: 8000 });
  ok(true, 'after successful reset, refresh requires a fresh login');

  await F.getByLabel('Email', { exact: true }).fill('ryan@example.com');
  await F.getByLabel('Password', { exact: true }).fill('wrong-pass');
  await F.getByRole('button', { name: 'Sign in', exact: true }).click();
  await F.getByText('Email or password is not correct.').waitFor({ timeout: 8000 });
  ok(true, 'password reset does not accept an incorrect password');
  await F.getByLabel('Password', { exact: true }).fill('newpass99');
  await F.getByRole('button', { name: 'Sign in', exact: true }).click();
  await F.getByText('Workout completed').waitFor({ timeout: 10000 });
  ok(true, 'password reset requires new credentials for successful login');

  const secondDevice = await open({ width: 1280, height: 800 });
  await secondDevice.getByLabel('Email', { exact: true }).fill('ryan@example.com');
  await secondDevice.getByLabel('Password', { exact: true }).fill('newpass99');
  await secondDevice.getByRole('button', { name: 'Sign in', exact: true }).click();
  await secondDevice.getByText('Workout completed').waitFor({ timeout: 10000 });
  ok(true, 'new password works in a second independent browser context');
  secondDevice.errors.forEach(e => C.errors.push(e));

  await F.goto(`http://localhost:${PORT}/?reset=${mail.token}`);
  await F.getByText('reset link has expired').waitFor({ timeout: 8000 }).catch(() => {});
  ok(await F.getByText('reset link has expired').isVisible(), 'used reset token cannot be consumed twice');

  // Cancelling password recovery must not leave future sign-ins stuck.
  const cancelToken = 'rst-cancel-fixture';
  mock.db.resetTokens[cancelToken] = mock.db.users.find(u => u.email === 'ryan@example.com').id;
  const K = await open({ width: 375, height: 812 });
  await K.goto(`http://localhost:${PORT}/?reset=${cancelToken}`);
  await K.getByRole('heading', { name: 'Choose a new password', exact: true }).waitFor();
  await K.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await K.getByLabel('Email', { exact: true }).fill('ryan@example.com');
  await K.getByLabel('Password', { exact: true }).fill('newpass99');
  await K.getByRole('button', { name: 'Sign in', exact: true }).click();
  await K.getByText('Workout completed', { exact: true }).waitFor();
  ok(true, 'cancelled recovery does not block a later login');
  K.errors.forEach(e => C.errors.push(e));

  // Second independent coach: real UI against the scoped mock, no production fixture.
  const O = await open({ width: 768, height: 1024 });
  await signUp(O, 'Other Coach', 'othercoach@example.com', 'otherpass1', 'coach');
  await O.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
  ok(!(await O.getByText('Ryan Lee', { exact: true }).count()), 'second coach cannot see first coach roster');
  ok((await O.getByRole('button', { name: 'Client', exact: true }).count()) === 0, 'cloud coach cannot switch into client role');
  const otherToken = mock.db.users.find(u => u.email === 'othercoach@example.com').id;
  const ownToken = mock.db.users.find(u => u.email === 'ryan@example.com').id;
  const scopeChecks = await O.evaluate(async ({ otherToken, ownToken, clientId, workoutId }) => {
    const h = tok => ({ apikey: 'anon', Authorization: 'Bearer tok-' + tok, 'Content-Type': 'application/json' });
    const foreign = await fetch('https://mock.supabase.co/rest/v1/clients?id=eq.'+clientId, { headers: h(otherToken) });
    const notes = await fetch('https://mock.supabase.co/rest/v1/coach_notes_secure', { headers: h(ownToken) });
    const prescription = await fetch('https://mock.supabase.co/rest/v1/workouts?id=eq.'+workoutId, { method: 'PATCH', headers: h(ownToken), body: JSON.stringify({data:{title:'forged'}}) });
    return { foreign: await foreign.json(), notes: await notes.json(), prescription: prescription.status };
  }, { otherToken, ownToken, clientId: ryanRow.id, workoutId: w.id });
  ok(scopeChecks.foreign.length === 0 && scopeChecks.notes.length === 0, 'scoped REST hides foreign client and private notes');
  ok(mock.db.workouts.find(x => x.id === w.id).data.title !== 'forged', 'direct client PATCH cannot overwrite a prescription');
  ok(mock.log.some(l => l.startsWith('POST /rest/v1/rpc/save_workout_results_secure')), 'client logging uses secure result RPC');
  O.errors.forEach(e => C.errors.push(e));

  for (const width of [375, 768, 1024, 1440]) {
    await R.setViewportSize({ width, height: 900 });
    ok((await R.evaluate(() => document.documentElement.scrollWidth === innerWidth)), `cloud client layout at ${width}px`);
  }

  /* ---------------- PRI Assessment Notes restoration ---------------- */
  const priSecureNotesBefore = JSON.stringify(mock.db.coach_notes_secure);
  const priPostureReviewsBefore = JSON.stringify(mock.db.posture_reviews_secure || []);
  const priPostureReportsBefore = JSON.stringify(mock.db.posture_public_reports || []);
  const priLogStart = mock.log.length;
  const goToClientsList = async () => {
    await C.getByRole('button', { name: 'Clients', exact: true }).first().click();
    const backBtn = C.getByRole('button', { name: 'All clients' });
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click();
    }
  };

  // Create a second synthetic client to verify client switching never mixes PRI notes
  await goToClientsList();
  await C.getByRole('button', { name: 'Add client' }).click();
  await C.getByPlaceholder('e.g., Jordan Taylor').fill('Casey Pri');
  await C.getByPlaceholder('jordan.taylor@example.com').fill('casey.pri@example.invalid');
  await C.locator('form button[type=submit]').click();
  await C.waitForTimeout(800);
  await C.getByRole('button', { name: 'Close', exact: true }).last().click();
  await C.waitForTimeout(800);
  const caseyRow = mock.db.clients.find((c) => c.email === 'casey.pri@example.invalid');
  ok(!!caseyRow, 'pri: created second synthetic client for isolation check');

  await C.locator('main').getByText('Casey Pri', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();

  const caseyAdtLeft = C.getByLabel('Adduction Drop Test (ADT) Left Side');
  const caseyAdtRight = C.getByLabel('Adduction Drop Test (ADT) Right Side');
  const caseyAdtStatus = C.getByLabel('Adduction Drop Test (ADT) Status');
  const caseyAdtNotes = C.getByLabel('Adduction Drop Test (ADT) Assessment notes');
  await caseyAdtNotes.waitFor();
  ok((await caseyAdtNotes.inputValue()) === '', 'pri: brand-new client starts with empty assessment notes');
  ok((await caseyAdtStatus.inputValue()) === 'Not tested', 'pri: brand-new client starts as Not tested');

  // Keyboard Tab traversal from Left Side -> Right Side -> Status -> Assessment notes
  await caseyAdtLeft.focus();
  await C.keyboard.press('Tab');
  ok(await caseyAdtRight.evaluate((el) => el === document.activeElement), 'pri: Tab moves to Right Side');
  await C.keyboard.press('Tab');
  ok(await caseyAdtStatus.evaluate((el) => el === document.activeElement), 'pri: Tab moves to Status');
  await C.keyboard.press('Tab');
  ok(await caseyAdtNotes.evaluate((el) => el === document.activeElement), 'pri: Tab moves into Assessment notes textarea');
  await C.keyboard.type('Casey baseline note');
  await C.keyboard.press('Enter');
  await C.keyboard.type('Line two');
  await C.waitForTimeout(1200);

  const savedCasey = mock.db.clients.find((c) => c.id === caseyRow.id);
  ok(
    savedCasey &&
      savedCasey.data.priTests.length === 4 &&
      savedCasey.data.priTests[0].notes === 'Casey baseline note\nLine two' &&
      savedCasey.data.priTests.slice(1).every((t) => t.leftResult === '' && t.rightResult === '' && t.status === 'Not tested' && t.notes === ''),
    'pri: editing one untested row saves multiline note and invents no other results or statuses'
  );

  // Seed previously saved PRI tests and an earlier dated snapshot on Ryan Lee
  const ryanLive = mock.db.clients.find((c) => c.id === ryanRow.id);
  ryanLive.data.priTests = [
    { id: 'pri-def-1', name: 'Adduction Drop Test (ADT)', category: 'Pelvis', leftResult: 'Positive', rightResult: 'Negative', status: 'Asymmetric', notes: 'Previously saved ADT note\nSecond line' },
    { id: 'pri-def-2', name: 'Extension Drop Test', category: 'Pelvis', leftResult: '', rightResult: '', status: 'Not tested', notes: 'Existing EDT note' },
    { id: 'pri-def-3', name: 'Hruska Adduction Lift Test (HALT)', category: 'Pelvis', leftResult: '', rightResult: '', status: 'Not tested', notes: '' },
    { id: 'pri-def-4', name: 'Passive Glenohumeral IR (HGIR)', category: 'Shoulder', leftResult: '', rightResult: '', status: 'Not tested', notes: '' }
  ];
  ryanLive.data.assessments = [
    {
      id: 'as-2026-10-01',
      date: '2026-10-01',
      week: 0,
      inBody: JSON.parse(JSON.stringify(ryanLive.data.inBody)),
      rom: [],
      priTests: [{ id: 'pri-def-1', name: 'Adduction Drop Test (ADT)', category: 'Pelvis', leftResult: 'Positive', rightResult: 'Negative', status: 'Asymmetric', notes: 'Snapshot 2026-10-01 baseline note' }],
      gaitPosture: [],
      strengthTests: [],
      videos: []
    },
    ...(ryanLive.data.assessments || []).filter((a) => a.date !== '2026-10-01')
  ];
  ryanLive.updated_at = new Date(Date.now() + 2000).toISOString();

  await C.reload();
  await goToClientsList();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();

  const ryanAdtNotes = C.getByLabel('Adduction Drop Test (ADT) Assessment notes');
  const ryanEdtNotes = C.getByLabel('Extension Drop Test Assessment notes');
  await ryanAdtNotes.waitFor();
  ok((await ryanAdtNotes.inputValue()) === 'Previously saved ADT note\nSecond line', 'pri: previously saved multiline ADT note displays when opening form');
  ok((await ryanEdtNotes.inputValue()) === 'Existing EDT note', 'pri: second test previously saved note displays');

  // Client switching isolation
  await goToClientsList();
  await C.locator('main').getByText('Casey Pri', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();
  ok((await C.getByLabel('Adduction Drop Test (ADT) Assessment notes').inputValue()) === 'Casey baseline note\nLine two', 'pri: switching clients shows Casey own notes without Ryan notes');

  await goToClientsList();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();
  ok((await ryanAdtNotes.inputValue()) === 'Previously saved ADT note\nSecond line', 'pri: switching back shows Ryan own notes without Casey notes');

  // Edit ONLY ADT notes and preserve all other tests/fields
  await ryanAdtNotes.fill('Updated line 1\nUpdated line 2\nUpdated line 3');
  await C.waitForTimeout(1200);
  const ryanAfterEdit = mock.db.clients.find((c) => c.id === ryanRow.id);
  ok(
    ryanAfterEdit.data.priTests[0].notes === 'Updated line 1\nUpdated line 2\nUpdated line 3' &&
      ryanAfterEdit.data.priTests[0].leftResult === 'Positive' &&
      ryanAfterEdit.data.priTests[0].rightResult === 'Negative' &&
      ryanAfterEdit.data.priTests[0].status === 'Asymmetric' &&
      ryanAfterEdit.data.priTests[1].notes === 'Existing EDT note' &&
      ryanAfterEdit.data.priTests[1].status === 'Not tested' &&
      ryanAfterEdit.data.priTests[2].notes === '' &&
      ryanAfterEdit.data.priTests[3].notes === '',
    'pri: editing notes on one test preserves all other tests and fields'
  );

  // Create snapshot via Complete Assessment and confirm snapshot retains PRI notes while earlier snapshot is untouched
  await C.getByRole('button', { name: /6\. Video/ }).click();
  await C.getByRole('button', { name: 'Complete Assessment' }).click();
  await C.waitForTimeout(1200);
  const ryanAfterSnap = mock.db.clients.find((c) => c.id === ryanRow.id);
  const snapOlder = ryanAfterSnap.data.assessments.find((a) => a.date === '2026-10-01');
  const snapToday = ryanAfterSnap.data.assessments.find((a) => a.date === today);
  ok(
    snapToday && snapToday.priTests?.[0]?.notes === 'Updated line 1\nUpdated line 2\nUpdated line 3',
    'pri: completed assessment snapshot retains PRI notes'
  );
  ok(
    snapOlder && snapOlder.priTests?.[0]?.notes === 'Snapshot 2026-10-01 baseline note',
    'pri: completing assessment preserves earlier dated snapshot unchanged'
  );
  ok((await C.getByText(/Updated line 1/).count()) === 0, 'pri: confirmed assessment history Overview does not render PRI notes');

  // Reload and confirm multiline notes persist
  await C.reload();
  await goToClientsList();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();
  ok(
    (await ryanAdtNotes.inputValue()) === 'Updated line 1\nUpdated line 2\nUpdated line 3' &&
      (await ryanEdtNotes.inputValue()) === 'Existing EDT note',
    'pri: multiline notes persist across cloud save and reload'
  );

  // Clearing notes persists empty string and does NOT mutate earlier snapshots
  await ryanAdtNotes.fill('');
  await C.waitForTimeout(1200);
  await C.reload();
  await goToClientsList();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Assessment', exact: true }).click();
  await C.getByRole('button', { name: /^(Start assessment|New assessment)$/ }).click();
  await C.getByRole('button', { name: /2\. PRI Tests/ }).click();
  const ryanAfterClear = mock.db.clients.find((c) => c.id === ryanRow.id);
  ok(
    (await ryanAdtNotes.inputValue()) === '' &&
      ryanAfterClear.data.priTests[0].notes === '' &&
      ryanAfterClear.data.priTests[1].notes === 'Existing EDT note',
    'pri: clearing notes persists empty string without affecting other rows'
  );
  ok(
    ryanAfterClear.data.assessments.find((a) => a.date === '2026-10-01')?.priTests?.[0]?.notes === 'Snapshot 2026-10-01 baseline note' &&
      ryanAfterClear.data.assessments.find((a) => a.date === today)?.priTests?.[0]?.notes === 'Updated line 1\nUpdated line 2\nUpdated line 3',
    'pri: later edits do not mutate earlier dated assessment snapshots'
  );

  // Long unbroken multiline note overflow, touch targets (>=44px), and phone font (>=16px) at all 4 widths
  await ryanAdtNotes.fill('SuperLongUnbrokenClinicalObservationNoteWithoutSpacesForWrappingVerification_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\nSecond line observation');
  for (const [w, h] of [
    [375, 812],
    [768, 1024],
    [1024, 768],
    [1440, 900]
  ]) {
    await C.setViewportSize({ width: w, height: h });
    await C.waitForTimeout(100);
    const metrics = await C.evaluate(() => {
      const pageOverflow = document.documentElement.scrollWidth - window.innerWidth;
      const ta = document.querySelector('textarea[aria-label="Adduction Drop Test (ADT) Assessment notes"]');
      const taOverflow = ta ? ta.scrollWidth - ta.clientWidth : 999;
      const fieldControls = [...document.querySelectorAll('textarea, input[aria-label*="Side"], select[aria-label*="Status"]')];
      const navButtons = [...document.querySelectorAll('button')].filter((el) => /^(Back|Save & next)$/.test((el.innerText || '').trim()));
      const minFieldHeight = Math.min(...fieldControls.map((el) => el.getBoundingClientRect().height));
      const minButtonHeight = navButtons.length ? Math.min(...navButtons.map((el) => el.getBoundingClientRect().height)) : 0;
      const minFieldFont = Math.min(...fieldControls.map((el) => parseFloat(getComputedStyle(el).fontSize)));
      return { pageOverflow, taOverflow, minFieldHeight, minButtonHeight, minFieldFont };
    });
    ok(metrics.pageOverflow <= 0 && metrics.taOverflow <= 1, `pri: zero horizontal overflow with long note at ${w}x${h}`);
    ok(metrics.minFieldHeight >= 44 && metrics.minButtonHeight >= 44, `pri: controls height >= 44px at ${w}x${h} (field=${Math.round(metrics.minFieldHeight)}px, btn=${Math.round(metrics.minButtonHeight)}px)`);
    if (w <= 768) {
      ok(metrics.minFieldFont >= 16, `pri: mobile/tablet field font >= 16px at ${w}x${h} (${metrics.minFieldFont}px)`);
    }
  }
  await C.setViewportSize({ width: 1440, height: 900 });

  // No writes went to secure coach notes or posture review/report tables
  const priWriteLogs = mock.log.slice(priLogStart).filter((entry) => /^(POST|PATCH|PUT|DELETE)\b/.test(entry));
  ok(
    JSON.stringify(mock.db.coach_notes_secure) === priSecureNotesBefore &&
      JSON.stringify(mock.db.posture_reviews_secure || []) === priPostureReviewsBefore &&
      JSON.stringify(mock.db.posture_public_reports || []) === priPostureReportsBefore &&
      !priWriteLogs.some((entry) => /coach_notes_secure|posture_reviews_secure|posture_public_reports/.test(entry)),
    'pri: writes go only to client assessment record, zero writes to secure notes or posture review/report tables'
  );

  // Clients safety checks: Test Client hidden in cloud production, Gmail/Googlemail duplicate blocked, server-verified Delete Client
  await goToClientsList();
  ok((await C.getByRole('button', { name: '+ Test Client', exact: true }).count()) === 0, 'clients safety: + Test Client button is hidden in production cloud build');

  // Add a Gmail client, verify Googlemail alias is rejected, then safely delete via server-verified delete-client
  await C.getByRole('button', { name: 'Add client', exact: true }).first().click();
  await C.getByPlaceholder('e.g., Jordan Taylor').fill('Alias Guard');
  await C.getByPlaceholder('jordan.taylor@example.com').fill('alias.guard@gmail.com');
  await C.locator('form').getByRole('button', { name: 'Add client', exact: true }).click();
  await C.getByRole('button', { name: 'Close', exact: true }).last().click();
  await C.waitForTimeout(1000);
  const aliasRow = mock.db.clients.find((c) => c.email === 'alias.guard@gmail.com');
  ok(Boolean(aliasRow), 'clients safety: created Gmail client saved to cloud');

  // Duplicate googlemail.com alias must be blocked
  await C.getByRole('button', { name: 'Add client', exact: true }).first().click();
  await C.getByPlaceholder('e.g., Jordan Taylor').fill('Alias Duplicate');
  await C.getByPlaceholder('jordan.taylor@example.com').fill('alias.guard@googlemail.com');
  await C.locator('form').getByRole('button', { name: 'Add client', exact: true }).click();
  await C.getByText(/Gmail\/Googlemail address already belongs/i).waitFor();
  ok(!mock.db.clients.some((c) => c.email === 'alias.guard@googlemail.com'), 'clients safety: googlemail duplicate of gmail client is blocked');
  await C.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Seed a linked Auth account and storage file for Alias Guard; verify Permanent Delete stays disabled by default and Archive keeps all data intact.
  const aliasAuthId = 'alias-auth-uid';
  mock.db.users.push({ id: aliasAuthId, email: 'alias.guard@gmail.com', password: 'Password123!', confirmed: true, meta: { display_name: 'Alias Guard' } });
  mock.db.profiles.push({ id: aliasAuthId, role: 'client', display_name: 'Alias Guard', client_id: aliasRow.id });
  mock.db.clientFiles[`${aliasRow.id}/clip.webm`] = { type: 'video/webm', body: Buffer.alloc(1) };

  // Archived tab is always accessible even when empty
  ok(await C.getByRole('tab', { name: 'Archived (0)', exact: true }).isVisible(), 'clients safety: Archived (0) tab is visible even when empty');

  await C.getByRole('button', { name: /More actions for Alias Guard/i }).click();
  const deleteMenuItem = C.getByRole('menuitem', { name: /Delete Client/i });
  ok(await deleteMenuItem.isDisabled(), 'clients safety: Permanent Delete is disabled by default until safe server cleanup is enabled');

  // Archive works without deleting DB record, Auth account, or storage files, and persists after refresh
  await C.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await C.waitForTimeout(800);
  const archivedAlias = mock.db.clients.find((c) => c.id === aliasRow.id);
  ok(Boolean(archivedAlias && archivedAlias.data.archived === true), 'clients safety: Archive marks client archived without deleting row');
  ok(mock.db.users.some((u) => u.id === aliasAuthId) && mock.db.profiles.some((p) => p.id === aliasAuthId), 'clients safety: Archive preserves linked Auth account and profile');
  ok(Boolean(mock.db.clientFiles[`${aliasRow.id}/clip.webm`]), 'clients safety: Archive preserves client storage files');
  ok(!mock.log.some((entry) => entry.startsWith('POST /functions/v1/delete-client')), 'clients safety: Archive never invokes delete-client');

  // Refresh page to verify Archive persists across reload
  await C.reload();
  await C.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
  ok((await C.locator('section[aria-label="Client list"]').getByText('Alias Guard', { exact: true }).count()) === 0, 'clients safety: archived client stays hidden from Active after refresh');
  await C.getByRole('tab', { name: 'Archived (1)', exact: true }).click();
  await C.locator('section[aria-label="Client list"]').getByText('Alias Guard', { exact: true }).first().waitFor();
  await C.getByRole('button', { name: 'Restore Client', exact: true }).click();
  await C.waitForTimeout(800);
  const restoredAlias = mock.db.clients.find((c) => c.id === aliasRow.id);
  ok(Boolean(restoredAlias && !restoredAlias.data.archived), 'clients safety: Restore returns archived client to active list intact');

  // Refresh page to verify Restore persists across reload
  await C.reload();
  await C.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
  ok(await C.getByRole('tab', { name: 'Archived (0)', exact: true }).isVisible(), 'clients safety: Archived (0) persists after Restore and refresh');
  ok(await C.locator('section[aria-label="Client list"]').getByText('Alias Guard', { exact: true }).first().isVisible(), 'clients safety: restored client remains in Active after refresh');

  // A stale coach editor must fail closed instead of replacing newer results.
  await goToClientsList();
  await C.locator('main').getByText('Ryan Lee', { exact: true }).first().click();
  await C.getByRole('button', { name: 'Exercises', exact: true }).click();
  const serverWorkout = mock.db.workouts.find(x => x.id === w.id);
  const protectedReps = serverWorkout.data.blocks[0].reps;
  serverWorkout.updated_at = new Date(Date.now() + 10000).toISOString(); // another device, deliberately no event
  await C.locator('input[placeholder="8-10"]').first().fill('12');
  await C.locator('input[placeholder="8-10"]').first().blur();
  await C.getByRole('heading', { name: 'Data needs a fresh load', exact: true }).waitFor();
  ok(serverWorkout.data.blocks[0].reps === protectedReps, 'stale editor cannot overwrite a newer workout version');

  // layout
  for (const [n, p] of [['client', R], ['stranger', S], ['reset', F]]) {
    ok((await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) === 0, `${n}: no horizontal overflow on phone`);
  }
  const all = [...S.errors, ...C.errors, ...R.errors, ...F.errors];
  ok(all.length === 0, 'no page errors ' + all.join(' | '));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await b.close();
  srv.close();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
