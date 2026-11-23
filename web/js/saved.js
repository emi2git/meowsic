// Saved copies on this device (pages, scores, API answers kept by the service worker for offline):
// ask it for sizes, clean up after a sync, set the size cap, clear them. All the work is in sw.js.
export const MB = 1024 * 1024;
export const CAPS = [250, 500, 1024, 2048].map((n) => n * MB);

async function worker() {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000, null))]);
  return reg?.active || null;
}
// one request to the service worker; null when there is none (first visit, private window)
export async function ask(msg, ms = 20000) {
  const sw = await worker();
  if (!sw) return null;
  return new Promise((res) => {
    const ch = new MessageChannel(); const t = setTimeout(() => res(null), ms);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data?.ok ? e.data.value : null); };
    sw.postMessage(msg, [ch.port2]);
  });
}

// every string an item mentions (its page / score file names): a saved /file/<name> not among them is stale
function names(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => names(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'lines' && k !== 'text') names(x, out);
  return out;
}
// after a sync with the Mac: drop saved copies of items it no longer has, and of files they no longer use
export const clean = (items) => ask({ op: 'clean', items: items.map((it) => ({ id: it.id, files: names(it) })) });
export const stats = (urls = false) => ask({ op: 'stats', urls });
export const clear = () => ask({ op: 'clear' });
export const setCap = (bytes) => ask({ op: 'cap', bytes });
