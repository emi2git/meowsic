// Edit notes never loses edits (views/editnotes.js; server: server/meowsic/editsafe.py).
// - A draft of the open editor ({item, title, sha (the score as the editor opened it), ops, n, savedAt, session})
//   is kept in this browser after every edit: localStorage (meowsic-editdraft-<item id>), IndexedDB when it is too
//   big for it. It goes only after a successful save, or when the user closes without saving on purpose.
// - The same draft goes to the Mac every ~30 s of edits and when the page is hidden (on disk there: a browser
//   crash or a server restart loses at most a few seconds).
// - The edit session: started when the editor opens, a heartbeat every 25 s, ended when it closes (a beacon on
//   pagehide). While it lives, other API writes to the score get 423 (agents must wait).
// - saveNote(): the Save answer that stays on screen — "Saved ✓ 14:05" (20 s, or until ✕; a merge that kept
//   "(my edits)" stays), or an error until dismissed.
import { esc } from './ui.js';

const KEY = (id) => `meowsic-editdraft-${id}`;
const IDB = 'meowsic-editdrafts';
let dbp = null;
const idb = () => (dbp ||= new Promise((res, rej) => {
  const r = indexedDB.open(IDB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('d');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
const idbDo = async (mode, f) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('d', mode); const q = f(t.objectStore('d')); t.oncomplete = () => res(q?.result); t.onerror = t.onabort = () => rej(t.error); }); };

export const newSession = () => 'en-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// this browser's draft of an item (or null)
export async function localDraft(id) {
  try { const s = localStorage.getItem(KEY(id)); if (s) { const d = JSON.parse(s); if (d?.idb) return (await idbDo('readonly', (st) => st.get(id))) || null; return d; } } catch {}
  try { return (await idbDo('readonly', (st) => st.get(id))) || null; } catch { return null; }
}
export async function keepLocal(d) {
  try { localStorage.setItem(KEY(d.item), JSON.stringify(d)); return true; } catch {}
  try { await idbDo('readwrite', (st) => st.put(d, d.item)); try { localStorage.setItem(KEY(d.item), JSON.stringify({ idb: true, item: d.item, savedAt: d.savedAt })); } catch {} return true; } catch { return false; }
}
export async function dropLocal(id) {
  try { localStorage.removeItem(KEY(id)); } catch {}
  try { await idbDo('readwrite', (st) => st.delete(id)); } catch {}
}

const api = (path, opts = {}) => fetch('/api' + path, opts).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.detail || `Failed (${r.status})`), { status: r.status }); return j; });
const json = (method, body, keepalive = false) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });

// the newest draft of an item: this browser's or the Mac's (another device / a cleared browser) -> draft | null
export async function findDraft(id) {
  const loc = await localDraft(id);
  let srv = null;
  try {
    const top = (await api(`/items/${encodeURIComponent(id)}/editnotes/draft`)).drafts?.find((d) => d.n > 0);
    if (top && (!loc || top.savedAt > loc.savedAt + 1000)) srv = await api(`/items/${encodeURIComponent(id)}/editnotes/draft/${encodeURIComponent(top.session)}`);
  } catch {}
  const d = srv && srv.ops?.length ? srv : loc;
  return d && d.ops?.length ? d : null;
}

export async function dropDrafts(id) {
  await dropLocal(id);
  try { await api(`/items/${encodeURIComponent(id)}/editnotes/draft`, { method: 'DELETE' }); } catch {}
}

// the edit session + drafts of one open editor
export function editGuard(it, session, getState, alive = () => true) {
  const url = `/items/${encodeURIComponent(it.id)}`;
  let dirty = false, timer = null, beat = null, lastSent = 0, stopped = false, held = false, inflight = null;
  const state = () => { const s = getState(); return { item: it.id, title: it.title || '', session, sha: s.sha, ops: s.ops, n: s.n, savedAt: Date.now() }; };
  const toMac = async (keepalive = false) => {
    if (!dirty || stopped || held) return;
    const d = state(), xml = getState().xml;
    dirty = false; lastSent = Date.now();
    const body = { session, sha: d.sha, ops: d.ops, n: d.ops.length ? d.n : 0, ...(keepalive && (xml || '').length > 48000 ? {} : { xml }) };
    inflight = api(`${url}/editnotes/draft`, json('POST', body, keepalive && JSON.stringify(body).length < 60000)).catch(() => { dirty = true; });
    await inflight; inflight = null;
  };
  const later = () => { if (!timer) timer = setTimeout(() => { timer = null; toMac(); }, Math.max(0, 30000 - (Date.now() - lastSent))); };
  const g = {
    start: (sha) => api(`${url}/editsession`, json('POST', { session, sha })).catch(() => {}),
    // after every edit / undo: this browser at once, the Mac within 30 s
    changed: async () => {
      const d = state();
      if (d.ops.length) await keepLocal(d); else await dropLocal(it.id); // back to the score as saved: no draft
      dirty = true;
      later();
    },
    // a Save is on its way: no draft is sent meanwhile (one sent after it would bring the saved edits back)
    hold: async () => { held = true; clearTimeout(timer); timer = null; await inflight; },
    release: () => { held = false; dirty = true; later(); },
    flush: () => { clearTimeout(timer); timer = null; return toMac(true); },
    stop: () => {
      stopped = true; clearTimeout(timer); clearInterval(beat);
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide);
      try { navigator.sendBeacon?.(`/api${url}/editsession/end`, new Blob([JSON.stringify({ session })], { type: 'text/plain' })) || fetch(`/api${url}/editsession/end`, json('POST', { session }, true)); } catch {}
    },
  };
  const onVis = () => { if (document.visibilityState === 'hidden') { const d = state(); if (d.ops.length) keepLocal(d); g.flush(); } };
  const onHide = () => { const d = state(); if (d.ops.length) keepLocal(d); g.flush(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  beat = setInterval(() => {
    if (!stopped && !alive()) { onHide(); g.stop(); return; } // the view went away with the editor open: the draft stays
    if (!stopped) api(`${url}/editsession`, json('POST', { session, beat: true })).catch(() => {}); }, 25000);
  return g;
}

// the answer to a Save, kept on screen: ok ("Saved ✓ 14:05" + more words) or an error (stays until ✕)
export function saveNote(text, { error = false, stay = false, action } = {}) {
  document.querySelector('.save-note')?.remove();
  const el = document.createElement('div');
  el.className = `save-note${error ? ' err' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  const hm = new Date().toTimeString().slice(0, 5);
  el.innerHTML = `<span class="sn-text">${error ? '' : `<b>Saved ✓ ${hm}</b> `}${esc(text || '')}</span>${action ? `<button class="link" data-go>${esc(action.label)}</button>` : ''}<button class="icon-btn sn-x" aria-label="Dismiss">✕</button>`;
  el.querySelector('.sn-x').onclick = () => el.remove();
  if (action) el.querySelector('[data-go]').onclick = () => { el.remove(); action.run(); };
  document.body.append(el);
  if (!error && !stay) setTimeout(() => el.remove(), 20000);
  return el;
}
