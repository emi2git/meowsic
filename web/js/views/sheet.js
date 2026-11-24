// Sheet viewer: page images with swipe / arrow / pedal turns, 1 or 2 pages, thumbnails, ink.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { sheetUrl } from '../sheet-art.js';
import { InkLayer, inkToolbar } from './annotate.js';
import { go } from '../app.js';
import { printEntry, download } from './actions.js';
import { attachSwipe, backToLibrary } from '../swipe.js';
import { isTouch, isDesktop } from '../device.js';
import { watchImage, markFailed } from '../conn.js';

// real sheets: the page files on the Mac; the UI preview draws mock pages
export const pageSrc = (it, p) => (it.pageFiles?.[p - 1] && store.pageUrl(it.id, p, it.updatedAt)) || (it.upload && store.sessionImage(`${it.id}:${p}`)) || sheetUrl(it.title, p, it.pages, { artist: it.artist });

export function sheetBody(root, it, { perform = false, onEnd } = {}) {
  let page = 1;
  let layers = [];
  let tool = null;

  root.innerHTML = `
    <div class="sheet-frame">
      <button class="turn-strip prev" aria-label="Previous page" title="Previous page">‹</button>
      <div class="pages ${perform ? 'perform' : ''}" id="pages" tabindex="-1"><div class="page-row" id="page-row"></div></div>
      <button class="turn-strip next" aria-label="Next page" title="Next page">›</button>
      <div class="page-dots" id="sv-dots" role="tablist" aria-label="Pages"></div>
    </div>`;

  // two pages side by side only in a Mac browser (mouse / trackpad and a wide window); iPad and iPhone show one
  const pages = $('#pages', root);
  // zoom: 100% = the page fits the frame (whole page visible): one page on iPad / iPhone, two side by
  // side on a Mac in a wide window. The steps scale that fitted size; bigger than 100% scrolls.
  // Kept per item on this device only (localStorage): a zoom picked on the Mac never makes the iPad
  // open overflowing. The old shared item.zoom (other scale, 100% = 1.5× the screen) is ignored.
  const canTwo = () => it.pages > 1 && isDesktop() && root.clientWidth > 900;
  const LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const zKey = `meowsic.sheetZoom.${it.id}`;
  let zoom = 1;
  try { const z = +localStorage.getItem(zKey); if (LEVELS.includes(z)) zoom = z; } catch {}
  const twoUp = () => canTwo();
  // room under the page for the page dots: Mac only (iPad / iPhone pages stay edge to edge, the
  // thin dots sit over the bottom margin of the page)
  const DOTS = it.pages > 1 && isDesktop() ? 14 : 0;
  const dots = $('#sv-dots', root);
  dots.onclick = (e) => { const d = e.target.closest('[data-p]'); if (d) { page = +d.dataset.p; draw(); } };

  // page pictures, loaded and decoded ahead (the pages next to the shown ones too), so a turn swaps
  // in a ready picture whose shape is known: the new page never shows at a wrong (bigger) size first
  const imgs = new Map(); // src -> { im, ready: Promise, done }
  const load = (p) => {
    const src = pageSrc(it, p);
    let c = imgs.get(src);
    if (!c) {
      const im = new Image();
      im.draggable = false;
      watchImage(im);
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
    const big = zoom > 1;
    if (dots.childElementCount !== (it.pages > 1 ? it.pages : 0)) dots.innerHTML = it.pages > 1 ? Array.from({ length: it.pages }, (_, k) => `<i data-p="${k + 1}" role="tab" aria-label="Page ${k + 1}"></i>`).join('') : '';
    [...dots.children].forEach((d) => { const on = show.includes(+d.dataset.p); d.classList.toggle('on', on); d.setAttribute('aria-selected', on); });
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
    // the room a fitted (100%) page gets, measured unzoomed: iPad / iPhone the whole room inside .pages
    // (no padding there: the page goes edge to edge); Mac: a small margin
    pages.classList.remove('zoomed');
    const touch = isTouch(), pcs = getComputedStyle(pages), n = show.length;
    const gap = touch ? parseFloat(getComputedStyle(row).columnGap) || 0 : 4;
    const room = {
      H: pages.clientHeight - (touch ? parseFloat(pcs.paddingTop) + parseFloat(pcs.paddingBottom) : 8) - DOTS,
      W: (pages.clientWidth - (touch ? parseFloat(pcs.paddingLeft) + parseFloat(pcs.paddingRight) : 12) - gap * (n - 1)) / n,
    };
    pages.classList.toggle('zoomed', big);
    row.style.height = '';
    row.replaceChildren(...show.map((p, i) => {
      const w = document.createElement('div');
      w.className = 'page'; w.dataset.p = p;
      const img = cs[i].im;
      img.alt = `Page ${p} of ${it.title}`;
      w.append(img);
      if (img.classList.contains('img-fail') || (img.complete && img.src && !img.naturalWidth)) markFailed(img); // failed before it was in the page
      return w;
    }));
    row.querySelectorAll('.page').forEach((w) => {
      const img = w.querySelector('img');
      // size the page box to the page's own shape, so the picture fills it with no empty band
      const size = () => {
        const ratio = img.naturalWidth ? img.naturalWidth / img.naturalHeight : 850 / 1100;
        w.style.aspectRatio = String(ratio);
        const h = Math.max(1, Math.min(room.H, room.W / ratio)) * zoom;
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
    zoomReset() { this.zoomTo(1); },
    zoomTo(z) { zoom = z; try { z === 1 ? localStorage.removeItem(zKey) : localStorage.setItem(zKey, z); } catch {} pages.scrollTo({ top: 0, left: 0 }); draw(); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); },
    zoomBy(d) {
      const i = Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(zoom) + d));
      if (LEVELS[i] === zoom) return;
      this.zoomTo(LEVELS[i]);
    },
    get zoom() { return zoom; },
    get zoomLabel() { return `${Math.round(zoom * 100)}%`; },
    destroy() { document.removeEventListener('keydown', onKey); ro.disconnect(); offSwipe(); layers.forEach((l) => l.destroy()); },
  };
}

export function sheetToolbar(bar, it, view) {
  bar.innerHTML = `
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

// the sheet's ⋯ tools (actions.viewerMenu). Pages — reorder, split, merge, delete, crop — are edited in one place,
// Manage library → Organize pages; Crop page… opens it on the crop of the page shown. Books are read-only PDFs:
// no page editing and no Make a score (Organize pages leaves them out).
export function sheetTools(it, view) {
  if (store.mode !== 'server' || it.book) return [];
  const org = `#/manage?id=${encodeURIComponent(it.id)}&back=item`;
  return [
    ...(it.pageFiles?.length ? [{ label: 'Edit pages…', icon: 'edit', run: () => go(org) },
      { label: 'Crop page…', icon: 'edit', run: () => go(`${org}&crop=${view?.page || 1}`) }] : []),
    { label: 'Make a score…', icon: 'wave', run: () => makeScore(it) },
  ];
}
// Export ▸ for a sheet or book: print (or save as PDF), the page shown as an image
export function sheetExports(it, view) {
  const p = view?.page || 1, f = it.pageFiles?.[p - 1];
  return [printEntry(it.id),
    ...(f ? [{ label: `Page ${p} as an image`, icon: 'download', run: () => download(`${it.title} - page ${p}${(f.match(/\.\w+$/) || ['.jpg'])[0]}`, { url: store.pageUrl(it.id, p, it.updatedAt) }) }] : [])];
}

// photo → score: the Mac reads the notes, chord names and words; unsure bars are marked "check"
async function makeScore(it) {
  const ok = await confirmSheet({ title: `Make a score from “${it.title}”?`, body: `The Mac reads all ${it.pages} page${it.pages > 1 ? 's' : ''} (about 20 s a page). The new score is its own entry; bars it isn't sure about are marked “check” in red.`, ok: 'Make score' });
  if (!ok) return;
  store.addJob({ kind: 'omr', title: it.title, source: `From the sheet “${it.title}”`, output: 'Score', outputs: ['original'], fromItemId: it.id, artist: it.artist || '' });
  toast('Reading the sheet…', { label: 'Progress', run: () => go('#/jobs') });
}
