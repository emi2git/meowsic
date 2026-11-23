// Saved copies on this device: opened pages are saved; after a sync, old versions (?v=) and pages of
// deleted sheets are gone; a size cap evicts the least recently used; Settings shows sizes; Clear works;
// a recently opened page still shows offline.
//   BASE=http://localhost:5228/ SERVER='cd server && MEOWSIC_DATA=… .venv/bin/python -m meowsic --port 5228' node storage.mjs
// SERVER = the shell command that starts the server: this test starts it and stops it for the offline check
// (without SERVER, BASE must already answer and the offline check is skipped).
// PREVIEW=http://localhost:5227/ also checks Settings in the UI preview (no Mac).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { spawn } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:5228/';
const PREVIEW = process.env.PREVIEW, SERVER = process.env.SERVER;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
const up = async () => { try { return (await fetch(BASE + 'api/health')).ok; } catch { return false; } };
const start = async () => { srv = spawn(SERVER, { shell: true, detached: true, stdio: 'ignore' }); for (let i = 0; i < 100 && !(await up()); i++) await sleep(200); if (!(await up())) throw new Error('server did not start'); };
const stop = async () => { try { process.kill(-srv.pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50 && (await up()); i++) await sleep(200); };
if (SERVER) { if (await up()) { console.error('Something already answers at ' + BASE + ' — stop it first (this test owns the server)'); process.exit(2); } await start(); }
else if (!(await up())) { console.error('Nothing answers at ' + BASE); process.exit(2); }
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const png = fs.readFileSync(new URL('../../web/icon-512.png', import.meta.url));
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function sheet(title, n) {
  const fd = new FormData(); fd.append('title', title + ' ' + Date.now());
  for (let k = 0; k < n; k++) fd.append('files', new Blob([png, Buffer.from(String(Math.random()))], { type: 'image/png' }), `p${k}.png`);
  return (await (await fetch(BASE + 'api/sheets', { method: 'POST', body: fd })).json()).item;
}
const A = await sheet('Storage A', 3), B = await sheet('Storage B', 2), C = await sheet('Storage C', 2);

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const errs = [];
try {
  const page = await b.newPage(); await page.setViewport({ width: 1032, height: 1376, hasTouch: true, isMobile: true }); // iPad
  page.on('pageerror', (e) => errs.push(e.message));
  const saved = () => page.evaluate(async () => (await import('/js/saved.js')).stats(true));
  const entries = async (id) => ((await saved())?.urls || []).filter((x) => x.url.includes(`/api/items/${encodeURIComponent(id)}/`));
  const open = async (id) => { await page.evaluate((h) => { location.hash = h; }, '#/item/' + id); await sleep(1800); };
  const wake = () => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new Event('visibilitychange')); });
  const shownOk = () => page.evaluate(() => { const i = document.querySelector('.page img'); return !!(i?.complete && i.naturalWidth > 0); });

  await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), { timeout: 10000 }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  check('the service worker runs the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
  await page.evaluate(async () => (await import('/js/saved.js')).clear()); // start from nothing

  // ---- opened pages are saved ----
  await open(A.id);
  let a = await entries(A.id);
  const a1 = a.filter((x) => /\/pages\/1\?/.test(x.url));
  check('opening a sheet saves its page (/pages/1?v=…)', a1.length === 1, JSON.stringify(a));
  const oldV = a1[0] && new URL(a1[0].url).searchParams.get('v');

  // ---- rename: a new ?v=, the old version goes ----
  await page.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.update(id, { title: 'Storage A renamed ' + Date.now() }); }, A.id);
  await sleep(1500); await wake(); await sleep(2500);
  a = (await entries(A.id)).filter((x) => /\/pages\/1\?/.test(x.url));
  const curV = await page.evaluate(async (id) => String((await import('/js/store.js')).store.get(id).updatedAt), A.id);
  check('after a rename + sync: one saved copy of page 1', a.length === 1, JSON.stringify(a));
  check('…the new version, the old ?v= is gone', a.length && new URL(a[0].url).searchParams.get('v') !== oldV && !a.some((x) => x.url.includes('v=' + oldV + '')), `${oldV} → ${curV}: ${JSON.stringify(a)}`);
  check('the renamed sheet still shows', await shownOk());

  // ---- crop-like change (the item changes on the Mac): newer ?v= replaces the older one ----
  await page.evaluate(async (id) => { await fetch(`/api/items/${id}/pages/1?v=1`); await fetch(`/api/items/${id}/pages/1?v=2`); await fetch(`/api/items/${id}/pages/1?v=3&r=99`); }, A.id);
  await sleep(800);
  a = (await entries(A.id)).filter((x) => /\/pages\/1\?/.test(x.url));
  check('older versions of one page are replaced by the newest (retry markers ignored)', a.length === 1 && /v=3$/.test(a[0].url), JSON.stringify(a));

  // ---- a sheet deleted on the Mac: its pages go after the sync ----
  await open(B.id);
  check('sheet B pages saved', (await entries(B.id)).length >= 1);
  await open(C.id);
  await post('/items/trash', { ids: [B.id] }); await post('/items/purge', { ids: [B.id] });
  await wake(); await sleep(2500);
  check('the sync dropped sheet B from the list', !(await page.evaluate(async (id) => !!(await import('/js/store.js')).store.get(id), B.id)));
  check('after the sync, the deleted sheet\'s saved pages are gone', (await entries(B.id)).length === 0, JSON.stringify(await entries(B.id)));
  check('…other sheets keep theirs', (await entries(A.id)).length >= 1 && (await entries(C.id)).length >= 1);

  // ---- size cap: least recently used go first ----
  await open(A.id); await sleep(300); await open(C.id); // C used last
  const st = await saved();
  const cAt = Math.min(...st.urls.filter((x) => x.url.includes(C.id) && /\/pages\//.test(x.url)).map((x) => x.at));
  const keep = st.urls.filter((x) => x.at >= cAt), cap = keep.reduce((n, x) => n + x.size, 0) + 10;
  const r = await page.evaluate(async (cap) => (await import('/js/saved.js')).setCap(cap), cap);
  const after = await saved();
  check('a tiny cap evicts older copies', r?.evicted > 0 && after.size <= cap, JSON.stringify({ r, size: after.size, cap }));
  check('…the most recently used stay (sheet C)', (await entries(C.id)).some((x) => /\/pages\/1\?/.test(x.url)));
  check('…the least recently used went (sheet A)', !(await entries(A.id)).some((x) => /\/pages\/1\?/.test(x.url)), JSON.stringify(await entries(A.id)));
  await page.evaluate(async () => (await import('/js/saved.js')).setCap(1024 * 1024 * 1024));

  // ---- Settings shows the sizes and the cap ----
  await page.evaluate(() => { location.hash = '#/settings'; }); await sleep(1500);
  const ui = await page.evaluate(() => ({ t: document.querySelector('#st-storage')?.innerText || '', on: document.querySelector('#st-cap button.on')?.textContent, pages: document.querySelector('#st-pages')?.textContent, usage: document.querySelector('#st-usage')?.textContent }));
  check('Settings: "Storage on this device" with saved pages + MB', /Storage on this device/.test(ui.t) && /\d+ pages? · [\d.]+ (MB|GB)/.test(ui.pages), JSON.stringify(ui));
  check('Settings: browser total usage / quota', /used of/.test(ui.usage || ''), ui.usage);
  check('Settings: the 1 GB cap is chosen', ui.on === '1 GB', ui.on);
  await page.evaluate(() => [...document.querySelectorAll('#st-cap button')].find((x) => x.textContent === '500 MB').click()); await sleep(800);
  check('choosing 500 MB sets the cap', (await saved()).cap === 500 * 1024 * 1024 && (await page.evaluate(() => document.querySelector('#st-cap button.on')?.textContent)) === '500 MB');
  await page.evaluate(() => [...document.querySelectorAll('#st-cap button')].find((x) => x.textContent === '1 GB').click()); await sleep(500);

  // ---- offline: a recently opened page still shows ----
  if (SERVER) {
    await stop();
    await page.goto(BASE + '#/item/' + C.id); await page.reload({ waitUntil: 'networkidle0' }).catch(() => {}); await sleep(2500); // a real restart, not a hash change
    const offMode = await page.evaluate(async () => (await import('/js/store.js')).store.mode);
    check('offline: the app knows', offMode === 'offline', offMode);
    check('offline: the recently opened sheet still shows its page', await shownOk());
    await start();
    await page.goto(BASE + '#/settings'); await page.reload({ waitUntil: 'networkidle0' }); await sleep(1500);
  } else { console.log('  (offline check skipped: no SERVER)'); await page.evaluate(() => { location.hash = '#/settings'; }); await sleep(1500); }

  // ---- Clear saved pages ----
  await page.click('#st-clear'); await sleep(400);
  await page.evaluate(() => document.querySelector('[data-ok]').click()); await sleep(1500);
  const cl = await saved();
  check('Clear: no saved pages left', !cl.urls.some((x) => /\/(pages|thumb|file)\//.test(x.url)), JSON.stringify(cl.urls));
  check('Clear: Settings says 0 pages', /^0 pages/.test(await page.$eval('#st-pages', (e) => e.textContent)));
  const kept = await page.evaluate(async () => ({ shell: await caches.has('meowsic-shell-v3'), items: (await import('/js/store.js')).store.items().length, list: !!localStorage.getItem('meowsic-cache-v1') }));
  check('Clear keeps the app shell and the library list', kept.shell && kept.items > 0 && kept.list, JSON.stringify(kept));

  // ---- the UI preview (no Mac): Settings shows the card too ----
  if (PREVIEW) {
    const p2 = await b.newPage(); p2.on('pageerror', (e) => errs.push('preview: ' + e.message));
    await p2.goto(PREVIEW + '?preview#/settings', { waitUntil: 'networkidle0' }); await sleep(1500);
    const t = await p2.evaluate(() => ({ h: !!document.querySelector('#st-storage'), saved: document.querySelector('#st-saved')?.textContent }));
    check('preview: Settings shows "Storage on this device"', t.h && t.saved && t.saved !== '…', JSON.stringify(t));
  }
} finally {
  await post('/items/trash', { ids: [A.id, C.id] }); await post('/items/purge', { ids: [A.id, C.id] });
  console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
  await b.close();
  if (SERVER) await stop();
}
