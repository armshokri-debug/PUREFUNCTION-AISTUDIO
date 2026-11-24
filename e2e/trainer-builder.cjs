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
  await page.locator('main').getByText('Alex Carter', { exact: true }).first().click();
  await page.getByRole('heading', { name: 'Workout Builder' }).waitFor();
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
    await search.fill('Stability Ball Body Saw');
    await p.getByRole('button', { name: 'Add custom exercise Stability Ball Body Saw' }).click();
    await check('custom movement appears in the prescribed workout', p.getByText('Stability Ball Body Saw', { exact:true }).first().isVisible());
    await check('custom movement is not registered in the exercise library',
      p.getByText('Custom workout exercise', { exact:true }).isVisible());

    await search.fill('1 arm row with rotation');
    await p.getByRole('button', { name: 'Add 1 arm row with rotation', exact:true }).waitFor();
    await p.getByRole('button', { name: 'Add 1 arm row with rotation', exact:true }).click();
    const pairedBefore = await p.getByText('Paired with previous exercise', {exact:true}).count();
    await p.getByRole('button', { name: 'Superset with previous' }).last().click();
    const pairedAfter = await p.getByText('Paired with previous exercise', {exact:true}).count();
    await check('newly appended movement can join a superset', Promise.resolve(pairedAfter === pairedBefore + 1));
    await check('superset grouping is visible to the coach', p.getByText(/Superset [A-Z] · Alternate these exercises before resting/).first().isVisible());

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
      p.getByText('Paired with previous exercise', {exact:true}).count().then((count) => count === pairedAfter));
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
