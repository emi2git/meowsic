// Manage library: two tabs — Organize pages (#/manage; #/cleanup and #/organize go here too) and Trash
// (#/manage/trash; #/bin and #/trash go there). Organize pages: any sheet or book, its pages in a grid —
//  · split   tap the page where a new song starts (the Mac reads its title); "Make N new sheets…" moves each
//            song into its own sheet (books: pages before the first start stay in the book)
//  · merge   untap a start to join two songs of this sheet; Merge… adds the pages of another sheet after these
//  · reorder drag a page (touch: hold, then drag; Mac: drag), or its ‹ › buttons; a page can move into the
//            song before / after it (song starts stay on their pages)
//  · delete  ✕ on a page: it moves to items/<folder>/.history/ (never deleted for good); the last page → Trash
// Every change goes to the Mac at once and gets an Activities row; Undo here rolls that row back.
// Recommended to check: Refresh runs a scan on the Mac (a job, with progress) that lists fishy sheets and books
// with a reason each, most likely first. "This is a complete song" hides one from every scan (undoable;
// Show hidden lists them).
import { store } from '../store.js';
import { isDesktop, isNarrow, isTouch } from '../device.js';
import { $, esc, toast, ago, sheet as modal, confirmSheet } from '../ui.js';
import { binView } from './organize.js';

const KEYS = [
  ['← → ↑ ↓', 'Move between pages'],
  ['S / Enter', 'A new song starts here (again: not)'],
  ['⇧← / ⇧→', 'Move the page left / right'],
  ['Delete', 'Delete the page (kept in history; Undo brings it back)'],
  ['Space', 'View the page large'],
  ['U / Z', 'Undo'],
];
const SEGS = 6; // colours for the songs (seg-0 … seg-5), then they repeat
const KIND = { several: 'Several songs?', merge: 'One song in parts?', order: 'Page order?', duplicate: 'Same page twice?', blank: 'Blank page?' };
const LIST_MAX = 300;
const UNDO = [];  // Undo here outlives the view: open a sheet, come back, Undo still works (the Mac keeps the real history)

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.detail && (data.detail.message || (typeof data.detail === 'string' ? data.detail : ''))) || 'The Mac said no.');
  return data;
};
const range = (a, b) => (a === b ? `page ${a}` : `pages ${a}–${b}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the header: Manage library with its two tabs (links, so Back / reload keep the tab)
const head = (tab, right = '') => `<header class="top cu-top">
      <a class="icon-btn back cu-back" href="#/library" aria-label="Back to the library">‹ Library</a>
      <h1>Manage library</h1>
      <nav class="cu-tabs" aria-label="Manage library">
        <a href="#/manage" data-tab="organize" class="${tab === 'organize' ? 'on' : ''}" ${tab === 'organize' ? 'aria-current="page"' : ''}>Organize pages</a>
        <a href="#/manage/trash" data-tab="trash" class="${tab === 'trash' ? 'on' : ''}" ${tab === 'trash' ? 'aria-current="page"' : ''}>Trash <i id="cu-ntrash">${store.items({ deleted: true }).length || ''}</i></a></nav>
      <span class="grow"></span>${right}</header>`;

export function cleanupView(main, { parts = [], q } = {}) {
  if (parts[1] === 'trash') {  // Manage library → Trash: restore, delete for good, Empty Trash (views/organize.js)
    main.innerHTML = head('trash') + '<div class="cu trash" id="cu"></div>';
    const off1 = binView($('#cu', main), { embedded: true });
    const off2 = store.on(() => { const n = $('#cu-ntrash', main); if (n) n.textContent = store.items({ deleted: true }).length || ''; });
    return () => { off1?.(); off2(); };
  }
  if (store.mode !== 'server') {
    main.innerHTML = head('organize') + '<p class="pad muted">Organize pages needs the Mac.</p>';
    return;
  }
  let id0 = q?.get?.('id') || null;
  if (!id0) { try { id0 = localStorage.getItem('meowsic-org-id') || localStorage.getItem('meowsic-cu-songsplit'); } catch {} }
  const bs = { items: null, scan: null, job: null, id: id0, book: null, starts: {}, focus: 1, list: !id0 || (isNarrow() && !q?.get?.('id')), saving: {}, loading: false,
    q: Promise.resolve(), det: {}, sug: null, find: '', hidden: false, undo: UNDO, busy: false, drag: null, alive: true };
  main.innerHTML = head('organize', `<button id="cu-undo" class="cu-undo" disabled title="Undo (U)">↶ Undo</button>
      <button id="cu-help" class="icon-btn" aria-label="Help" title="Help">?</button>`) + '<div class="cu organize" id="cu"></div>';
  const body = $('#cu', main);
  const it = () => bs.items?.find((b) => b.id === bs.id);
  const SH = () => !(bs.book?.book ?? it()?.book);          // a sheet (page 1 starts song 1) or a book
  const BASE = () => (SH() ? '/sheets' : '/books');
  const det = (p, id = bs.id) => (bs.det[`${id}:${p}`] ||= {});

  // ---------- undo (each entry rolls back an Activities row, or puts marks back) ----------
  const drawHead = () => {
    const u = bs.undo.at(-1), ub = $('#cu-undo', main);
    if (!ub) return;
    ub.disabled = !u || bs.busy;
    ub.textContent = u ? `↶ Undo ${u.label}` : '↶ Undo';
  };
  const busy = async (fn) => { if (bs.busy) return; bs.busy = true; drawHead(); try { return await fn(); } catch (e) { toast(e.message); } finally { bs.busy = false; drawHead(); } };
  const undo = () => busy(async () => {
    const u = bs.undo.pop();
    if (!u) return toast('Nothing to undo');
    await bs.q;
    await u.run();
    toast(`Undone: ${u.label}`);
    bs.book = null;
    await reload();
  });
  const pushAct = (label, aid, ids) => {
    if (!aid) return;
    bs.undo.push({ label, run: async () => {
      await api('POST', `/activity/${encodeURIComponent(aid)}/undo`, {});
      for (const i of ids) { try { store.putItem(await api('GET', `/items/${encodeURIComponent(i)}`)); } catch {} }
    } });
    drawHead();
  };

  // ---------- loading ----------
  const reload = async () => { bs.items = null; await draw(); };
  const fetchAll = async () => { const r = await api('GET', '/organize'); bs.items = r.items; bs.scan = r.scan; if (r.job && !bs.job) watchJob(r.job.id); };
  const fetchBook = async () => {
    const d = await api('GET', `/sheets/${encodeURIComponent(bs.id)}/split`);
    d.book = !!it()?.book;
    bs.book = d; bs.starts = { ...d.starts }; bs.sug = null;
    bs.focus = Math.max(1, Math.min(bs.focus, d.pages || 1));
  };

  const draw = async () => {
    if (!bs.items || (bs.id && !bs.book)) {
      if (bs.loading) return;
      bs.loading = true;
      if (!body.querySelector('.bs')) body.innerHTML = '<p class="pad muted">Loading…</p>';
      try {
        if (!bs.items) await fetchAll();
        if (bs.id && !it()) { bs.id = null; bs.list = true; }
        if (!bs.id && !isNarrow()) bs.id = bs.scan?.candidates?.[0]?.id || bs.items[0]?.id || null;
        if (bs.id) await fetchBook();
      } catch (e) { toast(e.message); bs.loading = false; return; }
      bs.loading = false;
      if (!bs.alive) return;
    }
    render();
  };

  // ---------- the side: Recommended to check, then every sheet and book ----------
  const candHtml = () => {
    const cs = bs.scan?.candidates || [];
    if (!bs.scan) return '<p class="muted small og-empty">Refresh looks through the whole library for sheets that hold several songs, songs split in two, pages out of order, twice or blank.</p>';
    if (!cs.length) return `<p class="muted small og-empty">Nothing to check. 🎉</p>`;
    return `<ol class="bs-list og-cands" id="og-cands">${cs.map((c, k) => `<li data-id="${esc(c.id)}" data-k="${k}" class="og-c ${c.id === bs.id ? 'on' : ''}">
      <b>${esc(c.title)}</b><small><span class="og-kind k-${c.kind}">${esc(KIND[c.kind] || c.kind)}</span> ${esc(c.reason)}</small>
      <button class="ghost small og-done" data-done="${esc(c.id)}" title="This is a complete song — don’t bring it up again">✓ Complete song</button></li>`).join('')}</ol>`;
  };
  const scanLine = () => (bs.job ? `<progress id="og-prog" max="1" value="${bs.job.progress || 0}"></progress><span class="muted small" id="og-progt">Checking pages… ${Math.round((bs.job.progress || 0) * 100)}%</span>`
    : bs.scan ? `<span class="muted small">${bs.scan.candidates.length} to check · looked ${esc(ago(bs.scan.at))}</span>` : '');
  const itemsHtml = () => {
    const f = bs.find.trim().toLowerCase();
    const xs = bs.items.filter((x) => !f || x.title.toLowerCase().includes(f));
    return xs.slice(0, LIST_MAX).map((b) => {
      const n = Object.keys(b.id === bs.id ? bs.starts : b.starts).length;
      return `<li data-id="${esc(b.id)}" class="${b.id === bs.id ? 'on' : ''} ${n ? 'marked' : ''}"><b>${esc(b.title)}</b><small>${b.book ? 'Book · ' : ''}${plural(b.pages, 'page')}${n ? ` · <span class="bs-cnt">${plural(n, 'start')} marked</span>` : ''}${b.reviewed ? ' · complete song' : ''}</small></li>`;
    }).join('') + (xs.length > LIST_MAX ? `<li class="og-more muted small">${xs.length - LIST_MAX} more — type to find them</li>` : '') + (!xs.length ? '<li class="og-more muted small">No sheet or book with that name</li>' : '');
  };
  const hiddenHtml = () => {
    const xs = bs.items.filter((x) => x.reviewed);
    return `<div class="og-hidden-list" ${bs.hidden ? '' : 'hidden'}><p class="og-h muted small">Marked as complete songs (${xs.length}) — scans leave these out</p>
      <ol class="bs-list">${xs.map((b) => `<li data-id="${esc(b.id)}"><b>${esc(b.title)}</b><button class="ghost small" data-again="${esc(b.id)}">Check again</button></li>`).join('') || '<li class="og-more muted small">None yet</li>'}</ol></div>`;
  };
  const sideHtml = () => `
    <section class="og-rec"><div class="og-rec-h"><b>Recommended to check</b><span class="grow"></span><button id="og-refresh" class="ghost" ${bs.job ? 'disabled' : ''}>↻ Refresh</button></div>
      <div class="og-scan" id="og-scan">${scanLine()}</div><div id="og-candwrap">${candHtml()}</div>
      <label class="og-showh small"><input type="checkbox" id="og-hidden" ${bs.hidden ? 'checked' : ''}> Show hidden</label><div id="og-hidwrap">${hiddenHtml()}</div></section>
    <section class="og-all"><div class="og-rec-h"><b>All sheets and books</b><span class="muted small">${bs.items.length}</span></div>
      <input id="og-find" type="search" placeholder="Find a sheet or book" value="${esc(bs.find)}" aria-label="Find a sheet or book" enterkeyhint="search">
      <ol class="bs-list og-items" id="bs-list">${itemsHtml()}</ol></section>`;
  const paintSide = () => {
    const s = $('#og-side', body); if (!s) return;
    const top = s.scrollTop, focused = document.activeElement?.id === 'og-find';
    s.innerHTML = sideHtml(); wireSide(); s.scrollTop = top;
    if (focused) { const f = $('#og-find', body); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  };
  const wireSide = () => {
    const s = $('#og-side', body);
    s.onclick = (e) => {
      const done = e.target.closest('[data-done]'); if (done) return complete(done.dataset.done, true);
      const again = e.target.closest('[data-again]'); if (again) return complete(again.dataset.again, false);
      if (e.target.closest('#og-refresh')) return refresh();
      const li = e.target.closest('li[data-id]'); if (li) openBook(li.dataset.id);
    };
    $('#og-hidden', body).onchange = (e) => { bs.hidden = e.target.checked; $('#og-hidwrap', body).innerHTML = hiddenHtml(); };
    $('#og-find', body).oninput = (e) => { bs.find = e.target.value; $('#bs-list', body).innerHTML = itemsHtml(); };
    $('#og-find', body).onkeydown = (e) => e.stopPropagation();
  };

  // ---------- Refresh: the scan runs as a job on the Mac ----------
  const refresh = async () => {
    if (bs.job) return;
    try { const j = await api('POST', '/organize/scan', {}); watchJob(j.id); } catch (e) { toast(e.message); }
  };
  const watchJob = async (jid) => {
    bs.job = { id: jid, progress: 0 }; paintScan();
    while (bs.alive) {
      let j = null; try { j = await api('GET', `/jobs/${encodeURIComponent(jid)}`); } catch {}
      if (!j) break;
      bs.job.progress = j.progress || 0; paintScan();
      if (!['queued', 'running'].includes(j.status)) {
        if (j.status !== 'done') toast(`The check stopped: ${(j.log?.at(-1)?.msg) || j.status}`);
        break;
      }
      await sleep(800);
    }
    bs.job = null;
    if (!bs.alive) return;
    try { const r = await api('GET', '/organize'); bs.items = r.items; bs.scan = r.scan; } catch {}
    paintSide(); paintBar();
    if (bs.scan) toast(`${plural(bs.scan.candidates.length, 'sheet')} to check`);
  };
  const paintScan = () => {
    const el = $('#og-scan', body); if (el) el.innerHTML = scanLine();
    const b = $('#og-refresh', body); if (b) b.disabled = !!bs.job;
  };

  // "This is a complete song": scans leave it out (undoable)
  const complete = (id, on) => busy(async () => {
    const r = await api('POST', '/organize/reviewed', { id, on });
    const x = bs.items.find((b) => b.id === id); if (x) x.reviewed = on;
    if (on && bs.scan) bs.scan.candidates = bs.scan.candidates.filter((c) => c.id !== id && !(c.others || []).includes(id));
    if (r.activity) bs.undo.push({ label: on ? 'complete song' : 'check again', run: () => api('POST', `/activity/${encodeURIComponent(r.activity)}/undo`, {}) });
    toast(on ? `“${x?.title || ''}” is a complete song — scans leave it out` : `“${x?.title || ''}” can come up in checks again`);
    paintSide(); paintBar();
  });

  // ---------- the editor ----------
  const segs = () => {
    const n = bs.book?.pages || 0, s = [...new Set([...(SH() && n ? [1] : []), ...Object.keys(bs.starts).map(Number)])].filter((p) => p <= n).sort((a, b) => a - b);
    return s.map((p, k) => ({ k, start: p, end: k + 1 < s.length ? s[k + 1] - 1 : n, title: bs.starts[p] || (SH() && p === 1 ? bs.book?.title || '' : '') }));
  };
  const segOf = (p, sg = segs()) => sg.findIndex((x) => p >= x.start && p <= x.end);
  const nameOf = (x) => x.title.trim() || (SH() && x.start === 1 ? bs.book.title : `${bs.book.title} — p${x.start}`);
  const W = () => (SH() ? 'song' : 'sheet');

  const figHtml = (b, k) => `<figure data-p="${k + 1}">
    <button class="bs-pg" data-p="${k + 1}" aria-label="Page ${k + 1}"><img src="/api/items/${encodeURIComponent(b.id)}/thumb/${k + 1}?w=500&v=${b.updatedAt || 0}" alt="" loading="lazy" draggable="false"><span class="bs-flag"></span></button>
    <button class="bs-zoom" data-z="${k + 1}" aria-label="View page ${k + 1} large" title="View large (Space)">⤢</button>
    <button class="og-del" data-del="${k + 1}" aria-label="Delete page ${k + 1}" title="Delete this page (kept in history)">✕</button>
    <figcaption><button class="og-mv" data-mv="-1" data-at="${k + 1}" aria-label="Move page ${k + 1} left" title="Move left" ${k === 0 ? 'disabled' : ''}>‹</button>
      <span class="bs-n">${k + 1}</span><span class="bs-t"></span>
      <button class="og-mv" data-mv="1" data-at="${k + 1}" aria-label="Move page ${k + 1} right" title="Move right" ${k + 1 === b.pages ? 'disabled' : ''}>›</button></figcaption></figure>`;

  const render = () => {
    const b = bs.book;
    try { if (bs.id) localStorage.setItem('meowsic-org-id', bs.id); } catch {}
    body.innerHTML = `<div class="bs og ${b && !bs.list ? 'has-book' : ''}">
      <aside class="bs-side og-side" id="og-side"></aside>
      <section class="bs-main">${b ? `
        <div class="bs-bar">
          <button class="ghost bs-back" id="bs-back">‹ All</button>
          <div class="bs-name"><b>${esc(b.title)}</b><small class="muted">${b.book ? 'Book · ' : ''}${plural(b.pages, 'page')} · tap where a new ${W()} starts · ${isTouch() ? 'hold and drag' : 'drag'} to reorder</small></div>
          <span class="grow"></span><span class="muted small" id="bs-sugst"></span><button id="bs-sug" class="ghost" hidden></button>
          <button id="og-merge" class="ghost" title="Add the pages of another sheet after these">Merge…</button>
          <button id="og-ok" class="ghost"></button>
        </div>
        <div class="og-why" id="og-why"></div>
        <div class="bs-segs" id="bs-segs"></div>
        <div class="bs-grid" id="bs-grid" data-id="${esc(b.id)}">${(b.files || []).map((_, k) => figHtml(b, k)).join('')}</div>
        <div class="bs-act"><span class="muted small bs-hint" id="bs-hint"></span><span class="grow"></span>
          <button id="bs-make" class="primary big">Make sheets…</button></div>` : `<p class="pad muted">${bs.items.length ? 'Pick a sheet or book.' : 'No sheets yet.'}</p>`}</section></div>`;
    $('#og-side', body).innerHTML = sideHtml(); wireSide();
    if (!b) return;
    $('#bs-back', body).onclick = () => { bs.list = true; body.querySelector('.bs').classList.remove('has-book'); paintSide(); };
    $('#bs-make', body).onclick = make;
    $('#bs-sug', body).onclick = useSuggestions;
    $('#og-merge', body).onclick = () => mergePick();
    $('#og-ok', body).onclick = () => complete(b.id, !it()?.reviewed);
    suggest();
    const g = $('#bs-grid', body);
    g.onclick = (e) => {
      if (e.target.closest('input')) return;
      if (bs.dragged) { bs.dragged = false; return; }
      const del = e.target.closest('[data-del]'); if (del) return delPage(+del.dataset.del);
      const mv = e.target.closest('[data-mv]'); if (mv) return movePage(+mv.dataset.at, +mv.dataset.at + +mv.dataset.mv);
      const z = e.target.closest('[data-z]'); if (z) { bs.focus = +z.dataset.z; paint(); return large(); }
      const p = e.target.closest('.bs-pg'); if (p) { bs.focus = +p.dataset.p; toggle(bs.focus); }
    };
    wireDrag(g);
    paint();
    g.querySelector(`figure[data-p="${bs.focus}"]`)?.scrollIntoView({ block: 'nearest' });
    prefetch();
  };
  const paintBar = () => {
    const ok = $('#og-ok', body), x = it(); if (!ok || !x) return;
    ok.textContent = x.reviewed ? 'Complete song ✓' : 'This is a complete song';
    ok.classList.toggle('on', !!x.reviewed);
    ok.title = x.reviewed ? 'Scans leave it out — tap to let them bring it up again' : 'Scans won’t bring it up again';
    const why = $('#og-why', body), cs = (bs.scan?.candidates || []).filter((c) => c.id === x.id);
    if (why) {
      why.innerHTML = cs.map((c) => `<span class="og-kind k-${c.kind}">${esc(KIND[c.kind] || c.kind)}</span> <span class="small">${esc(c.reason)}</span>${c.kind === 'merge' && c.others?.length ? ` <button class="ghost small" data-mergewith="${esc(c.others[0])}">Merge “${esc(c.otherTitles?.[0] || '')}” into this</button>` : ''}`).join('<br>');
      why.hidden = !cs.length;
      why.onclick = (e) => { const m = e.target.closest('[data-mergewith]'); if (m) mergeWith(m.dataset.mergewith); };
    }
  };

  // marks, colour bands, title boxes and the summary — without reloading the page images
  const paint = () => {
    const g = $('#bs-grid', body); if (!g) return;
    const sg = segs(), sh = SH();
    for (const fig of g.children) {
      const p = +fig.dataset.p, k = segOf(p, sg), start = p in bs.starts || (sh && p === 1);
      const sug = !start && bs.sug?.[p]?.start && p > 1;
      fig.className = `${k < 0 ? 'lead' : 'seg-' + (k % SEGS)}${start ? ' start' : ''}${sug ? ' suggested' : ''}${p === bs.focus ? ' focus' : ''}`;
      fig.querySelector('.bs-flag').textContent = start ? `${sh ? 'Song' : 'Sheet'} ${k + 1} starts` : sug ? `new song? ${bs.sug[p].title ? '“' + bs.sug[p].title + '”' : ''}` : '';
      fig.querySelector('.bs-pg').setAttribute('aria-pressed', start);
      const t = fig.querySelector('.bs-t');
      t.textContent = k < 0 ? 'stays in the book' : start ? '' : `${W()} ${k + 1}`;
      let inp = fig.querySelector('input');
      if (start && !inp) {
        inp = document.createElement('input');
        inp.className = 'bs-title'; inp.placeholder = sh && p === 1 ? bs.book.title : `Title of this ${W()}`; inp.enterKeyHint = 'done';
        inp.setAttribute('aria-label', `Title of the ${W()} starting on page ${p}`);
        inp.value = bs.starts[p] || '';
        inp.oninput = () => { bs.starts[p] = inp.value; det(p).typed = true; paintDet(fig, p); saveTitle(p); paintSegs(); };
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); } };
        inp.onblur = () => flushTitle(p);
        const hint = document.createElement('small');
        hint.className = 'bs-det muted';
        fig.append(inp, hint);
      } else if (!start && inp) { inp.remove(); fig.querySelector('.bs-det')?.remove(); }
      if (start) {
        if ((!det(p).typed || document.activeElement !== inp) && inp.value !== (bs.starts[p] || '')) inp.value = bs.starts[p] || '';
        paintDet(fig, p);
      }
    }
    paintSegs(); paintBar();
    const li = $(`#bs-list li[data-id="${CSS.escape(bs.id)}"] small`, body), x = it();  // the list line: how many starts
    if (li && x) { const n = Object.keys(bs.starts).length; li.innerHTML = `${x.book ? 'Book · ' : ''}${plural(bs.book.pages, 'page')}${n ? ` · <span class="bs-cnt">${plural(n, 'start')} marked</span>` : ''}${x.reviewed ? ' · complete song' : ''}`; }
  };
  const paintDet = (fig, p) => {
    const h = fig.querySelector('.bs-det'); if (!h) return;
    const d = det(p), v = (bs.starts[p] || '').trim();
    h.textContent = d.typed ? '' : d.state === 'busy' && !v ? 'Reading the title…'
      : d.state === 'ok' && v === d.title ? 'detected' : d.state === 'fail' && !v ? 'couldn’t read the title' : '';
    h.dataset.state = d.typed ? '' : d.state || '';
  };
  // read the title off the page; it fills the box only if you haven't typed there (yours always wins)
  const detect = async (p) => {
    const id = bs.id, d = det(p, id);
    if (d.state === 'busy') return;
    if (!d.state) {
      d.state = 'busy'; paint();
      let r = null;
      try { r = await api('GET', `/items/${encodeURIComponent(id)}/pages/${p}/title`); } catch {}
      const ok = !!(r && r.title && r.confidence >= 0.5);
      d.state = ok ? 'ok' : 'fail'; d.title = ok ? r.title : '';
    }
    if (bs.id !== id || !(p in bs.starts)) return;
    const cur = (bs.starts[p] || '').trim();
    if (d.state === 'ok' && !d.typed && (!cur || cur === bs.book?.guess?.[p] || cur === bs.sug?.[p]?.title)) { /* an automatic title, not typed */ bs.starts[p] = d.title; bs.saving[p] = 0; flushTitle(p); }
    paint();
  };
  const prefetch = async () => {
    const id = bs.id;
    for (const p of Object.keys(bs.starts).map(Number).sort((a, b) => a - b)) {
      if (bs.id !== id || !bs.alive) return;
      if (!(bs.starts[p] || '').trim() && !(SH() && p === 1)) await detect(p);
    }
  };
  const paintSegs = () => {
    const sg = segs(), b = bs.book, el = $('#bs-segs', body); if (!el || !b) return;
    const lead = sg.length ? sg[0].start - 1 : b.pages;
    el.innerHTML = (SH() ? '' : lead ? `<span class="bs-seg lead">Stays in the book: ${range(1, lead)}</span>` : sg.length ? '<span class="bs-seg lead">Nothing stays in the book — it goes to the Trash</span>' : '')
      + sg.map((x) => `<button class="bs-seg seg-${x.k % SEGS}" data-go="${x.start}"><b>${SH() ? 'Song' : 'Sheet'} ${x.k + 1}:</b> ${range(x.start, x.end)}${x.title.trim() ? ` · ${esc(x.title.trim())}` : ''}</button>`).join('');
    el.onclick = (e) => { const s = e.target.closest('[data-go]'); if (s) { bs.focus = +s.dataset.go; paint(); focusFig(); } };
    const mk = $('#bs-make', body);
    const made = SH() ? sg.length - 1 : sg.length;  // a sheet keeps its first song
    mk.textContent = made > 0 ? `Make ${plural(made, SH() ? 'new sheet' : 'sheet')}…` : 'Make sheets…';
    mk.disabled = made < 1;
    $('#bs-hint', body).textContent = made > 0 ? `${plural(sg.length, W())} marked · saved on the Mac` : SH() ? 'Tap the first page of each song after the first' : 'Tap the first page of each sheet';
  };
  const focusFig = () => $('#bs-grid', body)?.querySelector(`figure[data-p="${bs.focus}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const openBook = async (id) => {
    if (id === bs.id && bs.book) { bs.list = false; body.querySelector('.bs')?.classList.add('has-book'); return; }
    await flushAll();
    bs.id = id; bs.book = null; bs.focus = 1; bs.list = false;
    draw();
  };

  // ---------- suggestions: where new songs probably start, read off every page by the Mac ----------
  const suggest = async () => {
    const id = bs.id, el = $('#bs-sugst', body);
    if (!bs.book || bs.sug) return paintSug();
    if (el) el.textContent = 'Reading the pages…';
    let r = null;
    try { r = await api('GET', `/sheets/${encodeURIComponent(id)}/split?detect=1`); } catch {}
    if (bs.id !== id || !bs.alive) return;
    bs.sug = r?.suggest || {};
    paint(); paintSug();
  };
  const sugPages = () => Object.entries(bs.sug || {}).filter(([p, s]) => +p > 1 && s.start && !(p in bs.starts)).map(([p]) => +p);
  const paintSug = () => {
    const el = $('#bs-sugst', body), b = $('#bs-sug', body); if (!el || !b) return;
    const n = sugPages();
    el.textContent = !bs.sug ? 'Reading the pages…' : n.length ? '' : Object.keys(bs.starts).some((p) => +p > 1) ? '' : 'The Mac found no other song starts';
    b.hidden = !n.length; b.textContent = `Mark the ${plural(n.length, 'suggested start')}`;
  };
  const useSuggestions = () => {
    const n = sugPages(); if (!n.length) return;
    const prev = { ...bs.starts }, id = bs.id, base = BASE();
    for (const p of n) bs.starts[p] = bs.sug[p].title || '';
    if (SH() && !('1' in bs.starts) && bs.sug[1]?.title && bs.sug[1].title !== bs.book.title) bs.starts[1] = bs.sug[1].title;
    paint(); paintSug();
    bs.undo.push({ label: 'mark suggestions', run: async () => { await api('POST', `${base}/${encodeURIComponent(id)}/split`, { starts: prev }); bs.id = id; } });
    drawHead();
    const all = { ...bs.starts };
    bs.q = bs.q.then(() => setStarts(all)).catch((e) => toast(e.message));
  };

  // ---------- marks ----------
  const setStarts = async (starts) => {
    bs.starts = { ...(await api('POST', `${BASE()}/${encodeURIComponent(bs.id)}/split`, { starts })).starts };
    const b = it(); if (b) b.starts = { ...bs.starts };
  };
  // marks apply at once on screen; the Mac is told in order (one request after the other)
  const toggle = (p) => {
    if (!bs.book) return;
    if (SH() && p === 1) return toast('Page 1 always starts the first song — type its title in the box');
    flushAll();
    const prev = { ...bs.starts }, on = !(p in bs.starts), id = bs.id, base = BASE();
    if (on) bs.starts[p] = bs.sug?.[p]?.title || bs.book.guess?.[p] || ''; else { delete bs.starts[p]; det(p).typed = false; }
    paint();
    if (on) detect(p);
    if (on && !bs.starts[p] && isDesktop() && !document.querySelector('.modal')) $('#bs-grid', body)?.querySelector(`figure[data-p="${p}"] input`)?.focus({ preventScroll: true });
    bs.undo.push({ label: on ? 'mark' : 'join songs', run: async () => {
      bs.id = id; bs.list = false; bs.focus = p;
      await api('POST', `${base}/${encodeURIComponent(id)}/split`, { starts: prev });
    } });
    drawHead();
    return (bs.q = bs.q.then(async () => {
      const r = await api('POST', `${base}/${encodeURIComponent(id)}/split`, on ? { page: p, on: true, title: bs.starts[p] ?? '' } : { page: p, on: false });
      const b = bs.items?.find((x) => x.id === id); if (b) b.starts = { ...r.starts };
    }).catch((e) => toast(e.message)));
  };
  const saveTitle = (p) => { clearTimeout(bs.saving[p]); bs.saving[p] = setTimeout(() => flushTitle(p), 500); };
  const flushTitle = (p) => {
    if (!(p in bs.saving)) return;
    clearTimeout(bs.saving[p]); delete bs.saving[p];
    if (!(p in bs.starts) && !(SH() && p === 1)) return;
    const id = bs.id, title = bs.starts[p] ?? '', base = BASE();
    return (bs.q = bs.q.then(() => api('POST', `${base}/${encodeURIComponent(id)}/split`, { page: p, on: true, title }))
      .then((r) => { const b = bs.items?.find((x) => x.id === id); if (b) b.starts = { ...r.starts }; })
      .catch(() => toast('Title not saved — the Mac said no')));
  };
  const flushAll = () => Promise.all(Object.keys(bs.saving).map((p) => flushTitle(+p)));

  // ---------- reorder / delete pages (on the Mac at once; one Activities row each) ----------
  const arrange = async (order, label, focus) => { while (bs.busy) await sleep(100); return busy(async () => {  // after an Undo still on its way
    await flushAll(); await bs.q;
    const id = bs.id, title = bs.book.title;
    const r = await api('POST', `/items/${encodeURIComponent(id)}/pages/arrange`, { order });
    store.putItem(r.item);  // library, sheet viewer and thumbnails take the new pages
    pushAct(label, r.activity, [id]);
    const x = it(); if (x) { x.pages = r.item.pages; x.updatedAt = r.item.updatedAt; x.starts = r.starts; }
    if (r.trashed) {
      toast(`“${title}” had no pages left — it went to the Trash. Undo brings it back.`);
      bs.items = bs.items.filter((b) => b.id !== id); bs.id = null; bs.book = null; bs.list = true;
    } else { bs.book = null; if (focus) bs.focus = focus; }
    await draw();
  }); };
  const movePage = (from, to) => {
    const n = bs.book?.pages || 0;
    if (!n || to < 1 || to > n || to === from) return;
    const order = Array.from({ length: n }, (_, k) => k + 1);
    order.splice(from - 1, 1); order.splice(to - 1, 0, from);
    return arrange(order, `move page ${from}`, to);
  };
  const delPage = async (p) => {
    const n = bs.book?.pages || 0;
    if (!n) return;
    if (n === 1 && !(await confirmSheet({ title: 'Delete the only page?', body: `“${bs.book.title}” has no other page, so it goes to the Trash. Undo brings it back.`, ok: 'Delete', danger: true }))) return;
    const order = Array.from({ length: n }, (_, k) => k + 1).filter((x) => x !== p);
    await arrange(order, `delete page ${p}`, Math.min(p, Math.max(1, n - 1)));
    if (n > 1) toast(`Page ${p} deleted — kept in the history; Undo brings it back`);
  };

  // drag a page: Mac — press and move; touch — hold still a moment, then drag (a quick swipe still scrolls)
  const wireDrag = (g) => {
    const figAt = (x, y) => { const el = document.elementFromPoint(x, y)?.closest?.('#bs-grid figure'); return el && el.dataset.p ? el : null; };
    const start = (fig, x, y) => {
      const p = +fig.dataset.p, img = fig.querySelector('img'), r = img.getBoundingClientRect();
      const ghost = img.cloneNode(); ghost.className = 'og-ghost'; ghost.style.width = r.width * 0.7 + 'px';
      document.body.append(ghost);
      bs.drag = { p, ghost, target: null, after: false, dx: r.width * 0.35, dy: 20 };
      fig.classList.add('dragging'); g.classList.add('og-dragging');
      at(x, y);
    };
    const at = (x, y) => {
      const d = bs.drag; if (!d) return;
      d.ghost.style.transform = `translate(${x - d.dx}px, ${y - d.dy}px)`;
      g.querySelectorAll('.drop-before, .drop-after').forEach((f) => f.classList.remove('drop-before', 'drop-after'));
      const f = figAt(x, y);
      d.target = f && +f.dataset.p !== d.p ? +f.dataset.p : null;
      if (f && d.target) { const r = f.getBoundingClientRect(); d.after = x > r.left + r.width / 2; f.classList.add(d.after ? 'drop-after' : 'drop-before'); }
      const gr = g.getBoundingClientRect();  // near the top / bottom edge: scroll
      if (y < gr.top + 50) g.scrollBy(0, -18); else if (y > gr.bottom - 50) g.scrollBy(0, 18);
    };
    const end = (drop) => {
      const d = bs.drag; if (!d) return;
      bs.drag = null; d.ghost.remove();
      g.classList.remove('og-dragging');
      g.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((f) => f.classList.remove('dragging', 'drop-before', 'drop-after'));
      bs.dragged = true; setTimeout(() => { bs.dragged = false; }, 400);
      if (!drop || !d.target) return;
      let to = d.target + (d.after ? 1 : 0);  // the place before which it goes, in the old numbering
      if (d.p < to) to -= 1;
      movePage(d.p, to);
    };
    // mouse (Mac): the move / up listeners are on the window (added once, below)
    g.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const fig = e.target.closest('figure'); if (!fig || !e.target.closest('.bs-pg')) return;
      bs.pend = { fig, x: e.clientX, y: e.clientY };
    });
    bs.dragApi = { start, at, end };
    // touch (iPad / iPhone): hold ~0.35 s without moving, then drag
    let timer = null, t0 = null;
    g.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const fig = e.target.closest('figure'); if (!fig || !e.target.closest('.bs-pg')) return;
      const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; start(fig, t0.x, t0.y); navigator.vibrate?.(15); }, 350);
    }, { passive: true });
    g.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (bs.drag) { e.preventDefault(); return at(t.clientX, t.clientY); }
      if (timer && t0 && Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 10) { clearTimeout(timer); timer = null; }
    }, { passive: false });
    g.addEventListener('touchend', (e) => { clearTimeout(timer); timer = null; if (bs.drag) { e.preventDefault(); end(true); } });
    g.addEventListener('touchcancel', () => { clearTimeout(timer); timer = null; end(false); });
    g.addEventListener('contextmenu', (e) => { if (bs.drag || timer) e.preventDefault(); });
  };

  // ---------- merge another sheet into this one ----------
  const mergeWith = async (otherId) => {
    const b = bs.book, o = bs.items.find((x) => x.id === otherId);
    if (!b || !o) return;
    if (!(await confirmSheet({ title: `Add the pages of “${o.title}” after these?`, body: `“${b.title}” gets ${plural(o.pages, 'more page')} (${b.pages + 1}–${b.pages + o.pages}); “${o.title}”, empty then, goes to the Trash. Undo puts it all back.`, ok: 'Merge' }))) return;
    await busy(async () => {
      await flushAll(); await bs.q;
      const r = await api('POST', `/items/${encodeURIComponent(b.id)}/join`, { other: otherId });
      store.putItem(r.item); if (r.other) store.putItem(r.other);
      pushAct(`merge “${o.title}”`, r.activity, [b.id, otherId]);
      toast(`Merged “${o.title}” into “${b.title}”`);
      bs.items = null; bs.book = null;
      await draw();
    });
  };
  const mergePick = () => {
    const b = bs.book; if (!b) return;
    const sugg = (bs.scan?.candidates || []).filter((c) => c.kind === 'merge' && (c.id === b.id || c.others?.includes(b.id))).flatMap((c) => [c.id, ...c.others]).filter((x) => x !== b.id);
    const m = modal(`<h2>Merge into “${esc(b.title)}”</h2><p class="muted small">Pick the sheet whose pages come after these.</p>
      <input id="og-mq" type="search" placeholder="Find a sheet" aria-label="Find a sheet">
      <ol class="bs-list og-pick" id="og-ml"></ol><div class="modal-actions"><button data-close>Cancel</button></div>`);
    const list = () => {
      const f = $('#og-mq', m.el).value.trim().toLowerCase();
      const xs = bs.items.filter((x) => x.id !== b.id && (!f || x.title.toLowerCase().includes(f)))
        .sort((x, y) => (sugg.includes(y.id) - sugg.includes(x.id)) || x.title.localeCompare(y.title)).slice(0, 80);
      $('#og-ml', m.el).innerHTML = xs.map((x) => `<li data-id="${esc(x.id)}"><b>${esc(x.title)}</b><small>${x.book ? 'Book · ' : ''}${plural(x.pages, 'page')}${sugg.includes(x.id) ? ' · <span class="bs-cnt">looks like the same song</span>' : ''}</small></li>`).join('') || '<li class="og-more muted small">No sheet with that name</li>';
    };
    $('#og-mq', m.el).oninput = list;
    $('#og-mq', m.el).onkeydown = (e) => e.stopPropagation();
    $('#og-ml', m.el).onclick = (e) => { const li = e.target.closest('[data-id]'); if (li) { m.close(); mergeWith(li.dataset.id); } };
    list();
  };

  // ---------- one page large ----------
  const large = () => {
    const b = bs.book; if (!b) return;
    const m = modal(`<div class="bs-large"><img id="bs-big" alt=""></div>
      <div class="modal-actions bs-large-act"><button id="bs-lp" aria-label="Previous page">‹</button><span id="bs-lt" class="grow"></span>
        <button id="bs-lm"></button><button id="bs-ln" aria-label="Next page">›</button><button class="primary" data-close>Close</button></div>`,
    { wide: true, onClose: () => { removeEventListener('keydown', key, true); paint(); focusFig(); } });
    m.el.classList.add('bs-modal');
    const show = () => {
      const p = bs.focus, k = segOf(p);
      $('#bs-big', m.el).src = store.pageUrl(b.id, p, b.updatedAt);
      $('#bs-lt', m.el).textContent = `Page ${p} of ${b.pages} · ${k < 0 ? 'stays in the book' : `${W()} ${k + 1}`}`;
      const lm = $('#bs-lm', m.el), on = p in bs.starts || (SH() && p === 1); lm.textContent = on ? `Not a new ${W()}` : `A new ${W()} starts here`; lm.classList.toggle('on', on); lm.disabled = SH() && p === 1;
    };
    const step = (d) => { bs.focus = Math.max(1, Math.min(b.pages, bs.focus + d)); show(); };
    const flip = async () => { await toggle(bs.focus); show(); };
    $('#bs-lp', m.el).onclick = () => step(-1); $('#bs-ln', m.el).onclick = () => step(1); $('#bs-lm', m.el).onclick = flip;
    const key = (e) => {
      if (!m.el.isConnected) return removeEventListener('keydown', key, true);
      const a = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), ArrowUp: () => step(-1), ArrowDown: () => step(1), s: flip, Enter: flip, ' ': m.close }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!a || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault(); e.stopPropagation(); a();
    };
    addEventListener('keydown', key, true);
    let x0 = null;
    const big = $('.bs-large', m.el);
    big.onpointerdown = (e) => { x0 = e.clientX; };
    big.onpointerup = (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 50) step(e.clientX < x0 ? 1 : -1); x0 = null; };
    show();
  };

  // ---------- make the sheets ----------
  const make = async () => {
    await flushAll(); await bs.q;
    const sg = segs(), b = bs.book, sh = SH(), made = sh ? sg.length - 1 : sg.length, base = BASE();
    if (made < 1) return toast(sh ? 'Tap the page where the next song starts first' : 'Tap the page where a sheet starts first');
    const lead = sg[0].start - 1;
    const m = modal(`<h2>${sh ? `Split “${esc(b.title)}” into ${plural(sg.length, 'song')}?` : `Make ${plural(sg.length, 'sheet')} from “${esc(b.title)}”?`}</h2>
      <ol class="bs-confirm">${sg.map((x) => `<li class="seg-${x.k % SEGS}"><b>${esc(nameOf(x))}</b> <span class="muted">${range(x.start, x.end)} (${x.end - x.start + 1} p)${sh && x.k === 0 ? ' · stays in this sheet' : sh ? ' · new sheet' : ''}</span></li>`).join('')}</ol>
      <p class="muted small">${sh ? 'The first song keeps this sheet (its plays, notes and history).' : lead ? `${range(1, lead).replace(/^p/, 'P')} stay in the book.` : 'No pages are left in the book, so it goes to the Trash.'} Undo puts everything back.</p>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Make ${plural(made, sh ? 'new sheet' : 'sheet')}</button></div>`);
    m.el.querySelector('[data-ok]').onclick = () => busy(async () => {
      const id = b.id, title = b.title;
      const r = await api('POST', `${base}/${encodeURIComponent(id)}/make-sheets`, { starts: bs.starts });
      m.close();
      store.putItem(r.book); for (const s of r.sheets) store.putItem(s);
      bs.undo.push({ label: sh ? 'split songs' : 'make sheets', run: async () => {
        const u = await api('POST', `${base}/${encodeURIComponent(id)}/unmake`);
        store.putItem(u.book); store.drop(u.removed);
        bs.id = id; bs.list = false;
      } });
      toast(`${plural(r.sheets.length, 'new sheet')} from “${title}”${r.book.deleted ? ` · the ${sh ? 'sheet' : 'book'} went to the Trash` : ''}`);
      bs.items = null; bs.book = null;
      if (r.book.deleted) { bs.id = null; bs.list = true; }
      await draw();
    });
  };

  // ---------- keys (Mac) ----------
  const help = () => modal(`<h2>Organize pages</h2><p class="muted small">Split a sheet where a new song starts, merge songs, reorder and delete pages. Everything can be undone; deleted pages are kept in the sheet’s history.</p>
    ${isDesktop() ? `<table class="cu-keys">${KEYS.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table>` : '<p class="small">Tap a page to mark a new song; hold a page, then drag it to move it; ✕ deletes a page.</p>'}
    <div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
  const cols = () => { const g = $('#bs-grid', body); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 1; };
  const move = (d) => { if (!bs.book) return; bs.focus = Math.max(1, Math.min(bs.book.pages, bs.focus + d)); paint(); focusFig(); };
  const onKey = (e) => {
    if (!main.isConnected || !body.isConnected) return removeEventListener('keydown', onKey);
    if (bs.busy || document.querySelector('.modal') || e.target.matches?.('input:not([readonly]), textarea')) return;
    const k = e.key;
    const a = {
      ArrowRight: () => (e.shiftKey ? movePage(bs.focus, bs.focus + 1) : move(1)), ArrowLeft: () => (e.shiftKey ? movePage(bs.focus, bs.focus - 1) : move(-1)),
      ArrowDown: () => move(cols()), ArrowUp: () => move(-cols()),
      s: () => bs.book && toggle(bs.focus), Enter: () => bs.book && toggle(bs.focus), ' ': large,
      Delete: () => bs.book && delPage(bs.focus), Backspace: () => bs.book && delPage(bs.focus),
      u: undo, z: undo, '?': help,
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!a || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('button') && !e.target.closest('#bs-grid') && (k === 'Enter' || k === ' ')) return;
    e.preventDefault(); a();
  };
  addEventListener('keydown', onKey);
  const pmove = (e) => {
    if (e.pointerType !== 'mouse' || !bs.dragApi) return;
    if (bs.drag) { e.preventDefault(); return bs.dragApi.at(e.clientX, e.clientY); }
    if (bs.pend && Math.hypot(e.clientX - bs.pend.x, e.clientY - bs.pend.y) > 6) { if (bs.pend.fig.isConnected) bs.dragApi.start(bs.pend.fig, e.clientX, e.clientY); bs.pend = null; }
  };
  const pup = (e) => { if (e.pointerType !== 'mouse') return; bs.pend = null; if (bs.drag) bs.dragApi?.end(true); };
  addEventListener('pointermove', pmove);
  addEventListener('pointerup', pup);
  $('#cu-undo', main).onclick = undo;
  $('#cu-help', main).onclick = help;
  drawHead();
  draw();
  return () => { bs.alive = false; flushAll(); removeEventListener('keydown', onKey); removeEventListener('pointermove', pmove); removeEventListener('pointerup', pup); bs.drag?.ghost.remove(); };
}
