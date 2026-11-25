// Focused local-browser acceptance of the trainer-requested workout programming flow.
// No Supabase or Production calls; only the isolated demo build at localhost.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node e2e/trainer-builder.cjs <demo dist dir>');
const PORT = 4196;
const srv = http.createServer((q, r) => {
  const uri = decodeURIComponent(q.url.split('?')[0]);
  let file = path.join(root, uri);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream';
  r.writeHead(200, {'content-type':type}); r.end(fs.readFileSync(file));
}).listen(PORT);
let browser;
async function check(label, p) {
  if (!(await p)) throw new Error('FAIL: ' + label);
  console.log('PASS:', label);
}
async function openBuilder(page) {
  const heading = page.getByRole('heading', { name: 'Workout Builder' });
  if (await heading.isVisible()) return; // persisted client workspace after Refresh
  await page.locator('main').getByText('Alex Carter', { exact: true }).first().click();
  if (!(await heading.isVisible())) {
    // At mobile widths the roster opens a client detail sheet first.
    await page.locator('section[aria-label="Selected client details"]')
      .getByRole('button', { name: 'Exercises', exact: true }).click();
  }
  await heading.waitFor();
}
async function run(viewport) {
  const ctx = await browser.newContext({viewport, serviceWorkers:'block'});
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto(`http://localhost:${PORT}/`);
    await openBuilder(p);
    const create = p.getByRole('button', { name: 'Create workout' });
    if (await create.isVisible()) await create.click();
    const search = p.getByRole('textbox', { name: 'Search exercises or enter a custom exercise name' });
    const categories = p.getByRole('combobox', {name:'Categories'});
    await check('one compact category selector is visible', categories.count().then(n=>n===1));
    const options = await categories.locator('option').allTextContents();
    await check('all original muscle categories are preserved', Promise.resolve(options.join('|') === ['All','Chest','Back','Shoulders','Biceps','Triceps','Quads','Hamstrings','Glutes','Calves','Hips & Adductors','Core','Full Body','Mobility & Breathing'].join('|')));
    await categories.selectOption('Chest');
    const groups = () => p.locator('[data-library-group]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-library-group')));
    await check('Chest category filters actual exercise rows', groups().then(a=>a.length>0 && a.every(g=>g==='Chest')));
    await categories.selectOption('Back');
    await check('Back category filters actual exercise rows', groups().then(a=>a.length>0 && a.every(g=>g==='Back')));
    await categories.selectOption('All');
    await check('All restores the mixed catalog', groups().then(a=>new Set(a).size>1));
    const details = p.locator('details').filter({hasText:'Workout details'});
    const focus = p.getByRole('textbox', {name:'Workout focus'});
    const notes = p.getByRole('textbox', {name:'Client notes'});
    await check('optional workout details are collapsed by default', focus.isVisible().then(v=>!v));
    await details.locator('summary').click();
    await focus.fill('Synthetic focus');
    await notes.fill('Synthetic coach notes');
    await details.locator('summary').click();
    await check('optional details can be collapsed without losing data', focus.isVisible().then(v=>!v));
    await details.locator('summary').click();
    await check('focus and notes remain editable', Promise.all([focus.inputValue(),notes.inputValue()]).then(([a,b])=>a==='Synthetic focus'&&b==='Synthetic coach notes'));
    await details.locator('summary').click();
    await search.fill('Stability Ball Body Saw');
    await p.getByRole('button', { name: 'Add custom exercise Stability Ball Body Saw' }).click();
    await check('custom movement appears in the prescribed workout', p.getByText('Stability Ball Body Saw', { exact:true }).first().isVisible());
    await check('custom movement is not registered in the exercise library',
      p.getByText('Custom exercise', { exact:true }).isVisible());

    await search.fill('1 arm row with rotation');
    await p.getByRole('button', { name: 'Add 1 arm row with rotation', exact:true }).waitFor();
    await p.getByRole('button', { name: 'Add 1 arm row with rotation', exact:true }).click();
    const pairedBefore = await p.locator('[data-editor-exercise][data-superset-linked="true"]').count();
    await p.getByRole('button', { name: 'Superset with previous' }).last().click();
    const pairedAfter = await p.locator('[data-editor-exercise][data-superset-linked="true"]').count();
    await check('newly appended movement can join a superset', Promise.resolve(pairedAfter === pairedBefore + 1));
    await check('superset grouping is visible to the coach', p.locator('[data-editor-exercise]').getByText(/Superset [A-Z] · \d+ exercises/).first().isVisible());

    await p.getByRole('button', {name:'Preview 1 arm row with rotation video'}).first().click();
    const modal = p.getByRole('dialog', {name:'Preview 1 arm row with rotation video'});
    await modal.waitFor();
    await check('trainer video player opens with catalog reference', modal.locator('iframe[src*="vimeo.com/video/558288571"]').count().then(Boolean));
    await p.getByRole('button', {name:'Close video preview'}).click();

    // The free-text block survives the same save/refresh path as normal blocks.
    await p.reload();
    await openBuilder(p);
    await check('custom exercise persists after reload', p.getByText('Stability Ball Body Saw',{exact:true}).first().isVisible());
    await check('superset pairing persists after reload',
      p.locator('[data-editor-exercise][data-superset-linked="true"]').count().then((count) => count === pairedAfter));
    await check('details start collapsed after reload', focus.isVisible().then(v=>!v));
    await p.locator('details').filter({hasText:'Workout details'}).locator('summary').click();
    await check('saved workout focus and notes survive reload', Promise.all([focus.inputValue(),notes.inputValue()]).then(([a,b])=>a==='Synthetic focus'&&b==='Synthetic coach notes'));
    const width = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await check(`no horizontal overflow at ${viewport.width}px`, Promise.resolve(width <= 1));
    await check('no JavaScript errors', Promise.resolve(errors.length === 0));
  } finally {
    await ctx.close();
  }
}
(async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {});
  await run({width:1280,height:900});
  await run({width:375,height:812});
  console.log('PASS: trainer programming browser acceptance');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => srv.close(resolve)); });
