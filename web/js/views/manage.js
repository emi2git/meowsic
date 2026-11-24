// Manage library: a hub of jobs, one focused flow each (each with ‹ Back, a title, its progress, one main action).
//   #/manage                        the hub: Check suspect songs · Complete info · Fix pages · Trash (live counts)
//                                   and "Last change · Undo" (the newest undoable Activities row)
//   #/manage/review                 Check suspect songs, one at a time (views/review.js)
//   #/manage/info                   Complete info: Key + Version, one sheet at a time (views/completeinfo.js)
//   #/manage/pages                  Fix pages: pick a sheet (search, Recently opened / All sheets; books are read-only)
//   #/manage/pages/<id>             the page editor (views/pageeditor.js); ?back=item returns to the sheet
//   #/manage/pages/<id>/crop/<p>    crop one page, full screen (views/pageeditor.js)
//   #/manage/trash                  Trash: Restore / Delete for good / Empty Trash (views/organize.js binView)
import { store } from '../store.js';
import { $, esc, iconOn, toast } from '../ui.js';
import { binView } from './organize.js';
import { completeInfoView } from './completeinfo.js';
import { reviewView } from './review.js';
import { editorView, cropView } from './pageeditor.js';
import { api, head, plural, recent, taps, thumb } from './managekit.js';
import { what } from './activity.js';

export function manageView(main, ctx) {
  const [, sub, id, what, p] = ctx.parts;
  if (!sub) return hubView(main);
  if (sub === 'review') return reviewView(main, ctx);
  if (sub === 'info') return infoView(main);
  if (sub === 'trash') return binView(main);
  if (sub === 'pages' && id && what === 'crop') return cropView(main, { ...ctx, id, page: +p || 1 });
  if (sub === 'pages' && id) return editorView(main, { ...ctx, id });
  return pickView(main);
}

// ---------- the hub ----------
function hubView(main) {
  let alive = true;
  const card = ({ href, ic, title, text, count, unit, go, primary, quiet, idc }) => `<a class="mg-card${quiet ? ' quiet' : ''}" href="${href}" id="${idc}">
      <span class="mg-ico">${iconOn(ic)}</span>
      <span class="mg-body"><h2>${title}</h2><p>${text}</p></span>
      <span class="mg-foot">${count}<span class="btn ${primary ? 'primary' : ''} mg-go">${go}</span></span></a>`;
  const num = (n, unit) => (n == null ? '<span class="mg-count muted">…</span>' : `<span class="mg-count">${n}<small>${unit}</small></span>`);
  const draw = (c = {}) => {
    const trash = store.items({ deleted: true }).length;
    main.innerHTML = `<header class="top mg-top"><a class="mg-back" href="#/library">‹ Library</a><h1>Manage library</h1><span class="grow"></span></header>
      <div class="mg-pad mg-wrap">
        <p class="mg-lede">Pick one job. Every change can be undone.</p>
        ${store.mode !== 'server' ? '<p class="muted">Manage library needs the Mac.</p>' : ''}
        <div class="mg-cards">
          ${card({ href: '#/manage/review', ic: 'search', title: 'Check suspect songs', text: 'Sheets that might hold two songs, half a song, pages out of order or blank pages.', idc: 'mg-c-review',
    count: c.suspects === undefined ? num(null) : c.suspects === null ? '<span class="muted small">Not checked yet</span>' : num(c.suspects, 'to check'), go: 'Start', primary: true })}
          ${card({ href: '#/manage/info', ic: 'tag', title: 'Complete info', text: 'Add the key and version, one sheet at a time, with the page in view.', idc: 'mg-c-info', count: num(c.info, 'left'), go: 'Start', primary: true })}
          ${card({ href: '#/manage/pages', ic: 'pages', title: 'Fix pages', text: 'Crop, reorder, split, merge or delete pages of any sheet.', idc: 'mg-c-pages', count: '<span class="muted small">Choose a sheet</span>', go: 'Open' })}
          ${card({ href: '#/manage/trash', ic: 'bin', title: 'Trash', text: 'Restore deleted music or delete it for good.', idc: 'mg-c-trash', count: num(trash, trash === 1 ? 'item' : 'items'), go: 'Open', quiet: true })}
        </div>
        <div class="mg-last" id="mg-last" ${c.last ? '' : 'hidden'}>${iconOn('undo')}<span class="mg-last-t">${c.last ? `Last change: ${esc(c.last.text)}` : ''}</span><span class="grow"></span>
          <button class="ghost mg-undo" data-act="undo-last">Undo</button></div>
      </div>`;
  };
  const counts = {};
  const load = async () => {
    if (store.mode !== 'server') return draw({ suspects: null, info: 0 });
    const [org, info, acts] = await Promise.all([api('GET', '/organize').catch(() => null), api('GET', '/completeinfo/count').catch(() => null), api('GET', '/activity?limit=60').catch(() => [])]);
    if (!alive) return;
    counts.suspects = org?.scan ? new Set(org.scan.candidates.map((x) => x.id)).size : null;
    counts.info = info?.count ?? 0;
    const a = (acts || []).find((x) => !x.kind && x.type !== 'rollback' && !x.undoneAt);
    counts.last = a && a.action === 'undo' ? { id: a.id, text: `${what(a)} · “${a.title}”${a.detail && a.detail !== a.title ? ` — ${a.detail}` : ''}` } : null;
    draw(counts);
  };
  draw();
  const off = taps(main, '[data-act]', async (el) => {
    if (el.dataset.act !== 'undo-last' || !counts.last) return;
    el.disabled = true;
    try { const r = await api('POST', `/activity/${encodeURIComponent(counts.last.id)}/undo`, {}); toast(r.message || 'Undone'); } catch (e) { toast(e.message); }
    load();
  });
  const off2 = store.on(() => { const n = store.items({ deleted: true }).length, el = $('#mg-c-trash .mg-count', main); if (el) el.innerHTML = `${n}<small>${n === 1 ? 'item' : 'items'}</small>`; });
  load();
  return () => { alive = false; off(); off2(); };
}

// ---------- Complete info (views/completeinfo.js) in a flow header ----------
function infoView(main) {
  main.innerHTML = head({ title: 'Complete info', sub: '', right: '<a class="btn ghost mg-done" href="#/manage">Done</a>' })
    + '<div class="mg-progress"><i id="mg-bar"></i></div><div class="mg-info" id="mg-info"></div>';
  return completeInfoView($('#mg-info', main), {
    onProgress: ({ at, left, done }) => {
      const total = left + done, s = $('#mg-sub', main), bar = $('#mg-bar', main);
      if (s) s.textContent = left ? `${at} of ${left} · saved as you go` : 'All done';
      if (bar) bar.style.width = `${total ? Math.max(2, (done / total) * 100) : 100}%`;
    },
  });
}

// ---------- Fix pages: pick a sheet ----------
const LIST_MAX = 200;
function pickView(main) {
  if (store.mode !== 'server') { main.innerHTML = head({ title: 'Fix pages', sub: null, h: 'h1' }) + '<p class="mg-pad muted">Fix pages needs the Mac.</p>'; return; }
  let items = null, seg = recent().length ? 'recent' : 'all', find = '';
  main.innerHTML = head({ title: 'Fix pages', sub: null, h: 'h1' }) + `<div class="mg-pad mg-wrap">
      <input class="mg-search" id="pk-find" type="search" placeholder="Find a sheet" aria-label="Find a sheet" enterkeyhint="search" autocomplete="off">
      <div class="mg-seg" role="tablist"><button data-seg="recent" role="tab">Recently opened</button><button data-seg="all" role="tab">All sheets</button></div>
      <ul class="mg-rows" id="pk-list"><li class="muted mg-empty">Loading…</li></ul></div>`;
  const list = () => {
    main.querySelectorAll('[data-seg]').forEach((b) => { b.classList.toggle('on', b.dataset.seg === seg && !find); b.setAttribute('aria-selected', b.dataset.seg === seg); });
    if (!items) return;
    const f = find.trim().toLowerCase();
    let xs;
    if (f) xs = items.filter((x) => x.title.toLowerCase().includes(f));
    else if (seg === 'recent') { const by = new Map(items.map((x) => [x.id, x])); xs = recent().map((i) => by.get(i)).filter(Boolean); }
    else xs = items;
    $('#pk-list', main).innerHTML = xs.slice(0, LIST_MAX).map((x) => `<li><a class="mg-row" href="#/manage/pages/${encodeURIComponent(x.id)}" data-id="${esc(x.id)}">
        <img class="mg-mini" src="${thumb(x.id, 1, x.updatedAt, 120)}" alt="" loading="lazy"><span class="mg-rt"><b>${esc(x.title)}</b><small>Sheet · ${plural(x.pages, 'page')}</small></span><span class="mg-chev">›</span></a></li>`).join('')
      + (xs.length > LIST_MAX ? `<li class="muted small mg-empty">${xs.length - LIST_MAX} more — type to find them</li>` : '')
      + (!xs.length ? `<li class="muted mg-empty">${f ? 'No sheet with that name' : seg === 'recent' ? 'Nothing opened yet — see All sheets' : 'No sheets yet'}</li>` : '');
  };
  $('#pk-find', main).oninput = (e) => { find = e.target.value; list(); };
  const off = taps(main, '[data-seg]', (el) => { seg = el.dataset.seg; find = ''; $('#pk-find', main).value = ''; list(); });
  list();
  api('GET', '/organize').then((r) => { items = r.items; list(); }).catch((e) => { $('#pk-list', main).innerHTML = `<li class="muted mg-empty">${esc(e.message)}</li>`; });
  return off;
}

