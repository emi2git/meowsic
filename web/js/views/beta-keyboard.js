// Keyboard (beta): practise with a USB MIDI keyboard (e.g. a small Yamaha PSS-A50 plugged into the Mac).
// One page, a 7-step tutorial (Next / Back, progress dots): Connect · Find the notes · Play along (wait mode)
// · Play in time · Echo · Record a melody · Fix a note by playing. The song is Home NDP (m-b6xs990), read-only:
// nothing here ever writes to a score; the "fix a note" demo edits a copy of bar 1 in memory.
// Input: Web MIDI (Chrome on the Mac). iPad / iPhone Safari has no Web MIDI: a note says so, and the
// on-screen keys or a computer keyboard (A S D F … white, W E T Y U … black, Z / X octave) stand in.
// Progress and settings are remembered per device (localStorage, guarded).
import { pianoKey, clickAt, audioCtx, loadPiano, ScorePlayer } from '../audio.js';
import { esc } from '../ui.js';

const SONG_ID = 'm-b6xs990';
const BARS = 8; // the excerpt: bars 1–8
const LS = 'meowsic-beta-keyboard';
const PC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcName = (m) => PC[((m % 12) + 12) % 12];
const noteName = (m) => pcName(m) + (Math.floor(m / 12) - 1);
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isWhite = (m) => WHITE.includes(((m % 12) + 12) % 12);
const now = () => performance.now();

function loadSettings() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function saveSettings(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} }

function ensureCss() {
  if (document.querySelector('link[data-beta-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = new URL('../../css/beta.css', import.meta.url).href; l.dataset.betaCss = '';
  document.head.append(l);
}

// where each note is on the keyboard, for beginners
const WHERE = {
  0: 'the white key just left of the two black keys', 2: 'the white key between the two black keys', 4: 'the white key just right of the two black keys',
  5: 'the white key just left of the three black keys', 7: 'the white key after F, between the first two of the three black keys', 9: 'the white key between the last two of the three black keys',
  11: 'the white key just right of the three black keys',
};
const where = (pc) => WHERE[pc] || `the black key just right of ${PC[pc - 1]}`;

// ---------- the song: MusicXML → melody (top staff, top note, ties joined) + left-hand chords ----------
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJ = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MIN = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
const pcOf = (name) => (STEP_PC[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + 12) % 12;

export function parseSong(text, bars = BARS) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const part = doc.querySelector('part');
  if (!part || doc.querySelector('parsererror')) throw new Error('Could not read the score');
  const title = (doc.querySelector('work-title') || doc.querySelector('movement-title'))?.textContent.trim() || 'the song';
  let div = 1, beats = 4, beatType = 4, fifths = null, mode = 'major', tempo = 0, barQ = 0;
  const raw = { 1: [], 2: [] }, barList = [];
  const measures = [...part.querySelectorAll(':scope > measure')].slice(0, bars);
  for (const [bi, m] of measures.entries()) {
    const at = m.querySelector(':scope > attributes');
    if (at) {
      const dv = at.querySelector('divisions'); if (dv) div = +dv.textContent || 1;
      const b = at.querySelector('time > beats'), bt = at.querySelector('time > beat-type');
      if (b) { beats = +b.textContent; beatType = +(bt?.textContent || 4); }
      const f = at.querySelector('key > fifths'); if (f && fifths === null) { fifths = +f.textContent; mode = at.querySelector('key > mode')?.textContent || 'major'; }
    }
    if (!tempo) { const s = m.querySelector('sound[tempo]'); if (s) tempo = +s.getAttribute('tempo'); }
    const len = (beats * 4) / beatType;
    barList.push({ i: bi, q0: barQ, len });
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
      if (staff > 2) continue;
      const midi = 12 * (+p.querySelector('octave').textContent + 1) + STEP_PC[p.querySelector('step').textContent.trim()] + Math.round(+(p.querySelector('alter')?.textContent || 0));
      const q = barQ + onset;
      if (e.querySelector(':scope > tie[type="stop"]')) {
        const prev = raw[staff].slice(-12).reverse().find((x) => x.midi === midi && Math.abs(x.q + x.d - q) < 1e-3);
        if (prev) { prev.d += dur; continue; }
      }
      raw[staff].push({ midi, q, d: dur, bar: bi });
    }
    barQ += len;
  }
  const byOnset = (list) => {
    const g = new Map();
    for (const n of list) { const k = Math.round(n.q * 1000); if (!g.has(k)) g.set(k, []); g.get(k).push(n); }
    return [...g.values()].sort((a, b) => a[0].q - b[0].q);
  };
  const end = barQ;
  const mel = byOnset(raw[1]).map((g) => { const top = g.reduce((a, b) => (b.midi > a.midi ? b : a)); return { midi: top.midi, q: top.q, d: top.d, bar: top.bar }; });
  mel.forEach((n, i) => { const nx = mel[i + 1]; n.d = Math.min(n.d, (nx ? nx.q : end) - n.q); });
  const lh = byOnset(raw[2]).map((g) => ({ q: g[0].q, d: Math.max(...g.map((x) => x.d)), bar: g[0].bar, notes: [...new Set(g.map((x) => x.midi))].sort((a, b) => a - b) }));
  lh.forEach((c) => { c.d = Math.min(c.d, end - c.q); });
  const f = fifths ?? 0, minor = mode === 'minor';
  const tonic = (minor ? MIN : MAJ)[Math.max(0, Math.min(14, f + 7))];
  return { title, tempo: tempo || 100, beats: (beats * 4) / beatType, meter: [beats, beatType], bars: barList, mel, lh, end,
    keyName: `${tonic} ${minor ? 'minor' : 'major'}`, tonicPc: pcOf(tonic), minor };
}

// when the Mac is away (preview / offline) the tutorial still works with a short public-domain tune
function fallbackSong() {
  const tune = [[60, 60, 67, 67], [69, 69, 67], [65, 65, 64, 64], [62, 62, 60], [67, 67, 65, 65], [64, 64, 62], [67, 67, 65, 65], [64, 64, 62]];
  const mel = [], lh = [], bars = [];
  tune.forEach((bar, bi) => {
    bars.push({ i: bi, q0: bi * 4, len: 4 });
    bar.forEach((m, k) => mel.push({ midi: m + 12, q: bi * 4 + k, d: bar.length === 3 && k === 2 ? 2 : 1, bar: bi }));
    lh.push({ q: bi * 4, d: 4, bar: bi, notes: bi % 2 ? [55, 59] : [48, 52] });
  });
  return { title: 'Twinkle Twinkle', tempo: 100, beats: 4, meter: [4, 4], bars, mel, lh, end: 32, keyName: 'C major', tonicPc: 0, minor: false, fallback: true };
}

async function fetchSong() {
  try {
    const r = await fetch(`/api/items/${SONG_ID}/musicxml`);
    if (!r.ok) throw new Error(String(r.status));
    const s = parseSong(await r.text());
    if (!s.mel.length) throw new Error('no notes');
    return s;
  } catch { return fallbackSong(); }
}

// ---------- the note strip: a small piano roll, bars side by side, note names on the notes ----------
function noteStrip(host, song, notes, { lh = null, barsShown = null, hidden = false } = {}) {
  const bars = barsShown || song.bars;
  const lo = Math.min(...notes.map((n) => n.midi)) - 1, hi = Math.max(...notes.map((n) => n.midi)) + 1;
  host.innerHTML = `<div class="bk-strip${lh ? ' with-lh' : ''}">${bars.map((b) => `<div class="bk-bar" data-bar="${b.i}"><i class="bk-barno">${b.i + 1}</i></div>`).join('')}</div>`;
  const strip = host.firstElementChild;
  const barEl = (bi) => strip.querySelector(`.bk-bar[data-bar="${bi}"]`);
  const pct = (q, b) => ((q - b.q0) / b.len) * 100;
  const chips = notes.map((n, i) => {
    const b = bars.find((x) => n.q >= x.q0 - 1e-6 && n.q < x.q0 + x.len - 1e-6) || bars[0];
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'bk-note' + (hidden ? ' hidden' : ''); c.dataset.i = i; c.dataset.midi = n.midi;
    c.style.left = pct(n.q, b) + '%'; c.style.width = `calc(${(Math.min(n.d, b.q0 + b.len - n.q) / b.len) * 100}% - 3px)`;
    c.style.bottom = `calc(${lh ? 34 : 6}px + ${((n.midi - lo) / Math.max(1, hi - lo)) * 100}% * .62)`;
    c.innerHTML = `<b>${hidden ? '?' : pcName(n.midi)}</b>`;
    c.title = hidden ? '' : noteName(n.midi);
    barEl(b.i).append(c);
    return c;
  });
  const lhChips = (lh || []).map((ch, i) => {
    const b = bars.find((x) => ch.q >= x.q0 - 1e-6 && ch.q < x.q0 + x.len - 1e-6) || bars[0];
    const c = document.createElement('span');
    c.className = 'bk-lh'; c.dataset.i = i;
    c.style.left = pct(ch.q, b) + '%'; c.style.width = `calc(${(Math.min(ch.d, b.q0 + b.len - ch.q) / b.len) * 100}% - 3px)`;
    c.textContent = [...new Set(ch.notes.map(pcName))].join(' ');
    barEl(b.i).append(c);
    return c;
  });
  const head = document.createElement('div'); head.className = 'bk-head'; head.hidden = true;
  const place = (q) => {
    const b = bars.find((x) => q >= x.q0 && q < x.q0 + x.len);
    if (!b) { head.hidden = true; return; }
    barEl(b.i).append(head); head.hidden = false; head.style.left = pct(q, b) + '%';
  };
  const focus = (i) => { const c = chips[i]; if (!c) return; const s = strip; const x = c.offsetLeft + c.parentElement.offsetLeft - s.clientWidth / 2; if (s.scrollWidth > s.clientWidth) s.scrollTo({ left: Math.max(0, x), behavior: 'smooth' }); };
  return { strip, chips, lhChips, place, focus, reveal: () => chips.forEach((c, i) => { c.classList.remove('hidden'); c.innerHTML = `<b>${pcName(notes[i].midi)}</b>`; c.title = noteName(notes[i].midi); }) };
}

// ---------- the on-screen piano ----------
function makePiano(host, emit) {
  let lo = 48, hi = 84;
  const lit = new Map(); // class → Set(midi)
  const build = () => {
    const whites = []; for (let m = lo; m <= hi; m++) if (isWhite(m)) whites.push(m);
    const w = 100 / whites.length;
    let html = '';
    whites.forEach((m, i) => { html += `<div class="bk-key white" data-m="${m}" style="left:${i * w}%;width:${w}%"><span class="bk-lbl">${pcName(m) === 'C' ? noteName(m) : pcName(m)}</span><kbd></kbd></div>`; });
    for (let m = lo; m <= hi; m++) if (!isWhite(m)) {
      const i = whites.indexOf(m - 1);
      html += `<div class="bk-key black" data-m="${m}" style="left:${(i + 1) * w - w * 0.31}%;width:${w * 0.62}%"><kbd></kbd></div>`;
    }
    host.innerHTML = `<div class="bk-keys">${html}</div>`;
    for (const [cls, set] of lit) for (const m of set) keyEl(m)?.classList.add(cls);
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
  const flash = (m, cls, ms = 450) => {
    const el = keyEl(m); if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    clearTimeout(el['t' + cls]); el['t' + cls] = setTimeout(() => el.classList.remove(cls), ms);
  };
  const labels = (map) => { host.querySelectorAll('.bk-key kbd').forEach((k) => { k.textContent = map.get(+k.parentElement.dataset.m) || ''; }); };
  const setRange = (a, b) => { if (a === lo && b === hi) return; lo = a; hi = b; build(); };
  // touch / mouse: a press sounds until the finger lifts
  const down = new Map();
  host.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.bk-key'); if (!k) return;
    e.preventDefault();
    try { host.setPointerCapture(e.pointerId); } catch {}
    const m = +k.dataset.m; down.set(e.pointerId, m);
    emit({ type: 'on', midi: m, vel: 96, t: now(), src: 'screen' });
  });
  const up = (e) => { const m = down.get(e.pointerId); if (m == null) return; down.delete(e.pointerId); emit({ type: 'off', midi: m, vel: 0, t: now(), src: 'screen' }); };
  host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up);
  host.addEventListener('contextmenu', (e) => e.preventDefault());
  build();
  return { light, clear, flash, fold, labels, setRange, get range() { return [lo, hi]; } };
}

// the computer keyboard: one row of white keys, the row above for black keys, Z / X = octave down / up
const CODES = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
const CODE_LABEL = (c) => ({ Semicolon: ';', Quote: "'" }[c] || c.slice(3));

// ---------- Web MIDI (kept for the page's life, shared between visits) ----------
const midi = { access: null, status: navigator.requestMIDIAccess ? 'idle' : 'unsupported', error: '' };
async function askMidi() {
  if (!navigator.requestMIDIAccess) { midi.status = 'unsupported'; return; }
  midi.status = 'asking';
  try { midi.access = await navigator.requestMIDIAccess({ sysex: false }); midi.status = 'ok'; }
  catch (e) { midi.status = e && (e.name === 'SecurityError' || e.name === 'NotAllowedError') ? 'denied' : 'error'; midi.error = e?.message || String(e); }
}
const inputsOf = () => (midi.access ? [...midi.access.inputs.values()].filter((i) => !i.state || i.state === 'connected') : []);

// ---------- music helpers ----------
const sameNote = (a, b, anyOct) => (anyOct ? ((a - b) % 12 + 12) % 12 === 0 : a === b);
const DUR = { 4: 'whole', 3: 'dotted half', 2: 'half', 1.5: 'dotted quarter', 1: 'quarter', 0.75: 'dotted 8th', 0.5: '8th', 0.25: '16th' };
const durName = (d) => DUR[Math.round(d * 1000) / 1000] || `${+d.toFixed(2)} beats`;
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const CHORDS = [[[0, 4, 7], ''], [[0, 3, 7], 'm'], [[0, 4, 7, 10], '7'], [[0, 3, 7, 10], 'm7'], [[0, 4, 7, 11], 'maj7'], [[0, 3, 6], 'dim'], [[0, 4, 8], 'aug'], [[0, 2, 7], 'sus2'], [[0, 5, 7], 'sus4'], [[0, 7], '5']];
export function chordName(midis) {
  const pcs = [...new Set(midis.map((m) => m % 12))];
  if (pcs.length < 2) return '';
  const bass = Math.min(...midis) % 12;
  for (const [shape, suf] of CHORDS) for (const root of pcs) {
    const rel = pcs.map((p) => (p - root + 12) % 12).sort((a, b) => a - b);
    if (rel.length === shape.length && rel.every((x, i) => x === shape[i])) return PC[root] + suf + (bass !== root ? '/' + PC[bass] : '');
  }
  return '';
}

// note-by-note comparison (edit distance): match · wrong (sub) · missed (del) · extra (ins)
export function alignNotes(want, got, eq) {
  const n = want.length, m = got.length, D = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j - 1] + (eq(want[i - 1], got[j - 1]) ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
  const ops = [];
  let i = n, j = m;
  while (i || j) {
    if (i && j && D[i][j] === D[i - 1][j - 1] + (eq(want[i - 1], got[j - 1]) ? 0 : 1)) { ops.unshift({ op: eq(want[i - 1], got[j - 1]) ? 'ok' : 'wrong', want: want[i - 1], got: got[j - 1] }); i--; j--; }
    else if (i && D[i][j] === D[i - 1][j] + 1) { ops.unshift({ op: 'missed', want: want[i - 1] }); i--; }
    else { ops.unshift({ op: 'extra', got: got[j - 1] }); j--; }
  }
  return ops;
}

// a free recording → notes on a grid (grid in quarters: 1 = 1/4, .5 = 1/8, .25 = 1/16); notes that start together
// (within 50 ms) make a chord; a later note never lands on the same slot as the one before
export function quantize(raw, { spb, t0, grid }) {
  const sorted = [...raw].sort((a, b) => a.t - b.t), groups = [];
  for (const n of sorted) { const g = groups[groups.length - 1]; if (g && n.t - g[0].t < 50) g.push(n); else groups.push([n]); }
  const ev = [];
  for (const g of groups) {
    let q = Math.max(0, Math.round((g[0].t - t0) / 1000 / spb / grid) * grid);
    const prev = ev[ev.length - 1];
    if (prev && q <= prev.q + 1e-6) q = prev.q + grid;
    const held = Math.max(...g.map((n) => (n.off ?? n.t + 200) - n.t)) / 1000 / spb;
    ev.push({ q, d: Math.max(grid, Math.round(held / grid) * grid), notes: [...new Set(g.map((n) => n.midi))].sort((a, b) => a - b) });
  }
  ev.forEach((e, i) => { const nx = ev[i + 1]; if (nx) e.d = Math.min(e.d, nx.q - e.q); });
  return ev;
}

// those notes → a one-staff MusicXML (for OSMD): rests fill the gaps, notes across a bar line are tied
const SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const PIECES = [[48, 'whole', 0], [36, 'half', 1], [24, 'half', 0], [18, 'quarter', 1], [12, 'quarter', 0], [9, 'eighth', 1], [6, 'eighth', 0], [3, '16th', 0]];
export function eventsXml(events, { beats = 4, title = '' } = {}) {
  const bar = beats * 12, items = [];
  let cur = 0;
  for (const e of events) {
    const a = Math.round(e.q * 12), d = Math.max(3, Math.round(e.d * 12));
    if (a > cur) items.push({ a: cur, d: a - cur, notes: null });
    items.push({ a, d, notes: e.notes }); cur = a + d;
  }
  const total = Math.max(bar, Math.ceil(cur / bar) * bar);
  if (total > cur) items.push({ a: cur, d: total - cur, notes: null });
  const all = events.flatMap((e) => e.notes), bass = all.length && all.reduce((s, x) => s + x, 0) / all.length < 57;
  let xml = '';
  for (let b = 0; b < total / bar; b++) {
    xml += `<measure number="${b + 1}">`;
    if (!b) xml += `<attributes><divisions>12</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>4</beat-type></time><clef><sign>${bass ? 'F' : 'G'}</sign><line>${bass ? 4 : 2}</line></clef></attributes>`;
    for (const it of items) {
      const s = Math.max(it.a, b * bar), e = Math.min(it.a + it.d, (b + 1) * bar);
      if (e <= s) continue;
      let left = e - s, pos = s;
      while (left > 0) {
        const [len, type, dot] = PIECES.find(([l]) => l <= left) || [left, '16th', 0];
        const first = pos === it.a, last = pos + len === it.a + it.d;
        if (!it.notes) xml += `<note><rest/><duration>${len}</duration><voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}</note>`;
        else it.notes.forEach((m, k) => {
          const [step, alter] = SHARP[m % 12];
          const ties = (first ? '' : '<tie type="stop"/>') + (last ? '' : '<tie type="start"/>');
          const tied = (first ? '' : '<tied type="stop"/>') + (last ? '' : '<tied type="start"/>');
          xml += `<note>${k ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? '<alter>1</alter>' : ''}<octave>${Math.floor(m / 12) - 1}</octave></pitch><duration>${len}</duration>${ties}<voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}${alter ? '<accidental>sharp</accidental>' : ''}${tied ? `<notations>${tied}</notations>` : ''}</note>`;
        });
        left -= len; pos += len;
      }
    }
    xml += '</measure>';
  }
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><work><work-title>${esc(title)}</work-title></work><part-list><score-part id="P1"><part-name></part-name></score-part></part-list><part id="P1">${xml}</part></score-partwise>`;
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
async function drawScore(box, xml) {
  try {
    await loadOsmd();
    box.innerHTML = '';
    const o = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(box, { backend: 'svg', autoResize: false, drawTitle: false, drawSubtitle: false, drawComposer: false, drawPartNames: false, drawMetronomeMarks: false, drawMeasureNumbers: true });
    await o.load(xml);
    o.zoom = 0.75;
    o.render();
    box.classList.add('drawn');
    return true;
  } catch { box.innerHTML = ''; box.classList.remove('drawn'); return false; }
}

// a metronome: clicks on the audio clock, beat 0 at performance time t0 (ms); stop() ends it
function metronome(t0, spb, beatsPerBar, { until = Infinity } = {}) {
  const c = audioCtx();
  let k = Math.ceil((now() - t0) / 1000 / spb - 1e-6), stopped = false;
  const tick = () => {
    if (stopped) return;
    const horizon = now() + 160;
    for (;;) {
      const t = t0 + k * spb * 1000;
      if (t > horizon || t > until) break;
      const when = c.currentTime + Math.max(0, (t - now()) / 1000);
      try { clickAt(when, ((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0); } catch {}
      k++;
    }
  };
  tick();
  const timer = setInterval(tick, 40);
  return { stop() { stopped = true; clearInterval(timer); } };
}

const STEPS = [
  { id: 'connect', title: 'Connect', intro: 'Plug the keyboard into the Mac with USB, switch it on, then press any key.', tip: 'Your keyboard has its own speaker. Switch off <b>App sound</b> below to hear only the keyboard.' },
  { id: 'find', title: 'Find the notes', intro: 'Meowsic asks for a note; find it and play it. These are the notes the song uses.', tip: 'Any octave counts here. The black keys come in groups of two and three: C is always just left of the two.' },
  { id: 'wait', title: 'Play along', intro: 'The tune waits for you: play each note and it moves on. No hurry.', tip: 'Stuck? <b>Hint</b> lights the key. Turn on <b>Left hand chords</b> when the tune feels easy.' },
  { id: 'time', title: 'Play in time', intro: 'Now with a beat. After the count-in, play each note on time.', tip: 'Start slow. Speed up only when most notes are green.' },
  { id: 'echo', title: 'Echo', intro: 'Listen to one bar, then play it back by ear.', tip: 'Hum it first. Find the first note, then go up or down from there.' },
  { id: 'record', title: 'Record a melody', intro: 'Press Record, play anything, then Stop. Meowsic writes it down.', tip: 'With the metronome on, the notes line up on the beat. Try 1/4 if the result looks busy.' },
  { id: 'fix', title: 'Fix a note by playing', intro: 'Tap a note in the strip, then press a key: the note changes to that key.', tip: 'This is a demo on a copy of bar 1. It will come to <b>Edit notes</b> later; nothing is saved.' },
];

export function render(el, _ctx = {}) {
  ensureCss();
  const st = Object.assign({ step: 0, done: [], sound: true, anyOct: true, lh: false, tempo: 60, quant: 0.5, metro: false, base: 60 }, loadSettings());
  const persist = () => saveSettings(st);
  const subs = new Set();
  const on = (f) => { subs.add(f); return () => subs.delete(f); };
  const held = new Map(); // midi → release()
  let stepCleanup = null, alive = true;
  const songP = fetchSong();

  el.innerHTML = `
    <header class="top"><h1>Keyboard (beta)</h1><span class="bk-badge">BETA</span></header>
    <div class="pad bk">
      <section class="card bk-conn" id="bk-conn" aria-live="polite"></section>
      <section class="card bk-step" id="bk-step">
        <div class="bk-dots" id="bk-dots">${STEPS.map((s, i) => `<button type="button" class="bk-dot" data-i="${i}" aria-label="Step ${i + 1}: ${s.title}"><span>${i + 1}</span></button>`).join('')}</div>
        <h2 id="bk-title"></h2>
        <p class="bk-intro" id="bk-intro"></p>
        <div class="bk-try"><div class="bk-try-h">Try it</div><div id="bk-live" class="bk-live"></div></div>
        <p class="bk-tip" id="bk-tip"></p>
        <div class="bk-nav"><button type="button" id="bk-back">‹ Back</button><span id="bk-count" class="muted small"></span><button type="button" class="primary" id="bk-next">Next ›</button></div>
      </section>
      <div class="bk-dock">
        <div class="bk-opts">
          <label class="bk-tg"><input type="checkbox" id="bk-sound"${st.sound ? ' checked' : ''}><span>App sound</span></label>
          <label class="bk-tg"><input type="checkbox" id="bk-anyoct"${st.anyOct ? ' checked' : ''}><span>Any octave counts</span></label>
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
      if (st.sound) { try { rel = pianoKey(e.midi, e.vel || 90); } catch {} }
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
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range'))) return;
    if (e.type === 'keydown') {
      if (e.code === 'KeyZ' || e.code === 'KeyX') { if (!e.repeat) { st.base = Math.max(36, Math.min(84, st.base + (e.code === 'KeyZ' ? -12 : 12))); persist(); keyLabels(); } e.preventDefault(); return; }
      if (!(e.code in CODES)) return;
      e.preventDefault();
      if (e.repeat || keyDown.has(e.code)) return;
      const m = st.base + CODES[e.code]; keyDown.set(e.code, m);
      emit({ type: 'on', midi: m, vel: 90, t: e.timeStamp || now(), src: 'keys' });
    } else if (keyDown.has(e.code)) {
      const m = keyDown.get(e.code); keyDown.delete(e.code);
      emit({ type: 'off', midi: m, vel: 0, t: e.timeStamp || now(), src: 'keys' });
    }
  };
  addEventListener('keydown', onKey); addEventListener('keyup', onKey);
  const onBlur = () => { for (const [code, m] of keyDown) { keyDown.delete(code); emit({ type: 'off', midi: m, vel: 0, t: now(), src: 'keys' }); } };
  addEventListener('blur', onBlur);

  // MIDI
  const attached = new Set();
  const onMidi = (e) => {
    const d = e.data; if (!d || d.length < 2) return;
    const cmd = d[0] & 0xf0, t = e.timeStamp || now();
    if (cmd === 0x90 && d[2] > 0) emit({ type: 'on', midi: d[1], vel: d[2], t, src: 'midi' });
    else if (cmd === 0x80 || cmd === 0x90) emit({ type: 'off', midi: d[1], vel: 0, t, src: 'midi' });
  };
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
    const fallback = '<p class="muted small bk-fb">No keyboard? Use the keys at the bottom, or the computer keys: <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> … white keys, <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> black keys.</p>';
    let html;
    if (midi.status === 'unsupported') html = `<div class="bk-state warn"><b>This browser can’t use a USB keyboard.</b> iPad and iPhone Safari have no Web MIDI. Everything below still works with the on-screen keys. For your Yamaha, plug it into the Mac and open Meowsic in Chrome.</div>`;
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
  $('#bk-anyoct').onchange = (e) => { st.anyOct = e.target.checked; persist(); };
  const onResize = () => fitRange();
  addEventListener('resize', onResize);
  fitRange();

  // ----- the stepper -----
  const markDone = (id) => { if (!st.done.includes(id)) { st.done.push(id); persist(); drawDots(); } };
  function drawDots() {
    el.querySelectorAll('.bk-dot').forEach((d, i) => { d.classList.toggle('on', i === st.step); d.classList.toggle('done', st.done.includes(STEPS[i].id)); d.setAttribute('aria-current', i === st.step ? 'step' : 'false'); });
  }
  const api = { on, piano, st, persist, songP, markDone, el, isAlive: () => alive };
  function show(i) {
    if (typeof stepCleanup === 'function') { try { stepCleanup(); } catch {} }
    stepCleanup = null;
    for (const c of ['hint', 'map', 'ok', 'bad', 'target']) piano.clear(c);
    st.step = Math.max(0, Math.min(STEPS.length - 1, i)); persist();
    const s = STEPS[st.step];
    $('#bk-step').dataset.step = s.id;
    $('#bk-title').textContent = `${st.step + 1} · ${s.title}`;
    $('#bk-intro').textContent = s.intro;
    $('#bk-tip').innerHTML = `<b>Tip</b> ${s.tip}`;
    $('#bk-count').textContent = `${st.step + 1} / ${STEPS.length}`;
    $('#bk-back').disabled = st.step === 0;
    $('#bk-next').textContent = st.step === STEPS.length - 1 ? 'Start again' : 'Next ›';
    const live = $('#bk-live'); live.innerHTML = '';
    stepCleanup = MOUNT[s.id](live, api);
    drawDots();
  }
  $('#bk-back').onclick = () => show(st.step - 1);
  $('#bk-next').onclick = () => show(st.step === STEPS.length - 1 ? 0 : st.step + 1);
  $('#bk-dots').onclick = (e) => { const d = e.target.closest('.bk-dot'); if (d) show(+d.dataset.i); };
  show(st.step);

  return () => {
    alive = false;
    if (typeof stepCleanup === 'function') { try { stepCleanup(); } catch {} }
    removeEventListener('keydown', onKey); removeEventListener('keyup', onKey); removeEventListener('blur', onBlur); removeEventListener('resize', onResize);
    for (const inp of attached) inp.removeEventListener('midimessage', onMidi);
    midi.access?.removeEventListener?.('statechange', onState);
    for (const r of held.values()) r(); held.clear();
  };
}
export const betaKeyboardView = render;
export default render;

// ---------- the steps (each returns its clean-up) ----------
const songLine = (song) => song.fallback ? `<p class="bk-info warn">Home NDP needs the Mac. Practising <b>${esc(song.title)}</b> meanwhile.</p>` : '';
const excerpt = (song) => `${esc(song.fallback ? song.title : 'Home NDP')} · bars 1–${song.bars.length}`;
const loading = (live) => { live.innerHTML = '<p class="muted">Loading the song…</p>'; };

const MOUNT = {
  connect(live, { on, markDone }) {
    live.innerHTML = `
      <div class="bk-big" id="bk-last"><b>—</b><span class="muted">Press any key</span></div>
      <div class="bk-row"><span class="muted small">Holding:</span> <span id="bk-held" class="bk-held">nothing</span> <span id="bk-chord" class="bk-chordname"></span></div>
      <div class="bk-recent" id="bk-recent"></div>`;
    const down = new Set(), recent = [];
    const SRC = { midi: 'from the keyboard', screen: 'on-screen key', keys: 'computer key' };
    const off = on((e) => {
      if (e.type === 'on') {
        down.add(e.midi);
        live.querySelector('#bk-last').innerHTML = `<b>${noteName(e.midi)}</b><span class="muted">${pcName(e.midi)} · velocity ${e.vel} · ${SRC[e.src] || ''}</span>`;
        recent.unshift(noteName(e.midi)); recent.length = Math.min(recent.length, 12);
        live.querySelector('#bk-recent').innerHTML = recent.map((n) => `<span class="bk-chip">${n}</span>`).join('');
        markDone('connect');
      } else down.delete(e.midi);
      const ms = [...down].sort((a, b) => a - b);
      live.querySelector('#bk-held').textContent = ms.length ? ms.map(noteName).join(' ') : 'nothing';
      const c = chordName(ms);
      live.querySelector('#bk-chord').textContent = c ? `= ${c} chord` : '';
    });
    return off;
  },

  find(live, { on, piano, songP, markDone, isAlive }) {
    loading(live);
    let off = () => {}, timer = 0;
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      const used = [...new Set(song.mel.map((n) => n.midi % 12))];
      const t = song.tonicPc, triad = [t, (t + (song.minor ? 3 : 4)) % 12, (t + 7) % 12];
      const rest = used.filter((p) => !triad.includes(p)).sort((a, b) => ((a - t + 12) % 12) - ((b - t + 12) % 12));
      const targets = [...triad, ...rest];
      const lo = Math.min(...song.mel.map((n) => n.midi)), hi = Math.max(...song.mel.map((n) => n.midi));
      let k = 0;
      live.innerHTML = `${songLine(song)}
        <p><b>${esc(song.fallback ? song.title : 'Home NDP')}</b> is in <b>${esc(song.keyName)}</b>. Its tune uses <b>${used.length}</b> notes, from <b>${noteName(lo)}</b> up to <b>${noteName(hi)}</b>.</p>
        <div class="bk-ask" id="bk-ask"></div>
        <div class="bk-targets" id="bk-targets">${targets.map((p, i) => `<span class="bk-chip" data-i="${i}">${PC[p]}</span>`).join('')}</div>
        <p class="bk-msg" id="bk-msg"></p>
        <div class="bk-row"><button type="button" id="bk-show">Show me</button><button type="button" id="bk-again">Start over</button></div>`;
      const ask = () => {
        piano.clear('hint');
        live.querySelectorAll('#bk-targets .bk-chip').forEach((c, i) => { c.classList.toggle('ok', i < k); c.classList.toggle('cur', i === k); });
        if (k >= targets.length) {
          live.querySelector('#bk-ask').innerHTML = `<b class="ok">All ${targets.length} found!</b>`;
          live.querySelector('#bk-msg').textContent = 'The dotted keys are the notes of the song. Next: play the tune.';
          for (let m = 36; m <= 96; m++) if (used.includes(m % 12)) piano.light(m, 'map');
          markDone('find');
          return;
        }
        live.querySelector('#bk-ask').innerHTML = `Play <b id="bk-want">${PC[targets[k]]}</b>`;
      };
      live.querySelector('#bk-show').onclick = () => { if (k < targets.length) { for (let m = 36; m <= 96; m++) if (m % 12 === targets[k]) piano.light(m, 'hint'); live.querySelector('#bk-msg').textContent = `${PC[targets[k]]} is ${where(targets[k])}.`; } };
      live.querySelector('#bk-again').onclick = () => { k = 0; piano.clear('map'); live.querySelector('#bk-msg').textContent = ''; ask(); };
      off = on((e) => {
        if (e.type !== 'on' || k >= targets.length) return;
        if (e.midi % 12 === targets[k]) {
          piano.flash(e.midi, 'ok', 600);
          live.querySelector('#bk-msg').textContent = `Yes, ${noteName(e.midi)}.`;
          k++; clearTimeout(timer); timer = setTimeout(ask, 350);
          if (k >= targets.length) { clearTimeout(timer); ask(); }
        } else {
          piano.flash(e.midi, 'bad', 600);
          live.querySelector('#bk-msg').textContent = `That’s ${pcName(e.midi)}. ${PC[targets[k]]} is ${where(targets[k])}.`;
        }
      });
      ask();
    });
    return () => { off(); clearTimeout(timer); };
  },

  wait(live, { on, piano, st, persist, songP, markDone, isAlive }) {
    loading(live);
    let off = () => {};
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      live.innerHTML = `${songLine(song)}
        <div class="bk-row"><b>${excerpt(song)}</b><span class="bk-grow"></span>
          <label class="bk-tg"><input type="checkbox" id="bk-lh"${st.lh ? ' checked' : ''}><span>Left hand chords</span></label>
          <button type="button" id="bk-hint">Hint</button><button type="button" id="bk-restart">Start over</button></div>
        <div id="bk-stripbox"></div>
        <p class="bk-msg" id="bk-msg"></p>
        <div id="bk-result"></div>`;
      let steps, k, got, mistakes, hints, t0, strip, firstTry;
      const build = () => {
        const lh = st.lh ? song.lh : null;
        strip = noteStrip(live.querySelector('#bk-stripbox'), song, song.mel, { lh });
        const map = new Map();
        song.mel.forEach((n, i) => map.set(Math.round(n.q * 1000), { q: n.q, need: [n.midi], mel: i, lh: null }));
        if (lh) lh.forEach((c, i) => { const key = Math.round(c.q * 1000); const s = map.get(key) || { q: c.q, need: [], mel: null, lh: null }; s.need.push(...c.notes); s.lh = i; map.set(key, s); });
        steps = [...map.values()].sort((a, b) => a.q - b.q);
        k = 0; got = new Set(); mistakes = 0; hints = 0; t0 = 0; firstTry = 0; clean = true;
        live.querySelector('#bk-result').innerHTML = '';
        cue();
      };
      const pending = () => steps[k].need.filter((m) => ![...got].some((g) => sameNote(g, m, st.anyOct)));
      const wanted = () => [...new Set(steps[k].need.map((m) => (st.anyOct ? pcName(m) : noteName(m))))].join(' + ');
      const cue = () => {
        piano.clear('hint'); piano.clear('target');
        strip.chips.forEach((c, i) => c.classList.toggle('cur', k < steps.length && steps[k].mel === i));
        strip.lhChips.forEach((c, i) => c.classList.toggle('cur', k < steps.length && steps[k].lh === i));
        if (k >= steps.length) return finish();
        const s = steps[k];
        if (s.mel != null) strip.focus(s.mel);
        live.querySelector('#bk-msg').innerHTML = `Play <b id="bk-want">${wanted()}</b>`;
      };
      const finish = () => {
        const ms = now() - t0, notes = steps.reduce((a, s) => a + s.need.length, 0);
        live.querySelector('#bk-msg').innerHTML = '<b class="ok">Well done!</b>';
        live.querySelector('#bk-result').innerHTML = `<div class="bk-score" id="bk-score">
          <div><b>${notes}</b><span>notes</span></div><div><b>${mistakes}</b><span>mistakes</span></div>
          <div><b>${mmss(ms)}</b><span>time</span></div><div><b>${Math.round((firstTry / steps.length) * 100)}%</b><span>right first time</span></div>
          ${hints ? `<div><b>${hints}</b><span>hints</span></div>` : ''}</div>`;
        st.lastWait = { notes, mistakes, ms: Math.round(ms) }; persist();
        markDone('wait');
      };
      let clean = true;
      off = on((e) => {
        if (e.type !== 'on' || !steps || k >= steps.length) return;
        if (!t0) t0 = e.t || now();
        const s = steps[k], hit = s.need.find((m) => sameNote(e.midi, m, st.anyOct));
        if (hit != null) {
          got.add(e.midi); piano.flash(e.midi, 'ok');
          if (!pending().length) {
            if (s.mel != null) strip.chips[s.mel].classList.add(clean ? 'ok' : 'fixed');
            if (s.lh != null) strip.lhChips[s.lh].classList.add('ok');
            if (clean) firstTry++;
            k++; got = new Set(); clean = true; cue();
          }
        } else {
          mistakes++; clean = false;
          piano.flash(e.midi, 'bad', 600);
          if (s.mel != null) { const c = strip.chips[s.mel]; c.classList.remove('bad'); void c.offsetWidth; c.classList.add('bad'); setTimeout(() => c.classList.remove('bad'), 600); }
          live.querySelector('#bk-msg').innerHTML = `<span class="bad">That was ${st.anyOct ? pcName(e.midi) : noteName(e.midi)}.</span> Expected <b id="bk-want">${wanted()}</b>`;
        }
      });
      live.querySelector('#bk-hint').onclick = () => { if (k < steps.length) { hints++; for (const m of pending()) piano.light(m, 'hint'); } };
      live.querySelector('#bk-restart').onclick = build;
      live.querySelector('#bk-lh').onchange = (e) => { st.lh = e.target.checked; persist(); build(); };
      build();
    });
    return () => off();
  },

  time(live, { on, piano, st, persist, songP, markDone, isAlive }) {
    loading(live);
    let off = () => {}, stopRun = () => {};
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      live.innerHTML = `${songLine(song)}
        <div class="bk-row"><b>${excerpt(song)}</b><span class="bk-grow"></span>
          <label class="bk-slider">Tempo <input type="range" id="bk-tempo" min="40" max="${Math.max(60, Math.round(song.tempo))}" step="2" value="${Math.min(st.tempo, Math.round(song.tempo))}"> <b id="bk-bpm"></b> <span class="muted small">(song ${Math.round(song.tempo)})</span></label>
          <button type="button" class="primary" id="bk-go">Start</button></div>
        <div id="bk-stripbox"></div>
        <div class="bk-count" id="bk-countin"></div>
        <div id="bk-result"></div>`;
      const tempo = live.querySelector('#bk-tempo'), bpmEl = live.querySelector('#bk-bpm'), goBtn = live.querySelector('#bk-go');
      const showBpm = () => { bpmEl.textContent = tempo.value + ' BPM'; };
      tempo.oninput = () => { st.tempo = +tempo.value; persist(); showBpm(); };
      showBpm();
      let strip = noteStrip(live.querySelector('#bk-stripbox'), song, song.mel), run = null;
      const stop = (finished) => {
        if (!run) return;
        run.metro.stop(); cancelAnimationFrame(run.raf); strip.place(-1);
        const r = run; run = null; goBtn.textContent = 'Start'; goBtn.classList.add('primary');
        live.querySelector('#bk-countin').textContent = '';
        const c = { ontime: 0, early: 0, late: 0, missed: 0 };
        r.res.forEach((x) => { if (x) c[x.kind]++; else if (finished) c.missed++; });
        const played = c.ontime + c.early + c.late;
        live.querySelector('#bk-result').innerHTML = `<div class="bk-score" id="bk-score">
          <div class="ok"><b>${c.ontime}</b><span>on time</span></div><div class="early"><b>${c.early}</b><span>early</span></div>
          <div class="late"><b>${c.late}</b><span>late</span></div><div><b>${c.missed}</b><span>missed</span></div><div><b>${r.extra}</b><span>wrong notes</span></div></div>`;
        if (played) markDone('time');
      };
      stopRun = () => stop(false);
      goBtn.onclick = () => {
        if (run) return stop(false);
        try { audioCtx(); } catch {}
        strip = noteStrip(live.querySelector('#bk-stripbox'), song, song.mel);
        live.querySelector('#bk-result').innerHTML = '';
        const spb = 60 / +tempo.value, bar = song.beats, t0 = now() + 200 + bar * spb * 1000;
        const times = song.mel.map((n) => t0 + n.q * spb * 1000);
        const endT = t0 + song.end * spb * 1000;
        run = { t0, spb, times, res: song.mel.map(() => null), extra: 0, metro: metronome(t0 - bar * spb * 1000, spb, bar, { until: endT }) };
        strip.strip.dataset.t0 = t0; strip.strip.dataset.spb = spb;
        goBtn.textContent = 'Stop'; goBtn.classList.remove('primary');
        const win = 0.6 * spb * 1000, tol = Math.max(90, 0.18 * spb * 1000);
        run.win = win; run.tol = tol;
        const frame = () => {
          if (!run) return;
          const t = now(), cnt = live.querySelector('#bk-countin');
          if (t < t0) cnt.textContent = String(Math.max(1, Math.min(bar, Math.floor((t - t0) / 1000 / spb + bar) + 1))); // count-in: 1 2 3 4
          else cnt.textContent = '';
          strip.place((t - t0) / 1000 / spb);
          run.times.forEach((T, i) => { if (!run.res[i] && t > T + win) { run.res[i] = { kind: 'missed' }; strip.chips[i].classList.add('missed'); } });
          if (t > endT + spb * 1000) return stop(true);
          run.raf = requestAnimationFrame(frame);
        };
        frame();
      };
      off = on((e) => {
        if (e.type !== 'on' || !run) return;
        let best = -1, bd = Infinity;
        run.times.forEach((T, i) => { const d = Math.abs(e.t - T); if (!run.res[i] && d < run.win && d < bd && sameNote(e.midi, song.mel[i].midi, st.anyOct)) { best = i; bd = d; } });
        if (best < 0) { run.extra++; piano.flash(e.midi, 'bad'); return; }
        const dt = e.t - run.times[best], kind = Math.abs(dt) <= run.tol ? 'ontime' : dt < 0 ? 'early' : 'late';
        run.res[best] = { kind, dt };
        const c = strip.chips[best];
        c.classList.add(kind === 'ontime' ? 'ok' : kind);
        c.innerHTML = `<b>${pcName(song.mel[best].midi)}</b><small>${kind === 'ontime' ? '✓' : (dt > 0 ? '+' : '−') + Math.round(Math.abs(dt)) + ' ms'}</small>`;
        piano.flash(e.midi, kind === 'ontime' ? 'ok' : 'warn');
      });
    });
    return () => { off(); stopRun(); };
  },

  echo(live, { on, piano, st, persist, songP, markDone, isAlive }) {
    loading(live);
    let off = () => {}, player = null, timer = 0;
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      const bars = song.bars.filter((b) => song.mel.filter((n) => n.bar === b.i).length >= 2);
      let bi = Math.max(0, Math.min(bars.length - 1, st.echoBar || 0)), played = [], listening = false, checked = false;
      live.innerHTML = `${songLine(song)}
        <div class="bk-row"><button type="button" id="bk-prev" aria-label="Previous bar">‹</button><b id="bk-barname"></b><button type="button" id="bk-nextbar" aria-label="Next bar">›</button>
          <span class="bk-grow"></span><button type="button" class="primary" id="bk-listen">▶ Listen</button><button type="button" id="bk-check">Check</button><button type="button" id="bk-retry">Try again</button></div>
        <div id="bk-stripbox"></div>
        <div class="bk-row"><span class="muted small">You played:</span> <span id="bk-played" class="bk-held"></span></div>
        <p class="bk-msg" id="bk-msg"></p>
        <div id="bk-result"></div>`;
      let strip, notes;
      const setBar = () => {
        const b = bars[bi]; st.echoBar = bi; persist();
        notes = song.mel.filter((n) => n.bar === b.i);
        live.querySelector('#bk-barname').textContent = `Bar ${b.i + 1}`;
        strip = noteStrip(live.querySelector('#bk-stripbox'), song, notes, { barsShown: [b], hidden: true });
        reset();
      };
      const reset = () => {
        played = []; checked = false; clearTimeout(timer);
        live.querySelector('#bk-played').textContent = '';
        live.querySelector('#bk-result').innerHTML = '';
        live.querySelector('#bk-msg').textContent = `Listen, then play the ${notes.length} notes back.`;
      };
      const check = () => {
        clearTimeout(timer);
        if (checked) return;
        checked = true;
        const ops = alignNotes(notes.map((n) => n.midi), played, (a, b) => sameNote(a, b, st.anyOct));
        const ok = ops.filter((o) => o.op === 'ok').length;
        strip.reveal();
        let ni = 0;
        for (const o of ops) if (o.op !== 'extra') { strip.chips[ni].classList.add(o.op === 'ok' ? 'ok' : 'missed'); ni++; }
        const label = { ok: '✓', wrong: '✗', missed: 'missed', extra: 'extra' };
        live.querySelector('#bk-result').innerHTML = `<table class="bk-cmp" id="bk-cmp"><tr><th>Song</th>${ops.map((o) => `<td class="${o.op}">${o.want != null ? pcName(o.want) : '·'}</td>`).join('')}</tr>
          <tr><th>You</th>${ops.map((o) => `<td class="${o.op}">${o.got != null ? pcName(o.got) : '·'}</td>`).join('')}</tr>
          <tr><th></th>${ops.map((o) => `<td class="${o.op} mark">${label[o.op]}</td>`).join('')}</tr></table>`;
        live.querySelector('#bk-msg').innerHTML = `<b id="bk-matched" class="${ok === notes.length && played.length === notes.length ? 'ok' : ''}">${ok} of ${notes.length} notes matched.</b>${ok === notes.length && played.length === notes.length ? ' By ear, well done!' : ' Listen again and try once more.'}`;
        markDone('echo');
      };
      live.querySelector('#bk-prev').onclick = () => { bi = (bi - 1 + bars.length) % bars.length; setBar(); };
      live.querySelector('#bk-nextbar').onclick = () => { bi = (bi + 1) % bars.length; setBar(); };
      live.querySelector('#bk-check').onclick = check;
      live.querySelector('#bk-retry').onclick = () => setBar();
      live.querySelector('#bk-listen').onclick = async () => {
        player?.stop();
        const b = bars[bi];
        reset(); strip = noteStrip(live.querySelector('#bk-stripbox'), song, notes, { barsShown: [b], hidden: true });
        listening = true;
        live.querySelector('#bk-msg').textContent = 'Listen…';
        player = new ScorePlayer({ notes: notes.map((n) => ({ n: n.midi, q: n.q - b.q0, d: n.d, v: 90 })), bpm: Math.max(60, Math.min(st.tempo + 12, song.tempo)), beats: b.len,
          onTick: (q) => strip.place(b.q0 + q), onEnd: () => { listening = false; strip.place(-1); live.querySelector('#bk-msg').textContent = 'Your turn: play it back.'; } });
        try { await player.play(); } catch { listening = false; live.querySelector('#bk-msg').textContent = 'No sound yet: tap Listen again.'; }
      };
      off = on((e) => {
        if (e.type !== 'on' || listening) return;
        if (checked) reset();
        played.push(e.midi);
        live.querySelector('#bk-played').textContent = played.map(pcName).join(' ');
        clearTimeout(timer);
        if (played.length >= notes.length) timer = setTimeout(check, 1200);
      });
      setBar();
    });
    return () => { off(); clearTimeout(timer); player?.stop(); };
  },

  record(live, { on, st, persist, markDone }) {
    live.innerHTML = `
      <div class="bk-row">
        <button type="button" class="primary bk-rec" id="bk-rec">● Record</button>
        <button type="button" id="bk-play" disabled>▶ Play back</button>
        <label class="bk-tg"><input type="checkbox" id="bk-metro"${st.metro ? ' checked' : ''}><span>Metronome</span></label>
        <label class="bk-slider">Tempo <input type="range" id="bk-rtempo" min="40" max="160" step="2" value="${st.recTempo || 80}"> <b id="bk-rbpm"></b></label>
        <label class="bk-slider">Quantize <select id="bk-quant"><option value="1">1/4</option><option value="0.5">1/8</option><option value="0.25">1/16</option></select></label>
      </div>
      <p class="bk-msg" id="bk-msg">Press Record and play anything.</p>
      <div class="bk-osmd" id="bk-osmd"></div>
      <div class="bk-recent" id="bk-notes"></div>
      <div class="bk-row"><button type="button" id="bk-save" disabled title="Coming later">Save as new score</button><span class="muted small">Coming later: nothing is saved yet.</span></div>`;
    const q = (s) => live.querySelector(s);
    q('#bk-quant').value = String(st.quant || 0.5);
    const tempo = q('#bk-rtempo'), showBpm = () => { q('#bk-rbpm').textContent = tempo.value + ' BPM'; };
    tempo.oninput = () => { st.recTempo = +tempo.value; persist(); showBpm(); };
    showBpm();
    let rec = null, take = null, events = [], player = null, drawSeq = 0;
    const draw = async () => {
      if (!take) return;
      const spb = take.spb, grid = +q('#bk-quant').value;
      events = quantize(take.notes, { spb, t0: take.t0 ?? Math.min(...take.notes.map((n) => n.t)), grid });
      q('#bk-notes').innerHTML = events.map((e) => `<span class="bk-chip" data-q="${e.q}" data-d="${e.d}" data-n="${e.notes.join(',')}">${e.notes.map(noteName).join('+')} <small>${durName(e.d)}</small></span>`).join('');
      q('#bk-play').disabled = !events.length;
      const seq = ++drawSeq;
      if (!events.length) { q('#bk-osmd').innerHTML = ''; return; }
      const xml = eventsXml(events, { beats: 4, title: 'My melody' });
      q('#bk-osmd').dataset.xml = 'ready';
      const box = q('#bk-osmd');
      if (seq === drawSeq) await drawScore(box, xml);
    };
    q('#bk-quant').onchange = () => { st.quant = +q('#bk-quant').value; persist(); draw(); };
    q('#bk-metro').onchange = (e) => { st.metro = e.target.checked; persist(); };
    q('#bk-rec').onclick = () => {
      if (rec) {
        const t = now();
        for (const n of rec.open.values()) { n.off = t; rec.notes.push(n); }
        rec.metro?.stop();
        take = { notes: rec.notes, spb: rec.spb, t0: rec.t0 };
        rec = null;
        q('#bk-rec').textContent = '● Record'; q('#bk-rec').classList.remove('on');
        q('#bk-msg').textContent = take.notes.length ? `${take.notes.length} notes recorded.` : 'Nothing recorded. Press Record and play.';
        if (take.notes.length) markDone('record');
        draw();
        return;
      }
      player?.stop();
      try { audioCtx(); } catch {}
      const spb = 60 / +tempo.value, start = now();
      rec = { notes: [], open: new Map(), spb, t0: null };
      if (q('#bk-metro').checked) { rec.t0 = start + 200 + 4 * spb * 1000; rec.metro = metronome(start + 200, spb, 4); }
      q('#bk-rec').textContent = '■ Stop'; q('#bk-rec').classList.add('on');
      q('#bk-msg').textContent = rec.metro ? 'Recording: count-in of 4, then play…' : 'Recording… play anything.';
      q('#bk-notes').innerHTML = ''; q('#bk-osmd').innerHTML = ''; q('#bk-play').disabled = true;
    };
    q('#bk-play').onclick = async () => {
      if (player?.playing) { player.stop(); q('#bk-play').textContent = '▶ Play back'; return; }
      player = new ScorePlayer({ notes: events.flatMap((e) => e.notes.map((n) => ({ n, q: e.q, d: e.d, v: 90 }))), bpm: +tempo.value, beats: 4, onEnd: () => { q('#bk-play').textContent = '▶ Play back'; } });
      q('#bk-play').textContent = '■ Stop';
      try { await player.play(); } catch { q('#bk-play').textContent = '▶ Play back'; }
    };
    const off = on((e) => {
      if (!rec) return;
      if (e.type === 'on') { rec.open.set(e.midi, { midi: e.midi, t: e.t, vel: e.vel }); q('#bk-msg').textContent = `Recording… ${rec.notes.length + rec.open.size} notes`; }
      else { const n = rec.open.get(e.midi); if (n) { n.off = e.t; rec.notes.push(n); rec.open.delete(e.midi); } }
    });
    return () => { off(); rec?.metro?.stop(); player?.stop(); };
  },

  fix(live, { on, songP, markDone, isAlive }) {
    loading(live);
    let off = () => {};
    songP.then((song) => {
      if (!isAlive() || !live.isConnected) return;
      const b = song.bars.find((x) => song.mel.some((n) => n.bar === x.i)) || song.bars[0];
      const orig = song.mel.filter((n) => n.bar === b.i).map((n) => ({ ...n }));
      let copy = orig.map((n) => ({ ...n })), sel = 0;
      live.innerHTML = `${songLine(song)}
        <p class="bk-info">A copy of <b>bar ${b.i + 1}</b>, in memory only. This will come to <b>Edit notes</b> later. Nothing is saved.</p>
        <div class="bk-osmd small" id="bk-osmd"></div>
        <div id="bk-stripbox"></div>
        <p class="bk-msg" id="bk-msg"></p>
        <div class="bk-row"><button type="button" id="bk-undo">Undo all</button></div>`;
      const q = (s) => live.querySelector(s);
      let strip;
      const redraw = () => {
        strip = noteStrip(q('#bk-stripbox'), song, copy, { barsShown: [b] });
        strip.chips.forEach((c, i) => { c.classList.toggle('sel', i === sel); c.classList.toggle('changed', copy[i].midi !== orig[i].midi); c.onclick = () => { sel = i; redraw(); }; });
        q('#bk-msg').innerHTML = sel != null && copy[sel] ? `Note ${sel + 1} is <b>${noteName(copy[sel].midi)}</b>. Press a key to change it.` : 'Tap a note.';
        drawScore(q('#bk-osmd'), eventsXml(copy.map((n) => ({ q: n.q - b.q0, d: n.d, notes: [n.midi] })), { beats: b.len }));
      };
      q('#bk-undo').onclick = () => { copy = orig.map((n) => ({ ...n })); sel = 0; redraw(); };
      off = on((e) => {
        if (e.type !== 'on' || sel == null || !copy[sel]) return;
        const was = copy[sel].midi;
        copy[sel].midi = e.midi;
        const i = sel;
        sel = sel + 1 < copy.length ? sel + 1 : sel;
        redraw();
        q('#bk-msg').innerHTML = `Note ${i + 1}: ${noteName(was)} → <b id="bk-changed">${noteName(e.midi)}</b>. ` + (sel !== i ? `Next: note ${sel + 1}.` : 'Tap a note to change another.');
        if (e.midi !== was) markDone('fix');
      });
      redraw();
    });
    return () => off();
  },
};
