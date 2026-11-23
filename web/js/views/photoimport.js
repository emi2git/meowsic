// Add music → From Photos. The Mac looks into one Apple Photos album (default "SHEET"; Photos itself is only
// read, never changed), takes the photos that are not in the library yet, reads each page (title, page dots,
// a suggested crop) and proposes where each song starts. Here you check that:
//  · the photos in order (capture time), songs as coloured bands with an editable title each
//  · tap a photo: a new song starts here (again: not) · ‹ › or drag: move a photo · ✕: not a sheet
//  · Crop pages… (suggested box, the last box carries over, Frame 1 / 2) — or later
//  · Add N sheets → Undo removes them again and the photos are new again
import { store } from '../store.js';
import { go } from '../app.js';
import { isDesktop } from '../device.js';
import { $, esc, toast, sheet as modal } from '../ui.js';

const SEGS = 6;
const POLL = 700;
const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((typeof data.detail === 'string' ? data.detail : data.detail?.message) || 'The Mac said no.');
  return data;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const full = () => ({ top: 0, bottom: 1, left: 0, right: 1 });
const isFull = (b) => !b || (b.top <= 0.001 && b.bottom >= 0.999 && b.left <= 0.001 && b.right >= 0.999);
const frameText = (b) => b ? `top ${Math.round(b.top * 100)}% · bottom ${Math.round(b.bottom * 100)}%` + (b.left > 0.001 || b.right < 0.999 ? ` · left ${Math.round(b.left * 100)}% · right ${Math.round(b.right * 100)}%` : '') : 'not saved';
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// kept while the app is open: going back to the album keeps your arrangement (also after an Undo)
let S = null;

export function photoImportView(main) {
  if (store.mode !== 'server') {
    main.innerHTML = `<header class="top"><a class="icon-btn back" href="#/add-sheets" aria-label="Back">‹ Back</a><h1>From Photos</h1></header>
      <p class="pad muted">Adding from Photos needs the Mac (it reads the album in Apple Photos there).</p>`;
    return;
  }
  main.innerHTML = `<header class="top pi-top"><a class="icon-btn back" href="#/add-sheets" aria-label="Back">‹ Back</a><h1>From Photos</h1>
    <span class="grow"></span><span class="muted small" id="pi-status"></span>
    <button id="pi-undo" class="cu-undo" hidden>↶ Undo</button></header><div class="pi" id="pi"></div>`;
  const body = $('#pi', main);
  let alive = true, timer = null;
  const ui = { focus: 0, tab: 'arrange', crop: null, ci: 0 };

  // ---------- 1. the album ----------
  const showAlbum = async () => {
    body.className = 'pi album';
    body.innerHTML = '<p class="pad muted">Looking at the album…</p>';
    let a;
    try { a = await api('GET', `/photos/album${S?.albumName ? `?name=${encodeURIComponent(S.albumName)}` : ''}`); } catch (e) { a = { error: 'failed', message: e.message, photos: [] }; }
    if (!alive) return;
    const have = a.photos.filter((p) => p.inLibrary), fresh = a.photos.filter((p) => !p.inLibrary);
    const last = a.lastImport;
    body.innerHTML = `<div class="pad narrow pi-album">
      <label class="field pi-name">Album in Photos <span class="pi-row"><input id="pi-album" value="${esc(a.album || a.name || 'SHEET')}" autocomplete="off" spellcheck="false" aria-label="Album name">
        <button id="pi-look" class="ghost">Look again</button></span>
        <small class="muted">Put photos of sheet music into this album in Photos (on any of your devices). Meowsic only reads it — nothing in Photos is changed.</small></label>
      ${a.error ? `<div class="pi-err" role="alert"><b>${esc(a.error === 'access' ? 'No access to Photos' : a.error === 'no-album' ? 'Album not found' : 'Photos can’t be read')}</b>
        <p>${esc(a.message || '')}</p>${a.albums?.length ? `<p class="muted small">Albums: ${a.albums.map(esc).join(' · ')}</p>` : ''}</div>` : `
      <p class="pi-count"><b>${plural(a.photos.length, 'photo')}</b> in “${esc(a.album)}” · <b>${fresh.length} new</b>${have.length ? ` · ${have.length} already in the library` : ''}${a.fake ? ' <span class="muted small">(test album)</span>' : ''}</p>
      ${fresh.length ? `<button id="pi-go" class="primary big">Look at the ${plural(fresh.length, 'new photo')}</button>
        ${S?.session && S.session.status === 'ready' && S.session.pages.some((p) => fresh.some((f) => f.id === p.id)) ? '<button id="pi-back" class="ghost">Back to the preview</button>' : ''}` : '<p class="muted">Nothing new — every photo in the album is in the library.</p>'}
      ${have.length ? `<details class="pi-have"><summary>${plural(have.length, 'photo')} already in the library</summary><ul>${have.map((p) => `<li><span class="muted">${esc(p.filename)} · ${esc(when(p.date))}</span> → <a href="#/item/${esc(p.inLibrary.itemId)}">${esc(p.inLibrary.title)}</a>${p.inLibrary.deleted ? ' <span class="muted">(in the Trash)</span>' : ''} <small class="muted">(${esc(p.inLibrary.how)})</small></li>`).join('')}</ul></details>` : ''}`}
      ${last ? `<p class="pi-last muted small">Last added: ${plural(last.sheets.length, 'sheet')} (${esc(last.sheets.map((s) => s.title).slice(0, 4).join(', '))}${last.sheets.length > 4 ? '…' : ''}) · <button class="link" id="pi-unlast">Undo that</button></p>` : ''}
    </div>`;
    const inp = $('#pi-album', body);
    const look = async () => {
      const v = inp.value.trim() || 'SHEET';
      (S ||= {}).albumName = v;
      try { await api('PUT', '/settings', { photosAlbum: v }); } catch {}
      showAlbum();
    };
    $('#pi-look', body).onclick = look;
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); look(); } };
    $('#pi-go', body)?.addEventListener('click', () => start(inp.value.trim()));
    $('#pi-back', body)?.addEventListener('click', () => showPreview());
    $('#pi-unlast', body)?.addEventListener('click', () => undoImport(last.id));
  };

  // ---------- 2. reading the photos (the Mac copies them out of Photos and reads each page) ----------
  const start = async (name) => {
    body.className = 'pi reading';
    body.innerHTML = '<div class="pad narrow center"><p id="pi-msg">Copying the photos out of Photos…</p><progress id="pi-prog" max="1" value="0"></progress></div>';
    try {
      const s = await api('POST', '/photos/sessions', { name });
      S = { albumName: name, session: s, order: null };
      poll();
    } catch (e) { toast(e.message); showAlbum(); }
  };
  const poll = async () => {
    if (!alive) return;
    let s;
    try { s = await api('GET', `/photos/sessions/${S.session.id}`); } catch (e) { toast(e.message); return showAlbum(); }
    S.session = s;
    const m = $('#pi-msg', body), pr = $('#pi-prog', body);
    if (s.status === 'failed') { toast(s.error || 'Reading the photos failed'); return showAlbum(); }
    if (s.status === 'ready') return setup();
    if (m) m.textContent = s.status === 'reading' ? `Reading page ${Math.min(s.done + 1, s.total)} of ${s.total} (title, page dots, crop)…` : `Copying ${plural(s.total, 'photo')} out of Photos…`;
    if (pr) { pr.max = s.total; pr.value = s.done; }
    timer = setTimeout(poll, POLL);
  };

  // ---------- 3. preview: order, songs, titles, left-out photos ----------
  const setup = () => {
    const s = S.session;
    if (!S.order) {
      S.order = s.pages.map((p) => p.id);
      S.starts = new Set(s.pages.filter((p) => p.start).map((p) => p.id));
      S.out = new Set(s.pages.filter((p) => p.error || p.dup).map((p) => p.id));
      S.titles = {}; S.crops = {};
      for (const p of s.pages) if (p.start && p.title?.title && p.title.confidence >= 0.5) S.titles[p.id] = p.title.title;
      S.carry = null;
    }
    showPreview();
  };
  const P = (id) => S.session.pages.find((p) => p.id === id);
  const live = () => S.order.filter((id) => !S.out.has(id));
  // songs from the marks: the first photo that is in always starts one
  const songs = () => {
    const out = [];
    for (const id of live()) {
      if (!out.length || S.starts.has(id)) out.push({ k: out.length, first: id, ids: [] });
      out.at(-1).ids.push(id);
    }
    for (const g of out) g.title = (S.titles[g.first] ?? '').trim();
    return out;
  };
  const songOf = (id, sg = songs()) => sg.findIndex((g) => g.ids.includes(id));
  const thumb = (id, w = 400) => `/api/photos/sessions/${encodeURIComponent(S.session.id)}/pages/${encodeURIComponent(id)}/image?w=${w}`;
  const detHint = (id) => {
    const p = P(id), t = p.title || {};
    const typed = id in S.titles && S.titles[id] !== (t.title || '');
    if (typed) return '';
    if (t.title && t.confidence >= 0.5) return `detected${t.confidence < 0.8 ? ' · not sure' : ''}`;
    return t.title ? `maybe “${t.title}”?` : 'no title found';
  };

  const showPreview = () => {
    if (!S?.order) return showAlbum();
    body.className = 'pi preview';
    body.innerHTML = `<div class="pi-bar">
        <div class="pi-sum"><b id="pi-sum"></b><small class="muted">Tap a photo where a new song starts · ‹ › or drag to move · ✕ not a sheet</small></div>
        <span class="grow"></span>
        <button id="pi-album-btn" class="ghost">Album…</button>
        <button id="pi-crop" class="ghost big">Crop pages…</button>
        <button id="pi-add" class="primary big">Add sheets</button></div>
      <div class="bs-segs pi-segs" id="pi-segs"></div>
      <div class="bs-grid pi-grid" id="pi-grid"></div>`;
    $('#pi-album-btn', body).onclick = showAlbum;
    $('#pi-crop', body).onclick = () => { ui.ci = 0; showCrop(); };
    $('#pi-add', body).onclick = () => confirmAdd();
    const g = $('#pi-grid', body);
    g.onclick = (e) => {
      if (e.target.closest('input')) return;
      const f = e.target.closest('figure[data-id]'); if (!f) return;
      const id = f.dataset.id, act = e.target.closest('[data-a]')?.dataset.a;
      ui.focus = S.order.indexOf(id);
      if (act === 'prev') return move(id, -1);
      if (act === 'next') return move(id, 1);
      if (act === 'out') return exclude(id);
      if (act === 'zoom') return large(id);
      if (e.target.closest('.bs-pg')) toggle(id);
    };
    // drag to reorder (Mac / iPad with a mouse); touch uses ‹ ›
    g.ondragstart = (e) => { const f = e.target.closest('figure[data-id]'); if (!f) return; e.dataTransfer.setData('text/plain', f.dataset.id); e.dataTransfer.effectAllowed = 'move'; f.classList.add('dragging'); };
    g.ondragend = () => g.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    g.ondragover = (e) => {
      const f = e.target.closest('figure[data-id]'); if (!f) return;
      e.preventDefault();
      const r = f.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
      g.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      f.classList.add(after ? 'drop-after' : 'drop-before');
    };
    g.ondrop = (e) => {
      e.preventDefault();
      const f = e.target.closest('figure[data-id]'), id = e.dataTransfer.getData('text/plain');
      if (!f || !id || f.dataset.id === id) return g.ondragend();
      const r = f.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
      const o = S.order.filter((x) => x !== id);
      o.splice(o.indexOf(f.dataset.id) + (after ? 1 : 0), 0, id);
      S.order = o; ui.focus = o.indexOf(id);
      renderGrid();
    };
    renderGrid();
  };

  const renderGrid = () => {
    const g = $('#pi-grid', body); if (!g) return;
    const sg = songs();
    g.innerHTML = S.order.map((id, k) => {
      const p = P(id), out = S.out.has(id), si = songOf(id, sg), start = !out && sg[si]?.first === id;
      const unsure = !out && p.sure === false && k > 0;
      return `<figure data-id="${esc(id)}" draggable="${isDesktop() && !out}" class="${out ? 'out' : 'seg-' + (si % SEGS)}${start ? ' start' : ''}${k === ui.focus ? ' focus' : ''}">
        <button class="bs-pg" aria-pressed="${start}" aria-label="Photo ${k + 1}${start ? ', a new song starts here' : ''}" ${out ? 'disabled' : ''}>
          ${p.file ? `<img src="${thumb(id)}" alt="" loading="lazy" draggable="false">` : '<div class="pi-nofile">No photo</div>'}
          <span class="bs-flag">${start ? `Song ${si + 1}` : ''}</span>${unsure ? `<span class="pi-unsure" title="${esc((p.why || []).join(' · '))}">?</span>` : ''}</button>
        <button class="bs-zoom" data-a="zoom" aria-label="View photo ${k + 1} large" title="View large (Space)">⤢</button>
        <figcaption><span class="bs-n">${k + 1}</span><span class="bs-t">${out ? esc(p.error ? 'can’t be used' : p.dup ? `already in the library: ${p.dup.title}` : 'not a sheet') : start ? '' : `song ${si + 1}`}</span>
          <span class="grow"></span>
          <button class="pi-mini" data-a="prev" aria-label="Move earlier" title="Move earlier (⇧←)" ${k === 0 ? 'disabled' : ''}>‹</button>
          <button class="pi-mini" data-a="next" aria-label="Move later" title="Move later (⇧→)" ${k === S.order.length - 1 ? 'disabled' : ''}>›</button>
          <button class="pi-mini" data-a="out" aria-label="${out ? 'Use this photo' : 'Not a sheet — leave it out'}" title="${out ? 'Use it after all' : 'Not a sheet (X)'}" ${p.error || !p.file ? 'disabled' : ''}>${out ? '↺' : '✕'}</button></figcaption>
        ${start ? `<input class="bs-title" data-t="${esc(id)}" value="${esc(S.titles[id] ?? '')}" placeholder="Untitled" enterkeyhint="done" aria-label="Title of song ${si + 1}"><small class="bs-det muted" data-state="${P(id).title?.confidence >= 0.5 ? 'ok' : ''}">${esc(detHint(id))}</small>` : ''}
        ${S.crops[id] ? '<span class="pi-cropped" title="Will be cropped">✂</span>' : ''}</figure>`;
    }).join('');
    g.querySelectorAll('input[data-t]').forEach((inp) => {
      inp.oninput = () => { S.titles[inp.dataset.t] = inp.value; const h = inp.nextElementSibling; if (h) h.textContent = ''; paintHead(); };
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); inp.blur(); } };
    });
    paintHead();
    g.querySelector('figure.focus')?.scrollIntoView({ block: 'nearest' });
  };
  const paintHead = () => {
    const sg = songs(), n = live().length, out = S.order.length - n;
    const sum = $('#pi-sum', body); if (sum) sum.textContent = `${plural(n, 'photo')} → ${plural(sg.length, 'sheet')}${out ? ` · ${out} left out` : ''}`;
    const add = $('#pi-add', body); if (add) { add.textContent = sg.length ? `Add ${plural(sg.length, 'sheet')}` : 'Add sheets'; add.disabled = !sg.length; }
    const nc = Object.keys(S.crops).filter((id) => !S.out.has(id)).length;  // looked at: cropped or kept whole
    const cb = $('#pi-crop', body); if (cb) cb.textContent = nc ? `Crop pages… (${nc} of ${n} done)` : 'Crop pages…';
    const el = $('#pi-segs', body);
    if (el) {
      el.innerHTML = sg.map((x) => `<button class="bs-seg seg-${x.k % SEGS}" data-go="${esc(x.first)}"><b>${x.k + 1}:</b> ${esc(x.title || 'Untitled')} · ${plural(x.ids.length, 'page')}</button>`).join('');
      el.onclick = (e) => { const b = e.target.closest('[data-go]'); if (b) { ui.focus = S.order.indexOf(b.dataset.go); renderGrid(); } };
    }
    $('#pi-status', main).textContent = '';
  };

  const toggle = (id) => {
    if (S.out.has(id)) return;
    const first = live()[0];
    if (id === first) return toast('The first photo always starts a song');
    if (S.starts.has(id)) S.starts.delete(id);
    else {
      S.starts.add(id);
      const t = P(id).title;
      if (!(id in S.titles) && t?.title && t.confidence >= 0.5) S.titles[id] = t.title;
    }
    renderGrid();
    if (S.starts.has(id) && isDesktop() && !S.titles[id]) $(`#pi-grid input[data-t="${CSS.escape(id)}"]`, body)?.focus({ preventScroll: true });
  };
  const move = (id, d) => {
    const k = S.order.indexOf(id), j = k + d;
    if (j < 0 || j >= S.order.length) return;
    [S.order[k], S.order[j]] = [S.order[j], S.order[k]];
    ui.focus = j; renderGrid();
  };
  const exclude = (id) => {
    const p = P(id);
    if (p.error || !p.file) return;
    if (S.out.has(id)) S.out.delete(id); else S.out.add(id);
    renderGrid();
  };
  const large = (id) => {
    let k = S.order.indexOf(id);
    const m = modal(`<div class="bs-large"><img id="pi-big" alt=""></div>
      <div class="modal-actions bs-large-act"><button id="pi-lp" aria-label="Previous photo">‹</button><span id="pi-lt" class="grow"></span>
        <button id="pi-lm"></button><button id="pi-ln" aria-label="Next photo">›</button><button class="primary" data-close>Close</button></div>`,
    { wide: true, onClose: () => { removeEventListener('keydown', key, true); ui.focus = k; renderGrid(); } });
    m.el.classList.add('bs-modal');
    const show = () => {
      const pid = S.order[k], p = P(pid), sg = songs(), si = songOf(pid, sg);
      $('#pi-big', m.el).src = thumb(pid, 1000);
      $('#pi-lt', m.el).textContent = `Photo ${k + 1} of ${S.order.length} · ${S.out.has(pid) ? 'left out' : `song ${si + 1}`} · ${p.filename || ''} ${when(p.date)}`;
      const lm = $('#pi-lm', m.el), st = sg[si]?.first === pid;
      lm.textContent = st ? 'Not a new song' : 'A new song starts here'; lm.classList.toggle('on', st); lm.disabled = S.out.has(pid);
    };
    const step = (d) => { k = Math.max(0, Math.min(S.order.length - 1, k + d)); show(); };
    $('#pi-lp', m.el).onclick = () => step(-1); $('#pi-ln', m.el).onclick = () => step(1);
    $('#pi-lm', m.el).onclick = () => { toggle(S.order[k]); show(); };
    const key = (e) => {
      if (!m.el.isConnected) return removeEventListener('keydown', key, true);
      const a = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), s: () => { toggle(S.order[k]); show(); }, ' ': m.close }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
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

  // ---------- 4. crop each page (boxes are on the photo; the photo is kept) ----------
  const cropIds = () => live();
  const startBox = (id) => {
    const p = P(id), sug = p.trim || p.box, c = S.carry;
    if (id in S.crops) return { ...(S.crops[id] || full()), from: S.crops[id] ? 'Cropped' : 'Whole page' };
    if (c && c.id !== id) return { ...c.box, from: 'Same as the last crop' };
    if (sug) return { ...full(), top: sug.top, bottom: sug.bottom, left: sug.left ?? 0, right: sug.right ?? 1, from: 'Suggested' };
    return { ...full(), from: 'Whole page' };
  };
  const showCrop = async () => {
    const ids = cropIds();
    if (!ids.length) return showPreview();
    ui.ci = Math.max(0, Math.min(ui.ci, ids.length - 1));
    const id = ids[ui.ci], sg = songs(), si = songOf(id, sg);
    if (!S.frames) S.frames = await api('GET', '/cleanup/frames').catch(() => ({ 1: null, 2: null }));
    ui.crop = { id, ...startBox(id) };
    body.className = 'pi crop';
    body.innerHTML = `<div class="pi-bar"><button id="pi-done-crop" class="ghost">‹ Songs</button>
        <div class="pi-sum"><b>${esc(sg[si]?.title || 'Untitled')}</b><small class="muted">Page ${sg[si].ids.indexOf(id) + 1} of ${sg[si].ids.length} · photo ${ui.ci + 1} of ${ids.length}</small></div>
        <span class="grow"></span><button id="pi-add2" class="primary">Add ${plural(sg.length, 'sheet')}</button></div>
      <div class="cu-strip pi-strip">${ids.map((x, k) => `<button class="${k === ui.ci ? 'on' : ''}" data-k="${k}"><img src="${thumb(x, 160)}" alt="" loading="lazy"><span>${k + 1}${x in S.crops ? (S.crops[x] ? ' · ✂' : ' · whole') : ''}</span></button>`).join('')}</div>
      <div class="cu-stage" id="pi-stage"><div class="cu-img"><img id="pi-img" src="${thumb(id, 1000)}" alt="" draggable="false"><div class="cu-shade"></div>
        <div class="cu-box"><i data-e="top"></i><i data-e="bottom"></i><i data-e="left"></i><i data-e="right"></i><i data-e="top left"></i><i data-e="top right"></i><i data-e="bottom left"></i><i data-e="bottom right"></i></div></div></div>
      <div class="cu-frames">${[1, 2].map((n) => `<span class="cu-fr"><button data-fr="${n}" class="ghost" ${S.frames[n] ? '' : 'disabled'} title="${S.frames[n] ? `Use Frame ${n} (${n})` : `Frame ${n} not saved yet — ⤓ saves the box`}">Frame ${n}<small>${frameText(S.frames[n])}</small></button><button data-frs="${n}" class="ghost cu-frsave" title="Save box as Frame ${n} (⇧${n})" aria-label="Save box as Frame ${n}">⤓</button></span>`).join('')}</div>
      <div class="cu-act"><span class="muted small cu-hint"><b class="cu-from"></b>${P(id).trim ? ` · found: ${esc(P(id).trim.reasons.join(', '))}` : ''} · drag the red edges, or draw a new box</span><span class="grow"></span>
        <button id="pi-whole" class="big" title="Keep the whole photo (F)">Whole page</button>
        <button id="pi-later" class="big" title="Skip cropping this page (L)">Later</button>
        <button id="pi-doit" class="primary big" title="Crop and go on (Enter)">Crop &amp; next</button></div>`;
    place();
    body.querySelector('.cu-strip button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#pi-done-crop', body).onclick = showPreview;
    $('#pi-add2', body).onclick = () => confirmAdd();
    body.querySelector('.cu-strip').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { ui.ci = +b.dataset.k; showCrop(); } };
    $('#pi-doit', body).onclick = cropNext;
    $('#pi-whole', body).onclick = () => { S.crops[ui.crop.id] = null; nextPage(); };
    $('#pi-later', body).onclick = () => { delete S.crops[ui.crop.id]; nextPage(); };
    body.querySelector('.cu-frames').onclick = (e) => { const a = e.target.closest('[data-fr]'), sv = e.target.closest('[data-frs]'); if (a) useFrame(+a.dataset.fr); else if (sv) saveFrame(+sv.dataset.frs); };
    body.querySelector('.cu-img').onpointerdown = drag;
  };
  const place = () => {
    const c = ui.crop, box = $('.cu-img', body); if (!box || !c) return;
    for (const k of ['top', 'bottom', 'left', 'right']) box.style.setProperty('--' + k[0], c[k] * 100 + '%');
    const f = $('.cu-from', body); if (f) f.textContent = c.from;
  };
  const drag = (e) => {
    const img = $('#pi-img', body), r = img.getBoundingClientRect();
    const at = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
    const edges = e.target.dataset?.e?.split(' ');
    const [x0, y0] = at(e), c = ui.crop;
    e.preventDefault();
    const mv = (ev) => {
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
      c.from = 'Your box'; place();
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      if (c.bottom - c.top < 0.2 || c.right - c.left < 0.2) { Object.assign(c, full(), { from: 'Whole page' }); place(); toast('Box too small — whole page'); }
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  const nudge = (edge, d) => {
    const c = ui.crop; if (!c) return;
    if (edge === 'top') c.top = Math.min(c.bottom - 0.2, Math.max(0, c.top + d));
    if (edge === 'bottom') c.bottom = Math.max(c.top + 0.2, Math.min(1, c.bottom + d));
    if (edge === 'left') c.left = Math.min(c.right - 0.2, Math.max(0, c.left + d));
    if (edge === 'right') c.right = Math.max(c.left + 0.2, Math.min(1, c.right + d));
    c.from = 'Your box'; place();
  };
  const boxOf = (c) => ({ top: +c.top.toFixed(4), bottom: +c.bottom.toFixed(4), left: +c.left.toFixed(4), right: +c.right.toFixed(4) });
  const cropNext = () => {
    const c = ui.crop; if (!c) return;
    const b = boxOf(c);
    S.crops[c.id] = isFull(b) ? null : b;
    if (!isFull(b)) S.carry = { id: c.id, box: b };  // the next page starts with this box
    nextPage();
  };
  const nextPage = () => {
    const ids = cropIds();
    if (ui.ci < ids.length - 1) { ui.ci++; return showCrop(); }
    toast('Every page looked at — add the sheets when you are ready');
    showPreview();
  };
  const useFrame = (n) => {
    const f = S.frames[n];
    if (!f) return toast(`Frame ${n} is not saved yet — ⤓ (or ⇧${n}) saves the box`);
    ui.crop = { ...ui.crop, ...f, from: `Frame ${n}` }; place();
  };
  const saveFrame = async (n) => {
    try {
      S.frames = await api('POST', '/cleanup/frames', { n, box: boxOf(ui.crop) });
      toast(`Saved as Frame ${n}: ${frameText(S.frames[n])}`);
      const keep = { ...ui.crop }; await showCrop(); ui.crop = keep; place();
    } catch (e) { toast(e.message); }
  };

  // ---------- 5. add the sheets / undo ----------
  const confirmAdd = () => {
    const sg = songs();
    if (!sg.length) return toast('No photos left to add');
    const nc = sg.reduce((n, g) => n + g.ids.filter((id) => S.crops[id]).length, 0);
    const m = modal(`<h2>Add ${plural(sg.length, 'sheet')}?</h2>
      <ol class="bs-confirm">${sg.map((g) => `<li class="seg-${g.k % SEGS}"><b>${esc(g.title || 'Untitled')}</b> <span class="muted">${plural(g.ids.length, 'page')}${g.ids.some((id) => S.crops[id]) ? ` · ${g.ids.filter((id) => S.crops[id]).length} cropped` : ''}</span></li>`).join('')}</ol>
      <p class="muted small">${nc ? `${plural(nc, 'page')} will be cropped (the photo is kept — Original photo brings it back). ` : ''}Pages not cropped stay as they are (reorder, split or delete pages in Manage library → Organize pages). Undo removes these sheets again.</p>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Add ${plural(sg.length, 'sheet')}</button></div>`);
    m.el.querySelector('[data-ok]').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('POST', `/photos/sessions/${S.session.id}/import`, { songs: sg.map((g) => ({ title: g.title || 'Untitled', pages: g.ids.map((id) => ({ id, crop: S.crops[id] || null })) })) });
        m.close();
        for (const it of r.items) store.putItem(it);
        S.lastImport = r.import;
        done(r);
      } catch (err) { e.target.disabled = false; toast(err.message); }
    };
  };
  const done = (r) => {
    body.className = 'pi done';
    body.innerHTML = `<div class="pad narrow pi-done"><h2>${plural(r.items.length, 'sheet')} added</h2>
      <ul class="pi-made">${r.items.map((it) => `<li><a href="#/item/${esc(it.id)}">${esc(it.title)}</a> <span class="muted">${plural(it.pages, 'page')}</span></li>`).join('')}</ul>
      <p class="muted small">The photos stay in Photos. Next time only new photos in the album are shown.</p>
      <div class="pi-row"><button id="pi-again" class="ghost">Look at the album again</button><button id="pi-open" class="primary">Open the library</button></div></div>`;
    $('#pi-again', body).onclick = showAlbum;
    $('#pi-open', body).onclick = () => go('#/library?kind=sheet');
    const ub = $('#pi-undo', main);
    ub.hidden = false; ub.textContent = `↶ Undo add ${plural(r.items.length, 'sheet')}`;
    ub.onclick = () => undoImport(r.import.id);
    toast(`${plural(r.items.length, 'sheet')} added`, { label: 'Undo', run: () => undoImport(r.import.id) });
  };
  const undoImport = async (iid) => {
    try {
      const u = await api('POST', `/photos/imports/${encodeURIComponent(iid)}/undo`);
      store.drop(u.removed);
      $('#pi-undo', main).hidden = true;
      toast(`Undone — ${plural(u.removed.length, 'sheet')} removed; the photos are new again`);
      if (S?.session?.id === u.session && S.order) showPreview(); else showAlbum();
    } catch (e) { toast(e.message); }
  };

  // ---------- keys (Mac) ----------
  const onKey = (e) => {
    if (!main.isConnected || !body.isConnected) return removeEventListener('keydown', onKey);
    if (document.querySelector('.modal') || e.target.matches?.('input, textarea')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (body.classList.contains('crop') && e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); nudge(e.shiftKey ? 'right' : 'left', k === 'ArrowLeft' ? -0.005 : 0.005); }
      return;
    }
    if (body.classList.contains('crop')) {
      if (e.code === 'Digit1' || e.code === 'Digit2') { e.preventDefault(); const n = +e.code.slice(-1); return e.shiftKey ? saveFrame(n) : useFrame(n); }
      const a = { Enter: cropNext, t: cropNext, f: () => { S.crops[ui.crop.id] = null; nextPage(); }, l: () => { delete S.crops[ui.crop.id]; nextPage(); },
        ArrowRight: () => { ui.ci = Math.min(cropIds().length - 1, ui.ci + 1); showCrop(); }, ArrowLeft: () => { ui.ci = Math.max(0, ui.ci - 1); showCrop(); },
        ArrowUp: () => nudge(e.shiftKey ? 'bottom' : 'top', -0.005), ArrowDown: () => nudge(e.shiftKey ? 'bottom' : 'top', 0.005),
        x: () => { const p = P(ui.crop.id), sg = p.trim || p.box; if (sg) { ui.crop = { ...ui.crop, ...full(), ...sg, from: 'Suggested' }; place(); } },
        c: () => { ui.crop = { ...ui.crop, ...full(), from: 'Whole page' }; place(); }, Escape: showPreview }[k];
      if (a) { e.preventDefault(); a(); }
      return;
    }
    if (!body.classList.contains('preview') || !S?.order) return;
    const id = S.order[ui.focus];
    const cols = () => { const g = $('#pi-grid', body); return g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 1; };
    const foc = (d) => { ui.focus = Math.max(0, Math.min(S.order.length - 1, ui.focus + d)); renderGrid(); };
    const a = {
      ArrowRight: () => (e.shiftKey ? move(id, 1) : foc(1)), ArrowLeft: () => (e.shiftKey ? move(id, -1) : foc(-1)),
      ArrowDown: () => foc(cols()), ArrowUp: () => foc(-cols()),
      s: () => toggle(id), Enter: () => toggle(id), x: () => exclude(id), Delete: () => exclude(id), Backspace: () => exclude(id), ' ': () => large(id),
    }[k];
    if (!a || !id) return;
    if (e.target.closest?.('button') && (k === 'Enter' || k === ' ')) return;
    e.preventDefault(); a();
  };
  addEventListener('keydown', onKey);

  if (S?.order && S.session?.status === 'ready') showPreview();
  else if (S?.session && ['queued', 'fetching', 'reading'].includes(S.session.status)) { body.innerHTML = '<div class="pad narrow center"><p id="pi-msg">Reading…</p><progress id="pi-prog" max="1" value="0"></progress></div>'; poll(); }
  else showAlbum();
  return () => { alive = false; clearTimeout(timer); removeEventListener('keydown', onKey); };
}
