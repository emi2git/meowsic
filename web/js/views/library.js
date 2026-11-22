// Library: every sheet, chord chart and score in one list.
import { store } from '../store.js';
import { $, esc, icon, badge, ago, menu, KIND, CAT } from '../ui.js';
import { go, addMenu } from '../app.js';
import { thumbHtml, metaText, itemMenu, editTags, binItems } from './actions.js';

const SORTS = {
  added: ['Recently added', (a, b) => b.createdAt - a.createdAt],
  title: ['Title A–Z', (a, b) => a.title.localeCompare(b.title)],
  played: ['Recently played', (a, b) => store.lastPlayed(b.id) - store.lastPlayed(a.id)],
  most: ['Most played', (a, b) => store.playCount(b.id) - store.playCount(a.id)],
};
const PAGE = 60;
const state = { q: '', sort: 'added', select: false, sel: new Set(), shown: PAGE };
try { state.sort = localStorage.getItem('meowsic-sort') || 'added'; } catch {}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

export function libraryView(main, { q }) {
  const kind = q.get('kind') || '';
  const tag = q.get('tag') || '';
  const setQ = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); go('#/library' + (p.toString() ? '?' + p : '')); };

  main.innerHTML = `
    <header class="top">
      <h1>${kind ? KIND[kind].plural : 'All music'}</h1>
      <label class="search">${icon('search')}<input type="search" id="lib-q" placeholder="Search titles, artists, tags" value="${esc(state.q)}" aria-label="Search"></label>
      <button class="icon-btn" id="lib-select" title="Select">${icon('select')}<span class="hide-s">Select</span></button>
      <button class="primary hide-phone" id="lib-add">${icon('plus')}Add</button>
    </header>
    <div class="filters">
      <div class="seg" role="tablist">${[['', 'All'], ['sheet', 'Sheets'], ['chords', 'Chords'], ['score', 'Scores']].map(([k, l]) =>
        `<button role="tab" class="${kind === k ? 'on' : ''}" data-kind="${k}">${k ? icon(KIND[k].icon) : ''}${l}</button>`).join('')}</div>
      <button class="chip-btn ${tag ? 'on' : ''}" id="lib-tag">${icon('tag')}${tag ? esc(tag) : 'Any tag'}${tag ? `<span class="x" id="lib-tag-x" aria-label="Clear tag">${icon('close')}</span>` : ''}</button>
      ${tag ? `<button class="icon-btn" id="lib-perform">${icon('perform')}<span>Play all</span></button><a class="icon-btn btn" href="#/print?tag=${encodeURIComponent(tag)}">${icon('print')}<span>Print all</span></a>` : ''}
      <span class="grow"></span>
      <label class="sort">Sort <select id="lib-sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <ul class="rows" id="lib-rows"></ul>
    <div class="selbar" id="selbar" hidden></div>`;

  const draw = () => {
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    let list = store.items().filter((it) => (!kind || it.kind === kind) && (!tag || it.tags.includes(tag)));
    if (words.length) list = list.filter((it) => { const hay = fold([it.title, it.artist, ...it.tags, KIND[it.kind].label].join(' ')); return words.every((w) => hay.includes(w)); });
    list.sort(SORTS[state.sort][1]);
    const rows = $('#lib-rows', main);
    if (!list.length) {
      rows.innerHTML = `<li class="empty">${CAT}<p>${state.q || tag ? 'No music matches.' : 'Nothing here yet.'}</p>${state.q || tag ? '' : '<button class="primary" id="empty-add">Add music</button>'}</li>`;
      $('#empty-add', main)?.addEventListener('click', (e) => addMenu(e.currentTarget));
    } else {
      rows.innerHTML = list.slice(0, state.shown).map((it) => `
        <li class="row ${state.sel.has(it.id) ? 'sel' : ''}" data-id="${it.id}">
          ${state.select ? `<span class="check">${state.sel.has(it.id) ? icon('check') : ''}</span>` : ''}
          ${thumbHtml(it)}
          <div class="row-main">
            <div class="row-title">${esc(it.title)}</div>
            <div class="row-sub">${badge(it.kind)}<span>${esc(it.artist || '')}</span><span class="dot">·</span><span>${metaText(it)}</span></div>
            ${it.tags.length ? `<div class="row-tags">${it.tags.slice(0, 4).map((t) => `<span class="tagchip">${esc(t)}</span>`).join('')}${it.tags.length > 4 ? `<span class="tagchip more">+${it.tags.length - 4}</span>` : ''}</div>` : ''}
          </div>
          <div class="row-when hide-s">${state.sort === 'most' ? `${store.playCount(it.id)} plays` : state.sort === 'played' ? ago(store.lastPlayed(it.id)) : ago(it.createdAt)}</div>
          ${state.select ? '' : `<button class="icon-btn row-more" aria-label="More for ${esc(it.title)}">${icon('more')}</button>`}
        </li>`).join('') +
        (list.length > state.shown ? `<li class="more-row"><button id="lib-more">Show ${Math.min(PAGE, list.length - state.shown)} more of ${list.length - state.shown}</button></li>` : '') +
        `<li class="count-row">${list.length} item${list.length === 1 ? '' : 's'}</li>`;
      $('#lib-more', main)?.addEventListener('click', () => { state.shown += PAGE; draw(); });
    }
    drawSelbar(list);
  };

  const drawSelbar = (list) => {
    const bar = $('#selbar', main);
    bar.hidden = !state.select;
    if (!state.select) return;
    const ids = [...state.sel];
    bar.innerHTML = `<button id="sb-all">${state.sel.size === list.length ? 'None' : 'All'}</button><b>${ids.length} selected</b><span class="grow"></span>
      <button ${ids.length ? '' : 'disabled'} id="sb-tag">${icon('tag')}<span class="hide-s">Tags</span></button>
      <button ${ids.length ? '' : 'disabled'} id="sb-print">${icon('print')}<span class="hide-s">Print</span></button>
      <button ${ids.length ? '' : 'disabled'} class="danger-text" id="sb-bin">${icon('bin')}<span class="hide-s">Bin</span></button>
      <button class="primary" id="sb-done">Done</button>`;
    $('#sb-all', bar).onclick = () => { if (state.sel.size === list.length) state.sel.clear(); else list.forEach((x) => state.sel.add(x.id)); draw(); };
    $('#sb-tag', bar).onclick = () => editTags(ids);
    $('#sb-print', bar).onclick = () => go(`#/print?items=${ids.join(',')}`);
    $('#sb-bin', bar).onclick = () => { binItems(ids); state.sel.clear(); };
    $('#sb-done', bar).onclick = () => { state.select = false; state.sel.clear(); draw(); };
  };

  main.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { state.shown = PAGE; setQ('kind', b.dataset.kind); } };
  $('#lib-tag', main).onclick = (e) => {
    if (e.target.closest('#lib-tag-x')) return setQ('tag', '');
    const counts = store.tagCounts();
    menu(e.currentTarget, [{ label: 'Any tag', run: () => setQ('tag', '') }, '-',
      ...store.db.tags.slice().sort().map((t) => ({ label: `${t}  (${counts.get(t) || 0})`, run: () => setQ('tag', t) }))]);
  };
  $('#lib-sort', main).onchange = (e) => { state.sort = e.target.value; try { localStorage.setItem('meowsic-sort', state.sort); } catch {} draw(); };
  $('#lib-q', main).oninput = (e) => { state.q = e.target.value; state.shown = PAGE; draw(); };
  $('#lib-select', main).onclick = () => { state.select = !state.select; state.sel.clear(); draw(); };
  $('#lib-add', main).onclick = (e) => addMenu(e.currentTarget);
  $('#lib-perform', main)?.addEventListener('click', () => { const first = store.tagItems(tag)[0]; if (first) go(`#/perform/${first.id}?tag=${encodeURIComponent(tag)}`); });
  $('#lib-rows', main).onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.row-more')) return itemMenu(e.target.closest('.row-more'), id);
    if (state.select) { state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); draw(); return; }
    go(`#/item/${id}`);
  };
  const onKey = (e) => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#lib-q', main)?.focus(); } };
  document.addEventListener('keydown', onKey);
  draw();
  const off = store.on(draw);
  return () => { off(); document.removeEventListener('keydown', onKey); };
}
