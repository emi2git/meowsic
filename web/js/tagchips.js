// Tags on an entry form: only the chosen tags, as removable chips, plus "+ Tag" (search the existing tags,
// or "Create “…”" a new one). suggestTags picks the chips to start with, from the library itself.
import { esc } from './ui.js';

export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const VI = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
// tags about one copy (its arrangement, state or where it came from), never carried over from another copy of the song
const COPY_TAGS = new Set(['super easy', 'original', 'from a sheet', 'verified', 'never printed', 'piano book', 'duet', 'easy', 'simple']);

// "Les Misérables - One Day More", "One Day More (Les Misérables)" -> ['les miserables one day more', 'les miserables', 'one day more']
function titleParts(t) {
  const parts = [fold(t), ...String(t || '').split(/\s[-–—:|]\s|[()[\]]/).map(fold)];
  return [...new Set(parts.filter((p) => p.length >= 3))];
}
const sameSong = (a, b) => { const pa = titleParts(a); return titleParts(b).some((p) => pa.includes(p)); };
const hasPhrase = (hay, t) => t.length >= 3 && new RegExp(`(^| )${t}s?( |$)`).test(hay); // (folded: only a-z 0-9 and spaces)

/** Tags to start a new entry with: existing tags only, plus at most one or two obvious new ones.
 *  song: {title, artist, album, source, id}; items: the library; vocab: every tag name; counts: Map tag -> uses. */
export function suggestTags(song, items, vocab, counts = new Map()) {
  const byFold = new Map(vocab.map((t) => [fold(t), t]));
  const out = [], fresh = [];
  const add = (t) => { if (t && !out.includes(t)) out.push(t); };
  // 1. the same song elsewhere in the library: its tags (not the per-copy ones), and its album
  const same = items.filter((x) => x.id !== song.id && !x.deleted && sameSong(song.title, x.title));
  const seen = new Map();
  for (const x of same) for (const t of x.tags || []) if (!COPY_TAGS.has(fold(t))) seen.set(t, (seen.get(t) || 0) + 1);
  [...seen].sort((a, b) => b[1] - a[1] || (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0)).forEach(([t]) => add(t));
  const album = song.album || same.map((x) => x.album).find(Boolean) || '';
  // 2. the show / film / album / artist named in the song: an existing tag that appears as a phrase there
  const hay = fold([song.title, song.artist, album].join(' '));
  for (const [f, t] of byFold) if (!COPY_TAGS.has(f) && hasPhrase(hay, f)) add(t);
  // 3. language: Vietnamese (hopamchuan, accents) or English
  const vi = song.source === 'hopamchuan' || VI.test(`${song.title} ${song.artist}`);
  const lang = vi ? 'Vietnamese' : song.source === 'ultimate-guitar' || /^[\x00-\x7f]*$/.test(song.title || '') ? 'English' : '';
  if (lang) { if (byFold.has(fold(lang))) add(byFold.get(fold(lang))); else fresh.push(lang); }
  // an album shared by several library items with no tag of its own yet: an obvious new tag
  if (album && !byFold.has(fold(album)) && items.filter((x) => fold(x.album) === fold(album)).length >= 2) fresh.push(album);
  return [...out.slice(0, 6), ...fresh.slice(0, 2)];
}

/** Chips for the chosen tags + "+ Tag". all: existing tag names (most used first); onChange(tags). */
export function tagChips(all, selected, onChange) {
  let sel = [...selected], open = false, q = '';
  const box = document.createElement('div');
  box.className = 'tagchips';
  const matches = () => {
    const f = fold(q);
    return all.filter((t) => !sel.includes(t) && (!f || fold(t).includes(f))).slice(0, 8);
  };
  const exact = () => q.trim() && [...all, ...sel].some((t) => fold(t) === fold(q));
  const list = () => `${matches().map((t) => `<button type="button" class="tc-opt" data-add="${esc(t)}">${esc(t)}</button>`).join('')}
    ${q.trim() && !exact() ? `<button type="button" class="tc-opt tc-new" data-add="${esc(q.trim())}">Create “${esc(q.trim())}”</button>` : ''}
    ${!matches().length && !q.trim() ? '<p class="muted small">No other tags yet. Type a name to make one.</p>' : ''}`;
  const draw = () => {
    box.innerHTML = `<div class="tc-row">${sel.map((t) => `<span class="tc-chip" data-t="${esc(t)}">${esc(t)}<button type="button" class="tc-x" data-del="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}
      ${open ? '' : `<button type="button" class="tc-add" aria-label="Add a tag">+ Tag</button>`}</div>
      ${open ? `<div class="tc-pick"><div class="tc-search"><input type="search" class="tc-q" placeholder="Find or make a tag" aria-label="Find or make a tag" value="${esc(q)}" autocomplete="off" enterkeyhint="done"><button type="button" class="tc-done">Done</button></div><div class="tc-list">${list()}</div></div>` : ''}`;
    if (open) { const i = box.querySelector('.tc-q'); i.focus(); i.setSelectionRange(q.length, q.length); }
  };
  const set = (v) => { sel = v; onChange([...sel]); };
  box.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]'), a = e.target.closest('[data-add]');
    if (d) { set(sel.filter((t) => t !== d.dataset.del)); draw(); }
    else if (a) { const t = all.find((x) => fold(x) === fold(a.dataset.add)) || a.dataset.add; if (!sel.includes(t)) set([...sel, t]); q = ''; draw(); }
    else if (e.target.closest('.tc-add')) { open = true; q = ''; draw(); }
    else if (e.target.closest('.tc-done')) { open = false; q = ''; draw(); }
  });
  box.addEventListener('input', (e) => { if (!e.target.matches('.tc-q')) return; q = e.target.value; box.querySelector('.tc-list').innerHTML = list(); });
  box.addEventListener('keydown', (e) => {
    if (!e.target.matches('.tc-q')) return;
    if (e.key === 'Enter') { e.preventDefault(); const first = box.querySelector('.tc-list [data-add]'); if (first && q.trim()) first.click(); else { open = false; draw(); } }
    if (e.key === 'Escape') { e.stopPropagation(); open = false; q = ''; draw(); }
  });
  draw();
  return box;
}
