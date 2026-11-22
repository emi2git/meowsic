// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// tempo, transpose, zoom; export lives in the More menu. Each version is its own entry.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, menu, sheet as modal } from '../ui.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS, VERSION_HELP, barBeats, midiOf, nameOf } from '../musicxml.js';
import { ScorePlayer } from '../audio.js';
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
  const version = it.version || 'original';
  // each score reopens the way you left it: key (transpose), tempo and zoom are saved on the entry
  let zoom = it.zoom || (perform ? 1.25 : 1) * (innerWidth < 760 ? 0.62 : 1);
  let osmd, player, stops = [], bar, ink = null;

  root.innerHTML = `<div class="score-wrap ${perform ? 'perform' : ''}"><div class="score-paper" id="paper"><div id="osmd"></div></div></div>`;
  const paper = $('#paper', root);

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
    await osmd.load(musicXml({ ...tune, title: it.title }, version));
    osmd.zoom = zoom;
    if (it.transpose) {
      osmd.TransposeCalculator = new O.TransposeCalculator();
      osmd.Sheet.Transpose = it.transpose;
      osmd.updateGraphic();
    }
    osmd.render();
    measureStops();
    ink?.destroy();
    ink = new InkLayer(paper, it.id, `score-${version}`);
    place(player?.posQ || 0);
    if (!player?.posQ) bar.style.display = 'none';
  };

  const makePlayer = () => {
    const was = player;
    was?.pause();
    player = new ScorePlayer({ notes: tuneNotes(tune, version), bpm: tune.bpm, beats: tune.beats, onTick: place,
      onEnd: () => root.dispatchEvent(new CustomEvent('ended', { bubbles: true })) });
    if (was) { player.rate = was.rate; player.loop = was.loop; }
    player.shift = it.transpose || 0;
    if (!was && it.rate) player.rate = it.rate;
  };
  makePlayer();
  const ready = render().catch((e) => { $('#osmd', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; });

  let rt;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => osmd && (osmd.render(), measureStops(), place(player.now()), ink?.fit()), 250); });
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
    barAt, showBar,
    // replace the bars (edit), save on the entry, redraw and replay from the new notes
    async setMeasures(ms, { save = true } = {}) {
      tune = { ...TUNES[it.tune], measures: ms };
      if (save) store.update(it.id, { measures: ms });
      makePlayer();
      await render();
    },
    async revert() { store.update(it.id, { measures: undefined }); delete it.measures; tune = TUNES[it.tune]; makePlayer(); await render(); },
    get player() { return player; },
    get version() { return version; },
    async setTranspose(n) { store.update(it.id, { transpose: n }); player.shift = n; await render(); },
    zoomReset() { this.setZoom(innerWidth < 760 ? 0.62 : 1); },
    setZoom(z) { zoom = Math.max(0.6, Math.min(2, Math.round(z * 100) / 100)); store.update(it.id, { zoom }); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); osmd.zoom = zoom; osmd.render(); measureStops(); place(player.now()); ink?.fit(); },
    get zoom() { return zoom; },
    setTool(t) { ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return musicXml({ ...tune, title: it.title }, version); },
    destroy() { player.pause(); ro.disconnect(); ink?.destroy(); },
  };
}

// Export entries for the item's More menu
export function scoreTools(it) {
  return [{ label: 'Make another version…', icon: 'plus', run: () => generateVersions(it) }];
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
  const total = t.measures.reduce((s, m) => s + barBeats(t, m), 0);
  bar.innerHTML = `
    <div class="transport">
      <button class="play" id="sc-play" aria-label="Play">Play</button>
      <input type="range" id="sc-pos" min="0" max="${total}" step="0.25" value="0" aria-label="Position">
      <span class="time" id="sc-time">0:00 / ${fmt(secs(total))}</span>
    </div>
    <div class="stepper" aria-label="Tempo" title="Tempo"><button id="sc-slow" aria-label="Slower">−</button><span id="sc-rate">${Math.round(t.bpm * view.player.rate)} bpm</span><button id="sc-fast" aria-label="Faster">+</button></div>
    <div class="stepper" aria-label="Transpose"><button id="sc-tdown" aria-label="Transpose down">♭</button><span id="sc-tval">${it.transpose ? (it.transpose > 0 ? '+' : '') + it.transpose : '0'}</span><button id="sc-tup" aria-label="Transpose up">♯</button></div>
    <button class="icon-btn" id="sc-edit" title="Edit notes" aria-label="Edit notes">${iconOn('edit')}</button>
    <div class="stepper zoom" aria-label="Zoom"><button id="sc-zout" aria-label="Zoom out" title="Zoom out (−)">${iconOn('zoomout')}</button><button id="sc-zreset" class="zreset" title="Reset zoom (0)">${Math.round(view.zoom * 100)}%</button><button id="sc-zin" aria-label="Zoom in" title="Zoom in (+)">${iconOn('zoomin')}</button></div>`;

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
    store.addJob({ gen: true, title: it.title, artist: it.artist, tags: it.tags.filter((t) => !Object.values(VERSIONS).includes(t)), tune: it.tune, key: it.key,
      source: `From the score “${it.title}”`, outputs, output: outputs.map((v) => VERSIONS[v]).join(' + ') });
    s.close();
    toast(`Making ${outputs.map((v) => VERSIONS[v]).join(', ')} — progress is in Add → Score`);
  };
}

// ================= score editor =================
// Click a bar, pick a note, change it. A bar whose notes no longer add up to the song's meter gets
// its own time signature automatically (5 beats in a 4/4 song → that bar becomes 5/4).
const LENGTHS = [[0.5, '⅛'], [1, '¼'], [1.5, '¼·'], [2, '½'], [3, '½·'], [4, '1']];
function scoreEditor(view, it, host, btn) {
  if (host.querySelector('.editbar')) { host.querySelector('.editbar').remove(); view.showBar(-1); btn.classList.remove('on'); return; }
  btn.classList.add('on');
  let ms = structuredClone(view.tune.measures);
  let bi = 0, ni = 0;
  const undo = [];
  const panel = document.createElement('div');
  panel.className = 'editbar';
  host.append(panel);
  const paper = host.querySelector('#paper');
  const meter = view.tune.beats;
  const draw = () => {
    const m = ms[bi];
    ni = Math.max(0, Math.min(ni, m.mel.length - 1));
    const beats = m.mel.reduce((s, [, d]) => s + d, 0);
    const n = m.mel[ni];
    panel.innerHTML = `
      <div class="eb-row">
        <b>Bar ${bi + 1}</b><button class="icon-btn" data-a="pbar" ${bi ? '' : 'disabled'} title="Previous bar">‹</button><button class="icon-btn" data-a="nbar" ${bi < ms.length - 1 ? '' : 'disabled'} title="Next bar">›</button>
        <span class="eb-meter ${beats !== meter ? 'changed' : ''}">${beats} beat${beats === 1 ? '' : 's'} · ${Number.isInteger(beats) ? `${beats}/4` : `${beats * 2}/8`}${beats !== meter ? ` <small>(song is ${meter}/4 — this bar's time signature was changed to fit)</small>` : ''}</span>
        <span class="grow"></span>
        <button data-a="undo" ${undo.length ? '' : 'disabled'}>Undo</button>
        <button data-a="revert">Revert to original</button>
        <button class="primary" data-a="done">Done</button>
      </div>
      <div class="eb-notes">${m.mel.map(([p, d], i) => `<button class="eb-note ${i === ni ? 'on' : ''}" data-n="${i}">${p === 'r' ? 'rest' : p}<small>${LENGTHS.find((l) => l[0] === d)?.[1] || d}</small></button>`).join('')}
        <button class="eb-add" data-a="add" title="Add a note after the selected one">+ note</button></div>
      <div class="eb-row">
        <span class="muted">Note</span>
        <div class="stepper"><button data-a="down" title="Lower (↓)">▼</button><button data-a="up" title="Higher (↑)">▲</button></div>
        <div class="stepper"><button data-a="o-" title="Octave lower">8va−</button><button data-a="o+" title="Octave higher">8va+</button></div>
        <div class="stepper eb-len">${LENGTHS.map(([d, l]) => `<button data-len="${d}" class="${n && n[1] === d ? 'on' : ''}" title="${d} beat${d === 1 ? '' : 's'}">${l}</button>`).join('')}</div>
        <button data-a="rest">${n && n[0] === 'r' ? 'Make note' : 'Make rest'}</button>
        <button class="danger-text" data-a="del" ${m.mel.length > 1 ? '' : 'disabled'}>Delete note</button>
        <label class="ctl">Chord <input id="eb-chord" value="${m.chord || ''}" size="5"></label>
      </div>`;
    view.showBar(bi);
  };
  const commit = async () => { await view.setMeasures(structuredClone(ms)); view.showBar(bi); draw(); };
  const edit = async (fn) => { undo.push(structuredClone(ms)); fn(ms[bi]); await commit(); };
  const shift = (p, k) => (p === 'r' ? p : nameOf(Math.max(36, Math.min(96, midiOf(p) + k))));
  panel.onclick = async (e) => {
    const nb = e.target.closest('[data-n]');
    if (nb) { ni = +nb.dataset.n; draw(); return; }
    const lb = e.target.closest('[data-len]');
    if (lb) return edit((m) => { m.mel[ni][1] = +lb.dataset.len; });
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'pbar') { bi--; ni = 0; draw(); }
    if (a === 'nbar') { bi++; ni = 0; draw(); }
    if (a === 'up' || a === 'down') await edit((m) => { m.mel[ni][0] = shift(m.mel[ni][0], a === 'up' ? 1 : -1); });
    if (a === 'o+' || a === 'o-') await edit((m) => { m.mel[ni][0] = shift(m.mel[ni][0], a === 'o+' ? 12 : -12); });
    if (a === 'rest') await edit((m) => { const p = m.mel[ni][0]; m.mel[ni][0] = p === 'r' ? (m.mel[ni - 1]?.[0] !== 'r' && m.mel[ni - 1]?.[0]) || 'C5' : 'r'; });
    if (a === 'add') { await edit((m) => { const [p, d] = m.mel[ni] || ['C5', 1]; m.mel.splice(ni + 1, 0, [p === 'r' ? 'C5' : p, d]); }); ni++; draw(); }
    if (a === 'del') await edit((m) => { m.mel.splice(ni, 1); });
    if (a === 'undo' && undo.length) { ms = undo.pop(); await commit(); }
    if (a === 'revert') { undo.push(structuredClone(ms)); await view.revert(); ms = structuredClone(view.tune.measures); view.showBar(bi); draw(); }
    if (a === 'done') { panel.remove(); view.showBar(-1); btn.classList.remove('on'); paper.removeEventListener('click', pick); document.removeEventListener('keydown', keys); }
  };
  panel.onchange = (e) => { if (e.target.id === 'eb-chord') edit((m) => { m.chord = e.target.value.trim() || m.chord; }); };
  const pick = (e) => { const i = view.barAt(e.clientX, e.clientY); if (i >= 0) { bi = i; ni = 0; draw(); } };
  paper.addEventListener('click', pick);
  const keys = (e) => {
    if (!host.contains(panel) || e.target.closest('input')) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); panel.querySelector(`[data-a="${e.key === 'ArrowUp' ? 'up' : 'down'}"]`).click(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); ni = Math.max(0, Math.min(ms[bi].mel.length - 1, ni + (e.key === 'ArrowRight' ? 1 : -1))); draw(); }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); panel.querySelector('[data-a="del"]').click(); }
  };
  document.addEventListener('keydown', keys);
  draw();
}
