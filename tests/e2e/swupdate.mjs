// An open app must never stay on an old shell while the Mac serves a newer one (js/update.js + sw.js).
// The server serves a COPY of web/ (MEOWSIC_WEB) whose shell this test bumps while the page stays open:
//  - the page notices (app comes back into view), updates the service worker, reloads itself once: new shell,
//    old caches gone, no reload loop;
//  - a reload that can't reach the new version (health says a shell that never arrives) happens once, then a pill;
//  - Edit notes open: no reload, a "New version — Reload" pill; closing it lets the reload go;
//  - App and Help show the running sha + shell; the Mac away: the app still opens from the saved shell.
// BASE = the server's URL; SERVER = the shell command that starts it (this test starts / stops it).
//   BASE=http://127.0.0.1:5331/ SERVER='cd server && exec .venv/bin/python -m meowsic --host 127.0.0.1 --port 5331 --data /tmp/x' node swupdate.mjs
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
const BASE = process.env.BASE || 'http://127.0.0.1:5331/';
const SERVER = process.env.SERVER;
if (!SERVER) { console.error('SERVER (the command that starts the server) is needed: this test starts and stops it'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };

// the web copy: shell v9001 and a marker the page shows
const WEB = fs.mkdtempSync(path.join(os.tmpdir(), 'meowsic-swupdate-web-'));
fs.cpSync(new URL('../../web/', import.meta.url).pathname, WEB, { recursive: true });
const setShell = (n, mark) => {
  const sw = path.join(WEB, 'sw.js'), ix = path.join(WEB, 'index.html');
  fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const SHELL = '[^']+'/, `const SHELL = 'meowsic-shell-v${n}'`));
  let h = fs.readFileSync(ix, 'utf8').replace(/<meta name="test-mark"[^>]*>\n/, '');
  fs.writeFileSync(ix, h.replace('<meta charset="utf-8">\n', `<meta charset="utf-8">\n<meta name="test-mark" content="${mark}">\n`));
};
setShell(9001, 'old');

let srv;
const up = async () => { try { return (await fetch(BASE + 'api/health')).ok; } catch { return false; } };
const start = async () => { srv = spawn(`export MEOWSIC_WEB='${WEB}'; ${SERVER}`, { shell: true, detached: true, stdio: 'ignore' }); for (let i = 0; i < 100 && !(await up()); i++) await sleep(200); if (!(await up())) throw new Error('server did not start'); };
const stop = async () => { try { process.kill(-srv.pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50 && (await up()); i++) await sleep(200); };
const health = async () => (await fetch(BASE + 'api/health')).json();

if (await up()) { console.error('Something already answers at ' + BASE + ' — stop it first (this test owns the server)'); process.exit(2); }
await start();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
try {
  const page = await b.newPage(); await page.setViewport({ width: 1180, height: 820 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  let navs = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  // a fake Mac answer for /api/health when localStorage 'fake-shell' is set (the loop / unsaved checks)
  await page.evaluateOnNewDocument(() => {
    const f = window.fetch;
    window.fetch = async (u, o) => {
      const fake = (() => { try { return localStorage.getItem('fake-shell'); } catch { return null; } })();
      if (fake && String(u).includes('/api/health')) { const h = await (await f(u, o)).json(); return new Response(JSON.stringify({ ...h, shell: fake }), { headers: { 'Content-Type': 'application/json' } }); }
      return f(u, o);
    };
  });
  // evaluate that survives a reload happening meanwhile
  const ev = async (fn, ...a) => { for (let i = 0; i < 40; i++) { try { return await page.evaluate(fn, ...a); } catch { await sleep(250); } } return undefined; };
  const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(fn)) return true; await sleep(250); } return false; };
  const state = () => ev(async () => ({ build: window.__meowsicBuild, mark: document.querySelector('meta[name="test-mark"]')?.content, ctl: !!navigator.serviceWorker.controller,
    caches: (await caches.keys()).sort(), pill: !!document.getElementById('update-pill') }));
  const shown = () => ev(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))); // the app comes back into view

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await until(() => !!navigator.serviceWorker.controller, 10000);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  const h0 = await health();
  let s = await state();
  check('the page runs under the service worker', s.ctl, JSON.stringify(s));
  check('the page knows the shell + sha it was built with', s.build?.shell === 'meowsic-shell-v9001' && s.build?.sha === h0.sha && !!h0.sha, JSON.stringify([s.build, h0]));
  check('the old shell is cached', s.caches.includes('meowsic-shell-v9001'), s.caches.join(' '));
  // a leftover from long ago: must go when a new worker activates
  await ev(async () => { const c = await caches.open('meowsic-shell-v1'); await c.put('/js/app.js', new Response('// old')); });
  navs = 0; await sleep(3000);
  check('no reload while the shell is current', navs === 0, `navigations: ${navs}`);

  // ---- the Mac gets new code (shell bump) while the page stays open ----
  setShell(9002, 'new');
  await sleep(5500); // version.py reads sw.js again after 5 s
  check('the Mac now says v9002', (await health()).shell === 'meowsic-shell-v9002');
  navs = 0;
  await shown();
  const got = await until(() => window.__meowsicBuild?.shell === 'meowsic-shell-v9002', 20000);
  await sleep(1000);
  s = await state();
  check('back in view: the page updates itself to the new shell, no manual reload', got && s.mark === 'new', JSON.stringify(s));
  check('the new service worker runs the page', s.ctl && s.caches.includes('meowsic-shell-v9002'), JSON.stringify(s));
  check('older shell caches are deleted (v9001 and a leftover v1)', !s.caches.includes('meowsic-shell-v9001') && !s.caches.includes('meowsic-shell-v1'), s.caches.join(' '));
  check('every cache left is the current shell or the data cache', s.caches.every((k) => k === 'meowsic-shell-v9002' || k === 'meowsic-data-v1'), s.caches.join(' '));
  await sleep(5000); await shown(); await sleep(3000);
  check('exactly one reload (no loop)', navs === 1, `navigations: ${navs}`);
  check('no pill once up to date', !s.pill);

  // ---- a version that never arrives: one reload, then the pill, never a loop ----
  await ev(() => localStorage.setItem('fake-shell', 'meowsic-shell-v9999'));
  navs = 0;
  await shown();
  await sleep(9000); await shown(); await sleep(4000);
  s = await state();
  check('a reload that did not help is not repeated', navs === 1, `navigations: ${navs}`);
  check('…and the "New version — Reload" pill shows instead', s.pill, JSON.stringify(s));

  // ---- Edit notes open (unsaved notes): never reload, pill; closing it lets the reload go ----
  await ev(() => localStorage.setItem('fake-shell', 'meowsic-shell-v9998'));
  await page.reload({ waitUntil: 'networkidle0' }); // (this reload is the test's; the check below starts after it)
  await until(() => !!window.__meowsicBuild, 5000);
  await sleep(2500); // the start-up check already reloads once for v9998 …
  navs = 0;
  await ev(() => { sessionStorage.removeItem('meowsic-reloaded-for'); document.getElementById('update-pill')?.remove(); });
  await ev(() => { const p = document.createElement('div'); p.className = 'notes-panel'; p.id = 'fake-notes'; document.body.append(p); });
  await shown(); await sleep(4000);
  s = await state();
  check('Edit notes open: no reload', navs === 0, `navigations: ${navs}`);
  check('Edit notes open: the pill shows', s.pill, JSON.stringify(s));
  check('the pill reads "New version — Reload"', (await ev(() => document.getElementById('update-pill')?.textContent)) === 'New version — Reload');
  await ev(() => document.getElementById('fake-notes').remove());
  await sleep(4000);
  check('Edit notes closed: the waiting reload goes', navs === 1, `navigations: ${navs}`);
  await ev(() => localStorage.removeItem('fake-shell'));
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(1500);

  // ---- the running version is shown ----
  const h1 = await health();
  await page.evaluate(() => { location.hash = '#/settings'; }); await sleep(800);
  const vline = await ev(() => document.getElementById('st-version')?.textContent || '');
  check('App shows the running sha + shell', vline.includes(h1.sha.slice(0, 7)) && vline.includes('shell v9002'), vline);
  await page.evaluate(() => { location.hash = '#/help'; }); await sleep(800);
  const hline = await ev(() => document.getElementById('help-version')?.textContent || '');
  check('Help shows the running sha + shell', hline.includes(h1.sha.slice(0, 7)) && hline.includes('shell v9002'), hline);

  // ---- the Mac away: the saved shell still opens, no reload ----
  await stop();
  navs = 0;
  const t0 = Date.now();
  await page.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await sleep(2000);
  s = await state();
  const side = await ev(() => document.querySelector('#side')?.textContent || '');
  check('offline: the app opens from the saved shell', s.mark === 'new' && s.build?.shell === 'meowsic-shell-v9002' && /Meowsic/.test(side), JSON.stringify(s));
  check('offline: it opened quickly', Date.now() - t0 < 9000, `${Date.now() - t0} ms`);
  await shown(); await sleep(3000);
  check('offline: no reload', navs === 1, `navigations: ${navs}`);
  console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
} finally { await b.close(); await stop(); fs.rmSync(WEB, { recursive: true, force: true }); }
process.exit(fail ? 1 : 0);
