// Sheet viewer: page images with swipe / arrow / pedal turns, 1 or 2 pages, thumbnails, ink.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { sheetUrl } from '../sheet-art.js';
import { InkLayer, inkToolbar } from './annotate.js';
import { go } from '../app.js';
import { bookToggle } from './actions.js';
import { titleBox } from '../title-detect.js';
import { attachSwipe, backToLibrary } from '../swipe.js';
import { isTouch, isDesktop } from '../device.js';

// real sheets: the page files on the Mac; the UI preview draws mock pages
export const pageSrc = (it, p) => (it.pageFiles?.[p - 1] && `${store.fileUrl(it.id, it.pageFiles[p - 1])}?v=${it.updatedAt || 0}`) || (it.upload && store.sessionImage(`${it.id}:${p}`)) || sheetUrl(it.title, p, it.pages, { artist: it.artist });

export function sheetBody(root, it, { perform = false, onEnd } = {}) {
  let page = 1;
  let layers = [];
  let tool = null;

  root.innerHTML = `
    <div class="sheet-frame">
      <button class="turn-strip prev" aria-label="Previous page" title="Previous page">‹</button>
      <div class="pages ${perform ? 'perform' : ''}" id="pages" tabindex="-1"><div class="page-row" id="page-row"></div></div>
      <button class="turn-strip next" aria-label="Next page" title="Next page">›</button>
    </div>`;

  // two pages side by side only in a Mac browser (mouse / trackpad and a wide window); iPad and iPhone show one
  const pages = $('#pages', root);
  // zoom steps (100% = one page at 1.5× the screen height): Mac starts at 50% = two pages side by
  // side; iPad / iPhone start at one page fitted to the screen (67%). Bigger pages scroll.
  const canTwo = () => it.pages > 1 && isDesktop() && root.clientWidth > 900;
  const levels = () => (canTwo() ? ['two', 1.5, 2.25, 3] : [1, 1.5, 2.25, 3]);
  let zoom = it.zoom ?? levels()[0];
  if (!levels().includes(zoom)) zoom = levels()[0];
  const twoUp = () => zoom === 'two' && canTwo();

  // page pictures, loaded and decoded ahead (the pages next to the shown ones too), so a turn swaps
  // in a ready picture whose shape is known: the new page never shows at a wrong (bigger) size first
  const imgs = new Map(); // src -> { im, ready: Promise, done }
  const load = (p) => {
    const src = pageSrc(it, p);
    let c = imgs.get(src);
    if (!c) {
      const im = new Image();
      im.draggable = false;
      im.src = src;
      c = { im, done: false };
      c.ready = im.decode().catch(() => new Promise((r) => (im.complete ? r() : (im.onload = im.onerror = r)))).then(() => { c.done = true; });
      imgs.set(src, c);
    }
    return c;
  };
  const preload = (show) => {
    const near = [];
    for (let d = 1; d <= 2; d++) near.push(show[0] - d, show.at(-1) + d);
    const keep = new Set([...show, ...near].filter((p) => p >= 1 && p <= it.pages).map((p) => pageSrc(it, p)));
    for (const k of imgs.keys()) if (!keep.has(k)) imgs.delete(k);
    near.filter((p) => p >= 1 && p <= it.pages).forEach(load);
  };
  let gen = 0;
  const draw = () => {
    if (twoUp() && page % 2 === 0) page--;
    const show = twoUp() ? [page, page + 1].filter((p) => p <= it.pages) : [page];
    const row = $('#page-row', root);
    const big = typeof zoom === 'number' && zoom > 1;
    root.querySelector('.turn-strip.prev').disabled = page <= 1;
    root.querySelector('.turn-strip.next').disabled = page + (twoUp() ? 2 : 1) > it.pages;
    root.querySelectorAll('#strip button').forEach((b) => b.classList.toggle('on', show.includes(+b.dataset.p)));
    root.dispatchEvent(new CustomEvent('pagechange', { detail: { page, show, pages: it.pages }, bubbles: true }));
    const cs = show.map(load);
    const g = ++gen;
    const swap = () => { if (g === gen) put(row, show, cs, big); };
    // the old page stays until the new picture is decoded (a slow one shows anyway after 3 s)
    if (cs.every((c) => c.done)) swap();
    else Promise.race([Promise.all(cs.map((c) => c.ready)), new Promise((r) => setTimeout(r, 3000))]).then(swap);
    preload(show);
  };
  const put = (row, show, cs, big) => {
    layers.forEach((l) => l.destroy());
    layers = [];
    pages.classList.toggle('zoomed', big);
    // zoomed: the page keeps its shape and grows in both directions (height = zoom × screen height)
    const fitH = pages.clientHeight - 16;
    row.style.height = '';
    row.dataset.h = big ? Math.round(fitH * zoom) : '';
    row.replaceChildren(...show.map((p, i) => {
      const w = document.createElement('div');
      w.className = 'page'; w.dataset.p = p;
      const img = cs[i].im;
      img.alt = `Page ${p} of ${it.title}`;
      w.append(img);
      return w;
    }));
    row.querySelectorAll('.page').forEach((w) => {
      const img = w.querySelector('img');
      // size the page box to the page's own shape, so the picture fills it with no empty band
      const size = () => {
        const ratio = img.naturalWidth ? img.naturalWidth / img.naturalHeight : 850 / 1100;
        w.style.aspectRatio = String(ratio);
        if (row.dataset.h) { w.style.height = row.dataset.h + 'px'; w.style.width = ''; return; }
        // iPad / iPhone: the whole room inside .pages (no padding there: the page goes edge to edge); Mac: as before
        const n = show.length, touch = isTouch(), cs = getComputedStyle(pages);
        const gap = touch ? parseFloat(getComputedStyle(row).columnGap) || 0 : 4;
        const H = pages.clientHeight - (touch ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 8);
        const W = (pages.clientWidth - (touch ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 12) - gap * (n - 1)) / n;
        const h = Math.min(H, W / ratio);
        w.style.height = h + 'px';
        w.style.width = h * ratio + 'px';
      };
      size();
      const mk = () => { if (!w.isConnected) return; size(); const l = new InkLayer(w, it.id, +w.dataset.p); l.setTool(tool); layers.push(l); };
      img.complete ? mk() : img.addEventListener('load', mk, { once: true });
    });
  };
  const step = () => (twoUp() ? 2 : 1);
  const next = () => { if (page + step() <= it.pages) { page += step(); draw(); } else onEnd?.(); };
  const prev = () => { if (page > 1) { page = Math.max(1, page - step()); draw(); } };
  root.querySelector('.turn-strip.prev').onclick = prev;
  root.querySelector('.turn-strip.next').onclick = next;

  $('#strip', root)?.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { page = +b.dataset.p; draw(); } });

  // click / tap to turn: see below; swipe works too
  // (when zoomed in, dragging moves around the page instead of turning it)
  let sx = null, sy = 0;
  let pan = null;
  pages.addEventListener('pointerdown', (e) => {
    if (tool) { sx = null; return; }
    sx = e.clientX; sy = e.clientY;
    if (e.pointerType === 'mouse' && pages.classList.contains('zoomed') && !e.target.closest('button')) {
      pan = { x: e.clientX, y: e.clientY, l: pages.scrollLeft, t: pages.scrollTop };
      pages.classList.add('panning');
    }
  });
  pages.addEventListener('pointermove', (e) => {
    if (!pan) return;
    pages.scrollLeft = pan.l - (e.clientX - pan.x);
    pages.scrollTop = pan.t - (e.clientY - pan.y);
  });
  const endPan = () => { pan = null; pages.classList.remove('panning'); };
  pages.addEventListener('pointerleave', endPan);
  document.addEventListener('pointerup', endPan);
  pages.addEventListener('pointerup', (e) => {
    if (sx === null || tool) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (e.target.closest('button')) return;
    const zoomed = pages.classList.contains('zoomed');
    if (!zoomed && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : prev();
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      // one page: left half ← / right half →. Two pages: outer half of the left page ←, outer half of the right page →
      const shown = [...pages.querySelectorAll('.page')];
      const hit = e.target.closest('.page');
      if (shown.length === 1 || !hit) {
        const r = (hit || pages).getBoundingClientRect();
        e.clientX - r.left < r.width / 2 ? prev() : next();
        return;
      }
      const r = hit.getBoundingClientRect(), leftHalf = e.clientX - r.left < r.width / 2;
      if (hit === shown[0] && leftHalf) prev();
      if (hit === shown[shown.length - 1] && !leftHalf) next();
    }
  });
  // iPad / iPhone, view mode: swipe up or down = back to the library (left / right turn pages, above)
  const offSwipe = attachSwipe(pages, { onDown: backToLibrary, canStart: () => !tool && !pages.classList.contains('zoomed') });
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
    setTool(t) { tool = t; layers.forEach((l) => l.setTool(t)); pages.classList.toggle('inking', !!t); },
    undo() { layers.at(-1)?.undo(); },
    clear() { layers.forEach((l) => l.clear()); },
    goTo(p) { page = p; draw(); },
    redraw() { draw(); },
    zoomReset() { this.zoomTo(levels()[0]); },
    zoomTo(z) { zoom = z; store.update(it.id, { zoom }); pages.scrollTo({ top: 0, left: 0 }); draw(); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); },
    zoomBy(d) {
      const L = levels();
      const i = Math.max(0, Math.min(L.length - 1, L.indexOf(zoom) + d));
      if (L[i] === zoom) return;
      this.zoomTo(L[i]);
    },
    get zoomLabel() { return zoom === 'two' ? '50%' : `${Math.round((zoom / 1.5) * 100)}%`; },
    destroy() { document.removeEventListener('keydown', onKey); ro.disconnect(); offSwipe(); layers.forEach((l) => l.destroy()); },
  };
}

export function sheetToolbar(bar, it, view) {
  bar.innerHTML = `
    <span class="pageno" id="pageno"></span>
    <div class="stepper zoom" aria-label="Zoom"><button id="sv-zout" aria-label="Zoom out" title="Zoom out (−)">${iconOn('zoomout')}</button><button id="sv-zreset" class="zreset" title="Reset zoom (0)">${view.zoomLabel}</button><button id="sv-zin" aria-label="Zoom in" title="Zoom in (+)">${iconOn('zoomin')}</button></div>
    <button class="icon-btn ink-toggle" id="sv-ink" title="Annotate" aria-label="Annotate">${iconOn('write')}</button>`;
  $('#sv-ink', bar).onclick = () => startInk(view, document.querySelector('.viewer'));
  const lab = () => ($('#sv-zreset', bar).textContent = view.zoomLabel);
  $('#sv-zout', bar).onclick = () => { view.zoomBy(-1); lab(); };
  $('#sv-zin', bar).onclick = () => { view.zoomBy(1); lab(); };
  $('#sv-zreset', bar).onclick = () => { view.zoomReset(); lab(); };
  bar.closest('.viewer')?.addEventListener('zoomchange', lab);
}

// the Annotate button toggles: first click opens the pen bar, second click closes it
export function startInk(view, host) {
  const open = host.querySelector('.inkbar') || host.closest('.viewer')?.querySelector('.inkbar');
  if (open) { view.setTool(null); open.remove(); document.querySelectorAll('.ink-toggle').forEach((b) => b.classList.remove('on')); return; }
  document.querySelectorAll('.ink-toggle').forEach((b) => b.classList.add('on'));
  view.setTool('blue');
  const tb = inkToolbar((t) => view.setTool(t), (a) => {
    if (a === 'undo') view.undo();
    if (a === 'clear') view.clear();
    if (a === 'done') { view.setTool(null); tb.remove(); document.querySelectorAll('.ink-toggle').forEach((b) => b.classList.remove('on')); toast('Annotations saved'); }
  });
  // sits in the top band, next to the Annotate button
  const top = host.querySelector('.item-top');
  if (top) top.querySelector('#it-more').before(tb); else host.append(tb);
}

export function sheetExtraMenu(it, view) {
  return [
    { label: 'Split…', icon: 'split', run: () => splitAt(it, view.page) },
    { label: 'Join…', icon: 'merge', run: () => mergeInto(it) },
    ...(store.mode === 'server' ? [{ label: 'Make a score (beta)…', icon: 'wave', run: () => makeScore(it) }] : []),
    ...bookToggle(it),
  ];
}

async function splitAt(it, page) {
  if (page <= 1) return toast('Go to the page where the new sheet should start.');
  const fallback = `${it.title} (part 2)`;
  let title = fallback;
  if (store.mode === 'server') { // the new sheet's title, read off its first page (you can change it)
    title = await new Promise((resolve) => {
      let answered = false;
      const s = modal(`<h2>${esc(`Split “${it.title}” at page ${page}?`)}</h2><p class="muted">${esc(`Pages ${page}–${it.pages} become a new sheet.`)}</p>
        <form><label class="field">New sheet's title <input id="sp-title" value="${esc(fallback)}"><small class="bs-det muted" id="sp-det"></small></label>
        <div class="modal-actions"><button type="button" data-close>Cancel</button><button class="primary" data-ok>Split</button></div></form>`,
      { onClose: () => { if (!answered) resolve(null); } });
      const inp = $('#sp-title', s.el);
      titleBox(inp, $('#sp-det', s.el), it.id, fallback, it.updatedAt || 0)(page);
      s.el.querySelector('form').onsubmit = (e) => { e.preventDefault(); answered = true; s.close(); resolve(inp.value.trim() || fallback); };
    });
    if (title == null) return;
  } else {
    const ok = await confirmSheet({ title: `Split “${it.title}” at page ${page}?`, body: `Pages ${page}–${it.pages} become a new sheet.`, ok: 'Split' });
    if (!ok) return;
  }
  if (store.mode === 'server') { // move the real page photos
    const res = await fetch(`/api/items/${it.id}/split`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, pages: Array.from({ length: it.pages - page + 1 }, (_, k) => page + k) }) });
    const d = await res.json();
    if (!res.ok) return toast(d.detail || 'Could not split');
    store.putItem(d.item); store.putItem(d.new);
    return toast('Split into two sheets', { label: 'Open new', run: () => go(`#/item/${d.new.id}`) });
  }
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
    if (store.mode === 'server') {
      fetch(`/api/items/${it.id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ other: o.id }) })
        .then(async (res) => { const d = await res.json(); if (!res.ok) return toast(d.detail || 'Could not join'); store.putItem(d.item); o.deleted = true; store.putItem({ ...o, deleted: true, pages: 0 }); s.close(); toast(`Joined — now ${d.item.pages} pages`); });
      return;
    }
    store.update(it.id, { pages: it.pages + o.pages, tags: [...new Set([...it.tags, ...o.tags])] });
    store.purge(o.id);
    s.close();
    toast(`Merged — now ${it.pages} pages`);
  };
}

// photo → score (beta): the Mac reads the notes, chord names and words; unsure bars are marked "check"
async function makeScore(it) {
  const ok = await confirmSheet({ title: `Make a score from “${it.title}”?`, body: `Beta. The Mac reads all ${it.pages} page${it.pages > 1 ? 's' : ''} (about 20 s a page). The new score is its own entry; bars it isn't sure about are marked “check” in red.`, ok: 'Make score' });
  if (!ok) return;
  store.addJob({ kind: 'omr', title: it.title, source: `From the sheet “${it.title}”`, output: 'Score (beta)', outputs: ['original'], fromItemId: it.id, artist: it.artist || '' });
  toast('Reading the sheet…', { label: 'Progress', run: () => go('#/jobs') });
}
