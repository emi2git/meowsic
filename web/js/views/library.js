// Library: every sheet, chord chart and score in one list.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, menu, KIND, CAT } from '../ui.js';
import { go, addMenu } from '../app.js';
import { thumbHtml, metaText, itemMenu, editTags, binItems } from './actions.js';

const SORTS = {
  added: ['Recently added', (a, b) => b.createdAt - a.createdAt],
  title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
  played: ['Recently played', (a, b) => store.lastPlayed(b.id) - store.lastPlayed(a.id)],
  most: ['Most played', (a, b) => store.playCount(b.id) - store.playCount(a.id)],
};
const PAGE = 60;
const state = { q: '', sort: 'added', select: false, sel: new Set(), shown: PAGE, anchor: null };
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
      
      <button class="chip-btn" id="lib-sort" aria-haspopup="menu">Sort: ${SORTS[state.sort][0]} ▾</button>
    
      <label class="search">${icon('search')}<input type="search" id="lib-q" placeholder="Search titles, artists, tags" value="${esc(state.q)}" aria-label="Search"></label>
      <button class="icon-btn tag-btn ${tags.length ? 'on' : ''}" id="lib-tag" title="Filter by tag" aria-label="Filter by tag">${iconOn('tag')}</button>
      <button class="icon-btn touch-only" id="lib-select">Select</button>
    </header>

    <ul class="rows" id="lib-rows"></ul>`;
  let shownList = [];

  const draw = () => {
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    let list = store.items().filter((it) => (!kind || it.kind === kind) && tags.every((t) => it.tags.includes(t)));
    if (words.length) list = list.filter((it) => { const hay = fold([it.title, it.artist, ...it.tags, KIND[it.kind].label].join(' ')); return words.every((w) => hay.includes(w)); });
    list.sort(SORTS[state.sort][1]);
    const rows = $('#lib-rows', main);
    if (!list.length) {
      rows.innerHTML = `<li class="empty">${CAT}<p>${state.q || tags.length ? 'No music matches.' : 'Nothing here yet.'}</p>${state.q || tags.length ? '' : '<button class="primary" id="empty-add">Add music</button>'}</li>`;
      $('#empty-add', main)?.addEventListener('click', (e) => addMenu(e.currentTarget));
    } else {
      shownList = list.slice(0, state.shown);
      rows.classList.toggle('selecting', selecting());
      rows.innerHTML = list.slice(0, state.shown).map((it) => `
        <li class="row ${state.sel.has(it.id) ? 'sel' : ''}" data-id="${it.id}">
          <label class="pick" title="Select (Shift-click for a range)"><input type="checkbox" ${state.sel.has(it.id) ? 'checked' : ''} aria-label="Select ${esc(it.title)}"></label>
          ${thumbHtml(it)}
          <div class="row-main">
            <div class="row-title">${esc(it.title)}</div>
            <div class="row-sub">${badge(it.kind)}<span>${esc(it.artist || '')}</span><span class="dot">·</span><span>${metaText(it)}</span></div>
            ${it.tags.length ? `<div class="row-tags">${it.tags.slice(0, 4).map((t) => `<span class="tagchip">${esc(t)}</span>`).join('')}${it.tags.length > 4 ? `<span class="tagchip more">+${it.tags.length - 4}</span>` : ''}</div>` : ''}
          </div>
          <div class="row-when hide-s">${state.sort === 'most' ? `${store.playCount(it.id)} plays` : state.sort === 'played' ? ago(store.lastPlayed(it.id)) : ago(it.createdAt)}</div>
          <button class="icon-btn row-more" aria-label="More for ${esc(it.title)}" title="More">${iconOn('more')}</button>
        </li>`).join('') +
        (list.length > state.shown ? `<li class="more-row"><button id="lib-more">Show ${Math.min(PAGE, list.length - state.shown)} more of ${list.length - state.shown}</button></li>` : '') +
        `<li class="count-row">${list.length} item${list.length === 1 ? '' : 's'}</li>`;
      $('#lib-more', main)?.addEventListener('click', () => { state.shown += PAGE; draw(); });
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
      <button ${n ? '' : 'disabled'} id="sb-print">Print</button>
      <button ${n ? '' : 'disabled'} class="danger-text" id="sb-bin">Move to bin</button>
      <button class="icon-btn" id="sb-done">Cancel</button>`;
    const box = $('#sb-all', band);
    box.indeterminate = n > 0 && !all;
    box.onchange = () => { if (all) state.sel.clear(); else list.forEach((x) => state.sel.add(x.id)); draw(); };
    $('#sb-tag', band).onclick = () => editTags(ids);
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

  main.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { state.shown = PAGE; setQ('kind', b.dataset.kind); } };
  $('#lib-tag', main).onclick = (e) => tagFilter(e.currentTarget, tags, setTags);
  main.querySelectorAll('[data-untag]').forEach((b) => (b.onclick = () => setTags(tags.filter((t) => t !== b.dataset.untag))));
  $('#lib-tags-clear', main)?.addEventListener('click', () => setTags([]));
  $('#lib-sort', main).onclick = (e) => menu(e.currentTarget, Object.entries(SORTS).map(([k, [l]]) => ({
    label: (state.sort === k ? '✓ ' : '   ') + l,
    run: () => { state.sort = k; try { localStorage.setItem('meowsic-sort', k); } catch {} $('#lib-sort', main).textContent = `Sort: ${l} ▾`; draw(); },
  })));
  $('#lib-q', main).oninput = (e) => { state.q = e.target.value; state.shown = PAGE; draw(); };
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
  const off = store.on(draw);
  return () => { off(); document.removeEventListener('keydown', onKey); };
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
