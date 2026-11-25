// Responsive check: node e2e/responsive-check.cjs <demo dist dir> [shots dir]
// Build demo first: npx vite build --outDir /tmp/dist-local --base /  (no VITE_SUPABASE_URL)
// Crawl the local demo build at several widths and report horizontal overflow.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], shots = process.argv[3];
const PORT = 4201;
if (shots) fs.mkdirSync(shots, { recursive: true });
http.createServer((q, r) => {
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(f)] || 'application/octet-stream';
  r.writeHead(200, { 'content-type': type }); r.end(fs.readFileSync(f));
}).listen(PORT);

const VP = { desktop: { width: 1440, height: 900 }, laptop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 }, tablet: { width: 768, height: 1024 }, tabletL: { width: 1024, height: 768 } };

async function measure(p) {
  return p.evaluate(() => {
    const W = window.innerWidth;
    const page = document.documentElement.scrollWidth - W;
    const scrollers = [], offRight = [];
    const label = (el) => {
      const t = (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 3).join('.') : ''} "${t}"`;
    };
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        // The seven-day coach calendar is deliberately swipe-scrollable on mobile.
        // Do not hide other accidental overflow: permit this single named region
        // only when all seven day columns actually exist.
        const weeklyCalendar = el.getAttribute('aria-label') === 'Scroll the full seven-day workout calendar' &&
          el.querySelectorAll('article[aria-label$=" workout"]').length === 7;
        if (!weeklyCalendar) scrollers.push(`${label(el)} (${el.scrollWidth}>${el.clientWidth})`);
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > W + 2 && !el.closest('[class*="overflow-x"],[class*="overflow-auto"],[class*="overflow-hidden"]'))
        offRight.push(`${label(el)} right=${Math.round(r.right)}`);
    }
    return { page, scrollers: [...new Set(scrollers)].slice(0, 8), offRight: offRight.slice(0, 5) };
  });
}

(async () => {
  let failures = 0, unvisited = 0;
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
  for (const [vn, vp] of Object.entries(VP)) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: vn !== 'tabletL' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(`http://localhost:${PORT}/`); await p.waitForTimeout(1500);
    // Menus must be checked while open: page scrollWidth alone misses left-edge clipping.
    const checkMenus = async (name) => {
      const triggers = p.locator('button[aria-haspopup="menu"]:visible');
      for (let i = 0; i < await triggers.count(); i++) {
        const trigger = triggers.nth(i);
        const title = await trigger.getAttribute('aria-label');
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click({ timeout: 3000 });
        const menu = p.getByRole('menu');
        await menu.waitFor({ state: 'visible' });
        const bounds = await menu.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            width: document.documentElement.clientWidth, height: window.innerHeight };
        });
        const bad = bounds.left < -1 || bounds.right > bounds.width + 1 ||
          bounds.top < -1 || bounds.bottom > bounds.height + 1 || bounds.bottom <= bounds.top;
        if (bad) failures++;
        console.log(`${bad ? 'XX' : 'ok'} [${vn}] ${name} open menu: ${title} ${JSON.stringify(bounds)}`);
        await p.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
      }
    };
    const report = async (name) => {
      await p.waitForTimeout(400);
      const m = await measure(p);
      const bad = m.page > 0 || m.scrollers.length || m.offRight.length;
      if (bad) failures++;
      console.log(`${bad ? 'XX' : 'ok'} [${vn}] ${name}${m.page > 0 ? ` PAGE+${m.page}px` : ''}`);
      m.scrollers.forEach((s) => console.log('     scroll: ' + s));
      m.offRight.forEach((s) => console.log('     off:    ' + s));
      if (['client', 'tab-Exercises', 'tab-Exercises-Program', 'nav-Programs'].includes(name)) await checkMenus(name);
      if (shots) await p.screenshot({ path: `${shots}/${vn}-${name.replace(/[^\w]+/g, '_')}.png`, fullPage: true });
    };
    const click = async (loc) => { try { await loc.first().click({ timeout: 2500 }); return true; } catch { return false; } };
    await report('home');
    // open the nav (mobile may hide it behind a menu button)
    for (const nav of ['Library', 'Programs', 'Messages', 'Clients']) {
      if (!(await click(p.getByRole('button', { name: new RegExp('^' + nav, 'i') })))) {
        await click(p.getByRole('button', { name: /menu/i }));
        if (!(await click(p.getByRole('button', { name: new RegExp('^' + nav, 'i') })))) { console.log(`?? [${vn}] no nav ${nav}`); unvisited++; continue; }
      }
      await report('nav-' + nav);
    }
    // open first client
    const row = p.locator('main').getByText('Alex Carter', { exact: true });
    if (!(await click(row))) { console.log(`?? [${vn}] no client row`); unvisited++; }
    await report('client');
    for (const tab of ['Exercises', 'Assessment', 'Notes', 'Goals', 'Progression', 'Nutrition']) {
      if (!(await click(p.getByRole('tab', { name: tab })))) if (!(await click(p.getByRole('button', { name: new RegExp('^' + tab + '$') })))) { console.log(`?? [${vn}] no tab ${tab}`); unvisited++; continue; }
      await report('tab-' + tab);
      const subs = { Exercises: ['Program', 'Exercise library', 'History'], Assessment: ['Overview', 'New assessment', 'Reports'] }[tab] || [];
      for (const s of subs) {
        if (await click(p.getByRole('tab', { name: s })) || await click(p.getByRole('button', { name: new RegExp('^' + s + '$') }))) await report(`tab-${tab}-${s}`);
      }
      if (tab === 'Assessment') await click(p.getByRole('button', { name: /^Overview$/ }));
    }
    if (await click(p.getByRole('button', { name: /^Client$/ }))) {
      await report('clientapp-today');
      const clientNav = p.getByRole('navigation', {name:'Client navigation'});
      const assertClient = async (name, test) => {
        const pass = await test;
        if (!pass) failures++;
        console.log(`${pass ? 'ok' : 'XX'} [${vn}] client layout: ${name}`);
      };
      await assertClient('navigation changes from bottom to desktop top',
        clientNav.evaluate(el=>getComputedStyle(el).position === (window.innerWidth < 768 ? 'fixed' : 'static')));
      const todayLayout = p.locator('[data-client-today-layout]');
      await assertClient('Today uses two columns only at desktop widths',
        todayLayout.evaluate(el=>{
          const main = el.querySelector('[data-client-today-workout]').getBoundingClientRect();
          const side = el.querySelector('[data-client-today-support]').getBoundingClientRect();
          return window.innerWidth >= 1024 ? main.right < side.left + 1 && main.width > side.width && el.clientWidth > 850 : Math.abs(main.left-side.left)<2;
        }));
      for (const t of ['Progress', 'Chat', 'Refer', 'Today']) {
        if (!(await click(clientNav.getByRole('button', { name:t, exact:true })))) { unvisited++; continue; }
        await report('clientapp-' + t);
        if (t === 'Progress' || t === 'Refer') {
          const layout = p.locator(t === 'Progress' ? '[data-client-progress-layout]' : '[data-client-refer-layout]');
          await assertClient(t+' has adaptive columns',layout.evaluate(el=>{
            const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length;
            return cols === (window.innerWidth>=1024 ? 2 : 1) && (window.innerWidth<1024 || el.clientWidth>850);
          }));
        }
        if(t==='Chat') await assertClient('Chat is wider on desktop',
          p.locator('[data-client-chat-layout]').evaluate(el=>window.innerWidth<1024||el.clientWidth>800));
      }
      if (vp.width >= 768) {
        const preview=p.getByRole('button',{name:'Phone frame',exact:true});
        await preview.click();
        await assertClient('explicit phone preview stays narrow',todayLayout.evaluate(el=>el.clientWidth<450 && getComputedStyle(el).gridTemplateColumns.split(' ').length===1));
        await p.getByRole('button',{name:'Full width',exact:true}).click();
        await report('clientapp-full-width');
      }
    } else { console.log(`?? [${vn}] no client switch`); unvisited++; }
    if (errs.length) { failures++; console.log(`!! [${vn}] page errors: ${[...new Set(errs)].slice(0, 3).join(' | ')}`); }
    await ctx.close();
  }
  await b.close();
  console.log(`Responsive check: ${failures} failures, ${unvisited} unvisited views`);
  process.exit(failures || unvisited ? 1 : 0);
})();
