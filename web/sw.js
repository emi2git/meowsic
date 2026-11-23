// Meowsic offline: the app shell is cached so the library opens without the Mac; API answers and
// page / score files are cached as they are viewed and served from cache when the Mac is away.
const SHELL = 'meowsic-shell-v2', DATA = 'meowsic-data-v1';
const SHELL_FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png', 'vendor/osmd.min.js'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // API + item files: network first (fresh when the Mac is there), cache when it isn't
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(DATA).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then((r) => r || new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // app files: network first so updates arrive at once, cache as fallback
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
