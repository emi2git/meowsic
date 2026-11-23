// iPad / iPhone: scores and chord charts never scroll. Their content is cut into screen-high
// pages and shown one page at a time, like a sheet: swipe left / right (or tap the page's edge)
// turns, swipe up / down goes back to the library, arrows / page keys (pedals) turn too.
//
// The view keeps its whole content laid out in one long "sheet" element inside a fixed-height
// "clip" window; a page is the sheet moved up by the page's start, with the window cut just below
// the page's last line (so a half line from the next page never peeks in).
import { attachSwipe, backToLibrary } from './swipe.js';

// blocks: [{ top, bottom, keep? }] in sheet coordinates, top to bottom (keep = stay with the next
// block, e.g. a section heading). H: the page height. → [{ start, end, first, last }]
export function paginate(blocks, H, { origin = 0 } = {}) {
  const pages = [];
  let first = 0;
  const startOf = (i) => (i === 0 ? Math.min(origin, blocks[0].top) : blocks[i].top);
  for (let i = 1; i <= blocks.length; i++) {
    if (i < blocks.length && blocks[i].bottom - startOf(first) <= H) continue;
    let last = i - 1;
    // a heading at the bottom of a page goes over with its lines
    while (i < blocks.length && last > first && blocks[last].keep) last--;
    pages.push({ start: startOf(first), end: blocks[last].bottom, first, last });
    first = last + 1; i = first;
  }
  return pages.length ? pages : [{ start: 0, end: H, first: 0, last: -1 }];
}

// the page holding block i / coordinate y
export const pageOfBlock = (pages, i) => Math.max(0, pages.findIndex((p) => i >= p.first && i <= p.last));
export function pageOfY(pages, y) {
  for (let k = pages.length - 1; k >= 0; k--) if (y >= pages[k].start - 1) return k;
  return 0;
}

// show page k: move the sheet up, cut the window to the page's own height
export function showPage(sheet, clip, p) {
  sheet.style.transform = p.start ? `translateY(${-p.start}px)` : '';
  clip.style.height = Math.max(1, p.end - p.start) + 'px';
}

// gestures + keys for a paged view. edge: the share of the width at each side where a tap turns
// (0.5 = the whole left / right half, like a sheet). Returns an off() function.
export function pagerInput(el, { next, prev, canStart = () => true, edge = 0.5 }) {
  const offSwipe = attachSwipe(el, { onLeft: next, onRight: prev, onUp: backToLibrary, onDown: backToLibrary, canStart });
  let down = null;
  const pd = (e) => { down = e.button > 0 || !canStart(e) ? null : { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const pu = (e) => {
    const d = down; down = null;
    if (!d || e.target.closest('a,button,input,select,textarea,.playbar,.ink-text')) return;
    if (Math.abs(e.clientX - d.x) > 8 || Math.abs(e.clientY - d.y) > 8 || Date.now() - d.t > 500) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x < edge) { e.stopPropagation(); prev(); } else if (x > 1 - edge) { e.stopPropagation(); next(); }
  };
  const onKey = (e) => {
    if (e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['ArrowRight', 'PageDown', 'ArrowDown'].includes(e.key)) { e.preventDefault(); next(); }
    if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); prev(); }
  };
  el.addEventListener('pointerdown', pd);
  el.addEventListener('pointerup', pu, true);
  document.addEventListener('keydown', onKey);
  return () => { offSwipe(); el.removeEventListener('pointerdown', pd); el.removeEventListener('pointerup', pu, true); document.removeEventListener('keydown', onKey); };
}
