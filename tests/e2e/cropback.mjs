// A saved crop leaves the history: Back (browser Back = iOS swipe-back) never opens it again, nor does Forward.
//   · sheet ⋯ Crop page… → Crop → the sheet; Back ×3 never shows a crop (the sheet, then the library…)
//   · Fix pages → Crop → Crop → the editor (page selected); Back ×3 never shows a crop; Forward neither
//   · the crop's ‹ Cancel → the sheet; Back never shows a crop
//   · Add sheet music (Photos album): Crop pages… → Crop & next → ‹ Songs → Add; Back never shows a crop
// Against a test server only: BASE (temp data; for the Photos part MEOWSIC_FAKE_PHOTOS = a fake album), SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '.';
const health = await fetch(BASE + 'api/health').then((r) => r.json());
if (!health.ok || /Documents\/Meowsic/.test(health.data)) { console.log('refusing: not a test server', health); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const p = await b.newPage(); await p.setViewport({ width: 1366, height: 1024, hasTouch: true, isMobile: true }); await p.setBypassServiceWorker(true);
p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409|Failed to load resource/.test(m.text()) && errs.push(m.text()));
const hash = () => p.evaluate(() => location.hash);
const isCrop = async () => /\/crop\//.test(await hash()) || !!(await p.$('#cr-stage')) || !!(await p.$('.pi.crop'));
await p.goto(BASE + '#/library?kind=sheet', { waitUntil: 'networkidle0' }); await sleep(600);
const sh = await p.evaluate(async () => {
  const fd = new FormData(); fd.append('title', 'Crop back test'); fd.append('artist', 'E2E');
  for (let k = 1; k <= 3; k++) {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = `rgb(${k * 60},200,120)`; g.fillRect(0, 0, 600, 800); g.fillStyle = '#000'; g.font = 'bold 300px sans-serif'; g.fillText(String(k), 200, 500); g.font = '20px sans-serif'; g.fillText(String(Math.random()), 20, 760);  // unique bytes
    fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `cb${k}.png`);
  }
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
});
let loads = 0;  // a fresh page load each part: Back ×3 may have left the app
const fresh = async () => { await p.goto(`${BASE}?r=${++loads}#/library?kind=sheet`, { waitUntil: 'networkidle0' }); await sleep(600); };
const nav = async (h) => { await p.evaluate((h) => { location.hash = h; }, h); await sleep(1200); };  // a push, like a tap on a link
const saveCrop = async (sel = '#cr-ok') => {
  await p.waitForSelector('#cr-stage img', { timeout: 8000 }).catch(() => {}); await sleep(500);
  await p.$eval('#cr-whole', (e) => e.click()); await sleep(100);  // start from the whole page so the crop is a change
  for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowDown');
  await p.$eval(sel, (e) => e.click()); await sleep(1800);
};
const backs = async (label, n = 3) => {
  const seen = [];
  for (let i = 0; i < n; i++) {
    await p.goBack({ timeout: 3000 }).catch(() => {}); await sleep(900);
    seen.push(await hash());
    if (await isCrop()) return check(`${label}: Back ×${n} never opens the crop`, false, seen.join(' → '));
  }
  check(`${label}: Back ×${n} never opens the crop`, true);
  return seen;
};

// ---- 1. the sheet ⋯ Crop page… → Crop → the sheet ----
const item = `#/item/${sh.id}`;
await nav(item);
await nav(`#/manage/pages/${sh.id}/crop/1?back=item`);
check('crop open', await isCrop());
await saveCrop();
check('Crop saves and lands on the sheet', (await hash()) === item, await hash());
const c1 = await fetch(`${BASE}api/items/${sh.id}/crops`).then((r) => r.json());
check('page 1 is cropped on the Mac', !!c1.pages[0].crop, JSON.stringify(c1.pages[0]));
let seen = await backs('from the sheet');
check('…the first Back goes to the library', seen?.[0]?.startsWith('#/library'), seen?.join(' → '));
await p.goForward().catch(() => {}); await sleep(900); await p.goForward().catch(() => {}); await sleep(900);
check('Forward ×2 never opens the crop', !(await isCrop()), await hash());

// ---- 2. Fix pages → Crop → the editor ----
const ed = `#/manage/pages/${sh.id}`;
await fresh();
await nav(ed);
await nav(`#/manage/pages/${sh.id}/crop/2`);
await saveCrop();
check('Crop lands in Fix pages (not the crop)', (await hash()).startsWith(ed) && !(await isCrop()) && !!(await p.$('#pe-grid')), await hash());
seen = await backs('from Fix pages');
check('…the first Back goes to the library', seen?.[0]?.startsWith('#/library'), seen?.join(' → '));
await p.goForward().catch(() => {}); await sleep(900); await p.goForward().catch(() => {}); await sleep(900);
check('Forward ×2 never opens the crop', !(await isCrop()), await hash());

// ---- 3. Crop & next, then Crop & finish (last page) ----
await fresh();
await nav(ed);
await nav(`#/manage/pages/${sh.id}/crop/2`);
await saveCrop('#cr-oknext');
check('Crop & next → page 3 (still the crop)', /\/crop\/3/.test(await hash()), await hash());
await saveCrop('#cr-oknext');
check('Crop & finish → Fix pages', (await hash()).startsWith(ed) && !(await isCrop()), await hash());
await backs('after Crop & next / finish');

// ---- 4. ‹ Cancel ----
await fresh();
await nav(item);
await nav(`#/manage/pages/${sh.id}/crop/1?back=item`);
await p.waitForSelector('#cr-stage img', { timeout: 8000 }).catch(() => {});
await p.$eval('.mg-back', (e) => e.click()); await sleep(1200);
check('‹ Cancel → the sheet', (await hash()) === item, await hash());
await backs('after ‹ Cancel');
// …and Esc
await nav(item);
await nav(`#/manage/pages/${sh.id}/crop/1?back=item`);
await p.waitForSelector('#cr-stage img', { timeout: 8000 }).catch(() => {}); await sleep(1200);
await p.keyboard.press('Escape'); await sleep(1200);
check('Esc → the sheet', (await hash()) === item, await hash());
await backs('after Esc');
await p.screenshot({ path: `${SHOTS}/cropback.png` });

// ---- 5. Add sheet music (the Photos album, when the server has a fake one) ----
const al = await fetch(BASE + 'api/photos/album').then((r) => r.json());
if (al.new > 0) {
  await fresh();
  await nav('#/add-sheets');
  const ok = await p.waitForFunction(() => document.querySelectorAll('#pi-grid figure').length > 0, { timeout: 60000 }).then(() => true, () => false);
  check('Add sheet music: the new photos', ok, await p.evaluate(() => location.hash + ' ' + document.querySelector('#main').innerText.slice(0, 300)));
  if (!ok) throw new Error('no photos');
  await p.$eval('#pi-crop', (e) => e.click()); await sleep(900);
  await p.keyboard.press('c'); for (let i = 0; i < 10; i++) await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter'); await sleep(700);
  await p.$eval('#pi-done-crop', (e) => e.click()); await sleep(400);
  await p.$eval('#pi-add', (e) => e.click()); await sleep(400);
  await p.$eval('.modal [data-ok]', (e) => e.click());
  await p.waitForFunction(() => !!document.querySelector('.pi-done'), { timeout: 20000 }).catch(() => {});
  check('added', !!(await p.$('.pi-done')));
  await p.$eval('#pi-open', (e) => e.click()); await sleep(1200);
  check('Open the library', (await hash()).startsWith('#/library'), await hash());
  await backs('after Add sheet music');
  for (const imp of await fetch(BASE + 'api/photos/imports').then((r) => r.json())) if (!imp.undoneAt) await post(`/photos/imports/${imp.id}/undo`, {});
} else console.log('  (no fake Photos album: the Add sheet music part is skipped)');

await post('/items/purge', { ids: [sh.id] });
check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
