// Manage library → Fix pages (#/manage/pages/<id>): the clean page grid + one dock, on Mac (1440×900, click /
// ⌘-click, drag, keys), iPad (1032×1376 touch, real taps, hold + drag) and iPhone (390×844 touch):
//   · no buttons on the pages; tap = select (✓); the dock (Crop · Move · New song here · Merge with… · Delete)
//     is off until a page is selected (Merge with… always on)
//   · Delete one page / several (confirm), Move (dock, then tap the place), drag; each undoable (header Undo),
//     an Activities row each, the deleted page kept in .history
//   · no hint text anywhere (no sub-line, no banner, no dock hint); Help (next to Done) opens a dialog, Close shuts it
//   · opens with no song break (stale marks on the Mac cleared; no suggested starts); New song here → "Song 2 · title
//     · ✕" line; Done becomes Make sheets → "Split into 2 sheets" → 2 sheets; Undo
//   · iPad Pro 13 / iPad 11, portrait + landscape, touch, safe-area insets: no sideways scroll, header one line, the
//     dock whole on screen and the last row above it, tiles 8.5 : 11, the song line fits, the crop fits
//   · Crop (full screen): draw a box, Crop & next carries the box to page 3, Cancel → back with page 2 selected
//     and a "cropped" tag; Undo takes the crop off
//   · Merge with… → pick the other sheet → its pages after these, it goes to the Trash; Undo
//   · books are not editable here; the sheet ⋯ Edit pages… / Crop page… open here and Back returns to the sheet
// Against a test server only: BASE (a temp data dir; refuses ~/Documents/Meowsic), DATA (to see .history), SHOTS.
import fs from 'node:fs';
import path from 'node:path';
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const DATA = process.env.DATA || '';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/organizepages';
fs.mkdirSync(SHOTS, { recursive: true });
const health = await fetch(BASE + 'api/health').then((r) => r.json());
if (!health.ok || /Documents\/Meowsic/.test(health.data)) { console.log('refusing: not a test server', health); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const newPage = async (vp, ua) => {
  const p = await b.newPage(); if (ua) await p.setUserAgent(ua); await p.setViewport(vp); await p.setBypassServiceWorker(true);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409|Failed to load resource/.test(m.text()) && errs.push(m.text()));
  return p;
};
const colour = (n) => [(n * 37) % 256, 240 - n * 22, 30 + n * 21];
const COLS = Array.from({ length: 10 }, (_, k) => colour(k + 1));

const mac = await newPage({ width: 1440, height: 900 });
await mac.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const upload = (title, from, n) => mac.evaluate(async (title, from, n, cols) => {
  const fd = new FormData(); fd.append('title', title); fd.append('artist', 'E2E');
  for (let k = from; k < from + n; k++) {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = `rgb(${cols[k - 1].join(',')})`; g.fillRect(0, 0, 600, 800);
    g.fillStyle = '#000'; g.font = 'bold 340px sans-serif'; g.textAlign = 'center'; g.fillText(String(k), 300, 520);
    fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `o${k}.png`);
  }
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, from, n, COLS);
// which test page (by colour) is page k now
const order = (id) => mac.evaluate(async (id, cols) => {
  const it = await (await fetch(`/api/items/${id}`)).json(), out = [];
  for (let n = 1; n <= it.pages; n++) {
    const img = new Image(); img.src = `/api/items/${id}/pages/${n}?x=${Math.random()}`; await img.decode();
    const c = document.createElement('canvas'); c.width = 4; c.height = 4; c.getContext('2d').drawImage(img, 0, 0);
    const [r, g, bl] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
    out.push(cols.findIndex((x) => Math.abs(x[0] - r) + Math.abs(x[1] - g) + Math.abs(x[2] - bl) < 14) + 1);
  }
  return out.join(',');
}, id, COLS);
const historyCount = (it) => {
  if (!DATA) return null;
  const d = path.join(DATA, 'items', it.folder, '.history');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^deleted-/.test(f)).length : 0;
};

const DEVICES = [['mac', { width: 1440, height: 900 }], ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }, IPAD_UA], ['iphone', { width: 390, height: 844, hasTouch: true, isMobile: true }, PHONE_UA]];
for (const [name, vp, ua] of DEVICES) {
  console.log(name);
  const T = `Fix ${name}`;
  const sh = await upload(T, 1, 6), sh2 = await upload(`${T} other`, 7, 2);
  const p = name === 'mac' ? mac : await newPage(vp, ua);
  const touch = name !== 'mac';
  // a real tap (touch: scrolled into view, then touchscreen.tap at its centre) or a click
  const tap = async (sel, mods = []) => {
    const h = await p.$(sel); if (!h) throw new Error('no ' + sel);
    await h.evaluate((e) => { const r = e.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 100) e.scrollIntoView({ block: 'center' }); });
    await sleep(120);
    const r = await h.boundingBox();
    if (touch) await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    else { for (const m of mods) await p.keyboard.down(m); await p.mouse.click(r.x + r.width / 2, r.y + r.height / 2); for (const m of mods) await p.keyboard.up(m); }
    await sleep(250);
  };
  const tile = (n) => `#pe-grid .pe-tile[data-p="${n}"]`;
  // select page n alone (touch: a tap toggles one page, so the others are tapped off first)
  const only = async (n) => { if (!touch) return tap(tile(n)); for (const x of await sel()) if (x !== n) await tap(tile(x)); if (!(await sel()).includes(n)) await tap(tile(n)); };
  const tiles = () => p.$$eval('#pe-grid .pe-tile', (e) => e.length);
  const sel = () => p.$$eval('#pe-grid .pe-tile.sel', (e) => e.map((x) => +x.dataset.p));
  const dis = (a) => p.$eval(`#pe-dock [data-act="${a}"]`, (e) => e.disabled);
  const undo = async () => { await tap('#pe-undo'); await sleep(1500); };
  const open = async () => { await p.goto(BASE + `#/manage/pages/${sh.id}`, { waitUntil: 'networkidle2' }); await p.waitForSelector(tile(1), { timeout: 8000 }).catch(() => {}); await sleep(400); };
  await open();
  check(`${name}: the editor shows 6 pages, no buttons on them`, (await tiles()) === 6 && !(await p.$('#pe-grid .pe-tile button')), await tiles());
  check(`${name}: no side pane, no song chip row`, !(await p.$('.og-side, .bs-segs, .bs-side')));
  check(`${name}: dock off until a page is selected (Merge with… on)`, (await dis('crop')) && (await dis('delete')) && (await dis('move')) && !(await dis('merge')));
  const fit = await p.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, mw: document.querySelector('#main').scrollWidth, mcw: document.querySelector('#main').clientWidth }));
  check(`${name}: no sideways scroll`, fit.sw <= fit.iw + 1 && fit.mw <= fit.mcw + 1, JSON.stringify(fit));
  const cols = await p.$eval('#pe-grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  check(`${name}: ${{ mac: 6, ipad: 5, iphone: 2 }[name]} pages a row`, cols === { mac: 6, ipad: 5, iphone: 2 }[name], cols);
  const hints = await p.evaluate(() => ({ sub: !!document.querySelector('.pe #mg-sub'), banner: !!document.querySelector('#pe-banner, #pe-hint'), text: /tap a page|click a page|first page of each song|you marked|starts here/i.test(document.querySelector('#main').innerText) }));
  check(`${name}: no hint text (no sub-line, banner or dock hint)`, !hints.sub && !hints.banner && !hints.text, JSON.stringify(hints));
  check(`${name}: Help sits next to Done`, await p.evaluate(() => document.querySelector('#pe-help')?.nextElementSibling?.id === 'pe-done'));
  await tap('#pe-help'); await sleep(300);
  check(`${name}: Help opens a dialog that explains it`, /Select[\s\S]*Crop[\s\S]*Move[\s\S]*New song here[\s\S]*Merge[\s\S]*Delete[\s\S]*Undo[\s\S]*Make sheets/.test(await p.$eval('#pe-helpdlg', (e) => e.innerText).catch(() => '')));
  await tap('#pe-helpx'); await sleep(300);
  check(`${name}: Close shuts it`, !(await p.$('#pe-helpdlg')));
  const dock = await p.$eval('#pe-dock', (e) => { const r = e.getBoundingClientRect(); return { b: r.bottom, h: innerHeight, l: r.left, r: r.right, w: innerWidth }; });
  check(`${name}: the dock floats at the bottom, on screen`, dock.b <= dock.h && dock.b > dock.h - 60 && dock.l >= 0 && dock.r <= dock.w, JSON.stringify(dock));

  // ---- select + delete one page ----
  await only(2);
  check(`${name}: tap selects (✓, dock on)`, JSON.stringify(await sel()) === '[2]' && !(await dis('delete')));
  await p.screenshot({ path: path.join(SHOTS, `editor-${name}.png`) });
  const h0 = historyCount(sh);
  await tap('#pe-dock [data-act="delete"]'); await sleep(1800);
  check(`${name}: Delete removes page 2 (on the Mac)`, (await order(sh.id)) === '1,3,4,5,6' && (await tiles()) === 5, await order(sh.id));
  if (h0 !== null) check(`${name}: the deleted page is kept in .history`, historyCount(sh) === h0 + 1);
  check(`${name}: an undoable Activities row`, (await api('/activity')).some((a) => a.type === 'pages' && a.action === 'undo' && /deleted page 2/.test(a.detail)));
  await undo();
  check(`${name}: Undo brings page 2 back`, (await order(sh.id)) === '1,2,3,4,5,6' && (await tiles()) === 6, await order(sh.id));

  // ---- select several + delete (asks first) ----
  await only(2); await tap(tile(3), ['Meta']);
  check(`${name}: several selected (2, 3)`, JSON.stringify(await sel()) === '[2,3]', JSON.stringify(await sel()));
  await tap('#pe-dock [data-act="delete"]'); await sleep(300);
  check(`${name}: deleting 2 pages asks first`, /Delete 2 pages/.test(await p.$eval('.modal h2', (e) => e.textContent).catch(() => '')));
  await tap('.modal [data-ok]'); await sleep(1800);
  check(`${name}: pages 2 and 3 deleted`, (await order(sh.id)) === '1,4,5,6', await order(sh.id));
  await undo();
  check(`${name}: Undo brings both back`, (await order(sh.id)) === '1,2,3,4,5,6', await order(sh.id));

  // ---- Move (dock, then tap the place) ----
  await only(1);
  check(`${name}: page 1 alone selected`, JSON.stringify(await sel()) === '[1]', JSON.stringify(await sel()));
  await tap('#pe-dock [data-act="move"]');
  check(`${name}: Move is on (its button says Cancel)`, (await p.$eval('#pe-dock [data-act="move"]', (e) => e.classList.contains('on') && /Cancel/.test(e.textContent))) && !(await p.$('#pe-banner')));
  await tap(tile(3)); await sleep(1800);
  check(`${name}: Move → tap page 3: page 1 goes there`, (await order(sh.id)) === '2,3,1,4,5,6', await order(sh.id));
  await undo();
  check(`${name}: undo the move`, (await order(sh.id)) === '1,2,3,4,5,6');

  // ---- drag page 5 before page 4 ----
  await p.$eval(tile(4), (e) => e.scrollIntoView({ block: 'center' })); await sleep(300);
  const rect = (s) => p.$eval(s, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.x, w: r.width }; });
  const from = await rect(`${tile(5)} img`), to = await rect(`${tile(4)} img`);
  const tx = to.l + to.w * 0.2, ty = to.y;
  if (!touch) {
    await p.mouse.move(from.x, from.y); await p.mouse.down();
    for (let k = 1; k <= 12; k++) { await p.mouse.move(from.x + (tx - from.x) * k / 12, from.y + (ty - from.y) * k / 12); await sleep(20); }
    check('mac: dragging shows where it goes', !!(await p.$('#pe-grid .drop-before')));
    await p.mouse.up();
  } else {
    const cdp = await p.target().createCDPSession();
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', from.x, from.y); await sleep(550);
    for (let k = 1; k <= 12; k++) { await tp('touchMove', from.x + (tx - from.x) * k / 12, from.y + (ty - from.y) * k / 12); await sleep(25); }
    check(`${name}: hold + drag shows where it goes`, !!(await p.$('#pe-grid .drop-before')));
    await tp('touchEnd'); await cdp.detach();
  }
  await sleep(2000);
  check(`${name}: drag moved page 5 before 4`, (await order(sh.id)) === '1,2,3,5,4,6', await order(sh.id));
  await undo();
  check(`${name}: undo the drag`, (await order(sh.id)) === '1,2,3,4,5,6');

  if (name === 'mac') {  // keys: → selects the next page, ⇧→ moves it
    await only(2); await p.keyboard.press('ArrowRight'); await sleep(200);
    check('mac: → selects page 3', JSON.stringify(await sel()) === '[3]');
    await p.keyboard.down('Shift'); await p.keyboard.press('ArrowRight'); await p.keyboard.up('Shift'); await sleep(1800);
    check('mac: ⇧→ moves page 3 right', (await order(sh.id)) === '1,2,4,3,5,6', await order(sh.id));
    await p.keyboard.press('u'); await sleep(1800);
    check('mac: U undoes it', (await order(sh.id)) === '1,2,3,4,5,6');
  }

  // ---- crop page 2, full screen ----
  await only(2);
  await tap('#pe-dock [data-act="crop"]'); await sleep(1500);
  check(`${name}: Crop opens page 2 full screen (the original photo)`, (await p.evaluate(() => location.hash)).startsWith(`#/manage/pages/${sh.id}/crop/2`) && /\/pages\/2\/original/.test(await p.$eval('#cr-stage img', (e) => e.src).catch(() => '')));
  const ir = await p.$eval('#cr-stage img', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const wr = await p.$eval('#cr-stage .cu-img', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  check(`${name}: the box frame matches the photo, on screen`, Math.abs(wr.w - ir.w) < 2 && Math.abs(wr.h - ir.h) < 2 && ir.y + ir.h <= vp.height, JSON.stringify([ir, wr]));
  const A = [ir.x + ir.w * 0.15, ir.y + ir.h * 0.12], B = [ir.x + ir.w * 0.85, ir.y + ir.h * 0.8];
  if (!touch) { await p.mouse.move(...A); await p.mouse.down(); for (let k = 1; k <= 8; k++) await p.mouse.move(A[0] + (B[0] - A[0]) * k / 8, A[1] + (B[1] - A[1]) * k / 8); await p.mouse.up(); }
  else {
    const cdp = await p.target().createCDPSession();
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', ...A); for (let k = 1; k <= 8; k++) await tp('touchMove', A[0] + (B[0] - A[0]) * k / 8, A[1] + (B[1] - A[1]) * k / 8); await tp('touchEnd'); await cdp.detach();
  }
  await sleep(200);
  check(`${name}: drawing a box`, (await p.$eval('#cr-stage', (e) => e.dataset.from)) === 'Your box');
  await p.screenshot({ path: path.join(SHOTS, `crop-${name}.png`) });
  await tap('#cr-oknext'); await sleep(2000);
  let crops = (await api(`/items/${sh.id}/crops`)).pages;
  check(`${name}: page 2 cropped on the Mac`, crops[1].crop && Math.abs(crops[1].crop.top - 0.12) < 0.03 && Math.abs(crops[1].crop.right - 0.85) < 0.03, JSON.stringify(crops[1]));
  check(`${name}: Crop & next → page 3 with the same box`, /3 of 6/.test(await p.$eval('.mg-t h2', (e) => e.textContent)) && (await p.$eval('#cr-stage', (e) => e.dataset.from)) === 'Same box as the last page' && /\/crop\/3/.test(await p.evaluate(() => location.hash)));
  if (name === 'mac') {
    await tap('#cr-boxes'); await p.evaluate(() => [...document.querySelectorAll('.menu button')].find((b) => /Save this box as box 1/.test(b.textContent)).click()); await sleep(800);
    await tap('#cr-whole');
    check('mac: Whole page', (await p.$eval('#cr-stage', (e) => e.dataset.from)) === 'Whole page');
    await p.keyboard.press('1'); await sleep(200);
    check('mac: key 1 uses saved box 1', (await p.$eval('#cr-stage', (e) => e.dataset.from)) === 'Saved box 1');
  }
  await tap('.mg-back'); await sleep(1500);
  check(`${name}: Cancel → back in the editor, page 2 selected, tagged "cropped"`, JSON.stringify(await sel()) === '[2]' && !!(await p.$(`${tile(2)} .pe-cropped`)), JSON.stringify(await sel()));
  check(`${name}: Undo offers the crop`, /crop page 2/.test(await p.$eval('#pe-undo', (e) => e.title)));
  await undo();
  crops = (await api(`/items/${sh.id}/crops`)).pages;
  check(`${name}: Undo takes the crop off`, !crops[1].crop, JSON.stringify(crops[1]));

  // ---- New song here → Done → Split into 2 sheets → Undo ----
  await only(4);
  await tap('#pe-dock [data-act="mark"]'); await sleep(900);
  check(`${name}: "Song 2" line before page 4`, /^Song 2$/.test(await p.$eval('#pe-grid .pe-break .pe-bt', (e) => e.textContent).catch(() => '')) && (await p.$eval('#pe-grid .pe-break + .pe-tile', (e) => e.dataset.p)) === '4');
  check(`${name}: Done says Make sheets, no banner`, (await p.$eval('#pe-done', (e) => e.textContent)) === 'Make sheets' && !(await p.$('#pe-banner')));
  check(`${name}: saved on the Mac`, '4' in (await api(`/sheets/${sh.id}/split`)).starts);
  await p.screenshot({ path: path.join(SHOTS, `editor-song-${name}.png`) });
  await tap('.pe-break [data-act="unmark"]'); await sleep(900);
  check(`${name}: ✕ takes the line away`, !(await p.$('#pe-grid .pe-break')) && !('4' in (await api(`/sheets/${sh.id}/split`)).starts));
  await only(4);
  await tap('#pe-dock [data-act="mark"]'); await sleep(900);
  await tap('#pe-done'); await sleep(400);
  check(`${name}: Make sheets asks "Split into 2 sheets"`, /Split into 2 sheets/.test(await p.$eval('.modal [data-ok]', (e) => e.textContent).catch(() => '')));
  await tap('.modal [data-ok]'); await sleep(2500);
  const it1 = await api('/items/' + sh.id);
  check(`${name}: split: this sheet keeps pages 1–3, back to the picker`, it1.pages === 3 && (await p.evaluate(() => location.hash)) === '#/manage/pages', `${it1.pages} ${await p.evaluate(() => location.hash)}`);
  await open();
  await undo();
  check(`${name}: Undo puts the 6 pages back`, (await api('/items/' + sh.id)).pages === 6 && (await order(sh.id)) === '1,2,3,4,5,6');

  // ---- Merge with… ----
  await tap('#pe-dock [data-act="merge"]'); await sleep(900);
  await p.type('#pe-mq', `${T} other`); await sleep(300);
  await tap(`#pe-ml [data-id="${sh2.id}"]`); await sleep(400);
  await tap('.modal [data-ok]'); await sleep(2500);
  check(`${name}: Merge with… adds the other sheet's pages`, (await order(sh.id)) === '1,2,3,4,5,6,7,8' && (await api('/items/' + sh2.id)).deleted, await order(sh.id));
  await undo();
  check(`${name}: Undo the merge`, (await order(sh.id)) === '1,2,3,4,5,6' && !(await api('/items/' + sh2.id)).deleted);
  // ---- opens with no song break, even with marks left on the Mac (old suggested starts) ----
  await p.goto(BASE + '#/manage/pages', { waitUntil: 'networkidle2' }); await sleep(300);
  await post(`/sheets/${sh.id}/split`, { starts: { 3: 'Old guess', 5: '' } });
  await open(); await sleep(600);
  check(`${name}: opens with no song break; the stale marks are cleared on the Mac`, !(await p.$('#pe-grid .pe-break')) && !Object.keys((await api(`/sheets/${sh.id}/split`)).starts).length && (await p.$eval('#pe-done', (e) => e.textContent)) === 'Done');
  await p.goto(BASE + '#/manage/pages', { waitUntil: 'networkidle2' }); await sleep(300);
  await p.goto(BASE + `#/manage/pages/${sh.id}?mark=3,5`, { waitUntil: 'networkidle2' }); await sleep(1200);
  check(`${name}: an old ?mark= link marks nothing`, !(await p.$('#pe-grid .pe-break')) && !Object.keys((await api(`/sheets/${sh.id}/split`)).starts).length);
  if (name !== 'mac') await p.close();
  await post('/items/purge', { ids: [sh.id, sh2.id] });
}

// ---- iPad Pro 13 and iPad 11, portrait + landscape: touch, safe-area insets (Home Screen app) ----
const IPADS = [['iPad Pro 13 portrait', 1032, 1376], ['iPad Pro 13 landscape', 1376, 1032], ['iPad 11 portrait', 820, 1180], ['iPad 11 landscape', 1180, 820]];
{
  const sh = await upload('iPad layout sheet with quite a long title to see it ellipsize', 1, 10);
  for (const [nm, w, h] of IPADS) {
    const p = await newPage({ width: w, height: h, hasTouch: true, isMobile: true }, IPAD_UA);
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, bottom: 20, left: 0, right: 0 } }).catch(() => {});
    const tapXY = async (sel) => { const r = await (await p.$(sel)).boundingBox(); await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); await sleep(400); };
    const slug = nm.replace(/ /g, '-').toLowerCase();
    // the editor, with one song break and a long title in it
    await p.goto(BASE + `#/manage/pages/${sh.id}`, { waitUntil: 'networkidle2' }); await p.waitForSelector('#pe-grid .pe-tile', { timeout: 8000 }).catch(() => {}); await sleep(500);
    check(`${nm}: no song break on open`, !(await p.$('#pe-grid .pe-break')));
    await tapXY('#pe-grid .pe-tile[data-p="4"]'); await tapXY('#pe-dock [data-act="mark"]'); await sleep(500);
    await p.$eval('.pe-title', (e) => { e.value = 'A very long title for the second song, long enough to overflow'; });
    const m = await p.evaluate(() => {
      const main = document.querySelector('#main'), top = document.querySelector('.mg-top'), R = (s) => document.querySelector(s).getBoundingClientRect();
      const kids = [...top.children].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
      const img = R('#pe-grid .pe-tile img'), br = R('.pe-break'), inp = R('.pe-title'), x = R('.pe-break .pe-x'), dock = R('#pe-dock'), dk = document.querySelector('#pe-dock');
      return { sw: document.scrollingElement.scrollWidth, iw: innerWidth, mw: main.scrollWidth, mcw: main.clientWidth, oneLine: kids.every((k) => k.top < kids[0].bottom && k.bottom > kids[0].top), topH: Math.round(R('.mg-top').height),
        aspect: img.width / img.height, brH: br.height, inpIn: inp.right <= br.right && x.right <= br.right + 1 && inp.width <= 340, dock: { t: dock.top, b: dock.bottom, l: dock.left, r: dock.right }, dockFits: dk.scrollWidth <= dk.clientWidth + 1, ih: innerHeight };
    });
    check(`${nm}: no sideways scroll`, m.sw <= m.iw + 1 && m.mw <= m.mcw + 1, JSON.stringify(m));
    check(`${nm}: header on one line`, m.oneLine && m.topH <= 100, JSON.stringify(m));
    check(`${nm}: tiles keep 8.5 : 11`, Math.abs(m.aspect - 8.5 / 11) < 0.01, m.aspect);
    check(`${nm}: the song line is one line, its title box fits`, m.brH < 70 && m.inpIn, JSON.stringify(m));
    check(`${nm}: the dock is whole on screen, above the home indicator`, m.dock.t >= 0 && m.dock.b <= m.ih - 20 && m.dock.l >= 0 && m.dock.r <= m.iw && m.dockFits, JSON.stringify(m));
    await p.screenshot({ path: path.join(SHOTS, `${slug}-editor.png`) });
    await p.evaluate(() => { const e = document.querySelector('#main'); e.scrollTop = e.scrollHeight; }); await sleep(400);
    const lb = await p.evaluate(() => { const ts = [...document.querySelectorAll('#pe-grid .pe-tile')], last = ts.at(-1).getBoundingClientRect(), d = document.querySelector('#pe-dock').getBoundingClientRect(); return { last: last.bottom, dock: d.top, ih: innerHeight }; });
    check(`${nm}: scrolled to the bottom, the last page is above the dock`, lb.last <= lb.dock && lb.last > 0, JSON.stringify(lb));
    await p.screenshot({ path: path.join(SHOTS, `${slug}-editor-bottom.png`) });
    // the crop
    await p.goto(BASE + `#/manage/pages/${sh.id}/crop/2`, { waitUntil: 'networkidle2' }); await p.waitForSelector('#cr-stage img', { timeout: 8000 }).catch(() => {}); await sleep(800);
    const c = await p.evaluate(() => {
      const R = (s) => document.querySelector(s)?.getBoundingClientRect(), img = R('#cr-stage img'), bar = R('.pe-cbar'), top = R('.mg-top');
      return { sw: document.scrollingElement.scrollWidth, iw: innerWidth, ih: innerHeight, img: img && { t: img.top, b: img.bottom, l: img.left, r: img.right }, bar: { t: bar.top, b: bar.bottom }, top: top.bottom };
    });
    check(`${nm}: the crop fits (photo between the header and the bar, bar on screen)`, c.img && c.img.t >= c.top && c.img.b <= c.bar.t && c.img.l >= 0 && c.img.r <= c.iw && c.bar.b <= c.ih + 1 && c.sw <= c.iw + 1, JSON.stringify(c));
    await p.screenshot({ path: path.join(SHOTS, `${slug}-crop.png`) });
    await p.close();
  }
  await post('/items/purge', { ids: [sh.id] });
}

// ---- books are not editable; the sheet ⋯ opens the editor / the crop, Back returns to the sheet ----
console.log('mac: books, Edit pages… and Crop page…');
const sh = await upload('Fix from the sheet', 1, 3);
let book = await upload('Fix book', 4, 3);
book = (await post('/items/book', { ids: [book.id], book: true })).items[0];
await mac.goto(BASE + `#/manage/pages/${book.id}`, { waitUntil: 'networkidle2' }); await sleep(1200);
check('a book is not editable here', !(await mac.$('#pe-grid .pe-tile')) && /Books are kept/.test(await mac.$eval('#pe-grid', (e) => e.textContent)));
await mac.goto(BASE + `#/item/${sh.id}`, { waitUntil: 'networkidle0' }); await mac.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
const menuPick = async (label) => { await mac.$eval('#it-more', (e) => e.click()); await sleep(400); await mac.evaluate((l) => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === l).click(), label); await sleep(1500); };
await menuPick('Edit pages…');
check('Edit pages… opens this sheet in Fix pages', (await mac.evaluate(() => location.hash)) === `#/manage/pages/${sh.id}?back=item` && (await mac.$$eval('#pe-grid .pe-tile', (e) => e.length)) === 3);
check('Back says the sheet', (await mac.$eval('.mg-back', (e) => e.textContent)).includes('Fix from the sheet'));
await mac.click('.mg-back'); await sleep(1000);
check('Back returns to the sheet', (await mac.evaluate(() => location.hash)) === `#/item/${sh.id}`);
await sleep(600);
await menuPick('Crop page…');
check('Crop page… opens the crop of page 1', (await mac.evaluate(() => location.hash)).startsWith(`#/manage/pages/${sh.id}/crop/1`) && !!(await mac.$('#cr-stage img')));
await mac.click('.mg-back'); await sleep(1000);
check('…its Cancel returns to the sheet', (await mac.evaluate(() => location.hash)) === `#/item/${sh.id}`);
await post('/items/purge', { ids: [sh.id, book.id] });

check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
