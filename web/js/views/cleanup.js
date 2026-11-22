// Clean up: every sheet song with what the Mac found — screen junk to trim (✕, status bar, player bar,
// page dots), page dots that don't match the song's pages (photos grouped wrongly), odd titles.
// Review any song: trim each page (suggested box, or draw your own), rename, mark it good. Everything
// can be undone (Z) and the original photo is always kept.
import { store } from '../store.js';
import { go } from '../app.js';
import { $, esc, toast, sheet as modal, confirmSheet } from '../ui.js';

const KEYS = [
  ['Enter / T', 'Trim this page as shown, go on'],
  ['F', 'This page is fine — no trim'],
  ['G', 'Whole song is good, next song'],
  ['→ / J', 'Next page'], ['← / K', 'Previous page'],
  ['] / N', 'Next song'], ['[ / P', 'Previous song'],
  ['↑ ↓', 'Move the top edge'], ['Shift ↑ ↓', 'Move the bottom edge'],
  ['⌥ ← →', 'Move the left edge'], ['⌥ Shift ← →', 'Move the right edge'],
  ['Drag on the page', 'Draw your own crop box'],
  ['X', 'Back to the suggested box'], ['C', 'Whole page (clear the box)'],
  ['R', 'Rename the song'],
  ['U / Z / ⌘Z', 'Undo the last thing (a trim comes back with its box to adjust)'],
  ['S', 'Split the song…'], ['Delete', 'Move the song to the Trash'],
  ['O', 'Back to the original photo'],
  ['1 / 2', 'Songs / Odd titles'],
  ['?', 'These shortcuts'],
];
const FILTERS = [['look', 'Needs a look'], ['good', 'Good'], ['all', 'All']];

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
  const st = { tab: 'songs', filter: 'look', songs: [], titles: [], sid: null, pi: 0, ti: 0, scan: null, crop: null, undo: [], busy: false, renaming: false };
  main.innerHTML = `<header class="top"><h1>Clean up</h1>
      <div class="cu-tabs" role="tablist"><button data-tab="songs">Songs</button><button data-tab="titles">Odd titles <i id="cu-nt"></i></button></div>
      <div class="cu-tabs cu-filter" id="cu-filter">${FILTERS.map(([k, l]) => `<button data-f="${k}">${l} <i></i></button>`).join('')}</div>
      <span class="muted small" id="cu-scan"></span>
      <div class="top-actions"><button id="cu-all" class="ghost">Trim all…</button><button id="cu-rescan" class="ghost">Scan again</button><button id="cu-keys" class="ghost" title="Keyboard shortcuts (?)">⌨︎ Keys</button></div></header>
    <div class="cu" id="cu"></div>`;
  const body = $('#cu', main);

  const shown = () => st.songs.filter((s) => (st.filter === 'all' ? true : st.filter === 'good' ? isGood(s) : !isGood(s)));
  const song = () => st.songs.find((s) => s.id === st.sid);
  const pg = () => song()?.pages[st.pi];

  const load = async () => {
    const d = await api('GET', '/cleanup');
    st.scan = d.scan; st.songs = d.songs; st.titles = d.titles;
    if (!song()) { st.sid = shown()[0]?.id || null; st.pi = 0; }
    st.ti = Math.min(st.ti, Math.max(0, st.titles.length - 1));
    draw();
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
    $('#cu-nt', main).textContent = st.titles.length || '';
    main.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.tab));
    const n = { look: st.songs.filter((s) => !isGood(s)).length, good: st.songs.filter(isGood).length, all: st.songs.length };
    main.querySelectorAll('[data-f]').forEach((b) => { b.classList.toggle('on', b.dataset.f === st.filter); b.querySelector('i').textContent = n[b.dataset.f]; });
    $('#cu-filter', main).hidden = st.tab !== 'songs';
    const s = st.scan;
    $('#cu-scan', main).textContent = s?.running ? `Looking at pages… ${s.done} / ${s.total}` : '';
    $('#cu-all', main).hidden = st.tab !== 'songs' || !st.songs.some((x) => !x.reviewed && x.pages.some((p) => p.trim));
  };

  const songLine = (s) => (s.reviewed ? 'marked good' : s.issues.length ? s.issues.map((i) => i.text).join(' · ') : 'looks good') + (s.trimmed ? ` · ${s.trimmed} trimmed` : '');

  const draw = () => {
    drawHead();
    body.classList.toggle('titles', st.tab === 'titles');
    if (st.tab === 'titles') return drawTitles();
    const list = shown();
    if (!list.length) {
      body.innerHTML = `<p class="pad muted">${st.scan?.running ? 'Looking at pages…' : st.filter === 'look' ? 'Nothing needs a look. 🎉' : 'No songs here.'}</p>`;
      return;
    }
    if (!list.some((s) => s.id === st.sid)) { st.sid = list[0].id; st.pi = 0; }
    const s = song(), it = store.get(s.id);
    st.pi = Math.max(0, Math.min(st.pi, s.pages.length - 1));
    const p = pg() || { page: 0, file: '', trims: 0 };
    const key = `${s.id}:${p.page}`;
    if (st.crop?.key !== key) { const pre = p.trim || p.box; st.crop = { key, ...full(), ...(pre ? { top: pre.top, bottom: pre.bottom } : {}) }; }
    const ver = it?.updatedAt || 0;
    body.innerHTML = `
      <ol class="cu-list" id="cu-list">${list.map((x) => `<li class="${x.id === st.sid ? 'on' : ''} ${isGood(x) ? 'good' : x.issues.some((i) => i.kind !== 'trim' && i.kind !== 'title') ? 'bad' : 'look'}" data-id="${x.id}">
        <b>${esc(store.get(x.id)?.title || x.title)}</b><small>${x.pages.length} p · ${esc(songLine(x))}</small></li>`).join('')}</ol>
      <section class="cu-main">
        <div class="cu-bar">
          <input id="cu-title" value="${esc(it?.title || s.title)}" aria-label="Title" readonly title="R to rename">
          <span class="grow"></span>
          ${p.trims ? '<button id="cu-orig" class="ghost">Original (O)</button>' : ''}
          <button id="cu-split" class="ghost" title="S">Split…</button>
          <button id="cu-del" class="ghost danger" title="Delete">Delete</button>
          <button id="cu-fine" class="ghost" title="F">Page is fine</button>
          <button id="cu-good" class="ghost" title="G">${s.reviewed ? 'Needs a look' : 'Song is good'}</button>
          <button id="cu-trim" class="primary" title="Enter">Trim</button>
        </div>
        ${s.issues.length ? `<div class="cu-issues">${s.issues.map((i) => `<span class="cu-issue ${i.kind}">${esc(i.text)}</span>`).join('')}${s.issues.some((i) => ['mixed', 'extra', 'twice', 'order', 'incomplete'].includes(i.kind)) ? '<span class="muted small">Fix: Split… (S), Delete, or join in the song’s ⋯ menu</span>' : ''}</div>` : ''}
        <div class="cu-strip">${s.pages.map((x, k) => `<button class="${k === st.pi ? 'on' : ''}" data-p="${k}" title="Page ${x.page}">
          <img src="${store.fileUrl(s.id, it?.pageFiles?.[x.page - 1] || x.file)}?v=${ver}" alt="" loading="lazy">
          <span>${x.page}${x.dots ? ` · dot ${x.dots.lit ?? '?'}/${x.dots.count}` : ''}${x.trims ? ' · ✓' : x.trim ? ' · ✂' : ''}</span></button>`).join('')}</div>
        ${!p.page ? '<p class="pad muted">This song has no pages. Delete it?</p>' : ''}
${p.page ? `        <div class="cu-stage" id="cu-stage"><div class="cu-img">
          <img id="cu-img" src="${store.fileUrl(s.id, it?.pageFiles?.[p.page - 1] || p.file)}?v=${ver}" alt="" draggable="false">
          <div class="cu-shade"></div>
          <div class="cu-box"><i data-e="top"></i><i data-e="bottom"></i><i data-e="left"></i><i data-e="right"></i>
            <i data-e="top left"></i><i data-e="top right"></i><i data-e="bottom left"></i><i data-e="bottom right"></i></div>
        </div></div>` : ''}
        <p class="cu-hint muted small">${p.trim ? `Junk found: ${esc(p.trim.reasons.join(', '))}. ` : p.box ? 'Preset: even white space above and below. ' : ''}Drag the edges, or drag on the page to draw your own box. ? = keys</p>
      </section>`;
    placeBox();
    body.querySelector('.cu-list li.on')?.scrollIntoView({ block: 'nearest' });
    $('#cu-list', body).onclick = (e) => { const li = e.target.closest('[data-id]'); if (li) { st.sid = li.dataset.id; st.pi = 0; st.crop = null; draw(); } };
    body.querySelector('.cu-strip').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { st.pi = +b.dataset.p; draw(); } };
    $('#cu-trim', body).onclick = doTrim;
    if (!p.page) for (const id of ['cu-trim', 'cu-fine', 'cu-split']) $('#' + id, body).disabled = true;
    $('#cu-fine', body).onclick = fine;
    $('#cu-good', body).onclick = songGood;
    $('#cu-split', body).onclick = splitSong;
    $('#cu-del', body).onclick = delSong;
    $('#cu-orig', body)?.addEventListener('click', original);
    $('#cu-title', body).onclick = () => rename();
    const ci = $('.cu-img', body); if (ci) ci.onpointerdown = drag;
  };

  const placeBox = () => {
    const c = st.crop, box = $('.cu-img', body);
    if (!box) return;
    for (const k of ['top', 'bottom', 'left', 'right']) box.style.setProperty('--' + k[0], c[k] * 100 + '%');
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

  const busy = async (fn) => { if (st.busy) return; st.busy = true; try { await fn(); } catch (e) { toast(e.message); } finally { st.busy = false; } };

  const doTrim = () => {
    const c = st.crop;
    if (!c || !pg()) return;
    if (c.top <= 0.001 && c.bottom >= 0.999 && c.left <= 0.001 && c.right >= 0.999) return fine();
    return busy(async () => {
      const s = song(), p = pg();
      store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/trim`, { top: c.top, bottom: c.bottom, left: c.left, right: c.right }));
      st.undo.push({ label: 'trim', run: async () => store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/untrim`, {})), at: [s.id, st.pi], box: { ...c, key: `${s.id}:${p.page}` } });
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
  const original = () => busy(async () => {
    const s = song(), p = pg();
    if (!p?.trims) return;
    store.putItem(await api('POST', `/items/${s.id}/pages/${p.page}/untrim`, { all: true }));
    toast('Back to the original photo');
    await reloadSong(s.id); st.crop = null; draw();
  });
  const undo = () => busy(async () => {
    const u = st.undo.pop();
    if (!u) return toast('Nothing to undo');
    await u.run();
    toast(`Undone: ${u.label}`);
    if (u.at) { await reloadSong(u.at[0]); if (st.tab === 'songs') { st.sid = u.at[0]; st.pi = u.at[1]; if (!shown().some((x) => x.id === st.sid)) st.filter = 'all'; } }
    else await load();
    st.crop = u.box ? { ...u.box } : null; draw();
  });

  const delSong = () => busy(async () => {
    const s = song();
    if (!(await confirmSheet({ title: `Move “${s.title}” to the Trash?`, body: 'You can get it back from the Trash (or press U).', ok: 'Move to Trash', danger: true }))) return;
    const k = shown().findIndex((x) => x.id === s.id);
    store.bin([s.id]);
    st.undo.push({ label: 'delete', run: async () => { store.restore([s.id]); await new Promise((r) => setTimeout(r, 400)); await load(); }, at: [s.id, 0] });
    st.songs = st.songs.filter((x) => x.id !== s.id);
    const nx = shown()[Math.min(k, shown().length - 1)];
    st.sid = nx?.id || null; st.pi = 0; st.crop = null;
    toast('Moved to the Trash'); draw();
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
      <label class="field">New song's title <input id="cu-st" value="${esc(s.title)} (part 2)"></label>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Split</button></div>`, { wide: true });
    m.el.querySelector('.cu-pick').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; const n = +b.dataset.p; pick.has(n) ? pick.delete(n) : pick.add(n); b.classList.toggle('on', pick.has(n)); };
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
    await reloadSong(x.id); st.ti = Math.min(st.ti, st.titles.length - 1); drawTitles(); drawHead();
  });
  const step = (d) => { st.ti = Math.max(0, Math.min(st.titles.length - 1, st.ti + d)); drawTitles(); };

  const rescan = () => busy(async () => { st.scan = await api('POST', '/cleanup/scan'); drawHead(); setTimeout(load, 1500); });
  const trimAll = async () => {
    const todo = st.songs.filter((s) => !s.reviewed).flatMap((s) => s.pages.filter((p) => p.trim).map((p) => ({ id: s.id, p })));
    if (!(await confirmSheet({ title: `Trim all ${todo.length} pages?`, body: 'Each page is trimmed as suggested. The original photos are kept — each can go back with Original (O).', ok: 'Trim all' }))) return;
    const m = modal(`<h2>Trimming…</h2><progress id="cu-p" max="${todo.length}" value="0"></progress><p class="muted small" id="cu-pm"></p>`);
    let n = 0;
    st.busy = true;
    for (const { id, p } of todo) {
      if (!m.el.isConnected) break;
      try { store.putItem(await api('POST', `/items/${id}/pages/${p.page}/trim`, { top: p.trim.top, bottom: p.trim.bottom })); } catch {}
      n++; $('#cu-p', m.el).value = n; $('#cu-pm', m.el).textContent = `${n} / ${todo.length}`;
    }
    st.busy = false;
    m.close();
    store.logEvent('cleanup', `Trimmed ${n} pages`);
    toast(`Trimmed ${n} pages`); await load();
  };

  main.querySelectorAll('.cu-tabs').forEach((t) => (t.onclick = (e) => {
    const b = e.target.closest('[data-tab], [data-f]'); if (!b) return;
    if (b.dataset.tab) st.tab = b.dataset.tab; else { st.filter = b.dataset.f; st.crop = null; }
    draw();
  }));
  $('#cu-rescan', main).onclick = rescan;
  $('#cu-all', main).onclick = trimAll;
  const help = () => modal(`<h2>Keyboard shortcuts</h2><table class="cu-keys">${KEYS.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
  $('#cu-keys', main).onclick = help;

  const onKey = (e) => {
    if (!main.isConnected || !location.hash.startsWith('#/cleanup') || !body.isConnected) return removeEventListener('keydown', onKey);
    if (st.renaming || document.querySelector('.modal') || e.target.matches?.('input:not([readonly]), textarea')) return;
    const k = e.key, songs = st.tab === 'songs';
    if (songs && e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); return nudge(e.shiftKey ? 'right' : 'left', k === 'ArrowLeft' ? -0.005 : 0.005); }
    const act = {
      Enter: () => (songs ? doTrim() : rename()), t: () => songs && doTrim(),
      f: () => (songs ? fine() : titleFine()), g: () => songs && songGood(),
      ArrowRight: () => songs && goPage(1), j: () => (songs ? goPage(1) : step(1)),
      ArrowLeft: () => songs && goPage(-1), k: () => (songs ? goPage(-1) : step(-1)),
      ']': () => songs && goSong(1), n: () => songs && goSong(1), '[': () => songs && goSong(-1), p: () => songs && goSong(-1),
      ArrowUp: () => (songs ? nudge(e.shiftKey ? 'bottom' : 'top', -0.005) : step(-1)),
      ArrowDown: () => (songs ? nudge(e.shiftKey ? 'bottom' : 'top', 0.005) : step(1)),
      x: () => { if (songs && pg()) { st.crop = null; draw(); } },
      c: () => { if (songs && st.crop) { Object.assign(st.crop, full()); placeBox(); } },
      r: () => rename(), z: () => undo(), u: () => undo(), o: () => songs && original(),
      s: () => songs && splitSong(), Delete: () => songs && delSong(), Backspace: () => songs && delSong(),
      1: () => { st.tab = 'songs'; draw(); }, 2: () => { st.tab = 'titles'; draw(); }, '?': help,
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!act || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    e.preventDefault(); act();
  };
  addEventListener('keydown', onKey);
  load();
}
