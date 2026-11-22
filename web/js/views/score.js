// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// tempo, transpose, zoom; export lives in the More menu. Each version is its own entry.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, menu, sheet as modal } from '../ui.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS, VERSION_HELP, barBeats, midiOf, nameOf, isTriplet, twelfths, meterOf, xmlInfo } from '../musicxml.js';
import { ScorePlayer } from '../audio.js';
import { TuneModel, XmlModel } from '../scoremodel.js';
import { InkLayer } from './annotate.js';

let osmdReady;
export function loadOsmd() {
  if (window.opensheetmusicdisplay) return Promise.resolve();
  return (osmdReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'vendor/osmd.min.js';
    s.onload = ok; s.onerror = () => fail(new Error('Could not load the notation library.'));
    document.head.append(s);
  }));
}

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function scoreBody(root, it, { perform = false } = {}) {
  // an edited score keeps its own bars on the entry (it.measures); otherwise the original tune
  let tune = it.measures ? { ...TUNES[it.tune], measures: structuredClone(it.measures) } : TUNES[it.tune];
  // a real score (from the Mac): its own MusicXML; notes for playback are read out of it
  const real = !tune;
  let xmlText = '', info = null;
  const loadReal = async () => {
    const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml`);
    if (!r.ok) throw new Error('Could not load this score from the Mac.');
    xmlText = await r.text();
    info = xmlInfo(xmlText);
    tune = { title: it.title, bpm: info.bpm, beats: info.beats, measures: [], real: true };
  };
  const version = it.version || 'original';
  // each score reopens the way you left it: key (transpose), tempo and zoom are saved on the entry
  let zoom = it.zoom || (perform ? 1.25 : 1) * (innerWidth < 760 ? 0.62 : 1);
  let osmd, player, stops = [], bar, ink = null;

  root.innerHTML = `<div class="score-wrap ${perform ? 'perform' : ''}"><div class="score-paper" id="paper"><div id="osmd"></div></div></div>`;
  const paper = $('#paper', root);

  // melody notes (first staff) get data-bar / data-note so a click can select them
  let picked = null;
  const tagNotes = () => {
    if (version === 'accomp') return;
    osmd.GraphicSheet.MeasureList.forEach((staves, bi) => {
      (staves[0]?.staffEntries || []).forEach((se, ni) => {
        const g = se.graphicalVoiceEntries[0]?.notes[0]?.getSVGGElement?.();
        if (!g) return;
        g.dataset.bar = bi; g.dataset.note = ni;
        g.classList.add('note-hit');
        if (picked && picked[0] === bi && picked[1] === ni) g.classList.add('note-on');
      });
    });
  };
  const pickNote = (bi, ni) => {
    picked = bi < 0 ? null : [bi, ni];
    root.querySelectorAll('.note-on').forEach((g) => g.classList.remove('note-on'));
    if (picked) root.querySelector(`g[data-bar="${bi}"][data-note="${ni}"]`)?.classList.add('note-on');
  };
  const measureStops = () => {
    stops = [];
    const c = osmd.cursor;
    c.show(); c.reset();
    const el = c.cursorElement;
    while (!c.iterator.EndReached) {
      stops.push({ q: c.iterator.currentTimeStamp.RealValue * 4, x: el.offsetLeft + el.offsetWidth / 2, top: el.offsetTop, h: el.offsetHeight });
      c.next();
    }
    c.hide();
    bar?.remove();
    bar = document.createElement('div');
    bar.className = 'playbar';
    (el.parentElement || $('#osmd', root)).append(bar);
  };

  const place = (q) => {
    if (!stops.length || !bar) return;
    if (!player?.playing && q <= 0) { bar.style.display = 'none'; return; }
    let i = stops.findIndex((s) => s.q > q) - 1;
    if (i < 0) i = q <= stops[0].q ? 0 : stops.length - 1;
    const a = stops[i], b = stops[i + 1];
    let x = a.x;
    if (b && b.top === a.top && b.q > a.q) x = a.x + ((b.x - a.x) * (q - a.q)) / (b.q - a.q);
    bar.style.display = 'block';
    bar.style.transform = `translate(${x}px, ${a.top}px)`;
    bar.style.height = a.h + 'px';
    const host = root.closest('.scroll-host');
    if (host && player?.playing) {
      const top = a.top + paper.offsetTop, view = host.scrollTop;
      if (top < view + 40 || top + a.h > view + host.clientHeight - 40) host.scrollTo({ top: Math.max(0, top - 80) });
    }
    root.dispatchEvent(new CustomEvent('tick', { detail: { q }, bubbles: true }));
  };

  const render = async () => {
    await loadOsmd();
    const O = window.opensheetmusicdisplay;
    $('#osmd', root).innerHTML = '';
    osmd = new O.OpenSheetMusicDisplay($('#osmd', root), {
      autoResize: false, backend: 'svg', drawTitle: true, drawSubtitle: false, drawComposer: false, drawPartNames: version === 'vocal',
      drawPartAbbreviations: false, drawMeasureNumbersOnlyAtSystemStart: true, followCursor: false,
    });
    const r = osmd.EngravingRules;
    r.MinNoteDistance = 2.0; r.ChordSymbolXSpacing = 1.5; r.LyricsHeight = 1.8;
    await osmd.load(real ? xmlText : musicXml({ ...tune, title: it.title }, version));
    osmd.zoom = zoom;
    if (it.transpose) {
      osmd.TransposeCalculator = new O.TransposeCalculator();
      osmd.Sheet.Transpose = it.transpose;
      osmd.updateGraphic();
    }
    osmd.render();
    tagNotes();
    measureStops();
    ink?.destroy();
    ink = new InkLayer(paper, it.id, `score-${version}`);
    place(player?.posQ || 0);
    if (!player?.posQ) bar.style.display = 'none';
  };

  const makePlayer = () => {
    const was = player;
    was?.pause();
    player = new ScorePlayer({ notes: real ? info.notes : tuneNotes(tune, version), bpm: tune.bpm, beats: tune.beats, onTick: place,
      onEnd: () => root.dispatchEvent(new CustomEvent('ended', { bubbles: true })) });
    if (was) { player.rate = was.rate; player.loop = was.loop; }
    player.shift = it.transpose || 0;
    if (!was && it.rate) player.rate = it.rate;
  };
  const ready = (real ? loadReal() : Promise.resolve()).then(() => { makePlayer(); return render(); }).catch((e) => { $('#osmd', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; });

  let rt;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => osmd && (osmd.render(), tagNotes(), measureStops(), place(player.now()), ink?.fit()), 250); });
  ro.observe(root);

  // bar under a click: find the drawn stop nearest the click on that line, then which bar its beat falls in
  const barAt = (cx, cy) => {
    const r = $('#osmd', root).getBoundingClientRect();
    const host = bar?.parentElement?.getBoundingClientRect() || r;
    const x = cx - host.left, y = cy - host.top;
    const line = stops.filter((s) => y >= s.top - 30 && y <= s.top + s.h + 30);
    if (!line.length) return -1;
    const st = line.reduce((b, s) => (s.x <= x + 6 && s.x > b.x ? s : b), line[0]);
    let acc = 0;
    for (let i = 0; i < tune.measures.length; i++) { const b = barBeats(tune, tune.measures[i]); if (st.q < acc + b - 1e-6) return i; acc += b; }
    return tune.measures.length - 1;
  };
  let selBox = null;
  const showBar = (i) => {
    selBox?.remove(); selBox = null;
    if (i < 0) return;
    let a = 0; for (let k = 0; k < i; k++) a += barBeats(tune, tune.measures[k]);
    const b = a + barBeats(tune, tune.measures[i]);
    const inBar = stops.filter((s) => s.q >= a - 1e-6 && s.q < b - 1e-6);
    if (!inBar.length || !bar) return;
    const next = stops.find((s) => s.q >= b - 1e-6 && s.top === inBar[0].top);
    const x0 = Math.min(...inBar.map((s) => s.x)) - 14, x1 = (next ? next.x : Math.max(...inBar.map((s) => s.x)) + 40) - 8;
    selBox = document.createElement('div');
    selBox.className = 'barsel';
    Object.assign(selBox.style, { left: x0 + 'px', top: inBar[0].top - 6 + 'px', width: x1 - x0 + 'px', height: inBar[0].h + 12 + 'px' });
    bar.parentElement.append(selBox);
  };

  return {
    ready,
    get tune() { return tune; },
    barAt, showBar, pickNote, get editable() { return version !== 'accomp'; },
    // replace the bars (edit), save on the entry, redraw and replay from the new notes
    async setMeasures(ms, { save = true } = {}) {
      tune = { ...TUNES[it.tune], measures: ms };
      if (save) store.update(it.id, { measures: ms });
      makePlayer();
      await render();
    },
    async revert() {
      if (real) { await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml/revert`, { method: 'POST' }); await loadReal(); makePlayer(); await render(); return; }
      store.update(it.id, { measures: undefined }); delete it.measures; tune = TUNES[it.tune]; makePlayer(); await render();
    },
    // real scores: save edited MusicXML on the Mac (keeps the untouched original there), redraw, replay
    async setXml(text) {
      xmlText = text; info = xmlInfo(text); tune = { ...tune, bpm: info.bpm, beats: info.beats };
      await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml`, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.recordare.musicxml+xml' }, body: text });
      makePlayer(); await render();
    },
    get player() { return player; },
    get version() { return version; },
    async setTranspose(n) { store.update(it.id, { transpose: n }); player.shift = n; await render(); },
    zoomReset() { this.setZoom(innerWidth < 760 ? 0.62 : 1); },
    setZoom(z) { zoom = Math.max(0.6, Math.min(2, Math.round(z * 100) / 100)); store.update(it.id, { zoom }); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); osmd.zoom = zoom; osmd.render(); tagNotes(); measureStops(); place(player.now()); ink?.fit(); },
    get zoom() { return zoom; },
    setTool(t) { ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return real ? xmlText : musicXml({ ...tune, title: it.title }, version); },
    get real() { return real; },
    get totalQ() { return real ? Math.ceil(info.totalQ) : tune.measures.reduce((s, m) => s + barBeats(tune, m), 0); },
    destroy() { player.pause(); ro.disconnect(); ink?.destroy(); },
  };
}

// Export entries for the item's More menu
export function scoreTools(it, view) {
  return [{ label: 'Make another version…', icon: 'plus', run: () => generateVersions(it) },
    ...(it.measures ? [{ label: 'Revert note edits', icon: 'restore', run: async () => { await view.revert(); document.querySelector('.editbar')?.dispatchEvent(new Event('close')); toast('Back to the original notes'); } }] : [])];
}
export function scoreExportMenu(it, view) {
  return [
    { label: 'Export as MusicXML', icon: 'download', run: () => download(`${it.title} - ${VERSIONS[view.version]}.musicxml`, view.xml(), 'application/vnd.recordare.musicxml+xml') },
    { label: 'Export as MIDI', icon: 'download', run: () => toast('MIDI export comes with the Mac server (phase 2).') },
    { label: 'Export as PDF', icon: 'download', run: () => toast('PDF export comes with the Mac server (phase 2).') },
  ];
}

export function scoreToolbar(bar, it, view) {
  const t = view.tune;
  const secs = (q) => (q / (t.bpm * view.player.rate)) * 60;
  const total = view.totalQ;
  bar.innerHTML = `
    <div class="transport">
      <button class="play" id="sc-play" aria-label="Play">Play</button>
      <input type="range" id="sc-pos" min="0" max="${total}" step="0.25" value="0" aria-label="Position">
      <span class="time" id="sc-time">0:00 / ${fmt(secs(total))}</span>
    </div>
    <div class="stepper" aria-label="Tempo" title="Tempo"><button id="sc-slow" aria-label="Slower">−</button><span id="sc-rate">${Math.round(t.bpm * view.player.rate)} bpm</span><button id="sc-fast" aria-label="Faster">+</button></div>
    <div class="stepper" aria-label="Transpose"><button id="sc-tdown" aria-label="Transpose down">♭</button><span id="sc-tval">${it.transpose ? (it.transpose > 0 ? '+' : '') + it.transpose : '0'}</span><button id="sc-tup" aria-label="Transpose up">♯</button></div>
    <div class="stepper zoom" aria-label="Zoom"><button id="sc-zout" aria-label="Zoom out" title="Zoom out (−)">${iconOn('zoomout')}</button><button id="sc-zreset" class="zreset" title="Reset zoom (0)">${Math.round(view.zoom * 100)}%</button><button id="sc-zin" aria-label="Zoom in" title="Zoom in (+)">${iconOn('zoomin')}</button></div>
    <button class="icon-btn" id="sc-edit" title="Edit notes" aria-label="Edit notes">${iconOn('edit')}</button>`;

  const p = () => view.player;
  const playBtn = $('#sc-play', bar);
  const setPlay = () => { playBtn.textContent = p().playing ? 'Pause' : 'Play'; playBtn.setAttribute('aria-label', p().playing ? 'Pause' : 'Play'); };
  playBtn.onclick = async () => { p().playing ? p().pause() : await p().play(); setPlay(); };
  const pos = $('#sc-pos', bar), time = $('#sc-time', bar);
  const host = bar.closest('.viewer') || document;
  const onTick = (e) => { pos.value = e.detail.q; time.textContent = `${fmt(secs(e.detail.q))} / ${fmt(secs(total))}`; };
  const onEnd = () => setPlay();
  host.addEventListener('tick', onTick);
  host.addEventListener('ended', onEnd);
  pos.oninput = () => p().seek(+pos.value);
  // tempo in beats per minute, 5 at a time; the score's own tempo is the starting point
  const rate = (d) => {
    const bpm = Math.max(30, Math.min(220, Math.round(t.bpm * p().rate / 5) * 5 + d * 5));
    p().setRate(bpm / t.bpm);
    store.update(it.id, { rate: bpm / t.bpm });
    $('#sc-rate', bar).textContent = `${bpm} bpm`;
    time.textContent = `${fmt(secs(+pos.value))} / ${fmt(secs(total))}`;
  };
  $('#sc-slow', bar).onclick = () => rate(-1);
  $('#sc-fast', bar).onclick = () => rate(1);
  const tr = async (d) => { const n = Math.max(-6, Math.min(6, (it.transpose || 0) + d)); await view.setTranspose(n); $('#sc-tval', bar).textContent = n ? (n > 0 ? '+' : '') + n : '0'; };
  $('#sc-tdown', bar).onclick = () => tr(-1);
  $('#sc-tup', bar).onclick = () => tr(1);
  const zl = () => ($('#sc-zreset', bar).textContent = `${Math.round(view.zoom * 100)}%`);
  $('#sc-zout', bar).onclick = () => { view.setZoom(view.zoom - 0.15); zl(); };
  $('#sc-zin', bar).onclick = () => { view.setZoom(view.zoom + 0.15); zl(); };
  $('#sc-zreset', bar).onclick = () => { view.zoomReset(); zl(); };
  $('#sc-edit', bar).onclick = (e) => scoreEditor(view, it, bar.closest('.viewer'), e.currentTarget);
  bar.closest('.viewer')?.addEventListener('zoomchange', zl);
  const onSpace = (e) => { if (e.key === ' ' && !e.target.closest('input,select,textarea,button')) { e.preventDefault(); playBtn.click(); } };
  document.addEventListener('keydown', onSpace);
  return () => { host.removeEventListener('tick', onTick); host.removeEventListener('ended', onEnd); document.removeEventListener('keydown', onSpace); };
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// make other arrangements of this score; each one becomes its own entry, tagged with its version
function generateVersions(it) {
  const have = new Set(store.items().filter((x) => x.kind === 'score' && x.title === it.title && x.tune === it.tune).map((x) => x.version));
  const pick = new Set();
  const s = modal(`<h2>Make another version of “${esc(it.title)}”</h2>
    <p class="muted">Pick one or more. Each becomes its own entry in the library.</p>
    <div class="cards one-col" id="gv">${Object.keys(VERSIONS).map((v) => `<button type="button" class="card-opt" data-o="${v}">
      <b>${VERSIONS[v]}${have.has(v) ? ' <small class="have">· you have one</small>' : ''}</b><small>${VERSION_HELP[v]}</small></button>`).join('')}</div>
    <p class="warn" id="gv-warn" hidden></p>
    <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok disabled>Make</button></div>`, { wide: true });
  const ok = s.el.querySelector('[data-ok]');
  s.el.querySelector('#gv').onclick = (e) => {
    const b = e.target.closest('[data-o]');
    if (!b || b.disabled) return;
    const v = b.dataset.o;
    pick.has(v) ? pick.delete(v) : pick.add(v);
    b.classList.toggle('on', pick.has(v));
    ok.disabled = !pick.size;
    ok.textContent = pick.size > 1 ? `Make ${pick.size}` : 'Make';
    const dup = [...pick].filter((x) => have.has(x)).map((x) => VERSIONS[x]);
    const w = s.el.querySelector('#gv-warn');
    w.hidden = !dup.length;
    w.textContent = dup.length ? `You already have ${dup.join(' and ')}. A new copy will be added next to it; the one you have, with your edits and annotations, stays as it is.` : '';
  };
  ok.onclick = () => {
    const outputs = [...pick];
    store.addJob({ gen: true, fromItemId: it.id, title: it.title, artist: it.artist, tags: it.tags.filter((t) => !Object.values(VERSIONS).includes(t)), tune: it.tune, key: it.key,
      source: `From the score “${it.title}”`, outputs, output: outputs.map((v) => VERSIONS[v]).join(' + ') });
    s.close();
    toast(`Making ${outputs.map((v) => VERSIONS[v]).join(', ')} — progress is in Add → Score`);
  };
}

// ================= score editor =================
// Like MuseScore / Flat: click a note on the staff to select it, then change it with the palette or keys:
// ↑/↓ semitone · ⌘↑/⌘↓ octave · ←/→ previous/next note · A–G set the note · 2 3 4 5 6 = 1/16 ⅛ ¼ ½ whole ·
// . dot · T triplet · R rest · N add a note after · Delete remove · ⌘Z undo. A bar whose notes no longer fit the
// song's meter gets its own time signature (5 beats in a 4/4 song → that bar becomes 5/4).
// small pictures of each note (head, stem, flags), drawn as SVG
const head = (filled) => `<ellipse cx="8" cy="18" rx="4.6" ry="3.4" transform="rotate(-22 8 18)" ${filled ? '' : 'fill="none" stroke-width="1.6"'}/>`;
const stem = '<path d="M12.2 17V3" stroke-width="1.5" fill="none"/>';
const flag = (y) => `<path d="M12.2 ${y}c2.5 2 5 3.5 4 8" stroke-width="1.6" fill="none"/>`;
const pic = (inner) => `<svg class="notepic" viewBox="0 0 20 24" aria-hidden="true">${inner}</svg>`;
const dot = '<circle cx="17" cy="19" r="1.7"/>';
const NOTE_PICS = { 0.25: pic(head(1) + stem + flag(3) + flag(7)), 0.5: pic(head(1) + stem + flag(3)), 0.75: pic(head(1) + stem + flag(3) + dot),
  1: pic(head(1) + stem), 1.5: pic(head(1) + stem + dot), 2: pic(head(0) + stem), 3: pic(head(0) + stem + dot), 4: pic(head(0)) };
const DOT_PIC = pic('<circle cx="10" cy="17" r="2.6"/>');
const rdot = '<circle cx="16" cy="13" r="1.6"/>';
const r8 = '<circle cx="8" cy="8" r="2.2"/><path d="M8 9.5c2 1 4 .5 5.5-1.5L9 21" stroke-width="1.6" fill="none"/>';
const REST_PICS = { 0.25: pic(r8 + '<circle cx="6.5" cy="13" r="2.2"/><path d="M6.5 14.5c2 1 4 .5 5.5-1.5" stroke-width="1.6" fill="none"/>'), 0.5: pic(r8), 0.75: pic(r8 + rdot),
  1: pic('<path d="M8 3l4.5 5-3.5 4 4.5 5c-3-1.5-5 0-3 3.5-4-2.5-3-6 0-5L6 9z"/>'), 1.5: pic('<path d="M7 3l4.5 5-3.5 4 4.5 5c-3-1.5-5 0-3 3.5-4-2.5-3-6 0-5L5 9z"/>' + rdot),
  2: pic('<path d="M3 13h14" stroke-width="1.4"/><rect x="6" y="9.5" width="8" height="3.5"/>'), 3: pic('<path d="M2 13h13" stroke-width="1.4"/><rect x="4.5" y="9.5" width="8" height="3.5"/>' + rdot),
  4: pic('<path d="M3 9h14" stroke-width="1.4"/><rect x="6" y="9" width="8" height="3.5"/>') };
const MODE_NOTE = pic(head(1) + stem), MODE_REST = REST_PICS[1];
const OCT_UP = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11l5-5 5 5M12 6v13" fill="none" stroke-width="1.8"/><text x="19" y="22" font-size="9" font-weight="700" stroke="none">8</text></svg>`;
const OCT_DOWN = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 13l5 5 5-5M12 18V5" fill="none" stroke-width="1.8"/><text x="19" y="9" font-size="9" font-weight="700" stroke="none">8</text></svg>`;
const TRIP_PIC = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V5h18v4" fill="none" stroke-width="1.4"/><text x="12" y="20" text-anchor="middle" font-size="12" font-weight="700" stroke="none">3</text></svg>`;
const LENGTHS = [[0.25, '16th note', '2'], [0.5, 'Eighth note', '3'], [0.75, 'Dotted eighth', ''], [1, 'Quarter note', '4'], [1.5, 'Dotted quarter (¼ + ⅛)', ''], [2, 'Half note', '5'], [3, 'Dotted half', ''], [4, 'Whole note', '6']];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function scoreEditor(view, it, host, btn) {
  if (host.querySelector('.editbar')) { host.querySelector('.editbar').dispatchEvent(new Event('close')); return; }
  if (!view.editable) return toast('This version has no melody to edit.');
  btn.classList.add('on');
  // sample scores edit their bars; real scores edit their MusicXML (upper staff)
  const model = view.real ? new XmlModel(view.xml()) : new TuneModel(view.tune);
  window.__editModel = model; // for automated tests
  let bi = 0, ni = 0;
  const undo = [];
  const panel = document.createElement('div');
  panel.className = 'editbar';
  host.append(panel);
  const paper = host.querySelector('#paper');
  paper.classList.add('editing');
  const draw = () => {
    ni = Math.max(0, Math.min(ni, model.count(bi) - 1));
    const n = model.get(bi, ni);
    const trip = isTriplet(n[1]);
    const base = trip ? n[1] * 1.5 : n[1]; // length button to light up (a triplet lights its plain note)
    const rest = n[0] === 'r';
    const pics = rest ? REST_PICS : NOTE_PICS;
    // one line: [note] · note/rest · lengths · triplet · + · Delete · undo · reset · done
    panel.innerHTML = `
      <div class="eb-row one">
        <input id="eb-pitch" class="eb-pitch" value="${rest ? '' : n[0]}" placeholder="${rest ? 'rest' : 'C4'}" aria-label="Note (e.g. C4, F#5, Bb)" title="Type a note: C, D#, Eb5… then Enter">
        <button class="eb-mode" data-a="rest" title="${rest ? 'Rest — click for note' : 'Note — click for rest'} (R)" aria-label="${rest ? 'Rest' : 'Note'}">${rest ? MODE_REST : MODE_NOTE}</button>
        <div class="stepper eb-len">${LENGTHS.map(([d, l, k]) => `<button data-len="${d}" class="${base === d ? 'on' : ''}" title="${rest ? l.replace('note', 'rest') : l}${k ? ` (${k})` : ''}" aria-label="${l}">${pics[d]}</button>`).join('')}<button data-a="trip" class="${trip ? 'on' : ''}" title="Triplet (T)" aria-label="Triplet">${TRIP_PIC}</button></div>
        <button class="icon-btn" data-a="add" title="Add a note after this one (N)" aria-label="Add note">${iconOn('plus')}</button>
        <button class="danger-text" data-a="del" ${model.count(bi) > 1 ? '' : 'disabled'} title="Delete note (⌫)">Delete</button>
        <span class="grow"></span>
        <button class="icon-btn" data-a="undo" ${undo.length ? '' : 'disabled'} title="Undo (⌘Z)" aria-label="Undo">${iconOn('undo')}</button>
        <button class="icon-btn" data-a="reset" title="Reset to the original notes" aria-label="Reset">${iconOn('restore')}</button>
        <button class="icon-btn eb-done" data-a="done" title="Done" aria-label="Done">${iconOn('check')}</button>
      </div>`;
    view.pickNote(bi, ni);
  };
  const save = async () => { if (view.real) await view.setXml(model.toString()); else await view.setMeasures(structuredClone(model.ms)); draw(); };
  const edit = async (fn) => { undo.push(model.snapshot()); fn(); await save(); };
  const step = (d) => { // next / previous note across bars
    ni += d;
    if (ni < 0 && bi > 0) { bi--; ni = model.count(bi) - 1; }
    else if (ni >= model.count(bi) && bi < model.bars() - 1) { bi++; ni = 0; }
    draw();
  };
  const nearest = (pc, ref) => { let v = null; for (let o = 2; o <= 7; o++) { const c = 12 * (o + 1) + pc; if (v === null || Math.abs(c - ref) < Math.abs(v - ref)) v = c; } return v; };
  const refOf = () => { const p = model.get(bi, ni)[0]; return p === 'r' ? 72 : midiOf(p); };
  const act = async (a, arg) => {
    if (a === 'up' || a === 'down') { const p = model.get(bi, ni)[0]; if (p !== 'r') await edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, midiOf(p) + (a === 'up' ? 1 : -1)))))); }
    if (a === 'o+' || a === 'o-') { const p = model.get(bi, ni)[0]; if (p !== 'r') await edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, midiOf(p) + (a === 'o+' ? 12 : -12)))))); }
    if (a === 'len') await edit(() => model.setLen(bi, ni, arg));
    if (a === 'dot') {
      const d = model.get(bi, ni)[1], t = twelfths(d);
      if (isTriplet(d) || t === 3) return toast('A triplet or 1/16 note can’t be dotted here.');
      await edit(() => model.setLen(bi, ni, [9, 18, 36].includes(t) ? d / 1.5 : d * 1.5));
    }
    if (a === 'trip') {
      const d = model.get(bi, ni)[1];
      if (!isTriplet(d) && !isTriplet(d / 3)) return toast('Pick a ⅛, ¼ or ½ note to make a triplet.');
      let g = ni;
      await edit(() => { g = model.triplet(bi, ni) ?? ni; });
      ni = g; draw();
    }
    if (a === 'rest') await edit(() => model.toggleRest(bi, ni));
    if (a === 'add') { await edit(() => model.add(bi, ni)); step(1); }
    if (a === 'del') await edit(() => model.del(bi, ni));
    if (a === 'letter') await edit(() => model.setPitch(bi, ni, nameOf(nearest(LETTER[arg], refOf()))));
    if (a === 'undo' && undo.length) { model.restore(undo.pop()); await save(); }
    if (a === 'reset') { undo.push(model.snapshot()); await view.revert(); model.restore(view.real ? view.xml() : view.tune.measures && new TuneModel(view.tune).snapshot()); draw(); } // undo brings the edits back
    if (a === 'done') close();
  };
  panel.onclick = (e) => {
    const lb = e.target.closest('[data-len]');
    if (lb) return act('len', +lb.dataset.len);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) act(a);
  };
  // type a note: "C", "c#", "Eb5" … a letter without octave goes to the nearest one
  const setPitch = (txt) => {
    const mm = String(txt).trim().match(/^([a-gA-G])([#b♯♭]?)(\d)?$/);
    if (!mm) { toast('Type a note like C4, F#5 or Bb'); draw(); return; }
    const pc = (LETTER[mm[1].toUpperCase()] + (/[#♯]/.test(mm[2]) ? 1 : /[b♭]/.test(mm[2]) ? -1 : 0) + 12) % 12;
    const v = mm[3] ? 12 * (+mm[3] + 1) + pc : nearest(pc, refOf());
    edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, v)))));
  };
  panel.addEventListener('keydown', (e) => { if (e.target.id === 'eb-pitch') { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); setPitch(e.target.value); } if (e.key === 'Escape') { e.target.blur(); draw(); } } });
  panel.onchange = (e) => { if (e.target.id === 'eb-pitch') setPitch(e.target.value); };
  const pick = (e) => { const g = e.target.closest('g[data-note]'); if (g) { bi = +g.dataset.bar; ni = +g.dataset.note; draw(); } };
  paper.addEventListener('click', pick);
  const keys = (e) => {
    if (e.target.closest('input,textarea,select')) return;
    const k = e.key, cmd = e.metaKey || e.ctrlKey;
    const map = { ArrowUp: cmd ? 'o+' : 'up', ArrowDown: cmd ? 'o-' : 'down', '.': 'dot', t: 'trip', T: 'trip', r: 'rest', R: 'rest', n: 'add', N: 'add', Backspace: 'del', Delete: 'del' };
    if (cmd && (k === 'z' || k === 'Z')) { e.preventDefault(); return act('undo'); }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); return step(k === 'ArrowRight' ? 1 : -1); }
    if (map[k]) { e.preventDefault(); e.stopImmediatePropagation(); return act(map[k]); }
    const len = k.length === 1 && LENGTHS.find((l) => l[2] === k);
    if (len && !cmd) { e.preventDefault(); e.stopImmediatePropagation(); return act('len', len[0]); }
    if (/^[a-gA-G]$/.test(k) && !cmd) { e.preventDefault(); return act('letter', k.toUpperCase()); }
    if (k === 'Escape') close();
  };
  document.addEventListener('keydown', keys, true);
  function close() {
    panel.remove(); view.pickNote(-1); btn.classList.remove('on'); paper.classList.remove('editing');
    paper.removeEventListener('click', pick); document.removeEventListener('keydown', keys, true);
  }
  panel.addEventListener('close', close);
  draw();
}
