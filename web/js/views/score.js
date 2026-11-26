// Score viewer: OpenSheetMusicDisplay notation, piano playback with a moving bar,
// speed (%), transpose, zoom; export lives in the More menu. Each version is its own entry.
import { store } from '../store.js';
import { $, esc, icon, iconOn, toast, menu, sheet as modal, confirmSheet } from '../ui.js';
import { printEntry, download } from './actions.js';
import { TUNES } from '../mock.js';
import { musicXml, tuneNotes, VERSIONS, barBeats, xmlInfo } from '../musicxml.js';
import { ScorePlayer, VoicePlayer } from '../audio.js';
import { chordEvents } from '../chordplay.js';
import { savedMuted, saveMuted, effectiveMuted, lhMuted, handsHtml, handsClick } from '../hands.js';
import { scoreEditor } from './scoreeditor.js';
import { checkBadge } from './checkbars.js';
import { incompleteBars, barFixSheet, fixBarOp } from '../incomplete.js';
import { InkLayer } from './annotate.js';
import { attachSwipe, flipBy } from '../swipe.js';
import { isTouch, isNarrow } from '../device.js';
import { easyOn, setEasy, classicXml, drawNoteLetters, kidsRules, noTempoXml, KIDS_STAFF } from '../easyscore.js';
import { chordsMode, setChordsMode, nextMode, MODE_LABEL, ukePanel } from '../ukepanel.js';
const CHORD_ICON = { piano: 'piano', uke: 'ukulele', off: 'chordgrid' }; // the chords button shows its state
import { simplePiano } from './simplepiano.js';
import { paginate, pageOfY, showPage, pagerInput } from '../pager.js';
export const TEMPO_MIN = 30, TEMPO_MAX = 240; // the toolbar's tempo range (beats per minute)

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
  // "100%" per device: OSMD draws at label × Z_BASE[device]; the label is the user's zoom (100% = this device's default)
  //   Mac / iPad: 0.75 (the old 75%)   iPhone / narrow window: 0.62 (the old iPhone default, unchanged)
  const Z_BASE = { wide: 0.75, narrow: 0.62 };
  const zBase = () => (isNarrow() ? Z_BASE.narrow : Z_BASE.wide);
  // the OSMD zoom drawn: kids note names draw the staff KIDS_STAFF× bigger, so heads that fit a staff space are big enough to read
  const zDraw = () => zoom * zBase() * (easy ? KIDS_STAFF : 1);
  const zDef = () => (perform ? 1.25 : 1);
  const zClamp = (z) => Math.max(0.6, Math.min(2, Math.round(z * 100) / 100));
  // saved zooms keep their drawn size; each old key is converted once, then moved to zKey and removed:
  //   meowsic-zoom-<id>       (first scale) the OSMD zoom itself        → drawn / base
  //   meowsic-scorezoom-<id>  (second scale) label drawn at × 0.75     → label × 0.75 / base
  //   entry zoom: a number = first scale (drawn), a string = label (Mac, base 0.75 both before and now)
  const zLocal = isTouch(), zKey = `meowsic-devzoom-${it.id}`, zMid = `meowsic-scorezoom-${it.id}`, zOld = `meowsic-zoom-${it.id}`;
  let zoom = zDef();
  if (zLocal) {
    try {
      const n = +localStorage.getItem(zKey), m = +localStorage.getItem(zMid), o = +localStorage.getItem(zOld);
      if (n) zoom = n;
      else if (m || o) { zoom = zClamp(m ? (m * 0.75) / zBase() : o / zBase()); localStorage.setItem(zKey, zoom); }
      localStorage.removeItem(zMid); localStorage.removeItem(zOld);
    } catch {}
  } else if (typeof it.zoom === 'string') zoom = +it.zoom || zoom;
  else if (typeof it.zoom === 'number' && it.zoom > 0) zoom = zClamp(it.zoom / zBase());
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
    // OSMD repaints the cursor image (a canvas → toDataURL) on every step, and offsetLeft forces a layout each time:
    // on a long score that was ~300 ms per drawing. The cursor is never shown (the orange line is ours), so skip the
    // image while stepping and read the place from the style OSMD sets (same numbers, no layout).
    const style = c.updateStyle;
    c.updateStyle = function () {};
    const px = (v) => parseFloat(v) || 0;
    try {
      while (!c.iterator.EndReached) {
        stops.push({ q: c.iterator.currentTimeStamp.RealValue * 4, x: px(el.style.left) + (+el.width || 0) / 2, top: px(el.style.top), h: +el.height || 0 });
        c.next();
      }
    } finally { c.updateStyle = style; }
    c.hide();
    bar?.remove();
    bar = document.createElement('div');
    bar.className = 'playbar';
    bar.innerHTML = '<i class="pb-grip" aria-hidden="true"></i>'; // a grip at its top: easy to grab with a finger
    (el.parentElement || $('#osmd', root)).append(bar);
    stopOff = bar.parentElement.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
  };

  // the play start you picked (tap / drag the line, or Edit notes' cue): Play starts there, Stop comes back to it
  let cueQ = 0, cued = false, quiet = false, keepBar = false;
  const place = (q, follow = true) => {
    if (!stops.length || !bar) return;
    if (!player?.playing && q <= 0 && !cued && !keepBar) { bar.style.display = 'none'; return; }
    if (quiet) follow = false;
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
    drawNoteLetters(osmd); // heads ≤ 1 staff space at every zoom (the letter scales with them)
  };

  // ---- pages (iPad / iPhone) ----
  // one block per system: from halfway after the system before to halfway before the next, so
  // chord names above and lyrics below stay with their staves; page 1 also holds the title
  const systemBlocks = () => {
    const svg = $('#osmd svg', root);
    if (!svg) return [];
    const sr = sheet.getBoundingClientRect(), vr = svg.getBoundingClientRect();
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const unit = (vb[2] ? vr.width / vb[2] : zDraw()) * 10; // px per OSMD unit
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
  // bars not complete (a voice short of / over the time signature): a tint and a badge "2 of 4 beats" on each,
  // from the MusicXML itself (so after a save, a reload or offline too) until the bar is complete. Tapping the badge
  // offers Fill with rest / Change time for this bar (Edit notes, when open, takes the tap: one undo step there).
  let incomplete = [];
  const markIncomplete = () => {
    const osv = $('#osmd', root), svg = osv?.querySelector('svg');
    osv?.querySelectorAll('.ib-mark, .ib-badge').forEach((e) => e.remove());
    incomplete = real ? incompleteBars(xmlText) : [];
    if (!incomplete.length || !svg || !osmd?.GraphicSheet) return;
    osv.classList.add('ib-host');
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const sr = svg.getBoundingClientRect(), or = osv.getBoundingClientRect();
    const unit = (vb[2] ? sr.width / vb[2] : zDraw()) * 10;
    for (const b of incomplete) {
      const gms = (osmd.GraphicSheet.MeasureList[b.bar - 1] || []).filter(Boolean);
      if (!gms.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const gm of gms) {
        const ps = gm.PositionAndShape, q = ps.AbsolutePosition;
        x0 = Math.min(x0, q.x + ps.BorderLeft); x1 = Math.max(x1, q.x + ps.BorderRight);
        y0 = Math.min(y0, q.y + ps.BorderTop); y1 = Math.max(y1, q.y + ps.BorderBottom);
      }
      const left = sr.left - or.left + x0 * unit, top = sr.top - or.top + y0 * unit;
      const mk = document.createElement('div');
      mk.className = 'ib-mark';
      mk.dataset.bar = b.bar;
      Object.assign(mk.style, { left: left - 2 + 'px', top: top - 4 + 'px', width: (x1 - x0) * unit + 4 + 'px', height: (y1 - y0) * unit + 8 + 'px' });
      const bd = document.createElement('button');
      bd.className = 'ib-badge';
      bd.dataset.bar = b.bar;
      bd.title = `Bar ${b.bar} is not complete — tap to fix`;
      bd.setAttribute('aria-label', `Bar ${b.bar}: ${b.words} — fix`);
      bd.textContent = b.words;
      Object.assign(bd.style, { left: left + 'px', top: top - 22 + 'px' });
      bd.addEventListener('click', (e) => { e.stopPropagation(); bd.dispatchEvent(new CustomEvent('barfix', { detail: b, bubbles: true })); });
      osv.append(mk, bd);
    }
  };
  // not editing: the fix is saved at once (Activities can undo it)
  root.addEventListener('barfix', async (e) => {
    const b = e.detail, how = await barFixSheet(b);
    if (!how) return;
    try {
      const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/editnotes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [fixBarOp(b, how)], mode: 'this' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : 'Could not fix the bar');
      const was = store.get(it.id);
      if (was && j.item) Object.assign(was, { updatedAt: j.item.updatedAt, musicxmlOriginal: j.item.musicxmlOriginal });
      await loadReal(); makePlayer(); await render();
      toast(how === 'fill' ? `Bar ${b.bar} filled with rests` : `Bar ${b.bar} has its own time now`, { label: 'Activities', run: () => go('#/activity') });
    } catch (err) { toast(err.message); }
  });
  const afterLayout = (follow) => {
    decorate(); tagNotes(); measureStops(); repaginate(); markIncomplete();
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
      autoResize: false, backend: 'svg', drawTitle: true, drawMetronomeMarks: false, drawSubtitle: false, drawComposer: true, drawPartNames: version === 'vocal',
      drawPartAbbreviations: false, drawMeasureNumbersOnlyAtSystemStart: true, followCursor: false,
    });
    const r = osmd.EngravingRules;
    r.MinNoteDistance = 2.0; r.ChordSymbolXSpacing = 1.5; r.LyricsHeight = 1.8;
    // markings with empty text (e.g. a bare tempo <words/>) crash OSMD's reader — drop them; the tempo lives on the item anyway
    const tidyXml = (x) => x.replace(/<direction(?:\s[^>]*)?>\s*<direction-type>\s*<words\s*\/>\s*<\/direction-type>[\s\S]*?<\/direction>/g, '');
    // the credits drawn on the score: the song's real artist (the item's Artist) as the composer, and on the left a
    // small line saying what Meowsic did: Made (pieces it wrote) / Arranged (versions of a score) /
    // Transcribed (recordings, photo → score). Shown in OSMD's lyricist place; the file itself keeps it as the arranger.
    const credit = (x) => {
      const q = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const src = it.source || '', a = (it.artist || '').trim();
      const by = src.startsWith('From the score') ? 'Arranged by Meowsic'
        : it.ai || /^Meowsic( AI)?$/.test(src) ? 'Made by Meowsic' : 'Transcribed by Meowsic';
      const c = (a && !/^Meowsic( AI)?$/.test(a) ? `<creator type="composer">${q(a)}</creator>` : '') + `<creator type="lyricist">${by}</creator>`;
      x = x.replace(/<creator\b[^>]*>[\s\S]*?<\/creator>|<creator\b[^>]*\/>/g, '');
      if (/<identification>/.test(x)) return x.replace(/<identification>/, '<identification>' + c);
      return x.replace(/(<part-list>)/, '<identification>' + c + '</identification>$1');
    };
    const xml = credit(noTempoXml(tidyXml(real ? xmlText : musicXml({ ...tune, title: it.title }, version))));
    if (easy) kidsRules(r); // big noteheads: wider spacing
    await osmd.load(xml);
    osmd.zoom = zDraw();
    if (it.transpose) {
      osmd.TransposeCalculator = new O.TransposeCalculator();
      osmd.Sheet.Transpose = it.transpose;
      osmd.updateGraphic();
    }
    osmd.render();
    drawn = true;
    ink?.destroy();
    ink = new InkLayer(sheet, it.id, `score-${version}`);
    afterLayout(!cued);
    if (!player?.posQ && !cued) bar.style.display = 'none';
  };

  // Voice (Make it sing): the sung audio plays in place of the piano, only when chosen. Every score plays the piano by
  // default (a vocal audio or a voice staff never turns it on); this device remembers picking Voice per score
  // (`meowsic-voice2-<id>` = '1'). midi = the piano player; `player` = whichever is playing.
  let midi = null, voice = null;
  dropOldVoiceKeys();
  const vKey = `meowsic-voice2-${it.id}`;
  const hasVoice = () => real && !!it.vocalAudio;
  let voiceOn = (() => { try { return localStorage.getItem(vKey) === '1'; } catch { return false; } })();
  const onEnded = () => root.dispatchEvent(new CustomEvent('ended', { bubbles: true }));
  const makeVoice = () => {
    voice?.destroy();
    voice = new VoicePlayer({ url: `/api/items/${encodeURIComponent(it.id)}/vocal?v=${encodeURIComponent(it.vocalAudio)}-${it.updatedAt || 0}`,
      bpm: it.vocalBpm || tune.bpm, beats: tune.beats, endQ: midi.endQ, onTick: place, onEnd: onEnded, segments: midi.segments });
    voice.setRate(tempoExact() / voice.bpm);
  };
  // Tempo (the toolbar's − 96 + stepper): one setting for Play, Edit notes' ▶ / ▶ From here / cue, and the voice.
  // Kept on the entry as `rate` (× the score's own tempo, so 1 = the score's tempo and follows it). Never drawn.
  const scoreTempo = () => Math.round(tune.bpm || 100);
  const tempoExact = () => (tune.bpm || 100) * (midi?.rate || +it.rate || 1);
  const setTempo = (bpm) => {
    bpm = Math.round(bpm);
    if (!(bpm > 0)) return;
    bpm = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, bpm));
    const r = bpm === scoreTempo() ? 1 : bpm / (tune.bpm || 100);
    midi?.setRate(r);
    voice?.setRate(bpm / voice.bpm);
    it.rate = r;
  };
  // Chords (toolbar toggle, this device): the chord names above the bars played as piano chords with the score
  const cpKey = 'meowsic-chordplay';
  let chordPlay = (() => { try { return localStorage.getItem(cpKey) === '1'; } catch { return false; } })();
  let chordList = [];
  const chordNotes = () => {
    try {
      const ci = real ? info : xmlInfo(musicXml({ ...tune, title: it.title }, version));
      chordList = ci.chords || [];
      const end = Math.max(ci.totalQ || 0, ...(real ? info.notes : tuneNotes(tune, version)).map((n) => n.q + n.d));
      return chordEvents(chordList, ci.barQ, end);
    } catch { chordList = []; return []; }
  };
  // Hands (hands.js): the staves to leave out; Play chords follows the left hand
  let mutedPick = savedMuted();
  const staves = () => (real ? info?.staves || [] : ['R', 'L']);
  const muted = () => effectiveMuted(staves(), mutedPick);
  const chordsWanted = () => chordPlay && !lhMuted(muted());
  const applyHands = () => { if (!midi) return; const st = staves(), m = muted(); midi.setMute(st.map((l, i) => (m.includes(l) ? i : -1)).filter((i) => i >= 0)); midi.setChords(chordsWanted()); };
  const makePlayer = () => {
    const was = midi;
    player?.pause();
    midi = new ScorePlayer({ notes: real ? info.notes : tuneNotes(tune, version), bpm: tune.bpm, beats: tune.beats, onTick: place, onEnd: onEnded, segments: real ? info.segments : null, chords: chordNotes() });
    applyHands();
    root.dispatchEvent(new CustomEvent('chordlistchange', { bubbles: true }));
    if (was) { midi.rate = was.rate; midi.loop = was.loop; }
    midi.shift = it.transpose || 0;
    if (!was && it.rate) midi.rate = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, (tune.bpm || 100) * it.rate)) / (tune.bpm || 100);
    if (hasVoice() && voiceOn) { makeVoice(); voice.posQ = Math.min(player?.posQ || 0, midi.endQ); player = voice; } else player = midi;
    if (cued) player.posQ = Math.min(cueQ, midi.endQ); // new notes (an edit, a save): Play still starts at the cue
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
  // bar starts in quarters: real scores from their MusicXML, sample tunes from their bars
  const barStarts = () => {
    if (real) return info?.barQ?.length ? info.barQ : [0];
    const out = []; let a = 0;
    for (const m of tune.measures) { out.push(a); a += barBeats(tune, m); }
    return out.length ? out : [0];
  };
  const barOfQ = (q) => { const s = barStarts(); let i = 0; while (i + 1 < s.length && s[i + 1] <= q + 1e-6) i++; return i; };
  // a tap snaps to the note under the finger (within 14 px of its onset on that line), else to the start of its bar
  const snapAt = (cx, cy) => {
    const q = qAt(cx, cy);
    if (q == null) return null;
    const host = bar?.parentElement?.getBoundingClientRect();
    if (host) {
      const x = cx - host.left, y = cy - host.top;
      const on = pageStops().filter((st) => y >= st.top - 30 && y <= st.top + st.h + 30 && Math.abs(st.x - x) <= 14).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
      if (on.length) return on[0].q;
    }
    return barStarts()[barOfQ(q)];
  };
  const nearestStop = (q) => (q == null || !stops.length ? q : stops.reduce((b, st) => (Math.abs(st.q - q) < Math.abs(b.q - q) ? st : b), stops[0]).q);
  // move the start: Play starts here, Stop comes back here. follow = false: the page stays (Edit notes' cue)
  const seekTo = (q, { follow = true, cue = true } = {}) => {
    if (q == null || !player) return;
    q = Math.max(0, q);
    if (cue) { cueQ = q; cued = true; }
    quiet = !follow;
    try { player.seek(q); if (bar && !player.playing) place(q, follow); } finally { quiet = false; }
  };
  // saved as a new version in Edit notes: this score opens cued one bar before the first bar edited
  ready.then(() => {
    const c = window.__meowsicCue;
    if (c?.id !== it.id) return;
    delete window.__meowsicCue;
    const s = barStarts();
    seekTo(s[Math.max(0, Math.min(s.length - 1, c.bar - 1))] || 0, { follow: false });
  });
  paper.addEventListener('pointerdown', (e) => {
    const onBar = !!bar && e.target.closest?.('.playbar') === bar;
    if (e.button > 0 || inkTool || (busy() && !onBar)) return;
    if (onBar) {
      e.stopPropagation();
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
    e.preventDefault();
    // paged (iPad / iPhone): hold the line at the page's left / right edge to drag it onto the page before / after
    const pr = paper.getBoundingClientRect(), d = !paged ? 0 : e.clientX >= pr.right - 18 ? 1 : e.clientX <= pr.left + 18 ? -1 : 0;
    if (d !== (drag.edge || 0)) {
      clearTimeout(drag.edgeT); drag.edge = d;
      if (d) {
        const dd = drag;
        dd.edgeT = setTimeout(function turn() {
          if (drag !== dd || dd.edge !== d || page + d < 0 || page + d >= pages.length) return;
          goPage(page + d);
          const on = pageStops();
          if (on.length) seekTo((d > 0 ? on[0] : on.at(-1)).q, { follow: false });
          dd.edgeT = setTimeout(turn, 900);
        }, 600);
      }
    }
    if (d) return;
    const q = qAt(e.clientX, e.clientY);
    if (q != null) seekTo(nearestStop(q), { follow: false }); // snaps to the nearest note as it moves, on any line of the page
  });
  const endDrag = (e) => {
    if (drag && e.pointerId === drag.id) {
      const was = drag.was; clearTimeout(drag.edgeT); drag = null; dragEnd = Date.now();
      bar?.classList.remove('dragging');
      seekTo(nearestStop(player?.now() ?? null), { follow: false }); // lands on a note
      root.dispatchEvent(new CustomEvent('cuedrag', { detail: { q: cueQ, bar: barOfQ(cueQ) }, bubbles: true }));
      if (was) player.play().catch(() => {}); // dragged while playing: plays on from the new spot
      return;
    }
    const t = tap; tap = null;
    if (!t || e.type !== 'pointerup' || busy() || e.target.closest('a,button,input,textarea,.ink-text')) return;
    if (Math.abs(e.clientX - t.x) > 8 || Math.abs(e.clientY - t.y) > 8 || Date.now() - t.t > 500) return;
    seekTo(snapAt(e.clientX, e.clientY));
  };
  paper.addEventListener('pointerup', endDrag);
  paper.addEventListener('pointercancel', endDrag);
  // iPad / iPhone: pages like a sheet — swipe left / right or tap the page's left / right edge
  // turns, swipe up / down = back to the library; a tap elsewhere on the music moves the line
  const scroller = () => root.closest('.scroll-host');
  const canSwipe = (e) => !busy() && !drag && Date.now() - dragEnd > 300 && !e?.target?.closest?.('.playbar');
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
    // Edit notes (and its Lyrics mode): draw (and play) MusicXML that is not saved yet; reload() = back to what the Mac has
    async showXml(text) { xmlText = classicXml(text, it); info = xmlInfo(xmlText); tune = { ...tune, bpm: info.bpm, beats: info.beats }; makePlayer(); await render(); },
    async reload() { if (!real) return; await loadReal(); makePlayer(); await render(); },
    get player() { return player; },
    get pianoNotes() { return midi?.notes || []; },  // what the piano plays (Export ▸ MIDI)
    get version() { return version; },
    async setTranspose(n) { store.update(it.id, { transpose: n }); it.transpose = n; midi.shift = n; await render(); },
    // Voice: the sung audio (Make it sing) in place of the piano
    get hasVoice() { return hasVoice(); },
    get tempo() { return Math.round(tempoExact()); }, get scoreTempo() { return scoreTempo(); }, setTempo,
    // Chords: play the chord names too (piano only; hidden when the score has none)
    get hasChords() { return chordList.length > 0; }, get chordPlay() { return chordPlay; },
    get chordTimes() { return chordList; }, // [{q, name}] in score time, not transposed (the chords strip while playing)
    setChordPlay(on) { chordPlay = !!on; try { localStorage.setItem(cpKey, chordPlay ? '1' : '0'); } catch {} midi?.setChords(chordsWanted()); },
    // Hands: the staves' names ([] / one staff: no picker), the muted ones; setMuted takes effect at once (while playing too)
    get staves() { return staves(); }, get muted() { return muted(); },
    setMuted(labels) { mutedPick = [...labels]; saveMuted(mutedPick); applyHands(); root.dispatchEvent(new CustomEvent('handschange', { bubbles: true })); },
    get voice() { return player === voice && !!voice; }, setVoice,
    voiceReady(v) { Object.assign(it, v); voice?.destroy(); voice = null; if (voiceOn) setVoice(true); }, // stays on the piano unless Voice was picked
    zoomReset() { this.setZoom(zDef()); },
    setZoom(z) { zoom = zClamp(z); if (zLocal) { try { localStorage.setItem(zKey, zoom); } catch {} } else store.update(it.id, { zoom: String(zoom) }); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); osmd.zoom = zDraw(); relayout(); },
    get easy() { return easy; },
    async setEasy(on) { easy = !!on; setEasy(it, easy); root.dispatchEvent(new CustomEvent('easychange', { bubbles: true })); await render(); },
    get zoom() { return zoom; },
    get osmd() { return drawn ? osmd : null; },
    get page() { return page + 1; }, get pages() { return pages.length; },
    goTo(n) { goPage(n - 1); },
    setTool(t) { inkTool = t; ink?.setTool(t); },
    undo() { ink?.undo(); }, clear() { ink?.clear(); },
    xml() { return real ? xmlText : musicXml({ ...tune, title: it.title }, version); },
    get real() { return real; },
    get incomplete() { return incomplete; },
    get totalQ() { return real ? Math.ceil(info.totalQ) : tune.measures.reduce((s, m) => s + barBeats(tune, m), 0); },
    seekAt: qAt, seek: seekTo, snapAt, barStarts, barOfQ,
    get cueQ() { return cued ? cueQ : 0; },
    get dragging() { return !!drag; },
    // Edit notes: the orange line stays on show (at the start when nothing is cued), so it can be dragged
    keepBar(on) { keepBar = !!on; if (!player?.playing) place(cued ? cueQ : (player?.posQ || 0), false); },
    // the start one bar before bar bi (0-based; bar 1 stays on bar 1), the page not turned; → the 1-based bar
    cueBar(bi) { const s = barStarts(), k = Math.max(0, Math.min(s.length - 1, bi - 1)); player?.pause(); seekTo(s[k] || 0, { follow: false }); return k + 1; },
    // Stop: back to the start you picked; Stop again there (or with no start picked) = back to the beginning
    stop() {
      const at = player?.now() || 0, was = !!player?.playing;
      player?.stop();
      if (cued && cueQ > 0 && (was || Math.abs(at - cueQ) > 1e-6)) { seekTo(cueQ); return 'cue'; }
      cued = false; cueQ = 0; place(0);
      return 'start';
    },
    // paged: the page holding this element (an Edit notes selection); Mac: scrolled into view
    showEl(el) {
      if (!el) return;
      if (!paged || !pages.length) { el.scrollIntoView?.({ block: 'nearest' }); return; }
      const r = el.getBoundingClientRect(), y = (r.top + r.bottom) / 2 - sheet.getBoundingClientRect().top;
      const k = pageOfY(pages, y);
      if (k !== page) goPage(k);
    },
    get paged() { return paged; },
    destroy() { player.pause(); voice?.destroy(); ro.disconnect(); offSwipe(); ink?.destroy(); },
  };
}

// a sing job for this score that has not finished yet (the Mac's jobs carry the score as fromItemId)
const singing = (it) => store.jobs().some((j) => j.kind === 'sing' && j.fromItemId === it.id && ['queued', 'running'].includes(j.status));
// the score's ⋯ tools (actions.viewerMenu), built each time ⋯ is tapped. Edit notes (✎), Kids note names, Chords and
// Voice are toolbar buttons (shown on every width), so they are not here too. The singing voice needs lyrics; while its job runs it shows, greyed.
export function scoreTools(it, view) {
  const notes = [...(it.measures ? [{ label: 'Revert note edits', icon: 'restore', run: async () => { await view.revert(); document.querySelector('.editbar')?.dispatchEvent(new Event('close')); toast('Back to the original notes'); } }] : [])];
  const words = [...(view.real && /<lyric[\s>]/.test(view.xml()) ? [singing(it) ? { label: 'Singing voice in progress…', icon: 'voice', disabled: true, run: () => {} }
      : { label: it.vocalAudio ? 'Redo singing voice' : 'Request singing voice', icon: 'voice', run: () => makeItSing(it) }] : [])];
  return notes.length && words.length ? [...notes, '-', ...words] : [...notes, ...words];
}
// Export ▸ for a score: the notes as MusicXML or MIDI (as shown: edits and transposition), print / PDF
export function scoreExportMenu(it, view) {
  const name = `${it.title} - ${VERSIONS[view.version] || 'Score'}`;
  return [
    { label: 'MusicXML', icon: 'download', run: () => download(`${name}.musicxml`, view.xml(), 'application/vnd.recordare.musicxml+xml') },
    { label: 'MIDI', icon: 'download', run: () => download(`${name}.mid`, midiFile(view.pianoNotes, view.tune.bpm, it.transpose || 0), 'audio/midi') },
    printEntry(it.id),
  ];
}
// notes [{q: start in quarters, d: length, n: MIDI note, v: velocity}] → a Standard MIDI File (one track, piano)
export function midiFile(notes, bpm = 100, shift = 0) {
  const TPQ = 480, ev = [];
  for (const x of notes || []) {
    const n = Math.max(0, Math.min(127, Math.round(x.n + shift))), on = Math.round(x.q * TPQ), off = Math.max(on + 1, Math.round((x.q + x.d) * TPQ));
    ev.push([on, 1, [0x90, n, Math.max(1, Math.min(127, x.v || 80))]], [off, 0, [0x80, n, 0]]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);  // at the same tick: note-offs first
  const vlq = (v) => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
  const us = Math.round(60e6 / (bpm || 100));
  const trk = [...vlq(0), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, ...vlq(0), 0xc0, 0];
  let t = 0;
  for (const [at, , m] of ev) { trk.push(...vlq(at - t), ...m); t = at; }
  trk.push(...vlq(0), 0xff, 0x2f, 0);
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, TPQ >> 8, TPQ & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk])], { type: 'audio/midi' });
}

// the tempo pop-up (tap the number): type a tempo, back to the score's tempo, or tap the beat (4 taps or more)
function tempoPop(anchor, view, setT) {
  const old = document.querySelector('.tempo-pop');
  old?.remove();
  if (old?.dataset.for === 'sc') return; // a second tap on the number closes it
  const m = document.createElement('div');
  m.className = 'menu tempo-pop'; m.dataset.for = 'sc';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Tempo');
  m.innerHTML = `<form><label><span>Tempo</span><input type="number" inputmode="numeric" min="${TEMPO_MIN}" max="${TEMPO_MAX}" step="1" value="${view.tempo}" aria-label="Tempo in beats per minute"><span class="muted">bpm</span></label></form>
    <div class="tp-row"><button type="button" data-reset title="Back to the score's own tempo">↺ ${view.scoreTempo}</button><button type="button" data-tap title="Tap the beat, 4 times or more">Tap</button></div>
    <p class="muted small">${TEMPO_MIN}–${TEMPO_MAX}. Applies to Play, Edit notes and the voice.</p>`;
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left + r.width / 2 - mw / 2)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  const input = m.querySelector('input'), reset = m.querySelector('[data-reset]');
  const sync = () => { input.value = view.tempo; reset.disabled = view.tempo === view.scoreTempo; };
  const put = (v) => { if (+v > 0) setT(+v); sync(); };
  const close = () => { m.remove(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key, true); };
  const off = (e) => { if (!m.contains(e.target) && e.target !== anchor) { put(input.value); close(); } };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
  document.addEventListener('keydown', key, true);
  m.querySelector('form').onsubmit = (e) => { e.preventDefault(); put(input.value); close(); };
  input.onchange = () => put(input.value);
  reset.onclick = () => put(view.scoreTempo);
  let taps = [];
  m.querySelector('[data-tap]').onclick = () => {
    const t = performance.now();
    taps = [...taps.filter((x) => t - x < 2500), t].slice(-8);
    if (taps.length >= 4) put(Math.round(60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1))));
  };
  sync();
  if (!isTouch()) setTimeout(() => input.select(), 30);
}

export function scoreToolbar(bar, it, view) {
  // tempo in beats per minute, here only (no tempo mark is drawn on the score); the same for the voice
  window.__score = view; // for automated tests (the orange line shows where it is; there is no position bar)
  bar.innerHTML = `<div class="transport">
      <button class="icon-btn stop" id="sc-stop" aria-label="Stop" title="Stop: back to where you put the line; again: back to the beginning">${iconOn('stop')}</button>
      <button class="play" id="sc-play" aria-label="Play" title="Play (space)">${iconOn('play')}</button>
    </div>
    <span class="hands-slot" id="sc-hands"></span>
    <button class="check-badge" id="sc-check" hidden></button>
    <div class="stepper tempo" id="sc-tempo" role="group" aria-label="Tempo"><button id="sc-slow" aria-label="Slower" title="Slower (hold to keep going)">−</button><button id="sc-rate" class="bpm" aria-haspopup="dialog">${view.tempo}</button><button id="sc-fast" aria-label="Faster" title="Faster (hold to keep going)">+</button></div>
    <div class="stepper" aria-label="Transpose"><button id="sc-tdown" aria-label="Transpose down">♭</button><span id="sc-tval">${it.transpose ? (it.transpose > 0 ? '+' : '') + it.transpose : '0'}</span><button id="sc-tup" aria-label="Transpose up">♯</button></div>
    <div class="stepper zoom" aria-label="Zoom"><button id="sc-zout" aria-label="Zoom out" title="Zoom out (−)">${iconOn('zoomout')}</button><button id="sc-zreset" class="zreset" title="Reset zoom (0)">${Math.round(view.zoom * 100)}%</button><button id="sc-zin" aria-label="Zoom in" title="Zoom in (+)">${iconOn('zoomin')}</button></div>
    <button class="icon-btn" id="sc-edit" title="Edit notes" aria-label="Edit notes">${iconOn('edit')}</button>
    ${store.mode === 'server' && view.real ? `<button class="icon-btn" id="sc-simple" title="Simple piano: smooth rests and rhythm, main notes, hands…" aria-label="Simple piano">${iconOn('simplepiano')}</button>` : ''}
    <span class="tg-row">
    <button class="tg-btn ${chordsMode() !== 'off' ? 'on' : ''}" id="sc-chords" data-mode="${chordsMode()}" title="${MODE_LABEL[chordsMode()]}" aria-label="${MODE_LABEL[chordsMode()]}">${iconOn(CHORD_ICON[chordsMode()])}</button>
    <button class="tg-btn ${view.easy ? 'on' : ''}" id="sc-names" aria-pressed="${view.easy}" title="Kids note names: big noteheads with the note's letter" aria-label="Kids note names">${iconOn('baby')}</button>
    <button class="tg-btn ${view.chordPlay ? 'on' : ''}" id="sc-chordplay" aria-pressed="${view.chordPlay}" title="Play the chords too: the chord names above the bars on the piano" aria-label="Play chords"${view.hasChords && !view.voice ? '' : ' hidden'}>${iconOn('chordplay')}</button>
    <button class="tg-btn ${view.voice ? 'on' : ''}" id="sc-voice" aria-pressed="${view.voice}" title="Voice: hear it sung, at the tempo you set (off = piano only)" aria-label="Voice"${view.hasVoice ? '' : ' hidden'}>${iconOn('voice')}</button>
    </span>`;

  const p = () => view.player;
  const playBtn = $('#sc-play', bar);
  const setPlay = () => { const on = p().playing; playBtn.innerHTML = iconOn(on ? 'pause' : 'play'); playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play'); playBtn.title = on ? 'Pause (space)' : 'Play (space)'; };
  playBtn.onclick = async () => {
    if (p().playing) p().pause();
    else { const pr = p().play(); setPlay(); try { await pr; } catch { toast(view.voice ? 'Could not play the voice — tap Play again, or turn Voice off.' : 'No sound yet — tap Play again.'); } }
    setPlay();
  };
  $('#sc-stop', bar).onclick = () => { view.stop(); setPlay(); };
  const host = bar.closest('.viewer') || document;
  const onEnd = () => setPlay();
  host.addEventListener('ended', onEnd);
  host.addEventListener('playstate', onEnd); // Edit notes' ▶ From here played or paused
  // Voice: the sung audio follows the tempo (time-stretched, same pitch); it has its own key — a key change goes back to the piano
  const voiceBtn = $('#sc-voice', bar);
  const cpBtn = $('#sc-chordplay', bar);
  const cpl = () => { cpBtn.hidden = !view.hasChords || view.voice; cpBtn.classList.toggle('on', view.chordPlay); cpBtn.setAttribute('aria-pressed', String(view.chordPlay)); };
  cpBtn.onclick = () => { view.setChordPlay(!view.chordPlay); cpl(); };
  host.addEventListener('chordlistchange', cpl); // an edit added / took away chord names
  // Hands: L · Both · R (or a toggle per staff); not for the singing voice
  const handsSlot = $('#sc-hands', bar);
  const hl = () => { handsSlot.innerHTML = view.voice ? '' : handsHtml(view.staves, view.muted); };
  handsSlot.onclick = (e) => { const m = handsClick(e, view.staves, view.muted); if (m) view.setMuted(m); };
  host.addEventListener('handschange', hl); host.addEventListener('chordlistchange', hl); // chordlistchange: new notes (an edit may add a staff)
  hl();
  const vl = () => { cpl(); hl(); voiceBtn.hidden = !view.hasVoice; voiceBtn.classList.toggle('on', view.voice); voiceBtn.setAttribute('aria-pressed', String(view.voice)); tl(); setPlay(); };
  voiceBtn.onclick = async () => { const pr = view.setVoice(!view.voice); vl(); await pr; vl(); };
  const toPiano = (why) => { if (!view.voice) return; view.setVoice(false); vl(); toast(`${why} — back to the piano (the voice sings in its own key)`); };
  const onSung = (e) => { // "Make it sing" finished for this score: the Voice button shows (the piano stays the default)
    if (!(e.detail || []).includes(it.id)) return;
    setTimeout(() => { const f = store.get(it.id); if (!f?.vocalAudio) return; view.voiceReady({ vocalAudio: f.vocalAudio, vocalBpm: f.vocalBpm, updatedAt: f.updatedAt }); vl(); toast(view.voice ? 'It sings now — Voice is on' : 'It sings now — tap Voice to hear it'); }, 800);
  };
  addEventListener('meowsic-new-items', onSung);
  // tempo: − / + in steps of 5 (hold to repeat); tap the number to type it, go back to the score's tempo or tap the beat
  const tBox = $('#sc-tempo', bar), tNum = $('#sc-rate', bar);
  const tl = () => {
    const t = view.tempo, s0 = view.scoreTempo;
    tNum.textContent = t;
    tBox.classList.toggle('changed', t !== s0);
    tNum.setAttribute('aria-label', `Tempo ${t} beats per minute${t !== s0 ? ` (the score's is ${s0})` : ''}: tap to type`);
    tNum.title = `Tempo: ${t} beats per minute${t !== s0 ? ` (score: ${s0})` : ''} — tap to type, reset or tap the beat`;
    $('#sc-slow', bar).disabled = t <= TEMPO_MIN; $('#sc-fast', bar).disabled = t >= TEMPO_MAX;
  };
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = 0; store.update(it.id, { rate: it.rate }); };
  const setT = (bpm) => { view.setTempo(bpm); tl(); clearTimeout(saveT); saveT = setTimeout(save, 500); };
  const step = (d) => { const t = view.tempo; setT(d > 0 ? Math.floor(t / 5) * 5 + 5 : Math.ceil(t / 5) * 5 - 5); };
  for (const [id, d] of [['#sc-slow', -1], ['#sc-fast', 1]]) {
    const b = $(id, bar);
    let hold = 0;
    const end = () => { clearTimeout(hold); clearInterval(hold); hold = 0; };
    b.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || b.disabled) return;
      e.preventDefault(); step(d); end();
      hold = setTimeout(() => { hold = setInterval(() => (b.disabled ? end() : step(d)), 90); }, 420);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, end);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.onclick = (e) => { if (!e.detail) step(d); }; // the keyboard (Enter / Space); a pointer already stepped
  }
  tNum.onclick = () => tempoPop(tNum, view, setT);
  tl();
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
  const offCheck = checkBadge($('#sc-check', bar), view, it, viewer); // "N to check": bars the sheet reader was not sure of
  const offVoice = store.on(() => { if (voiceBtn.hidden === view.hasVoice) vl(); });  // a voice made elsewhere (another device): Voice shows on the next item refresh
  if (store.mode === 'server') store.refreshJobs().catch(() => {});  // a sing job still running (after a reload): ⋯ says so, and Voice appears when it is done
  return () => {
    if (saveT) save();
    document.querySelector('.tempo-pop')?.remove();
    offCheck(); offVoice();
    host.removeEventListener('ended', onEnd); host.removeEventListener('playstate', onEnd); host.removeEventListener('chordlistchange', cpl); host.removeEventListener('handschange', hl); host.removeEventListener('chordlistchange', hl); document.removeEventListener('keydown', onSpace); removeEventListener('meowsic-new-items', onSung);
    viewer?.removeEventListener('ukeclose', onUkeClose); viewer?.removeEventListener('uketoggle', onUkeToggle); uke?.destroy(); uke = null;
  };
}

// The old per-score Voice choice (`meowsic-voice-<id>`, where no key meant "on") is dropped once, so every score starts
// on the piano; `meowsic-voice-lang` (voice input) is a different setting and stays.
let oldVoiceKeysDropped = false;
function dropOldVoiceKeys() {
  if (oldVoiceKeysDropped) return;
  oldVoiceKeysDropped = true;
  try {
    const old = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('meowsic-voice-') && k !== 'meowsic-voice-lang') old.push(k); }
    old.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

// Request singing voice (the "sing" job): the Mac sings the melody with its lyrics (SoulX-Singer, offline) over a
// soft piano; the audio is saved with this score and the toolbar's Voice toggle (shown once it exists) plays it
async function makeItSing(it) {
  const again = !!it.vocalAudio;
  const ok = await confirmSheet({ title: `${again ? 'Redo the' : 'Request a'} singing voice for “${it.title}”?`, body: `The Mac sings the melody with its lyrics over a soft piano (about 2–3 minutes for a short song).${again ? ' The new voice replaces the one it has.' : ''} When it is done, tap the Voice button to hear it sung; Play stays on the piano until you do.`, ok: again ? 'Redo' : 'Request' });
  if (!ok) return;
  store.addJob({ kind: 'sing', title: it.title, source: 'Singing voice', output: 'Voice', outputs: ['voice'], fromItemId: it.id });
  toast('Singing… progress is in Add → Score');
}

