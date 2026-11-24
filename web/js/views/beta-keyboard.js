// Keyboard (beta): fix notes by playing on a USB MIDI keyboard (e.g. a small Yamaha PSS-A50 plugged into the Mac).
// Two steps: 1 Connect (device status, a live key light-up) · 2 Fix notes by playing: a practice editor on the
// first 8 bars of Home NDP's melody (m-b6xs990). It edits an in-memory copy only: nothing is ever written to the score.
//   Select   tap a note (score or strip), ← / →
//   Pitch    press a key: the selected note takes it (it sounds); the next key goes to the next note (toggle)
//   Length   buttons whole … 32nd (note glyphs, notevalue.js) · dot · tie; number keys 1 2 4 8 6 3 (3 = 32nd) and . ;
//            the lowest keyboard keys (C D E F G B = whole … 32nd, A = rest, C# = dot, D# = tie; start note configurable);
//            no dotted 32nd here (4.5 ticks: finer than TPQ; Edit notes has it);
//            "Hold to set length": how long a key is held at the hold tempo (60 BPM by default) picks the length:
//            switch points at the geometric midpoints between neighbours (dotted ones only with "Dotted lengths"),
//            minus a calibrated release latency, times a calibrated stretch (Calibrate: 4 quarter notes with clicks);
//            a live bar with 16th … whole ticks, the note it would pick and the beats so far; optional quiet clicks
//   Bars always add up: shorter → a rest fills the gap (or the next notes move earlier); longer → borrows from the
//   notes / rests after it in the bar, refused when it would cross the bar line.
//   Rest (button, R / Delete, MIDI key) · Undo / Redo · Reset · Play these bars.
// Input: Web MIDI (Chrome on the Mac). iPad / iPhone Safari has no Web MIDI: the on-screen keys or the computer
// keyboard (A S D F … white, W E T Y U … black, Z / X octave) stand in. Settings are remembered per device (localStorage, guarded).
import { pianoKey, audioCtx, loadPiano, ScorePlayer } from '../audio.js';
// Timing for "Hold to set length": every press / release time is the event's own timeStamp (MIDIMessageEvent,
// PointerEvent, KeyboardEvent: all on the performance.now() clock), never Date.now() or a timer callback.
import { esc } from '../ui.js';
import { noteIcon } from '../notevalue.js';
import { pcName, noteName, now, evT, midi, askMidi, inputsOf, readMidi, TPQ, FN_KEYS, FN_BASES, fnLabel, HOLD_PLAIN, HOLD_DOTS,
  holdThresholds, pickLen, CAL_DEFAULT, loadCal, saveCal, holdBeats, calibrate } from '../midi.js';
export { TPQ, holdThresholds, pickLen, CAL_DEFAULT, loadCal, holdBeats, calibrate };

const SONG_ID = 'm-b6xs990';
const BARS = 8; // the excerpt: bars 1–8
const LS = 'meowsic-beta-keyboard';
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isWhite = (m) => WHITE.includes(((m % 12) + 12) % 12);

function loadSettings() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function saveSettings(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} }

function ensureCss() {
  if (document.querySelector('link[data-beta-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = new URL('../../css/beta.css', import.meta.url).href; l.dataset.betaCss = '';
  document.head.append(l);
}

// ---------- the song: MusicXML → melody (top staff, top note, ties joined) ----------
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseSong(text, bars = BARS) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const part = doc.querySelector('part');
  if (!part || doc.querySelector('parsererror')) throw new Error('Could not read the score');
  const title = (doc.querySelector('work-title') || doc.querySelector('movement-title'))?.textContent.trim() || 'the song';
  let div = 1, beats = 4, beatType = 4, fifths = null, tempo = 0, barQ = 0;
  const raw = [], barList = [];
  const measures = [...part.querySelectorAll(':scope > measure')].slice(0, bars);
  for (const [bi, m] of measures.entries()) {
    const at = m.querySelector(':scope > attributes');
    if (at) {
      const dv = at.querySelector('divisions'); if (dv) div = +dv.textContent || 1;
      const b = at.querySelector('time > beats'), bt = at.querySelector('time > beat-type');
      if (b) { beats = +b.textContent; beatType = +(bt?.textContent || 4); }
      const f = at.querySelector('key > fifths'); if (f && fifths === null) fifths = +f.textContent;
    }
    if (!tempo) { const s = m.querySelector('sound[tempo]'); if (s) tempo = +s.getAttribute('tempo'); }
    const len = (beats * 4) / beatType;
    barList.push({ i: bi, q0: barQ, len, meter: [beats, beatType] });
    let t = 0, onset = 0;
    for (const e of m.children) {
      const dur = +(e.querySelector(':scope > duration')?.textContent || 0) / div;
      if (e.tagName === 'backup') { t -= dur; continue; }
      if (e.tagName === 'forward') { t += dur; continue; }
      if (e.tagName !== 'note' || e.querySelector(':scope > grace') || e.querySelector(':scope > cue')) continue;
      if (e.querySelector(':scope > chord')) { /* same onset as the note before */ } else { onset = t; t += dur; }
      const p = e.querySelector(':scope > pitch');
      if (!p) continue; // a rest
      const staff = +(e.querySelector(':scope > staff')?.textContent || 1);
      if (staff !== 1) continue;
      const midi = 12 * (+p.querySelector('octave').textContent + 1) + STEP_PC[p.querySelector('step').textContent.trim()] + Math.round(+(p.querySelector('alter')?.textContent || 0));
      const q = barQ + onset;
      if (e.querySelector(':scope > tie[type="stop"]')) {
        const prev = raw.slice(-12).reverse().find((x) => x.midi === midi && Math.abs(x.q + x.d - q) < 1e-3);
        if (prev) { prev.d += dur; continue; }
      }
      raw.push({ midi, q, d: dur, bar: bi });
    }
    barQ += len;
  }
  const g = new Map();
  for (const n of raw) { const k = Math.round(n.q * 1000); if (!g.has(k)) g.set(k, []); g.get(k).push(n); }
  const mel = [...g.values()].sort((a, b) => a[0].q - b[0].q).map((x) => { const top = x.reduce((a, b) => (b.midi > a.midi ? b : a)); return { midi: top.midi, q: top.q, d: top.d, bar: top.bar }; });
  mel.forEach((n, i) => { const nx = mel[i + 1]; n.d = Math.min(n.d, (nx ? nx.q : barQ) - n.q); });
  return { title, tempo: tempo || 100, meter: [beats, beatType], fifths: fifths ?? 0, bars: barList, mel, end: barQ };
}

// when the Mac is away (preview / offline) the editor still works with a short public-domain tune
function fallbackSong() {
  const tune = [[60, 60, 67, 67], [69, 69, 67], [65, 65, 64, 64], [62, 62, 60], [67, 67, 65, 65], [64, 64, 62], [67, 67, 65, 65], [64, 64, 62]];
  const mel = [], bars = [];
  tune.forEach((bar, bi) => {
    bars.push({ i: bi, q0: bi * 4, len: 4, meter: [4, 4] });
    bar.forEach((m, k) => mel.push({ midi: m + 12, q: bi * 4 + k, d: bar.length === 3 && k === 2 ? 2 : 1, bar: bi }));
  });
  return { title: 'Twinkle Twinkle', tempo: 100, meter: [4, 4], fifths: 0, bars, mel, end: 32, fallback: true };
}

async function fetchSong() {
  if (new URLSearchParams(location.search).has('preview')) return fallbackSong(); // UI preview: no Mac, no real song
  try {
    const r = await fetch(`/api/items/${SONG_ID}/musicxml`);
    if (!r.ok) throw new Error(String(r.status));
    const s = parseSong(await r.text());
    if (!s.mel.length) throw new Error('no notes');
    return s;
  } catch { return fallbackSong(); }
}

// ---------- the in-memory melody: bars of items { m: midi | null (rest), t: ticks, tie } ----------
// TPQ (midi.js) = 24 ticks per quarter: 1/16 = 6, dotted 1/16 = 9, triplet 1/8 = 8
const LEN = { 1: 96, 2: 48, 4: 24, 8: 12, 6: 6, 3: 3 }; // number key → ticks (6 = sixteenth, 3 = thirty-second)
const PLAIN = [96, 48, 24, 12, 6, 3], DOTTED = [144, 72, 36, 18, 9]; // (no dotted 32nd: 4.5 ticks)
const LEN_NAME = { 144: 'dotted whole', 96: 'whole (1)', 72: 'dotted half', 48: 'half (1/2)', 36: 'dotted quarter', 24: 'quarter (1/4)', 18: 'dotted 1/8', 12: 'eighth (1/8)', 9: 'dotted 1/16', 6: 'sixteenth (1/16)', 3: 'thirty-second (1/32)' };
export const lenName = (t) => LEN_NAME[t] || `${+(t / TPQ).toFixed(2)} beats`;
// a length's glyph (note or rest; dotted too), else its number of beats as text
const lenGlyph = (t, rest = false) => noteIcon(t / TPQ, { rest, cls: 'bk-ic' });
const clone = (bars) => bars.map((b) => ({ len: b.len, items: b.items.map((x) => ({ ...x })) }));
const starts = (bar) => { let p = 0; return bar.items.map((x) => { const s = p; p += x.t; return s; }); };

export function barsFromSong(song) {
  return song.bars.map((b) => {
    const a = Math.round(b.q0 * TPQ), len = Math.round(b.len * TPQ), z = a + len, items = [];
    let cur = a;
    for (const n of song.mel) {
      const s = Math.round(n.q * TPQ), e = Math.round((n.q + n.d) * TPQ);
      if (e <= a || s >= z || e <= s) continue;
      const s2 = Math.max(s, cur), e2 = Math.min(e, z);
      if (e2 <= s2) continue;
      if (s2 > cur) items.push({ m: null, t: s2 - cur });
      items.push({ m: n.midi, t: e2 - s2, tie: e > z });
      cur = e2;
    }
    if (cur < z) items.push({ m: null, t: z - cur });
    return normalizeBar({ len, items });
  });
}

// LOCAL normalizeBar (beta only). TODO: swap for scoremodel.js normalizeBar once the Edit notes work is merged.
// Rests next to each other are joined, then split again into the pieces a copyist would write: each rest
// piece starts on a multiple of its own length (no half rest on beat 2 of 4/4), whole rest only for an empty bar.
export function normalizeBar(bar) {
  const out = [];
  for (const x of bar.items) {
    if (x.t <= 0) continue;
    const last = out[out.length - 1];
    if (x.m == null && last && last.m == null) last.t += x.t; else out.push({ ...x, tie: x.m == null ? false : !!x.tie });
  }
  if (out.length === 1 && out[0].m == null) return { len: bar.len, items: [{ m: null, t: bar.len }] };
  const items = [];
  let p = 0;
  for (const x of out) {
    if (x.m != null) { items.push(x); p += x.t; continue; }
    let left = x.t;
    while (left > 0) {
      const v = [48, 24, 12, 6, 3].find((v) => v <= left && p % v === 0) || Math.min(left, 3);
      items.push({ m: null, t: v }); p += v; left -= v;
    }
  }
  return { len: bar.len, items };
}

// a tie only means something between two notes of the same pitch
function fixTies(bars) {
  const flat = bars.flatMap((b) => b.items);
  flat.forEach((x, k) => { if (x.tie && (x.m == null || flat[k + 1]?.m !== x.m)) x.tie = false; });
}

// change one item's length; the bar keeps adding up. Returns { ok, bars, msg }
export function setLength(bars0, bi, i, t, { pull = false } = {}) {
  const bars = clone(bars0), bar = bars[bi], x = bar.items[i];
  if (!x) return { ok: false, msg: 'Pick a note first.' };
  const old = x.t, what = x.m == null ? 'rest' : 'note';
  if (t === old) return { ok: true, bars, same: true, msg: `It is already a ${lenName(t)} ${what}.` };
  if (t < old) {
    const gap = old - t;
    x.t = t;
    if (pull) bar.items.push({ m: null, t: gap }); else bar.items.splice(i + 1, 0, { m: null, t: gap });
    bars[bi] = normalizeBar(bar); fixTies(bars);
    return { ok: true, bars, shortened: true, msg: pull ? `Now a ${lenName(t)} ${what}; the next notes moved earlier, a rest fills the end of the bar.` : `Now a ${lenName(t)} ${what}; a ${lenName(gap)} rest fills the gap.` };
  }
  const need = t - old, after = bar.items.slice(i + 1).reduce((a, y) => a + y.t, 0);
  if (after < need) {
    return { ok: false, msg: `A ${lenName(t)} ${what} doesn’t fit: only ${lenName(after + old)} is left before the end of bar ${bi + 1}. Shorten something after it first.` };
  }
  let left = need, took = [];
  x.t = t;
  while (left > 0) {
    const y = bar.items[i + 1];
    if (y.t <= left) { left -= y.t; took.push(y.m == null ? 'a rest' : noteName(y.m)); bar.items.splice(i + 1, 1); }
    else { y.t -= left; took.push((y.m == null ? 'the rest' : noteName(y.m)) + ' (shorter)'); left = 0; }
  }
  bars[bi] = normalizeBar(bar); fixTies(bars);
  return { ok: true, bars, msg: `Now a ${lenName(t)} ${what}; it took the time from ${took.join(', ')}.` };
}

export function toRest(bars0, bi, i) {
  const bars = clone(bars0), x = bars[bi].items[i];
  if (!x || x.m == null) return { ok: false, msg: 'That is already a rest.' };
  const was = x.m; x.m = null; x.tie = false;
  bars[bi] = normalizeBar(bars[bi]); fixTies(bars);
  return { ok: true, bars, msg: `${noteName(was)} is now a ${lenName(x.t)} rest.` };
}

// the item at a given time in the bar (after an edit re-shaped it)
const itemAt = (bar, pos) => { const s = starts(bar); let k = s.findIndex((a, j) => pos >= a && pos < a + bar.items[j].t); return k < 0 ? bar.items.length - 1 : k; };

// ---------- the copy → MusicXML for OSMD: one staff; odd lengths drawn as tied pieces ----------
const SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const TYPES = [[96, 'whole', 0], [72, 'half', 1], [48, 'half', 0], [36, 'quarter', 1], [24, 'quarter', 0], [18, 'eighth', 1], [12, 'eighth', 0], [9, '16th', 1], [6, '16th', 0], [3, '32nd', 0]];
export function barsXml(bars, { meter = [4, 4], fifths = 0 } = {}) {
  const all = bars.flatMap((b) => b.items).filter((x) => x.m != null).map((x) => x.m);
  const bass = all.length && all.reduce((s, x) => s + x, 0) / all.length < 57;
  const spell = fifths < 0 ? FLAT : SHARP;
  const flat = bars.flatMap((b) => b.items);
  let k = 0, xml = '';
  bars.forEach((bar, bi) => {
    xml += `<measure number="${bi + 1}">`;
    if (!bi) xml += `<attributes><divisions>${TPQ}</divisions><key><fifths>${fifths}</fifths></key><time><beats>${meter[0]}</beats><beat-type>${meter[1]}</beat-type></time><clef><sign>${bass ? 'F' : 'G'}</sign><line>${bass ? 4 : 2}</line></clef></attributes>`;
    for (const x of bar.items) {
      const prev = flat[k - 1], tiedIn = prev?.tie && prev.m === x.m && x.m != null;
      k++;
      if (x.m == null && x.t === bar.len && bar.items.length === 1) { xml += `<note><rest measure="yes"/><duration>${x.t}</duration><voice>1</voice></note>`; continue; }
      let left = x.t, first = true;
      while (left > 0) {
        const [len, type, dot] = TYPES.find(([l]) => l <= left) || [left, '32nd', 0];
        left -= len;
        if (x.m == null) xml += `<note><rest/><duration>${len}</duration><voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}</note>`;
        else {
          const [step, alter] = spell[x.m % 12];
          const stop = !first || tiedIn, start = left > 0 || x.tie;
          const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
          const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '');
          xml += `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(x.m / 12) - 1}</octave></pitch><duration>${len}</duration>${ties}<voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}${tied ? `<notations>${tied}</notations>` : ''}</note>`;
        }
        first = false;
      }
    }
    xml += '</measure>';
  });
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name></part-name></score-part></part-list><part id="P1">${xml}</part></score-partwise>`;
}

// the copy → notes for the player (quarters); tied notes sound as one
function barsNotes(bars) {
  const out = [];
  let q = 0, hold = null;
  for (const b of bars) for (const x of b.items) {
    const d = x.t / TPQ;
    if (x.m != null) {
      if (hold && hold.n === x.m) hold.d += d; else { hold = { n: x.m, q, d, v: 90 }; out.push(hold); }
      if (!x.tie) hold = null;
    } else hold = null;
    q += d;
  }
  return out;
}

let osmdReady;
function loadOsmd() {
  if (window.opensheetmusicdisplay) return Promise.resolve();
  return (osmdReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/osmd.min.js', import.meta.url).href;
    s.onload = ok; s.onerror = () => { osmdReady = null; fail(new Error('no OSMD')); };
    document.head.append(s);
  }));
}

// note-value icons (notevalue.js: drawn, so they look the same on every device)
const ICON = (t) => lenGlyph(t);
const REST_IC = lenGlyph(24, true);

// ---------- the on-screen piano ----------
function makePiano(host, emit) {
  let lo = 48, hi = 84, fn = new Map();
  const lit = new Map(); // class → Set(midi)
  const build = () => {
    const whites = []; for (let m = lo; m <= hi; m++) if (isWhite(m)) whites.push(m);
    const w = 100 / whites.length;
    let html = '';
    whites.forEach((m, i) => { html += `<div class="bk-key white" data-m="${m}" style="left:${i * w}%;width:${w}%"><i class="bk-fn"></i><span class="bk-lbl">${pcName(m) === 'C' ? noteName(m) : pcName(m)}</span><kbd></kbd></div>`; });
    for (let m = lo; m <= hi; m++) if (!isWhite(m)) {
      const i = whites.indexOf(m - 1);
      html += `<div class="bk-key black" data-m="${m}" style="left:${(i + 1) * w - w * 0.31}%;width:${w * 0.62}%"><i class="bk-fn"></i><kbd></kbd></div>`;
    }
    host.innerHTML = `<div class="bk-keys">${html}</div>`;
    for (const [cls, set] of lit) for (const m of set) keyEl(m)?.classList.add(cls);
    paintFn();
  };
  const fold = (m) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };
  const keyEl = (m) => host.querySelector(`.bk-key[data-m="${fold(m)}"]`);
  const light = (m, cls, on = true) => {
    if (!lit.has(cls)) lit.set(cls, new Set());
    const f = fold(m);
    if (on) lit.get(cls).add(f); else lit.get(cls).delete(f);
    keyEl(f)?.classList.toggle(cls, on || [...lit.get(cls)].includes(f));
  };
  const clear = (cls) => { for (const m of lit.get(cls) || []) keyEl(m)?.classList.remove(cls); lit.delete(cls); };
  const labels = (map) => { host.querySelectorAll('.bk-key kbd').forEach((k) => { k.textContent = map.get(+k.parentElement.dataset.m) || ''; }); };
  // function keys (the length keys): marked and labelled only where they really are (no octave folding)
  const paintFn = () => host.querySelectorAll('.bk-key').forEach((k) => { const t = fn.get(+k.dataset.m); k.classList.toggle('fn', !!t); k.querySelector('.bk-fn').innerHTML = t || ''; });
  const setFn = (map) => { fn = map; paintFn(); };
  const setRange = (a, b) => { if (a === lo && b === hi) return; lo = a; hi = b; build(); };
  // touch / mouse: a press sounds until the finger lifts. The pressed key captures the pointer, so sliding off it
  // (or off the piano) neither ends the note nor starts another; the release time is pointerup's own timeStamp.
  const down = new Map();
  host.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.bk-key'); if (!k || down.has(e.pointerId)) return;
    if (e.button > 0) return;
    e.preventDefault();
    try { k.setPointerCapture(e.pointerId); } catch {}
    const m = +k.dataset.m; down.set(e.pointerId, m);
    emit({ type: 'on', midi: m, vel: 96, t: evT(e), src: 'screen' });
  });
  const up = (e) => { const m = down.get(e.pointerId); if (m == null) return; down.delete(e.pointerId); emit({ type: 'off', midi: m, vel: 0, t: evT(e), src: 'screen' }); };
  host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
  // a backstop when capture isn't available: a release anywhere on the page still ends the note (once)
  addEventListener('pointerup', up); addEventListener('pointercancel', up);
  host.addEventListener('contextmenu', (e) => e.preventDefault());
  build();
  const destroy = () => { removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  return { light, clear, fold, labels, setFn, setRange, destroy, get range() { return [lo, hi]; } };
}

// the computer keyboard: one row of white keys, the row above for black keys, Z / X = octave down / up
const CODES = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
const CODE_LABEL = (c) => ({ Semicolon: ';', Quote: "'" }[c] || c.slice(3));
const typing = (t) => t && (t.isContentEditable || (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range' && t.type !== 'radio'));

// ---------- Web MIDI: midi.js (access kept for the page's life, shared between visits) ----------

const STEPS = [
  { id: 'connect', title: 'Connect', intro: 'Plug the keyboard into the Mac with USB, switch it on, then press any key: it lights up below.' },
  { id: 'fix', title: 'Fix notes by playing', intro: 'Pick a note, play the right key, set its length. A practice copy: nothing is saved to the score.' },
];

export function render(el, _ctx = {}) {
  ensureCss();
  const st = Object.assign({ step: 0, done: [], sound: true, base: 60, tempo: 80, holdTempo: 60, holdDot: false, holdClick: false, auto: true, hold: false, fnOn: true, fnBase: 48, pull: false }, loadSettings());
  st.step = Math.max(0, Math.min(STEPS.length - 1, +st.step || 0));
  const persist = () => saveSettings(st);
  const subs = new Set();
  const on = (f) => { subs.add(f); return () => subs.delete(f); };
  const held = new Map(); // midi → release()
  let stepCleanup = null, alive = true, silent = () => false;
  const songP = fetchSong();

  el.innerHTML = `
    <header class="top"><h1>Keyboard (beta)</h1><span class="bk-badge">BETA</span></header>
    <div class="pad bk">
      <section class="card bk-conn" id="bk-conn" aria-live="polite"></section>
      <section class="card bk-step" id="bk-step">
        <div class="bk-tabs" id="bk-dots" role="tablist">${STEPS.map((s, i) => `<button type="button" class="bk-dot" role="tab" data-i="${i}"><span>${i + 1}</span> ${s.title}</button>`).join('')}</div>
        <h2 id="bk-title"></h2>
        <p class="bk-intro" id="bk-intro"></p>
        <div id="bk-live" class="bk-live"></div>
      </section>
      <div class="bk-dock">
        <div class="bk-opts">
          <label class="bk-tg"><input type="checkbox" id="bk-sound"${st.sound ? ' checked' : ''}><span>App sound</span></label>
          <span class="bk-oct muted small" id="bk-oct"></span>
        </div>
        <div class="bk-piano" id="bk-piano"></div>
      </div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  // ----- input bus: MIDI, on-screen keys and the computer keyboard all end up here -----
  const emit = (e) => {
    if (!alive) return;
    if (e.type === 'on') {
      held.get(e.midi)?.();
      let rel = null;
      if (st.sound && !silent(e.midi)) { try { rel = pianoKey(e.midi, e.vel || 90); } catch {} }
      held.set(e.midi, rel || (() => {}));
      piano.light(e.midi, 'down', true);
    } else {
      held.get(e.midi)?.(); held.delete(e.midi);
      piano.light(e.midi, 'down', false);
    }
    for (const f of [...subs]) f(e);
  };
  const piano = makePiano($('#bk-piano'), emit);
  const fitRange = () => { const w = $('#bk-piano').clientWidth || el.clientWidth; piano.setRange(w && w < 620 ? 60 : 48, 84); keyLabels(); };

  // computer keyboard
  const keyDown = new Map();
  const keyLabels = () => {
    const map = new Map();
    for (const [code, off] of Object.entries(CODES)) map.set(piano.fold(st.base + off), CODE_LABEL(code));
    piano.labels(map);
    $('#bk-oct').textContent = `Computer keys: A = ${noteName(st.base)} · Z / X octave`;
  };
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (e.type === 'keydown') {
      if (e.code === 'KeyZ' || e.code === 'KeyX') { if (!e.repeat) { st.base = Math.max(36, Math.min(84, st.base + (e.code === 'KeyZ' ? -12 : 12))); persist(); keyLabels(); } e.preventDefault(); return; }
      if (!(e.code in CODES)) return;
      e.preventDefault();
      if (e.repeat || keyDown.has(e.code)) return; // auto-repeat never restarts (or ends) a held key
      const m = st.base + CODES[e.code]; keyDown.set(e.code, m);
      emit({ type: 'on', midi: m, vel: 90, t: evT(e), src: 'keys' });
    } else if (keyDown.has(e.code)) {
      const m = keyDown.get(e.code); keyDown.delete(e.code);
      emit({ type: 'off', midi: m, vel: 0, t: evT(e), src: 'keys' });
    }
  };
  addEventListener('keydown', onKey); addEventListener('keyup', onKey);
  const onBlur = (e) => { for (const [code, m] of keyDown) { keyDown.delete(code); emit({ type: 'off', midi: m, vel: 0, t: evT(e), src: 'keys' }); } };
  addEventListener('blur', onBlur);

  // MIDI
  const attached = new Set();
  const onMidi = (e) => { const x = readMidi(e); if (x) emit(x); };
  const attach = () => {
    for (const inp of inputsOf()) if (!attached.has(inp)) {
      inp.addEventListener('midimessage', onMidi);
      try { inp.open?.()?.catch?.(() => {}); } catch {}
      attached.add(inp);
    }
    drawConn();
  };
  const onState = () => attach();
  const connect = async () => {
    try { audioCtx(); loadPiano(); } catch {} // inside the tap: wakes the sound
    drawConn(); await askMidi();
    if (!alive) return;
    if (midi.access) { midi.access.addEventListener?.('statechange', onState); attach(); } else drawConn();
  };
  function drawConn() {
    const box = $('#bk-conn'), names = inputsOf().map((i) => i.name || 'MIDI keyboard');
    const fallback = '<p class="muted small bk-fb">No keyboard? Use the on-screen keys at the bottom, or the computer keys: <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> … white keys, <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> … black keys.</p>';
    let html;
    if (midi.status === 'unsupported') html = `<div class="bk-state warn"><b>This browser can’t use a USB keyboard.</b> iPad and iPhone Safari have no Web MIDI: use the on-screen keys. For your Yamaha, plug it into the Mac and open Meowsic in Chrome.</div>`;
    else if (midi.status === 'idle') html = `<div class="bk-state"><span>Plug the keyboard into the Mac with USB and switch it on.</span><button type="button" class="primary" id="bk-connect">Connect keyboard</button></div>`;
    else if (midi.status === 'asking') html = `<div class="bk-state"><span>Chrome asks to use MIDI devices: choose <b>Allow</b>.</span></div>`;
    else if (midi.status === 'denied') html = `<div class="bk-state bad"><span><b>MIDI is blocked.</b> Click the icon left of the web address, allow <b>MIDI devices</b>, then try again.</span><button type="button" id="bk-connect">Try again</button></div>`;
    else if (midi.status === 'error') html = `<div class="bk-state bad"><span><b>Couldn’t open MIDI.</b> ${esc(midi.error)}</span><button type="button" id="bk-connect">Try again</button></div>`;
    else if (!names.length) html = `<div class="bk-state warn"><span><b>No keyboard found.</b> Check the USB cable and that the keyboard is on. It shows up here by itself.</span></div>`;
    else html = `<div class="bk-state ok"><span class="bk-led"></span><span id="bk-dev">Connected: <b>${names.map(esc).join(', ')}</b></span></div>`;
    box.innerHTML = html + (midi.status === 'ok' && names.length ? '' : fallback);
    box.querySelector('#bk-connect')?.addEventListener('click', connect);
  }
  drawConn();
  // Chrome remembers an allowed site: connect straight away then
  try { navigator.permissions?.query({ name: 'midi' }).then((p) => { if (alive && p.state === 'granted' && midi.status !== 'ok') connect(); }).catch(() => {}); } catch {}
  if (midi.access) { midi.status = 'ok'; midi.access.addEventListener?.('statechange', onState); attach(); }

  $('#bk-sound').onchange = (e) => { st.sound = e.target.checked; persist(); if (st.sound) { try { audioCtx(); loadPiano(); } catch {} } };
  const onResize = () => fitRange();
  addEventListener('resize', onResize);
  fitRange();

  // ----- the two steps -----
  const markDone = (id) => { if (!st.done.includes(id)) { st.done.push(id); persist(); drawDots(); } };
  function drawDots() {
    el.querySelectorAll('.bk-dot').forEach((d, i) => { d.classList.toggle('on', i === st.step); d.classList.toggle('done', st.done.includes(STEPS[i].id)); d.setAttribute('aria-selected', String(i === st.step)); });
  }
  const api = { on, piano, st, persist, songP, markDone, el, isAlive: () => alive, setSilent: (f) => { silent = f || (() => false); } };
  function show(i) {
    if (typeof stepCleanup === 'function') { try { stepCleanup(); } catch {} }
    stepCleanup = null; silent = () => false; piano.setFn(new Map());
    st.step = Math.max(0, Math.min(STEPS.length - 1, i)); persist();
    const s = STEPS[st.step];
    $('#bk-step').dataset.step = s.id;
    $('#bk-title').textContent = `${st.step + 1} · ${s.title}`;
    $('#bk-intro').textContent = s.intro;
    const live = $('#bk-live'); live.innerHTML = '';
    stepCleanup = MOUNT[s.id](live, api, show);
    drawDots();
  }
  $('#bk-dots').onclick = (e) => { const d = e.target.closest('.bk-dot'); if (d) show(+d.dataset.i); };
  show(st.step);

  return () => {
    alive = false;
    if (typeof stepCleanup === 'function') { try { stepCleanup(); } catch {} }
    removeEventListener('keydown', onKey); removeEventListener('keyup', onKey); removeEventListener('blur', onBlur); removeEventListener('resize', onResize);
    for (const inp of attached) inp.removeEventListener('midimessage', onMidi);
    midi.access?.removeEventListener?.('statechange', onState);
    for (const r of held.values()) r(); held.clear();
    piano.destroy();
  };
}
export default render;

// ---------- the steps (each returns its clean-up) ----------
// the lowest keys as length keys, from a C: C D E F G B = whole … 32nd, A = rest, C# = dot, D# = tie
// FN_KEYS / FN_BASES: midi.js
// ---------- hold to set length (thresholds, calibration: midi.js) ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// a quiet metronome tick at audio time `when`; returns a stopper
function softClick(when, accent = false, gain = 0.07) {
  try {
    const c = audioCtx(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1500 : 1100;
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(accent ? gain * 1.6 : gain, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(c.destination); o.start(when); o.stop(when + 0.07);
    return () => { try { o.stop(); } catch {} };
  } catch { return () => {}; }
}
// ticks at beat k of a hold that started at performance time t0 (ms): audio clock = now + (t0 + k·beat − now)
function clicksFrom(t0, beatMs, count, { from = 1, gain, accentEvery = 0 } = {}) {
  let stops = [];
  try {
    const c = audioCtx(), base = c.currentTime - now() / 1000;
    for (let k = from; k < from + count; k++) { const w = base + (t0 + k * beatMs) / 1000; if (w >= c.currentTime) stops.push(softClick(w, accentEvery && k % accentEvery === 0, gain)); }
  } catch {}
  return () => { stops.forEach((f) => f()); stops = []; };
}
// the progress bar's scale: log time from 1/32 to past a whole note, so every tick has room
const BAR_LO = 0.125, BAR_HI = 5.2;
const barPos = (beats) => clamp(Math.log(Math.max(beats, 1e-3) / BAR_LO) / Math.log(BAR_HI / BAR_LO), 0, 1) * 100;
const TICKS = [6, 12, 24, 48, 96];
const ICON_ANY = (t) => lenGlyph(t);

const MOUNT = {
  connect(live, { on, markDone }, show) {
    live.innerHTML = `
      <div class="bk-big" id="bk-last"><b>—</b><span class="muted">Press any key</span></div>
      <div class="bk-row"><button type="button" class="primary" id="bk-go">Next: Fix notes by playing ›</button></div>`;
    live.querySelector('#bk-go').onclick = () => show(1);
    const SRC = { midi: 'from the keyboard', screen: 'on-screen key', keys: 'computer key' };
    return on((e) => {
      if (e.type !== 'on') return;
      live.querySelector('#bk-last').innerHTML = `<b>${noteName(e.midi)}</b><span class="muted">velocity ${e.vel} · ${SRC[e.src] || ''}</span>`;
      markDone('connect');
    });
  },

  fix(live, { on, piano, st, persist, songP, markDone, isAlive, setSilent }) {
    live.innerHTML = '<p class="muted">Loading the song…</p>';
    let offAll = () => {};
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      offAll = fixEditor(live, song, { on, piano, st, persist, markDone, setSilent });
    });
    return () => offAll();
  },
};

function fixEditor(live, song, { on, piano, st, persist, markDone, setSilent }) {
  const orig = barsFromSong(song);
  let bars = clone(orig), sel = firstNote(bars), armed = false, hist = [], fut = [], lastShorten = null, player = null, hold = null;
  const did = new Set();
  const title = song.fallback ? song.title : 'Home NDP';
  live.innerHTML = `
    ${song.fallback ? `<p class="bk-info warn">Home NDP needs the Mac. Practising <b>${esc(song.title)}</b> meanwhile.</p>` : ''}
    <div class="bk-tips" id="bk-tips">
      <div class="bk-tipc" data-k="select"><b>1</b><span><b>Select</b> a note: tap it, or <kbd>←</kbd> <kbd>→</kbd>.</span></div>
      <div class="bk-tipc" data-k="pitch"><b>2</b><span><b>Play</b> the right key. The note takes it; the next key goes to the next note.</span></div>
      <div class="bk-tipc" data-k="length"><b>3</b><span><b>Length</b>: a button, keys <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> <kbd>8</kbd> <kbd>6</kbd> <kbd>3</kbd> <kbd>.</kbd>, or the low length keys.</span></div>
      <div class="bk-tipc" data-k="play"><b>4</b><span><b>Play these bars</b> to hear it. <b>Reset</b> brings the original back.</span></div>
    </div>
    <div class="bk-row bk-toolbar"><b>${esc(title)} · bars 1–${bars.length} · melody</b><span class="bk-chip bk-copy">Practice copy · not saved</span><span class="bk-grow"></span>
      <button type="button" id="bk-undo" title="Undo (⌘Z)">↶ Undo</button><button type="button" id="bk-redo" title="Redo (⇧⌘Z)">↷ Redo</button>
      <button type="button" id="bk-reset">Reset</button><button type="button" class="primary" id="bk-play">▶ Play these bars</button></div>
    <div class="bk-osmd" id="bk-osmd"></div>
    <div class="bk-strip2" id="bk-strip"></div>
    <div class="bk-lens" id="bk-lens" role="toolbar" aria-label="Note length">
      ${PLAIN.map((t) => `<button type="button" class="bk-len" data-t="${t}" title="${lenName(t)} · key ${Object.keys(LEN).find((k) => LEN[k] === t)}" aria-label="${lenName(t)}">${ICON(t)}<kbd>${Object.keys(LEN).find((k) => LEN[k] === t)}</kbd></button>`).join('')}
      <button type="button" class="bk-len" id="bk-dot" title="Dot: half as long again · key .">${lenGlyph(36)}<span>Dot</span><kbd>.</kbd></button>
      <button type="button" class="bk-len" id="bk-tie" title="Tie to the next note"><svg class="bk-ic" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 12c4 6 14 6 18 0" stroke="currentColor" stroke-width="1.8" fill="none"/></svg><span>Tie</span></button>
      <button type="button" class="bk-len" id="bk-rest" title="Make it a rest · key R or Delete">${REST_IC}<span>Rest</span><kbd>R</kbd></button>
    </div>
    <p class="bk-msg" id="bk-msg" aria-live="polite"></p>
    <details class="bk-more" id="bk-more" open>
      <summary>Options</summary>
      <div class="bk-row">
        <label class="bk-tg"><input type="checkbox" id="bk-auto"${st.auto ? ' checked' : ''}><span>Next key goes to the next note</span></label>
        <label class="bk-tg"><input type="checkbox" id="bk-pull"${st.pull ? ' checked' : ''}><span>Shorter: pull the next notes earlier (instead of a rest)</span></label>
      </div>
      <div class="bk-row">
        <label class="bk-tg"><input type="checkbox" id="bk-hold"${st.hold ? ' checked' : ''}><span>Hold to set length</span></label>
        <label class="bk-slider">Tempo <input type="range" id="bk-tempo" min="40" max="160" step="5" value="${st.hold ? st.holdTempo : st.tempo}"> <b id="bk-bpm"></b></label>
      </div>
      <div class="bk-holdbox" id="bk-holdbox"${st.hold ? '' : ' hidden'}>
        <div class="bk-row">
          <label class="bk-tg"><input type="checkbox" id="bk-holddot"${st.holdDot ? ' checked' : ''}><span>Dotted lengths</span></label>
          <label class="bk-tg"><input type="checkbox" id="bk-holdclick"${st.holdClick ? ' checked' : ''}><span>Quiet clicks while holding</span></label>
          <button type="button" id="bk-cal">Calibrate</button>
          <button type="button" class="bk-link" id="bk-calreset">Reset calibration</button>
        </div>
        <div class="bk-hbar" id="bk-hbar" aria-hidden="true"><div class="bk-hfill" id="bk-hfill"></div><div class="bk-hticks" id="bk-hticks"></div></div>
        <div class="bk-hnow" id="bk-hnow" aria-live="off"><span class="bk-hic" id="bk-hic"></span><b id="bk-hbeats">Hold a key</b><span class="muted small" id="bk-hlen"></span></div>
        <div class="bk-calbox" id="bk-calbox" hidden></div>
        <p class="muted small" id="bk-holdhelp"></p>
      </div>
      <div class="bk-row">
        <label class="bk-tg"><input type="checkbox" id="bk-fnon"${st.fnOn ? ' checked' : ''}><span>Low keys set the length</span></label>
        <label class="bk-slider">from <select id="bk-fnbase">${FN_BASES.map((m) => `<option value="${m}"${m === st.fnBase ? ' selected' : ''}>${noteName(m)}</option>`).join('')}</select></label>
      </div>
      <div class="bk-legend" id="bk-legend"></div>
    </details>`;
  const q = (s) => live.querySelector(s);
  const msg = (html, cls = '') => { q('#bk-msg').innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };
  const step = (k) => { did.add(k); live.querySelectorAll('.bk-tipc').forEach((c) => c.classList.toggle('done', did.has(c.dataset.k))); const nx = ['select', 'pitch', 'length', 'play'].find((x) => !did.has(x)); live.querySelectorAll('.bk-tipc').forEach((c) => c.classList.toggle('cur', c.dataset.k === nx)); if (['select', 'pitch', 'length', 'play'].every((x) => did.has(x))) markDone('fix'); };
  step('_');

  // ----- length keys on the keyboard -----
  const fnMap = () => { const m = new Map(); if (st.fnOn) for (const [off, kind, t, label] of FN_KEYS) m.set(st.fnBase + off, { kind, t, label }); return m; };
  let fns = fnMap();
  const paintFn = () => {
    fns = fnMap();
    piano.setFn(new Map([...fns].map(([m, f]) => [m, fnLabel(f)])));
    setSilent((m) => fns.has(m));
    q('#bk-legend').innerHTML = st.fnOn
      ? `<span class="muted small">Length keys:</span> ${[...fns].sort((a, b) => a[0] - b[0]).map(([m, f]) => `<span class="bk-chip" data-m="${m}"><b>${noteName(m)}</b> ${fnLabel(f)}</span>`).join(' ')}`
      : '<span class="muted small">Length keys are off: every key sets the pitch.</span>';
    q('#bk-fnbase').disabled = !st.fnOn;
  };
  paintFn();

  // ----- selection, history -----
  function firstNote(bs) { for (const [b, bar] of bs.entries()) { const i = bar.items.findIndex((x) => x.m != null); if (i >= 0) return { b, i }; } return { b: 0, i: 0 }; }
  const cur = () => bars[sel.b]?.items[sel.i];
  const flatIdx = () => bars.slice(0, sel.b).reduce((a, b) => a + b.items.length, 0) + sel.i;
  const fromFlat = (k) => { for (const [b, bar] of bars.entries()) { if (k < bar.items.length) return { b, i: k }; k -= bar.items.length; } return null; };
  const total = () => bars.reduce((a, b) => a + b.items.length, 0);
  const move = (d) => { const k = Math.max(0, Math.min(total() - 1, flatIdx() + d)); sel = fromFlat(k); armed = false; };
  const commit = (r, keepPos = true) => {
    if (!r.ok) { msg(r.msg, 'bad'); flash(); return false; }
    if (r.same) { msg(r.msg); return true; }
    const pos = starts(bars[sel.b])[sel.i];
    hist.push({ bars, sel: { ...sel } }); fut = [];
    bars = r.bars;
    if (keepPos) sel = { b: sel.b, i: itemAt(bars[sel.b], pos) };
    msg(r.msg);
    draw();
    return true;
  };
  const flash = () => { const c = q(`.bk-it[data-k="${sel.b}:${sel.i}"]`); if (c) { c.classList.remove('bad'); void c.offsetWidth; c.classList.add('bad'); setTimeout(() => c.classList.remove('bad'), 600); } };
  const undo = () => { if (!hist.length) return msg('Nothing to undo.'); fut.push({ bars, sel: { ...sel } }); ({ bars, sel } = hist.pop()); armed = false; msg('Undone.'); draw(); };
  const redo = () => { if (!fut.length) return msg('Nothing to redo.'); hist.push({ bars, sel: { ...sel } }); ({ bars, sel } = fut.pop()); armed = false; msg('Redone.'); draw(); };
  const reset = () => { if (JSON.stringify(bars) === JSON.stringify(orig)) return msg('This is already the original.'); hist.push({ bars, sel: { ...sel } }); fut = []; bars = clone(orig); sel = firstNote(bars); armed = false; msg('Back to the original. (Undo brings your changes back.)'); draw(); };

  // ----- actions -----
  const setLen = (t, how = '') => {
    const x = cur(); if (!x) return;
    lastShorten = null;
    const before = bars;
    const r = setLength(bars, sel.b, sel.i, t, { pull: st.pull });
    if (commit(r)) {
      step('length');
      if (r.shortened && !st.pull) { lastShorten = { before, b: sel.b, i: sel.i, t }; q('#bk-msg').insertAdjacentHTML('beforeend', ' <button type="button" class="bk-link" id="bk-pullnow">Pull the next notes earlier instead</button>'); }
      if (how) q('#bk-msg').insertAdjacentHTML('afterbegin', `<span class="muted">${how} · </span>`);
    }
  };
  const toggleDot = () => {
    const x = cur(); if (!x) return;
    const k = DOTTED.indexOf(x.t), j = PLAIN.indexOf(x.t);
    if (k >= 0) setLen(PLAIN[k]); else if (j >= 0 && DOTTED[j]) setLen(DOTTED[j]); else if (j >= 0) { msg('No dotted 32nd in this practice copy (Edit notes has it).', 'bad'); } else { msg(`A ${lenName(x.t)} can’t take a dot. Pick a plain length first.`, 'bad'); }
  };
  const toggleTie = () => {
    const x = cur(); if (!x) return;
    if (x.m == null) return msg('A rest can’t be tied.', 'bad');
    const k = flatIdx(), nx = fromFlat(k + 1), y = nx && bars[nx.b].items[nx.i];
    if (!x.tie && (!y || y.m == null)) return msg('A tie needs a note right after it.', 'bad');
    const nb = clone(bars), a = nb[sel.b].items[sel.i];
    a.tie = !a.tie;
    if (a.tie) nb[nx.b].items[nx.i].m = a.m;
    commit({ ok: true, bars: nb, msg: a.tie ? `Tied: ${noteName(a.m)} holds on into the next note.` : 'Tie removed.' });
    step('length');
  };
  const makeRest = () => { if (commit(toRest(bars, sel.b, sel.i))) step('length'); };
  const setPitch = (m) => {
    if (armed && st.auto) { const k = flatIdx(); if (k + 1 < total()) sel = fromFlat(k + 1); }
    const x = cur(); if (!x) return null;
    const was = x.m;
    const nb = clone(bars); nb[sel.b].items[sel.i].m = m; fixTies(nb);
    const r = { ok: true, bars: nb, msg: `Bar ${sel.b + 1}, note ${sel.i + 1}: ${was == null ? 'rest' : noteName(was)} → <b id="bk-changed">${noteName(m)}</b> (${lenName(x.t)}).` };
    if (was === m) { r.same = true; r.msg = `It is already <b id="bk-changed">${noteName(m)}</b>.`; }
    armed = !!st.auto;
    commit(r);
    if (r.same) draw();
    step('pitch');
    return { ...sel };
  };

  // ----- drawing: the strip (clickable, always there) and the score (OSMD) -----
  const draw = () => {
    const box = q('#bk-strip');
    box.innerHTML = bars.map((bar, b) => `<div class="bk-bar2" data-bar="${b}"><i class="bk-barno">${b + 1}</i>${bar.items.map((x, i) => `<button type="button" class="bk-it${x.m == null ? ' rest' : ''}${b === sel.b && i === sel.i ? ' sel' : ''}${changed(b, i) ? ' changed' : ''}${x.tie ? ' tie' : ''}" data-k="${b}:${i}" data-m="${x.m ?? ''}" data-t="${x.t}" style="flex-grow:${x.t}" title="${x.m == null ? 'rest' : noteName(x.m)} · ${lenName(x.t)}"><b>${x.m == null ? 'rest' : pcName(x.m)}</b><small>${lenGlyph(x.t, x.m == null)}</small></button>`).join('')}</div>`).join('');
    const nextK = armed && st.auto ? fromFlat(flatIdx() + 1) : null;
    if (nextK) q(`.bk-it[data-k="${nextK.b}:${nextK.i}"]`)?.classList.add('next');
    const x = cur();
    live.querySelectorAll('.bk-len[data-t]').forEach((bt) => bt.classList.toggle('on', !!x && (+bt.dataset.t === x.t || +bt.dataset.t * 1.5 === x.t)));
    q('#bk-dot').classList.toggle('on', !!x && DOTTED.includes(x.t));
    q('#bk-tie').classList.toggle('on', !!x?.tie);
    q('#bk-undo').disabled = !hist.length; q('#bk-redo').disabled = !fut.length;
    q('#bk-reset').disabled = JSON.stringify(bars) === JSON.stringify(orig);
    drawScore();
  };
  const origKey = orig.map((bar) => { let p = 0; return new Map(bar.items.map((x) => { const k = p; p += x.t; return [k, x]; })); });
  const changed = (b, i) => { const s = starts(bars[b])[i], o = origKey[b].get(s), x = bars[b].items[i]; return !o || o.m !== x.m || o.t !== x.t || !!o.tie !== !!x.tie; };

  let osmd = null, drawing = null, again = false;
  const drawScore = async () => {
    if (drawing) { again = true; return; }
    const box = q('#bk-osmd');
    drawing = (async () => {
      try {
        await loadOsmd();
        if (!live.isConnected) return;
        if (!osmd) osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(box, { backend: 'svg', autoResize: false, autoBeam: true, drawTitle: false, drawSubtitle: false, drawComposer: false, drawPartNames: false, drawMetronomeMarks: false, drawMeasureNumbers: true });
        await osmd.load(barsXml(bars, { meter: song.meter, fifths: song.fifths }));
        osmd.zoom = 0.8;
        osmd.render();
        box.classList.add('drawn');
        tagScore();
      } catch { box.classList.remove('drawn'); }
    })();
    await drawing; drawing = null;
    if (again) { again = false; drawScore(); }
  };
  const tagScore = () => {
    const box = q('#bk-osmd');
    (osmd.GraphicSheet?.MeasureList || []).forEach((gms, b) => {
      const bar = bars[b]; if (!bar) return;
      const s = starts(bar);
      for (const gm of gms || []) for (const se of gm?.staffEntries || []) {
        const pos = Math.round((se.relInMeasureTimestamp?.RealValue || 0) * 4 * TPQ);
        const i = s.findIndex((a, j) => pos >= a && pos < a + bar.items[j].t);
        if (i < 0) continue;
        for (const gve of se.graphicalVoiceEntries || []) for (const gn of gve.notes || []) {
          const g = gn.getSVGGElement?.(); if (!g) continue;
          g.dataset.k = `${b}:${i}`; g.classList.add('bk-hit');
          g.classList.toggle('bk-on', b === sel.b && i === sel.i);
        }
      }
    });
    box.dataset.ready = String(Date.now());
  };
  const pick = (k) => { const [b, i] = k.split(':').map(Number); if (!bars[b]?.items[i]) return; sel = { b, i }; armed = false; const x = cur(); msg(`Bar ${b + 1}, note ${i + 1}: <b>${x.m == null ? 'rest' : noteName(x.m)}</b>, ${lenName(x.t)}. Play a key to change it.`); step('select'); draw(); };
  q('#bk-strip').onclick = (e) => { const c = e.target.closest('.bk-it'); if (c) pick(c.dataset.k); };
  q('#bk-osmd').onclick = (e) => { const g = e.target.closest('[data-k]'); if (g) pick(g.dataset.k); };

  // ----- buttons and options -----
  q('#bk-lens').onclick = (e) => {
    const b = e.target.closest('.bk-len'); if (!b) return;
    if (b.dataset.t) setLen(+b.dataset.t); else if (b.id === 'bk-dot') toggleDot(); else if (b.id === 'bk-tie') toggleTie(); else if (b.id === 'bk-rest') makeRest();
  };
  q('#bk-msg').onclick = (e) => {
    if (e.target.id !== 'bk-pullnow' || !lastShorten) return;
    const { before, b, i, t } = lastShorten; lastShorten = null;
    const r = setLength(before, b, i, t, { pull: true });
    if (!r.ok) return msg(r.msg, 'bad');
    fut = []; bars = r.bars; sel = { b, i }; msg(r.msg); draw(); // replaces the step just made (one undo)
  };
  q('#bk-undo').onclick = undo; q('#bk-redo').onclick = redo; q('#bk-reset').onclick = reset;
  q('#bk-auto').onchange = (e) => { st.auto = e.target.checked; persist(); armed = false; draw(); };
  q('#bk-pull').onchange = (e) => { st.pull = e.target.checked; persist(); };
  // ----- hold to set length: tempo, live bar, calibration -----
  let cal = loadCal(), calRun = null, raf = 0, stopClicks = () => {};
  const bpm = () => (st.hold ? st.holdTempo : st.tempo); // hold mode has its own (slow) tempo, 60 by default
  const beatMs = () => 60000 / bpm();
  const tempo = q('#bk-tempo');
  // the hold (ms) where each length starts, at this tempo with the calibration: beats → ms is holdBeats reversed
  const switchMs = (beats) => (beats * beatMs()) / cal.stretch + cal.latency;
  const showBpm = () => {
    q('#bk-bpm').textContent = `${bpm()} BPM`;
    q('#bk-holdbox').hidden = !st.hold;
    if (!st.hold) return;
    const L = st.holdDot ? HOLD_DOTS : HOLD_PLAIN, th = holdThresholds(st.holdDot);
    q('#bk-holdhelp').innerHTML = `1 beat = ${(beatMs() / 1000).toFixed(2)} s. Switch points: ${L.map((t, i) => `<b title="${lenName(t)}">${lenGlyph(t)}</b>${th[i] != null ? ` <span data-th="${i}">${(switchMs(th[i]) / 1000).toFixed(2)} s</span>` : ''}`).join(' · ')}. `
      + `Calibration: ${cal.latency >= 0 ? '−' : '+'}${Math.abs(cal.latency)} ms, ×${cal.stretch.toFixed(2)}${cal.at ? '' : ' (default)'}.`;
    q('#bk-hticks').innerHTML = TICKS.map((t) => `<i data-t="${t}" style="left:${barPos(t / TPQ)}%" title="${lenName(t)} · ${((t / TPQ) * beatMs() / 1000).toFixed(2)} s"><span>${lenGlyph(t)}</span></i>`).join('')
      + th.map((b) => `<u style="left:${barPos(b)}%"></u>`).join('');
  };
  // the live read-out: bar, the note it would pick right now, the length in beats
  const showHold = (beats, done = false) => {
    const t = pickLen(beats, st.holdDot);
    q('#bk-hfill').style.width = `${barPos(beats)}%`;
    q('#bk-hbar').classList.toggle('on', !done);
    q('#bk-hticks').querySelectorAll('i').forEach((i) => i.classList.toggle('past', beats >= +i.dataset.t / TPQ));
    q('#bk-hic').innerHTML = ICON_ANY(t);
    q('#bk-hbeats').textContent = `${beats.toFixed(2)} beat${Math.abs(beats - 1) < 0.005 ? '' : 's'}`;
    q('#bk-hlen').textContent = `${done ? '=' : '→'} ${lenName(t)}`;
    q('#bk-hnow').dataset.t = String(t);
    return t;
  };
  const liveLoop = () => { if (!hold) return; showHold(holdBeats(now() - hold.t, bpm(), cal)); raf = requestAnimationFrame(liveLoop); };
  const startHold = (h) => {
    hold = h;
    stopClicks(); stopClicks = st.holdClick ? clicksFrom(h.t, beatMs(), 8) : () => {};
    cancelAnimationFrame(raf); liveLoop();
  };
  const endHold = () => { cancelAnimationFrame(raf); stopClicks(); stopClicks = () => {}; const h = hold; hold = null; return h; };

  const calBox = q('#bk-calbox');
  const calEnd = (text, cls = '') => {
    if (!calRun) return;
    calRun.stop(); calRun = null;
    q('#bk-cal').textContent = 'Calibrate';
    calBox.hidden = !text; calBox.innerHTML = text ? `<span class="${cls}">${text}</span>` : '';
    showBpm();
  };
  const calDraw = () => { calBox.hidden = false; calBox.innerHTML = `<b>Calibrate:</b> listen to 4 clicks, then hold <b>4 quarter notes</b> with the clicks: press on a click, let go on the next one, press again. <b id="bk-caln">${calRun.holds.length} / 4</b>`; };
  const calKey = (e) => {
    if (e.type === 'on') { if (!calRun.cur) calRun.cur = { midi: e.midi, on: e.t }; return; }
    if (!calRun.cur || calRun.cur.midi !== e.midi) return;
    calRun.holds.push({ on: calRun.cur.on, off: e.t }); calRun.cur = null;
    if (calRun.holds.length < 4) return calDraw();
    const r = calibrate(calRun.holds, calRun.beat);
    cal = { ...r, at: Date.now() }; saveCal(cal);
    calEnd(`Calibrated: ${r.latency >= 0 ? 'holds read ' + r.latency + ' ms shorter' : 'holds read ' + -r.latency + ' ms longer'}, stretch ×${r.stretch.toFixed(2)}. Saved on this device.`, 'ok');
    msg('Calibrated. Hold a key to try it.');
  };
  q('#bk-cal').onclick = () => {
    if (calRun) return calEnd('Calibration cancelled.');
    if (hold) endHold();
    try { audioCtx(); } catch {}
    const b = beatMs(), t0 = now() + 300;
    calRun = { holds: [], cur: null, beat: b, stop: clicksFrom(t0, b, 14, { from: 0, gain: 0.14, accentEvery: 4 }) };
    q('#bk-cal').textContent = 'Cancel';
    calDraw();
  };
  q('#bk-calreset').onclick = () => { if (calRun) calEnd(''); cal = { ...CAL_DEFAULT }; saveCal(null); calBox.hidden = false; calBox.textContent = 'Calibration reset to the default.'; showBpm(); };

  tempo.oninput = () => { if (st.hold) st.holdTempo = +tempo.value; else st.tempo = +tempo.value; persist(); showBpm(); if (player) { player.bpm = bpm(); } };
  q('#bk-hold').onchange = (e) => {
    st.hold = e.target.checked; persist();
    if (!st.hold) { endHold(); calEnd(''); }
    tempo.value = String(bpm()); showBpm();
    msg(st.hold ? `Hold to set length is on (${bpm()} BPM): hold each key as long as the note should last.` : 'Hold to set length is off.');
  };
  q('#bk-holddot').onchange = (e) => { st.holdDot = e.target.checked; persist(); showBpm(); };
  q('#bk-holdclick').onchange = (e) => { st.holdClick = e.target.checked; persist(); if (st.holdClick) { try { audioCtx(); } catch {} } };
  q('#bk-fnon').onchange = (e) => { st.fnOn = e.target.checked; persist(); paintFn(); };
  q('#bk-fnbase').onchange = (e) => { st.fnBase = +e.target.value; persist(); paintFn(); };
  showBpm();

  const stopPlay = () => { player?.stop(); player = null; q('#bk-play').textContent = '▶ Play these bars'; live.querySelectorAll('.bk-it.playing').forEach((c) => c.classList.remove('playing')); };
  q('#bk-play').onclick = async () => {
    if (player) return stopPlay();
    const notes = barsNotes(bars);
    const qs = []; bars.forEach((bar, b) => { const s = starts(bar); bar.items.forEach((x, i) => qs.push({ k: `${b}:${i}`, q: (bars.slice(0, b).reduce((a, y) => a + y.len, 0) + s[i]) / TPQ, d: x.t / TPQ })); });
    let lit = null;
    player = new ScorePlayer({ notes, bpm: bpm(), beats: bars[0].len / TPQ,
      onTick: (pq) => { const h = qs.find((x) => pq >= x.q && pq < x.q + x.d); const k = h?.k || null; if (k === lit) return; live.querySelector(`.bk-it[data-k="${lit}"]`)?.classList.remove('playing'); lit = k; if (k) live.querySelector(`.bk-it[data-k="${k}"]`)?.classList.add('playing'); },
      onEnd: () => stopPlay() });
    q('#bk-play').textContent = '■ Stop';
    live.dataset.played = String(notes.length);
    step('play');
    try { await player.play(); } catch { stopPlay(); }
  };

  // ----- the keyboard(s) -----
  const offNotes = on((e) => {
    if (calRun) return calKey(e); // while calibrating, every key is a measurement and nothing is edited
    const f = fns.get(e.midi);
    if (f) {
      if (e.type !== 'on') return;
      if (f.kind === 'len') setLen(f.t, `${noteName(e.midi)} key`);
      else if (f.kind === 'dot') toggleDot();
      else if (f.kind === 'tie') toggleTie();
      else makeRest();
      return;
    }
    if (e.type === 'on') {
      if (player) stopPlay();
      if (hold) endHold();
      const at = setPitch(e.midi);
      if (st.hold && at) startHold({ midi: e.midi, t: e.t, at });
    } else if (hold && hold.midi === e.midi) {
      const h = endHold(), ms = e.t - h.t;
      const beats = holdBeats(ms, bpm(), cal), t = showHold(beats, true);
      live.dataset.holdMs = String(Math.round(ms));
      if (sel.b !== h.at.b || sel.i !== h.at.i) return;
      setLen(t, `held ${(ms / 1000).toFixed(2)} s = ${beats.toFixed(2)} beats`);
    }
  });
  const onKey = (e) => {
    if (typing(e.target) || e.type !== 'keydown') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); e.stopImmediatePropagation(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.code === 'KeyY') { e.preventDefault(); return redo(); }
    if (mod || e.altKey) return;
    const d = /^(Digit|Numpad)([123468])$/.exec(e.code);
    if (d) { e.preventDefault(); return setLen(LEN[d[2]], `key ${d[2]}`); }
    if (e.code === 'Period' || e.code === 'NumpadDecimal') { e.preventDefault(); return toggleDot(); }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); move(e.code === 'ArrowLeft' ? -1 : 1); step('select'); const x = cur(); msg(`Bar ${sel.b + 1}, note ${sel.i + 1}: <b>${x.m == null ? 'rest' : noteName(x.m)}</b>, ${lenName(x.t)}.`); return draw(); }
    if (e.code === 'KeyR' || e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); return makeRest(); }
  };
  // capture: ⌘Z must not reach the app's own undo
  addEventListener('keydown', onKey, true);
  msg(`Bar 1, note ${sel.i + 1} is picked. Play a key to change it.`);
  draw();
  return () => { offNotes(); endHold(); calEnd(''); removeEventListener('keydown', onKey, true); stopPlay(); setSilent(null); piano.setFn(new Map()); };
}
