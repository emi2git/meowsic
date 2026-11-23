// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// tempo, transpose, zoom; export lives in the More menu. Each version is its own entry.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, menu, sheet as modal, confirmSheet } from '../ui.js';
import { pageSrc } from './sheet.js';
import { go } from '../app.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS, VERSION_HELP, barBeats, xmlInfo } from '../musicxml.js';
import { ScorePlayer, VoicePlayer } from '../audio.js';
import { scoreEditor } from './scoreeditor.js';
import { fitLyrics } from './fitlyrics.js';
import { editNotes, hasPiano } from './editnotes.js';
import { InkLayer } from './annotate.js';
import { attachSwipe, flipBy } from '../swipe.js';
import { isTouch, isNarrow } from '../device.js';
import { easyOn, setEasy, classicXml, drawNoteLetters, kidsRules } from '../easyscore.js';
import { chordsMode, setChordsMode, nextMode, MODE_LABEL, ukePanel } from '../ukepanel.js';
const CHORD_ICON = { piano: 'piano', uke: 'ukulele', off: 'chordgrid' }; // the chords button shows its state
import { simplePiano } from './simplepiano.js';
import { paginate, pageOfY, showPage, pagerInput } from '../pager.js';

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

export function scoreBody(root, it, { perform = false } = {}) {
  // an edited score keeps its own bars on the entry (it.measures); otherwise the original tune
  let tune = it.measures ? { ...TUNES[it.tune], measures: structuredClone(it.measures) } : TUNES[it.tune];
  // a real score (from the Mac): its own MusicXML; notes for playback are read out of it
  const real = !tune;
  let xmlText = '', info = null;
  const loadReal = async () => {
    const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml`);
    if (!r.ok) throw new Error('Could not load this score from the Mac.');
    xmlText = classicXml(await r.text(), it);
    info = xmlInfo(xmlText);
    tune = { title: it.title, bpm: info.bpm, beats: info.beats, measures: [], real: true };
  };
  const version = it.version || 'original';
  // kids note names (baby toggle, off by default, this device): big noteheads with their letters, all staves
  let easy = easyOn(it);
  // iPad / iPhone: no scrolling; the score is cut into screen-high pages, turned like a sheet's
  const paged = isTouch() && !perform;
  let pages = [], page = 0, stopOff = 0;

  // each score reopens the way you left it: key (transpose), tempo and zoom are saved on the entry
  // iPad / iPhone keep their own zoom (this device only): a Mac zoom would overflow an iPhone
  const zDef = () => (perform ? 1.25 : 1) * (isNarrow() ? 0.62 : 1);
  const zLocal = isTouch(), zKey = `meowsic-zoom-${it.id}`;
  let zoom = zDef();
  if (zLocal) { try { zoom = +localStorage.getItem(zKey) || zoom; } catch {} } else zoom = it.zoom || zoom;
  let osmd, player, stops = [], bar, ink = null, inkTool = null;
  let drawn = false; // OSMD has loaded and drawn the score (a resize / zoom before that must not render: "Before render, please load…")

  root.innerHTML = `<div class="score-wrap ${perform ? 'perform' : ''} ${paged ? 'paged' : ''}"><div class="score-paper" id="paper"><div class="score-clip" id="clip"><div class="score-sheet" id="sheet"><div id="osmd"></div></div></div></div></div>`;
  const paper = $('#paper', root), clip = $('#clip', root), sheet = $('#sheet', root);

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
    stopOff = bar.parentElement.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
  };

  const place = (q, follow = true) => {
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
    // paged: the page follows the line (turns when it moves past the page's last line)
    if (paged && follow && pages.length) { const k = pageOfY(pages, a.top + stopOff + a.h / 2); if (k !== page) goPage(k); }
    const host = root.closest('.scroll-host');
    if (!paged && host && player?.playing) {
      const top = a.top + paper.offsetTop, view = host.scrollTop;
      if (top < view + 40 || top + a.h > view + host.clientHeight - 40) host.scrollTo({ top: Math.max(0, top - 80) });
    }
    root.dispatchEvent(new CustomEvent('tick', { detail: { q }, bubbles: true }));
  };

  // words "Add lyrics from a sheet" wasn't sure of carry <lyric color>: OSMD ignores it, so colour them here
  let unsureOf = null, unsureXml = null;
  const unsureLyrics = () => {
    if (unsureXml !== xmlText) {
      unsureXml = xmlText; unsureOf = null;
      if (/<lyric\b[^>]*\bcolor=/.test(xmlText)) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        unsureOf = [...(doc.querySelector('part')?.querySelectorAll(':scope > measure') || [])]
          .map((m) => new Set([...m.querySelectorAll('lyric[color]')].map((l) => [...l.querySelectorAll('text')].map((t) => t.textContent).join(''))));
      }
    }
    if (!unsureOf) return;
    osmd.GraphicSheet.MeasureList.forEach((staves, bi) => {
      const red = unsureOf[bi];
      if (!red?.size) return;
      for (const se of staves[0]?.staffEntries || []) for (const le of se.LyricsEntries || []) {
        const n = le.graphicalLabel?.SVGNode;
        if (n && red.has(le.lyricsEntry?.Text)) { n.classList.add('lyric-unsure'); [n, ...n.querySelectorAll('*')].forEach((x) => { x.style.fill = '#D22'; }); }
      }
    });
  };

  // after every layout: kids mode = big noteheads with their letters (they follow transpose)
  const decorate = () => {
    unsureLyrics();
    paper.classList.toggle('easy', easy);
    if (!easy) return;
    drawNoteLetters(osmd, { minPx: isNarrow() ? 9 : 0 }); // iPhone: heads grow more if needed so the letters stay readable
  };

  // ---- pages (iPad / iPhone) ----
  // one block per system: from halfway after the system before to halfway before the next, so
  // chord names above and lyrics below stay with their staves; page 1 also holds the title
  const systemBlocks = () => {
    const svg = $('#osmd svg', root);
    if (!svg) return [];
    const sr = sheet.getBoundingClientRect(), vr = svg.getBoundingClientRect();
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const unit = (vb[2] ? vr.width / vb[2] : zoom) * 10; // px per OSMD unit
    const off = vr.top - sr.top;
    const sys = [];
    for (const pg of osmd.GraphicSheet?.MusicPages || []) for (const ms of pg.MusicSystems || []) {
      const ps = ms.PositionAndShape, y = ps.AbsolutePosition.y;
      sys.push({ top: off + (y + ps.BorderMarginTop) * unit, bottom: off + (y + ps.BorderMarginBottom) * unit });
    }
    sys.sort((a, b) => a.top - b.top);
    const end = sheet.scrollHeight;
    return sys.map((s, i) => ({
      top: i ? (sys[i - 1].bottom + s.top) / 2 : 0,
      bottom: i < sys.length - 1 ? (s.bottom + sys[i + 1].top) / 2 : Math.max(s.bottom + 12, Math.min(end, s.bottom + 40)),
    }));
  };
  // page dots under the score (iPad/iPhone pages): one dot per page, the current one filled
  const drawDots = () => {
    let d = paper.querySelector('.score-dots');
    if (!paged || pages.length < 2) { d?.remove(); return; }
    if (!d) { d = document.createElement('div'); d.className = 'score-dots'; d.setAttribute('aria-hidden', 'true'); paper.append(d); }
    if (d.childElementCount !== pages.length) d.innerHTML = '<i></i>'.repeat(pages.length);
    [...d.children].forEach((x, k) => x.classList.toggle('on', k === page));
  };
  const goPage = (k) => {
    if (!pages.length) return;
    page = Math.max(0, Math.min(pages.length - 1, k));
    showPage(sheet, clip, pages[page]);
    drawDots();
    root.dispatchEvent(new CustomEvent('pagechange', { detail: { page: page + 1, show: [page + 1], pages: pages.length }, bubbles: true }));
  };
  const repaginate = () => {
    if (!paged) return;
    const anchor = pages[page]?.first ?? 0;
    sheet.style.transform = '';
    const blocks = systemBlocks();
    pages = blocks.length ? paginate(blocks, paper.clientHeight - 26) /* room for the page dots */ : [{ start: 0, end: paper.clientHeight, first: 0, last: 0 }];
    const k = pages.findIndex((p) => anchor >= p.first && anchor <= p.last);
    goPage(k < 0 ? 0 : k);
  };
  const pageStops = () => (!paged || !pages.length ? stops : stops.filter((s) => { const y = s.top + stopOff + s.h / 2; return y >= pages[page].start && y < pages[page].end; }));
  const afterLayout = (follow) => {
    decorate(); tagNotes(); measureStops(); repaginate();
    place(player?.now() || 0, follow);
    ink?.fit();
    root.dispatchEvent(new CustomEvent('scoredrawn', { bubbles: true })); // the ukulele panel reads the drawn chords
  };
  const relayout = () => { if (!osmd || !drawn) return; osmd.render(); afterLayout(!!player?.playing); };

  const render = async () => {
    await loadOsmd();
    const O = window.opensheetmusicdisplay;
    drawn = false;
    $('#osmd', root).innerHTML = '';
    osmd = new O.OpenSheetMusicDisplay($('#osmd', root), {
      autoResize: false, backend: 'svg', drawTitle: true, drawMetronomeMarks: true, drawSubtitle: false, drawComposer: true, drawPartNames: version === 'vocal',
      drawPartAbbreviations: false, drawMeasureNumbersOnlyAtSystemStart: true, followCursor: false,
    });
    const r = osmd.EngravingRules;
    r.MinNoteDistance = 2.0; r.ChordSymbolXSpacing = 1.5; r.LyricsHeight = 1.8;
    // markings with empty text (e.g. a bare tempo <words/>) crash OSMD's reader — drop them; the tempo lives on the item anyway
    const tidyXml = (x) => x.replace(/<direction(?:\s[^>]*)?>\s*<direction-type>\s*<words\s*\/>\s*<\/direction-type>[\s\S]*?<\/direction>/g, '');
    // the credits drawn on the score: the song's real artist (the item's Artist) as the composer, and on the left a
    // small line saying what Meowsic did: Made (pieces it wrote) / Arranged (versions of a score) / Read (photo → score) /
    // Transcribed (recordings). Shown in OSMD's lyricist place; the file itself keeps it as the arranger.
    const credit = (x) => {
      const q = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const src = it.source || '', a = (it.artist || '').trim();
      const by = src.startsWith('From the score') ? 'Arranged by Meowsic' : src.startsWith('From the sheet') ? 'Read by Meowsic'
        : it.ai || /^Meowsic( AI)?$/.test(src) ? 'Made by Meowsic' : 'Transcribed by Meowsic';
      const c = (a && !/^Meowsic( AI)?$/.test(a) ? `<creator type="composer">${q(a)}</creator>` : '') + `<creator type="lyricist">${by}</creator>`;
      x = x.replace(/<creator\b[^>]*>[\s\S]*?<\/creator>|<creator\b[^>]*\/>/g, '');
      if (/<identification>/.test(x)) return x.replace(/<identification>/, '<identification>' + c);
      return x.replace(/(<part-list>)/, '<identification>' + c + '</identification>$1');
    };
    const xml = credit(tidyXml(real ? xmlText : musicXml({ ...tune, title: it.title }, version)));
    if (easy) kidsRules(r); // big noteheads: wider spacing
    await osmd.load(xml);
    osmd.zoom = zoom;
    if (it.transpose) {
      osmd.TransposeCalculator = new O.TransposeCalculator();
      osmd.Sheet.Transpose = it.transpose;
      osmd.updateGraphic();
    }
    osmd.render();
    drawn = true;
    ink?.destroy();
    ink = new InkLayer(sheet, it.id, `score-${version}`);
    afterLayout(true);
    if (!player?.posQ) bar.style.display = 'none';
  };

  // Voice (Make it sing): the sung audio plays in place of the piano; on by default once a score has one
  // (this device remembers turning it off). midi = the piano player; `player` = whichever is playing.
  let midi = null, voice = null;
  const vKey = `meowsic-voice-${it.id}`;
  const hasVoice = () => real && !!it.vocalAudio;
  let voiceOn = (() => { try { return localStorage.getItem(vKey) !== '0'; } catch { return true; } })();
  const onEnded = () => root.dispatchEvent(new CustomEvent('ended', { bubbles: true }));
  const makeVoice = () => {
    voice?.destroy();
    voice = new VoicePlayer({ url: `/api/items/${encodeURIComponent(it.id)}/vocal?v=${encodeURIComponent(it.vocalAudio)}-${it.updatedAt || 0}`,
      bpm: it.vocalBpm || tune.bpm, beats: tune.beats, endQ: midi.endQ, onTick: place, onEnd: onEnded });
  };
  const makePlayer = () => {
    const was = midi;
    player?.pause();
    midi = new ScorePlayer({ notes: real ? info.notes : tuneNotes(tune, version), bpm: tune.bpm, beats: tune.beats, onTick: place, onEnd: onEnded });
    if (was) { midi.rate = was.rate; midi.loop = was.loop; }
    midi.shift = it.transpose || 0;
    if (!was && it.rate) midi.rate = it.rate;
    if (hasVoice() && voiceOn) { makeVoice(); voice.posQ = Math.min(player?.posQ || 0, midi.endQ); player = voice; } else player = midi;
  };
  // switch between the piano and the voice at the same spot; keeps playing if it was
  const setVoice = (on) => {
    on = !!on && hasVoice();
    try { localStorage.setItem(vKey, on ? '1' : '0'); } catch {}
    if (on === (player === voice && !!voice)) { voiceOn = on; return Promise.resolve(); }
    const q = player?.now() || 0, was = !!player?.playing;
    player?.pause();
    voiceOn = on;
    if (on && (!voice || voice.failed)) makeVoice();
    player = on ? voice : midi;
    player.seek(q);
    return was ? player.play().catch(() => {}) : Promise.resolve(); // resolves once the other one is playing
  };
  const ready = (real ? loadReal() : Promise.resolve()).then(() => { makePlayer(); return render(); }).catch((e) => { $('#osmd', root).innerHTML = `<p class="err">${esc(e.message)}</p>`; });

  let rt;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(relayout, 250); });
  ro.observe(root);

  // bar under a click: find the drawn stop nearest the click on that line, then which bar its beat falls in
  const barAt = (cx, cy) => {
    const r = $('#osmd', root).getBoundingClientRect();
    const host = bar?.parentElement?.getBoundingClientRect() || r;
    const x = cx - host.left, y = cy - host.top;
    const line = pageStops().filter((s) => y >= s.top - 30 && y <= s.top + s.h + 30);
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
    const near = pageStops();
    for (const st of near) {
      const d = y < st.top ? st.top - y : y > st.top + st.h ? y - st.top - st.h : 0;
      if (d < bd) { bd = d; best = st.top; }
    }
    if (bd > 80) return null;
    const line = near.filter((st) => st.top === best).sort((a, b) => a.x - b.x || a.q - b.q);
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
  // iPad / iPhone: pages like a sheet — swipe left / right or tap the page's left / right edge
  // turns, swipe up / down = back to the library; a tap elsewhere on the music moves the line
  const scroller = () => root.closest('.scroll-host');
  const canSwipe = () => !busy() && !drag && Date.now() - dragEnd > 300;
  const offSwipe = !paged ? (perform ? () => {} : attachSwipe(root, { scroller, upAtEnd: true, canStart: canSwipe,
    onLeft: () => flipBy(scroller(), 1), onRight: () => flipBy(scroller(), -1) }))
    : pagerInput(paper, { next: () => goPage(page + 1), prev: () => goPage(page - 1), canStart: (e) => canSwipe() && e?.target !== bar, edge: 0.14 });

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
    // Fit lyrics: draw (and play) MusicXML that is not saved yet; reload() = back to what the Mac has
    async showXml(text) { xmlText = classicXml(text, it); info = xmlInfo(xmlText); tune = { ...tune, bpm: info.bpm, beats: info.beats }; makePlayer(); await render(); },
    async reload() { if (!real) return; await loadReal(); makePlayer(); await render(); },
    get player() { return player; },
    get version() { return version; },
    async setTranspose(n) { store.update(it.id, { transpose: n }); it.transpose = n; midi.shift = n; await render(); },
    // Voice: the sung audio (Make it sing) in place of the piano
    get hasVoice() { return hasVoice(); }, get voice() { return player === voice && !!voice; }, setVoice,
    voiceReady(v) { Object.assign(it, v); voice?.destroy(); voice = null; if (voiceOn) setVoice(true); },
    zoomReset() { this.setZoom(zDef()); },
    setZoom(z) { zoom = Math.max(0.6, Math.min(2, Math.round(z * 100) / 100)); if (zLocal) { try { localStorage.setItem(zKey, zoom); } catch {} } else store.update(it.id, { zoom }); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); osmd.zoom = zoom; relayout(); },
    get easy() { return easy; },
    async setEasy(on) { easy = !!on; setEasy(it, easy); root.dispatchEvent(new CustomEvent('easychange', { bubbles: true })); await render(); },
    get zoom() { return zoom; },
    get osmd() { return drawn ? osmd : null; },
    get page() { return page + 1; }, get pages() { return pages.length; },
    get pageLabel() { return paged && pages.length ? `Page ${page + 1} of ${pages.length}` : ''; },
    goTo(n) { goPage(n - 1); },
    setTool(t) { inkTool = t; ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return real ? xmlText : musicXml({ ...tune, title: it.title }, version); },
    get real() { return real; },
    get totalQ() { return real ? Math.ceil(info.totalQ) : tune.measures.reduce((s, m) => s + barBeats(tune, m), 0); },
    seekAt: qAt, seek: seekTo,
    stop() { player?.stop(); place(0); }, // Stop: back to the beginning (the orange line goes)
    destroy() { player.pause(); voice?.destroy(); ro.disconnect(); offSwipe(); ink?.destroy(); },
  };
}

// Export entries for the item's More menu
export function scoreTools(it, view) {
  return [{ label: 'Make another version…', icon: 'plus', run: () => generateVersions(it) },
    ...(store.mode === 'server' ? [{ label: 'Add lyrics from a sheet…', icon: 'text', run: () => addLyrics(it) }] : []),
    ...(store.mode === 'server' && view.real ? [{ label: 'Fit lyrics…', icon: 'text', run: () => fitLyrics(view, it, document.querySelector('.viewer')) }] : []),
    ...(store.mode === 'server' && view.real && hasPiano(view.xml()) ? [{ label: 'Edit notes…', icon: 'edit', run: () => editNotes(view, it, document.querySelector('.viewer')) }] : []),
    { label: 'Kids note names', icon: 'baby', checked: view.easy, run: () => view.setEasy(!view.easy) },
    { label: `Chords: ${MODE_LABEL[chordsMode()]} (tap for ${MODE_LABEL[nextMode(chordsMode())].toLowerCase()})`, icon: CHORD_ICON[chordsMode()], run: () => document.querySelector('.viewer')?.dispatchEvent(new CustomEvent('uketoggle')) },
    ...(view.real && /<lyric[\s>]/.test(view.xml()) ? [{ label: view.hasVoice ? 'Make it sing again (beta)' : 'Make it sing (beta)', icon: 'wave', run: () => makeItSing(it) }] : []),
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
  const bpmNow = () => Math.round((view.player.bpm || t.bpm) * view.player.rate);
  window.__score = view; // for automated tests (the orange line shows where it is; there is no position bar)
  bar.innerHTML = `${view.pageLabel ? `<span class="pageno" id="pageno">${view.pageLabel}</span>` : ''}
    <div class="transport">
      <button class="icon-btn stop" id="sc-stop" aria-label="Stop" title="Stop: back to the beginning">${iconOn('stop')}</button>
      <button class="play" id="sc-play" aria-label="Play" title="Play (space)">${iconOn('play')}</button>
    </div>
    <div class="stepper" aria-label="Tempo" title="Tempo"><button id="sc-slow" aria-label="Slower">−</button><span id="sc-rate">${bpmNow()} bpm</span><button id="sc-fast" aria-label="Faster">+</button></div>
    <div class="stepper" aria-label="Transpose"><button id="sc-tdown" aria-label="Transpose down">♭</button><span id="sc-tval">${it.transpose ? (it.transpose > 0 ? '+' : '') + it.transpose : '0'}</span><button id="sc-tup" aria-label="Transpose up">♯</button></div>
    <div class="stepper zoom" aria-label="Zoom"><button id="sc-zout" aria-label="Zoom out" title="Zoom out (−)">${iconOn('zoomout')}</button><button id="sc-zreset" class="zreset" title="Reset zoom (0)">${Math.round(view.zoom * 100)}%</button><button id="sc-zin" aria-label="Zoom in" title="Zoom in (+)">${iconOn('zoomin')}</button></div>
    <button class="icon-btn" id="sc-edit" title="Edit notes" aria-label="Edit notes">${iconOn('edit')}</button>
    ${store.mode === 'server' && view.real ? `<button class="icon-btn" id="sc-simple" title="Simple piano: smooth rests and rhythm, main notes, hands…" aria-label="Simple piano">${iconOn('simplepiano')}</button>` : ''}
    <span class="tg-row">
    <button class="tg-btn ${chordsMode() !== 'off' ? 'on' : ''}" id="sc-chords" data-mode="${chordsMode()}" title="${MODE_LABEL[chordsMode()]}" aria-label="${MODE_LABEL[chordsMode()]}">${iconOn(CHORD_ICON[chordsMode()])}</button>
    <button class="tg-btn ${view.easy ? 'on' : ''}" id="sc-names" aria-pressed="${view.easy}" title="Kids note names: big noteheads with the note's letter" aria-label="Kids note names">${iconOn('baby')}</button>
    <button class="tg-btn ${view.voice ? 'on' : ''}" id="sc-voice" aria-pressed="${view.voice}" title="Voice: hear it sung (off = piano only)" aria-label="Voice"${view.hasVoice ? '' : ' hidden'}>${iconOn('voice')}</button>
    </span>`;

  const p = () => view.player;
  const playBtn = $('#sc-play', bar);
  const setPlay = () => { const on = p().playing; playBtn.innerHTML = iconOn(on ? 'pause' : 'play'); playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play'); playBtn.title = on ? 'Pause (space)' : 'Play (space)'; };
  playBtn.onclick = async () => {
    if (p().playing) p().pause();
    else { const pr = p().play(); setPlay(); try { await pr; } catch { toast(view.voice ? 'Could not play the voice — tap Play again, or turn Voice off.' : 'Could not start playback.'); } }
    setPlay();
  };
  $('#sc-stop', bar).onclick = () => { view.stop(); setPlay(); };
  const host = bar.closest('.viewer') || document;
  const onEnd = () => setPlay();
  host.addEventListener('ended', onEnd);
  // tempo in beats per minute, 5 at a time; the score's own tempo is the starting point
  // Voice: the sung audio has its own tempo and key — a tempo or key change goes back to the piano
  const voiceBtn = $('#sc-voice', bar);
  const vl = () => { voiceBtn.hidden = !view.hasVoice; voiceBtn.classList.toggle('on', view.voice); voiceBtn.setAttribute('aria-pressed', String(view.voice)); $('#sc-rate', bar).textContent = `${bpmNow()} bpm`; setPlay(); };
  voiceBtn.onclick = async () => { const pr = view.setVoice(!view.voice); vl(); await pr; vl(); };
  const toPiano = (why) => { if (!view.voice) return; view.setVoice(false); vl(); toast(`${why} — back to the piano (the voice sings at its own tempo and key)`); };
  const onSung = (e) => { // "Make it sing" finished for this score: Voice turns on
    if (!(e.detail || []).includes(it.id)) return;
    setTimeout(() => { const f = store.get(it.id); if (!f?.vocalAudio) return; view.voiceReady({ vocalAudio: f.vocalAudio, vocalBpm: f.vocalBpm, updatedAt: f.updatedAt }); vl(); toast('It sings now — Voice is on'); }, 800);
  };
  addEventListener('meowsic-new-items', onSung);
  const rate = (d) => {
    toPiano('Tempo changed');
    const bpm = Math.max(30, Math.min(220, Math.round(t.bpm * p().rate / 5) * 5 + d * 5));
    p().setRate(bpm / t.bpm);
    store.update(it.id, { rate: bpm / t.bpm });
    $('#sc-rate', bar).textContent = `${bpm} bpm`;
  };
  $('#sc-slow', bar).onclick = () => rate(-1);
  $('#sc-fast', bar).onclick = () => rate(1);
  const tr = async (d) => { toPiano('Key changed'); const n = Math.max(-6, Math.min(6, (it.transpose || 0) + d)); await view.setTranspose(n); $('#sc-tval', bar).textContent = n ? (n > 0 ? '+' : '') + n : '0'; };
  $('#sc-tdown', bar).onclick = () => tr(-1);
  $('#sc-tup', bar).onclick = () => tr(1);
  const zl = () => ($('#sc-zreset', bar).textContent = `${Math.round(view.zoom * 100)}%`);
  $('#sc-zout', bar).onclick = () => { view.setZoom(view.zoom - 0.15); zl(); };
  $('#sc-zin', bar).onclick = () => { view.setZoom(view.zoom + 0.15); zl(); };
  $('#sc-zreset', bar).onclick = () => { view.zoomReset(); zl(); };
  const names = $('#sc-names', bar);
  const nl = () => { names.classList.toggle('on', view.easy); names.setAttribute('aria-pressed', String(view.easy)); };
  names.onclick = async () => { await view.setEasy(!view.easy); nl(); };
  bar.closest('.viewer')?.addEventListener('easychange', nl);
  // chords: piano → ukulele → off; a panel beside the score (iPhone: a bottom sheet); remembered on this device
  const viewer = bar.closest('.viewer');
  const chBtn = $('#sc-chords', bar);
  let uke = null;
  const setMode = (m) => {
    setChordsMode(m);
    if (m === 'off') { uke?.destroy(); uke = null; }
    else if (!uke && viewer) uke = ukePanel(view, it, viewer, m);
    else uke?.setMode(m);
    chBtn.innerHTML = iconOn(CHORD_ICON[m]);
    chBtn.dataset.mode = m;
    chBtn.classList.toggle('on', m !== 'off');
    chBtn.setAttribute('aria-label', MODE_LABEL[m]);
    chBtn.title = `${MODE_LABEL[m]} — tap for ${MODE_LABEL[nextMode(m)].toLowerCase()}`;
  };
  chBtn.onclick = () => setMode(nextMode(chordsMode()));
  const onUkeClose = () => setMode('off'), onUkeToggle = () => setMode(nextMode(chordsMode()));
  viewer?.addEventListener('ukeclose', onUkeClose);
  viewer?.addEventListener('uketoggle', onUkeToggle);
  if (chordsMode() !== 'off') view.ready.then(() => { if (!uke && bar.isConnected) setMode(chordsMode()); });
  $('#sc-edit', bar).onclick = (e) => scoreEditor(view, it, bar.closest('.viewer'), e.currentTarget);
  const simpleBtn = $('#sc-simple', bar);
  if (simpleBtn) simpleBtn.onclick = () => simplePiano(view, it, bar.closest('.viewer'));
  bar.closest('.viewer')?.addEventListener('zoomchange', zl);
  const onSpace = (e) => { if (e.key === ' ' && !e.target.closest('input,select,textarea,button')) { e.preventDefault(); playBtn.click(); } };
  document.addEventListener('keydown', onSpace);
  return () => {
    host.removeEventListener('ended', onEnd); document.removeEventListener('keydown', onSpace); removeEventListener('meowsic-new-items', onSung);
    viewer?.removeEventListener('ukeclose', onUkeClose); viewer?.removeEventListener('uketoggle', onUkeToggle); uke?.destroy(); uke = null;
  };
}

// Make it sing (beta): the Mac sings the melody with its lyrics (SoulX-Singer, offline) over a soft piano;
// the audio is saved with this score and the Voice button plays it
async function makeItSing(it) {
  const ok = await confirmSheet({ title: `Make “${it.title}” sing?`, body: 'Beta. The Mac sings the melody with its English lyrics over a soft piano (about 2–3 minutes for a short song). When it is done, Play sings it; the Voice button switches back to the piano.', ok: 'Make it sing' });
  if (!ok) return;
  store.addJob({ kind: 'sing', title: it.title, source: 'Make it sing (beta)', output: 'Voice', outputs: ['voice'], fromItemId: it.id });
  toast('Singing… progress is in Add → Score');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// make other arrangements of this score; each one becomes its own entry, tagged with its version (never Original: it exists)
function generateVersions(it) {
  const have = new Set(store.items().filter((x) => x.kind === 'score' && x.title === it.title && x.tune === it.tune).map((x) => x.version));
  const pick = new Set();
  const s = modal(`<h2>Make another version of “${esc(it.title)}”</h2>
    <p class="muted">Pick one or more. Each becomes its own entry in the library.</p>
    <div class="cards one-col" id="gv">${Object.keys(VERSIONS).filter((v) => v !== 'original').map((v) => `<button type="button" class="card-opt" data-o="${v}">
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

// the words of a sheet (photos of the printed song) under this score's tune: the Mac reads the sheet, lines its
// tune up with this one and writes a new score with lyrics; syllables it isn't sure of are red, their bars "check"
const fold = (t) => (t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function addLyrics(it) {
  const me = fold(it.title);
  const near = (x) => { const t = fold(x.title); return t && me && (t === me || t.includes(me) || me.includes(t)); };
  const sheets = store.items().filter((x) => x.kind === 'sheet' && !x.deleted && !x.book && x.pages)
    .sort((a, b) => near(b) - near(a) || a.title.localeCompare(b.title));
  const s = modal(`<h2>Add lyrics to “${esc(it.title)}”</h2><p class="muted">Pick the sheet with the words. The Mac reads it (about 20 s a page), finds where each syllable goes in this score's tune and adds the result as a new entry; this score stays as it is.</p>
    <input type="search" placeholder="Find a sheet" id="al-q">
    <div class="list-pick" id="al-list"></div><div class="modal-actions"><button data-close>Cancel</button></div>`, { wide: true });
  const list = $('#al-list', s.el);
  const draw = (q = '') => (list.innerHTML = sheets.filter((x) => x.title.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
    .map((x) => `<button data-id="${x.id}"><img src="${pageSrc(x, 1)}" alt=""><span>${esc(x.title)}${near(x) ? ' <small class="have">· same song</small>' : ''}</span><i>${x.pages} p</i></button>`).join('')
    || '<p class="muted">No sheet with that name.</p>');
  draw();
  $('#al-q', s.el).oninput = (e) => draw(e.target.value);
  list.onclick = async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const sh = store.get(b.dataset.id);
    s.close();
    const ok = await confirmSheet({ title: `Add the words of “${sh.title}”?`, body: `The Mac reads its ${sh.pages} page${sh.pages > 1 ? 's' : ''} and puts the words under “${it.title}”. The new score is its own entry, tagged “Lyrics added”; syllables it isn't sure of are red and their bars say “check lyrics”.`, ok: 'Add lyrics' });
    if (!ok) return;
    store.addJob({ kind: 'lyrics', title: it.title, fromItemId: it.id, sheetId: sh.id, artist: it.artist || '',
      source: `From the score “${it.title}” + lyrics from the sheet`, output: 'Lyrics added', outputs: [it.version || 'original'] });
    toast('Reading the words…', { label: 'Progress', run: () => go('#/jobs') });
  };
}
