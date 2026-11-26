// Library: every sheet, chord chart and score in one list.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, menu, KIND, kindOf, CAT } from '../ui.js';
import { go, addMenu } from '../app.js';
import { itemMenu, editTags, binItems, keyShort, verLabel, verDetail, versionMenu } from './actions.js';
import { autoTag } from './autotag.js';
import { VERSIONS } from '../musicxml.js';
import { isTouch, onDeviceChange } from '../device.js';
import { attachSwipe } from '../swipe.js';
import { verifiedMark } from './verified.js';

// when an item last changed: its content or info (title, tags, key, pages, notes, chords text…), set by
// the Mac; viewing, playing, zoom, transpose and speed don't count (store.update / items.py VIEW_ONLY)
const changedAt = (it) => it.updatedAt || it.createdAt || 0;
const SORTS = {
  modified: ['Last modified', (a, b) => changedAt(b) - changedAt(a) || b.createdAt - a.createdAt || a.title.localeCompare(b.title)],
  added: ['Recently added', (a, b) => b.createdAt - a.createdAt],
  title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
  played: ['Recently played', (a, b) => store.lastPlayed(b.id) - store.lastPlayed(a.id)],
  most: ['Most played', (a, b) => store.playCount(b.id) - store.playCount(a.id)],
  artist: ['Artist A–Z', (a, b) => (a.artist || '').localeCompare(b.artist || '') || a.title.localeCompare(b.title)],
  kind: ['Type', (a, b) => kindOf(a).localeCompare(kindOf(b)) || a.title.localeCompare(b.title)],
  pages: ['Pages', (a, b) => (a.pages || 0) - (b.pages || 0) || a.title.localeCompare(b.title)],
  key: ['Key', (a, b) => (keyShort(a.key) || '\uffff').localeCompare(keyShort(b.key) || '\uffff') || a.title.localeCompare(b.title)],
  version: ['Version', (a, b) => (verLabel(a) || '\uffff').localeCompare(verLabel(b) || '\uffff') || a.title.localeCompare(b.title)],
  album: ['Album', (a, b) => (a.album || '\uffff').localeCompare(b.album || '\uffff') || a.title.localeCompare(b.title)],
};
// table columns (Mac / iPad); clicking a heading sorts, clicking it again reverses
// [sort key, heading, class]. Type is left out when a type is already picked in the left bar.
// columns per view: [sort key, heading, class]. Key (as a chord name: A, Dm, Bb) sits right after the
// title block on every device; on a phone Pages gives way before Key (app.css).
const C = { title: ['title', 'Title', 'c-title'], artist: ['artist', 'Artist', 'c-artist'], album: ['album', 'Album', 'c-album'], type: ['kind', 'Type', 'c-type'],
  version: ['version', 'Version', 'c-ver'], pages: ['pages', 'Pages', 'c-pages'], key: ['key', 'Key', 'c-key'], added: ['added', 'Added', 'c-when'] };
// No tags in any list (they stay on the items: the tag filter and search use them, Info shows and edits them).
// Album (the show / movie / collection) is a Mac column; iPad / iPhone keep the list compact (app.css, touch section).
const COLS_BY = {
  '': [C.title, C.artist, C.album, C.key, C.version, C.type, C.added],
  sheet: [C.title, C.artist, C.album, C.key, C.version, C.pages, C.added],
  book: [C.title, C.artist, C.album, C.version, C.pages, C.added],
  chords: [C.title, C.artist, C.album, C.key, C.version, C.added],
  score: [C.title, C.artist, C.album, C.key, C.version, C.added],
};
// Every device: the page never scrolls; a page of the list = as many rows as fit on the screen
// (measured after drawing: header, table heading, pager, row height — book rows with covers are
// taller). The ‹ n / N › buttons turn pages; iPad / iPhone also swipe left / right. The Mac has no
// swipes or scrolling at all (the user's choice, 2026-11-26): buttons, plus ← → / Page Up / Down. `per` is the last measured count;
// `key` is the view (type + tags) the page number belongs to, so coming back from an item keeps it.
// World (every song, the default) ⇄ Vietnamese only; remembered on this device
const LANG_NEXT = { world: 'vi', vi: 'world' };
const VI_CHARS = /[ăâđêôơưĂÂĐÊÔƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/;
const isVi = (it) => it.tags.includes('Vietnamese') || VI_CHARS.test(it.title || '');
const LANG_ICON = {
  vi: '<svg class="ic star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2l2.2 5.1 5.5.4-4.2 3.6 1.3 5.4L12 15.8l-4.8 2.9 1.3-5.4-4.2-3.6 5.5-.4z"/></svg>',
  world: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.5 7.5c2 .5 3 1.8 2.5 3.5s1 2.5 2.5 3-1 3.5.5 5M14 3.4c-.5 1.6.5 2.6 2 3s2 2 1.5 3.5 1.5 2.5 3.4 2.4"/></svg>',
};
const LANG_TITLE = { world: 'All songs (tap: Vietnamese only)', vi: 'Vietnamese only (tap: all songs)' };
// older devices stored 'all' (or 'world' = not Vietnamese): both are World now
let lang = 'world'; try { lang = localStorage.getItem('meowsic-lang') === 'vi' ? 'vi' : 'world'; } catch {}
const state = { q: '', sort: 'modified', dir: 1, select: false, sel: new Set(), page: 1, anchor: null, per: 0, key: null, top: 0 };
// Default: Last modified, newest first (the user's choice, 2026-11-26). A pick is remembered on this device
// under `meowsic-sort2`; the old `meowsic-sort` keys (from before that default) are dropped once.
try {
  localStorage.removeItem('meowsic-sort'); localStorage.removeItem('meowsic-sort-dir');
  const s = localStorage.getItem('meowsic-sort2'); if (SORTS[s]) state.sort = s; state.dir = localStorage.getItem('meowsic-sort2-dir') === '-1' ? -1 : 1;
} catch {}
const saveSort = () => { try { localStorage.setItem('meowsic-sort2', state.sort); localStorage.setItem('meowsic-sort2-dir', String(state.dir)); } catch {} };
// No sort button: tap a column heading to sort by it (Title: A–Z ⇄ Z–A); the small ⌄ next to
// "Title" opens these orders. When the order has no column (Last modified, Most played) its name sits
// after the ⌄ (tap: reverse). Remembered on this device.
const SORT_MENU = [['modified', 1, 'Last modified'], ['title', 1, 'Title A–Z'], ['title', -1, 'Title Z–A'], ['most', 1, 'Most played'], ['added', 1, 'Recently added']];
const NEWEST_FIRST = new Set(['added', 'modified', 'played', 'most']); // dir 1 = newest / most first
const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
const sortName = () => SORT_MENU.find(([k, d]) => k === state.sort && d === state.dir)?.[2]
  || `${SORTS[state.sort][0]}${NEWEST_FIRST.has(state.sort) === (state.dir > 0) ? '' : ' (reversed)'}`;

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

export function libraryView(main, { q }) {
  const kind = q.get('kind') || '';
  // several tags can be on; an item must have all of them
  const tags = (q.get('tags') || q.get('tag') || '').split(',').filter(Boolean);
  const setTags = (list) => { const p = new URLSearchParams(q); p.delete('tag'); list.length ? p.set('tags', list.join(',')) : p.delete('tags'); go('#/library' + (p.toString() ? '?' + p : '')); };
  const setQ = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); go('#/library' + (p.toString() ? '?' + p : '')); };

  state.select = false; state.sel.clear(); state.anchor = null;
  const viewKey = [kind, tags.join(',')].join('|');
  if (state.key !== viewKey) { state.key = viewKey; state.page = 1; }
  const fit = () => true; // rows per page from the screen (no scrolling), on every device
  let perKind = null; // what `state.per` was measured for (book rows are taller)
  main.innerHTML = `
    <header class="top lib-top selband" id="selband" hidden></header>
    <header class="top lib-top" id="libhead">
      <h1>${kind ? KIND[kind].plural : 'All music'}</h1>
      <div class="seg phone-only" role="tablist">${[['', 'All'], ['sheet', 'Sheets'], ['score', 'Scores'], ['chords', 'Chords'], ['book', 'Books']].map(([k, l]) =>
        `<button role="tab" class="${kind === k ? 'on' : ''}" data-kind="${k}">${k ? icon(KIND[k].icon) : ''}${l}</button>`).join('')}</div>
      ${tags.map((t) => `<span class="tag-on">${esc(t)}<button class="x" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}" title="Remove">×</button></span>`).join('')}
      ${tags.length > 1 ? `<button class="link clear-tags" id="lib-tags-clear">Clear all</button>` : ''}
      ${tags.length ? `<a class="icon-btn btn" href="#/print?tags=${encodeURIComponent(tags.join(','))}">Print all</a>` : ''}

      <label class="search">${icon('search')}<input type="search" id="lib-q" placeholder="Search titles, artists, albums, tags" value="${esc(state.q)}" aria-label="Search" enterkeyhint="search"><button type="button" class="search-x" id="lib-q-x" aria-label="Clear search" title="Clear search" ${state.q ? '' : 'hidden'}>×</button></label>
      <button class="icon-btn lang-btn ${lang === 'vi' ? 'on' : ''}" id="lib-lang" data-lang="${lang}" title="${LANG_TITLE[lang]}" aria-label="${LANG_TITLE[lang]}">${LANG_ICON[lang]}</button>
      <button class="icon-btn tag-btn ${tags.length ? 'on' : ''}" id="lib-tag" title="Filter by tag" aria-label="Filter by tag">${iconOn('tag')}</button>
      <button class="icon-btn touch-only" id="lib-select">Select</button>
    </header>

    <div id="lib-rows"></div>`;
  let shownList = [];

  const draw = (again = true) => {
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    let list = store.items().filter((it) => (!kind || kindOf(it) === kind) && tags.every((t) => it.tags.includes(t)) && (lang !== 'vi' || isVi(it)));
    if (words.length) list = list.filter((it) => { const hay = fold([it.title, it.artist, it.album || '', ...it.tags, KIND[kindOf(it)].label, verLabel(it), it.kind === 'chords' ? '' : it.key || '', keyShort(it.key), it.kind === 'score' ? VERSIONS[it.version] || '' : ''].join(' ')); return words.every((w) => hay.includes(w)); });
    list.sort(SORTS[state.sort][1]);
    if (state.dir < 0) list.reverse();
    const rows = $('#lib-rows', main);
    if (!list.length) {
      const away = store.mode === 'offline' && !store.items().length;
      rows.innerHTML = `<ul class="rows"><li class="empty">${CAT}<p>${away ? 'Meowsic can’t reach the Mac. Check that the Mac is on and on the same Wi-Fi.' : state.q || tags.length || lang === 'vi' ? 'No music matches.' : 'Nothing here yet.'}</p>${state.q || tags.length || lang === 'vi' || away ? '' : '<button class="primary" id="empty-add">Add music</button>'}</li></ul>`;
      $('#empty-add', main)?.addEventListener('click', (e) => addMenu(e.currentTarget));
    } else {
      const per = perPage();
      const pages = Math.max(1, Math.ceil(list.length / per));
      state.page = Math.min(Math.max(1, state.page), pages);
      shownList = list.slice((state.page - 1) * per, state.page * per);
      const more = miniPager(state.page, pages, !isTouch()); // the Mac always shows it, even for one page
      const cnt = `${list.length} item${list.length === 1 ? '' : 's'}`;
      {
        // ▲ = A→Z / oldest first, ▼ = Z→A / newest first; Added / Last modified start newest first
        const arrow = (k) => (state.sort !== k ? '' : NEWEST_FIRST.has(k) === (state.dir > 0) ? ' ▼' : ' ▲');
        const cols = COLS_BY[kind] || COLS_BY[''];
        // the order has no heading of its own (Last modified, Most played…): name it after the ⌄
        const now = cols.some(([k]) => k === state.sort) ? '' : `<button class="th-sort th-now on" data-sort="${state.sort}" title="${esc(sortName())} (tap to reverse)">${esc(state.sort === 'modified' ? 'Modified' : SORTS[state.sort][0])}${arrow(state.sort)}</button>`;
        const cell = {
          'c-title': (it) => (kind === 'book' ? `<span class="cover">${store.thumbUrl(it, 1, 160) ? `<img src="${store.thumbUrl(it, 1, 160)}" alt="" loading="lazy">` : ''}</span>` : '') + esc(it.title) + verifiedMark(it), 'c-artist': (it) => esc(it.artist || ''), 'c-album': (it) => esc(it.album || ''), 'c-type': (it) => badge(it), 'c-ver': (it) => (verLabel(it) ? `<span title="${esc(verDetail(it) || verLabel(it))}">${esc(verLabel(it))}</span>` : ''),
          'c-pages': (it) => (it.pages ? `${it.pages}<span class="pg-u"> p</span>` : ''), 'c-key': (it) => esc(keyShort(it.key)), 'c-when': (it) => ago(it.createdAt),
        };
        rows.innerHTML = `<table class="lib-table ${kind ? 'one-kind' : ''} ${selecting() ? 'selecting' : ''}"><thead><tr><th class="c-pick"></th>${cols.map(([k, l, c]) =>
          `<th class="${c}">${k ? `<button class="th-sort ${state.sort === k ? 'on' : ''}" data-sort="${k}">${l}${arrow(k)}</button>` : l}${c === 'c-title'
            ? `<button class="th-menu" id="lib-sort-menu" aria-haspopup="menu" title="Sort: ${esc(sortName())}" aria-label="Sort options (now: ${esc(sortName())})">${CHEVRON}</button>${now}` : ''}</th>`).join('')}<th class="c-more"></th></tr></thead><tbody>${shownList.map((it) => `
          <tr class="row ${state.sel.has(it.id) ? 'sel' : ''}" data-id="${it.id}">
            <td class="c-pick"><label class="pick" title="Select (Shift-click for a range)"><input type="checkbox" ${state.sel.has(it.id) ? 'checked' : ''} aria-label="Select ${esc(it.title)}"></label></td>
            ${cols.map(([, , c]) => `<td class="${c}${c === 'c-title' ? ' row-title' : ''}">${cell[c](it)}</td>`).join('')}
            <td class="c-more"><button class="icon-btn row-more" aria-label="More for ${esc(it.title)}" title="More">${iconOn('more')}</button></td>
          </tr>`).join('')}</tbody></table><div class="pager-row"><span class="muted">${cnt}</span>${more}</div>`;
        rows.querySelector('.pager')?.addEventListener('click', (e) => {
          const b = e.target.closest('[data-pg]');
          if (!b || b.disabled) return;
          state.page = b.dataset.pg === 'next' ? state.page + 1 : b.dataset.pg === 'prev' ? state.page - 1 : +b.dataset.pg;
          state.top = (state.page - 1) * perPage(); // the row this page was turned to (kept through resizes)
          draw(); main.scrollTo({ top: 0 });
        });
        $('#lib-sort-menu', rows).onclick = (e) => menu(e.currentTarget, SORT_MENU.map(([k, d, l]) => ({
          label: l, checked: state.sort === k && state.dir === d,
          run: () => { state.sort = k; state.dir = d; state.page = 1; saveSort(); draw(); },
        })));
        rows.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
          const k = b.dataset.sort;
          state.dir = state.sort === k ? -state.dir : 1;
          state.sort = k; state.page = 1;
          saveSort();
          draw();
        }));
      }
    }
    drawSelbar(list);
    if (again && list.length && fit()) remeasure();
  };

  // iPad / iPhone: how many whole rows fit between the header and the pager. Measured from the real
  // DOM after drawing: #lib-rows is the flex box left under the header (search, tabs) and above the
  // iPhone tab bar; take away the pager row, the table heading and the table's margins, divide by the
  // real row height (book rows with covers are taller). Rows are never shrunk; the pager row sits at
  // the bottom and the table has no bottom margin there (app.css), so what is left is under one row.
  const perPage = () => state.per || 8;
  const keyboardUp = () => document.activeElement?.id === 'lib-q';
  const remeasure = () => {
    if (keyboardUp() && state.per && perKind === kind) return; // the on-screen keyboard is up: keep the count
    const box = $('#lib-rows', main), table = box.querySelector('.lib-table'), rows = [...box.querySelectorAll('tr.row')];
    if (!table || !rows.length || !box.clientHeight) return;
    const cs = getComputedStyle(table), pr = box.querySelector('.pager-row');
    const room = box.getBoundingClientRect().height - pr.getBoundingClientRect().height - table.tHead.getBoundingClientRect().height - parseFloat(cs.marginTop) - parseFloat(cs.marginBottom);
    const rowH = Math.max(...rows.map((r) => r.getBoundingClientRect().height));
    const n = Math.max(1, Math.floor((room + 0.5) / rowH));
    perKind = kind;
    if (n === perPage()) return;
    // keep the row the page was turned to on screen (rotation, Safari's toolbar), even after
    // several sizes in a row; when it isn't on this page any more (search, sort), the first row
    const first = (state.page - 1) * perPage();
    const top = state.top >= first && state.top < first + perPage() ? state.top : first;
    state.per = n;
    state.page = Math.floor(top / n) + 1;
    state.top = top;
    draw(false);
  };
  const turn = (d) => { const b = main.querySelector(`.pager [data-pg="${d > 0 ? 'next' : 'prev'}"]`); if (b && !b.disabled) b.click(); };

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
      <button ${n ? '' : 'disabled'} id="sb-ver" aria-haspopup="menu">Set version…</button>
      ${store.mode === 'server' ? `<button ${n ? '' : 'disabled'} id="sb-auto">Auto-tag</button>` : ''}
      <button ${n ? '' : 'disabled'} id="sb-print">Print</button>
      <button ${n ? '' : 'disabled'} class="danger-text" id="sb-bin">Move to Trash</button>
      <button class="icon-btn" id="sb-done">Cancel</button>`;
    const box = $('#sb-all', band);
    box.indeterminate = n > 0 && !all;
    box.onchange = () => { if (all) state.sel.clear(); else list.forEach((x) => state.sel.add(x.id)); draw(); };
    $('#sb-tag', band).onclick = () => editTags(ids);
    $('#sb-ver', band).onclick = (e) => versionMenu(e.currentTarget, ids);
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
  $('#lib-lang', main).onclick = (e) => {
    lang = LANG_NEXT[lang]; try { localStorage.setItem('meowsic-lang', lang); } catch {}
    const btn = e.currentTarget; btn.dataset.lang = lang; btn.classList.toggle('on', lang === 'vi');
    btn.title = btn.ariaLabel = LANG_TITLE[lang]; btn.innerHTML = LANG_ICON[lang];
    state.page = 1; draw();
  };
  main.querySelectorAll('[data-untag]').forEach((b) => (b.onclick = () => setTags(tags.filter((t) => t !== b.dataset.untag))));
  $('#lib-tags-clear', main)?.addEventListener('click', () => setTags([]));
  const qIn = $('#lib-q', main), qX = $('#lib-q-x', main);
  const setSearch = (v) => { state.q = v; qX.hidden = !v; state.page = 1; draw(); };
  qIn.oninput = () => setSearch(qIn.value);
  // × : one tap clears; the field is not focused, so no keyboard comes up on iPad / iPhone
  qX.addEventListener('pointerdown', (e) => e.preventDefault());
  qX.onclick = (e) => { e.preventDefault(); qIn.value = ''; qIn.blur(); setSearch(''); };
  qIn.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (qIn.value || state.q)) { e.preventDefault(); e.stopPropagation(); qIn.value = ''; qIn.blur(); setSearch(''); } });
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
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => rowsEl.addEventListener(t, (e) => { if (t !== 'pointermove' || Math.abs(e.movementY) > 4 || Math.abs(e.movementX) > 4) clearTimeout(holdT); }));
  // iPad / iPhone: swipe left = next page, right = previous page (taps still open, hold still selects)
  const offSwipe = attachSwipe(rowsEl, { onLeft: () => turn(1), onRight: () => turn(-1), onUp: null, canStart: () => fit() && !pressed });
  // rotation / resize: measure again (not while the keyboard is up; once it goes down instead)
  let rz = 0;
  const onResize = () => { if (!fit()) return; cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (rowsEl.isConnected && !keyboardUp()) draw(); }); };
  const onBlur = (e) => { if (e.target.id !== 'lib-q' || !fit()) return; main.scrollTop = 0; scrollTo(0, 0); setTimeout(onResize, 300); };
  // iOS Safari's toolbar growing / shrinking, rotation, an installed app's safe areas settling, the
  // header wrapping: any change of the room left for the rows. The ResizeObserver sees all of them
  // (window and visualViewport resize may not fire for every one of them on iOS).
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  let lastH = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(([e]) => { const h = Math.round(e.contentRect.height); if (h !== lastH) { lastH = h; onResize(); } }) : null;
  ro?.observe(rowsEl);
  main.addEventListener('focusout', onBlur);
  rowsEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.row') && e.pointerType !== 'mouse' && isTouch()) e.preventDefault(); });
  const onKey = (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#lib-q', main)?.focus(); }
    // Mac: ← → and Page Up / Down turn the library's pages (the buttons do the same)
    const dir = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[e.key];
    if (dir && !isTouch() && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.('input,textarea,select,[contenteditable]') && !document.querySelector('.menu, .tagpop, .modal-wrap')) { e.preventDefault(); turn(dir); }
    if (e.key === 'Escape' && selecting()) { state.select = false; state.sel.clear(); draw(); }
    else if (e.key === 'Escape' && state.q && !document.querySelector('.menu, .tagpop, .modal')) { const qIn = $('#lib-q', main); qIn.value = ''; qIn.blur(); qIn.oninput(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); shownList.forEach((x) => state.sel.add(x.id)); draw(); }
  };
  document.addEventListener('keydown', onKey);
  draw();
  const offDevice = onDeviceChange(() => draw());
  const off = store.on(() => draw());
  return () => { off(); offDevice(); offSwipe(); removeEventListener('resize', onResize); removeEventListener('orientationchange', onResize); window.visualViewport?.removeEventListener('resize', onResize); ro?.disconnect(); main.removeEventListener('focusout', onBlur); document.removeEventListener('keydown', onKey); };
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

// ‹ 3 / 12 ›  (iPad / iPhone: swipe left / right does the same; Mac: ← → / Page Up / Down). `always`: the Mac
// shows it even for one page (both buttons off), so the page buttons are always where they are expected
function miniPager(page, pages, always = false) {
  if (pages <= 1 && !always) return '';
  return `<nav class="pager mini" aria-label="Pages"><button data-pg="prev" ${page === 1 ? 'disabled' : ''} aria-label="Previous page" title="Previous page">‹</button><span class="pg-now" aria-current="page">${page} / ${pages}</span><button data-pg="next" ${page === pages ? 'disabled' : ''} aria-label="Next page" title="Next page">›</button></nav>`;
}
