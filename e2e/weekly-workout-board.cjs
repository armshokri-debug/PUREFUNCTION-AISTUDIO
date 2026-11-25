// Seven-day coach calendar acceptance: synthetic local demo only, never Production.
// Usage: node e2e/weekly-workout-board.cjs <demo dist dir>
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
if (!root) throw new Error('Usage: node e2e/weekly-workout-board.cjs <demo dist dir>');
const PORT = 4199;
const server = http.createServer((request, response) => {
  const uri = decodeURIComponent(request.url.split('?')[0]);
  let file = path.join(root, uri);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)] || 'application/octet-stream';
  response.writeHead(200, {'content-type':mime}); response.end(fs.readFileSync(file));
}).listen(PORT);
let browser;
const requireTrue = async (label, promise) => {
  if (!await promise) throw new Error('FAIL: ' + label);
  console.log('PASS:', label);
};
async function openBuilder(p) {
  const heading = p.getByRole('heading', {name:'Workout Builder'});
  if (await heading.isVisible()) return;
  await p.locator('main').getByText('Alex Carter', {exact:true}).first().click();
  if (!(await heading.isVisible())) {
    await p.locator('section[aria-label="Selected client details"]')
      .getByRole('button', {name:'Exercises',exact:true}).click();
  }
  await heading.waitFor();
}
async function run(viewport) {
  const context = await browser.newContext({viewport,hasTouch:viewport.width<800,serviceWorkers:'block'});
  const page = await context.newPage();
  const exceptions=[];
  page.on('pageerror',e=>exceptions.push(e.message));
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await openBuilder(page);
    const currentBoard = page.getByRole('region',{name:'Weekly workout overview'});
    const currentDay = currentBoard.locator('[data-day-today="true"]');
    const otherDay = currentBoard.locator('[data-day-today="false"]').first();
    const activate = async locator => viewport.width < 800 ? locator.tap() : locator.click();
    await requireTrue('exactly one actual local today card', currentDay.count().then(n=>n===1));
    await requireTrue('today badge and semantic date marker exist',
      currentDay.getByText('Today',{exact:true}).isVisible());
    await requireTrue('today is visually distinguished from other days',
      Promise.all([currentDay,otherDay].map(card=>card.evaluate(el=>getComputedStyle(el).backgroundColor)))
        .then(([a,b])=>a!==b));
    await activate(otherDay.getByRole('button').first());
    await requireTrue('selecting another date does not remove today marker',
      currentDay.locator('button[aria-current="date"]').count().then(n=>n===1));
    await requireTrue('today remains distinct when not selected',
      currentDay.getAttribute('data-day-selected').then(v=>v==='false'));
    await activate(currentDay.getByText('Today',{exact:true}));
    await requireTrue('tapping the body of today selects it',
      currentDay.getAttribute('data-day-selected').then(v=>v==='true'));

    // Synthetic demo ships with weekday workouts; test two weeks ahead to
    // avoid replacing seeded plans while verifying empty-day move/copy.
    await page.getByRole('button',{name:'Next week'}).click();
    await page.getByRole('button',{name:'Next week'}).click();
    const board = page.getByRole('region',{name:'Weekly workout overview'});
    await requireTrue('complete seven-day board appears',board.getByRole('article').count().then(n=>n===7));
    const tuesday=board.getByRole('article',{name:/^Tue, .* workout$/});
    const thursday=board.getByRole('article',{name:/^Thu, .* workout$/});
    const friday=board.getByRole('article',{name:/^Fri, .* workout$/});
    await requireTrue('today is not falsely highlighted in a future week',
      board.locator('[data-day-today="true"]').count().then(n=>n===0));
    await activate(tuesday.getByText('No workout planned',{exact:true}));
    await requireTrue('tapping a rest-day card body selects it',
      tuesday.getAttribute('data-day-selected').then(v=>v==='true'));
    const create=page.getByRole('button',{name:'Create workout'});
    if (await create.isVisible()) await create.click();

    const search=page.getByRole('textbox',{name:'Search exercises or enter a custom exercise name'});
    await search.fill('Stability Ball Body Saw');
    await page.getByRole('button',{name:'Add custom exercise Stability Ball Body Saw'}).click();
    await search.fill('1 arm row with rotation');
    await page.getByRole('button',{name:'Add 1 arm row with rotation',exact:true}).click();
    await page.getByRole('button',{name:'Superset with previous'}).last().click();
    await search.fill('Synthetic QA third movement');
    await page.getByRole('button',{name:'Add custom exercise Synthetic QA third movement'}).click();
    await page.getByRole('button',{name:'Superset with previous'}).last().click();
    const assertGroup = async (day, labels, count) => {
      const weeklyLabels = await day.locator('[data-weekly-exercise][data-superset-member]').evaluateAll(nodes =>
        nodes.map(n => n.getAttribute('data-weekly-exercise')));
      if (JSON.stringify(weeklyLabels) !== JSON.stringify(labels))
        throw new Error('Weekly superset mismatch: '+JSON.stringify(weeklyLabels));
      await requireTrue('weekly group member count matches', day.getByText(new RegExp('Superset A · '+count+' exercises')).isVisible());
    };
    const editorLabels = () => page.locator('[data-editor-exercise][data-superset-member]').evaluateAll(nodes =>
      nodes.map(n=>n.getAttribute('data-editor-exercise')));
    await assertGroup(tuesday, ['A1','A2','A3'],3);
    await requireTrue('editor and weekly board show the same three highlighted members',
      editorLabels().then(labels=>JSON.stringify(labels)===JSON.stringify(['A1','A2','A3'])));
    await page.getByRole('button',{name:'Superset with previous'}).last().click();
    await assertGroup(tuesday, ['A1','A2'],2);
    await requireTrue('unpair updates both views immediately',
      editorLabels().then(labels=>JSON.stringify(labels)===JSON.stringify(['A1','A2'])));
    await page.getByRole('button',{name:'Superset with previous'}).last().click();
    await assertGroup(tuesday, ['A1','A2','A3'],3);

    await requireTrue('Tuesday lists both exercises side-by-side with sets and reps',
      tuesday.getByText('Stability Ball Body Saw').count().then(n=>n>0));
    await requireTrue('grouped exercise prescriptions displayed',
      tuesday.getByText(/3 sets × (8-10|10) reps/).count().then(n=>n>=2));
    await requireTrue('superset A1/A2 visible without opening each day',
      tuesday.getByText(/A2/).count().then(n=>n>0));

    await tuesday.getByRole('button',{name:/Copy Tue /}).click();
    await friday.getByRole('button',{name:/Paste copy to Fri /}).click();
    await requireTrue('copy keeps Tuesday original', tuesday.getByText('Stability Ball Body Saw').isVisible());
    await requireTrue('copy preserves all Friday exercise prescriptions',
      friday.getByText('Stability Ball Body Saw').isVisible());
    await assertGroup(friday, ['A1','A2','A3'],3);
    await activate(tuesday.locator('[data-weekly-exercise="A1"]'));
    await requireTrue('tapping an exercise inside a card selects its day',
      tuesday.getAttribute('data-day-selected').then(v=>v==='true'));
    await requireTrue('editor follows full-card selection',
      editorLabels().then(labels=>JSON.stringify(labels)===JSON.stringify(['A1','A2','A3'])));
    await activate(friday.getByRole('button',{name:/Copy Fri /}));
    await requireTrue('copy on a different card does not select it',
      tuesday.getAttribute('data-day-selected').then(v=>v==='true'));
    await board.getByRole('button',{name:'Cancel workout transfer'}).click();

    if (viewport.width >= 800) {
      await friday.dragTo(thursday);
    } else {
      await friday.getByRole('button',{name:/Move Fri /}).click();
      await thursday.getByRole('button',{name:/Paste move to Thu /}).click();
    }
    await requireTrue('move places all exercises on Thursday',
      thursday.getByText('Stability Ball Body Saw').isVisible());
    await assertGroup(thursday, ['A1','A2','A3'],3);
    await requireTrue('move clears Friday only', friday.getByText('No workout planned').isVisible());

    await tuesday.getByRole('button',{name:/Move Tue /}).click();
    await thursday.getByRole('button',{name:/Paste move to Thu /}).click();
    const confirm=page.getByRole('dialog',{name:'Replace existing planned workout'});
    await confirm.waitFor();
    await requireTrue('occupied target requires confirmation', confirm.getByRole('button',{name:'Replace plan'}).isVisible());
    await confirm.getByRole('button',{name:'Cancel'}).click();
    await requireTrue('cancel preserves original Thursday plan',
      thursday.getByText('Stability Ball Body Saw').isVisible());
    await board.getByRole('button',{name:'Cancel workout transfer'}).click();

    await page.reload();
    await openBuilder(page);
    const after=page.getByRole('region',{name:'Weekly workout overview'});
    await requireTrue('copied and moved workouts persist after Refresh',
      after.getByRole('article',{name:/^Thu, .* workout$/}).getByText('Stability Ball Body Saw').isVisible());
    await requireTrue('Tuesday original remains after Refresh',
      after.getByRole('article',{name:/^Tue, .* workout$/}).getByText('Stability Ball Body Saw').isVisible());
    await assertGroup(after.getByRole('article',{name:/^Tue, .* workout$/}), ['A1','A2','A3'],3);
    await assertGroup(after.getByRole('article',{name:/^Thu, .* workout$/}), ['A1','A2','A3'],3);
    await requireTrue('rest day remains unplanned after Refresh',
      after.getByRole('article',{name:/^Fri, .* workout$/}).getByText('No workout planned').isVisible());
    await requireTrue('all days accessible',after.getByRole('article').count().then(n=>n===7));
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    await requireTrue('calendar has no global horizontal overflow',Promise.resolve(overflow<=1));
    await requireTrue('no browser JavaScript errors',Promise.resolve(exceptions.length===0));
  } finally {await context.close();}
}
(async()=>{
  browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {});
  await run({width:1440,height:900});
  await run({width:375,height:812});
  console.log('PASS: coach weekly board tests on desktop and touch-sized viewport');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close(); await new Promise(resolve=>server.close(resolve));});
