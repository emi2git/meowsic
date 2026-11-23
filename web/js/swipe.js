// iPad / iPhone swipes for the item views (touch events: the browser claims vertical pans, so
// pointerup never arrives for them). Left = forward, right = back, up = back to the library,
// down = `onDown` (sheets and books: back to the library too; nothing by default).
// `canStart()` says whether a swipe may begin (not zoomed, not inking, not editing, …).
// `upAtEnd`: a scrolling view only goes back on a swipe up when it was already at the bottom
// (or does not scroll) when the finger went down, so ordinary scrolling still works.
import { isTouch } from './device.js';

export function backToLibrary() {
  if (history.length > 1) history.back(); else location.hash = '#/library?kind=sheet';
}

export function attachSwipe(el, { onLeft, onRight, onUp = backToLibrary, onDown, canStart = () => true, scroller = null, upAtEnd = false }) {
  if (!isTouch()) return () => {};
  let ts = null;
  const atEnd = () => { const s = scroller?.(); return !s || s.scrollHeight - s.clientHeight - s.scrollTop < 4; };
  const wide = () => { const s = scroller?.(); return s && s.scrollWidth > s.clientWidth + 4; };
  const start = (e) => {
    ts = e.touches.length === 1 && (visualViewport?.scale || 1) < 1.05 && canStart(e)
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), end: atEnd() } : null;
  };
  const move = (e) => { if (e.touches.length > 1) ts = null; };
  const end = (e) => {
    if (!ts) return;
    const s = ts; ts = null;
    if (!canStart(e)) return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Date.now() - s.t > 800) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && !wide()) return dx < 0 ? onLeft?.() : onRight?.();
    if (dy < -90 && Math.abs(dy) > 2 * Math.abs(dx) && (!upAtEnd || s.end)) return onUp?.();
    if (dy > 90 && Math.abs(dy) > 2 * Math.abs(dx)) onDown?.();
  };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: true });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end); };
}

// a vertically scrolling view: one "page" = the visible height, less a little overlap
export function flipBy(scroller, dir) {
  if (!scroller) return;
  scroller.scrollBy({ top: dir * Math.max(80, scroller.clientHeight - 60), behavior: 'smooth' });
}
