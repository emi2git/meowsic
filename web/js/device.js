// Which device is this? The one place that decides; JS imports from here, CSS reads
// <html data-device="phone|tablet|desktop"> (kept up to date on rotation / resize / pointer change).
//
//   desktop  Mac browser: mouse / trackpad (no coarse pointer)
//   tablet   iPad: touch, wider than 760px
//   phone    iPhone: touch, 760px wide or less
//
// What each one gets:
//   touch (tablet + phone)  no left bar in the item and Clean up views (‹ Back instead); swipes and
//                           taps on the page halves instead of the ‹ › strips; pages edge to edge;
//                           a score's zoom is kept on this device only; Select button and press-and-
//                           hold to select in the library; no keyboard hints; fewer library columns
//   tablet (iPad)           portrait score: the controls get their own row
//   phone (iPhone)          one-row sheet toolbar (Back, title, page, pen, ⋯)
//   narrow (≤760px, any device, so also a narrow Mac window)  tab bar instead of the left bar,
//                           smaller default score zoom, wrapped toolbars, one-column lists
//   desktop (Mac)           left bar everywhere, keyboard shortcuts, two-page spreads in a wide
//                           window, ‹ › side strips, score zoom saved on the entry
export const PHONE_MAX = 760;

const coarse = matchMedia('(pointer: coarse)');
const narrowQ = matchMedia(`(max-width: ${PHONE_MAX}px)`);

export const isTouch = () => coarse.matches;
export const isNarrow = () => narrowQ.matches;
export const isPhone = () => isTouch() && isNarrow();
export const isTablet = () => isTouch() && !isNarrow();
export const isDesktop = () => !isTouch();
export const device = () => (!isTouch() ? 'desktop' : isNarrow() ? 'phone' : 'tablet');

// fn({ device, narrow }) runs when the device class or the narrow flag changes; returns an unsubscribe
const subs = new Set();
export function onDeviceChange(fn) { subs.add(fn); return () => subs.delete(fn); }

let last = '';
function update() {
  const d = device(), key = d + (isNarrow() ? ' narrow' : '');
  document.documentElement.dataset.device = d;
  if (key === last) return;
  const first = !last;
  last = key;
  if (!first) subs.forEach((fn) => fn({ device: d, narrow: isNarrow() }));
}
update();
coarse.addEventListener('change', update);
narrowQ.addEventListener('change', update);
addEventListener('resize', update);
addEventListener('orientationchange', update);
