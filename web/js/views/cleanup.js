// Clean up: trim screen junk off sheet pages (✕ button, status bar, player bar, page dots) and fix odd
// titles. The Mac finds the junk and suggests a trim; you check each one, move the lines if needed, and
// trim. Everything can be undone (Z), and the original photo is always kept.
import { store } from '../store.js';
import { $, esc, toast, sheet as modal, confirmSheet } from '../ui.js';

const KEYS = [
  ['Enter / T', 'Trim as shown, next page'],
  ['F', 'Looks fine — no trim'],
  ['→ / J', 'Next'], ['← / K', 'Back'],
  ['↑ ↓', 'Move the top line'], ['Shift ↑ ↓', 'Move the bottom line'],
  ['R', 'Rename the song'],
  ['Z / ⌘Z', 'Undo the last thing'],
  ['O', 'Back to the original photo'],
  ['1 / 2', 'Pages tab / Titles tab'],
  ['?', 'These shortcuts'],
];

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'The Mac said no.');
  return data;
};

export function cleanupView(main) {
  if (store.mode !== 'server') {
    main.innerHTML = '<header class="top"><h1>Clean up</h1></header><p class="pad muted">Clean up needs the Mac.</p>';
    return;
  }
  const st = { tab: 'pages', pages: [], titles: [], i: 0, ti: 0, scan: null, crop: null, undo: [], busy: false, renaming: false };
  main.innerHTML = `<header class="top"><h1>Clean up</h1>
      <div class="cu-tabs" role="tablist"><button data-tab="pages">Pages to trim <i id="cu-np"></i></button><button data-tab="titles">Odd titles <i id="cu-nt"></i></button></div>
      <span class="muted small" id="cu-scan"></span>
      <div class="top-actions"><button id="cu-all" class="ghost">Trim all…</button><button id="cu-rescan" class="ghost">Scan again</button><button id="cu-keys" class="ghost" title="Keyboard shortcuts (?)">⌨︎ Keys</button></div></header>
    <div class="cu" id="cu"></div>`;
  const body = $('#cu', main);

  const load = async () => {
    const d = await api('GET', '/cleanup');
    st.scan = d.scan;
    const was = st.pages[st.i] && `${st.pages[st.i].id}:${st.pages[st.i].page}`;
    st.pages = d.pages; st.titles = d.titles;
    if (was) { const k = st.pages.findIndex((p) => `${p.id}:${p.page}` === was); if (k >= 0) st.i = k; }
    st.i = Math.min(st.i, Math.max(0, st.pages.length - 1));
    st.ti = Math.min(st.ti, Math.max(0, st.titles.length - 1));
    draw();
    if (d.scan.running) setTimeout(() => main.isConnected && load(), 4000);
  };

  const cur = () => st.pages[st.i];
  const drawHead = () => {
    $('#cu-np', main).textContent = st.pages.filter((p) => p.suggest).length || '';
    $('#cu-nt', main).textContent = st.titles.length || '';
    main.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.tab));
    const s = st.scan;
    $('#cu-scan', main).textContent = s?.running ? `Looking at pages… ${s.done} / ${s.total}` : '';
    $('#cu-all', main).hidden = st.tab !== 'pages' || !st.pages.some((p) => p.suggest);
  };

  const draw = () => {
    drawHead();
    body.classList.toggle('titles', st.tab === 'titles');
    if (st.tab === 'titles') return drawTitles();
    if (!st.pages.length) {
      body.innerHTML = `<p class="pad muted">${st.scan?.running ? 'Looking for pages to trim…' : st.scan?.total ? 'Nothing to trim. 🎉' : 'Not scanned yet.'} ${!st.scan?.running ? '<button id="cu-go" class="primary">Scan pages</button>' : ''}</p>`;
      $('#cu-go', body)?.addEventListener('click', rescan);
      return;
    }
    const p = cur(), it = store.get(p.id);
    st.crop = st.crop?.key === `${p.id}:${p.page}` ? st.crop : { key: `${p.id}:${p.page}`, top: p.suggest?.top ?? 0, bottom: p.suggest?.bottom ?? 1 };
    body.innerHTML = `
      <ol class="cu-list" id="cu-list">${st.pages.map((x, k) => `<li class="${k === st.i ? 'on' : ''} ${x.suggest ? '' : 'done'}" data-k="${k}"><b>${esc(x.title)}</b><small>p ${x.page}${x.suggest ? ' · ' + esc(x.suggest.reasons.join(', ')) : ' · trimmed'}${x.trims ? ` · ${x.trims}×` : ''}</small></li>`).join('')}</ol>
      <section class="cu-main">
        <div class="cu-bar">
          <input id="cu-title" value="${esc(it?.title || p.title)}" aria-label="Title" readonly title="R to rename">
          <span class="muted small">Page ${p.page} of ${it?.pages ?? '?'} · ${st.i + 1} / ${st.pages.length}</span>
          <span class="grow"></span>
          ${p.trims ? '<button id="cu-orig" class="ghost">Original (O)</button>' : ''}
          <button id="cu-fine" class="ghost">Looks fine (F)</button>
          <button id="cu-trim" class="primary">Trim (Enter)</button>
        </div>
        <div class="cu-stage" id="cu-stage"><div class="cu-img">
          <img id="cu-img" src="${store.fileUrl(p.id, it?.pageFiles?.[p.page - 1] || p.file)}?v=${it?.updatedAt || 0}" alt="" draggable="false">
          <div class="cu-shade top"></div><div class="cu-shade bottom"></div>
          <div class="cu-line top" data-edge="top"><span>drag</span></div><div class="cu-line bottom" data-edge="bottom"><span>drag</span></div>
        </div></div>
      </section>`;
    placeLines();
    body.querySelector('.cu-list li.on')?.scrollIntoView({ block: 'nearest' });
    $('#cu-list', body).onclick = (e) => { const li = e.target.closest('[data-k]'); if (li) { st.i = +li.dataset.k; draw(); } };
    $('#cu-trim', body).onclick = doTrim;
    $('#cu-fine', body).onclick = fine;
    $('#cu-orig', body)?.addEventListener('click', original);
    $('#cu-title', body).onclick = () => rename();
    for (const ln of body.querySelectorAll('.cu-line')) ln.onpointerdown = dragLine;
  };

  const placeLines = () => {
    const c = st.crop, box = $('.cu-img', body);
    if (!box) return;
    box.style.setProperty('--t', c.top * 100 + '%');
    box.style.setProperty('--b', c.bottom * 100 + '%');
  };
  const dragLine = (e) => {
    const edge = e.currentTarget.dataset.edge, img = $('#cu-img', body);
    e.preventDefault();
    const move = (ev) => {
      const r = img.getBoundingClientRect();
      let y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      if (edge === 'top') st.crop.top = Math.min(y, st.crop.bottom - 0.2); else st.crop.bottom = Math.max(y, st.crop.top + 0.2);
      placeLines();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const nudge = (edge, d) => {
    if (edge === 'top') st.crop.top = Math.min(st.crop.bottom - 0.2, Math.max(0, st.crop.top + d));
    else st.crop.bottom = Math.max(st.crop.top + 0.2, Math.min(1, st.crop.bottom + d));
    placeLines();
  };

  const step = (d) => {
    if (st.tab === 'titles') { st.ti = Math.max(0, Math.min(st.titles.length - 1, st.ti + d)); return drawTitles(); }
    st.i = Math.max(0, Math.min(st.pages.length - 1, st.i + d)); draw();
  };
  const nextTodo = () => { const k = st.pages.findIndex((x, j) => j > st.i && x.suggest); st.i = k >= 0 ? k : Math.min(st.i + 1, st.pages.length - 1); };

  const busy = async (fn) => { if (st.busy) return; st.busy = true; try { await fn(); } catch (e) { toast(e.message); } finally { st.busy = false; } };

  const doTrim = () => busy(async () => {
    const p = cur(), c = st.crop;
    if (c.top <= 0.001 && c.bottom >= 0.999) return fine();
    const it = await api('POST', `/items/${p.id}/pages/${p.page}/trim`, { top: c.top, bottom: c.bottom });
    store.putItem(it);
    st.undo.push({ label: 'trim', run: async () => { store.putItem(await api('POST', `/items/${p.id}/pages/${p.page}/untrim`, {})); }, at: p });
    p.suggest = null; p.trims++; st.crop = null;
    nextTodo(); draw();
  });
  const fine = () => busy(async () => {
    const p = cur(), key = `${p.id}:${p.page}`;
    await api('POST', '/cleanup/ok', { key });
    st.undo.push({ label: 'looks fine', run: () => api('POST', '/cleanup/ok', { key, undo: true }), at: p });
    if (p.trims) p.suggest = null; else st.pages.splice(st.i, 1);
    st.crop = null;
    if (p.trims) nextTodo();
    st.i = Math.min(st.i, st.pages.length - 1); draw();
  });
  const original = () => busy(async () => {
    const p = cur();
    if (!p?.trims) return;
    store.putItem(await api('POST', `/items/${p.id}/pages/${p.page}/untrim`, { all: true }));
    toast('Back to the original photo');
    st.crop = null; await load();
  });
  const undo = () => busy(async () => {
    const u = st.undo.pop();
    if (!u) return toast('Nothing to undo');
    await u.run();
    toast(`Undone: ${u.label}`);
    st.crop = null; await load();
    if (u.at && st.tab === 'pages') { const k = st.pages.findIndex((x) => x.id === u.at.id && x.page === u.at.page); if (k >= 0) { st.i = k; draw(); } }
  });

  // rename: the title box becomes editable; Enter saves, Esc cancels
  const rename = (id = st.tab === 'pages' ? cur()?.id : st.titles[st.ti]?.id) => {
    const inp = st.tab === 'pages' ? $('#cu-title', body) : body.querySelector(`.cu-trow[data-id="${id}"] input`);
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
        st.undo.push({ label: 'rename', run: () => setTitle(id, old) });
        toast(`Renamed to “${t}”`);
        if (st.tab === 'titles') { st.titles.splice(st.ti, 1); st.ti = Math.min(st.ti, st.titles.length - 1); }
        await load(); // file names follow the title
      });
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };

  const setTitle = async (id, title) => store.putItem(await api('PATCH', `/items/${id}`, { title }));

  const drawTitles = () => {
    if (!st.titles.length) { body.innerHTML = '<p class="pad muted">No odd titles. 🎉</p>'; return; }
    body.innerHTML = `<p class="pad small muted">Titles that look like file names, page numbers or typos. R or click to rename · F if it's fine · Z to undo.</p>
      <ul class="cu-titles">${st.titles.map((x, k) => `<li class="cu-trow ${k === st.ti ? 'on' : ''}" data-id="${x.id}" data-k="${k}">
        <input value="${esc(store.get(x.id)?.title ?? x.title)}" readonly aria-label="Title">
        <span class="badge k-${x.kind}">${x.kind}</span><small class="muted">${esc(x.why)}</small>
        <a class="link small" href="#/item/${x.id}" target="_blank">Open</a>
        <button class="ghost small" data-fine>Fine</button></li>`).join('')}</ul>`;
    body.querySelector('.cu-trow.on')?.scrollIntoView({ block: 'nearest' });
    body.querySelector('.cu-titles').onclick = (e) => {
      const li = e.target.closest('[data-k]'); if (!li) return;
      st.ti = +li.dataset.k;
      if (e.target.closest('[data-fine]')) return titleFine();
      if (e.target.tagName === 'INPUT') { drawTitles(); rename(li.dataset.id); }
      else drawTitles();
    };
  };
  const titleFine = () => busy(async () => {
    const x = st.titles[st.ti]; if (!x) return;
    const key = `title:${x.id}`;
    await api('POST', '/cleanup/ok', { key });
    st.undo.push({ label: 'title is fine', run: () => api('POST', '/cleanup/ok', { key, undo: true }) });
    st.titles.splice(st.ti, 1); st.ti = Math.min(st.ti, st.titles.length - 1); drawTitles(); drawHead();
  });

  const rescan = () => busy(async () => { st.scan = await api('POST', '/cleanup/scan'); drawHead(); setTimeout(load, 1500); });
  const trimAll = async () => {
    const todo = st.pages.filter((p) => p.suggest);
    if (!(await confirmSheet({ title: `Trim all ${todo.length} pages?`, body: 'Each page is trimmed as suggested. The original photos are kept — each can go back with Original (O).', ok: 'Trim all' }))) return;
    const m = modal(`<h2>Trimming…</h2><progress id="cu-p" max="${todo.length}" value="0"></progress><p class="muted small" id="cu-pm"></p>`);
    let n = 0;
    for (const p of todo) {
      if (!m.el.isConnected) break;
      try { store.putItem(await api('POST', `/items/${p.id}/pages/${p.page}/trim`, { top: p.suggest.top, bottom: p.suggest.bottom })); p.suggest = null; p.trims++; } catch {}
      n++; $('#cu-p', m.el).value = n; $('#cu-pm', m.el).textContent = `${n} / ${todo.length}`;
    }
    m.close();
    store.logEvent('cleanup', `Trimmed ${n} pages`);
    toast(`Trimmed ${n} pages`); draw();
  };

  main.querySelector('.cu-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { st.tab = b.dataset.tab; draw(); } };
  $('#cu-rescan', main).onclick = rescan;
  $('#cu-all', main).onclick = trimAll;
  const help = () => modal(`<h2>Keyboard shortcuts</h2><table class="cu-keys">${KEYS.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
  $('#cu-keys', main).onclick = help;

  const onKey = (e) => {
    if (!main.isConnected) return removeEventListener('keydown', onKey);
    if (st.renaming || document.querySelector('.modal') || e.target.matches?.('input:not([readonly]), textarea')) return;
    const k = e.key, pages = st.tab === 'pages';
    const act = {
      Enter: () => (pages ? doTrim() : rename()), t: () => pages && doTrim(),
      f: () => (pages ? fine() : titleFine()),
      ArrowRight: () => step(1), j: () => step(1), ArrowLeft: () => step(-1), k: () => step(-1),
      ArrowUp: () => (pages ? nudge(e.shiftKey ? 'bottom' : 'top', -0.005) : step(-1)),
      ArrowDown: () => (pages ? nudge(e.shiftKey ? 'bottom' : 'top', 0.005) : step(1)),
      r: () => rename(), z: () => undo(), o: () => pages && original(),
      1: () => { st.tab = 'pages'; draw(); }, 2: () => { st.tab = 'titles'; draw(); }, '?': help,
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!act || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    e.preventDefault(); act();
  };
  addEventListener('keydown', onKey);
  load();
}
