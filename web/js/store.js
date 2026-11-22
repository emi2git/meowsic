// In-browser mock store. Phase 2 replaces this with the Mac server + offline cache;
// the views only talk to this API so the swap stays local to this file.
import { buildMock } from './mock.js';
import { parseChordPro } from './chordchart.js';

const KEY = 'meowsic-mock-v6';
let db;
const subs = new Set();
const jobSubs = new Set();
const session = new Map(); // uploaded images (object URLs) live only for this session

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
      localStorage.setItem(KEY, JSON.stringify(db, (k, v) => (k === 'lines' ? undefined : v)));
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
    changed();
  },
  add(item) {
    const it = { id: uid(item.kind[0]), tags: [], createdAt: Date.now(), updatedAt: Date.now(), deleted: false, ...item };
    if (it.kind === 'chords') it.lines = parseChordPro(it.text);
    db.items.unshift(it);
    for (const t of it.tags) if (!db.tags.includes(t)) db.tags.push(t);
    changed();
    return it;
  },
  bin(ids) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { Object.assign(it, { deleted: true, deletedAt: Date.now() }); t.push(it.title); } } this.logEvent('bin', t.length > 1 ? `${t.length} items` : t[0], t.join(', ')); changed(); },
  restore(ids) { const t = []; for (const id of [].concat(ids)) { const it = this.get(id); if (it) { it.deleted = false; t.push(it.title); } } this.logEvent('restore', t.length > 1 ? `${t.length} items` : t[0], t.join(', ')); changed(); },
  purge(ids) {
    const s = new Set([].concat(ids));
    const gone = db.items.filter((x) => s.has(x.id)).map((x) => x.title);
    if (gone.length) this.logEvent('delete', gone.length > 1 ? `${gone.length} items` : gone[0], gone.join(', '));
    db.items = db.items.filter((x) => !s.has(x.id));
    changed();
  },

  // tags
  tagCounts() {
    const m = new Map(db.tags.map((t) => [t, 0]));
    for (const it of this.items()) for (const t of it.tags) m.set(t, (m.get(t) || 0) + 1);
    return m;
  },
  addTag(name) { name = name.trim(); if (name && !db.tags.includes(name)) { db.tags.push(name); changed(); } },
  renameTag(from, to) {
    to = to.trim();
    if (!to || from === to) return;
    db.tags = [...new Set(db.tags.map((t) => (t === from ? to : t)))];
    for (const it of db.items) it.tags = [...new Set(it.tags.map((t) => (t === from ? to : t)))];
    changed();
  },
  deleteTag(name) { db.tags = db.tags.filter((t) => t !== name); for (const it of db.items) it.tags = it.tags.filter((t) => t !== name); changed(); },
  setTags(ids, add = [], remove = []) {
    for (const id of [].concat(ids)) {
      const it = this.get(id);
      if (it) it.tags = [...new Set([...it.tags.filter((t) => !remove.includes(t)), ...add])];
    }
    for (const t of add) if (!db.tags.includes(t)) db.tags.push(t);
    changed();
  },

  // everything with a tag, in the order print and set lists use (title A–Z)
  tagItems(tags) { tags = [].concat(tags); return this.items().filter((x) => tags.every((t) => x.tags.includes(t))).sort((a, b) => a.title.localeCompare(b.title)); },

  // play history
  plays(id) { return id ? db.plays.filter((p) => p.itemId === id) : db.plays; },
  logPlay(itemId, openedAt, closedAt) { if (closedAt - openedAt >= 10000) { db.plays.push({ itemId, openedAt, closedAt }); save(); } },
  lastPlayed(id) { let m = 0; for (const p of db.plays) if (p.itemId === id && p.openedAt > m) m = p.openedAt; return m; },
  playCount(id) { let n = 0; for (const p of db.plays) if (p.itemId === id) n++; return n; },

  // annotations: { "<itemId>:<page>": [stroke...] }
  strokes(id, page) { return db.annotations[`${id}:${page}`] || []; },
  setStrokes(id, page, strokes) { db.annotations[`${id}:${page}`] = strokes; save(); },
  hasStrokes(id) { return Object.keys(db.annotations).some((k) => k.startsWith(id + ':') && db.annotations[k].length); },

  // activity: one entry per job or change, newest first. Jobs keep a log of lines.
  activity() { return [...(db.activity || []), ...db.jobs.map((j) => ({ ...j, type: j.gen ? 'version' : 'transcribe', at: j.startedAt }))].sort((a, b) => b.at - a.at); },
  logEvent(type, title, detail = '') { (db.activity ||= []).unshift({ id: uid('act'), type, title, detail, status: 'done', at: Date.now() }); db.activity.length > 500 && (db.activity.length = 500); save(); },

  // jobs (transcriptions)
  jobs() { return db.jobs; },
  addJob(job) { const j = { id: uid('job'), status: 'running', stage: 0, progress: 0, startedAt: Date.now(), log: [{ t: Date.now(), msg: 'Started' }], ...job }; db.jobs.unshift(j); changed(); return j; },
  onJobs(fn) { jobSubs.add(fn); return () => jobSubs.delete(fn); },
  // progress ticks only wake the job screens; a finished job wakes everything
  updateJob(id, patch, { quiet = true } = {}) { const j = db.jobs.find((x) => x.id === id); if (!j) return; if (patch.msg) { (j.log ||= []).push({ t: Date.now(), msg: patch.msg }); delete patch.msg; } Object.assign(j, patch); save(); jobSubs.forEach((f) => f()); if (!quiet) changed(); },
  dismissJob(id) { const j = db.jobs.find((x) => x.id === id); if (j) j.dismissed = true; changed(); jobSubs.forEach((f) => f()); },

  // uploaded page images for this session
  sessionImage(key, url) { if (url) session.set(key, url); return session.get(key); },

  // backup
  exportJson() { return JSON.stringify(db, (k, v) => (k === 'lines' ? undefined : v), 1); },
  importJson(text) { const d = JSON.parse(text); if (!Array.isArray(d.items)) throw new Error('This is not a Meowsic backup.'); db = d; hydrate(); changed(); },
  reset() { db = buildMock(); hydrate(); changed(); },
};

load();
