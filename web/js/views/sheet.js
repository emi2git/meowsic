// Sheet viewer: page images with swipe / arrow / pedal turns, 1 or 2 pages, thumbnails, ink.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { sheetUrl } from '../sheet-art.js';
import { InkLayer, inkToolbar } from './annotate.js';
import { go } from '../app.js';

export const pageSrc = (it, p) => (it.upload && store.sessionImage(`${it.id}:${p}`)) || sheetUrl(it.title, p, it.pages, { artist: it.artist });

export function sheetBody(root, it, { perform = false, onEnd } = {}) {
  let page = 1;
  let spread = false;
  try { spread = localStorage.getItem('meowsic-spread') === '1'; } catch {}
  let layers = [];
  let tool = null;

  root.innerHTML = `
    <div class="pages ${perform ? 'perform' : ''}" id="pages" tabindex="-1">
      <button class="turn prev" aria-label="Previous page">‹</button>
      <div class="page-row" id="page-row"></div>
      <button class="turn next" aria-label="Next page">›</button>
    </div>
    ${perform ? '' : `<div class="strip" id="strip">${Array.from({ length: it.pages }, (_, i) =>
      `<button data-p="${i + 1}" aria-label="Page ${i + 1}"><img src="${pageSrc(it, i + 1)}" alt="" loading="lazy"><span>${i + 1}</span></button>`).join('')}</div>`}`;

  const wide = () => root.clientWidth > 700;
  const twoUp = () => spread && wide() && it.pages > 1;

  const draw = () => {
    layers.forEach((l) => l.destroy());
    layers = [];
    const show = twoUp() ? [page, page + 1].filter((p) => p <= it.pages) : [page];
    const row = $('#page-row', root);
    row.innerHTML = show.map((p) => `<div class="page" data-p="${p}"><img src="${pageSrc(it, p)}" alt="Page ${p} of ${esc(it.title)}" draggable="false"></div>`).join('');
    row.querySelectorAll('.page').forEach((w) => {
      const img = w.querySelector('img');
      const mk = () => { const l = new InkLayer(w, it.id, +w.dataset.p); l.setTool(tool); layers.push(l); };
      img.complete ? mk() : img.addEventListener('load', mk, { once: true });
    });
    root.querySelector('.prev').disabled = page <= 1;
    root.querySelector('.next').disabled = page + (twoUp() ? 2 : 1) > it.pages;
    root.querySelectorAll('#strip button').forEach((b) => b.classList.toggle('on', show.includes(+b.dataset.p)));
    root.querySelector('#strip .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    root.dispatchEvent(new CustomEvent('pagechange', { detail: { page, show, pages: it.pages }, bubbles: true }));
  };
  const step = () => (twoUp() ? 2 : 1);
  const next = () => { if (page + step() <= it.pages) { page += step(); draw(); } else onEnd?.(); };
  const prev = () => { if (page > 1) { page = Math.max(1, page - step()); draw(); } };

  root.querySelector('.prev').onclick = prev;
  root.querySelector('.next').onclick = next;
  $('#strip', root)?.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { page = +b.dataset.p; draw(); } });

  // swipe, and in performance mode a tap on the left / right half turns the page
  const pages = $('#pages', root);
  let sx = null, sy = 0;
  pages.addEventListener('pointerdown', (e) => { if (tool) return; sx = e.clientX; sy = e.clientY; });
  pages.addEventListener('pointerup', (e) => {
    if (sx === null || tool) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : prev();
    if (perform && Math.abs(dx) < 10 && !e.target.closest('button')) {
      const r = pages.getBoundingClientRect();
      e.clientX - r.left > r.width * 0.4 ? next() : prev();
    }
  });
  // arrows, page keys and space — Bluetooth page-turn pedals send these
  const onKey = (e) => {
    if (e.target.closest('input,textarea,select')) return;
    if (['ArrowRight', 'PageDown', 'ArrowDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
    if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); prev(); }
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => draw());
  ro.observe(root);

  return {
    get page() { return page; },
    setSpread(v) { spread = v; try { localStorage.setItem('meowsic-spread', v ? '1' : '0'); } catch {} if (spread && page % 2 === 0) page--; draw(); },
    get spread() { return spread; },
    setTool(t) { tool = t; layers.forEach((l) => l.setTool(t)); pages.classList.toggle('inking', !!t); },
    undo() { layers.at(-1)?.undo(); },
    clear() { layers.forEach((l) => l.clear()); },
    goTo(p) { page = p; draw(); },
    destroy() { document.removeEventListener('keydown', onKey); ro.disconnect(); layers.forEach((l) => l.destroy()); },
  };
}

export function sheetToolbar(bar, it, view) {
  bar.innerHTML = `
    <span class="pageno" id="pageno"></span>
    <button class="icon-btn hide-phone" id="sv-spread" title="One or two pages"><span id="sv-spread-l"></span></button>
    <button class="icon-btn" id="sv-ink" title="Annotate" aria-label="Annotate">${iconOn('pen')}</button>`;
  const setL = () => ($('#sv-spread-l', bar).textContent = view.spread ? '2 pages' : '1 page');
  setL();
  $('#sv-spread', bar).onclick = () => { view.setSpread(!view.spread); setL(); };
  $('#sv-ink', bar).onclick = () => startInk(view, document.querySelector('.viewer'));
}

export function startInk(view, host) {
  if (host.querySelector('.inkbar')) return;
  view.setTool('red');
  const tb = inkToolbar((t) => view.setTool(t), (a) => {
    if (a === 'undo') view.undo();
    if (a === 'clear') view.clear();
    if (a === 'done') { view.setTool(null); tb.remove(); toast('Annotations saved'); }
  });
  host.append(tb);
}

export function sheetExtraMenu(it, view) {
  return [
    { label: 'Split into a new sheet from this page', icon: 'split', run: () => splitAt(it, view.page) },
    { label: 'Merge with another sheet…', icon: 'merge', run: () => mergeInto(it) },
  ];
}

async function splitAt(it, page) {
  if (page <= 1) return toast('Go to the page where the new sheet should start.');
  const ok = await confirmSheet({ title: `Split “${it.title}” at page ${page}?`, body: `Pages ${page}–${it.pages} become a new sheet.`, ok: 'Split' });
  if (!ok) return;
  const n = store.add({ kind: 'sheet', title: it.title + ' (part 2)', artist: it.artist, tags: [...it.tags], pages: it.pages - page + 1, source: it.source });
  store.update(it.id, { pages: page - 1 });
  toast('Split into two sheets', { label: 'Open new', run: () => go(`#/item/${n.id}`) });
}

function mergeInto(it) {
  const others = store.items().filter((x) => x.kind === 'sheet' && x.id !== it.id).sort((a, b) => a.title.localeCompare(b.title));
  const s = modal(`<h2>Merge “${esc(it.title)}” with…</h2><p class="muted">The other sheet's pages are added after this one's, and it is removed from the list.</p>
    <input type="search" placeholder="Find a sheet" id="mg-q">
    <div class="list-pick" id="mg-list"></div><div class="modal-actions"><button data-close>Cancel</button></div>`, { wide: true });
  const list = $('#mg-list', s.el);
  const draw = (q = '') => (list.innerHTML = others.filter((x) => x.title.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
    .map((x) => `<button data-id="${x.id}"><img src="${pageSrc(x, 1)}" alt=""><span>${esc(x.title)}</span><i>${x.pages} p</i></button>`).join(''));
  draw();
  $('#mg-q', s.el).oninput = (e) => draw(e.target.value);
  list.onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const o = store.get(b.dataset.id);
    store.update(it.id, { pages: it.pages + o.pages, tags: [...new Set([...it.tags, ...o.tags])] });
    store.purge(o.id);
    s.close();
    toast(`Merged — now ${it.pages} pages`);
  };
}
