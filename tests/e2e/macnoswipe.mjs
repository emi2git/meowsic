// Mac (desktop Chrome, no touch): no swipe or drag gestures anywhere, buttons only (the user's choice, 2026-11-26).
// - Library: every tab and search shows the ‹ n / N › pager (also for one page), the buttons and ← → / Page Up / Down
//   turn it; nothing scrolls; a mouse drag or a trackpad wheel (sideways or up / down) changes nothing.
// - Chrome's two-finger swipe = history back / forward: off by overscroll-behavior-x: none on the root.
// - Sheet: a mouse drag left / right no longer turns (the ‹ › strips do); a sideways wheel does nothing.
// - Score: a drag or a wheel never leaves the view.
// - iPad (touch): the library still swipes (a touch swipe on the rows turns the page).
// Preview suite: PREVIEW=http://127.0.0.1:<port> (scripts/dev-server --preview).
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const ORIGIN = (process.env.PREVIEW || process.env.BASE || 'http://localhost:5181').replace(/\/+$/, '');
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };
const errs = [];

async function bigLibrary(p) {
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' }); await sleep(500);
  await p.evaluate(async () => {
    localStorage.clear();
    const db = (await import('/js/mock.js')).buildMock();
    const base = db.items.slice();
    let n = 0;
    for (const k of ['sheet', 'score', 'book']) {
      const src = base.filter((it) => it.kind === (k === 'book' ? 'sheet' : k));
      for (let i = 0; src.length && i < 60; i++) { const it = src[i % src.length]; db.items.push({ ...it, id: `${it.id}-x${n++}`, title: `${it.title} ${i + 2}`, ...(k === 'book' ? { book: true } : {}) }); }
    }
    localStorage.setItem('meowsic-mock-v6', JSON.stringify(db));
  });
  await p.reload({ waitUntil: 'networkidle0' });
}
const openTab = async (p, k) => { await p.goto(ORIGIN + `/?preview=1#/library${k ? '?kind=' + k : ''}`, { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' }); await sleep(400); };
const pg = (p) => p.$eval('.pager .pg-now', (e) => e.textContent).catch(() => '');
const firstRow = (p) => p.$eval('#lib-rows tr.row', (e) => e.dataset.id).catch(() => '');
const box = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// dy: end on another row, so the browser's click (down and up on one row = open it) is not what is tested
const drag = async (p, r, dx, dy = 5) => { const y = r.y + r.h / 2, x = r.x + r.w / 2; await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + dx, y + dy, { steps: 8 }); await p.mouse.up(); await sleep(250); };
const wheel = async (p, r, deltaX, deltaY) => { await p.mouse.move(r.x + r.w / 2, r.y + r.h / 2); for (let i = 0; i < 4; i++) await p.mouse.wheel({ deltaX, deltaY }); await sleep(300); };

{
  console.log('Mac library');
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await bigLibrary(p);
  check('device = desktop', (await p.evaluate(() => document.documentElement.dataset.device)) === 'desktop');
  check('Chrome history swipe off: overscroll-behavior-x none on html + body', (await p.evaluate(() => [document.documentElement, document.body].map((e) => getComputedStyle(e).overscrollBehaviorX).join())) === 'none,none');
  for (const [k, label] of [['', 'All'], ['sheet', 'Sheets'], ['score', 'Scores'], ['chords', 'Chords'], ['book', 'Books']]) {
    await openTab(p, k);
    const now = await pg(p);
    check(`${label}: ‹ 1 / N › pager with buttons`, /^1 \/ \d+$/.test(now) && !!(await p.$('.pager [data-pg="prev"]')) && !!(await p.$('.pager [data-pg="next"]')), now);
  }
  // Chords is short in the sample: one page still shows the pager, both buttons off
  await openTab(p, 'chords');
  if ((await pg(p)) === '1 / 1') check('one page: pager shown, ‹ › both off', await p.$$eval('.pager button', (e) => e.every((x) => x.disabled)));
  await openTab(p, 'sheet');
  const N = +(await pg(p)).split('/ ')[1];
  check('Sheets has several pages', N >= 3, N);
  const f1 = await firstRow(p);
  await p.click('.pager [data-pg="next"]'); await sleep(250);
  check('› turns to page 2', (await pg(p)) === `2 / ${N}` && (await firstRow(p)) !== f1);
  await p.click('.pager [data-pg="prev"]'); await sleep(250);
  check('‹ back to page 1', (await pg(p)) === `1 / ${N}` && (await firstRow(p)) === f1);
  await p.keyboard.press('ArrowRight'); await sleep(250);
  check('→ key turns', (await pg(p)) === `2 / ${N}`);
  await p.keyboard.press('PageUp'); await sleep(250);
  check('Page Up turns back', (await pg(p)) === `1 / ${N}`);
  const hash = await p.evaluate(() => location.hash);
  const rows = await box(p, '#lib-rows .lib-table tbody');
  await drag(p, rows, -300, 60);
  check('mouse drag left on the rows: same page', (await pg(p)) === `1 / ${N}` && (await firstRow(p)) === f1 && (await p.evaluate(() => location.hash)) === hash);
  await drag(p, rows, 300, -60);
  check('mouse drag right: same page', (await pg(p)) === `1 / ${N}`);
  await wheel(p, rows, 200, 0);
  check('sideways wheel (trackpad swipe): same page, same view', (await pg(p)) === `1 / ${N}` && (await p.evaluate(() => location.hash)) === hash);
  await wheel(p, rows, 0, 400);
  check('wheel down: nothing scrolls, same page', (await pg(p)) === `1 / ${N}` && (await p.evaluate(() => document.querySelector('#main').scrollTop + document.scrollingElement.scrollTop)) === 0);
  // search results get the pager too
  await p.type('#lib-q', '2'); await sleep(300);
  check('search results: ‹ 1 / N › pager', /^1 \/ \d+$/.test(await pg(p)), await pg(p));
  await p.close();
}

{
  console.log('Mac sheet + score');
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1366, height: 1024, deviceScaleFactor: 1 });
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  await p.evaluate(() => (location.hash = '#/item/s-001')); await sleep(1200);
  const shown = () => p.$$eval('#sv-dots i.on', (e) => e.map((x) => x.dataset.p).join('–'));
  check('sheet opens on 1–2', (await shown()) === '1–2', await shown());
  const pages = await box(p, '#pages');
  await drag(p, pages, -300);
  check('sheet: mouse drag left does not turn', (await shown()) === '1–2', await shown());
  await wheel(p, pages, 300, 0);
  check('sheet: sideways wheel does not turn or leave', (await shown()) === '1–2' && (await p.evaluate(() => location.hash)) === '#/item/s-001');
  await p.click('.turn-strip.next'); await sleep(250);
  check('sheet: › strip button turns', (await shown()) === '3');
  await p.click('.turn-strip.prev'); await sleep(250);
  check('sheet: ‹ strip button turns back', (await shown()) === '1–2');
  await p.evaluate(() => (location.hash = '#/item/m-02i')); await sleep(2000);
  const paper = await box(p, '#paper');
  await drag(p, paper, -300); await drag(p, paper, 300);
  await wheel(p, paper, 300, 0);
  check('score: drags and sideways wheel stay on the score (not paged on the Mac)', (await p.evaluate(() => location.hash)) === '#/item/m-02i' && !(await p.$('.score-wrap.paged')));
  await p.close();
}

{
  console.log('iPad keeps its swipes');
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1024, height: 1366, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await bigLibrary(p);
  await openTab(p, 'sheet');
  check('device = tablet', (await p.evaluate(() => document.documentElement.dataset.device)) === 'tablet');
  check('no overscroll rule on the iPad root', (await p.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorX)) === 'auto');
  const N = +(await pg(p)).split('/ ')[1];
  const r = await box(p, '#lib-rows .lib-table tbody');
  const c = await p.target().createCDPSession();
  const y = r.y + r.h / 2, x0 = r.x + r.w * 0.8, x1 = r.x + r.w * 0.2;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 6; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 6, y }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(400);
  check('iPad: swipe left on the rows turns to page 2', (await pg(p)) === `2 / ${N}`, await pg(p));
  await p.close();
}

check('no page errors', !errs.length, errs.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
