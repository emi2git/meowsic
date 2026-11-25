// Mock scores: build MusicXML (for drawing) and a note list (for playback) from a small tune
// description, in the three versions Emi Music Note produces.
import { chordTones, splitChord, notePc } from './chords.js';
import { harmonyName } from './chordplay.js';

const DIV = 12; // divisions per quarter: room for 16ths (3) and triplets (4 = triplet eighth)
// length in twelfths of a beat → [type, dotted, triplet]
const TYPES = { 48: ['whole', 0], 36: ['half', 1], 24: ['half', 0], 18: ['quarter', 1], 12: ['quarter', 0], 9: ['eighth', 1], 6: ['eighth', 0], 3: ['16th', 0],
  16: ['half', 0, 1], 8: ['quarter', 0, 1], 4: ['eighth', 0, 1], 2: ['16th', 0, 1] };
export const twelfths = (q) => Math.round(q * 12);
export const isTriplet = (q) => !!TYPES[twelfths(q)]?.[2];

function pitch(p) {
  const m = p.match(/^([A-G])([#b]?)(\d)$/);
  return { step: m[1], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, octave: +m[3] };
}
export const midiOf = (p) => { const q = pitch(p); return 12 * (q.octave + 1) + notePc(q.step) + q.alter; };

const STEP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const nameOf = (midi) => STEP_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

function noteXml(p, q, { staff, voice = 1, chord = false, lyric = null, tup = null } = {}) {
  const [type, dot, trip] = TYPES[twelfths(q)] || ['quarter', 0];
  let x = '<note>' + (chord ? '<chord/>' : '');
  if (p === 'r') x += '<rest/>';
  else {
    const t = pitch(p);
    x += `<pitch><step>${t.step}</step>${t.alter ? `<alter>${t.alter}</alter>` : ''}<octave>${t.octave}</octave></pitch>`;
  }
  x += `<duration>${twelfths(q)}</duration><voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}`;
  if (trip) x += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  if (staff) x += `<staff>${staff}</staff>`;
  if (tup) x += `<notations><tuplet type="${tup}" bracket="yes"/></notations>`;
  if (lyric) x += `<lyric><syllabic>single</syllabic><text>${lyric}</text></lyric>`;
  return x + '</note>';
}

function harmonyXml(ch) {
  const c = splitChord(ch);
  if (!c) return '';
  const kind = { '': 'major', m: 'minor', 7: 'dominant', m7: 'minor-seventh', maj7: 'major-seventh' }[c.suffix] || 'major';
  const alter = c.root[1] === '#' ? 1 : c.root[1] === 'b' ? -1 : 0;
  return `<harmony><root><root-step>${c.root[0]}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root><kind>${kind}</kind></harmony>`;
}

// chord -> bass note name (octave 3) and a right-hand triad (around octave 4)
function voicing(ch) {
  const c = splitChord(ch);
  const root = notePc(c.root);
  const bass = nameOf(48 + root);
  const tones = chordTones(ch).slice(0, 3);
  const rh = tones.map((t) => nameOf(60 + ((t - 0 + 12) % 12) + (t < 5 ? 12 : 0))).sort((a, b) => midiOf(a) - midiOf(b));
  return { bass, rh };
}

const backup = (q) => `<backup><duration>${twelfths(q)}</duration></backup>`;

// beats in bar i: its notes decide (a bar edited to 5 beats becomes 5/4); empty bars use the song's meter
export const barBeats = (tune, m) => { const sum = Math.round(m.mel.reduce((s, [, d]) => s + d, 0) * 12) / 12; return sum > 0 ? sum : tune.beats; };
export const meterOf = (b) => { for (const t of [4, 8, 16]) { const n = b * (t / 4); if (Math.abs(n - Math.round(n)) < 1e-6) return [Math.round(n), t]; } return [Math.round(b * 4), 16]; };
const timeXml = (b) => { const [n, t] = meterOf(b); return `<time><beats>${n}</beats><beat-type>${t}</beat-type></time>`; };
const meterChange = (tune, i) => { const b = barBeats(tune, tune.measures[i]); return i > 0 && b !== barBeats(tune, tune.measures[i - 1]) ? `<attributes>${timeXml(b)}</attributes>` : ''; };
// split a length into note values that can be written (4, 3, 2, 1.5, 1, 0.5)
const pieces = (q) => { const out = []; for (const v of [4, 3, 2, 1.5, 1, 0.5, 0.25]) while (q >= v - 1e-6) { out.push(v); q -= v; } return out; };

function attrs(tune, staves, clefs) {
  return `<attributes><divisions>${DIV}</divisions><key><fifths>${tune.fifths || 0}</fifths></key>` +
    `${timeXml(barBeats(tune, tune.measures[0]))}${staves > 1 ? `<staves>${staves}</staves>` : ''}` +
    clefs.map((c, i) => `<clef${staves > 1 ? ` number="${i + 1}"` : ''}><sign>${c[0]}</sign><line>${c[1]}</line></clef>`).join('') + '</attributes>';
}

function melodyPart(tune, { harmony, lyrics }) {
  let li = 0;
  return tune.measures.map((m, i) => {
    let x = `<measure number="${i + 1}">` + meterChange(tune, i) + (i === 0 ? attrs(tune, 1, [['G', 2]]) + `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tune.bpm}</per-minute></metronome></direction-type><sound tempo="${tune.bpm}"/></direction>` : '');
    if (harmony && m.chord && (i === 0 || tune.measures[i - 1].chord !== m.chord)) x += harmonyXml(m.chord); // chord name only where it changes
    let tc = 0;
    for (const [p, q] of m.mel) { const tup = isTriplet(q) ? ['start', null, 'stop'][tc++ % 3] : ((tc = 0), null); x += noteXml(p, q, { lyric: lyrics && p !== 'r' ? tune.lyrics?.[li++] : null, tup }); }
    return x + '</measure>';
  }).join('');
}

function pianoPart(tune, { melody, harmony, easy = false, octave = 0 }) {
  return tune.measures.map((m, i) => {
    const { bass, rh } = voicing(m.chord);
    const mb = barBeats(tune, m);
    let x = `<measure number="${i + 1}">` + meterChange(tune, i) + (i === 0 ? attrs(tune, 2, [['G', 2], ['F', 4]]) : '');
    if (harmony && m.chord && (i === 0 || tune.measures[i - 1].chord !== m.chord)) x += harmonyXml(m.chord); // chord name only where it changes
    let tc = 0;
    if (melody) for (const [p, q] of m.mel) { const tup = isTriplet(q) ? ['start', null, 'stop'][tc++ % 3] : ((tc = 0), null); x += noteXml(p === 'r' || !octave ? p : nameOf(midiOf(p) + octave), q, { staff: 1, tup }); }
    else for (const d of pieces(mb)) rh.forEach((p, k) => (x += noteXml(p, d, { staff: 1, chord: k > 0 })));
    x += backup(mb);
    if (easy || mb !== 4) for (const d of pieces(mb)) x += noteXml(bass, d, { staff: 2, voice: 2 });
    else x += noteXml(bass, 2, { staff: 2, voice: 2 }) + noteXml(nameOf(midiOf(bass) + 7), 2, { staff: 2, voice: 2 });
    return x + '</measure>';
  }).join('');
}

const head = (title, parts) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1"><work><work-title>${title}</work-title></work><part-list>${parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${p}</part-name></score-part>`).join('')}</part-list>`;

export const VERSIONS = { original: 'Original', clear: 'Simple Piano', lead: 'Lead sheet' };
// older entries may still be 'Piano easy': readable by name, but no longer offered (not enumerable)
Object.defineProperty(VERSIONS, 'easy', { value: 'Piano easy', enumerable: false });
// no longer offered; old scores keep their label
for (const [k, v] of Object.entries({ vocal: 'Piano + vocals', duet: 'Piano duet', accomp: 'Piano accompaniment', pro: 'Piano pro' })) Object.defineProperty(VERSIONS, k, { value: v, enumerable: false });

export function musicXml(tune, version) {
  if (version === 'lead') return head(tune.title, ['Melody']) + `<part id="P1">${melodyPart(tune, { harmony: true, lyrics: true })}</part></score-partwise>`;
  if (version === 'vocal') return head(tune.title, ['Voice', 'Piano']) +
    `<part id="P1">${melodyPart(tune, { harmony: true, lyrics: true })}</part><part id="P2">${pianoPart(tune, { melody: false })}</part></score-partwise>`;
  if (version === 'duet') return head(tune.title, ['Primo', 'Secondo']) +
    `<part id="P1">${pianoPart(tune, { melody: true, octave: 12 })}</part><part id="P2">${pianoPart(tune, { melody: false, harmony: true })}</part></score-partwise>`;
  if (version === 'accomp') return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: false, harmony: true })}</part></score-partwise>`;
  if (version === 'easy' || version === 'clear') return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: true, harmony: true, easy: true })}</part></score-partwise>`;
  return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: true, harmony: true })}</part></score-partwise>`;
}

// playback notes in quarter-note time: [{q, d, n, v, s}] (s: 0 = the top staff, 1 = the bass staff)
export function tuneNotes(tune, version) {
  const out = [];
  let q0 = 0;
  tune.measures.forEach((m) => {
    const mb = barBeats(tune, m);
    let q = q0;
    if (version !== 'accomp') for (const [p, d] of m.mel) { if (p !== 'r') out.push({ q, d, n: midiOf(p) + (version === 'duet' ? 12 : 0), v: 96, s: 0 }); q += d; }
    const { bass, rh } = voicing(m.chord);
    if (version === 'easy' || version === 'clear' || mb !== 4) out.push({ q: q0, d: mb, n: midiOf(bass), v: 70, s: 1 });
    else { out.push({ q: q0, d: 2, n: midiOf(bass), v: 70, s: 1 }); out.push({ q: q0 + 2, d: 2, n: midiOf(bass) + 7, v: 62, s: 1 }); }
    if (['vocal', 'duet', 'accomp', 'pro'].includes(version)) rh.forEach((p) => out.push({ q: q0, d: mb, n: midiOf(p), v: 52, s: 0 }));
    q0 += mb;
  });
  return out.sort((a, b) => a.q - b.q);
}

// ---- real scores: read notes, tempo and meter out of any MusicXML (for playback) ----
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function xmlInfo(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const notes = [];
  let bpm = 0, beats = 4, end = 0;
  const barQ = []; // where each bar of the first part starts, in quarters
  const marks = []; // repeats and endings of each bar of the first part (playOrder)
  let chords = null; // the chord names (<harmony>) of the first part that has any: [{q, name}]
  const partStaves = []; // how many staves each part has; a note's s = its staff counted over all parts (0 = the top one)
  let sBase = 0;
  for (const part of doc.querySelectorAll('part')) {
    const first = !barQ.length;
    let nst = 1;
    const hs = [];
    if (first) marks.push(...barMarks(part));
    let div = 1, t = 0; // t in divisions
    const tied = new Map(); // MIDI note → the sounding note a tie carries on
    for (const m of part.querySelectorAll(':scope > measure')) {
      let last = t;
      if (first) barQ.push(t / div);
      for (const el of m.children) {
        if (el.tagName === 'attributes') {
          div = +(el.querySelector('divisions')?.textContent || div);
          nst = Math.max(nst, +(el.querySelector('staves')?.textContent || 1) || 1);
          const b = el.querySelector('time > beats');
          if (b && !notes.length) beats = +b.textContent || beats;
        } else if (el.tagName === 'sound' || el.tagName === 'direction') {
          const s = el.tagName === 'sound' ? el : el.querySelector('sound');
          if (s?.getAttribute('tempo') && !bpm) bpm = +s.getAttribute('tempo');
        } else if (el.tagName === 'harmony') {
          const tx = (s) => el.querySelector(s)?.textContent ?? '';
          const k = el.querySelector(':scope > kind');
          const name = harmonyName({ rootStep: tx('root > root-step'), rootAlter: tx('root > root-alter'), kind: k?.textContent || 'major',
            kindText: k && k.hasAttribute('text') ? k.getAttribute('text') : null, bassStep: tx('bass > bass-step'), bassAlter: tx('bass > bass-alter') });
          if (name) hs.push({ q: (t + +(tx(':scope > offset') || 0)) / div, name });
        } else if (el.tagName === 'backup') t -= +el.querySelector('duration').textContent;
        else if (el.tagName === 'forward') t += +el.querySelector('duration').textContent;
        else if (el.tagName === 'note') {
          const d = +(el.querySelector('duration')?.textContent || 0);
          const chord = !!el.querySelector('chord');
          const start = chord ? last : t;
          const p = el.querySelector('pitch');
          const sk = Math.max(1, +(el.querySelector(':scope > staff')?.textContent || 1) || 1);
          nst = Math.max(nst, sk);
          if (p && !el.querySelector('rest')) {
            const midi = 12 * (+p.querySelector('octave').textContent + 1) + STEP_PC[p.querySelector('step').textContent] + +(p.querySelector('alter')?.textContent || 0);
            const tieOf = (k) => el.querySelector(`tie[type="${k}"], notations > tied[type="${k}"]`);
            // a tie joins the sound: the tied-to note lengthens the one it is tied from (no new attack)
            const held = tieOf('stop') && tied.get(midi);
            if (held) held.d = start / div + d / div - held.q;
            else if (!tieOf('stop')) { const nt = { q: start / div, d: d / div, n: midi, v: 90, s: sBase + sk - 1 }; notes.push(nt); if (tieOf('start')) tied.set(midi, nt); }
            if (held && !tieOf('start')) tied.delete(midi);
            else if (held) tied.set(midi, held);
          }
          if (!chord) { last = t; t += d; }
          end = Math.max(end, t / div);
        }
      }
    }
    partStaves.push(nst); sBase += nst;
    if (!chords && hs.length) chords = hs.sort((a, b) => a.q - b.q).filter((h, i, a) => !i || Math.abs(h.q - a[i - 1].q) > 1e-6);
  }
  // the bars as they are played (repeats, 1st / 2nd endings): [[from, to] in quarters] for the player, or null
  const order = playOrder(marks);
  let segments = null;
  if (marks.some((m) => m.start || m.end || m.ending)) {
    segments = [];
    const barEnd = (i) => (i + 1 < barQ.length ? barQ[i + 1] : Math.max(end, barQ[i] || 0));
    for (const [i] of order) {
      const a = barQ[i], z = barEnd(i), last = segments.at(-1);
      if (last && Math.abs(last[1] - a) < 1e-6) last[1] = z; else segments.push([a, z]);
    }
  }
  return { notes: notes.sort((a, b) => a.q - b.q), bpm: bpm || 100, beats, totalQ: end, barQ, order, segments, chords: chords || [], staves: staffLabels(partStaves) };
}

// the staves' names for the hand picker (hands.js): a two-staff part is a piano (R over L); a one-staff part beside
// a piano is a voice (V); anything else is numbered. partStaves: [staves of each part, in score order]
export function staffLabels(partStaves) {
  const total = partStaves.reduce((a, b) => a + b, 0);
  if (total === 2) return ['R', 'L']; // two staves: the top one is the right hand
  const pianos = partStaves.filter((k) => k === 2).length, voices = partStaves.filter((k) => k === 1).length;
  const out = []; let pn = 0, vn = 0, i = 0;
  for (const k of partStaves) {
    for (let j = 0; j < k; j++) {
      i++;
      if (k === 2) { pn++; const suf = pianos > 1 ? String(Math.ceil(pn / 2)) : ''; out.push((j ? 'L' : 'R') + suf); }
      else if (k === 1 && total > 1 && pianos) { vn++; out.push(voices > 1 ? `V${vn}` : 'V'); }
      else out.push(String(i));
    }
  }
  return out;
}

// ---- repeats and endings (the same rules as server/meowsic/structops.py play_order) ----
const nums = (s) => { const out = []; for (const x of String(s || '1').replace(/[\s.]/g, '').split(',')) { const r = x.split('-'); if (r.length === 2 && +r[0] && +r[1]) for (let k = +r[0]; k <= +r[1]; k++) out.push(k); else if (+x) out.push(+x); } return out.length ? out : [1]; };
export function barMarks(part) {
  const ms = [...part.querySelectorAll(':scope > measure')];
  const out = ms.map(() => ({ start: false, end: false, times: 2, ending: null }));
  let cur = null;
  const brackets = [];
  ms.forEach((m, i) => {
    for (const b of m.querySelectorAll(':scope > barline')) {
      const r = b.querySelector('repeat');
      if (r?.getAttribute('direction') === 'forward') out[i].start = true;
      else if (r) { out[i].end = true; out[i].times = Math.max(2, +(r.getAttribute('times') || 2) || 2); }
      const e = b.querySelector('ending');
      if (!e) continue;
      if (e.getAttribute('type') === 'start') cur = { a: i, nums: nums(e.getAttribute('number')) };
      else if (cur) { brackets.push({ ...cur, z: i }); cur = null; }
    }
  });
  if (cur) brackets.push({ ...cur, z: ms.length - 1 });
  for (const br of brackets) for (let i = br.a; i <= br.z; i++) out[i].ending = br;
  return out;
}
// octave lines (8va / 8vb, octaveops.py) of a <part>: { staff: [shift of each bar] } (8, -8, 15, -15; 0 = none).
// Only the drawing: the <pitch> under one is still what sounds. A stop at the very start of a bar ends the line on
// the bar before; a line never stopped runs to the end.
export function ottavaBars(part) {
  const ms = [...part.querySelectorAll(':scope > measure')], out = {}, open = new Map();
  const put = (o, z) => { const a = (out[o.staff] ||= ms.map(() => 0)); for (let i = o.a; i <= z; i++) a[i] = o.shift; };
  ms.forEach((m, bi) => {
    let t = 0;
    for (const el of m.children) {
      if (el.tagName === 'backup') t -= +el.querySelector('duration').textContent;
      else if (el.tagName === 'forward') t += +el.querySelector('duration').textContent;
      else if (el.tagName === 'note') { if (!el.querySelector('grace') && !el.querySelector('chord')) t += +(el.querySelector('duration')?.textContent || 0); }
      else if (el.tagName === 'direction') {
        const staff = +(el.querySelector(':scope > staff')?.textContent || 1) || 1;
        for (const o of el.querySelectorAll(':scope > direction-type > octave-shift')) {
          const type = o.getAttribute('type'), key = `${staff}|${o.getAttribute('number') || 1}`;
          if (type === 'up' || type === 'down') {
            if (open.has(key)) put(open.get(key), bi);
            open.set(key, { staff, a: bi, shift: (+o.getAttribute('size') === 15 ? 15 : 8) * (type === 'down' ? 1 : -1) });
          } else if (type === 'stop' && open.has(key)) { const x = open.get(key); open.delete(key); put(x, t === 0 && bi > x.a ? bi - 1 : bi); }
        }
      }
    }
  });
  for (const x of open.values()) put(x, ms.length - 1);
  return out;
}
// [[bar index, time through]] in the order they are played
export function playOrder(marks) {
  const brackets = [...new Set(marks.map((m) => m.ending).filter(Boolean))].sort((x, y) => x.a - y.a);
  const out = [], count = new Map();
  let i = 0, start = 0, pass = 1, guard = 0;
  while (i < marks.length && guard++ < 10000) {
    const mk = marks[i], e = mk.ending;
    if (mk.start && i !== start) { start = i; pass = 1; }
    if (e && e.a === i && !e.nums.includes(pass)) {
      const chain = [e];
      let k = brackets.indexOf(e);
      while (k + 1 < brackets.length && brackets[k + 1].a === chain.at(-1).z + 1) chain.push(brackets[++k]);
      const nx = chain.slice(1).find((c) => c.nums.includes(pass));
      if (nx) i = nx.a; else { i = chain.at(-1).z + 1; start = i; pass = 1; }
      continue;
    }
    out.push([i, pass]);
    if (mk.end) {
      const c = count.get(i) || 0;
      if (c < mk.times - 1) { count.set(i, c + 1); pass++; i = start; continue; }
      count.set(i, 0);
      if (!e) { start = i + 1; pass = 1; }
    }
    if (e && e.z === i && !mk.end) {
      const k = brackets.indexOf(e);
      if (!(k + 1 < brackets.length && brackets[k + 1].a === i + 1)) { start = i + 1; pass = 1; }
    }
    i++;
  }
  return out;
}
