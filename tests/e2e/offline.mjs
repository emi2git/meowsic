// The Mac goes away while a sheet is open (iPhone behind a VPN): never silent.
// Pages load by number (/pages/n); a banner says the Mac can't be reached; an unopened page shows a
// placeholder, an opened one still shows from the saved copy; when the Mac is back the banner goes
// (within ~10 s) and the pages load.
// BASE = the server's URL; SERVER = the shell command that starts it (this test stops and restarts it).
//   BASE=http://localhost:5225/ SERVER='cd server && MEOWSIC_DATA=… .venv/bin/python -m meowsic --port 5225' node offline.mjs
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { spawn } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:5225/';
const SERVER = process.env.SERVER;
if (!SERVER) { console.error('SERVER (the command that starts the server) is needed: this test stops and starts it'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
const up = async () => { try { return (await fetch(BASE + 'api/health')).ok; } catch { return false; } };
const start = async () => { srv = spawn(SERVER, { shell: true, detached: true, stdio: 'ignore' }); for (let i = 0; i < 100 && !(await up()); i++) await sleep(200); if (!(await up())) throw new Error('server did not start'); };
const stop = async () => { try { process.kill(-srv.pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50 && (await up()); i++) await sleep(200); };
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };

if (await up()) { console.error('Something already answers at ' + BASE + ' — stop it first (this test owns the server)'); process.exit(2); }
await start();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
try {
  const page = await b.newPage(); await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true }); // iPhone
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const imgUrls = new Set(); page.on('request', (r) => { if (r.resourceType() === 'image') imgUrls.add(new URL(r.url()).pathname); });
  const png = fs.readFileSync(new URL('../../web/icon-512.png', import.meta.url));
  const fd = new FormData(); fd.append('title', 'Offline test ' + Date.now());
  for (let k = 0; k < 6; k++) fd.append('files', new Blob([png, Buffer.from(String(Date.now() + k))], { type: 'image/png' }), `p${k}.png`);
  const it = (await (await fetch(BASE + 'api/sheets', { method: 'POST', body: fd })).json()).item;
  const shown = () => page.evaluate(() => { const i = document.querySelector('.page img'); const w = i?.closest('.page'); return { p: w?.dataset.p, ok: !!(i?.complete && i.naturalWidth > 0), fail: w?.dataset.fail || '', src: i?.getAttribute('src') || '' }; });
  const banner = () => page.evaluate(() => { const e = document.getElementById('conn-banner'); return !!e && !e.hidden && e.getBoundingClientRect().height > 0 ? e.textContent : ''; });
  const turn = async (n, key = 'ArrowRight') => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(250); } await sleep(1200); };

  // first visit installs the service worker; the second one runs under it
  await page.goto(BASE + '#/item/' + it.id, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), { timeout: 10000 }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
  check('the service worker runs the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
  let s = await shown();
  check('page 1 loads by number (/pages/1?v=…)', s.ok && /\/api\/items\/[^/]+\/pages\/1\?v=\d+/.test(s.src), JSON.stringify(s));
  check('page pictures use /pages/{n}, never file names', [...imgUrls].some((u) => u.includes('/pages/')) && ![...imgUrls].some((u) => u.includes('/file/')), [...imgUrls].join(' '));
  check('no banner while the Mac answers', !(await banner()));
  // one request failing while /api/health answers doesn't mean offline
  const stays = await page.evaluate(async () => {
    const { store } = await import('/js/store.js'); const f = window.fetch;
    window.fetch = (u, o) => (String(u).includes('/api/items/zz-fail') ? Promise.reject(new TypeError('Failed to fetch')) : f(u, o));
    await store.api('GET', '/items/zz-fail', undefined, { queue: false }); window.fetch = f; return store.mode;
  });
  check('a single failed request with health answering stays connected', stays === 'server', stays);
  const missing = await page.evaluate(async (id) => {
    const d = document.createElement('div'); d.className = 'page'; d.id = 'zz-missing'; d.innerHTML = `<img src="/api/items/${id}/pages/99?v=1" alt="">`; document.body.append(d);
    await new Promise((r) => setTimeout(r, 1500)); const t = d.dataset.fail; d.remove(); return t;
  }, it.id);
  check('a page the Mac doesn\'t have says "This page is missing"', missing === 'This page is missing', missing);

  // ---- the Mac goes away ----
  await stop();
  await turn(4); // page 5: never opened (only 1–3 were loaded)
  s = await shown();
  check('an unopened page shows a placeholder, not a blank box', s.p === '5' && !s.ok && /Can’t load this page — the Mac isn’t reachable/.test(s.fail), JSON.stringify(s));
  const ph = await page.evaluate(() => { const w = document.querySelector('.page.img-failed'); return w ? getComputedStyle(w, '::after').content : ''; });
  check('the placeholder text is drawn', /Can’t load this page/.test(ph), ph);
  let bt = await banner();
  check('the banner says the Mac can\'t be reached', /Can’t reach the Mac — showing the saved copy\. Pages you haven’t opened won’t show\./.test(bt) && /Retry/.test(bt), bt);
  const pos = await page.evaluate(() => { const t = [...document.querySelectorAll('#main .top')].find((h) => h.offsetParent); const e = document.getElementById('conn-banner'); return { top: t ? Math.round(t.getBoundingClientRect().bottom) : -1, b: Math.round(e.getBoundingClientRect().top) }; });
  check('the banner sits under the top bar', pos.top >= 0 && Math.abs(pos.top - pos.b) <= 1, JSON.stringify(pos));
  await turn(4, 'ArrowLeft'); // back to page 1: opened before → from the saved copy
  s = await shown();
  check('an opened page still shows from the saved copy', s.p === '1' && s.ok && !s.fail, JSON.stringify(s));
  // the whole app reopened while the Mac is away (Home Screen app relaunched)
  await page.reload({ waitUntil: 'load' }); await sleep(2500);
  check('reopened offline: the banner shows at once', !!(await banner()));
  s = await shown();
  check('reopened offline: page 1 shows from the saved copy', s.ok, JSON.stringify(s));
  await page.click('#conn-banner button'); await sleep(4500);
  check('Retry while the Mac is still away keeps the banner', !!(await banner()));
  await turn(4);
  s = await shown();
  check('reopened offline: an unopened page shows the placeholder', s.p === '5' && /the Mac isn’t reachable/.test(s.fail), JSON.stringify(s));

  // ---- the Mac is back: no tap needed ----
  await start();
  const t0 = Date.now();
  await page.waitForFunction(() => { const e = document.getElementById('conn-banner'); return e && e.hidden; }, { timeout: 13000, polling: 250 }).catch(() => {});
  const took = Date.now() - t0;
  check('the banner goes by itself within ~10 s', !(await banner()) && took <= 12500, `${took} ms`);
  await sleep(2500);
  s = await shown();
  check('the page that failed loads now', s.p === '5' && s.ok && !s.fail, JSON.stringify(s));
  check('back in server mode', (await page.evaluate(async () => (await import('/js/store.js')).store.mode)) === 'server');
  await fetch(BASE + 'api/items/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [it.id] }) });
  console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
} finally { await b.close(); await stop(); }
process.exit(fail ? 1 : 0);
