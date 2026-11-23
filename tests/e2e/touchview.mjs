// iPad / iPhone item views: no sidebar; on a sheet swipe up or down goes back to the library.
// TOUCH_BASE=http://localhost:5190/ for a test server (default: the real one, :5180; opening items logs plays there)
import puppeteer from 'puppeteer-core';
const BASE = process.env.TOUCH_BASE || 'https://localhost:5180/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const out = process.env.OUT || '.';
const devices = [['ipad-land', 1180, 820], ['ipad-port', 820, 1180], ['iphone', 390, 844]];
const p0 = await b.newPage(); await p0.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const all = await p0.evaluate(() => fetch('/api/items').then((r) => r.json()));
const pick = (k) => all.find((x) => x.kind === k && (k !== 'sheet' || x.pages > 1));
const errs = [];
for (const [name, w, h] of devices) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  for (const k of ['sheet', 'chords', 'score']) {
    const it = pick(k);
    await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
    await p.evaluate((id) => { location.hash = '#/item/' + id; }, it.id); await sleep(k === 'score' ? 3500 : 1500);
    const side = await p.$eval('.side', (e) => getComputedStyle(e).display);
    check(`${name} ${k}: no sidebar`, side === 'none', side);
    const back = await p.$eval('.item-top .back', (e) => e.getBoundingClientRect().width > 0);
    check(`${name} ${k}: Back button shows`, back);
    await p.screenshot({ path: `${out}/touch-${name}-${k}.png` });
    if (k === 'sheet') {
      const box = await p.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      // sideways swipe still turns the page, stays on the sheet
      await p.touchscreen.touchStart(box.x + 120, box.y); await p.touchscreen.touchMove(box.x - 120, box.y); await p.touchscreen.touchEnd(); await sleep(400);
      check(`${name}: sideways swipe stays on the sheet`, (await p.evaluate(() => location.hash)).startsWith('#/item/'));
      await p.touchscreen.touchStart(box.x, box.y - 150);
      for (let i = 1; i <= 5; i++) await p.touchscreen.touchMove(box.x + 3, box.y - 150 + i * 60);
      await p.touchscreen.touchEnd(); await sleep(700);
      check(`${name}: swipe down → library`, (await p.evaluate(() => location.hash)).startsWith('#/library'), await p.evaluate(() => location.hash));
      await p.evaluate((id) => { location.hash = '#/item/' + id; }, it.id); await sleep(1500);
      await p.touchscreen.touchStart(box.x, box.y + 150);
      for (let i = 1; i <= 5; i++) await p.touchscreen.touchMove(box.x, box.y + 150 - i * 60);
      await p.touchscreen.touchEnd(); await sleep(700);
      check(`${name}: swipe up → library`, (await p.evaluate(() => location.hash)) === '#/library', await p.evaluate(() => location.hash));
    }
  }
  await p.close();
}
// Mac: sidebar stays
const m = await b.newPage(); await m.setViewport({ width: 1440, height: 900 });
await m.goto(BASE + '#/item/' + pick('sheet').id, { waitUntil: 'networkidle0' }); await sleep(800);
check('Mac sheet: sidebar still there', (await m.$eval('.side', (e) => getComputedStyle(e).display)) !== 'none');
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
