// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// versions, tempo, loop bars, transpose, zoom, downloads.
import { store } from '../store.js';
import { $, esc, icon, toast, menu } from '../ui.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS } from '../musicxml.js';
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
  const tune = TUNES[it.tune];
  let version = it.version || 'original';
  let zoom = (perform ? 1.25 : 1) * (innerWidth < 760 ? 0.62 : 1);
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
  };
  makePlayer();
  const ready = render().catch((e) => { $('#osmd', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; });

  let rt;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => osmd && (osmd.render(), measureStops(), place(player.now()), ink?.fit()), 250); });
  ro.observe(root);

  return {
    ready,
    tune,
    get player() { return player; },
    get version() { return version; },
    async setVersion(v) { version = v; makePlayer(); await render(); },
    async setTranspose(n) { store.update(it.id, { transpose: n }); player.shift = n; await render(); },
    setZoom(z) { zoom = Math.max(0.6, Math.min(2, z)); osmd.zoom = zoom; osmd.render(); measureStops(); place(player.now()); ink?.fit(); },
    get zoom() { return zoom; },
    setTool(t) { ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return musicXml({ ...tune, title: it.title }, version); },
    destroy() { player.pause(); ro.disconnect(); ink?.destroy(); },
  };
}

export function scoreToolbar(bar, it, view) {
  const t = view.tune;
  const bars = t.measures.length;
  const secs = (q) => (q / (t.bpm * view.player.rate)) * 60;
  const total = bars * t.beats;
  bar.innerHTML = `
    <label class="ctl">Version <select id="sc-ver">${it.versions.map((v) => `<option value="${v}" ${v === view.version ? 'selected' : ''}>${VERSIONS[v]}</option>`).join('')}</select></label>
    <div class="transport">
      <button class="play" id="sc-play" aria-label="Play">Play</button>
      <input type="range" id="sc-pos" min="0" max="${total}" step="0.25" value="0" aria-label="Position">
      <span class="time" id="sc-time">0:00 / ${fmt(secs(total))}</span>
    </div>
    <label class="ctl">Tempo <select id="sc-rate">${[0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25].map((r) => `<option value="${r}" ${r === view.player.rate ? 'selected' : ''}>${Math.round(r * 100)}% · ${Math.round(t.bpm * r)}</option>`).join('')}</select></label>
    <button class="toggle ${view.player.loop ? 'on' : ''}" id="sc-loop">${icon('loop')}<span>Loop</span></button>
    <span class="loop-bars" id="sc-loopbars" ${view.player.loop ? '' : 'hidden'}>bars <input type="number" id="sc-la" min="1" max="${bars}" value="${view.player.loop ? view.player.loop[0] / t.beats + 1 : 1}"> to <input type="number" id="sc-lb" min="1" max="${bars}" value="${view.player.loop ? view.player.loop[1] / t.beats : Math.min(4, bars)}"></span>
    <div class="stepper" aria-label="Transpose"><button id="sc-tdown" aria-label="Transpose down">♭</button><span id="sc-tval">${it.transpose ? (it.transpose > 0 ? '+' : '') + it.transpose : '0'}</span><button id="sc-tup" aria-label="Transpose up">♯</button></div>
    <div class="stepper" aria-label="Zoom"><button id="sc-zout" aria-label="Zoom out">−</button><button id="sc-zin" aria-label="Zoom in">+</button></div>
    <button class="icon-btn" id="sc-dl" title="Download">${icon('download')}<span>Files</span></button>`;

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
  $('#sc-ver', bar).onchange = async (e) => { await view.setVersion(e.target.value); setPlay(); };
  $('#sc-rate', bar).onchange = (e) => { p().setRate(+e.target.value); time.textContent = `${fmt(secs(+pos.value))} / ${fmt(secs(total))}`; };
  const setLoop = () => {
    const a = Math.max(1, Math.min(bars, +$('#sc-la', bar).value || 1));
    const b = Math.max(a, Math.min(bars, +$('#sc-lb', bar).value || a));
    p().loop = [(a - 1) * t.beats, b * t.beats];
    if (p().now() < p().loop[0] || p().now() > p().loop[1]) p().seek(p().loop[0]);
  };
  $('#sc-loop', bar).onclick = (e) => {
    const on = !p().loop;
    e.currentTarget.classList.toggle('on', on);
    $('#sc-loopbars', bar).hidden = !on;
    if (on) setLoop(); else p().loop = null;
  };
  $('#sc-la', bar).onchange = setLoop;
  $('#sc-lb', bar).onchange = setLoop;
  const tr = async (d) => { const n = Math.max(-6, Math.min(6, (it.transpose || 0) + d)); await view.setTranspose(n); $('#sc-tval', bar).textContent = n ? (n > 0 ? '+' : '') + n : '0'; };
  $('#sc-tdown', bar).onclick = () => tr(-1);
  $('#sc-tup', bar).onclick = () => tr(1);
  $('#sc-zout', bar).onclick = () => view.setZoom(view.zoom - 0.15);
  $('#sc-zin', bar).onclick = () => view.setZoom(view.zoom + 0.15);
  $('#sc-dl', bar).onclick = (e) => menu(e.currentTarget, [
    { label: 'MusicXML (for MuseScore)', icon: 'download', run: () => download(`${it.title} - ${VERSIONS[view.version]}.musicxml`, view.xml(), 'application/vnd.recordare.musicxml+xml') },
    { label: 'MIDI', icon: 'download', run: () => toast('MIDI download comes with the Mac server (phase 2).') },
    { label: 'PDF', icon: 'print', run: () => toast('PDF download comes with the Mac server (phase 2).') },
  ]);
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
