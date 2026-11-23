// Song title read off a sheet page by the Mac (Apple Vision: the biggest text at the top of the page).
// GET /api/items/{id}/pages/{n}/title → { title, confidence 0..1, alts }.
const cache = new Map();
export const MIN_CONFIDENCE = 0.5;

export function detectTitle(itemId, page, ver = 0) {
  const k = `${itemId}:${page}:${ver}`;
  if (!cache.has(k)) {
    cache.set(k, fetch(`/api/items/${encodeURIComponent(itemId)}/pages/${page}/title`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => (d && d.title && d.confidence >= MIN_CONFIDENCE ? d.title : null)));
  }
  return cache.get(k);
}

// A title box in a Split dialog: fill it from `page` (again when the page changes), unless you typed in it.
// `fallback` is the old default ("<title> (part 2)"), kept when the title can't be read.
export function titleBox(input, hint, itemId, fallback, ver = 0) {
  let typed = false, want = 0;
  input.addEventListener('input', () => { typed = true; hint.textContent = ''; hint.dataset.state = ''; });
  return async (page) => {
    if (typed) return;
    const n = ++want;
    hint.textContent = 'Reading the title…'; hint.dataset.state = 'busy';
    const t = await detectTitle(itemId, page, ver);
    if (typed || n !== want) return;
    input.value = t || fallback;
    hint.textContent = t ? `detected on page ${page}` : 'couldn’t read the title';
    hint.dataset.state = t ? 'ok' : 'fail';
  };
}
