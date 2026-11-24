// The library store. Three modes:
//  - server:  the Meowsic server on the Mac answers /api; every change is sent there too
//  - offline: the Mac can't be reached; the last copy of the library is used and changes wait
//             in an outbox until the Mac is back
//  - mock:    the UI preview without a server (sample data kept in this browser)
// The screens only use the `store` object below, so they don't care which mode is on.
import { buildMock } from './mock.js';
import { parseChordPro } from './chordchart.js';
import * as saved from './saved.js';

const KEY = 'meowsic-mock-v6';
let db;
const subs = new Set();
const jobSubs = new Set();
const session = new Map(); // uploaded images (object URLs) live only for this session

let mode = 'mock';
let lastSync = 0;
const CACHE = 'meowsic-cache-v1', OUTBOX = 'meowsic-outbox-v1';
const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// a fetch that gives up after ms (AbortSignal.timeout is missing on older iOS)
const timed = (url, ms, opts = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t)); };
// does the Mac answer? (never from the service worker's cache: sw.js leaves /api/health alone)
async function ping() {
  try { const h = await timed('/api/health', 4000, { cache: 'no-store' }); return h.ok && !!(await h.json()).ok; } catch { return false; }
}
const connSubs = new Set();
function setMode(m) { if (m === mode) return; mode = m; connSubs.forEach((f) => f(m)); if (m === 'offline') subs.forEach((f) => f()); }

// one call to the Mac; when it fails (offline) the call waits in the outbox and is sent later.
// One failed request alone doesn't mean the Mac is away: only when /api/health doesn't answer either.
// the open Edit notes' session (editnotes.js): the page's own writes to that score (tempo, transpose …) pass the
// Mac's lock (server editsafe.py), which refuses other writers with 423 while it is open
let editSession = null;
export const setEditSession = (s) => { editSession = s; };
async function api(method, path, body, { queue = true } = {}) {
  if (mode === 'mock') return null;
  const opts = { method, headers: editSession ? { 'X-Edit-Session': editSession } : {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  try {
    const r = await fetch('/api' + path, opts);
    if (r.headers.get('X-Meowsic-Offline')) throw new Error('offline'); // the service worker: no network and nothing cached
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || `Request failed (${r.status})`), { status: r.status });
    return r.status === 204 ? null : r.json();
  } catch (e) {
    if (queue && !e.status) { const box = ls.get(OUTBOX) || []; box.push([method, path, body]); ls.set(OUTBOX, box); }
    if (e.status) console.warn('Meowsic:', e.message);
    else if (mode === 'server' && !(await ping())) setMode('offline');
    return null;
  }
}
async function flushOutbox() {
  const box = ls.get(OUTBOX) || [];
  if (!box.length) return;
  ls.set(OUTBOX, []);
  for (let i = 0; i < box.length; i++) {
    await api(...box[i]);
    // the Mac went away again (api queued that one): the rest waits too, in order
    if (mode !== 'server') { ls.set(OUTBOX, [...(ls.get(OUTBOX) || []), ...box.slice(i + 1)]); return; }
  }
}
const send = (method, path, body) => { api(method, path, body); };

async function boot() {
  try {
    if (await ping()) {
      mode = 'server';
      await flushOutbox();
      db = await (await fetch('/api/backup', { cache: 'no-store' })).json();
      ls.set(CACHE, db);
      lastSync = Date.now(); ls.set('meowsic-last-sync', lastSync);
    }
  } catch { mode = 'mock'; }
  const preview = new URLSearchParams(location.search).has('preview'); // sample library, only for automated UI tests
  if (mode === 'mock' && preview) return load();
  if (mode === 'mock') { db = ls.get(CACHE) || { items: [], tags: [] }; mode = 'offline'; lastSync = ls.get('meowsic-last-sync') || 0; }
  db.items ||= []; db.tags ||= []; db.plays ||= []; db.jobs ||= []; db.activity ||= []; db.annotations ||= {}; db.printed ||= {};
  hydrate();
  if (mode === 'server') tidy();
}
// after a sync with the Mac: saved pages / scores of items it no longer has, and older versions, go (in the background)
function tidy() { if (mode === 'server' && Array.isArray(db?.items)) saved.clean(db.items).catch?.(() => {}); }

// offline: ask the Mac every 10 s, and when the app comes back to the front / the network changes.
// When it answers: server mode again, send what waited, pull the Mac's list, redraw open views.
let checking = null;
function reconnect() {
  if (mode !== 'offline') return Promise.resolve(mode === 'server');
  return (checking ||= (async () => {
    if (!(await ping())) return false;
    setMode('server');
    await flushOutbox();
    if (mode !== 'server') return false;
    if (!db.items.length) { try { const d = await (await fetch('/api/backup', { cache: 'no-store' })).json(); if (Array.isArray(d.items)) { Object.assign(db, d); hydrate(); tidy(); } } catch {} }
    else await store.resync().catch(() => {});
    lastSync = Date.now(); ls.set('meowsic-last-sync', lastSync);
    changed();
    dispatchEvent(new CustomEvent('meowsic-reconnected'));
    return true;
  })().finally(() => { checking = null; }));
}
setInterval(() => { if (mode === 'offline') reconnect(); }, 10 * 1000);
// coming back to the app (iPad wakes, tab shown, Home Screen app reopened) and every few minutes: pull the Mac's list again
const wake = () => { if (mode === 'offline') reconnect(); else if (document.visibilityState === 'visible') store.resync().catch(() => {}); };
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
addEventListener('focus', () => { if (mode === 'offline') reconnect(); });
addEventListener('online', () => { if (mode === 'offline') reconnect(); });
setInterval(() => { if (document.visibilityState === 'visible') store.resync().catch(() => {}); }, 3 * 60 * 1000);

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) db = JSON.parse(raw);
  } catch {}
  if (!db || db.version !== 6) db = buildMock();
  hydrate();
}
// the old credit name reads "Meowsic" everywhere (the Mac's data is moved over too)
const OLD_CREDIT = 'Meowsic AI';
function credited(it) { if (it.artist === OLD_CREDIT) it.artist = 'Meowsic'; if (it.source === OLD_CREDIT) it.source = 'Meowsic'; return it; }
function hydrate() {
  for (const it of db.items) { credited(it); if (it.kind === 'chords') it.lines = parseChordPro(it.text); }
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
    // the Mac's answer wins: a new title renames the folder and the page files, so take its file names
    api('PATCH', `/items/${id}`, patch).then((fresh) => {
      if (fresh && fresh.id === id && ('title' in patch || fresh.pageFiles)) { const cur = this.get(id); if (cur) { Object.assign(cur, fresh); if (cur.kind === 'chords') cur.lines = parseChordPro(cur.text); changed(); } }
    });
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
  // Trash changes: the Mac writes the Activities row itself (with what Undo needs), so it is only kept here.
  // act = {type, title, detail} names that row (Clean up: "Deleted 3 sheets").
  bin(ids, act) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { Object.assign(it, { deleted: true, deletedAt: Date.now() }); t.push(it.title); } } send('POST', '/items/trash', { ids: [].concat(ids), ...(act ? { act } : {}) }); this.logEvent(act?.type || 'bin', act?.title || (t.length > 1 ? `${t.length} items` : t[0]), act?.detail || t.join(', '), { local: true }); changed(); },
  restore(ids) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { it.deleted = false; t.push(it.title); } } send('POST', '/items/restore', { ids: [].concat(ids) }); this.logEvent('restore', t.length > 1 ? `${t.length} items` : t[0], t.join(', '), { local: true }); changed(); },
  purge(ids) {
    const s = new Set([].concat(ids));
    const gone = db.items.filter((x) => s.has(x.id)).map((x) => x.title);
    if (gone.length) this.logEvent('delete', gone.length > 1 ? `${gone.length} items` : gone[0], gone.join(', '), { local: true });
    db.items = db.items.filter((x) => !s.has(x.id));
    send('POST', '/items/purge', { ids: [...s] });
    changed();
  },

  // sheet / chord chart versions: 'lead' | 'piano' | 'duet' | '' for many at once
  setVersion(ids, version) {
    ids = [].concat(ids);
    for (const id of ids) { const it = this.get(id); if (it?.kind === 'sheet' || it?.kind === 'chords') Object.assign(it, { version, updatedAt: Date.now() }); }
    send('POST', '/items/version', { ids, version });
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
  // act = {id, type, title, detail}: several calls with the same act id make one Activities row (one Undo)
  setTags(ids, add = [], remove = [], act) {
    for (const id of [].concat(ids)) {
      const it = this.get(id);
      if (it) it.tags = [...new Set([...it.tags.filter((t) => !remove.includes(t)), ...add])];
    }
    for (const t of add) if (!db.tags.includes(t)) db.tags.push(t);
    send('POST', '/tags/set', { ids: [].concat(ids), add, remove, ...(act ? { act } : {}) });
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
  // { local: true }: the Mac logs this change itself (with its undo info): keep it here only
  logEvent(type, title, detail = '', { local = false, id = uid('act') } = {}) { (db.activity ||= []).unshift({ id, type, title, detail, status: 'done', at: Date.now() }); db.activity.length > 500 && (db.activity.length = 500); if (!local) send('POST', '/activity', { type, title, detail }); save(); },

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
  // page n by number (the Mac looks up its current file): stays right after a rename
  pageUrl(id, n, v = 0) { return `/api/items/${encodeURIComponent(id)}/pages/${n}?v=${v || 0}`; },
  // connection: check now (true = the Mac answers), try again, listen for server <-> offline
  async checkConnection() { if (mode === 'mock') return false; if (mode === 'offline') return reconnect(); if (await ping()) return true; setMode('offline'); return false; },
  retry() { return reconnect(); },
  onConn(fn) { connSubs.add(fn); return () => connSubs.delete(fn); },
  fileUrl(id, file) { return `/api/items/${encodeURIComponent(id)}/file/${file.split('/').map(encodeURIComponent).join('/')}`; },
  api,
  // after an upload / server-side change: put the server's copy of an item into the library
  // items the Mac already removed for good (no request, no activity): just forget them here
  drop(ids) { const s = new Set([].concat(ids)); db.items = db.items.filter((x) => !s.has(x.id)); changed(); },
  putItem(it) { credited(it); const i = db.items.findIndex((x) => x.id === it.id); if (it.kind === 'chords') it.lines = parseChordPro(it.text); if (i >= 0) db.items[i] = Object.assign(db.items[i], it); else db.items.unshift(it); /* same object: open views (sheet viewer) see the new pages */ for (const t of it.tags) if (!db.tags.includes(t)) db.tags.push(t); changed(); },
  // the Mac's list wins: items deleted or merged there (e.g. a split undone) disappear here too
  async resync() {
    if (mode !== 'server') return;
    await flushOutbox();
    const items = await api('GET', '/items', undefined, { queue: false });
    if (!Array.isArray(items)) return;
    const before = JSON.stringify(db.items.map((x) => [x.id, x.updatedAt, x.deleted]));
    const had = new Map(db.items.map((x) => [x.id, x]));
    db.items = items.map((f) => (had.has(f.id) ? Object.assign(had.get(f.id), f) : f)); hydrate(); // same objects: open views keep working
    tidy();
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
