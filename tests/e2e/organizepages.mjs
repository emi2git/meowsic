// Manage library → Organize pages: delete and reorder pages (✕, ‹ ›, drag with the mouse and with touch, across
// a song start), Undo, the sheet viewer showing the new order, Merge…, Refresh (scan job) → Recommended to check,
// "This is a complete song" + Show hidden, and the Trash tab — on Mac, iPad (1032×1376 touch) and iPhone (420×912 touch).
// Against a test server only: BASE (default :5190) and DATA (its data folder, to see .history). SHOTS = screenshot folder.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const DATA = process.env.DATA || '';
const SHOTS = process.env.SHOTS || '.';
const T = 'Organize test', T2 = 'Organize test (part 2)', N = 6;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const newPage = async (vp) => {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  return p;
};
const colour = (n) => [(n * 37) % 256, 240 - n * 22, 30 + n * 21];
const COLS = Array.from({ length: 10 }, (_, k) => colour(k + 1));

const mac = await newPage({ width: 1440, height: 900 });
await mac.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const purgeOld = async () => {
  const old = (await api('/items?deleted=true')).concat(await api('/items')).filter((x) => x.title.startsWith(T));
  if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
};
await purgeOld();
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
let sh = await upload(T, 1, N);
const sh2 = await upload(T2, 7, 2);
await post(`/sheets/${sh.id}/split`, { starts: { 4: 'Second' } });  // song 1 = pages 1–3, song 2 = 4–6

// which test page (by colour) is page k now — through the stable page URLs /api/items/{id}/pages/{n}
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
const deletedInHistory = () => {
  if (!DATA) return null;
  const d = path.join(DATA, 'items', sh.folder, '.history');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^deleted-[0-9a-fx]+-p[0-9]+\.[a-z]+$/.test(f)).length : 0;  // the page photos (not their crop history)
};
check('test sheet pages in order', (await order(sh.id)) === '1,2,3,4,5,6');

const open = async (p, id) => {
  await p.goto(BASE + `#/manage?id=${id}`, { waitUntil: 'networkidle2', timeout: 60000 }); await sleep(1500);  // the Mac may still be reading page titles
  await p.waitForSelector('#bs-grid figure', { timeout: 8000 }).catch(() => {});
};
const figCount = (p) => p.$$eval('#bs-grid figure', (e) => e.length);
const undoBtn = async (p) => { await p.$eval('#cu-undo', (e) => e.click()); await sleep(1600); };

for (const [name, vp] of [['mac', { width: 1440, height: 900 }], ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  console.log(name);
  const p = name === 'mac' ? mac : await newPage(vp);
  const touch = name !== 'mac';
  await open(p, sh.id);
  check(`${name}: Manage library → Organize pages, 6 pages`, (await p.$eval('.cu-tabs a.on', (e) => e.dataset.tab)) === 'organize' && (await figCount(p)) === N, await figCount(p));
  check(`${name}: every page has ✕ and ‹ ›`, (await p.$$('#bs-grid .og-del')).length === N && (await p.$$('#bs-grid .og-mv')).length === 2 * N);
  const fit = await p.evaluate(() => { const se = document.scrollingElement; return { sw: se.scrollWidth, iw: innerWidth, sh: se.scrollHeight, ih: innerHeight }; });
  check(`${name}: no page scroll`, fit.sw <= fit.iw + 1 && fit.sh <= fit.ih + 1, JSON.stringify(fit));
  if (name === 'iphone') check('iphone: delete button big enough', (await p.$eval('#bs-grid .og-del', (e) => e.getBoundingClientRect().width)) >= 34);
  // ---- delete page 2 ----
  const h0 = deletedInHistory();
  const tapOrClick = (sel) => (touch ? p.tap(sel) : p.click(sel));
  await tapOrClick('#bs-grid figure[data-p="2"] .og-del'); await sleep(1800);
  check(`${name}: ✕ deletes page 2 (on the Mac)`, (await order(sh.id)) === '1,3,4,5,6' && (await figCount(p)) === 5, await order(sh.id));
  if (h0 !== null) check(`${name}: the deleted page is kept in .history`, deletedInHistory() === h0 + 1, `${h0} → ${deletedInHistory()}`);
  check(`${name}: song 2 still starts on its page`, JSON.stringify((await api(`/sheets/${sh.id}/split`)).starts) === JSON.stringify({ 3: 'Second' }));
  const acts = await api('/activity');
  check(`${name}: an undoable Activities row`, acts.some((a) => a.type === 'pages' && a.action === 'undo' && /deleted page 2/.test(a.detail)));
  check(`${name}: Undo offers it`, /delete page 2/.test(await p.$eval('#cu-undo', (e) => e.textContent)));
  await undoBtn(p);
  check(`${name}: Undo brings page 2 back`, (await order(sh.id)) === '1,2,3,4,5,6' && (await figCount(p)) === N, await order(sh.id));
  if (h0 !== null) check(`${name}: .history after undo`, deletedInHistory() === h0);
  // ---- move page 1 right with › ----
  await tapOrClick('#bs-grid figure[data-p="1"] .og-mv[data-mv="1"]'); await sleep(1800);
  check(`${name}: › moves page 1 right`, (await order(sh.id)) === '2,1,3,4,5,6', await order(sh.id));
  await undoBtn(p);
  check(`${name}: undo the move`, (await order(sh.id)) === '1,2,3,4,5,6');
  // ---- drag page 5 (song 2) before page 4 (song 2 starts there): it joins song 1 ----
  await p.$eval('#bs-grid figure[data-p="4"]', (e) => e.scrollIntoView({ block: 'start' })); await sleep(300);
  const rect = (sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.x, w: r.width }; });
  const from = await rect('#bs-grid figure[data-p="5"] .bs-pg img');
  const to = await rect('#bs-grid figure[data-p="4"] .bs-pg img');
  const tx = to.l + to.w * 0.2, ty = to.y;
  if (!touch) {
    await p.mouse.move(from.x, from.y); await p.mouse.down();
    for (let k = 1; k <= 12; k++) { await p.mouse.move(from.x + (tx - from.x) * k / 12, from.y + (ty - from.y) * k / 12); await sleep(20); }
    check('mac: dragging shows where it goes', !!(await p.$('#bs-grid figure.drop-before')));
    await p.mouse.up();
  } else {
    const cdp = await p.target().createCDPSession();
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', from.x, from.y); await sleep(550);  // hold
    for (let k = 1; k <= 12; k++) { await tp('touchMove', from.x + (tx - from.x) * k / 12, from.y + (ty - from.y) * k / 12); await sleep(25); }
    check(`${name}: hold + drag shows where it goes`, !!(await p.$('#bs-grid figure.drop-before')));
    await tp('touchEnd'); await cdp.detach();
  }
  await sleep(2000);
  check(`${name}: drag moved page 5 before 4`, (await order(sh.id)) === '1,2,3,5,4,6', await order(sh.id));
  const st = (await api(`/sheets/${sh.id}/split`)).starts;
  check(`${name}: it crossed into song 1 (song 2 now starts on page 5)`, JSON.stringify(st) === JSON.stringify({ 5: 'Second' }), JSON.stringify(st));
  check(`${name}: on screen too`, await p.$eval('#bs-grid figure[data-p="5"]', (e) => e.classList.contains('start')) && !(await p.$eval('#bs-grid figure[data-p="4"]', (e) => e.classList.contains('start'))));
  check(`${name}: not marked as a tap (no new start)`, !(await p.$eval('#bs-grid figure[data-p="4"]', (e) => e.classList.contains('start'))));
  await p.screenshot({ path: path.join(SHOTS, `organize-${name}.png`) });
  if (name === 'mac') {
    // the sheet viewer shows the new order (store resync)
    await p.goto(BASE + `#/item/${sh.id}`, { waitUntil: 'networkidle0' }); await sleep(1200);
    const src = await p.$eval('#page-row img', (e) => e.src).catch(() => '');
    check('sheet viewer uses the stable page URL with the new version', /\/api\/items\/.+\/pages\/1\?v=/.test(src), src);
    const v = (await api('/items/' + sh.id)).updatedAt;
    check('…and the new updatedAt', src.includes(`v=${v}`), `${src} vs ${v}`);
    await p.goBack(); await sleep(1200);
  }
  await undoBtn(p);
  check(`${name}: undo the drag (order and song start back)`, (await order(sh.id)) === '1,2,3,4,5,6' && JSON.stringify((await api(`/sheets/${sh.id}/split`)).starts) === JSON.stringify({ 4: 'Second' }), await order(sh.id));
  // ---- crop page 2: the original with the box, Crop & next carries the box, Undo ----
  await p.$eval('#bs-grid figure[data-p="2"]', (e) => e.scrollIntoView({ block: 'center' })); await sleep(200);
  await tapOrClick('#bs-grid figure[data-p="2"] .og-crop'); await sleep(1200);
  check(`${name}: ✂ opens the crop on the original photo`, /\/pages\/2\/original/.test(await p.$eval('#cr-stage img', (e) => e.src).catch(() => '')));
  const ir = await p.$eval('#cr-stage img', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const A = [ir.x + ir.w * 0.15, ir.y + ir.h * 0.12], B = [ir.x + ir.w * 0.85, ir.y + ir.h * 0.8];
  if (!touch) { await p.mouse.move(...A); await p.mouse.down(); for (let k = 1; k <= 8; k++) await p.mouse.move(A[0] + (B[0] - A[0]) * k / 8, A[1] + (B[1] - A[1]) * k / 8); await p.mouse.up(); }
  else {
    const cdp = await p.target().createCDPSession();
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', ...A); for (let k = 1; k <= 8; k++) await tp('touchMove', A[0] + (B[0] - A[0]) * k / 8, A[1] + (B[1] - A[1]) * k / 8); await tp('touchEnd'); await cdp.detach();
  }
  await sleep(200);
  check(`${name}: drawing a box`, (await p.$eval('#cr-from', (e) => e.textContent)) === 'Your box');
  await tapOrClick('#cr-oknext'); await sleep(2000);
  let crops = (await api(`/items/${sh.id}/crops`)).pages;
  check(`${name}: page 2 cropped on the Mac (box of the original)`, crops[1].crop && Math.abs(crops[1].crop.top - 0.12) < 0.03 && Math.abs(crops[1].crop.right - 0.85) < 0.03, JSON.stringify(crops[1]));
  check(`${name}: Crop & next → page 3 starts with the same box`, /Page 3/.test(await p.$eval('#cr-t', (e) => e.textContent)) && (await p.$eval('#cr-from', (e) => e.textContent)) === 'Same as the last crop');
  await p.screenshot({ path: path.join(SHOTS, `organize-crop-${name}.png`) });
  if (name === 'mac') {
    await p.click('#cr-frames [data-frs="1"]'); await sleep(800);
    check('mac: ⤓ saves Frame 1', !(await p.$eval('#cr-frames [data-fr="1"]', (e) => e.disabled)));
    await p.click('#cr-whole'); await sleep(100);
    await p.click('#cr-frames [data-fr="1"]'); await sleep(100);
    check('mac: Frame 1 puts the box back', (await p.$eval('#cr-from', (e) => e.textContent)) === 'Frame 1');
  }
  await tapOrClick('.og-crop-modal [data-close]'); await sleep(1500);
  check(`${name}: the page tile shows the crop (new thumbnail)`, (await p.$eval('#bs-grid figure[data-p="2"] img', (e) => e.src)).includes(`v=${(await api('/items/' + sh.id)).updatedAt}`));
  check(`${name}: Undo offers the crop`, /crop page 2/.test(await p.$eval('#cu-undo', (e) => e.textContent)));
  await undoBtn(p);
  crops = (await api(`/items/${sh.id}/crops`)).pages;
  check(`${name}: Undo takes the crop off (the original stays in .history)`, !crops[1].crop && crops[1].trims === 0, JSON.stringify(crops[1]));
  if (name === 'iphone') {
    await p.tap('#bs-back'); await sleep(400);
    check('iphone: ‹ All shows Recommended to check and the list', await p.$eval('#og-side', (e) => e.getBoundingClientRect().height > 200));
    await p.screenshot({ path: path.join(SHOTS, 'organize-iphone-list.png') });
  }
  if (name !== 'mac') await p.close();
}

// ---- the sheet view: Edit pages… opens this sheet in Organize pages; Back returns to the sheet ----
console.log('mac: Edit pages from the sheet');
await mac.goto(BASE + `#/item/${sh.id}`, { waitUntil: 'networkidle0' }); await mac.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await mac.waitForSelector('#it-more', { timeout: 8000 }); await mac.$eval('#it-more', (e) => e.click()); await sleep(400);
const menuItems = await mac.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
check('item menu has Edit pages…, no Split… / Join…', menuItems.includes('Edit pages…') && !menuItems.some((x) => /^(Split|Join)…$/.test(x)), menuItems.join('|'));
await mac.evaluate(() => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.trim() === 'Edit pages…').click()); await sleep(1500);
check('Edit pages opens this sheet in Organize pages', (await mac.evaluate(() => location.hash)).startsWith(`#/manage?id=${sh.id}`) && (await mac.$eval('#bs-grid', (e) => e.dataset.id)) === sh.id);
check('Back says the sheet', (await mac.$eval('.cu-back', (e) => e.textContent)).includes(T));
await mac.$eval('.cu-back', (e) => e.click()); await sleep(1000);
check('Back returns to the sheet', (await mac.evaluate(() => location.hash)) === `#/item/${sh.id}`);

// ---- Mac: Refresh → Recommended to check → merge, complete song, Show hidden ----
console.log('mac: Recommended to check');
const p = mac;
await open(p, sh.id);
for (let i = 0; i < 600 && (await api('/organize')).job; i++) await sleep(1000);  // a scan still running from before
const at0 = (await api('/organize')).scan?.at || 0;
await p.click('#og-refresh'); await sleep(500);
check('Refresh shows progress', !!(await p.$('#og-prog')));
for (let i = 0; i < 600 && ((await api('/organize')).scan?.at || 0) === at0; i++) await sleep(1000);
await p.waitForFunction(() => !document.querySelector('#og-prog'), { timeout: 30000 }).catch(() => {});
await sleep(1200);
const cands = await p.$$eval('#og-cands li', (e) => e.map((x) => [x.dataset.id, x.textContent.replace(/\s+/g, ' ')]));
const mc = cands.find(([id]) => id === sh.id);
check('Refresh lists the two parts as one song in parts', mc && /One song in parts/.test(mc[1]) && /look like one song in parts/.test(mc[1]), JSON.stringify(cands.slice(0, 5)));
const jobs = await api('/jobs');
check('the scan ran as a job', jobs.some((j) => j.kind === 'organize' && j.status === 'done'));
await p.screenshot({ path: path.join(SHOTS, 'organize-mac-recommended.png') });
await p.click(`#og-cands li[data-id="${sh.id}"]`); await sleep(1200);
check('the reason shows above the pages', /look like one song in parts/.test(await p.$eval('#og-why', (e) => e.textContent)));
await p.click('#og-why [data-mergewith]'); await sleep(400);
await p.click('.modal [data-ok]'); await sleep(2500);
check('Merge adds the part 2 pages', (await order(sh.id)) === '1,2,3,4,5,6,7,8', await order(sh.id));
check('part 2 went to the Trash (empty)', (await api('/items/' + sh2.id)).deleted);
await undoBtn(p); await sleep(500);
check('Undo the merge', (await order(sh.id)) === '1,2,3,4,5,6' && !(await api('/items/' + sh2.id)).deleted);
// This is a complete song
await p.click('#og-ok'); await sleep(1200);
let g = await api('/organize');
check('This is a complete song: saved', g.items.find((x) => x.id === sh.id)?.reviewed);
check('…and gone from Recommended to check', !(await p.$(`#og-cands li[data-id="${sh.id}"]`)));
await p.click('#og-hidden'); await sleep(300);
check('Show hidden lists it', !!(await p.$(`.og-hidden-list li[data-id="${sh.id}"] [data-again]`)));
await p.screenshot({ path: path.join(SHOTS, 'organize-mac-hidden.png') });
check('an undoable Activities row', (await api('/activity')).some((a) => a.type === 'reviewed' && a.action === 'undo'));
await undoBtn(p);
g = await api('/organize');
check('Undo: it can come up again', !g.items.find((x) => x.id === sh.id)?.reviewed);

// ---- Trash tab ----
console.log('Trash tab');
await post('/items/trash', { ids: [sh2.id] });
await p.goto(BASE + '#/trash', { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
check('#/trash opens Manage library → Trash', (await p.evaluate(() => location.hash)) === '#/manage/trash' && (await p.$eval('.cu-tabs a.on', (e) => e.dataset.tab)) === 'trash');
check('no Trash entry in the left bar', !/Trash/.test(await p.$eval('#side', (e) => e.textContent)));
const row = `#bn .row[data-id="${sh2.id}"]`;
check('the trashed sheet is listed', !!(await p.$(row)));
await p.screenshot({ path: path.join(SHOTS, 'trash-mac.png') });
await p.click(`${row} [data-act="restore"]`); await sleep(900);
check('Restore works', !(await p.$(row)) && !(await api('/items/' + sh2.id)).deleted);
await post('/items/trash', { ids: [sh2.id] });
await p.reload({ waitUntil: 'networkidle0' }); await sleep(900);
await p.click(`${row} [data-act="purge"]`); await sleep(300);
check('Delete asks first', /for good/.test(await p.$eval('.modal h2', (e) => e.textContent)));
await p.click('.modal [data-close]'); await sleep(300);
check('Cancel keeps it', !!(await p.$(row)));
await p.click('#bn-empty'); await sleep(300);
check('Empty Trash asks first', /for good/.test(await p.$eval('.modal h2', (e) => e.textContent)));
await p.click('.modal [data-close]'); await sleep(200);
for (const [name, vp] of [['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  const q = await newPage(vp);
  await q.goto(BASE + '#/bin', { waitUntil: 'networkidle0' }); await sleep(900);
  check(`${name}: #/bin → Trash tab`, (await q.evaluate(() => location.hash)) === '#/manage/trash' && !!(await q.$(row)));
  const fit = await q.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
  check(`${name}: Trash fits the width`, fit.sw <= fit.iw + 1, JSON.stringify(fit));
  await q.screenshot({ path: path.join(SHOTS, `trash-${name}.png`) });
  await q.close();
}

await purgeOld();
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
