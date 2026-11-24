// Manage library → Fix pages: one sheet's pages in a clean grid (books are read-only PDFs: not editable).
//   tap a page = select it (Mac: click; ⇧ / ⌘ add more; arrows move the selection)
//   one floating dock: Crop · Move · New song here · Merge with… · Delete
//     Crop           #/manage/pages/<id>/crop/<p>: the ORIGINAL photo with the box (cropbox.js), full screen
//     Move           drag a page (touch: hold, then drag), or Move then tap the place it goes; ⇧← / ⇧→ on Mac
//     New song here  a "Song 2 starts here · ✕ Remove" line before the page; Done makes each song its own sheet
//                    (after a confirm: "Split into N sheets"); the first song keeps this sheet
//     Merge with…    the pages of another sheet go after these; the other one, empty then, goes to the Trash
//     Delete         the page goes to the sheet's history (never deleted for good); the last page → Trash
// Every change goes to the Mac at once and gets an Activities row; Undo (header) rolls the newest one back.
import { store } from '../store.js';
import { isDesktop } from '../device.js';
import { $, esc, iconOn, toast, sheet as modal, confirmSheet, menu } from '../ui.js';
import { cropStage, savedBoxes, boxOf, isFull, full } from '../cropbox.js';
import { api, plural, range, sleep, thumb, listPages, head, taps, pushAct, pushUndo, undoLast, canUndo, undoLabel, onUndo, recent } from './managekit.js';

let CARRY = null;  // the last crop box set (any sheet): the next page starts with it ("Use this box for the next pages")
const carryOn = () => { try { return localStorage.getItem('meowsic-crop-carry') !== '0'; } catch { return true; } };

const KEYS = [
  ['← → ↑ ↓', 'Select the next page'], ['⇧ / ⌘ click', 'Select more pages'], ['⇧← / ⇧→', 'Move the page left / right'],
  ['S / Enter', 'A new song starts here (again: not)'], ['Delete', 'Delete the selected pages (Undo brings them back)'],
  ['C', 'Crop the page'], ['M', 'Merge with another sheet'], ['Space', 'View the page large'], ['U / ⌘Z', 'Undo'], ['Esc', 'Clear the selection'],
];

const backOf = (id, q) => (q?.get?.('back') === 'item' ? { href: `#/item/${encodeURIComponent(id)}`, label: store.get(id)?.title || 'Back' } : { href: '#/manage/pages', label: 'Back' });
const editorHash = (id, q, extra = '') => { const ps = [q?.get?.('back') === 'item' ? 'back=item' : '', extra].filter(Boolean).join('&'); return `#/manage/pages/${encodeURIComponent(id)}${ps ? '?' + ps : ''}`; };

// ================= the editor =================
export function editorView(main, { id, q }) {
  if (store.mode !== 'server') { main.innerHTML = head({ title: 'Fix pages', sub: null }) + '<p class="mg-pad muted">Fix pages needs the Mac.</p>'; return; }
  const back = backOf(id, q);
  const st = { b: null, crops: [], sel: new Set(), anchor: null, moving: 0, alive: true, q: Promise.resolve(), saving: {}, det: {}, busy: false, drag: null, dragged: false, items: null, scan: null };
  main.innerHTML = `<div class="mg-full pe">${head({ back: back.href, backLabel: back.label, title: store.get(id)?.title || 'Fix pages', sub: '',
    right: `<button class="ghost pe-undo" id="pe-undo" data-act="undo" title="Undo (U)" disabled>${iconOn('undo')}<span class="hide-phone">Undo</span></button>${isDesktop() ? '<button class="ghost" data-act="help" aria-label="Keys" title="Keys">?</button>' : ''}<button class="primary pe-done" id="pe-done" data-act="done">Done</button>` })}
    <p class="pe-banner" id="pe-banner" hidden></p>
    <div class="pe-grid" id="pe-grid"><p class="muted">Loading…</p></div>
    <nav class="pe-dock" id="pe-dock" aria-label="Page actions">
      <span class="pe-hint" id="pe-hint"></span><span class="pe-sep"></span>
      <button class="pe-tool" data-act="crop">${iconOn('crop')}<span>Crop</span></button>
      <button class="pe-tool" data-act="move">${iconOn('move')}<span>Move</span></button>
      <button class="pe-tool" data-act="mark">${iconOn('split')}<span class="hide-phone" id="pe-markl">New song here</span><span class="only-phone" id="pe-markp">Split</span></button>
      <button class="pe-tool" data-act="merge">${iconOn('join')}<span class="hide-phone">Merge with…</span><span class="only-phone">Merge</span></button>
      <button class="pe-tool dng" data-act="delete">${iconOn('bin')}<span>Delete</span></button>
    </nav></div>`;
  const grid = $('#pe-grid', main);
  const n = () => st.b?.pages || 0;
  const det = (p) => (st.det[p] ||= {});

  // ---------- songs ----------
  const segs = () => {
    const s = [...new Set([1, ...Object.keys(st.b?.starts || {}).map(Number)])].filter((p) => p <= n()).sort((a, b) => a - b);
    return s.map((p, k) => ({ k, start: p, end: k + 1 < s.length ? s[k + 1] - 1 : n(), title: st.b.starts[p] || (p === 1 ? st.b.title : '') }));
  };
  const marks = () => segs().slice(1).map((x) => x.start);
  const nameOf = (x) => x.title.trim() || (x.start === 1 ? st.b.title : `${st.b.title} — p${x.start}`);

  // ---------- loading ----------
  const load = async () => {
    try {
      const it = await api('GET', `/items/${encodeURIComponent(id)}`);
      if (it.deleted) throw new Error(`“${it.title}” is in the Trash.`);
      if (it.book) throw new Error('Books are kept as the PDF they came in: their pages can’t be changed here.');
      if (it.kind !== 'sheet' || !it.pages) throw new Error('Only sheets have pages to fix.');
      const [b, cr] = await Promise.all([api('GET', `/sheets/${encodeURIComponent(id)}/split`), api('GET', `/items/${encodeURIComponent(id)}/crops`).catch(() => ({ pages: [] }))]);
      st.b = b; st.crops = cr.pages || [];
      st.sel = new Set([...st.sel].filter((p) => p <= b.pages));
    } catch (e) {
      if (!st.alive) return;
      grid.innerHTML = `<div class="mg-emptybox"><p>${esc(e.message)}</p><a class="btn" href="${back.href}">‹ ${esc(back.label)}</a></div>`;
      $('#pe-dock', main).hidden = true; st.b = null; paintHead(); return;
    }
    if (!st.alive) return;
    recent(id);
    $('#pe-dock', main).hidden = false;
    render();
  };

  // ---------- drawing ----------
  const tileHtml = (p) => {
    const c = st.crops[p - 1];
    return `<button class="pe-tile" data-p="${p}" aria-label="Page ${p}" aria-pressed="false"><span class="pe-pg"><img src="${thumb(id, p, st.b.updatedAt, 500)}" alt="" loading="lazy" draggable="false">${c?.crop ? '<span class="pe-cropped">cropped</span>' : ''}<span class="pe-chk">✓</span></span><span class="pe-n">${p}</span></button>`;
  };
  const render = () => {
    const sg = segs();
    $('.mg-t h2', main).textContent = st.b.title;
    grid.innerHTML = sg.map((x) => (x.k === 0 ? (sg.length > 1 ? `<div class="pe-songhead">Song 1 · ${esc(nameOf(x))}</div>` : '')
      : `<div class="pe-break" data-start="${x.start}"><span class="pe-bt">Song ${x.k + 1} starts here</span><input class="pe-title" data-title="${x.start}" value="${esc(st.b.starts[x.start] || '')}" placeholder="Title" aria-label="Title of song ${x.k + 1}" enterkeyhint="done"><small class="pe-det" data-det="${x.start}"></small><button class="ghost pe-x" data-act="unmark" data-p="${x.start}">✕ Remove</button></div>`)
      + Array.from({ length: x.end - x.start + 1 }, (_, i) => tileHtml(x.start + i)).join('')).join('');
    grid.querySelectorAll('.pe-title').forEach((inp) => {
      const p = +inp.dataset.title;
      inp.oninput = () => { st.b.starts[p] = inp.value; det(p).typed = true; paintDet(p); saveTitle(p); };
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); } };
      inp.onblur = () => flushTitle(p);
      paintDet(p);
    });
    paint();
  };
  const paintDet = (p) => {
    const h = grid.querySelector(`[data-det="${p}"]`); if (!h) return;
    const d = det(p), v = (st.b.starts[p] || '').trim();
    h.textContent = d.typed ? '' : d.state === 'busy' && !v ? 'Reading the title…' : d.state === 'fail' && !v ? 'couldn’t read the title' : '';
  };
  const paintHead = () => {
    const u = $('#pe-undo', main);
    if (u) { u.disabled = !canUndo() || st.busy; u.title = canUndo() ? `Undo ${undoLabel()} (U)` : 'Undo (U)'; }
    const s = $('#mg-sub', main);
    if (s && st.b) s.textContent = `${plural(n(), 'page')} · ${isDesktop() ? 'click' : 'tap'} a page to select it`;
  };
  const paint = () => {
    if (!st.b) return;
    for (const t of grid.querySelectorAll('.pe-tile')) {
      const p = +t.dataset.p, on = st.sel.has(p);
      t.classList.toggle('sel', on); t.setAttribute('aria-pressed', on);
      t.classList.toggle('moving', st.moving === p);
    }
    grid.classList.toggle('pe-moving', !!st.moving);
    const ms = marks(), one = st.sel.size === 1 ? [...st.sel][0] : 0;
    const ban = $('#pe-banner', main);
    ban.hidden = !ms.length && !st.moving;
    ban.innerHTML = st.moving ? `${iconOn('move')}<span>Tap the page whose place page ${st.moving} should take. <button class="link" data-act="cancel-move">Cancel</button></span>`
      : ms.length ? `${iconOn('split')}<span>You marked a new song at ${listPages(ms)}. <b>Done</b> will make ${ms.length === 1 ? 'it a separate sheet' : 'them separate sheets'}.</span>` : '';
    $('#pe-hint', main).textContent = st.sel.size === 0 ? (isDesktop() ? 'Click a page' : 'Tap a page') : st.sel.size === 1 ? `Page ${one}` : `${st.sel.size} pages`;
    const dock = $('#pe-dock', main), b = (a) => dock.querySelector(`[data-act="${a}"]`);
    b('crop').disabled = !st.sel.size;
    b('move').disabled = !one || n() < 2;
    b('mark').disabled = !one || one === 1;
    b('delete').disabled = !st.sel.size;
    const isStart = one > 1 && one in st.b.starts;
    $('#pe-markl', main).textContent = isStart ? 'Not a new song' : 'New song here';
    $('#pe-markp', main).textContent = isStart ? 'Unsplit' : 'Split';
    $('#pe-done', main).textContent = 'Done';
    paintHead();
  };

  // ---------- selection ----------
  const select = (p, e) => {
    if (st.moving) { const from = st.moving; st.moving = 0; if (p !== from) return movePage(from, p); return paint(); }
    if (isDesktop() && e && !e.metaKey && !e.ctrlKey && !e.shiftKey) st.sel = new Set([p]);
    else if (e?.shiftKey && st.anchor) { const [a, z] = [Math.min(st.anchor, p), Math.max(st.anchor, p)]; for (let k = a; k <= z; k++) st.sel.add(k); }
    else if (st.sel.has(p)) st.sel.delete(p); else st.sel.add(p);
    st.anchor = p;
    paint();
  };
  const focusTile = (p) => grid.querySelector(`.pe-tile[data-p="${p}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // ---------- busy / undo ----------
  const busy = async (fn) => { if (st.busy) return; st.busy = true; paintHead(); try { return await fn(); } catch (e) { toast(e.message); } finally { st.busy = false; paintHead(); } };
  const undo = () => busy(async () => { await flushAll(); await st.q; if (await undoLast()) await load(); });

  // ---------- song marks (saved on the Mac at once, in order) ----------
  const toggleMark = (p) => {
    if (!st.b || p === 1) return;
    flushAll();
    const prev = { ...st.b.starts }, on = !(p in st.b.starts);
    if (on) st.b.starts[p] = st.b.guess?.[p] || ''; else { delete st.b.starts[p]; det(p).typed = false; }
    render();
    if (on) detect(p);
    pushUndo(on ? 'new song' : 'remove song start', async () => { await api('POST', `/sheets/${encodeURIComponent(id)}/split`, { starts: prev }); });
    st.q = st.q.then(() => api('POST', `/sheets/${encodeURIComponent(id)}/split`, on ? { page: p, on: true, title: st.b.starts[p] ?? '' } : { page: p, on: false })).catch((e) => toast(e.message));
    return st.q;
  };
  const saveTitle = (p) => { clearTimeout(st.saving[p]); st.saving[p] = setTimeout(() => flushTitle(p), 500); };
  const flushTitle = (p) => {
    if (!(p in st.saving)) return;
    clearTimeout(st.saving[p]); delete st.saving[p];
    if (!(p in (st.b?.starts || {}))) return;
    const title = st.b.starts[p] ?? '';
    st.q = st.q.then(() => api('POST', `/sheets/${encodeURIComponent(id)}/split`, { page: p, on: true, title })).catch(() => toast('Title not saved — the Mac said no'));
    return st.q;
  };
  const flushAll = () => Promise.all(Object.keys(st.saving).map((p) => flushTitle(+p)));
  // read the title off the page; it fills the box only if nothing was typed there
  const detect = async (p) => {
    const d = det(p);
    if (d.state === 'busy') return;
    if (!d.state) {
      d.state = 'busy'; paintDet(p);
      let r = null;
      try { r = await api('GET', `/items/${encodeURIComponent(id)}/pages/${p}/title`); } catch {}
      const ok = !!(r && r.title && r.confidence >= 0.5);
      d.state = ok ? 'ok' : 'fail'; d.title = ok ? r.title : '';
    }
    if (!st.alive || !st.b || !(p in st.b.starts)) return;
    if (d.state === 'ok' && !d.typed && !(st.b.starts[p] || '').trim()) {
      st.b.starts[p] = d.title; st.saving[p] = 0; flushTitle(p);
      const inp = grid.querySelector(`[data-title="${p}"]`); if (inp && document.activeElement !== inp) inp.value = d.title;
    }
    paintDet(p);
  };

  // ---------- reorder / delete (one Activities row each) ----------
  const arrange = async (order, label, sel) => { while (st.busy) await sleep(100); return busy(async () => {
    await flushAll(); await st.q;
    const title = st.b.title;
    const r = await api('POST', `/items/${encodeURIComponent(id)}/pages/arrange`, { order });
    store.putItem(r.item);
    pushAct(label, r.activity, [id]);
    if (r.trashed) { toast(`“${title}” had no pages left — it went to the Trash. Undo brings it back.`); location.hash = back.href; return; }
    st.sel = new Set(sel ? [sel] : []);
    await load();
    if (sel) focusTile(sel);
  }); };
  const movePage = (from, to) => {
    if (!n() || to < 1 || to > n() || to === from) return paint();
    const order = Array.from({ length: n() }, (_, k) => k + 1);
    order.splice(from - 1, 1); order.splice(to - 1, 0, from);
    return arrange(order, `move page ${from}`, to);
  };
  const delPages = async () => {
    const ps = [...st.sel].sort((a, b) => a - b); if (!ps.length) return;
    if (ps.length === n() && !(await confirmSheet({ title: ps.length === 1 ? 'Delete the only page?' : 'Delete every page?', body: `“${st.b.title}” has no other page, so it goes to the Trash. Undo brings it back.`, ok: 'Delete', danger: true }))) return;
    if (ps.length > 1 && ps.length < n() && !(await confirmSheet({ title: `Delete ${plural(ps.length, 'page')}?`, body: `${listPages(ps).replace(/^p/, 'P')} go to the sheet’s history. Undo brings them back.`, ok: 'Delete', danger: true }))) return;
    const order = Array.from({ length: n() }, (_, k) => k + 1).filter((x) => !st.sel.has(x));
    const left = n() - ps.length;
    await arrange(order, ps.length === 1 ? `delete page ${ps[0]}` : `delete ${plural(ps.length, 'page')}`, left ? Math.min(ps[0], left) : 0);
    if (left) toast(`${listPages(ps).replace(/^p/, 'P')} deleted — Undo brings ${ps.length === 1 ? 'it' : 'them'} back`);
  };

  // ---------- merge another sheet into this one ----------
  const mergeWith = async (other) => {
    const o = st.items?.find((x) => x.id === other) || (await api('GET', `/items/${encodeURIComponent(other)}`).catch(() => null));
    if (!o) return;
    if (!(await confirmSheet({ title: `Add the pages of “${o.title}” after these?`, body: `“${st.b.title}” gets ${plural(o.pages, 'more page')} (${n() + 1}–${n() + o.pages}); “${o.title}”, empty then, goes to the Trash. Undo puts it all back.`, ok: 'Merge' }))) return;
    await busy(async () => {
      await flushAll(); await st.q;
      const r = await api('POST', `/items/${encodeURIComponent(id)}/join`, { other });
      store.putItem(r.item); if (r.other) store.putItem(r.other);
      pushAct(`merge “${o.title}”`, r.activity, [id, other]);
      toast(`Merged “${o.title}” into “${st.b.title}”`);
      await load();
    });
  };
  const mergePick = async () => {
    if (!st.b) return;
    if (!st.items) { try { const r = await api('GET', '/organize'); st.items = r.items; st.scan = r.scan; } catch (e) { return toast(e.message); } }
    const sugg = (st.scan?.candidates || []).filter((c) => c.kind === 'merge' && (c.id === id || c.others?.includes(id))).flatMap((c) => [c.id, ...c.others]).filter((x) => x !== id);
    const m = modal(`<h2>Merge with…</h2><p class="muted small">Pick the sheet whose pages come after the pages of “${esc(st.b.title)}”.</p>
      <input id="pe-mq" type="search" placeholder="Find a sheet" aria-label="Find a sheet" autocomplete="off">
      <ul class="mg-rows pe-pick" id="pe-ml"></ul><div class="modal-actions"><button data-close>Cancel</button></div>`);
    const list = () => {
      const f = $('#pe-mq', m.el).value.trim().toLowerCase();
      const xs = st.items.filter((x) => x.id !== id && (!f || x.title.toLowerCase().includes(f))).sort((x, y) => (sugg.includes(y.id) - sugg.includes(x.id)) || x.title.localeCompare(y.title)).slice(0, 80);
      $('#pe-ml', m.el).innerHTML = xs.map((x) => `<li><button class="mg-row" data-id="${esc(x.id)}"><span class="mg-rt"><b>${esc(x.title)}</b><small>${plural(x.pages, 'page')}${sugg.includes(x.id) ? ' · looks like the same song' : ''}</small></span></button></li>`).join('') || '<li class="muted mg-empty">No sheet with that name</li>';
    };
    $('#pe-mq', m.el).oninput = list;
    $('#pe-mq', m.el).onkeydown = (e) => e.stopPropagation();
    taps($('#pe-ml', m.el), '[data-id]', (el) => { m.close(); mergeWith(el.dataset.id); });
    list();
  };

  // ---------- Done: split marks → the confirm; else back ----------
  const done = async () => {
    await flushAll(); await st.q;
    if (!st.b || !marks().length) { location.hash = back.href; return; }
    const sg = segs(), made = sg.length - 1;
    const m = modal(`<h2>Split “${esc(st.b.title)}” into ${plural(sg.length, 'sheet')}?</h2>
      <ol class="pe-confirm">${sg.map((x) => `<li><b>${esc(nameOf(x))}</b> <span class="muted">${range(x.start, x.end)}${x.k === 0 ? ' · stays in this sheet' : ' · new sheet'}</span></li>`).join('')}</ol>
      <p class="muted small">The first song keeps this sheet (its plays, notes and history). Undo puts everything back.</p>
      <div class="modal-actions"><button data-close>Not yet</button><button class="primary" data-ok>Split into ${plural(sg.length, 'sheet')}</button></div>`);
    m.el.querySelector('[data-ok]').onclick = () => busy(async () => {
      const title = st.b.title;
      const r = await api('POST', `/sheets/${encodeURIComponent(id)}/make-sheets`, { starts: st.b.starts });
      m.close();
      store.putItem(r.book); for (const s of r.sheets) store.putItem(s);
      pushUndo('split songs', async () => { const u = await api('POST', `/sheets/${encodeURIComponent(id)}/unmake`); store.putItem(u.book); store.drop(u.removed); });
      toast(`${plural(r.sheets.length, 'new sheet')} from “${title}”`, { label: 'Undo', run: () => undoLast() });
      location.hash = back.href;
    });
    return made;
  };

  // ---------- one page large (Space / double-click) ----------
  const large = (p0) => {
    if (!st.b) return;
    let p = p0 || [...st.sel][0] || 1;
    const m = modal(`<div class="pe-large"><img id="pe-big" alt=""></div><div class="modal-actions"><button data-a="-1" aria-label="Previous page">‹</button><span class="grow muted small center" id="pe-lt"></span><button data-a="1" aria-label="Next page">›</button><button class="primary" data-close>Close</button></div>`, { wide: true });
    const show = () => { $('#pe-big', m.el).src = store.pageUrl(id, p, st.b.updatedAt); $('#pe-lt', m.el).textContent = `Page ${p} of ${n()}`; };
    m.el.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { p = Math.max(1, Math.min(n(), p + +b.dataset.a)); show(); }; });
    show();
  };
  const help = () => modal(`<h2>Fix pages</h2><p class="muted small">Every change is saved on the Mac at once and can be undone. Deleted pages are kept in the sheet’s history.</p>
    <table class="pe-keys">${KEYS.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);

  const crop = () => { const p = [...st.sel].sort((a, b) => a - b)[0]; if (!p) return; location.hash = `#/manage/pages/${encodeURIComponent(id)}/crop/${p}${q?.get?.('back') === 'item' ? '?back=item&from=editor' : ''}`; };
  const act = (el, e) => {
    if (st.dragged) return;
    const a = el.dataset.act;
    if (el.classList.contains('pe-tile')) return select(+el.dataset.p, e);
    if (a === 'undo') return undo();
    if (a === 'done') return done();
    if (a === 'help') return help();
    if (a === 'unmark') return toggleMark(+el.dataset.p);
    if (a === 'cancel-move') { st.moving = 0; return paint(); }
    if (a === 'crop') return crop();
    if (a === 'move') { st.moving = [...st.sel][0]; return paint(); }
    if (a === 'mark') return toggleMark([...st.sel][0]);
    if (a === 'merge') return mergePick();
    if (a === 'delete') return delPages();
  };
  const offTaps = taps(main, '.pe-tile, [data-act]', act);
  grid.addEventListener('dblclick', (e) => { const t = e.target.closest('.pe-tile'); if (t) large(+t.dataset.p); });

  // ---------- drag a page: Mac — press and move; touch — hold still a moment, then drag ----------
  const tileAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('#pe-grid .pe-tile') || null;
  const dStart = (tile, x, y) => {
    const p = +tile.dataset.p, img = tile.querySelector('img'), r = img.getBoundingClientRect();
    const ghost = img.cloneNode(); ghost.className = 'pe-ghost'; ghost.style.width = r.width * 0.7 + 'px';
    document.body.append(ghost);
    st.drag = { p, ghost, target: null, after: false, dx: r.width * 0.35, dy: 20 };
    tile.classList.add('dragging'); grid.classList.add('pe-dragging');
    dAt(x, y);
  };
  const dAt = (x, y) => {
    const d = st.drag; if (!d) return;
    d.ghost.style.transform = `translate(${x - d.dx}px, ${y - d.dy}px)`;
    grid.querySelectorAll('.drop-before, .drop-after').forEach((f) => f.classList.remove('drop-before', 'drop-after'));
    const f = tileAt(x, y);
    d.target = f && +f.dataset.p !== d.p ? +f.dataset.p : null;
    if (f && d.target) { const r = f.getBoundingClientRect(); d.after = x > r.left + r.width / 2; f.classList.add(d.after ? 'drop-after' : 'drop-before'); }
    if (y < 90) main.scrollBy(0, -18); else if (y > innerHeight - 110) main.scrollBy(0, 18);
  };
  const dEnd = (drop) => {
    const d = st.drag; if (!d) return;
    st.drag = null; d.ghost.remove(); grid.classList.remove('pe-dragging');
    grid.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((f) => f.classList.remove('dragging', 'drop-before', 'drop-after'));
    st.dragged = true; setTimeout(() => { st.dragged = false; }, 400);
    if (!drop || !d.target) return;
    let to = d.target + (d.after ? 1 : 0);
    if (d.p < to) to -= 1;
    movePage(d.p, to);
  };
  let pend = null, timer = null, t0 = null;
  grid.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) { const t = e.target.closest('.pe-tile'); pend = t ? { t, x: e.clientX, y: e.clientY } : null; } });
  const pmove = (e) => {
    if (e.pointerType !== 'mouse') return;
    if (st.drag) { e.preventDefault(); return dAt(e.clientX, e.clientY); }
    if (pend && Math.hypot(e.clientX - pend.x, e.clientY - pend.y) > 6) { if (pend.t.isConnected) dStart(pend.t, e.clientX, e.clientY); pend = null; }
  };
  const pup = (e) => { if (e.pointerType !== 'mouse') return; pend = null; if (st.drag) dEnd(true); };
  addEventListener('pointermove', pmove); addEventListener('pointerup', pup);
  grid.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.target.closest('.pe-tile'); if (!t) return;
    const tp = e.touches[0]; t0 = { x: tp.clientX, y: tp.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; dStart(t, t0.x, t0.y); navigator.vibrate?.(15); }, 350);
  }, { passive: true });
  grid.addEventListener('touchmove', (e) => {
    const tp = e.touches[0];
    if (st.drag) { e.preventDefault(); return dAt(tp.clientX, tp.clientY); }
    if (timer && t0 && Math.hypot(tp.clientX - t0.x, tp.clientY - t0.y) > 10) { clearTimeout(timer); timer = null; }
  }, { passive: false });
  grid.addEventListener('touchend', (e) => { clearTimeout(timer); timer = null; if (st.drag) { e.preventDefault(); dEnd(true); } });
  grid.addEventListener('touchcancel', () => { clearTimeout(timer); timer = null; dEnd(false); });
  grid.addEventListener('contextmenu', (e) => { if (st.drag || timer || e.target.closest('.pe-tile')) e.preventDefault(); });

  // ---------- keys (Mac) ----------
  const cols = () => getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const step = (d) => { if (!n()) return; const cur = st.anchor || [...st.sel][0] || 0; const p = Math.max(1, Math.min(n(), cur ? cur + d : 1)); st.sel = new Set([p]); st.anchor = p; paint(); focusTile(p); };
  const onKey = (e) => {
    if (!main.isConnected || !grid.isConnected) return;
    if (st.busy || document.querySelector('.modal-wrap, .menu') || e.target.matches?.('input, textarea')) return;
    const k = e.key, one = st.sel.size === 1 ? [...st.sel][0] : 0;
    const a = {
      ArrowRight: () => (e.shiftKey && one ? movePage(one, one + 1) : step(1)), ArrowLeft: () => (e.shiftKey && one ? movePage(one, one - 1) : step(-1)),
      ArrowDown: () => step(cols()), ArrowUp: () => step(-cols()),
      s: () => one && toggleMark(one), Enter: () => one && toggleMark(one), ' ': () => large(), Delete: delPages, Backspace: delPages,
      c: crop, m: mergePick, u: undo, z: undo, '?': help, Escape: () => { st.sel.clear(); st.moving = 0; paint(); },
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!a || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('button') && !e.target.closest('#pe-grid') && (k === 'Enter' || k === ' ')) return;
    e.preventDefault(); a();
  };
  addEventListener('keydown', onKey);
  const offUndo = onUndo(paintHead);

  // from Check suspect songs: ?mark=4,7 pre-marks the suggested song starts; ?sel=3 selects a page (back from Crop)
  (async () => {
    await load();
    if (!st.b) return;
    const mk = (q?.get?.('mark') || '').split(',').map(Number).filter((p) => p > 1 && p <= n() && !(p in st.b.starts));
    const sel = +q?.get?.('sel') || 0;
    if (q?.get?.('mark') || sel) history.replaceState(null, '', editorHash(id, q));
    if (sel && sel <= n()) { st.sel = new Set([sel]); st.anchor = sel; paint(); focusTile(sel); }
    if (mk.length) {
      const prev = { ...st.b.starts };
      for (const p of mk) st.b.starts[p] = st.b.guess?.[p] || '';
      render(); mk.forEach(detect);
      pushUndo('new song', () => api('POST', `/sheets/${encodeURIComponent(id)}/split`, { starts: prev }));
      const all = { ...st.b.starts };
      st.q = st.q.then(() => api('POST', `/sheets/${encodeURIComponent(id)}/split`, { starts: all })).catch((e) => toast(e.message));
    }
  })();
  paintHead();
  return () => { st.alive = false; flushAll(); offTaps(); offUndo(); removeEventListener('keydown', onKey); removeEventListener('pointermove', pmove); removeEventListener('pointerup', pup); st.drag?.ghost.remove(); };
}

// ================= crop one page, full screen =================
export function cropView(main, { id, page, q }) {
  if (store.mode !== 'server') { main.innerHTML = head({ title: 'Crop', sub: null }) + '<p class="mg-pad muted">Crop needs the Mac.</p>'; return; }
  const toItem = q?.get?.('back') === 'item' && q?.get?.('from') !== 'editor';
  const leave = (p) => { location.hash = toItem ? `#/item/${encodeURIComponent(id)}` : editorHash(id, q, p ? `sel=${p}` : ''); };
  const st = { info: null, p: page, stage: null, ver: store.get(id)?.updatedAt || 0, working: false, alive: true, boxes: null };
  const cancelHref = toItem ? `#/item/${encodeURIComponent(id)}` : editorHash(id, q, `sel=${page}`);
  main.innerHTML = `<div class="mg-full pe-crop">${head({ back: cancelHref, backLabel: 'Cancel', title: 'Crop', sub: 'Drag the corners or edges',
    right: '<button id="cr-ok" data-act="ok" title="Crop this page">Crop</button><button id="cr-oknext" class="primary" data-act="next" title="Crop and go to the next page (Enter)">Crop &amp; next ›</button>' })}
    <div class="cu-stage pe-cstage" id="cr-stage"><p class="muted">Loading…</p></div>
    <div class="pe-cbar">
      <label class="pe-toggle"><input type="checkbox" id="cr-carry" ${carryOn() ? 'checked' : ''}><span class="pe-sw" aria-hidden="true"></span><span>Use this box for the next pages</span></label>
      <span class="grow"></span><span class="muted small pe-from" id="cr-from"></span>
      <button data-act="boxes" id="cr-boxes">Saved boxes</button>
      <button data-act="whole" id="cr-whole" title="Whole page (W)">Whole page</button>
      <button class="ghost" data-act="orig" id="cr-orig" title="The photo as it came in" hidden>Back to original photo</button>
    </div></div>`;
  const total = () => st.info?.length || 0;
  const show = () => {
    const p = st.p, pi = st.info[p - 1];
    const [box, from] = pi.crop ? [pi.crop, 'Cropped'] : CARRY && carryOn() ? [CARRY, 'Same box as the last page'] : pi.suggest ? [pi.suggest, 'Suggested'] : [full(), 'Whole page'];
    st.stage = cropStage($('#cr-stage', main), { src: `/api/items/${encodeURIComponent(id)}/pages/${p}/original?v=${st.ver}`, box, from, onChange: (_, f) => { const el = $('#cr-from', main); if (el) el.textContent = f; } });
    $('.mg-t h2', main).innerHTML = `<span class="hide-phone">Crop page </span>${p} of ${total()}`;
    $('#cr-orig', main).hidden = !pi.trims;
    $('#cr-oknext', main).innerHTML = p < total() ? 'Crop &amp; next ›' : 'Crop &amp; finish';
    history.replaceState(null, '', `#/manage/pages/${encodeURIComponent(id)}/crop/${p}${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}`);
  };
  const go = (d) => { const p = Math.max(1, Math.min(total(), st.p + d)); if (p !== st.p) { st.p = p; show(); } };
  const same = (a, c) => a && c && ['top', 'bottom', 'left', 'right'].every((k) => Math.abs(a[k] - c[k]) < 0.0005);
  const after = async (item) => { store.putItem(item); st.ver = item.updatedAt; st.info = (await api('GET', `/items/${encodeURIComponent(id)}/crops`)).pages; };
  const apply = async (next) => {
    if (st.working || !st.stage) return;
    st.working = true;
    try {
      const p = st.p, pi = st.info[p - 1], box = boxOf(st.stage.box), prev = pi.crop;
      if (isFull(box)) {
        if (prev) {
          await after(await api('POST', `/items/${encodeURIComponent(id)}/pages/${p}/untrim`, { all: true }));
          pushUndo(`whole page ${p}`, async () => store.putItem(await api('POST', `/items/${encodeURIComponent(id)}/pages/${p}/trim`, prev)));
          toast(`Page ${p}: the whole photo`);
        }
      } else if (!same(prev, box)) {
        await after(await api('POST', `/items/${encodeURIComponent(id)}/pages/${p}/trim`, box));
        CARRY = box;
        pushUndo(`crop page ${p}`, async () => store.putItem(await api('POST', `/items/${encodeURIComponent(id)}/pages/${p}/untrim`, {})));
        toast(`Page ${p} cropped — the photo is kept`);
      }
      if (next && p < total()) go(1); else leave(p);
    } catch (e) { toast(e.message); } finally { st.working = false; }
  };
  const boxesMenu = (anchor) => {
    const b = st.boxes; if (!b) return;
    menu(anchor, [1, 2].flatMap((k) => [
      { label: b.get(k) ? `Use box ${k}` : `Box ${k} (not saved yet)`, run: () => b.use(k), disabled: !b.get(k) },
      { label: `Save this box as box ${k}`, run: () => b.save(k) },
    ]));
  };
  const offTaps = taps(main, '[data-act]', (el) => {
    const a = el.dataset.act;
    if (a === 'ok') return apply(false);
    if (a === 'next') return apply(true);
    if (a === 'whole') return st.stage?.set(full(), 'Whole page');
    if (a === 'orig') { st.stage?.set(full(), 'Original photo'); return apply(false); }
    if (a === 'boxes') return boxesMenu(el);
  });
  $('#cr-carry', main).onchange = (e) => { try { localStorage.setItem('meowsic-crop-carry', e.target.checked ? '1' : '0'); } catch {} };
  const onKey = (e) => {
    if (!main.isConnected || !st.stage || document.querySelector('.modal-wrap, .menu')) return;
    if (e.metaKey || e.ctrlKey || e.target.matches?.('input[type=search], textarea')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, s = st.stage;
    if ((e.code === 'Digit1' || e.code === 'Digit2') && st.boxes) { e.preventDefault(); const n = +e.code.slice(-1); return e.shiftKey ? st.boxes.save(n) : st.boxes.use(n); }
    const a = e.altKey ? { ArrowLeft: () => s.nudge(e.shiftKey ? 'right' : 'left', -0.005), ArrowRight: () => s.nudge(e.shiftKey ? 'right' : 'left', 0.005) }[k]
      : { ArrowUp: () => s.nudge(e.shiftKey ? 'bottom' : 'top', -0.005), ArrowDown: () => s.nudge(e.shiftKey ? 'bottom' : 'top', 0.005),
        ArrowLeft: () => go(-1), ArrowRight: () => go(1), Enter: () => apply(true), w: () => s.set(full(), 'Whole page'), Escape: () => { location.hash = cancelHref; } }[k];
    if (!a) return;
    e.preventDefault(); a();
  };
  addEventListener('keydown', onKey);
  (async () => {
    try {
      const it = await api('GET', `/items/${encodeURIComponent(id)}`);
      if (it.book) throw new Error('Books are kept as the PDF they came in: their pages can’t be cropped.');
      st.ver = it.updatedAt; store.putItem(it);
      st.info = (await api('GET', `/items/${encodeURIComponent(id)}/crops`)).pages;
      if (!st.info.length) throw new Error('This sheet has no pages.');
    } catch (e) { $('#cr-stage', main).innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    if (!st.alive) return;
    st.p = Math.max(1, Math.min(total(), st.p));
    show();
    st.boxes = await savedBoxes(() => st.stage);
  })();
  return () => { st.alive = false; offTaps(); removeEventListener('keydown', onKey); };
}

