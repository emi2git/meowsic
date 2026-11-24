// Manage library → Check suspect songs (#/manage/review): the Mac's check (a job; the header's check-again button
// runs it with a progress bar) lists sheets that look wrong (books are never checked: read-only PDFs). One sheet at
// a time: what looks wrong in plain words, its pages with the suspect ones marked, and
//   the fix that fits      Split at page N (asks first, then splits) · Merge with “X” · Delete page N · Fix order…
//   Fix pages…             the page editor (no song break placed: the user taps New song here)
//   ✓ (round)              "This is a complete song": checks leave it out from now on (toast Undo; the hub's Undo)
//   Skip                   to the end of the queue
import { store } from '../store.js';
import { $, esc, iconOn, toast, ago, confirmSheet, sheet as modal } from '../ui.js';
import { api, head, plural, sleep, thumb, listPages, range, taps, pushAct, pushUndo, undoLast } from './managekit.js';

const FLAG = { several: 'New song?', order: 'Order?', duplicate: 'Same page?', blank: 'Blank?' };
const STRIP_MAX = 12;
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const sentence = (s) => { s = cap(s).trim(); return /[.!?”"]$/.test(s) ? s : s + '.'; };

export function reviewView(main) {
  if (store.mode !== 'server') { main.innerHTML = head({ title: 'Check suspect songs', sub: null }) + '<p class="mg-pad muted">Checking needs the Mac.</p>'; return; }
  const st = { items: null, scan: null, queue: [], i: 0, done: 0, job: null, alive: true, busy: false };
  main.innerHTML = head({ title: 'Check suspect songs', sub: null, right: `<button class="mg-ib" id="rv-scan" data-act="scan" title="Check again" aria-label="Check again">${iconOn('restore')}</button>` })
    + '<div class="mg-progress"><i id="mg-bar"></i></div><div class="mg-pad mg-wrap" id="rv"><p class="muted">Loading…</p></div>';
  const body = $('#rv', main);
  const itemOf = (id) => st.items?.find((x) => x.id === id);

  // one entry per sheet, its reasons most likely first (the scan is sorted already)
  const build = () => {
    const by = new Map();
    for (const c of st.scan?.candidates || []) {
      if (!itemOf(c.id)) continue;
      if (!by.has(c.id)) by.set(c.id, { id: c.id, cands: [] });
      by.get(c.id).cands.push(c);
    }
    st.queue = [...by.values()];
    st.i = 0;
  };
  const load = async () => {
    try { const r = await api('GET', '/organize'); st.items = r.items; st.scan = r.scan; if (r.job && !st.job) watch(r.job.id); } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    build(); draw();
  };

  // ---------- header line ----------
  const paintHead = () => {
    const bar = $('#mg-bar', main), n = st.queue.length, total = n + st.done, sc = $('#rv-scan', main);
    sc.disabled = !!st.job; sc.classList.toggle('spin', !!st.job);
    sc.title = st.job ? `Checking… ${Math.round((st.job.progress || 0) * 100)}%` : st.scan ? `Check again (checked ${ago(st.scan.at).toLowerCase()})` : 'Check now';
    if (st.job) { bar.style.width = `${Math.max(2, (st.job.progress || 0) * 100)}%`; return; }
    bar.style.width = `${total ? Math.max(2, (st.done / total) * 100) : 100}%`;
  };

  // ---------- what looks wrong, in plain words ----------
  const words = (x, c) => {
    const t = `“${x.title}”`, ps = c.pages || [];
    if (c.kind === 'several') return { h: `${t} might be two songs`, p: sentence(c.reason) };
    if (c.kind === 'merge') return { h: `${t} might be half a song`, p: sentence(c.reason) };
    if (c.kind === 'order') return { h: `The pages of ${t} might be out of order`, p: sentence(c.reason) };
    if (c.kind === 'duplicate') return { h: `${t} might have the same page twice`, p: sentence(c.reason) };
    if (c.kind === 'blank') return { h: ps.length > 1 ? `${t} might have blank pages` : `${t} might have a blank page`, p: sentence(c.reason) };
    return { h: t, p: sentence(c.reason) };
  };
  // the fix that fits the reason: {label, run} or null (then Fix pages… is the main button)
  const primary = (x, c) => {
    const ps = (c.pages || []).filter((p) => p > 1 && p <= x.pages);
    if (c.kind === 'several' && ps.length) return { label: `Split at ${listPages(ps.slice(0, 3))}`, run: () => split(x, ps.slice(0, 3)) };
    if (c.kind === 'merge' && c.others?.length) return { label: `Merge with “${c.otherTitles?.[0] || 'the other part'}”`, run: () => merge(x, c.others[0], c.otherTitles?.[0] || '') };
    if (c.kind === 'blank' && c.pages?.length && c.pages.length < x.pages) return { label: `Delete ${listPages(c.pages)}`, run: () => del(x, c.pages) };
    if (c.kind === 'duplicate' && c.pages?.length === 2) return { label: `Delete page ${c.pages[1]}`, run: () => del(x, [c.pages[1]]) };
    if (c.kind === 'order') return { label: 'Fix order…', run: () => fix(x, c) };
    return null;
  };

  const stripHtml = (x, flags, label) => {
    let ps = Array.from({ length: x.pages }, (_, k) => k + 1);
    if (ps.length > STRIP_MAX) {  // a long sheet: the pages around the flagged ones
      const keep = new Set([1]);
      for (const f of flags) for (let d = -2; d <= 2; d++) if (f + d >= 1 && f + d <= x.pages) keep.add(f + d);
      for (let p = 2; keep.size < STRIP_MAX && p <= x.pages; p++) keep.add(p);
      ps = [...keep].sort((a, b) => a - b).slice(0, STRIP_MAX);
    }
    return `<div class="rv-strip">${ps.map((p) => `<button class="rv-pg${flags.includes(p) ? ' flag' : ''}" data-act="page" data-id="${esc(x.id)}" data-p="${p}" aria-label="Page ${p}">${flags.includes(p) && label ? `<span class="rv-lbl">${esc(label)}</span>` : ''}<img src="${thumb(x.id, p, x.updatedAt, 300)}" alt="" loading="lazy" draggable="false"><span class="rv-n">${p}</span></button>`).join('')}</div>`;
  };

  const draw = () => {
    if (!st.alive) return;
    paintHead();
    const g = st.queue[st.i];
    if (!st.scan && !st.job) {
      body.innerHTML = `<div class="mg-emptybox"><h2>Not checked yet</h2><button class="primary" data-act="scan">Check now</button></div>`;
      return;
    }
    if (!g) {
      body.innerHTML = `<div class="mg-emptybox"><h2>${st.job ? 'Checking…' : 'Nothing to check'}</h2></div>`;
      return;
    }
    const x = itemOf(g.id), c = g.cands[0], w = words(x, c), pr = primary(x, c);
    const other = c.kind === 'merge' && c.others?.[0] ? st.items.find((y) => y.id === c.others[0]) : null;
    body.innerHTML = `<section class="rv-card" data-id="${esc(x.id)}">
        <div class="rv-why"><span class="rv-ico">${iconOn('warn')}</span><div><h2 id="rv-h">${esc(w.h)}</h2><p>${esc(w.p)}</p></div></div>
        ${stripHtml(x, (c.pages || []).filter((p) => p <= x.pages), FLAG[c.kind])}
        ${other ? `<p class="rv-sub">“${esc(other.title)}” · ${plural(other.pages, 'page')}</p>${stripHtml(other, [], '')}` : ''}
        <div class="rv-act">
          ${pr ? `<button class="primary" data-act="primary" id="rv-primary">${esc(pr.label)}</button>` : ''}
          <button class="${pr ? '' : 'primary'}" data-act="fix" id="rv-fix">Fix pages…</button>
          <span class="grow"></span>
          <button class="ghost" data-act="skip" id="rv-skip">Skip</button>
          <button class="mg-ib rv-fine" data-act="fine" id="rv-fine" title="This is a complete song" aria-label="This is a complete song">${iconOn('check')}</button>
        </div></section>`;
  };

  // ---------- moving on ----------
  const doneWith = (id) => {
    const k = st.queue.findIndex((g) => g.id === id);
    if (k >= 0) { st.queue.splice(k, 1); st.done++; if (st.i >= st.queue.length) st.i = 0; else if (k < st.i) st.i--; }
    draw(); main.scrollTop = 0;
  };
  const busy = async (fn) => { if (st.busy) return; st.busy = true; try { return await fn(); } catch (e) { toast(e.message); } finally { st.busy = false; } };

  const fine = (x) => busy(async () => {
    const r = await api('POST', '/organize/reviewed', { id: x.id, on: true });
    x.reviewed = true;
    if (r.activity) pushUndo('it’s fine', async () => { await api('POST', `/activity/${encodeURIComponent(r.activity)}/undo`, {}); x.reviewed = false; });
    toast('Marked as a complete song', { label: 'Undo', run: async () => { if (await undoLast()) { st.done = Math.max(0, st.done - 1); await load(); } } });
    doneWith(x.id);
  });
  const split = async (x, ps) => {
    const sg = [1, ...ps].map((p, k, a) => ({ start: p, end: k + 1 < a.length ? a[k + 1] - 1 : x.pages }));
    if (!(await confirmSheet({ title: `Split “${x.title}” into ${plural(sg.length, 'sheet')}?`, body: `${sg.map((s, k) => `${k ? 'New sheet' : 'This sheet'}: ${range(s.start, s.end)}`).join(' · ')}. The first song keeps this sheet. Undo puts everything back.`, ok: `Split into ${plural(sg.length, 'sheet')}` }))) return;
    await busy(async () => {
      const cur = (await api('GET', `/sheets/${encodeURIComponent(x.id)}/split`)).starts || {};
      const starts = { ...cur };
      for (const p of ps) if (!(p in starts)) {
        let t = ''; try { const r = await api('GET', `/items/${encodeURIComponent(x.id)}/pages/${p}/title`); if (r.title && r.confidence >= 0.5) t = r.title; } catch {}
        starts[p] = t;
      }
      const r = await api('POST', `/sheets/${encodeURIComponent(x.id)}/make-sheets`, { starts });
      store.putItem(r.book); for (const s of r.sheets) store.putItem(s);
      pushUndo('split songs', async () => { const u = await api('POST', `/sheets/${encodeURIComponent(x.id)}/unmake`); store.putItem(u.book); store.drop(u.removed); });
      toast(`${plural(r.sheets.length, 'new sheet')} from “${x.title}”`, { label: 'Undo', run: () => undoLast() });
      doneWith(x.id);
    });
  };
  const merge = async (x, other, otherTitle) => {
    const o = itemOf(other);
    if (!(await confirmSheet({ title: `Add the pages of “${otherTitle}” after the pages of “${x.title}”?`, body: `“${x.title}” gets ${plural(o?.pages || 0, 'more page')}; “${otherTitle}”, empty then, goes to the Trash. Undo puts it all back.`, ok: 'Merge' }))) return;
    await busy(async () => {
      const r = await api('POST', `/items/${encodeURIComponent(x.id)}/join`, { other });
      store.putItem(r.item); if (r.other) store.putItem(r.other);
      pushAct(`merge “${otherTitle}”`, r.activity, [x.id, other]);
      toast(`Merged “${otherTitle}” into “${x.title}”`, { label: 'Undo', run: () => undoLast() });
      st.queue = st.queue.filter((g) => g.id !== other);
      doneWith(x.id);
    });
  };
  const del = async (x, ps) => {
    if (ps.length > 1 && !(await confirmSheet({ title: `Delete ${plural(ps.length, 'page')} of “${x.title}”?`, body: `${cap(listPages(ps))} go to the sheet’s history. Undo brings them back.`, ok: 'Delete', danger: true }))) return;
    await busy(async () => {
      const order = Array.from({ length: x.pages }, (_, k) => k + 1).filter((p) => !ps.includes(p));
      const r = await api('POST', `/items/${encodeURIComponent(x.id)}/pages/arrange`, { order });
      store.putItem(r.item);
      pushAct(`delete ${listPages(ps)}`, r.activity, [x.id]);
      toast(`${cap(listPages(ps))} of “${x.title}” deleted`, { label: 'Undo', run: () => undoLast() });
      doneWith(x.id);
    });
  };
  const fix = (x) => { location.hash = `#/manage/pages/${encodeURIComponent(x.id)}`; };
  const skip = () => { if (st.queue.length > 1) { st.i = (st.i + 1) % st.queue.length; draw(); main.scrollTop = 0; } else toast('This is the last one'); };
  const page = (id, p) => {
    const x = itemOf(id); if (!x) return;
    let n = p;
    const m = modal(`<div class="pe-large"><img id="rv-big" alt=""></div><div class="modal-actions"><button data-a="-1" aria-label="Previous page">‹</button><span class="grow muted small center" id="rv-lt"></span><button data-a="1" aria-label="Next page">›</button><button class="primary" data-close>Close</button></div>`, { wide: true });
    const show = () => { $('#rv-big', m.el).src = store.pageUrl(id, n, x.updatedAt); $('#rv-lt', m.el).textContent = `${x.title} · page ${n} of ${x.pages}`; };
    m.el.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { n = Math.max(1, Math.min(x.pages, n + +b.dataset.a)); show(); }; });
    show();
  };

  // ---------- check again: a job on the Mac, with progress ----------
  const scan = async () => {
    if (st.job) return;
    try { const j = await api('POST', '/organize/scan', {}); watch(j.id); } catch (e) { toast(e.message); }
  };
  const watch = async (jid) => {
    st.job = { id: jid, progress: 0 }; paintHead(); if (!st.queue.length) draw();
    while (st.alive) {
      let j = null; try { j = await api('GET', `/jobs/${encodeURIComponent(jid)}`); } catch {}
      if (!j) break;
      st.job.progress = j.progress || 0; paintHead();
      if (!['queued', 'running'].includes(j.status)) { if (j.status !== 'done') toast(`The check stopped: ${(j.log?.at(-1)?.msg) || j.status}`); break; }
      await sleep(800);
    }
    st.job = null;
    if (!st.alive) return;
    st.done = 0;
    await load();
    if (st.scan) toast(`${plural(st.queue.length, 'sheet')} to check`);
  };

  const off = taps(main, '[data-act]', (el) => {
    const g = st.queue[st.i], x = g && itemOf(g.id), c = g?.cands[0];
    switch (el.dataset.act) {
      case 'scan': return scan();
      case 'primary': return x && primary(x, c)?.run();
      case 'fix': return x && fix(x, c);
      case 'fine': return x && fine(x);
      case 'skip': return skip();
      case 'page': return page(el.dataset.id, +el.dataset.p);
    }
  });
  const onKey = (e) => {
    if (document.querySelector('.modal-wrap, .menu') || e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input, textarea')) return;
    const g = st.queue[st.i], x = g && itemOf(g.id); if (!x) return;
    const a = { s: skip, f: () => fine(x), Enter: () => primary(x, g.cands[0])?.run() }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (a && !e.target.closest?.('button')) { e.preventDefault(); a(); }
  };
  addEventListener('keydown', onKey);
  load();
  return () => { st.alive = false; off(); removeEventListener('keydown', onKey); };
}
