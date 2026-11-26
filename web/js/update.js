// The page keeps itself up to date: an app window left open for days (Meowsic.app on the Mac, a Home Screen app)
// or a page served from an old saved shell must never stay on old code while the Mac serves new code.
// On start and each time the app comes back into view: ask the Mac what it runs (/api/health, never cached).
// When its shell or commit differs from the one this page was built with (<meta name="meowsic-build">, filled
// in by the Mac), the service worker is updated, and once the new one runs the page reloads once.
// Never while something on screen may hold unsaved work: Edit notes (.notes-panel) or any editor marked with
// data-unsaved="1" (ui.js unsaved(): Simple piano, Check bars, the ink bar, Crop, Add sheet music's arrangement,
// Complete info picks, Feedback text; a sheet / popup once a field in it is typed into or its tags are changed).
// A small "New version — Reload" pill shows instead, and the reload waits until they are closed or saved. A reload that did not help (same target again) never repeats: pill only.
import { confirmSheet } from './ui.js';

const RELOAD_KEY = 'meowsic-reloaded-for';
const meta = document.querySelector('meta[name="meowsic-build"]')?.content.trim().split(/\s+/) || [];
export const build = { shell: meta[0] || '', sha: meta[1] || '' };
window.__meowsicBuild = build; // tests + the App page
export const server = { shell: '', sha: '' }; // what the Mac said last

const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
// unsaved work on screen: Edit notes, or any editor that marks itself with data-unsaved (ui.js unsaved())
export const editing = () => !!document.querySelector('.notes-panel, [data-unsaved="1"]');
// typing into a field of a sheet (modal) marks the sheet: closing it (Save / Cancel) removes the mark with it.
// Search boxes and buttons-only sheets don't count.
const markField = (e) => {
  const t = e.target;
  if (!t?.matches?.('input, textarea, select') || t.type === 'search') return;
  const box = t.closest('.modal-wrap');
  if (box) box.dataset.unsaved = '1';
};
addEventListener('input', markField, true);
addEventListener('change', markField, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
  try { const r = await fetch('/api/health', { cache: 'no-store', signal: ac.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}

// the service worker: look for a new sw.js; a new one installs, skips waiting and claims this page (sw.js)
async function updateWorker() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const reg = await sw.getRegistration().catch(() => null);
  if (!reg) return;
  try { await reg.update(); } catch {}
  const w = reg.installing || reg.waiting;
  if (!w) return;
  if (w.state === 'installed') w.postMessage({ op: 'skipWaiting' });
  await Promise.race([sleep(10000), new Promise((res) => {
    const done = () => { if (w.state === 'activated' || w.state === 'redundant') res(); else if (w.state === 'installed') w.postMessage({ op: 'skipWaiting' }); };
    w.addEventListener('statechange', done); done();
  })]);
}

let pill = null, waitTimer = null;
function showPill() {
  if (pill?.isConnected) return;
  pill = document.createElement('button');
  pill.id = 'update-pill';
  pill.className = 'update-pill';
  pill.type = 'button';
  pill.textContent = 'New version — Reload';
  pill.onclick = async () => {
    if (editing() && !(await confirmSheet({ title: 'Reload now?', body: 'Something you are editing is still open: changes you haven’t saved are lost.', ok: 'Reload', danger: true }))) return;
    location.reload();
  };
  document.body.append(pill);
}

let running = null;
export function check() { return (running ||= run().finally(() => { running = null; })); }
async function run() {
  if (!build.shell) return; // preview / served without the Mac's stamp: nothing to compare
  const h = await health();
  if (!h?.ok || !h.shell) return; // the Mac is away: the saved copy is all there is
  Object.assign(server, { shell: h.shell, sha: h.sha || '' });
  const stale = h.shell !== build.shell || (!!h.sha && !!build.sha && h.sha !== build.sha);
  if (!stale) return;
  await updateWorker();
  const target = `${h.shell} ${h.sha || ''}`;
  if (ss.get(RELOAD_KEY) === target) return showPill(); // reloaded for this already and still old: no loop
  if (editing()) {
    showPill();
    clearInterval(waitTimer);
    waitTimer = setInterval(() => { if (!editing() && document.visibilityState === 'visible') { clearInterval(waitTimer); reload(target); } }, 1000);
    return;
  }
  reload(target);
}
function reload(target) {
  ss.set(RELOAD_KEY, target);
  window.__meowsicReloading = true;
  location.reload();
}

addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
addEventListener('pageshow', (e) => { if (e.persisted) check(); });
check();

// the version this page runs (short sha + shell), and the Mac's when it differs: anyone can check an update arrived
// (App page foot and Help). preview = the UI preview (no Mac stamp).
const shellN = (s) => (/v(\d+)$/.test(s) ? 'shell v' + s.match(/v(\d+)$/)[1] : s);
const safe = (s) => String(s).replace(/[^\w .·-]/g, '');
export function versionLine(preview = false) {
  if (!build.shell) return preview ? 'Meowsic 2.0 · UI preview' : 'Meowsic 2.0';
  const mine = `${safe(build.sha.slice(0, 7))} · ${safe(shellN(build.shell))}`;
  const mac = server.shell && (server.shell !== build.shell || server.sha !== build.sha) ? ` · the Mac has ${safe(server.sha.slice(0, 7))} · ${safe(shellN(server.shell))}` : '';
  return `Meowsic 2.0 · running ${mine}${mac}`;
}
