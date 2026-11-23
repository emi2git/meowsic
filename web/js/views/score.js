// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// tempo, transpose, zoom; export lives in the More menu. Each version is its own entry.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, menu, sheet as modal } from '../ui.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS, VERSION_HELP, barBeats, xmlInfo } from '../musicxml.js';
import { ScorePlayer } from '../audio.js';
import { scoreEditor } from './scoreeditor.js';
import { InkLayer } from './annotate.js';
import { attachSwipe, flipBy } from '../swipe.js';
import { isTouch, isNarrow } from '../device.js';
import { easyOn, setEasy, creditOf, chordsOf, drawNoteLetters, easyHeaderHtml } from '../easyscore.js';

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
  // "super easy piano" look: title + keyboard chord diagrams + credit on top, letters in the noteheads
  let easy = easyOn(it);

  // each score reopens the way you left it: key (transpose), tempo and zoom are saved on the entry
  // iPad / iPhone keep their own zoom (this device only): a Mac zoom would overflow an iPhone
  const zDef = () => (perform ? 1.25 : 1) * (isNarrow() ? 0.62 : 1) * (easy ? 1.5 : 1);
  const zLocal = isTouch(), zKey = `meowsic-zoom-${it.id}`;
  let zoom = zDef();
  if (zLocal) { try { zoom = +localStorage.getItem(zKey) || zoom; } catch {} } else zoom = it.zoom || zoom;
  let osmd, player, stops = [], bar, ink = null, inkTool = null;

  root.innerHTML = `<div class="score-wrap ${perform ? 'perform' : ''}"><div class="score-paper" id="paper"><div id="easyhead"></div><div id="osmd"></div></div></div>`;
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

  // after every layout: letters in the noteheads and the header (chords follow transpose)
  const decorate = () => {
    const head = $('#easyhead', root);
    paper.classList.toggle('easy', easy);
    if (!easy) { head.innerHTML = ''; return; }
    drawNoteLetters(osmd);
    head.innerHTML = easyHeaderHtml({ title: it.title, credit: (real ? creditOf(xmlText) : '') || (it.source === 'Meowsic AI' || it.ai ? 'Meowsic AI' : it.artist || ''), chords: chordsOf(osmd), scale: isNarrow() ? 0.8 : Math.max(1, (zoom / 1.5) * 1.25) });
  };
  const relayout = () => { osmd.render(); decorate(); tagNotes(); measureStops(); place(player.now()); ink?.fit(); };

  const render = async () => {
    await loadOsmd();
    const O = window.opensheetmusicdisplay;
    $('#osmd', root).innerHTML = '';
    osmd = new O.OpenSheetMusicDisplay($('#osmd', root), {
      autoResize: false, backend: 'svg', drawTitle: !easy, drawMetronomeMarks: !easy, drawSubtitle: false, drawComposer: false, drawPartNames: version === 'vocal',
      drawPartAbbreviations: false, drawMeasureNumbersOnlyAtSystemStart: true, followCursor: false,
    });
    const r = osmd.EngravingRules;
    r.MinNoteDistance = easy ? 2.6 : 2.0; r.ChordSymbolXSpacing = 1.5; r.LyricsHeight = 1.8;
    if (easy) { r.DefaultFontFamily = 'Helvetica Neue, Helvetica, Arial, sans-serif'; r.PageTopMargin = 2; r.InstantaneousTempoTextHeight = 1.7; r.UnknownTextHeight = 1.7; }
    await osmd.load(real ? xmlText : musicXml({ ...tune, title: it.title }, version));
    osmd.zoom = zoom;
    if (it.transpose) {
      osmd.TransposeCalculator = new O.TransposeCalculator();
      osmd.Sheet.Transpose = it.transpose;
      osmd.updateGraphic();
    }
    osmd.render();
    decorate();
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
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => osmd && relayout(), 250); });
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
  // the beat under a point: nearest drawn line, then between the two stops either side of x
  const qAt = (cx, cy) => {
    const host = bar?.parentElement;
    if (!host || !stops.length) return null;
    const r = host.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    let best = null, bd = Infinity;
    for (const st of stops) {
      const d = y < st.top ? st.top - y : y > st.top + st.h ? y - st.top - st.h : 0;
      if (d < bd) { bd = d; best = st.top; }
    }
    if (bd > 80) return null;
    const line = stops.filter((st) => st.top === best).sort((a, b) => a.x - b.x || a.q - b.q);
    if (x <= line[0].x) return line[0].q;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      if (x < b.x) return b.x > a.x ? a.q + ((b.q - a.q) * (x - a.x)) / (b.x - a.x) : a.q;
    }
    return line.at(-1).q;
  };
  // move the orange line: drag it, or tap / click anywhere on the music; Play then starts there
  // (not while editing notes or writing on the page)
  let drag = null, tap = null, dragEnd = 0;
  const busy = () => !!inkTool || paper.classList.contains('editing');
  const seekTo = (q) => { if (q == null || !player) return; player.seek(Math.max(0, q)); if (bar && !player.playing) place(Math.max(q, 1e-3)); };
  paper.addEventListener('pointerdown', (e) => {
    if (busy() || e.button > 0) return;
    if (bar && e.target === bar) {
      e.preventDefault();
      drag = { id: e.pointerId, was: player?.playing };
      if (drag.was) player.pause();
      try { bar.setPointerCapture(e.pointerId); } catch {}
      bar.classList.add('dragging');
      return;
    }
    tap = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  paper.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    seekTo(qAt(e.clientX, e.clientY));
  });
  const endDrag = (e) => {
    if (drag && e.pointerId === drag.id) {
      const was = drag.was; drag = null; dragEnd = Date.now();
      bar?.classList.remove('dragging');
      if (was) player.play();
      return;
    }
    const t = tap; tap = null;
    if (!t || e.type !== 'pointerup' || busy() || e.target.closest('a,button,input,textarea,.ink-text')) return;
    if (Math.abs(e.clientX - t.x) > 8 || Math.abs(e.clientY - t.y) > 8 || Date.now() - t.t > 500) return;
    seekTo(qAt(e.clientX, e.clientY));
  };
  paper.addEventListener('pointerup', endDrag);
  paper.addEventListener('pointercancel', endDrag);
  // iPad / iPhone: swipe left / right = a screen down / up; swipe up at the end = back to the library
  const scroller = () => root.closest('.scroll-host');
  const offSwipe = perform ? () => {} : attachSwipe(root, { scroller, upAtEnd: true,
    canStart: () => !busy() && !drag && Date.now() - dragEnd > 300,
    onLeft: () => flipBy(scroller(), 1), onRight: () => flipBy(scroller(), -1) });

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
    zoomReset() { this.setZoom(zDef()); },
    setZoom(z) { zoom = Math.max(0.6, Math.min(2, Math.round(z * 100) / 100)); if (zLocal) { try { localStorage.setItem(zKey, zoom); } catch {} } else store.update(it.id, { zoom }); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); osmd.zoom = zoom; relayout(); },
    get easy() { return easy; },
    async setEasy(on) { easy = !!on; setEasy(it, easy); await render(); },
    get zoom() { return zoom; },
    setTool(t) { inkTool = t; ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return real ? xmlText : musicXml({ ...tune, title: it.title }, version); },
    get real() { return real; },
    get totalQ() { return real ? Math.ceil(info.totalQ) : tune.measures.reduce((s, m) => s + barBeats(tune, m), 0); },
    seekAt: qAt, seek: seekTo,
    destroy() { player.pause(); ro.disconnect(); offSwipe(); ink?.destroy(); },
  };
}

// Export entries for the item's More menu
export function scoreTools(it, view) {
  return [{ label: 'Make another version…', icon: 'plus', run: () => generateVersions(it) },
    { label: 'Note names in noteheads', icon: 'text', checked: view.easy, run: () => view.setEasy(!view.easy) },
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
      source: `From the score “${it.title}”`, sourceUrl: it.sourceUrl || '', outputs, output: outputs.map((v) => VERSIONS[v]).join(' + ') });
    s.close();
    toast(`Making ${outputs.map((v) => VERSIONS[v]).join(', ')} — progress is in Add → Score`);
  };
}
