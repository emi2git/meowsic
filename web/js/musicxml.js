// Mock scores: build MusicXML (for drawing) and a note list (for playback) from a small tune
// description, in the three versions Emi Music Note produces.
import { chordTones, splitChord, notePc } from './chords.js';

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
export const VERSION_HELP = { original: 'What is played in the recording, both hands', vocal: 'Melody with lyrics above the piano', lead: 'Melody, lyrics and chord names',
  duet: 'Two players: melody up high, accompaniment below', accomp: 'Only the accompaniment, no melody', clear: 'Both hands as written, one note at a time (the top note on the right, the bass note on the left)', pro: 'Fuller chords for advanced players' };

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

// playback notes in quarter-note time: [{q, d, n, v}]
export function tuneNotes(tune, version) {
  const out = [];
  let q0 = 0;
  tune.measures.forEach((m) => {
    const mb = barBeats(tune, m);
    let q = q0;
    if (version !== 'accomp') for (const [p, d] of m.mel) { if (p !== 'r') out.push({ q, d, n: midiOf(p) + (version === 'duet' ? 12 : 0), v: 96 }); q += d; }
    const { bass, rh } = voicing(m.chord);
    if (version === 'easy' || version === 'clear' || mb !== 4) out.push({ q: q0, d: mb, n: midiOf(bass), v: 70 });
    else { out.push({ q: q0, d: 2, n: midiOf(bass), v: 70 }); out.push({ q: q0 + 2, d: 2, n: midiOf(bass) + 7, v: 62 }); }
    if (['vocal', 'duet', 'accomp', 'pro'].includes(version)) rh.forEach((p) => out.push({ q: q0, d: mb, n: midiOf(p), v: 52 }));
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
  for (const part of doc.querySelectorAll('part')) {
    let div = 1, t = 0; // t in divisions
    for (const m of part.querySelectorAll(':scope > measure')) {
      let last = t;
      for (const el of m.children) {
        if (el.tagName === 'attributes') {
          div = +(el.querySelector('divisions')?.textContent || div);
          const b = el.querySelector('time > beats');
          if (b && !notes.length) beats = +b.textContent || beats;
        } else if (el.tagName === 'sound' || el.tagName === 'direction') {
          const s = el.tagName === 'sound' ? el : el.querySelector('sound');
          if (s?.getAttribute('tempo') && !bpm) bpm = +s.getAttribute('tempo');
        } else if (el.tagName === 'backup') t -= +el.querySelector('duration').textContent;
        else if (el.tagName === 'forward') t += +el.querySelector('duration').textContent;
        else if (el.tagName === 'note') {
          const d = +(el.querySelector('duration')?.textContent || 0);
          const chord = !!el.querySelector('chord');
          const start = chord ? last : t;
          const p = el.querySelector('pitch');
          if (p && !el.querySelector('rest') && !el.querySelector('tie[type="stop"]')) {
            const midi = 12 * (+p.querySelector('octave').textContent + 1) + STEP_PC[p.querySelector('step').textContent] + +(p.querySelector('alter')?.textContent || 0);
            notes.push({ q: start / div, d: d / div, n: midi, v: 90 });
          }
          if (!chord) { last = t; t += d; }
          end = Math.max(end, t / div);
        }
      }
    }
  }
  return { notes: notes.sort((a, b) => a.q - b.q), bpm: bpm || 100, beats, totalQ: end };
}
