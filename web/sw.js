// Meowsic offline: the app shell is cached so the library opens without the Mac; API answers and
// page / score files are cached as they are viewed and served from cache when the Mac is away.
// Saved copies are kept tidy: one copy per URL path (the newest ?v=), an index in IndexedDB with the
// size and last use of each, a size cap (least recently used go first), and a clean-up the app asks
// for after each sync with the Mac (items the Mac no longer has). The app shell is never touched.
const SHELL = 'meowsic-shell-v22', DATA = 'meowsic-data-v1';
const SHELL_FILES = ['./', 'index.html', 'css/app.css', 'css/photoimport.css', 'css/completeinfo.css', 'css/beta.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png', 'vendor/osmd.min.js'];
const MB = 1024 * 1024, DEFAULT_CAP = 1024 * MB;

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// no network and nothing saved: say so (the app tells this apart from a real server error)
const away = () => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Meowsic-Offline': '1' } });

// ---------- the index: { url, path, base, item, kind, size, at } per saved copy ----------
let dbp;
const idb = () => (dbp ||= new Promise((res, rej) => {
  const r = indexedDB.open('meowsic-saved', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('entries', { keyPath: 'url' }).createIndex('base', 'base'); r.result.createObjectStore('meta'); };
  r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
}));
const tx = async (store, mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, mode); let out; Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; }); t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error); }); };
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const allEntries = () => tx('entries', 'readonly', (s) => req(s.getAll()));
const getCap = async () => (await tx('meta', 'readonly', (s) => req(s.get('cap')))) || DEFAULT_CAP;

// the cache key: retry markers (?r=) dropped, so a retried picture is the same saved copy
function keyOf(u) { const url = new URL(u); url.searchParams.delete('r'); return url.href; }
// one URL "slot": the path plus every parameter except the version (?v=) — older versions share it
function baseOf(u) { const url = new URL(u); url.searchParams.delete('r'); url.searchParams.delete('v'); url.searchParams.sort(); return url.pathname + '?' + url.searchParams; }
function describe(u) {
  const p = new URL(u).pathname, m = p.match(/^\/api\/items\/([^/]+)(\/.*)?$/);
  const rest = m?.[2] || '';
  const kind = /^\/pages\/\d+$/.test(rest) || /\.(png|jpe?g|webp|gif|heic)$/i.test(rest) ? 'page' : /^\/thumb\//.test(rest) ? 'thumb'
    : /musicxml|\.mxl$|\.mid/i.test(rest) ? 'score' : 'data';
  return { path: p, item: m && m[1] !== 'book' && m[1] !== 'trash' && m[1] !== 'purge' && m[1] !== 'restore' ? decodeURIComponent(m[1]) : null, kind };
}

// a fresh answer from the Mac: save it, drop older versions of the same slot, note size + use, then keep under the cap
async function save(url, r) {
  const key = keyOf(url), base = baseOf(url), blob = await r.blob();
  const c = await caches.open(DATA);
  const h = new Headers(r.headers); h.delete('Content-Encoding'); h.delete('Content-Length');
  await c.put(key, new Response(blob, { status: r.status, statusText: r.statusText, headers: h }));
  const older = await tx('entries', 'readwrite', async (s) => {
    const gone = (await req(s.index('base').getAll(base))).filter((x) => x.url !== key);
    for (const x of gone) s.delete(x.url);
    s.put({ url: key, base, ...describe(key), size: blob.size, at: Date.now() });
    return gone;
  });
  for (const x of older) await c.delete(x.url);
  scheduleCap();
}
// served from the saved copy (offline): it was used just now
const touch = (key) => tx('entries', 'readwrite', async (s) => { const e = await req(s.get(key)); if (e) { e.at = Date.now(); s.put(e); } }).catch(() => {});

let capTimer;
function scheduleCap() { clearTimeout(capTimer); capTimer = setTimeout(() => enforceCap().catch(() => {}), 500); }
// over the cap: least recently used go first; the copy used last always stays
async function enforceCap(cap) {
  cap ??= await getCap();
  const all = (await allEntries()).sort((a, b) => a.at - b.at);
  let total = all.reduce((n, x) => n + (x.size || 0), 0), gone = 0;
  const c = await caches.open(DATA);
  for (let i = 0; i < all.length - 1 && total > cap; i++) {
    await c.delete(all[i].url); await tx('entries', 'readwrite', (s) => s.delete(all[i].url));
    total -= all[i].size || 0; gone++;
  }
  return gone;
}

// the index and the cache agree: copies saved before the index existed get their size (used: long ago)
async function reconcile() {
  const c = await caches.open(DATA), keys = await c.keys(), have = new Set(keys.map((k) => k.url));
  const idx = new Map((await allEntries()).map((x) => [x.url, x]));
  const add = [];
  for (const k of keys) if (!idx.has(k.url)) { const r = await c.match(k); const b = r ? await r.blob() : null; add.push({ url: k.url, base: baseOf(k.url), ...describe(k.url), size: b?.size || 0, at: 0 }); }
  await tx('entries', 'readwrite', (s) => { for (const x of add) s.put(x); for (const u of idx.keys()) if (!have.has(u)) s.delete(u); });
  // two versions of one slot from before the index: keep the newest (highest ?v=)
  const bySlot = new Map();
  for (const x of await allEntries()) (bySlot.get(x.base) || bySlot.set(x.base, []).get(x.base)).push(x);
  const drop = [];
  for (const list of bySlot.values()) if (list.length > 1) { list.sort((a, b) => (+new URL(b.url).searchParams.get('v') || 0) - (+new URL(a.url).searchParams.get('v') || 0) || b.at - a.at); drop.push(...list.slice(1)); }
  await removeAll(drop);
}
async function removeAll(list) {
  if (!list.length) return 0;
  const c = await caches.open(DATA);
  for (const x of list) await c.delete(x.url);
  await tx('entries', 'readwrite', (s) => { for (const x of list) s.delete(x.url); });
  return list.length;
}

// after a sync: items = [{ id, files: [names the item still has] }] — everything else of an item goes
async function clean(items) {
  await reconcile();
  const live = new Map(items.map((x) => [x.id, new Set(x.files || [])]));
  const drop = (await allEntries()).filter((x) => {
    if (!x.item) return false;
    if (!live.has(x.item)) return true;
    const f = x.path.match(/^\/api\/items\/[^/]+\/file\/(.+)$/);
    return f ? !live.get(x.item).has(decodeURIComponent(f[1])) : false;
  });
  const n = await removeAll(drop);
  return { removed: n, evicted: await enforceCap() };
}
async function stats(withUrls) {
  await reconcile();
  const all = await allEntries(), by = { page: [0, 0], thumb: [0, 0], score: [0, 0], data: [0, 0] };
  for (const x of all) { const k = by[x.kind] || by.data; k[0]++; k[1] += x.size || 0; }
  const out = { count: all.length, size: all.reduce((n, x) => n + (x.size || 0), 0), by, cap: await getCap() };
  if (withUrls) out.urls = all.map((x) => ({ url: x.url, at: x.at, size: x.size }));
  return out;
}
async function clearAll() {
  await caches.delete(DATA);
  await tx('entries', 'readwrite', (s) => s.clear());
}

// the app asks: { op: 'stats' | 'clean' | 'clear' | 'cap', ... } — the answer goes back on the port
self.addEventListener('message', (e) => {
  const m = e.data || {}, port = e.ports[0];
  if (!m.op || !port) return;
  const run = { stats: () => stats(m.urls), clean: () => clean(m.items || []), clear: clearAll, cap: async () => { await tx('meta', 'readwrite', (s) => s.put(m.bytes, 'cap')); return { evicted: await enforceCap(m.bytes) }; } }[m.op];
  if (!run) return port.postMessage({ error: 'unknown op' });
  e.waitUntil(run().then((v) => port.postMessage({ ok: true, value: v }), (err) => port.postMessage({ error: String(err) })));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // "is the Mac there?" must never be answered from the cache
  if (url.pathname === '/api/health') return;
  // API + item files: network first (fresh when the Mac is there), cache when it isn't.
  // Pages by number (/pages/n?v=…): an older saved copy of the same page beats no page.
  if (url.pathname.startsWith('/api/')) {
    const page = /^\/api\/items\/[^/]+\/pages\/\d+$/.test(url.pathname), key = keyOf(e.request.url);
    e.respondWith(fetch(e.request).then((r) => { if (r.ok && r.status === 200) e.waitUntil(save(e.request.url, r.clone()).catch(() => {})); return r; })
      .catch(async () => {
        const c = await caches.open(DATA);
        let hit = key, r = await c.match(key);
        if (!r && page) { const k = (await c.keys(key, { ignoreSearch: true }))[0]; if (k) { hit = k.url; r = await c.match(k); } }
        if (!r) return away();
        e.waitUntil(touch(hit));
        return r;
      }));
    return;
  }
  // app files: network first so updates arrive at once, cache as fallback
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
