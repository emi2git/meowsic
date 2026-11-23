// Connection state, never silent: a banner under the top bar while the Mac can't be reached, and a
// clear placeholder on any page picture that fails to load (instead of a blank box).
import { store } from './store.js';

const bar = document.createElement('div');
bar.id = 'conn-banner'; bar.className = 'conn-banner'; bar.setAttribute('role', 'status'); bar.hidden = true;
bar.innerHTML = '<span>Can’t reach the Mac — showing the saved copy. Pages you haven’t opened won’t show.</span><button type="button">Retry</button>';
document.body.append(bar);
const btn = bar.querySelector('button');
btn.onclick = async () => {
  btn.disabled = true; btn.textContent = 'Trying…';
  await store.retry();
  btn.disabled = false; btn.textContent = 'Retry';
};

// sit just under the open screen's top bar (each screen has its own), inside the main column
export function placeBanner() {
  const main = document.getElementById('main');
  bar.hidden = store.mode !== 'offline';
  document.body.classList.toggle('conn-off', !bar.hidden);
  if (bar.hidden || !main) return;
  const m = main.getBoundingClientRect();
  const top = [...main.querySelectorAll('header.top, .top')].find((h) => h.offsetParent && h.getBoundingClientRect().height);
  bar.style.left = m.left + 'px'; bar.style.width = m.width + 'px';
  bar.style.top = top ? Math.max(0, top.getBoundingClientRect().bottom) + 'px' : '';
}
store.onConn(() => { placeBanner(); if (store.mode === 'server') retryImages(); });
store.on(() => requestAnimationFrame(placeBanner));
addEventListener('hashchange', () => requestAnimationFrame(placeBanner));
addEventListener('resize', placeBanner);
addEventListener('meowsic-reconnected', () => { placeBanner(); retryImages(); });
new ResizeObserver(() => placeBanner()).observe(document.documentElement);

// ---------- page pictures that fail ----------
const isPage = (img) => /\/api\/items\/[^/]+\/(pages|file|thumb)\//.test(img.getAttribute('src') || img.src || '');
const holder = (img) => img.closest('.page, button, figure, .cu-img, .pp, .bs-large') || img.parentElement;
export async function markFailed(img) {
  if (!isPage(img)) return;
  img.classList.add('img-fail');
  const h = holder(img); if (!h) return;
  h.classList.add('img-failed');
  h.dataset.fail = store.mode === 'offline' ? 'Can’t load this page — the Mac isn’t reachable' : '…';
  if (store.mode === 'server') {
    const up = await store.checkConnection(); // one failed picture: is it the Mac or the page?
    if (img.classList.contains('img-fail')) h.dataset.fail = up ? 'This page is missing' : 'Can’t load this page — the Mac isn’t reachable';
  }
}
export function markLoaded(img) {
  if (!img.classList.contains('img-fail')) return;
  img.classList.remove('img-fail');
  const h = holder(img); if (h) { h.classList.remove('img-failed'); delete h.dataset.fail; }
}
// the Mac is back: load every failed page picture again (a new query so the browser really asks)
export function retryImages() {
  for (const img of document.querySelectorAll('img.img-fail')) {
    const u = new URL(img.src, location.href); u.searchParams.set('r', Date.now()); img.src = u.pathname + u.search;
  }
}
// any <img> in the page (load / error don't bubble, so listen while capturing)
document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) markFailed(e.target); }, true);
document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) markLoaded(e.target); }, true);
// pictures loaded before they were put in the page (the sheet viewer): watch them directly
export function watchImage(img) {
  img.addEventListener('error', () => markFailed(img));
  img.addEventListener('load', () => markLoaded(img));
  if (img.complete && img.src && !img.naturalWidth) markFailed(img);
}
placeBanner();
