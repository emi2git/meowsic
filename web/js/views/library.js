// Library: every sheet, chord chart and score in one list.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, menu, KIND, CAT } from '../ui.js';
import { go, addMenu } from '../app.js';
import { itemMenu, editTags, binItems, keyShort } from './actions.js';
import { autoTag } from './autotag.js';
import { VERSIONS } from '../musicxml.js';

const SORTS = {
  added: ['Recently added', (a, b) => b.createdAt - a.createdAt],
  title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
  played: ['Recently played', (a, b) => store.lastPlayed(b.id) - store.lastPlayed(a.id)],
  most: ['Most played', (a, b) => store.playCount(b.id) - store.playCount(a.id)],
  artist: ['Artist A–Z', (a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title)],
  kind: ['Type', (a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)],
  pages: ['Pages', (a, b) => (a.pages || 0) - (b.pages || 0) || a.title.localeCompare(b.title)],
  key: ['Key', (a, b) => (a.key || '').localeCompare(b.key || '') || a.title.localeCompare(b.title)],
  version: ['Version', (a, b) => (VERSIONS[a.version] || '').localeCompare(VERSIONS[b.version] || '') || a.title.localeCompare(b.title)],
  tag: ['Tag', (a, b) => (mainTag(a) || '\uffff').localeCompare(mainTag(b) || '\uffff') || a.title.localeCompare(b.title)],
};
// table columns (Mac / iPad); clicking a heading sorts, clicking it again reverses
// [sort key, heading, class]. Type is left out when a type is already picked in the left bar.
// columns per view: [sort key, heading, class]
const C = { title: ['title', 'Title', 'c-title'], artist: ['artist', 'Artist', 'c-artist'], type: ['kind', 'Type', 'c-type'], version: ['version', 'Version', 'c-ver'],
  tag: ['tag', 'Tag', 'c-tag'], pages: ['pages', 'Pages', 'c-pages'], key: ['key', 'Key', 'c-key'], added: ['added', 'Added', 'c-when'] };
const COLS_BY = {
  '': [C.title, C.artist, C.type, C.tag, C.added],
  sheet: [C.title, C.artist, C.tag, C.pages, C.added],
  chords: [C.title, C.artist, C.tag, C.key, C.added],
  score: [C.title, C.artist, C.version, C.tag, C.key, C.added],
};
// The one tag worth showing in the list: the most specific one (a musical, a movie, a set like
// "Piano recital"), not genre, language or version tags.
const GENERIC = new Set(['Musical', 'Disney', 'Movie', 'Anime', 'Pop', 'Rock', 'Ballad', 'Jazz', 'Folk', 'Country', 'Classical', 'Christmas', 'Children',
  'English', 'Vietnamese', 'Chinese', 'Russian', 'Korea', 'Japan', 'Singapore', 'Original', 'Piano + vocals', 'Lead sheet', 'Piano duet',
  'Piano accompaniment', 'Piano easy', 'Piano pro', 'Printed', 'Never printed']);
export const mainTag = (it) => it.tags.find((t) => !GENERIC.has(t)) || '';
const PAGE = 50; // rows per page
const state = { q: '', sort: 'added', dir: 1, select: false, sel: new Set(), page: 1, anchor: null };
try { state.sort = localStorage.getItem('meowsic-sort') || 'added'; } catch {}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

export function libraryView(main, { q }) {
  const kind = q.get('kind') || '';
  // several tags can be on; an item must have all of them
  const tags = (q.get('tags') || q.get('tag') || '').split(',').filter(Boolean);
  const setTags = (list) => { const p = new URLSearchParams(q); p.delete('tag'); list.length ? p.set('tags', list.join(',')) : p.delete('tags'); go('#/library' + (p.toString() ? '?' + p : '')); };
  const setQ = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); go('#/library' + (p.toString() ? '?' + p : '')); };

  state.select = false; state.sel.clear(); state.anchor = null;
  main.innerHTML = `
    <header class="top lib-top selband" id="selband" hidden></header>
    <header class="top lib-top" id="libhead">
      <h1>${kind ? KIND[kind].plural : 'All music'}</h1>
      <div class="seg phone-only" role="tablist">${[['', 'All'], ['sheet', 'Sheets'], ['chords', 'Chords'], ['score', 'Scores']].map(([k, l]) =>
        `<button role="tab" class="${kind === k ? 'on' : ''}" data-kind="${k}">${k ? icon(KIND[k].icon) : ''}${l}</button>`).join('')}</div>
      ${tags.map((t) => `<span class="tag-on">${esc(t)}<button class="x" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}" title="Remove">×</button></span>`).join('')}
      ${tags.length > 1 ? `<button class="link clear-tags" id="lib-tags-clear">Clear all</button>` : ''}
      ${tags.length ? `<a class="icon-btn btn" href="#/print?tags=${encodeURIComponent(tags.join(','))}">Print all</a>` : ''}
      
      <button class="chip-btn" id="lib-sort" hidden aria-haspopup="menu">Sort: ${SORTS[state.sort][0]} ▾</button>
    
      <label class="search">${icon('search')}<input type="search" id="lib-q" placeholder="Search titles, artists, tags" value="${esc(state.q)}" aria-label="Search"></label>
      <button class="icon-btn tag-btn ${tags.length ? 'on' : ''}" id="lib-tag" title="Filter by tag" aria-label="Filter by tag">${iconOn('tag')}</button>
      <button class="icon-btn touch-only" id="lib-select">Select</button>
    </header>

    <div id="lib-rows"></div>`;
  let shownList = [];

  const draw = () => {
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    let list = store.items().filter((it) => (!kind || it.kind === kind) && tags.every((t) => it.tags.includes(t)));
    if (words.length) list = list.filter((it) => { const hay = fold([it.title, it.artist, ...it.tags, KIND[it.kind].label].join(' ')); return words.every((w) => hay.includes(w)); });
    list.sort(SORTS[state.sort][1]);
    if (state.dir < 0) list.reverse();
    const rows = $('#lib-rows', main);
    if (!list.length) {
      const away = store.mode === 'offline' && !store.items().length;
      rows.innerHTML = `<ul class="rows"><li class="empty">${CAT}<p>${away ? 'Meowsic can’t reach the Mac. Check that the Mac is on and on the same Wi-Fi.' : state.q || tags.length ? 'No music matches.' : 'Nothing here yet.'}</p>${state.q || tags.length || away ? '' : '<button class="primary" id="empty-add">Add music</button>'}</li></ul>`;
      $('#empty-add', main)?.addEventListener('click', (e) => addMenu(e.currentTarget));
    } else {
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      state.page = Math.min(Math.max(1, state.page), pages);
      shownList = list.slice((state.page - 1) * PAGE, state.page * PAGE);
      const more = pager(state.page, pages);
      const cnt = `${list.length} item${list.length === 1 ? '' : 's'}`;
      {
        // ▲ = A→Z / oldest first, ▼ = Z→A / newest first; Added starts newest first
        const arrow = (k) => (state.sort !== k ? '' : (k === 'added') === (state.dir > 0) ? ' ▼' : ' ▲');
        const cols = COLS_BY[kind] || COLS_BY[''];
        const cell = {
          'c-title': (it) => esc(it.title), 'c-artist': (it) => esc(it.artist || ''), 'c-type': (it) => badge(it.kind), 'c-ver': (it) => esc(VERSIONS[it.version] || ''),
          'c-tag': (it) => (mainTag(it) ? `<span class="tagchip">${esc(mainTag(it))}</span>` : ''), 'c-pages': (it) => it.pages || '', 'c-key': (it) => esc(keyShort(it.key)), 'c-when': (it) => ago(it.createdAt),
        };
        rows.innerHTML = `<table class="lib-table ${kind ? 'one-kind' : ''} ${selecting() ? 'selecting' : ''}"><thead><tr><th class="c-pick"></th>${cols.map(([k, l, c]) =>
          `<th class="${c}">${k ? `<button class="th-sort ${state.sort === k ? 'on' : ''}" data-sort="${k}">${l}${arrow(k)}</button>` : l}</th>`).join('')}<th class="c-more"></th></tr></thead><tbody>${shownList.map((it) => `
          <tr class="row ${state.sel.has(it.id) ? 'sel' : ''}" data-id="${it.id}">
            <td class="c-pick"><label class="pick" title="Select (Shift-click for a range)"><input type="checkbox" ${state.sel.has(it.id) ? 'checked' : ''} aria-label="Select ${esc(it.title)}"></label></td>
            ${cols.map(([, , c]) => `<td class="${c}${c === 'c-title' ? ' row-title' : ''}">${cell[c](it)}</td>`).join('')}
            <td class="c-more"><button class="icon-btn row-more" aria-label="More for ${esc(it.title)}" title="More">${iconOn('more')}</button></td>
          </tr>`).join('')}</tbody></table><div class="pager-row"><span class="muted">${cnt}</span>${more}</div>`;
        rows.querySelector('.pager')?.addEventListener('click', (e) => { const b = e.target.closest('[data-pg]'); if (b && !b.disabled) { state.page = +b.dataset.pg; draw(); main.scrollTo({ top: 0 }); } });
        rows.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
          const k = b.dataset.sort;
          state.dir = state.sort === k ? -state.dir : 1;
          state.sort = k;
          try { localStorage.setItem('meowsic-sort', k); } catch {}
          draw();
        }));
      }
    }
    drawSelbar(list);
  };

  const selecting = () => state.select || state.sel.size > 0;
  const drawSelbar = (list) => {
    const band = $('#selband', main), head = $('#libhead', main);
    const on = selecting();
    band.hidden = !on; head.hidden = on;
    if (!on) return;
    const ids = [...state.sel], n = ids.length;
    const all = n && list.every((x) => state.sel.has(x.id));
    band.innerHTML = `
      <label class="pick all" title="Select all"><input type="checkbox" id="sb-all" ${all ? 'checked' : ''} aria-label="Select all"></label>
      <b class="sel-count">${n ? `${n} selected` : 'Select items'}</b>
      <span class="grow"></span>
      <button ${n ? '' : 'disabled'} id="sb-tag">Edit tags</button>
      ${store.mode === 'server' ? `<button ${n ? '' : 'disabled'} id="sb-auto">Auto-tag</button>` : ''}
      <button ${n ? '' : 'disabled'} id="sb-print">Print</button>
      <button ${n ? '' : 'disabled'} class="danger-text" id="sb-bin">Move to Trash</button>
      <button class="icon-btn" id="sb-done">Cancel</button>`;
    const box = $('#sb-all', band);
    box.indeterminate = n > 0 && !all;
    box.onchange = () => { if (all) state.sel.clear(); else list.forEach((x) => state.sel.add(x.id)); draw(); };
    $('#sb-tag', band).onclick = () => editTags(ids);
    $('#sb-auto', band)?.addEventListener('click', () => autoTag(ids));
    $('#sb-print', band).onclick = () => go(`#/print?items=${ids.join(',')}`);
    $('#sb-bin', band).onclick = () => { binItems(ids); state.sel.clear(); state.select = false; draw(); };
    $('#sb-done', band).onclick = () => { state.select = false; state.sel.clear(); draw(); };
  };

  // toggle one row; Shift extends from the last row clicked
  const toggle = (id, shift) => {
    const idx = shownList.findIndex((x) => x.id === id);
    const a = shownList.findIndex((x) => x.id === state.anchor);
    if (shift && a >= 0) {
      const on = !state.sel.has(id) || true;
      for (let i = Math.min(a, idx); i <= Math.max(a, idx); i++) on ? state.sel.add(shownList[i].id) : state.sel.delete(shownList[i].id);
    } else state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
    state.anchor = id;
    draw();
  };

  main.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { state.page = 1; setQ('kind', b.dataset.kind); } };
  $('#lib-tag', main).onclick = (e) => tagFilter(e.currentTarget, tags, setTags);
  main.querySelectorAll('[data-untag]').forEach((b) => (b.onclick = () => setTags(tags.filter((t) => t !== b.dataset.untag))));
  $('#lib-tags-clear', main)?.addEventListener('click', () => setTags([]));
  $('#lib-sort', main).onclick = (e) => menu(e.currentTarget, Object.entries(SORTS).map(([k, [l]]) => ({
    label: (state.sort === k ? '✓ ' : '   ') + l,
    run: () => { state.sort = k; state.dir = 1; try { localStorage.setItem('meowsic-sort', k); } catch {} $('#lib-sort', main).textContent = `Sort: ${l} ▾`; draw(); },
  })));
  $('#lib-q', main).oninput = (e) => { state.q = e.target.value; state.page = 1; draw(); };
  $('#lib-select', main).onclick = () => { state.select = true; draw(); };
  const rowsEl = $('#lib-rows', main);
  let pressed = false;
  rowsEl.onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (pressed) { pressed = false; e.preventDefault(); return; }
    if (e.target.closest('.row-more')) return itemMenu(e.target.closest('.row-more'), id);
    if (e.target.closest('.pick')) { e.preventDefault(); return toggle(id, e.shiftKey); }
    if (selecting() || e.metaKey || e.ctrlKey || e.shiftKey) return toggle(id, e.shiftKey);
    go(`#/item/${id}`);
  };
  // press and hold a row (iPad / iPhone) to start selecting
  let holdT;
  rowsEl.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.pointerType === 'mouse' || e.target.closest('.row-more,.pick')) return;
    holdT = setTimeout(() => { pressed = true; state.select = true; state.sel.add(row.dataset.id); state.anchor = row.dataset.id; draw(); navigator.vibrate?.(10); }, 450);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => rowsEl.addEventListener(t, (e) => { if (t !== 'pointermove' || Math.abs(e.movementY) > 4) clearTimeout(holdT); }));
  rowsEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.row') && e.pointerType !== 'mouse' && matchMedia('(pointer: coarse)').matches) e.preventDefault(); });
  const onKey = (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#lib-q', main)?.focus(); }
    if (e.key === 'Escape' && selecting()) { state.select = false; state.sel.clear(); draw(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); shownList.forEach((x) => state.sel.add(x.id)); draw(); }
  };
  document.addEventListener('keydown', onKey);
  draw();
  const mq = matchMedia('(min-width: 761px)');
  mq.addEventListener('change', draw);
  const off = store.on(draw);
  return () => { off(); mq.removeEventListener('change', draw); document.removeEventListener('keydown', onKey); };
}

// tag filter: a list of checkboxes that stays open while you tick; live counts; Clear all
function tagFilter(anchor, current, apply) {
  document.querySelector('.tagpop')?.remove();
  const sel = new Set(current);
  const pop = document.createElement('div');
  pop.className = 'menu tagpop';
  const counts = store.tagCounts();
  const draw = () => {
    pop.innerHTML = `<div class="tagpop-head"><button class="link" data-clear ${sel.size ? '' : 'disabled'}>Clear all</button></div>
      <input type="search" class="tagpop-q" placeholder="Find a tag" aria-label="Find a tag">
      <div class="tagpop-list">${store.db.tags.slice().sort((a, b) => a.localeCompare(b)).map((t) =>
        `<label class="tagpop-row"><input type="checkbox" value="${esc(t)}" ${sel.has(t) ? 'checked' : ''}><span>${esc(t)}</span><i>${counts.get(t) || 0}</i></label>`).join('')}</div>
      <p class="muted small tagpop-foot">Shows music that has every ticked tag.</p>`;
  };
  draw();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  pop.addEventListener('change', (e) => { const v = e.target.value; e.target.checked ? sel.add(v) : sel.delete(v); apply([...sel]); });
  pop.addEventListener('click', (e) => { if (e.target.closest('[data-clear]')) { sel.clear(); pop.querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = false)); apply([]); } });
  pop.querySelector('.tagpop-q').oninput = (e) => { const f = e.target.value.toLowerCase(); pop.querySelectorAll('.tagpop-row').forEach((row) => (row.hidden = !row.textContent.toLowerCase().includes(f))); };
  const off = (e) => { if (!pop.contains(e.target) && !e.target.closest('#lib-tag')) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key); };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', key); });
  pop.querySelector('.tagpop-q').focus();
}

// « ‹ 1 … 4 [5] 6 … 12 › »  — First, previous, a window of page numbers, next, Last
function pager(page, pages) {
  if (pages <= 1) return '';
  const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  if (page <= 3) [2, 3, 4].forEach((n) => n <= pages && nums.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => n >= 1 && nums.add(n));
  const sorted = [...nums].sort((a, b) => a - b);
  let html = '', prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) html += '<span class="pg-gap">…</span>';
    html += `<button data-pg="${n}" class="${n === page ? 'on' : ''}" ${n === page ? 'aria-current="page"' : ''}>${n}</button>`;
    prev = n;
  }
  return `<nav class="pager" aria-label="Pages"><button data-pg="1" ${page === 1 ? 'disabled' : ''} title="First page">«</button><button data-pg="${page - 1}" ${page === 1 ? 'disabled' : ''} title="Previous page">‹</button>${html}<button data-pg="${page + 1}" ${page === pages ? 'disabled' : ''} title="Next page">›</button><button data-pg="${pages}" ${page === pages ? 'disabled' : ''} title="Last page">»</button></nav>`;
}
