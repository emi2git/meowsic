// Clean up, three jobs:
//  · Go through sheets — every sheet one by one, page 1 first (scroll for the rest): Delete or Keep, then the
//    next one. Decisions are kept on the Mac; at the end a summary, then the deletes really happen.
//  · Fix pages — what the Mac found per song (screen junk to trim, pages grouped wrongly): trim each page
//    (suggested box or your own), split, rename, delete.
//  · Titles — titles that look like file names or typos.
// Only sheets — books are left out everywhere. Each sheet can carry a short note for Claude (what should
// happen to it); it saves as you type.
// Every action can be undone (Undo button, U or Z); the original photo of a trimmed page is always kept.
import { store } from '../store.js';
import { go } from '../app.js';
import { $, esc, toast, menu, sheet as modal, confirmSheet } from '../ui.js';
import { makeBooks, BOOK_KEYS } from './cleanup-books.js';
import { titleBox } from '../title-detect.js';

const KEYS = {
  sort: [
    ['D / Delete', 'Delete this sheet (marks it; nothing is deleted until you finish)'],
    ['K / Enter', 'Keep this sheet'],
    ['→ / ←', 'Next / previous sheet'],
    ['↑ ↓ / Space', 'Scroll the pages'],
    ['U / Z', 'Undo'],
  ],
  fix: [
    ['Enter / T', 'Trim as shown and go on'],
    ['F', 'Keep this page as it is'],
    ['G', 'Song done'],
    ['→ ←', 'Next / previous page'],
    ['] [', 'Next / previous song'],
    ['↑ ↓', 'Move the top edge (Shift: bottom edge)'],
    ['⌥ ← →', 'Move the left edge (Shift: right edge)'],
    ['X / C', 'Suggested box / whole page'],
    ['O', 'Back to the original photo'],
    ['R', 'Rename'], ['S', 'Split into two songs…'], ['Delete', 'Delete the song'],
    ['U / Z', 'Undo'],
  ],
  titles: [['Enter / R', 'Rename'], ['F', 'Title is fine'], ['↑ ↓', 'Next / previous'], ['U / Z', 'Undo']],
  books: BOOK_KEYS,
};
// what the Mac found, in plain words
const ISSUE = { trim: 'Screen junk to trim', mixed: 'Pages from different songs', incomplete: 'Pages missing', extra: 'Extra pages',
  twice: 'Same page twice', order: 'Pages out of order', empty: 'No pages', title: 'Odd title' };
const FILTERS = [['look', 'To do'], ['good', 'Done'], ['all', 'All']];

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'The Mac said no.');
  return data;
};
const isGood = (s) => s.reviewed || !s.issues.length;
const full = () => ({ top: 0, bottom: 1, left: 0, right: 1 });

export function cleanupView(main) {
  if (store.mode !== 'server') {
    main.innerHTML = '<header class="top"><h1>Clean up</h1></header><p class="pad muted">Clean up needs the Mac.</p>';
    return;
  }
  let tab0 = 'sort'; try { tab0 = localStorage.getItem('meowsic-cu-tab') || 'sort'; } catch {}
  const st = { tab: tab0, filter: 'look', songs: [], titles: [], sid: null, pi: 0, ti: 0, scan: null, crop: null, carry: null, undo: [], sug: [], busy: false, renaming: false,
    sort: { dec: {}, id: null, show: 'todo', summary: false }, notes: {}, noteDue: null };
  main.innerHTML = `<header class="top cu-top">
      <a class="icon-btn back cu-back" href="#/library" aria-label="Back to the library">‹ Library</a>
      <h1>Clean up</h1>
      <div class="cu-tabs" role="tablist">
        <button data-tab="sort">Go through sheets</button>
        <button data-tab="songs">Fix pages <i id="cu-nf"></i></button>
        <button data-tab="titles">Titles <i id="cu-nt"></i></button>
        <button data-tab="books">Books → sheets</button></div>
      <span class="grow"></span>
      <span class="muted small" id="cu-scan"></span>
      <button id="cu-undo" class="cu-undo" disabled title="Undo (U)">↶ Undo</button>
      <button id="cu-more" class="icon-btn" aria-label="More" title="More">⋯</button></header>
    <div class="cu" id="cu"></div>`;
  const body = $('#cu', main);
  const books = makeBooks({ body, st, busy: (f) => busy(f), undo: () => undo(), help: () => help(), drawHead: () => drawHead(), tab: (t) => { st.tab = t; draw(); } });

  // the song you're on stays in the list until you move off it — otherwise finishing its last trim
  // would drop it from "To do" and throw you back to the top of the list (the same song again and again)
  const shown = () => st.songs.filter((s) => s.id === st.sid || (st.filter === 'all' ? true : st.filter === 'good' ? isGood(s) : !isGood(s)));
  const song = () => st.songs.find((s) => s.id === st.sid);
  const pg = () => song()?.pages[st.pi];

  const load = async () => {
    const [d, so, sg] = await Promise.all([api('GET', '/cleanup'), api('GET', '/cleanup/sort'), api('GET', '/cleanup/suggest').catch(() => [])]);
    st.sug = sg; st.scan = d.scan; st.songs = d.songs; st.titles = d.titles; st.sort.dec = so.decisions;
    for (const s of d.songs) if (!(s.id in st.notes)) st.notes[s.id] = s.note || ''; // what is typed here always wins
    if (!song()) { st.sid = shown()[0]?.id || null; st.pi = 0; }
    st.ti = Math.min(st.ti, Math.max(0, st.titles.length - 1));
    if (document.activeElement?.id === 'cu-note') drawHead(); // typing a note: don't redraw under the cursor
    else if (st.tab === 'sort' && !st.sort.summary && body.dataset.sid && body.dataset.sid === st.sort.id) { drawHead(); drawSort(false); } else draw();
    if (d.scan.running) setTimeout(() => body.isConnected && !st.busy && load(), 6000);
  };
  // refresh one song after a change (the Mac looks at the page again)
  const reloadSong = async (id) => {
    const d = await api('GET', `/cleanup?id=${encodeURIComponent(id)}`);
    const fresh = d.songs[0], k = st.songs.findIndex((s) => s.id === id);
    if (fresh && k >= 0) st.songs[k] = fresh;
    st.titles = st.titles.filter((t) => t.id !== id).concat(d.titles).sort((a, b) => a.title.localeCompare(b.title));
  };

  const drawHead = () => {
    $('#cu-nt', main).textContent = st.titles.length + st.sug.length || '';
    $('#cu-nf', main).textContent = st.songs.filter((s) => !isGood(s)).length || '';
    main.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.tab));
    const s = st.scan;
    $('#cu-scan', main).textContent = s?.running ? `Checking pages… ${s.done} / ${s.total}` : '';
    const u = st.undo.at(-1), ub = $('#cu-undo', main);
    ub.disabled = !u || st.busy;
    ub.textContent = u ? `↶ Undo ${u.label}` : '↶ Undo';
  };

  const songLine = (s) => (s.reviewed ? 'done' : s.issues.length ? s.issues.map((i) => i.text).join(' · ') : 'nothing found') + (s.trimmed ? ` · ${s.trimmed} trimmed` : '');
  const chips = (s) => (s.issues.length ? s.issues.map((i) => `<span class="cu-issue ${i.kind}" title="${esc(i.text)}">${esc(ISSUE[i.kind] || i.kind)}${i.kind === 'trim' ? ` · ${esc(i.text.split(' ')[0])}` : ''}</span>`).join('')
    : `<span class="cu-issue ok">${s.reviewed ? 'Done' : 'Nothing found'}</span>`);

  const draw = () => {
    flushNote();
    drawHead();
    try { localStorage.setItem('meowsic-cu-tab', st.tab); } catch {}
    body.className = 'cu ' + st.tab;
    if (st.tab === 'titles') return drawTitles();
    if (st.tab === 'books') return books.draw();
    if (st.tab === 'sort') return drawSort();
    const list = shown();
    const filt = `<div class="cu-filter">${FILTERS.map(([k, l]) => `<button data-f="${k}" class="${st.filter === k ? 'on' : ''}">${l} <i>${{ look: st.songs.filter((s) => !isGood(s)).length, good: st.songs.filter(isGood).length, all: st.songs.length }[k]}</i></button>`).join('')}</div>`;
    if (!list.length) {
      body.innerHTML = `<div class="cu-side">${filt}</div><p class="pad muted">${st.scan?.running ? 'Checking pages…' : st.filter === 'look' ? 'Nothing left to fix. 🎉' : 'No songs here.'}</p>`;
      return;
    }
    if (!list.some((s) => s.id === st.sid)) { st.sid = list[0].id; st.pi = 0; }
    const s = song(), it = store.get(s.id);
    st.pi = Math.max(0, Math.min(st.pi, s.pages.length - 1));
    const p = pg() || { page: 0, file: '', trims: 0 };
    const key = `${s.id}:${p.page}`;
    if (st.crop?.key !== key) st.crop = startBox(s, p);
    const ver = it?.updatedAt || 0;
    body.innerHTML = `<div class="cu-side">${filt}
      <ol class="cu-list" id="cu-list">${list.map((x) => `<li class="${x.id === st.sid ? 'on' : ''} ${isGood(x) ? 'good' : x.issues.some((i) => i.kind !== 'trim' && i.kind !== 'title') ? 'bad' : 'look'}" data-id="${x.id}">
        <b>${hasNote(x.id) ? '<span class="cu-pen" title="Has a note for Claude">✎</span> ' : ''}${esc(store.get(x.id)?.title || x.title)}</b><small>${x.pages.length} p · ${esc(songLine(x))}</small></li>`).join('')}</ol></div>
      <section class="cu-main">
        <div class="cu-bar">
          <input id="cu-title" value="${esc(it?.title || s.title)}" aria-label="Title — tap to rename" readonly title="Tap to rename (R)">
          ${noteBox(s.id)}
          <button id="cu-songmore" class="ghost">Song ▾</button>
        </div>
        <div class="cu-issues">${chips(s)}${s.issues.some((i) => ['mixed', 'extra', 'twice', 'order', 'incomplete'].includes(i.kind)) ? '<span class="muted small">To fix grouping: Song ▾ → Split into two songs, or Delete.</span>' : ''}</div>
        <div class="cu-strip">${s.pages.map((x, k) => `<button class="${k === st.pi ? 'on' : ''}" data-p="${k}" title="Page ${x.page}">
          <img src="${store.fileUrl(s.id, it?.pageFiles?.[x.page - 1] || x.file)}?v=${ver}" alt="" loading="lazy">
          <span>${x.page}${x.dots ? ` · dot ${x.dots.lit ?? '?'}/${x.dots.count}` : ''}${x.trims ? ' · ✓' : x.trim ? ' · ✂' : ''}</span></button>`).join('')}</div>
        ${!p.page ? '<p class="pad muted">This song has no pages. Delete it?</p>' : ''}
${p.page ? `        <div class="cu-stage" id="cu-stage"><div class="cu-img">
          <img id="cu-img" src="${p.trims ? `/api/items/${encodeURIComponent(s.id)}/pages/${p.page}/original` : store.fileUrl(s.id, it?.pageFiles?.[p.page - 1] || p.file)}?v=${ver}" alt="" draggable="false">
          <div class="cu-shade"></div>
          <div class="cu-box"><i data-e="top"></i><i data-e="bottom"></i><i data-e="left"></i><i data-e="right"></i>
            <i data-e="top left"></i><i data-e="top right"></i><i data-e="bottom left"></i><i data-e="bottom right"></i></div>
        </div></div>` : ''}
        <div class="cu-act">
          <span class="muted small cu-hint">Page ${st.pi + 1} of ${s.pages.length} · <b class="cu-from">${esc(st.crop.from)}</b>${p.trim && !p.crop ? ` · found: ${esc(p.trim.reasons.join(', '))}` : ''} · drag the red edges, or draw a new box</span>
          <span class="grow"></span>
          ${p.trims ? '<button id="cu-orig" class="ghost">Original photo</button>' : ''}
          <button id="cu-fine" class="big">Keep page as is</button>
          <button id="cu-trim" class="primary big">Trim &amp; next</button>
        </div>
      </section>`;
    placeBox();
    body.querySelector('.cu-list li.on')?.scrollIntoView({ block: 'nearest' });
    $('#cu-list', body).onclick = (e) => { const li = e.target.closest('[data-id]'); if (li) { st.sid = li.dataset.id; st.pi = 0; st.crop = null; draw(); } };
    body.querySelector('.cu-strip').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { st.pi = +b.dataset.p; draw(); } };
    $('#cu-trim', body).onclick = doTrim;
    if (!p.page) for (const id of ['cu-trim', 'cu-fine']) $('#' + id, body).disabled = true;
    $('#cu-fine', body).onclick = fine;
    $('#cu-orig', body)?.addEventListener('click', () => original());
    body.querySelector('.cu-filter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { st.filter = b.dataset.f; st.crop = null; draw(); } };
    $('#cu-songmore', body).onclick = (e) => menu(e.currentTarget, [
      { label: s.reviewed ? 'Not done yet' : 'Song done — next song', icon: 'check', run: songGood },
      { label: 'Rename…', icon: 'edit', run: () => rename() },
      { label: 'Split into two songs…', icon: 'split', run: splitSong },
      { label: 'Open in the library', icon: 'right', run: () => go(`#/item/${s.id}`) },
      '-',
      { label: 'Delete this song', icon: 'bin', danger: true, run: delSong },
    ]);
    $('#cu-title', body).onclick = () => rename();
    wireNote(s.id);
    const ci = $('.cu-img', body); if (ci) ci.onpointerdown = drag;
  };

  // the box a page starts with: its own crop > the last crop set anywhere this session (any song) > the Mac's suggestion.
  // Boxes are always on the ORIGINAL photo (the stage shows the original, never the cropped file).
  const startBox = (s, p, prefer) => {
    const key = `${s.id}:${p.page}`, cc = st.carry, sug = p.trim || p.box;
    const pick = (b) => ({ top: b.top, bottom: b.bottom, left: b.left ?? 0, right: b.right ?? 1 });
    if (prefer !== 'suggested') {
      if (p.crop) return { key, ...pick(p.crop), from: 'Cropped' };
      if (cc && !(cc.sid === s.id && cc.page === p.page)) return { key, ...pick(cc.box), from: cc.sid === s.id ? `Same as page ${cc.page}` : `Same as last crop (${cc.title} p${cc.page})` };
    }
    if (sug) return { key, ...full(), ...pick(sug), from: 'Suggested' };
    return { key, ...full(), from: 'Whole page' };
  };
  const placeBox = () => {
    const c = st.crop, box = $('.cu-img', body);
    if (!box) return;
    for (const k of ['top', 'bottom', 'left', 'right']) box.style.setProperty('--' + k[0], c[k] * 100 + '%');
    const f = $('.cu-from', body); if (f && c.from) f.textContent = c.from;
  };
  // drag an edge / corner of the box, or anywhere else on the page to draw a new box
  const drag = (e) => {
    const img = $('#cu-img', body), r = img.getBoundingClientRect();
    const at = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
    const edges = e.target.dataset?.e?.split(' ');
    const [x0, y0] = at(e), c = st.crop;
    e.preventDefault();
    const move = (ev) => {
      const [x, y] = at(ev);
      if (edges) {
        for (const ed of edges) {
          if (ed === 'top') c.top = Math.min(y, c.bottom - 0.1);
          if (ed === 'bottom') c.bottom = Math.max(y, c.top + 0.1);
          if (ed === 'left') c.left = Math.min(x, c.right - 0.1);
          if (ed === 'right') c.right = Math.max(x, c.left + 0.1);
        }
      } else if (Math.abs(x - x0) > 0.02 || Math.abs(y - y0) > 0.02) {
        Object.assign(c, { top: Math.min(y, y0), bottom: Math.max(y, y0), left: Math.min(x, x0), right: Math.max(x, x0) });
      }
      placeBox();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      if (c.bottom - c.top < 0.2 || c.right - c.left < 0.2) { Object.assign(c, full()); placeBox(); toast('Box too small — whole page'); }
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const nudge = (edge, d) => {
    const c = st.crop;
    if (!c) return;
    if (edge === 'top') c.top = Math.min(c.bottom - 0.2, Math.max(0, c.top + d));
    if (edge === 'bottom') c.bottom = Math.max(c.top + 0.2, Math.min(1, c.bottom + d));
    if (edge === 'left') c.left = Math.min(c.right - 0.2, Math.max(0, c.left + d));
    if (edge === 'right') c.right = Math.max(c.left + 0.2, Math.min(1, c.right + d));
    placeBox();
  };

  const goPage = (d) => {
    const s = song(); if (!s) return;
    const k = st.pi + d;
    if (k >= 0 && k < s.pages.length) { st.pi = k; return draw(); }
    goSong(d, d < 0);
  };
  const goSong = (d, last = false) => {
    const list = shown(), k = list.findIndex((x) => x.id === st.sid);
    const nx = list[Math.max(0, Math.min(list.length - 1, (k < 0 ? 0 : k) + d))];
    if (!nx) return;
    st.sid = nx.id; st.pi = last ? nx.pages.length - 1 : 0; st.crop = null; draw();
  };
  // after an action on a page: the next page that still needs a trim in this song, else the next page
  // after a page is done: the next page, then the next song
  const onward = () => {
    const s = song();
    if (!s) return draw();
    if (st.pi < s.pages.length - 1) { st.pi++; return draw(); }
    goSong(1);
  };

  const busy = async (fn) => { if (st.busy) return; st.busy = true; try { await fn(); } catch (e) { toast(e.message); } finally { st.busy = false; drawHead(); } };

  const doTrim = () => {
    const c = st.crop;
    if (!c || !pg()) return;
    const whole = c.top <= 0.001 && c.bottom >= 0.999 && c.left <= 0.001 && c.right >= 0.999;
    if (whole && !pg().crop) return fine();
    if (whole) return original(true);
    const same = (a, b) => a && ['top', 'bottom', 'left', 'right'].every((k) => Math.abs(a[k] - b[k]) < 0.0005);
    if (same(pg().crop, c)) { st.crop = null; return onward(); }  // already cropped like this
    return busy(async () => {
      const s = song(), p = pg(), box = { top: c.top, bottom: c.bottom, left: c.left, right: c.right };
      const prev = st.carry;
      store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/trim`, box));
      st.carry = { box, sid: s.id, page: p.page, title: store.get(s.id)?.title || s.title };  // the next page (any song) starts with this box
      st.undo.push({ label: 'trim', run: async () => { store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/untrim`, {})); st.carry = prev; }, at: [s.id, st.pi] });
      await reloadSong(s.id); st.crop = null; onward();
    });
  };
  const fine = () => busy(async () => {
    const s = song(), p = pg();
    if (!p) return;
    const key = `${s.id}:${p.page}`;
    await api('POST', '/cleanup/ok', { key });
    st.undo.push({ label: 'page is fine', run: () => api('POST', '/cleanup/ok', { key, undo: true }), at: [s.id, st.pi] });
    await reloadSong(s.id); st.crop = null; onward();
  });
  const songGood = () => busy(async () => {
    const s = song(), key = `song:${s.id}`, was = s.reviewed;
    await api('POST', '/cleanup/ok', { key, undo: was });
    st.undo.push({ label: was ? 'needs a look' : 'song is good', run: () => api('POST', '/cleanup/ok', { key, undo: !was }), at: [s.id, 0] });
    const k = shown().findIndex((x) => x.id === s.id);
    await reloadSong(s.id);
    if (!was) toast(`“${s.title}” is good`);
    const after = shown();
    if (!after.some((x) => x.id === s.id)) { const nx = after[Math.min(k, after.length - 1)]; st.sid = nx?.id || null; st.pi = 0; st.crop = null; draw(); }
    else if (!was) goSong(1);
    else draw();
  });
  // undo every crop of this page (not undoable: the page is back to the photo it came in as)
  const original = (next = false) => busy(async () => {
    const s = song(), p = pg();
    if (!p?.trims) return;
    store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/untrim`, { all: true }));
    if (st.carry?.sid === s.id && st.carry.page === p.page) st.carry = null;  // only when this page was the source
    toast('Back to the original photo');
    await reloadSong(s.id);
    if (next === true) { st.crop = null; return onward(); }
    st.crop = { key: `${s.id}:${p.page}`, ...full(), from: 'Original photo' }; draw();
  });
  const undo = () => busy(async () => {
    const u = st.undo.pop();
    if (!u) return toast('Nothing to undo');
    await u.run();
    toast(`Undone: ${u.label}`);
    if (u.tab) { st.tab = u.tab; if (u.sortId) { st.sort.id = u.sortId; st.sort.summary = false; } }
    if (u.at) { await reloadSong(u.at[0]); if (st.tab === 'songs') { st.sid = u.at[0]; st.pi = u.at[1]; if (!shown().some((x) => x.id === st.sid)) st.filter = 'all'; } }
    else if (!u.sortId) await load();
    st.crop = u.box ? { ...u.box } : null; draw();
  });

  const delSong = () => busy(async () => {
    const s = song();
    if (!(await confirmSheet({ title: `Delete “${s.title}”?`, body: 'It goes to the Trash. Undo brings it back.', ok: 'Delete', danger: true }))) return;
    const k = shown().findIndex((x) => x.id === s.id);
    store.bin([s.id]);
    st.undo.push({ label: 'delete', run: async () => { store.restore([s.id]); await new Promise((r) => setTimeout(r, 400)); await load(); }, at: [s.id, 0] });
    st.songs = st.songs.filter((x) => x.id !== s.id);
    const nx = shown()[Math.min(k, shown().length - 1)];
    st.sid = nx?.id || null; st.pi = 0; st.crop = null;
    toast('Deleted — Undo brings it back'); draw();
  });
  // split: tick the pages that belong to another song; they become a new song
  const splitSong = () => {
    const s = song(), it = store.get(s.id), ver = it?.updatedAt || 0;
    if (s.pages.length < 2) return toast('One page — nothing to split');
    const pick = new Set(s.pages.filter((x, k) => k >= Math.max(1, st.pi)).map((x) => x.page));
    const m = modal(`<h2>Split “${esc(s.title)}”</h2>
      <p class="muted small">Tick the pages that belong to another song. They become a new song.</p>
      <div class="cu-pick">${s.pages.map((x) => `<button type="button" data-p="${x.page}" class="${pick.has(x.page) ? 'on' : ''}">
        <img src="${store.fileUrl(s.id, it?.pageFiles?.[x.page - 1] || x.file)}?v=${ver}" alt=""><span>${x.page}${x.dots ? ` · dot ${x.dots.lit ?? '?'}/${x.dots.count}` : ''}</span></button>`).join('')}</div>
      <label class="field">New song's title <input id="cu-st" value="${esc(s.title)} (part 2)"><small class="bs-det muted" id="cu-st-det"></small></label>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Split</button></div>`, { wide: true });
    // the new song's title: read off the first page that moves (again when that page changes)
    const fill = titleBox($('#cu-st', m.el), $('#cu-st-det', m.el), s.id, `${s.title} (part 2)`, ver);
    let first = 0;
    const refill = () => { const f = Math.min(...pick); if (pick.size && f !== first) { first = f; fill(f); } };
    refill();
    m.el.querySelector('.cu-pick').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; const n = +b.dataset.p; pick.has(n) ? pick.delete(n) : pick.add(n); b.classList.toggle('on', pick.has(n)); refill(); };
    m.el.querySelector('[data-ok]').onclick = () => busy(async () => {
      if (!pick.size || pick.size === s.pages.length) return toast('Tick some pages, not all of them');
      const r = await api('POST', `/items/${s.id}/split`, { pages: [...pick], title: $('#cu-st', m.el).value.trim() });
      store.putItem(r.item); store.putItem(r.new);
      m.close();
      toast(`New song “${r.new.title}” (${r.new.pages} p)`, { label: 'Open', run: () => go(`#/item/${r.new.id}`) });
      await load(); st.crop = null; st.pi = 0; draw();
    });
  };

  // rename: the title box becomes editable; Enter saves, Esc cancels
  const setTitle = async (id, title) => store.putItem(await api('PATCH', `/items/${id}`, { title }));
  const rename = (id = st.tab === 'songs' ? st.sid : st.titles[st.ti]?.id) => {
    const inp = st.tab === 'songs' ? $('#cu-title', body) : body.querySelector(`.cu-trow[data-id="${id}"] input`);
    const it = store.get(id);
    if (!inp || !it) return;
    st.renaming = true;
    inp.readOnly = false; inp.focus(); inp.select();
    const old = it.title;
    const done = (save) => {
      inp.onkeydown = inp.onblur = null; inp.readOnly = true; st.renaming = false;
      const t = inp.value.trim();
      if (!save || !t || t === old) { inp.value = old; return; }
      busy(async () => {
        await setTitle(id, t);
        st.undo.push({ label: 'rename', run: async () => { await setTitle(id, old); }, at: st.tab === 'songs' ? [id, st.pi] : null });
        toast(`Renamed to “${t}”`);
        await reloadSong(id); // file names follow the title
        if (st.tab === 'titles') st.ti = Math.min(st.ti, st.titles.length - 1);
        draw();
      });
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };

  // ---------- note for Claude: saves as you type (600 ms), on blur and before moving on; never drops text ----------
  const hasNote = (id) => !!st.notes[id]?.trim();
  const noteBox = (id) => `<div class="cu-note"><textarea id="cu-note" rows="2" maxlength="2000" enterkeyhint="done" aria-label="Note for Claude"
      placeholder="Note for Claude — what should happen to this sheet?">${esc(st.notes[id] || '')}</textarea><span class="cu-note-st" id="cu-note-st" aria-live="polite"></span></div>`;
  const noteSaved = (id, ok) => {
    const el = $('#cu-note-st', body);
    if (!el || body.querySelector('#cu-note')?.dataset.id !== id) return;
    el.textContent = ok ? 'Saved' : 'Not saved — will retry';
    el.classList.toggle('bad', !ok); el.classList.add('on');
    clearTimeout(el._t); if (ok) el._t = setTimeout(() => el.classList.remove('on'), 1500);
  };
  const flushNote = () => {
    const due = st.noteDue; if (!due) return;
    clearTimeout(due.timer); st.noteDue = null;
    const { id } = due, text = st.notes[id] || '';
    fetch('/api/cleanup/notes', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) })
      .then((r) => { if (!r.ok) throw 0; noteSaved(id, true); })
      .catch(() => { if (!st.noteDue) st.noteDue = { id, timer: setTimeout(flushNote, 5000) }; noteSaved(id, false); });
  };
  const wireNote = (id) => {
    const ta = $('#cu-note', body); if (!ta) return;
    ta.dataset.id = id;
    ta.oninput = () => {
      st.notes[id] = ta.value;
      if (st.noteDue && st.noteDue.id !== id) flushNote();
      clearTimeout(st.noteDue?.timer); st.noteDue = { id, timer: setTimeout(flushNote, 600) };
      const f = body.querySelector('.sv-show [data-show="note"] i'); if (f) f.textContent = st.songs.filter((x) => hasNote(x.id)).length;
    };
    ta.onblur = flushNote;
    ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); ta.blur(); } };
  };
  addEventListener('pagehide', flushNote);
  addEventListener('hashchange', flushNote, { once: true });

  // ---------- Go through sheets: Delete / Keep, one sheet at a time ----------
  const sheets = () => st.songs; // every sheet (no books), A–Z (the Mac's order)
  const sortList = () => sheets().filter((x) => st.sort.show === 'all' || (st.sort.show === 'note' ? hasNote(x.id) : st.sort.show === 'todo' ? !st.sort.dec[x.id] : st.sort.dec[x.id] === st.sort.show));
  // only decisions about sheets still in Clean up count (deleted sheets, books, merged ones don't)
  const counts = () => { const ids = new Set(sheets().map((x) => x.id)); const v = Object.entries(st.sort.dec).filter(([id]) => ids.has(id)).map(([, d]) => d); return { del: v.filter((x) => x === 'delete').length, keep: v.filter((x) => x === 'keep').length }; };
  const drawSort = (force = true) => {
    if (force) flushNote();
    if (st.sort.summary) return drawSummary();
    const all = sheets(), list = sortList();
    if (!st.sort.id || !all.some((x) => x.id === st.sort.id)) st.sort.id = list[0]?.id || (st.sort.show === 'all' ? all[0]?.id : null) || null;
    const s = all.find((x) => x.id === st.sort.id), it = s && store.get(s.id), n = counts();
    const pos = all.findIndex((x) => x.id === st.sort.id);
    const showBtns = [['todo', 'Not decided', all.length - n.del - n.keep], ['delete', 'To delete', n.del], ['keep', 'Kept', n.keep], ['note', 'With a note', all.filter((x) => hasNote(x.id)).length], ['all', 'All', all.length]]
      .map(([k, l, c]) => `<button data-show="${k}" class="${st.sort.show === k ? 'on' : ''}">${l} <i>${c}</i></button>`).join('');
    if (!force && body.dataset.sid === st.sort.id) { const f = body.querySelector('.sv-show'); if (f) f.innerHTML = showBtns; return; }
    body.dataset.sid = st.sort.id || '';
    if (!s) { body.innerHTML = `<div class="sv"><div class="sv-top"><div class="cu-filter sv-show">${showBtns}</div></div><p class="pad muted">${st.scan?.running ? 'Checking pages…' : st.sort.show === 'todo' && all.length ? `All ${all.length} sheets are decided ✓${n.del ? ` — ${n.del} marked to delete: tap Finish.` : ''}` : 'No sheets here.'}</p>${st.sort.show === 'todo' && n.del ? `<div class="sv-act"><button id="sv-finish" class="danger-btn big">Finish — delete ${n.del} ›</button></div>` : ''}</div>`; return wireSort(); }
    const dec = st.sort.dec[s.id];
    body.innerHTML = `<div class="sv">
      <div class="sv-top">
        <div class="cu-filter sv-show">${showBtns}</div>
        <span class="grow"></span>
        <button id="sv-finish" class="ghost" ${n.del ? '' : 'disabled'}>Finish — delete ${n.del} ›</button>
      </div>
      <div class="sv-head">
        <button id="sv-prev" class="ghost big" aria-label="Previous sheet">‹</button>
        <div class="sv-title"><b>${esc(it?.title || s.title)}</b>
          <small>Sheet · ${s.pages.length} page${s.pages.length === 1 ? '' : 's'} · ${pos + 1} of ${all.length}${dec ? ` · <span class="sv-dec ${dec}">${dec === 'delete' ? 'marked to delete' : 'kept'}</span>` : ''}</small>
          <div class="cu-issues">${chips(s)}</div>
          ${noteBox(s.id)}</div>
        <button id="sv-next" class="ghost big" aria-label="Next sheet">›</button>
      </div>
      <div class="sv-pages" id="sv-pages">${s.pages.length ? s.pages.map((p, k) => `<figure><img src="/api/items/${encodeURIComponent(s.id)}/thumb/${p.page}?w=1000&v=${it?.updatedAt || 0}" alt="Page ${p.page}" ${k ? 'loading="lazy"' : 'fetchpriority="high"'}><figcaption>${p.page} / ${s.pages.length}</figcaption></figure>`).join('') : '<p class="pad muted">No pages.</p>'}</div>
      <div class="sv-act">
        <button id="sv-del" class="danger-btn big ${dec === 'delete' ? 'on' : ''}">Delete <kbd>D</kbd></button>
        <button id="sv-keep" class="primary big ${dec === 'keep' ? 'on' : ''}">Keep <kbd>K</kbd></button>
      </div></div>`;
    wireSort();
  };
  const wireSort = () => {
    if (st.sort.id) wireNote(st.sort.id);
    body.querySelector('.sv-show').onclick = (e) => { const b = e.target.closest('[data-show]'); if (b) { st.sort.show = b.dataset.show; st.sort.id = sortList()[0]?.id || null; drawSort(); } };
    $('#sv-finish', body)?.addEventListener('click', () => { st.sort.summary = true; drawSort(); });
    $('#sv-prev', body)?.addEventListener('click', () => sortStep(-1));
    $('#sv-next', body)?.addEventListener('click', () => sortStep(1));
    $('#sv-del', body)?.addEventListener('click', () => decide('delete'));
    $('#sv-keep', body)?.addEventListener('click', () => decide('keep'));
  };
  // previous / next in the list being shown (the current one stays reachable even once decided)
  const sortStep = (d) => {
    if (st.sort.summary) return;
    const all = sheets(), list = sortList();
    const cur = all.findIndex((x) => x.id === st.sort.id);
    let nx;
    if (d > 0) nx = list.find((x) => all.indexOf(x) > cur);
    else nx = all[cur - 1]; // back = the one just before, decided or not (to change your mind)
    if (!nx) return toast(d > 0 ? 'That was the last one' : 'That is the first one');
    st.sort.id = nx.id; drawSort();
  };
  const decide = (what) => busy(async () => {
    const s = sheets().find((x) => x.id === st.sort.id);
    if (!s || st.sort.summary) return;
    const was = st.sort.dec[s.id] || null;
    const next = was === what ? null : what; // pressing it again takes it back
    st.sort.dec = (await api('POST', '/cleanup/sort', { id: s.id, decision: next })).decisions;
    st.undo.push({ label: next ? (next === 'delete' ? 'delete mark' : 'keep') : 'unmark', tab: 'sort', sortId: s.id,
      run: async () => { st.sort.dec = (await api('POST', '/cleanup/sort', { id: s.id, decision: was })).decisions; } });
    if (!next) return drawSort();
    const all = sheets(), cur = all.findIndex((x) => x.id === s.id);
    const nx = sortList().find((x) => all.indexOf(x) > cur) || sortList()[0];
    if (!nx) { st.sort.summary = true; return drawSort(); }
    st.sort.id = nx.id; drawSort();
  });
  const drawSummary = () => {
    const n = counts(), del = sheets().filter((x) => st.sort.dec[x.id] === 'delete');
    const left = sheets().length - n.del - n.keep;
    body.dataset.sid = '';
    body.innerHTML = `<div class="sv sv-sum">
      <div class="sv-top"><button id="sv-back" class="ghost">‹ Back to the sheets</button></div>
      <h2>${n.del ? `${n.del} sheet${n.del === 1 ? '' : 's'} to delete` : 'Nothing marked to delete'}</h2>
      <p class="muted">${n.keep} kept · ${left} not looked at yet. Tap a sheet to keep it after all.</p>
      <div class="sv-grid">${del.map((x) => { const it = store.get(x.id); return `<button data-id="${x.id}" class="on">${x.pages.length ? `<img src="/api/items/${encodeURIComponent(x.id)}/thumb/1?w=240&v=${it?.updatedAt || 0}" alt="" loading="lazy">` : '<div class="sv-nopage">No pages</div>'}<span>${esc(it?.title || x.title)}</span><small>${x.pages.length} p</small></button>`; }).join('')}</div>
      ${n.del ? `<div class="sv-act"><button id="sv-go" class="danger-btn big">Delete ${n.del} sheet${n.del === 1 ? '' : 's'}</button></div>` : ''}</div>`;
    $('#sv-back', body).onclick = () => { st.sort.summary = false; drawSort(); };
    body.querySelector('.sv-grid').onclick = (e) => { const b = e.target.closest('[data-id]'); if (!b) return;
      busy(async () => { const id = b.dataset.id; st.sort.dec = (await api('POST', '/cleanup/sort', { id, decision: 'keep' })).decisions;
        st.undo.push({ label: 'keep', tab: 'sort', run: async () => { st.sort.dec = (await api('POST', '/cleanup/sort', { id, decision: 'delete' })).decisions; st.sort.summary = true; } }); drawSummary(); }); };
    $('#sv-go', body)?.addEventListener('click', () => reallyDelete(del.map((x) => x.id)));
  };
  // the deletes really happen: to the Trash first (Undo brings them back), then, if wanted, for good
  const reallyDelete = (ids) => busy(async () => {
    if (!(await confirmSheet({ title: `Delete ${ids.length} sheet${ids.length === 1 ? '' : 's'}?`, body: 'They go to the Trash now. Undo brings them back.', ok: 'Delete', danger: true }))) return;
    store.bin(ids);
    await api('POST', '/cleanup/sort', { clear: ids });
    st.undo.push({ label: `delete ${ids.length}`, tab: 'sort', run: async () => { store.restore(ids); for (const id of ids) await api('POST', '/cleanup/sort', { id, decision: 'delete' }); await new Promise((r) => setTimeout(r, 400)); await load(); st.sort.summary = true; } });
    st.songs = st.songs.filter((x) => !ids.includes(x.id));
    st.sort.dec = (await api('GET', '/cleanup/sort')).decisions;
    store.logEvent('cleanup', `Deleted ${ids.length} sheets`, 'Clean up → Go through sheets');
    body.innerHTML = `<div class="sv sv-sum"><h2>${ids.length} sheet${ids.length === 1 ? '' : 's'} deleted</h2>
      <p class="muted">They are in the Trash for now. Undo brings them back.</p>
      <div class="sv-act"><button id="sv-again" class="primary big">Go on with the rest</button>
      <button id="sv-purge" class="danger-btn">Also remove them from the Trash for good…</button></div></div>`;
    $('#sv-again', body).onclick = () => { st.sort.summary = false; st.sort.show = 'todo'; st.sort.id = null; drawSort(); };
    $('#sv-purge', body).onclick = async () => {
      if (!(await confirmSheet({ title: `Delete ${ids.length} sheet${ids.length === 1 ? '' : 's'} for good?`, body: 'Their photos are removed from the Mac. This cannot be undone.', ok: 'Delete for good', danger: true }))) return;
      store.purge(ids);
      st.undo = st.undo.filter((u) => !u.label.startsWith('delete ')); drawHead();
      toast(`${ids.length} sheets deleted for good`);
      st.sort.summary = false; st.sort.id = null; drawSort();
    };
  });

  // suggested names (from Claude): edit if needed, then Use this or Keep mine
  const sugHtml = () => (st.sug.length ? `<section class="cu-sug"><h3>Suggested names (${st.sug.length})</h3><ul>${st.sug.map((x) => `<li class="cu-srow" data-id="${x.id}">
    <div class="cu-scur"><small class="muted">Now</small> <b>${esc(x.title)}</b>${x.artist ? ` <span class="muted">· ${esc(x.artist)}</span>` : ''} <a class="link small" href="#/item/${x.id}" target="_blank">Open</a></div>
    <label><small class="muted">Title</small><input data-k="title" value="${esc(x.suggest.title ?? x.title)}" aria-label="Suggested title"></label>
    <label><small class="muted">Artist</small><input data-k="artist" value="${esc(x.suggest.artist ?? x.artist)}" aria-label="Suggested artist"></label>
    <small class="muted cu-why">${esc(x.why)}</small>
    <div class="cu-sbtn"><button class="ghost small" data-keep>Keep mine</button><button class="primary small" data-use>Use this</button></div></li>`).join('')}</ul></section>` : '');
  const sugDone = (id, action) => busy(async () => {
    const li = body.querySelector(`.cu-srow[data-id="${id}"]`), x = st.sug.find((s) => s.id === id); if (!li || !x) return;
    const v = (k) => li.querySelector(`[data-k="${k}"]`).value.trim();
    const r = await api('POST', `/cleanup/suggest/${id}/done`, action === 'accept' ? { action, title: v('title') || x.title, artist: v('artist') } : { action });
    if (r.item) store.putItem(r.item);
    st.undo.push({ label: action === 'accept' ? 'rename' : 'keep mine', run: async () => { const u = await api('POST', `/cleanup/suggest/${id}/done`, { action: 'undo' }); if (u.item) store.putItem(u.item); } });
    toast(action === 'accept' ? `Renamed to “${r.item.title}”` : 'Kept the name');
    st.sug = st.sug.filter((s) => s.id !== id);
    await reloadSong(id); st.ti = Math.min(st.ti, Math.max(0, st.titles.length - 1)); drawTitles(); drawHead();
  });
  const drawTitles = () => {
    if (!st.titles.length) { body.innerHTML = sugHtml() + '<p class="pad muted">No odd titles. 🎉</p>'; return wireSug(); }
    body.innerHTML = sugHtml() + `<p class="pad small muted">Titles that look like file names, page numbers or typos. R or click to rename · F if it's fine · Z to undo.</p>
      <ul class="cu-titles">${st.titles.map((x, k) => `<li class="cu-trow ${k === st.ti ? 'on' : ''}" data-id="${x.id}" data-k="${k}">
        <input value="${esc(store.get(x.id)?.title ?? x.title)}" readonly aria-label="Title">
        <span class="badge k-${x.kind}">${x.kind}</span><small class="muted">${esc(x.why)}</small>
        <a class="link small" href="#/item/${x.id}" target="_blank">Open</a>
        <button class="ghost small" data-fine>Fine</button></li>`).join('')}</ul>`;
    wireSug();
    body.querySelector('.cu-trow.on')?.scrollIntoView({ block: 'nearest' });
    body.querySelector('.cu-titles').onclick = (e) => {
      const li = e.target.closest('[data-k]'); if (!li) return;
      st.ti = +li.dataset.k;
      if (e.target.closest('[data-fine]')) return titleFine();
      if (e.target.tagName === 'INPUT') { drawTitles(); rename(li.dataset.id); }
      else drawTitles();
    };
  };
  const wireSug = () => {
    const sec = body.querySelector('.cu-sug'); if (!sec) return;
    sec.onclick = (e) => { const li = e.target.closest('.cu-srow'); if (!li) return; if (e.target.closest('[data-use]')) sugDone(li.dataset.id, 'accept'); else if (e.target.closest('[data-keep]')) sugDone(li.dataset.id, 'dismiss'); };
    sec.onkeydown = (e) => { if (e.target.tagName !== 'INPUT') return; e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); sugDone(e.target.closest('.cu-srow').dataset.id, 'accept'); } };
  };
  const titleFine = () => busy(async () => {
    const x = st.titles[st.ti]; if (!x) return;
    const key = `title:${x.id}`;
    await api('POST', '/cleanup/ok', { key });
    st.undo.push({ label: 'title is fine', run: () => api('POST', '/cleanup/ok', { key, undo: true }) });
    await reloadSong(x.id); st.ti = Math.min(st.ti, st.titles.length - 1); drawTitles(); drawHead();
  });
  const step = (d) => { st.ti = Math.max(0, Math.min(st.titles.length - 1, st.ti + d)); drawTitles(); };

  const rescan = () => busy(async () => { st.scan = await api('POST', '/cleanup/scan'); drawHead(); setTimeout(load, 1500); });
  const trimAll = async () => {
    const todo = st.songs.filter((s) => !s.reviewed && !s.book).flatMap((s) => s.pages.filter((p) => p.trim).map((p) => ({ id: s.id, p })));
    if (!(await confirmSheet({ title: `Trim all ${todo.length} pages the Mac suggests?`, body: 'Each page is trimmed as suggested. The original photos are kept — any page can go back with Original photo.', ok: 'Trim all' }))) return;
    const m = modal(`<h2>Trimming…</h2><progress id="cu-p" max="${todo.length}" value="0"></progress><p class="muted small" id="cu-pm"></p>`);
    let n = 0;
    st.busy = true;
    for (const { id, p } of todo) {
      if (!m.el.isConnected) break;
      try { store.putItem(await api('POST', `/items/${id}/pages/${p.page}/trim`, { top: p.trim.top, bottom: p.trim.bottom, left: p.trim.left ?? 0, right: p.trim.right ?? 1 })); } catch {}
      n++; $('#cu-p', m.el).value = n; $('#cu-pm', m.el).textContent = `${n} / ${todo.length}`;
    }
    st.busy = false;
    m.close();
    store.logEvent('cleanup', `Trimmed ${n} pages`);
    toast(`Trimmed ${n} pages`); await load();
  };

  $('.cu-tabs', main).onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { st.tab = b.dataset.tab; draw(); } };
  $('#cu-undo', main).onclick = undo;
  const help = () => modal(`<h2>Keyboard shortcuts</h2><table class="cu-keys">${KEYS[st.tab === 'songs' ? 'fix' : st.tab].map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
  $('#cu-more', main).onclick = (e) => menu(e.currentTarget, [
    ...(st.songs.some((x) => !x.reviewed && !x.book && x.pages.some((p) => p.trim)) ? [{ label: 'Trim every page the Mac suggests…', icon: 'tools', run: trimAll }] : []),
    { label: 'Check all pages again', icon: 'wave', run: rescan },
    { label: 'Keyboard shortcuts', icon: 'info', run: help },
  ]);

  const onKey = (e) => {
    if (!main.isConnected || !location.hash.startsWith('#/cleanup') || !body.isConnected) return removeEventListener('keydown', onKey);
    if (st.renaming || document.querySelector('.modal') || e.target.matches?.('input:not([readonly]), textarea')) return;
    const k = e.key, songs = st.tab === 'songs';
    if (st.tab === 'books') return books.onKey(e);
    if (st.tab === 'sort') {
      const a = { d: () => decide('delete'), Delete: () => decide('delete'), Backspace: () => decide('delete'), k: () => decide('keep'), Enter: () => decide('keep'),
        ArrowRight: () => sortStep(1), ArrowLeft: () => sortStep(-1), z: undo, u: undo, '?': help,
        ArrowDown: () => $('#sv-pages', body)?.scrollBy({ top: 300, behavior: 'smooth' }), ArrowUp: () => $('#sv-pages', body)?.scrollBy({ top: -300, behavior: 'smooth' }),
        ' ': () => $('#sv-pages', body)?.scrollBy({ top: (e.shiftKey ? -1 : 1) * $('#sv-pages', body).clientHeight * 0.85, behavior: 'smooth' }),
        1: () => { st.tab = 'sort'; draw(); }, 2: () => { st.tab = 'songs'; draw(); }, 3: () => { st.tab = 'titles'; draw(); } }[k.length === 1 ? k.toLowerCase() : k];
      if (!a || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
      e.preventDefault(); return a();
    }
    if (songs && e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); return nudge(e.shiftKey ? 'right' : 'left', k === 'ArrowLeft' ? -0.005 : 0.005); }
    const act = {
      Enter: () => (songs ? doTrim() : rename()), t: () => songs && doTrim(),
      f: () => (songs ? fine() : titleFine()), g: () => songs && songGood(),
      ArrowRight: () => songs && goPage(1), j: () => (songs ? goPage(1) : step(1)),
      ArrowLeft: () => songs && goPage(-1), k: () => (songs ? goPage(-1) : step(-1)),
      ']': () => songs && goSong(1), n: () => songs && goSong(1), '[': () => songs && goSong(-1), p: () => songs && goSong(-1),
      ArrowUp: () => (songs ? nudge(e.shiftKey ? 'bottom' : 'top', -0.005) : step(-1)),
      ArrowDown: () => (songs ? nudge(e.shiftKey ? 'bottom' : 'top', 0.005) : step(1)),
      x: () => { if (songs && pg()) { st.crop = startBox(song(), pg(), 'suggested'); draw(); } },
      c: () => { if (songs && st.crop) { Object.assign(st.crop, full(), { from: 'Whole page' }); placeBox(); } },
      r: () => rename(), z: () => undo(), u: () => undo(), o: () => songs && original(),
      s: () => songs && splitSong(), Delete: () => songs && delSong(), Backspace: () => songs && delSong(),
      1: () => { st.tab = 'sort'; draw(); }, 2: () => { st.tab = 'songs'; draw(); }, 3: () => { st.tab = 'titles'; draw(); }, '?': help,
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!act || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    e.preventDefault(); act();
  };
  addEventListener('keydown', onKey);
  load();
}
