// Clean up → Books → sheets. Some books are really sheets grouped together: open a book, go through its
// pages and mark the page where each new sheet starts (with its title). A sheet runs from its start to the
// page before the next start; pages before the first start stay in the book. Marks and titles are kept on
// the Mac as you go (work/cleanup.json 'booksplit'), so you can stop and go on later.
// "Make N sheets…" moves those pages into new sheets in one go; Undo puts every page back into the book.
import { store } from '../store.js';
import { isDesktop, isNarrow } from '../device.js';
import { $, esc, toast, sheet as modal } from '../ui.js';

export const BOOK_KEYS = [
  ['← → ↑ ↓', 'Move between pages'],
  ['S / Enter', 'A new sheet starts here (again: not)'],
  ['Space', 'View the page large'],
  ['U / Z', 'Undo'],
];
const SEGS = 6; // colours for the sheets (seg-0 … seg-5), then they repeat

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'The Mac said no.');
  return data;
};
const range = (a, b) => (a === b ? `page ${a}` : `pages ${a}–${b}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ctx: { body, st (Clean up state, for st.undo), busy(fn), undo(), help(), tab(name) }
export function makeBooks(ctx) {
  const { body, st } = ctx;
  let id0 = null; try { id0 = localStorage.getItem('meowsic-cu-book'); } catch {}
  const bs = { books: null, id: id0, book: null, starts: {}, focus: 1, list: !id0, saving: {}, loading: false, q: Promise.resolve(), det: {} };
  // title detection (the Mac reads the biggest text at the top of the page): det[bookId:page] = { state, title, typed }
  const det = (p, id = bs.id) => (bs.det[`${id}:${p}`] ||= {});
  const book = () => bs.books?.find((b) => b.id === bs.id);

  const segs = () => {
    const n = bs.book?.pages || 0, s = Object.keys(bs.starts).map(Number).sort((a, b) => a - b);
    return s.map((p, k) => ({ k, start: p, end: k + 1 < s.length ? s[k + 1] - 1 : n, title: bs.starts[p] || '' }));
  };
  const segOf = (p, sg = segs()) => sg.findIndex((x) => p >= x.start && p <= x.end);
  const nameOf = (x) => x.title.trim() || `${bs.book.title} — p${x.start}`;

  const fetchList = async () => { bs.books = (await api('GET', '/books/split')).books; };
  const fetchBook = async () => {
    const d = await api('GET', `/books/${encodeURIComponent(bs.id)}/split`);
    bs.book = d; bs.starts = { ...d.starts };
    bs.focus = Math.max(1, Math.min(bs.focus, d.pages || 1));
  };

  // ---------- drawing ----------
  const draw = async () => {
    let fresh = false;
    if (!bs.books || (bs.id && !bs.book)) {
      fresh = true;
      if (bs.loading) return;
      bs.loading = true;
      if (!body.querySelector('.bs')) body.innerHTML = '<p class="pad muted">Loading the books…</p>';
      try {
        if (!bs.books) await fetchList();
        if (bs.id && !book()) { bs.id = bs.books[0]?.id || null; bs.list = true; }
        if (!bs.id && !isNarrow()) bs.id = bs.books[0]?.id || null;
        if (bs.id) await fetchBook();
      } catch (e) { toast(e.message); bs.loading = false; return; }
      bs.loading = false;
      if (st.tab !== 'books') return;
    }
    if (!bs.books.length) { body.innerHTML = '<p class="pad muted">No books. (A book is a sheet you made into a book in the library.)</p>'; return; }
    const grid = $('#bs-grid', body);
    if (!fresh && grid && grid.dataset.id === bs.id) return paint(); // same book on screen: only marks and titles change
    render();
  };

  const listHtml = () => bs.books.map((b) => {
    const n = Object.keys(b.id === bs.id ? bs.starts : b.starts).length;
    return `<li data-id="${esc(b.id)}" class="${b.id === bs.id ? 'on' : ''} ${n ? 'marked' : ''}"><b>${esc(b.title)}</b><small>${plural(b.pages, 'page')}${n ? ` · <span class="bs-cnt">${plural(n, 'sheet')} marked</span>` : ''}</small></li>`;
  }).join('');

  const render = () => {
    const b = bs.book;
    try { if (bs.id) localStorage.setItem('meowsic-cu-book', bs.id); } catch {}
    body.innerHTML = `<div class="bs ${b && !bs.list ? 'has-book' : ''}">
      <aside class="bs-side"><p class="bs-side-h muted small">Books — open one, mark where each sheet starts</p><ol class="bs-list" id="bs-list">${listHtml()}</ol></aside>
      <section class="bs-main">${b ? `
        <div class="bs-bar">
          <button class="ghost bs-back" id="bs-back">‹ Books</button>
          <div class="bs-name"><b>${esc(b.title)}</b><small class="muted">${plural(b.pages, 'page')} · tap the page where a new sheet starts</small></div>
        </div>
        <div class="bs-segs" id="bs-segs"></div>
        <div class="bs-grid" id="bs-grid" data-id="${esc(b.id)}">${(b.files || []).map((f, k) => `<figure data-p="${k + 1}">
          <button class="bs-pg" data-p="${k + 1}" aria-label="Page ${k + 1}"><img src="/api/items/${encodeURIComponent(b.id)}/thumb/${k + 1}?w=500&v=${b.updatedAt || 0}" alt="" loading="lazy" draggable="false">
            <span class="bs-flag"></span></button>
          <button class="bs-zoom" data-z="${k + 1}" aria-label="View page ${k + 1} large" title="View large (Space)">⤢</button>
          <figcaption><span class="bs-n">${k + 1}</span><span class="bs-t"></span></figcaption></figure>`).join('')}</div>
        <div class="bs-act"><span class="muted small bs-hint" id="bs-hint"></span><span class="grow"></span>
          <button id="bs-make" class="primary big">Make sheets…</button></div>` : '<p class="pad muted">Pick a book.</p>'}</section></div>`;
    $('#bs-list', body).onclick = (e) => { const li = e.target.closest('[data-id]'); if (li) openBook(li.dataset.id); };
    if (!b) return;
    $('#bs-back', body).onclick = () => { bs.list = true; body.querySelector('.bs').classList.remove('has-book'); };
    $('#bs-make', body).onclick = make;
    const g = $('#bs-grid', body);
    g.onclick = (e) => {
      if (e.target.closest('input')) return;
      const z = e.target.closest('[data-z]'); if (z) { bs.focus = +z.dataset.z; paint(); return large(); }
      const p = e.target.closest('.bs-pg'); if (p) { bs.focus = +p.dataset.p; toggle(bs.focus); }
    };
    paint();
    g.querySelector(`figure[data-p="${bs.focus}"]`)?.scrollIntoView({ block: 'nearest' });
    prefetch();
  };

  // marks, colour bands, title boxes and the summary — without reloading the page images
  const paint = () => {
    const g = $('#bs-grid', body); if (!g) return;
    const sg = segs();
    for (const fig of g.children) {
      const p = +fig.dataset.p, k = segOf(p, sg), start = p in bs.starts;
      fig.className = `${k < 0 ? 'lead' : 'seg-' + (k % SEGS)}${start ? ' start' : ''}${p === bs.focus ? ' focus' : ''}`;
      fig.querySelector('.bs-flag').textContent = start ? `Sheet ${k + 1} starts` : '';
      fig.querySelector('.bs-pg').setAttribute('aria-pressed', start);
      const t = fig.querySelector('.bs-t');
      t.textContent = k < 0 ? 'stays in the book' : start ? '' : `sheet ${k + 1}`;
      let inp = fig.querySelector('input');
      if (start && !inp) {
        inp = document.createElement('input');
        inp.className = 'bs-title'; inp.placeholder = 'Title of this sheet'; inp.enterKeyHint = 'done';
        inp.setAttribute('aria-label', `Title of sheet starting on page ${p}`);
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
    paintSegs();
    const lst = $('#bs-list', body); if (lst) { lst.innerHTML = listHtml(); }
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
    const ok = d.state === 'ok', r = { title: d.title };
    if (bs.id !== id || !(p in bs.starts)) return;
    const cur = (bs.starts[p] || '').trim();
    if (ok && !d.typed && (!cur || cur === bs.book?.guess?.[p])) {
      bs.starts[p] = r.title;
      bs.saving[p] = 0; flushTitle(p);
    }
    paint();
  };
  // starts already marked whose title is still empty: read them one after the other
  const prefetch = async () => {
    const id = bs.id;
    for (const p of Object.keys(bs.starts).map(Number).sort((a, b) => a - b)) {
      if (bs.id !== id || st.tab !== 'books') return;
      if (!(bs.starts[p] || '').trim()) await detect(p);
    }
  };
  const paintSegs = () => {
    const sg = segs(), b = bs.book, el = $('#bs-segs', body); if (!el || !b) return;
    const lead = sg.length ? sg[0].start - 1 : b.pages;
    el.innerHTML = (lead ? `<span class="bs-seg lead">Stays in the book: ${range(1, lead)}</span>` : sg.length ? '<span class="bs-seg lead">Nothing stays in the book — it goes to the Trash</span>' : '')
      + sg.map((x) => `<button class="bs-seg seg-${x.k % SEGS}" data-go="${x.start}"><b>Sheet ${x.k + 1}:</b> ${range(x.start, x.end)}${x.title.trim() ? ` · ${esc(x.title.trim())}` : ''}</button>`).join('');
    el.onclick = (e) => { const s = e.target.closest('[data-go]'); if (s) { bs.focus = +s.dataset.go; paint(); focusFig(); } };
    const mk = $('#bs-make', body);
    mk.textContent = sg.length ? `Make ${plural(sg.length, 'sheet')}…` : 'Make sheets…';
    mk.disabled = !sg.length;
    $('#bs-hint', body).textContent = sg.length ? `${plural(sg.length, 'sheet')} marked · saved on the Mac` : 'Tap the first page of each sheet';
  };
  const focusFig = () => $('#bs-grid', body)?.querySelector(`figure[data-p="${bs.focus}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const openBook = async (id) => {
    if (id === bs.id && bs.book) { bs.list = false; body.querySelector('.bs')?.classList.add('has-book'); return; }
    flushAll();
    bs.id = id; bs.book = null; bs.focus = 1; bs.list = false;
    draw();
  };

  // ---------- marks ----------
  const setStarts = async (starts) => {
    bs.starts = { ...(await api('POST', `/books/${encodeURIComponent(bs.id)}/split`, { starts })).starts };
    const b = book(); if (b) b.starts = { ...bs.starts };
  };
  // marks apply at once on screen; the Mac is told in order (one request after the other)
  const toggle = (p) => {
    if (!bs.book) return;
    flushAll();
    const prev = { ...bs.starts }, on = !(p in bs.starts), id = bs.id;
    if (on) bs.starts[p] = bs.book.guess?.[p] || ''; else { delete bs.starts[p]; det(p).typed = false; }
    paint();
    if (on) detect(p);
    if (on && !bs.starts[p] && isDesktop() && !document.querySelector('.modal')) $('#bs-grid', body)?.querySelector(`figure[data-p="${p}"] input`)?.focus({ preventScroll: true });
    st.undo.push({ label: on ? 'mark' : 'unmark', tab: 'books', run: async () => {
      await bs.q;
      if (bs.id !== id) { bs.id = id; bs.book = null; }
      bs.list = false; bs.focus = p;
      const s = (await api('POST', `/books/${encodeURIComponent(id)}/split`, { starts: prev })).starts;
      bs.starts = { ...s }; const bb = bs.books?.find((x) => x.id === id); if (bb) bb.starts = { ...s };
    } });
    ctx.drawHead();
    return (bs.q = bs.q.then(async () => {
      const r = await api('POST', `/books/${encodeURIComponent(id)}/split`, on ? { page: p, on: true, title: bs.starts[p] ?? '' } : { page: p, on: false });
      const b = bs.books?.find((x) => x.id === id); if (b) b.starts = { ...r.starts };
    }).catch((e) => toast(e.message)));
  };
  // titles save as you type (500 ms) and on leaving the box
  const saveTitle = (p) => { clearTimeout(bs.saving[p]); bs.saving[p] = setTimeout(() => flushTitle(p), 500); };
  const flushTitle = (p) => {
    if (!(p in bs.saving)) return;
    clearTimeout(bs.saving[p]); delete bs.saving[p];
    if (!(p in bs.starts)) return;
    const id = bs.id, title = bs.starts[p];
    return (bs.q = bs.q.then(() => api('POST', `/books/${encodeURIComponent(id)}/split`, { page: p, on: true, title }))
      .then((r) => { const b = bs.books?.find((x) => x.id === id); if (b) b.starts = { ...r.starts }; })
      .catch(() => toast('Title not saved — the Mac said no')));
  };
  const flushAll = () => Promise.all(Object.keys(bs.saving).map((p) => flushTitle(+p)));

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
      $('#bs-big', m.el).src = store.fileUrl(b.id, b.files[p - 1]) + `?v=${b.updatedAt || 0}`;
      $('#bs-lt', m.el).textContent = `Page ${p} of ${b.pages} · ${k < 0 ? 'stays in the book' : `sheet ${k + 1}`}`;
      const lm = $('#bs-lm', m.el); lm.textContent = p in bs.starts ? 'Not a new sheet' : 'A new sheet starts here'; lm.classList.toggle('on', p in bs.starts);
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
    // swipe left / right on touch
    let x0 = null;
    const big = $('.bs-large', m.el);
    big.onpointerdown = (e) => { x0 = e.clientX; };
    big.onpointerup = (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 50) step(e.clientX < x0 ? 1 : -1); x0 = null; };
    show();
  };

  // ---------- make the sheets ----------
  const make = async () => {
    await flushAll(); await bs.q;
    const sg = segs(), b = bs.book;
    if (!sg.length) return toast('Tap the page where a sheet starts first');
    const lead = sg[0].start - 1;
    const m = modal(`<h2>Make ${plural(sg.length, 'sheet')} from “${esc(b.title)}”?</h2>
      <ol class="bs-confirm">${sg.map((x) => `<li class="seg-${x.k % SEGS}"><b>${esc(nameOf(x))}</b> <span class="muted">${range(x.start, x.end)} (${x.end - x.start + 1} p)</span></li>`).join('')}</ol>
      <p class="muted small">${lead ? `${range(1, lead).replace(/^p/, 'P')} stay in the book.` : 'No pages are left in the book, so it goes to the Trash.'} Undo puts everything back.</p>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Make ${plural(sg.length, 'sheet')}</button></div>`);
    m.el.querySelector('[data-ok]').onclick = () => ctx.busy(async () => {
      const id = b.id, title = b.title;
      const r = await api('POST', `/books/${encodeURIComponent(id)}/make-sheets`, { starts: bs.starts });
      m.close();
      store.putItem(r.book); for (const s of r.sheets) store.putItem(s);
      st.undo.push({ label: 'make sheets', tab: 'books', run: async () => {
        const u = await api('POST', `/books/${encodeURIComponent(id)}/unmake`);
        store.putItem(u.book); store.drop(u.removed);
        bs.books = null; bs.id = id; bs.book = null; bs.list = false;
      } });
      toast(`${plural(r.sheets.length, 'new sheet')} from “${title}”${r.book.deleted ? ' · the book went to the Trash' : ''}`);
      bs.books = null; bs.book = null;
      if (r.book.deleted) { bs.id = null; bs.list = true; }
      draw();
    });
  };

  // ---------- keys (Mac) ----------
  const cols = () => { const g = $('#bs-grid', body); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 1; };
  const move = (d) => { if (!bs.book) return; bs.focus = Math.max(1, Math.min(bs.book.pages, bs.focus + d)); paint(); focusFig(); };
  const onKey = (e) => {
    const k = e.key;
    const a = {
      ArrowRight: () => move(1), ArrowLeft: () => move(-1), ArrowDown: () => move(cols()), ArrowUp: () => move(-cols()),
      s: () => bs.book && toggle(bs.focus), Enter: () => bs.book && toggle(bs.focus), ' ': large,
      u: ctx.undo, z: ctx.undo, '?': ctx.help,
      1: () => ctx.tab('sort'), 2: () => ctx.tab('songs'), 3: () => ctx.tab('titles'), 4: () => ctx.tab('books'),
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!a || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('button') && !e.target.closest('#bs-grid') && (k === 'Enter' || k === ' ')) return; // a focused button does its own thing
    e.preventDefault(); a();
  };

  return { draw, onKey, flush: flushAll };
}
