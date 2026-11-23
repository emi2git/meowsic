// The library store. Three modes:
//  - server:  the Meowsic server on the Mac answers /api; every change is sent there too
//  - offline: the Mac can't be reached; the last copy of the library is used and changes wait
//             in an outbox until the Mac is back
//  - mock:    the UI preview without a server (sample data kept in this browser)
// The screens only use the `store` object below, so they don't care which mode is on.
import { buildMock } from './mock.js';
import { parseChordPro } from './chordchart.js';

const KEY = 'meowsic-mock-v6';
let db;
const subs = new Set();
const jobSubs = new Set();
const session = new Map(); // uploaded images (object URLs) live only for this session

let mode = 'mock';
let lastSync = 0;
const CACHE = 'meowsic-cache-v1', OUTBOX = 'meowsic-outbox-v1';
const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// one call to the Mac; when it fails (offline) the call waits in the outbox and is sent later
async function api(method, path, body, { queue = true } = {}) {
  if (mode === 'mock') return null;
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  try {
    const r = await fetch('/api' + path, opts);
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || `Request failed (${r.status})`), { status: r.status });
    return r.status === 204 ? null : r.json();
  } catch (e) {
    if (queue && !e.status) { const box = ls.get(OUTBOX) || []; box.push([method, path, body]); ls.set(OUTBOX, box); mode = 'offline'; }
    else if (e.status) console.warn('Meowsic:', e.message);
    return null;
  }
}
async function flushOutbox() {
  const box = ls.get(OUTBOX) || [];
  if (!box.length) return;
  ls.set(OUTBOX, []);
  for (const [m, p, b] of box) await api(m, p, b);
}
const send = (method, path, body) => { api(method, path, body); };

async function boot() {
  try {
    const h = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    if (h.ok && (await h.json()).ok) {
      mode = 'server';
      await flushOutbox();
      db = await (await fetch('/api/backup')).json();
      ls.set(CACHE, db);
      lastSync = Date.now(); ls.set('meowsic-last-sync', lastSync);
    }
  } catch {}
  const preview = new URLSearchParams(location.search).has('preview'); // sample library, only for automated UI tests
  if (mode === 'mock' && preview) return load();
  if (mode === 'mock') { db = ls.get(CACHE) || { items: [], tags: [] }; mode = 'offline'; lastSync = ls.get('meowsic-last-sync') || 0; }
  db.items ||= []; db.tags ||= []; db.plays ||= []; db.jobs ||= []; db.activity ||= []; db.annotations ||= {}; db.printed ||= {};
  hydrate();
}
// coming back to the app (iPad wakes, tab shown) and every few minutes: pull the Mac's list again
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') store.resync().catch(() => {}); });
setInterval(() => { if (document.visibilityState === 'visible') store.resync().catch(() => {}); }, 3 * 60 * 1000);
addEventListener('online', () => { if (mode === 'offline') boot().then(() => subs.forEach((f) => f())); });

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) db = JSON.parse(raw);
  } catch {}
  if (!db || db.version !== 6) db = buildMock();
  hydrate();
}
function hydrate() {
  for (const it of db.items) if (it.kind === 'chords') it.lines = parseChordPro(it.text);
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(mode === 'mock' ? KEY : CACHE, JSON.stringify(db, (k, v) => (k === 'lines' ? undefined : v)));
    } catch {}
  }, 200);
}
function changed() { save(); subs.forEach((f) => f()); }

export const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 9);

export const store = {
  on(fn) { subs.add(fn); return () => subs.delete(fn); },
  get db() { return db; },
  items({ deleted = false } = {}) { return db.items.filter((x) => !!x.deleted === deleted); },
  get(id) { return db.items.find((x) => x.id === id); },
  update(id, patch) {
    const it = this.get(id);
    if (!it) return;
    Object.assign(it, patch, { updatedAt: Date.now() });
    if ('text' in patch && it.kind === 'chords') it.lines = parseChordPro(it.text);
    send('PATCH', `/items/${id}`, patch);
    changed();
  },
  add(item) {
    const it = { id: uid(item.kind[0]), tags: [], createdAt: Date.now(), updatedAt: Date.now(), deleted: false, ...item };
    if (it.kind === 'chords') it.lines = parseChordPro(it.text);
    db.items.unshift(it);
    for (const t of it.tags) if (!db.tags.includes(t)) db.tags.push(t);
    if (!item.fromServer) send('POST', '/items', it);
    delete it.fromServer;
    changed();
    return it;
  },
  bin(ids) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { Object.assign(it, { deleted: true, deletedAt: Date.now() }); t.push(it.title); } } send('POST', '/items/trash', { ids: [].concat(ids) }); this.logEvent('bin', t.length > 1 ? `${t.length} items` : t[0], t.join(', ')); changed(); },
  restore(ids) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { it.deleted = false; t.push(it.title); } } send('POST', '/items/restore', { ids: [].concat(ids) }); this.logEvent('restore', t.length > 1 ? `${t.length} items` : t[0], t.join(', ')); changed(); },
  purge(ids) {
    const s = new Set([].concat(ids));
    const gone = db.items.filter((x) => s.has(x.id)).map((x) => x.title);
    if (gone.length) this.logEvent('delete', gone.length > 1 ? `${gone.length} items` : gone[0], gone.join(', '));
    db.items = db.items.filter((x) => !s.has(x.id));
    send('POST', '/items/purge', { ids: [...s] });
    changed();
  },

  // tags
  tagCounts() {
    const m = new Map(db.tags.map((t) => [t, 0]));
    for (const it of this.items()) for (const t of it.tags) m.set(t, (m.get(t) || 0) + 1);
    return m;
  },
  addTag(name) { name = name.trim(); if (name && !db.tags.includes(name)) { db.tags.push(name); send('POST', '/tags', { name }); changed(); } },
  renameTag(from, to) {
    to = to.trim();
    if (!to || from === to) return;
    db.tags = [...new Set(db.tags.map((t) => (t === from ? to : t)))];
    for (const it of db.items) it.tags = [...new Set(it.tags.map((t) => (t === from ? to : t)))];
    send('PATCH', `/tags/${encodeURIComponent(from)}`, { to });
    changed();
  },
  deleteTag(name) { db.tags = db.tags.filter((t) => t !== name); for (const it of db.items) it.tags = it.tags.filter((t) => t !== name); send('DELETE', `/tags/${encodeURIComponent(name)}`); changed(); },
  setTags(ids, add = [], remove = []) {
    for (const id of [].concat(ids)) {
      const it = this.get(id);
      if (it) it.tags = [...new Set([...it.tags.filter((t) => !remove.includes(t)), ...add])];
    }
    for (const t of add) if (!db.tags.includes(t)) db.tags.push(t);
    send('POST', '/tags/set', { ids: [].concat(ids), add, remove });
    changed();
  },

  // everything with a tag, in the order print and set lists use (title A–Z)
  tagItems(tags) { tags = [].concat(tags); return this.items().filter((x) => tags.every((t) => x.tags.includes(t))).sort((a, b) => a.title.localeCompare(b.title)); },

  // play history
  plays(id) { return id ? db.plays.filter((p) => p.itemId === id) : db.plays; },
  logPlay(itemId, openedAt, closedAt) { if (closedAt - openedAt >= 10000) { db.plays.push({ itemId, openedAt, closedAt }); send('POST', '/plays', { itemId, openedAt, closedAt }); save(); } },
  lastPlayed(id) { let m = 0; for (const p of db.plays) if (p.itemId === id && p.openedAt > m) m = p.openedAt; return m; },
  playCount(id) { let n = 0; for (const p of db.plays) if (p.itemId === id) n++; return n; },

  // annotations: { "<itemId>:<page>": [stroke...] }
  strokes(id, page) { return db.annotations[`${id}:${page}`] || []; },
  setStrokes(id, page, strokes) { db.annotations[`${id}:${page}`] = strokes; send('PUT', `/items/${id}/annotations/${encodeURIComponent(page)}`, strokes); save(); },
  hasStrokes(id) { return Object.keys(db.annotations).some((k) => k.startsWith(id + ':') && db.annotations[k].length); },

  // activity: one entry per job or change, newest first. Jobs keep a log of lines.
  activity() { return [...(db.activity || []), ...db.jobs.map((j) => ({ ...j, type: j.gen ? 'version' : 'transcribe', at: j.startedAt }))].sort((a, b) => b.at - a.at); },
  markPrinted(ids) { db.printed ||= {}; for (const id of ids) db.printed[id] = Date.now(); send('POST', '/printed', { ids }); save(); },
  logEvent(type, title, detail = '') { (db.activity ||= []).unshift({ id: uid('act'), type, title, detail, status: 'done', at: Date.now() }); db.activity.length > 500 && (db.activity.length = 500); send('POST', '/activity', { type, title, detail }); save(); },

  // jobs (transcriptions)
  jobs() { return db.jobs; },
  addJob(job) {
    const j = { id: uid('job'), status: mode === 'mock' ? 'running' : 'queued', stage: 0, progress: 0, startedAt: Date.now(), log: [{ t: Date.now(), msg: 'Started' }], ...job };
    db.jobs.unshift(j);
    if (mode !== 'mock') api('POST', '/jobs', { ...job, kind: job.kind || (job.gen ? 'version' : 'transcribe') }).then((s) => { if (s) { Object.assign(j, s); jobSubs.forEach((f) => f()); } });
    changed();
    return j;
  },
  // audio file + job in one request (the Mac starts transcribing when the upload is in)
  async uploadJob(file, job) {
    const j = { id: uid('job'), status: 'queued', stage: 0, progress: 0, startedAt: Date.now(), log: [{ t: Date.now(), msg: 'Uploading' }], ...job };
    db.jobs.unshift(j); changed();
    const fd = new FormData();
    fd.append('file', file, file.name); fd.append('title', job.title); fd.append('outputs', JSON.stringify(job.outputs)); fd.append('source', job.source || '');
    try {
      const r = await fetch('/api/jobs/upload', { method: 'POST', body: fd });
      const s = await r.json();
      if (!r.ok) throw new Error(s.detail || 'Upload failed');
      Object.assign(j, s);
    } catch (e) { Object.assign(j, { status: 'failed', log: [...j.log, { t: Date.now(), msg: e.message }] }); }
    jobSubs.forEach((f) => f());
    return j;
  },
  onJobs(fn) { jobSubs.add(fn); return () => jobSubs.delete(fn); },
  // progress ticks only wake the job screens; a finished job wakes everything
  updateJob(id, patch, { quiet = true } = {}) { const j = db.jobs.find((x) => x.id === id); if (!j) return; if (patch.msg) { (j.log ||= []).push({ t: Date.now(), msg: patch.msg }); delete patch.msg; } Object.assign(j, patch); save(); jobSubs.forEach((f) => f()); if (!quiet) changed(); },
  dismissJob(id) { const j = db.jobs.find((x) => x.id === id); if (j) j.dismissed = true; send('POST', `/jobs/${id}/dismiss`); changed(); jobSubs.forEach((f) => f()); },

  // uploaded page images for this session
  sessionImage(key, url) { if (url) session.set(key, url); return session.get(key); },

  // backup
  exportJson() { return JSON.stringify(db, (k, v) => (k === 'lines' ? undefined : v), 1); },
  importJson(text) { const d = JSON.parse(text); if (!Array.isArray(d.items)) throw new Error('This is not a Meowsic backup.'); db = d; send('POST', '/backup/import', d); hydrate(); changed(); },
  reset() { if (mode !== 'mock') return; db = buildMock(); hydrate(); changed(); },

  // where things come from
  get mode() { return mode; },
  get lastSync() { return lastSync; },
  get waiting() { return (ls.get(OUTBOX) || []).length; },
  thumbUrl(it, page = 1, w = 240) { return mode === 'server' && it.pageFiles?.length ? `/api/items/${encodeURIComponent(it.id)}/thumb/${page}?w=${w}&v=${it.updatedAt || 0}` : null; },
  fileUrl(id, file) { return `/api/items/${encodeURIComponent(id)}/file/${file.split('/').map(encodeURIComponent).join('/')}`; },
  api,
  // after an upload / server-side change: put the server's copy of an item into the library
  // items the Mac already removed for good (no request, no activity): just forget them here
  drop(ids) { const s = new Set([].concat(ids)); db.items = db.items.filter((x) => !s.has(x.id)); changed(); },
  putItem(it) { const i = db.items.findIndex((x) => x.id === it.id); if (it.kind === 'chords') it.lines = parseChordPro(it.text); if (i >= 0) db.items[i] = it; else db.items.unshift(it); for (const t of it.tags) if (!db.tags.includes(t)) db.tags.push(t); changed(); },
  // the Mac's list wins: items deleted or merged there (e.g. a split undone) disappear here too
  async resync() {
    if (mode !== 'server') return;
    await flushOutbox();
    const items = await api('GET', '/items', undefined, { queue: false });
    if (!Array.isArray(items)) return;
    const before = JSON.stringify(db.items.map((x) => [x.id, x.updatedAt, x.deleted]));
    db.items = items; hydrate();
    if (JSON.stringify(db.items.map((x) => [x.id, x.updatedAt, x.deleted])) !== before) changed();
  },
  async refreshJobs() {
    if (mode !== 'server') return;
    const j = await api('GET', '/jobs', undefined, { queue: false });
    if (!j) return;
    const wasRunning = new Set(db.jobs.filter((x) => x.status === 'running' || x.status === 'queued').map((x) => x.id));
    db.jobs = j;
    // a job just finished: its new scores are on the Mac — pull them into the library
    const finished = j.filter((x) => wasRunning.has(x.id) && x.status === 'done');
    if (finished.length) dispatchEvent(new CustomEvent('meowsic-new-items', { detail: finished.flatMap((x) => x.result || []) }));
    if (finished.length) {
      const items = await api('GET', '/items', undefined, { queue: false });
      if (items) { for (const it of items) this.putItem(it); }
    }
    jobSubs.forEach((f) => f());
  },
};

await boot();
