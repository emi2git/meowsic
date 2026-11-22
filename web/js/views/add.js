// Adding music: sheet photos / PDFs (with grouping review), chord search, score from audio.
import { store } from '../store.js';
import { $, esc, icon, toast, tagPicker, sheet as modal, CAT, ago } from '../ui.js';
import { go } from '../app.js';
import { CHORD_CHARTS, SEARCH_EXTRA, TUNES } from '../mock.js';
import { parseChordPro, linesHtml, diagramsHtml } from '../chordchart.js';
import { VERSIONS, VERSION_HELP } from '../musicxml.js';
import { keySelect } from './chordsview.js';
import { sheetUrl } from '../sheet-art.js';

const titleCase = (s) => s.replace(/\s+/g, ' ').trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

// ================= sheets =================
let pending = null; // [{title, tags, pages:[{name, url, pdf}] , dup}]

export function addSheetsView(main) {
  if (pending) return reviewSheets(main);
  main.innerHTML = `
    <header class="top"><a class="icon-btn back" href="#/library" aria-label="Back">‹ Back</a><h1>Add sheet music</h1></header>
    <div class="pad narrow">
      <label class="drop" id="drop">
        ${CAT}
        <b>Choose photos or PDFs</b>
        <span class="muted">On iPad and iPhone this opens your photo library, the camera or Files. On the Mac you can also drag files here.</span>
        <input type="file" id="files" accept="image/*,application/pdf" multiple hidden>
        <span class="btn primary">${icon('photo')}Choose…</span>
      </label>
      ${store.mode === 'mock' ? '<p class="center"><button class="link" id="sample">No photos handy? Try with 7 sample pages</button></p>' : ''}
      <div class="how">
        <h3>What happens next</h3>
        <ol>
          <li>The Mac reads each page and finds its title.</li>
          <li>Pages are grouped into sheets: a page with a title starts a new sheet, the pages after it join it.</li>
          <li>You check the grouping, fix titles and tags, then add them.</li>
        </ol>
      </div>
    </div>`;
  const input = $('#files', main);
  input.onchange = () => input.files.length && analyse(main, [...input.files]);
  const drop = $('#drop', main);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); analyse(main, [...e.dataTransfer.files].filter((f) => /^image\/|pdf$/.test(f.type))); };
  $('#sample', main)?.addEventListener('click', () => {
    const names = ['Edelweiss 1', 'Moon River 1', 'Moon River 2', 'Castle on a Cloud 1', 'Castle on a Cloud 2', 'Castle on a Cloud 3', 'Arirang 1'];
    analyse(main, names.map((n, i) => ({ name: n + '.jpg', type: 'image/jpeg', lastModified: Date.now() - (names.length - i) * 30000, sample: true })));
  });
}

function analyse(main, files) {
  if (!files.length) return;
  main.innerHTML = `<header class="top"><h1>Reading pages…</h1></header><div class="pad narrow center">
    <p id="an-msg">Reading page 1 of ${files.length}</p><progress id="an-prog" max="${files.length}" value="0"></progress></div>`;
  files.sort((a, b) => a.lastModified - b.lastModified);
  let i = 0;
  const t = setInterval(() => {
    i++;
    const p = $('#an-prog', main), m = $('#an-msg', main);
    if (!p) return clearInterval(t);
    p.value = i;
    m.textContent = i < files.length ? `Reading page ${i + 1} of ${files.length}` : 'Grouping pages into sheets…';
    if (i >= files.length) { clearInterval(t); setTimeout(() => { pending = group(files); reviewSheets(main); }, 350); }
  }, Math.max(80, 1400 / files.length));
}

// mock grouping: same name without its page number = same sheet; a PDF is one sheet
function group(files) {
  const groups = [];
  const existing = new Set(store.items().map((x) => fold(x.title)));
  for (const f of files) {
    const pdf = /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
    const stem = titleCase(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s*(p(age)?\s*)?\d+$/i, '')) || 'Untitled';
    const url = f.sample ? sheetUrl(stem, 1 + groups.filter((g) => g.title === stem).reduce((n, g) => n + g.pages.length, 0)) : pdf ? null : URL.createObjectURL(f);
    const page = { name: f.name, url, pdf, file: f.sample ? null : f };
    const last = groups.at(-1);
    if (!pdf && last && !last.pdf && last.stem === stem) last.pages.push(page);
    else groups.push({ stem, title: stem, tags: [], pages: [page], pdf, dup: existing.has(fold(stem)), skip: false });
  }
  for (const g of groups) if (g.pdf) g.pdfPages = 2; // phase 2 counts real PDF pages
  return groups;
}

function reviewSheets(main) {
  const groups = pending;
  const live = () => groups.filter((g) => !g.skip && g.pages.length);
  main.innerHTML = `
    <header class="top"><button class="icon-btn back" id="rv-cancel" aria-label="Cancel">Cancel</button><h1>Check your sheets</h1><span class="grow"></span>
      <button class="primary" id="rv-add"></button></header>
    <p class="pad muted hint">Tap <b>${icon('split')} New sheet here</b> between pages to split, or <b>${icon('merge')} Join</b> to put a sheet's pages onto the one before.</p>
    <div class="review" id="review"></div>`;
  const draw = () => {
    $('#review', main).innerHTML = groups.map((g, gi) => !g.pages.length ? '' : `
      <section class="rv-card ${g.skip ? 'skipped' : ''}" data-g="${gi}">
        <div class="rv-head">
          <input class="rv-title" value="${esc(g.title)}" aria-label="Title" data-f="title">
          ${gi > 0 ? `<button class="icon-btn" data-act="join" title="Join onto the sheet before">${icon('merge')}<span>Join</span></button>` : ''}
          <button class="icon-btn" data-act="skip">${g.skip ? 'Include' : 'Skip'}</button>
        </div>
        ${g.dup ? `<p class="warn">${icon('info')} A sheet called “${esc(g.title)}” is already in your library.</p>` : ''}
        <div class="rv-pages">${g.pages.map((p, pi) => `
          ${pi > 0 ? `<button class="rv-split" data-act="split" data-p="${pi}" title="Start a new sheet at this page">${icon('split')}<span>New sheet here</span></button>` : ''}
          <figure class="rv-page">${p.pdf ? `<div class="pdf">PDF<br><small>${g.pdfPages} pages</small></div>` : `<img src="${p.url}" alt="">`}
            <figcaption>${esc(p.name)}</figcaption>
            <button class="rv-x" data-act="drop" data-p="${pi}" aria-label="Remove page">Remove</button></figure>`).join('')}
        </div>
        <div class="rv-tags"><span class="muted">Tags</span> <span class="rv-tagslot"></span></div>
      </section>`).join('');
    main.querySelectorAll('.rv-card').forEach((card) => {
      const g = groups[+card.dataset.g];
      card.querySelector('.rv-tagslot').append(tagPicker([...store.db.tags], g.tags, (v) => (g.tags = v)));
    });
    const n = live().length;
    $('#rv-add', main).textContent = n ? `Add ${n} sheet${n > 1 ? 's' : ''}` : 'Nothing to add';
    $('#rv-add', main).disabled = !n;
  };
  draw();
  $('#review', main).addEventListener('input', (e) => { if (e.target.dataset.f === 'title') groups[+e.target.closest('.rv-card').dataset.g].title = e.target.value; });
  $('#review', main).addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const gi = +b.closest('.rv-card').dataset.g, g = groups[gi];
    const act = b.dataset.act, pi = +b.dataset.p;
    if (act === 'skip') g.skip = !g.skip;
    if (act === 'drop') g.pages.splice(pi, 1);
    if (act === 'split') groups.splice(gi + 1, 0, { ...g, title: g.title + ' (2)', tags: [...g.tags], pages: g.pages.splice(pi), dup: false });
    if (act === 'join') { const prev = groups.slice(0, gi).reverse().find((x) => x.pages.length); if (prev) { prev.pages.push(...g.pages); g.pages = []; } }
    draw();
  });
  $('#rv-cancel', main).onclick = () => { pending = null; go('#/library'); };
  $('#rv-add', main).onclick = async () => {
    if (store.mode !== 'mock') return uploadSheets(main, live());
    const made = live().map((g) => {
      const it = store.add({ kind: 'sheet', title: g.title.trim() || 'Untitled', artist: '', tags: g.tags, pages: g.pdf ? g.pdfPages : g.pages.length, source: g.pdf ? 'pdf' : 'photos', upload: !g.pdf });
      g.pages.forEach((p, i) => p.url && store.sessionImage(`${it.id}:${i + 1}`, p.url));
      return it;
    });
    pending = null;
    store.logEvent('add-sheet', made.length > 1 ? `${made.length} sheets` : made[0].title, made.map((x) => `${x.title} (${x.pages} p)`).join(', '));
    toast(`Added ${made.length} sheet${made.length > 1 ? 's' : ''}`);
    go('#/library?kind=sheet');
  };
}

// send each sheet's files to the Mac (one request per sheet); the server names the folder and files
async function uploadSheets(main, groups) {
  const btn = $('#rv-add', main);
  btn.disabled = true;
  const made = [], skipped = [];
  for (const [i, g] of groups.entries()) {
    btn.textContent = `Adding ${i + 1} of ${groups.length}…`;
    const fd = new FormData();
    for (const p of g.pages) if (p.file) fd.append('files', p.file, p.name);
    fd.append('title', g.title.trim() || 'Untitled');
    fd.append('tags', JSON.stringify(g.tags));
    fd.append('last_modified', JSON.stringify(g.pages.filter((p) => p.file).map((p) => p.file.lastModified)));
    try {
      const r = await fetch('/api/sheets', { method: 'POST', body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || 'Upload failed');
      store.putItem(body.item);
      made.push(body.item);
      skipped.push(...(body.skipped || []));
    } catch (e) { toast(`${g.title}: ${e.message}`); }
  }
  pending = null;
  if (made.length) store.logEvent('add-sheet', made.length > 1 ? `${made.length} sheets` : made[0].title, made.map((x) => `${x.title} (${x.pages} p)`).join(', '));
  toast(`Added ${made.length} sheet${made.length === 1 ? '' : 's'}${skipped.length ? ` · ${skipped.length} page${skipped.length > 1 ? 's' : ''} already in the library were skipped` : ''}`);
  go('#/library?kind=sheet');
}

// songbook-style lines (from the server's chord fetch) → ChordPro text
const toChordPro = (lines) => lines.map((l) => (l.t === 'blank' ? '' : l.t === 'section' ? `{c: ${l.text}}` : (l.parts || []).map((p) => (p.chord ? `[${p.chord}]` : '') + (p.text || '')).join(''))).join('\n');

// ================= chords =================
const chordState = { q: '', src: 'auto', picked: null };

export function addChordsView(main) {
  main.innerHTML = `
    <header class="top"><a class="icon-btn back" href="#/library" aria-label="Back">‹ Back</a><h1>Add chords</h1></header>
    <div class="split-pane">
      <div class="pane-l">
        <form class="pad" id="cs-form">
          <label class="search big">${icon('search')}<input type="search" id="cs-q" placeholder="Song name, e.g. Amazing Grace or Cò lả" value="${esc(chordState.q)}" aria-label="Song name"></label>
          <div class="seg small" id="cs-src">${[['auto', 'Auto'], ['en', 'English'], ['vi', 'Vietnamese']].map(([k, l]) =>
            `<button type="button" data-s="${k}" class="${chordState.src === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        </form>
        <ul class="rows compact" id="cs-results"></ul>
        <p class="pad center"><button class="link" id="cs-paste">Or paste a chord chart yourself</button></p>
      </div>
      <div class="pane-r" id="cs-preview"><div class="empty">${CAT}<p>Search for a song, then pick a result to preview it.</p></div></div>
    </div>`;
  let all = store.mode === 'mock' ? [...CHORD_CHARTS, ...SEARCH_EXTRA] : [];
  const inLib = new Set(store.items().filter((x) => x.kind === 'chords').map((x) => fold(x.title)));
  const results = () => {
    const words = fold(chordState.q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const vi = chordState.src === 'vi' || (chordState.src === 'auto' && /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(chordState.q));
    return all.filter((c) => {
      if (chordState.src === 'en' && c.source !== 'ultimate-guitar') return false;
      if (chordState.src === 'vi' && c.source !== 'hopamchuan') return false;
      const hay = fold(c.title + ' ' + c.artist);
      return words.every((w) => hay.includes(w));
    }).sort((a, b) => (vi ? (b.source === 'hopamchuan') - (a.source === 'hopamchuan') : 0));
  };
  let searching = 0;
  const drawResults = async () => {
    if (store.mode !== 'mock' && chordState.q.trim()) { // search the web through the Mac
      const n = ++searching;
      $('#cs-results', main).innerHTML = '<li class="muted pad">Searching…</li>';
      const lang = chordState.src === 'auto' ? 'auto' : chordState.src;
      const res = await store.api('GET', `/chords/search?q=${encodeURIComponent(chordState.q)}&lang=${lang}`, undefined, { queue: false });
      if (n !== searching) return;
      all = (res?.results || []).map((c) => ({ ...c, key: c.key || '' }));
      if (!res) { $('#cs-results', main).innerHTML = '<li class="muted pad">Chord search needs the Mac.</li>'; return; }
    }
    const r = store.mode === 'mock' ? results() : all;
    const ul = $('#cs-results', main);
    if (!chordState.q.trim()) { ul.innerHTML = `<li class="muted pad">Try “grace”, “danny”, “cò lả” or “clementine”.</li>`; return; }
    ul.innerHTML = r.length ? r.map((c, i) => `<li class="row" data-i="${all.indexOf(c)}">
        <span class="thumb t-chords">${esc(c.key)}</span>
        <div class="row-main"><div class="row-title">${esc(c.title)}</div>
        <div class="row-sub"><span>${esc(c.artist)}</span><span class="dot">·</span><span>${c.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : 'Ultimate Guitar'}</span><span class="dot">·</span><span>Key ${c.key}</span></div></div>
        ${inLib.has(fold(c.title)) ? '<span class="pill">In library</span>' : ''}</li>`).join('')
      : `<li class="muted pad">No results for “${esc(chordState.q)}”.</li>`;
  };
  let t;
  $('#cs-q', main).oninput = (e) => { chordState.q = e.target.value; clearTimeout(t); t = setTimeout(drawResults, store.mode === 'mock' ? 200 : 450); };
  $('#cs-form', main).onsubmit = (e) => { e.preventDefault(); drawResults(); };
  $('#cs-src', main).onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; chordState.src = b.dataset.s; main.querySelectorAll('#cs-src button').forEach((x) => x.classList.toggle('on', x === b)); drawResults(); };
  $('#cs-results', main).onclick = (e) => { const li = e.target.closest('[data-i]'); if (!li) return; main.querySelectorAll('#cs-results .row').forEach((x) => x.classList.toggle('sel', x === li)); preview(main, all[+li.dataset.i]); };
  $('#cs-paste', main).onclick = () => pasteChart();
  drawResults();
}

async function preview(main, c) {
  if (!c.text && store.mode !== 'mock') { // fetch the chords for this result
    $('#cs-preview', main).innerHTML = '<p class="pad muted">Fetching chords…</p>';
    const song = await store.api('GET', `/chords/fetch?url=${encodeURIComponent(c.url)}`, undefined, { queue: false });
    if (!song) { $('#cs-preview', main).innerHTML = '<p class="pad muted">Couldn’t fetch this song.</p>'; return; }
    c = { ...c, ...song, text: toChordPro(song.lines || []), key: song.key || c.key || '', capo: +song.capo || 0 };
  }
  const chart = { ...c, lines: parseChordPro(c.text), transpose: null, tags: c.tags ? [...c.tags] : [] };
  const pane = $('#cs-preview', main);
  const draw = () => {
    pane.innerHTML = `<div class="pad">
      <div class="pv-head"><div><h2>${esc(chart.title)}</h2><p class="muted">${esc(chart.artist)} · ${chart.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : 'Ultimate Guitar'} · original key ${chart.key}</p></div>
      <button class="primary" id="pv-save">${icon('plus')}Save to library</button></div>
      <div class="toolbar flat">${keySelect(chart)}</div>
      <div class="pv-tags"><span class="muted">Tags</span> <span id="pv-tagslot"></span></div>
      <div class="chart" style="--chart-size:16px"><div class="diagrams">${diagramsHtml(chart)}</div><div class="lyrics">${linesHtml(chart)}</div></div></div>`;
    $('#pv-tagslot', pane).append(tagPicker([...store.db.tags], chart.tags, (v) => (chart.tags = v)));
    $('#cv-key', pane).onchange = (e) => { chart.transpose = +e.target.value; draw(); };
    $('#pv-save', pane).onclick = () => {
      const it = store.add({ kind: 'chords', title: chart.title, artist: chart.artist, tags: chart.tags, source: chart.source, key: chart.key, capo: chart.capo || 0,
        url: chart.url || `https://${chart.source === 'hopamchuan' ? 'hopamchuan.com' : 'tabs.ultimate-guitar.com'}/mock/${encodeURIComponent(chart.title)}`, originAt: Date.now(), text: chart.text, transpose: chart.transpose });
      store.logEvent('add-chords', it.title, `${chart.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : 'Ultimate Guitar'} · key ${chart.key}`);
      toast(`Saved “${it.title}”`, { label: 'Open', run: () => go(`#/item/${it.id}`) });
    };
  };
  draw();
  if (innerWidth < 800) pane.scrollIntoView({ behavior: 'smooth' });
}

function pasteChart() {
  const s = modal(`<h2>Paste a chord chart</h2>
    <form id="pc"><input name="title" placeholder="Title" required><input name="artist" placeholder="Artist (optional)">
    <textarea name="text" rows="10" placeholder="[C]Twinkle, twinkle, [F]little [C]star&#10;Put chords in square brackets before the syllable." required></textarea>
    <div class="modal-actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`, { wide: true });
  $('#pc', s.el).onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const text = f.get('text');
    const first = text.match(/\[([A-G][#b]?m?)/);
    const it = store.add({ kind: 'chords', title: f.get('title'), artist: f.get('artist'), source: 'pasted', key: first ? first[1] : 'C', capo: 0, url: '', text, transpose: null });
    store.logEvent('add-chords', it.title, 'Pasted by hand');
    s.close();
    go(`#/item/${it.id}`);
  };
}

// ================= score =================
export const GEN_STAGES = ['Read the score', 'Arrange', 'Write the score', 'Draw the pages'];
export const STAGES = ['Download audio', 'Separate voice and instruments', 'Find the notes', 'Read the lyrics', 'Find key, beat and chords', 'Write the score', 'Draw the pages'];

export function addScoreView(main) {
  const f = { src: 'yt', outputs: new Set(['original']) };
  main.innerHTML = `
    <header class="top"><a class="icon-btn back" href="#/library" aria-label="Back">‹ Back</a><h1>Add score</h1></header>
    <div class="pad narrow" id="sf-jobs"></div>
    <form class="pad narrow form" id="sf">
      <h2 class="sub-h">New score from a recording</h2>
      <div class="seg" id="sf-src"><button type="button" data-s="yt" class="on">${icon('link')}YouTube link</button><button type="button" data-s="file">${icon('upload')}Audio file</button></div>
      <div id="sf-yt"><input id="sf-url" type="url" placeholder="https://www.youtube.com/watch?v=…" aria-label="YouTube link"></div>
      <div id="sf-file" hidden><label class="drop small"><input type="file" id="sf-audio" accept="audio/*,video/*" hidden><span class="btn">${icon('upload')}Choose audio file</span><span class="muted" id="sf-fname">MP3, M4A, WAV or a video</span></label></div>
      <label class="field">Title <input id="sf-title" placeholder="Filled in from the link or file"></label>
      <fieldset><legend>What do you want? <small class="muted">Pick one or more — each becomes its own entry.</small></legend><div class="cards" id="sf-out">
        ${Object.keys(VERSIONS).map((v, i) =>
          `<button type="button" class="card-opt ${i ? '' : 'on'}" data-o="${v}" aria-pressed="${!i}"><b>${VERSIONS[v]}</b><small>${VERSION_HELP[v]}</small></button>`).join('')}</div></fieldset>
      <p class="muted">Runs on the Mac and takes about 3–6 minutes for a 4-minute song. Progress shows at the top of this page; you can keep using Meowsic meanwhile.</p>
      <button class="primary big" id="sf-go">${icon('wave')}Start</button>
    </form>`;
  $('#sf-out', main).onclick = (e) => {
    const b = e.target.closest('[data-o]');
    if (!b) return;
    const v = b.dataset.o;
    if (f.outputs.has(v) && f.outputs.size === 1) return toast('Pick at least one.');
    f.outputs.has(v) ? f.outputs.delete(v) : f.outputs.add(v);
    b.classList.toggle('on', f.outputs.has(v));
    b.setAttribute('aria-pressed', f.outputs.has(v));
  };
  $('#sf-src', main).onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; f.src = b.dataset.s; $('#sf-src', main).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); $('#sf-yt', main).hidden = f.src !== 'yt'; $('#sf-file', main).hidden = f.src !== 'file'; };
  $('#sf-url', main).oninput = (e) => { if (/youtu/.test(e.target.value) && !$('#sf-title', main).value) $('#sf-title', main).value = 'Song from YouTube'; };
  $('#sf-audio', main).onchange = (e) => { const file = e.target.files[0]; if (!file) return; f.file = file.name; $('#sf-fname', main).textContent = file.name; if (!$('#sf-title', main).value) $('#sf-title', main).value = titleCase(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')); };
  $('#sf', main).onsubmit = (e) => {
    e.preventDefault();
    const url = $('#sf-url', main).value.trim();
    if (f.src === 'yt' && !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) return toast('Paste a YouTube link first.');
    if (f.src === 'file' && !f.file) return toast('Choose an audio file first.');
    store.addJob({ title: $('#sf-title', main).value.trim() || 'Untitled song', source: f.src === 'yt' ? 'YouTube · ' + url.replace(/^https?:\/\/(www\.)?/, '') : 'Audio file · ' + f.file, outputs: [...f.outputs], output: [...f.outputs].map((v) => VERSIONS[v]).join(' + ') });
    e.target.reset();
    $('#sf-fname', main).textContent = 'MP3, M4A, WAV or a video';
    f.file = null;
    main.scrollTo({ top: 0, behavior: 'smooth' });
  };
  return jobsList($('#sf-jobs', main));
}

function jobsList(host) {
  const draw = () => {
    const jobs = store.jobs().filter((j) => !j.dismissed);
    host.hidden = !jobs.length;
    host.innerHTML = `<h2 class="sub-h">In progress and done <a class="link small" href="#/activity">All logs ›</a></h2>` + jobs.map((j) => `
      <section class="job ${j.status}">
        <div class="job-head"><div><b>${esc(j.title)}</b><small>${esc(j.source)} · ${esc(j.output)}</small></div>
          ${j.status === 'running' ? `<button data-cancel="${j.id}">Cancel</button>` : j.status === 'done' ? `${(j.items || []).map((x) => `<a class="btn primary" href="#/item/${x.id}">Open ${VERSIONS[x.version]}</a>`).join('')}<button data-dismiss="${j.id}">Dismiss</button>` : `<button data-dismiss="${j.id}">Dismiss</button>`}</div>
        <ol class="stages">${(j.gen ? GEN_STAGES : STAGES).map((s, i) => `<li class="${i < j.stage || j.status === 'done' ? 'done' : i === j.stage && j.status === 'running' ? 'now' : ''}"><span>${s}</span>${i === j.stage && j.status === 'running' ? `<progress max="1" value="${j.progress}"></progress>` : ''}</li>`).join('')}</ol>
        <small class="muted">${j.status === 'running' ? `Started ${ago(j.startedAt)}` : j.status === 'done' ? `Finished ${ago(j.doneAt)}` : 'Cancelled'}</small>
      </section>`).join('');
  };
  host.onclick = (e) => {
    const c = e.target.closest('[data-cancel]'), d = e.target.closest('[data-dismiss]');
    if (c) store.updateJob(c.dataset.cancel, { status: 'cancelled', doneAt: Date.now(), msg: 'Cancelled' }, { quiet: false });
    if (d) store.dismissJob(d.dataset.dismiss);
  };
  draw();
  const a = store.onJobs(draw), b = store.on(draw);
  return () => { a(); b(); };
}

// mock progress: each stage takes a few seconds
let ticking = false;
export function tickJobs() {
  if (ticking) return;
  ticking = true;
  if (store.mode !== 'mock') { // real jobs run on the Mac; just watch them
    setInterval(() => { if (store.jobs().some((j) => j.status === 'running' || j.status === 'queued')) store.refreshJobs(); }, 2000);
    return;
  }
  const tunes = Object.keys(TUNES);
  setInterval(() => {
    for (const j of store.jobs()) {
      if (j.status !== 'running') continue;
      let { stage, progress } = j;
      progress += 0.12 + Math.random() * 0.1;
      if (progress >= 1) { stage++; progress = 0; }
      if (stage >= (j.gen ? GEN_STAGES : STAGES).length) {
        const tune = j.tune || tunes[Math.floor(Math.random() * tunes.length)];
        const made = (j.outputs || ['original']).map((version) => store.add({ kind: 'score', title: j.title, artist: j.artist || '', tags: [VERSIONS[version], ...(j.tags || [])], tune, version,
          source: j.source, key: j.key || 'C major', bpm: TUNES[tune].bpm, transpose: 0 }));
        store.updateJob(j.id, { status: 'done', stage, progress: 1, doneAt: Date.now(), items: made.map((x) => ({ id: x.id, version: x.version })), msg: `Done — added ${made.map((x) => VERSIONS[x.version]).join(', ')}` }, { quiet: false });
        toast(made.length > 1 ? `${made.length} new versions of ${j.title} are ready` : `${VERSIONS[made[0].version]} of ${j.title} is ready`, { label: 'Open', run: () => go(`#/item/${made[0].id}`) });
      } else store.updateJob(j.id, stage !== j.stage ? { stage, progress, msg: `${(j.gen ? GEN_STAGES : STAGES)[j.stage]} — done` } : { stage, progress });
    }
  }, 700);
}
