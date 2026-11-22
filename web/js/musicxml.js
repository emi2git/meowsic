// Mock scores: build MusicXML (for drawing) and a note list (for playback) from a small tune
// description, in the three versions Emi Music Note produces.
import { chordTones, splitChord, notePc } from './chords.js';

const DIV = 2; // divisions per quarter
const TYPES = { 4: ['whole', 0], 3: ['half', 1], 2: ['half', 0], 1.5: ['quarter', 1], 1: ['quarter', 0], 0.5: ['eighth', 0] };

function pitch(p) {
  const m = p.match(/^([A-G])([#b]?)(\d)$/);
  return { step: m[1], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, octave: +m[3] };
}
export const midiOf = (p) => { const q = pitch(p); return 12 * (q.octave + 1) + notePc(q.step) + q.alter; };

const STEP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const nameOf = (midi) => STEP_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

function noteXml(p, q, { staff, voice = 1, chord = false, lyric = null } = {}) {
  const [type, dot] = TYPES[q] || ['quarter', 0];
  let x = '<note>' + (chord ? '<chord/>' : '');
  if (p === 'r') x += '<rest/>';
  else {
    const t = pitch(p);
    x += `<pitch><step>${t.step}</step>${t.alter ? `<alter>${t.alter}</alter>` : ''}<octave>${t.octave}</octave></pitch>`;
  }
  x += `<duration>${q * DIV}</duration><voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}`;
  if (staff) x += `<staff>${staff}</staff>`;
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

const backup = (q) => `<backup><duration>${q * DIV}</duration></backup>`;

function attrs(tune, staves, clefs) {
  return `<attributes><divisions>${DIV}</divisions><key><fifths>${tune.fifths || 0}</fifths></key>` +
    `<time><beats>${tune.beats}</beats><beat-type>4</beat-type></time>${staves > 1 ? `<staves>${staves}</staves>` : ''}` +
    clefs.map((c, i) => `<clef${staves > 1 ? ` number="${i + 1}"` : ''}><sign>${c[0]}</sign><line>${c[1]}</line></clef>`).join('') + '</attributes>';
}

function melodyPart(tune, { harmony, lyrics }) {
  let li = 0;
  return tune.measures.map((m, i) => {
    let x = `<measure number="${i + 1}">` + (i === 0 ? attrs(tune, 1, [['G', 2]]) + `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tune.bpm}</per-minute></metronome></direction-type><sound tempo="${tune.bpm}"/></direction>` : '');
    if (harmony && m.chord) x += harmonyXml(m.chord);
    for (const [p, q] of m.mel) x += noteXml(p, q, { lyric: lyrics && p !== 'r' ? tune.lyrics?.[li++] : null });
    return x + '</measure>';
  }).join('');
}

function pianoPart(tune, { melody, harmony, easy = false, octave = 0 }) {
  return tune.measures.map((m, i) => {
    const { bass, rh } = voicing(m.chord);
    let x = `<measure number="${i + 1}">` + (i === 0 ? attrs(tune, 2, [['G', 2], ['F', 4]]) : '');
    if (harmony && m.chord) x += harmonyXml(m.chord);
    if (melody) for (const [p, q] of m.mel) x += noteXml(p === 'r' || !octave ? p : nameOf(midiOf(p) + octave), q, { staff: 1 });
    else rh.forEach((p, k) => (x += noteXml(p, tune.beats, { staff: 1, chord: k > 0 })));
    x += backup(tune.beats);
    if (easy || tune.beats === 3) x += noteXml(bass, tune.beats, { staff: 2, voice: 2 });
    else x += noteXml(bass, 2, { staff: 2, voice: 2 }) + noteXml(nameOf(midiOf(bass) + 7), 2, { staff: 2, voice: 2 });
    return x + '</measure>';
  }).join('');
}

const head = (title, parts) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1"><work><work-title>${title}</work-title></work><part-list>${parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${p}</part-name></score-part>`).join('')}</part-list>`;

export const VERSIONS = { original: 'Original', vocal: 'Piano + vocals', lead: 'Lead sheet', duet: 'Piano duet', accomp: 'Piano accompaniment', easy: 'Piano easy', pro: 'Piano pro' };
export const VERSION_HELP = { original: 'What is played in the recording, both hands', vocal: 'Melody with lyrics above the piano', lead: 'Melody, lyrics and chord names',
  duet: 'Two players: melody up high, accompaniment below', accomp: 'Only the accompaniment, no melody', easy: 'Simpler left hand, fewer notes', pro: 'Fuller chords for advanced players' };

export function musicXml(tune, version) {
  if (version === 'lead') return head(tune.title, ['Melody']) + `<part id="P1">${melodyPart(tune, { harmony: true, lyrics: true })}</part></score-partwise>`;
  if (version === 'vocal') return head(tune.title, ['Voice', 'Piano']) +
    `<part id="P1">${melodyPart(tune, { harmony: true, lyrics: true })}</part><part id="P2">${pianoPart(tune, { melody: false })}</part></score-partwise>`;
  if (version === 'duet') return head(tune.title, ['Primo', 'Secondo']) +
    `<part id="P1">${pianoPart(tune, { melody: true, octave: 12 })}</part><part id="P2">${pianoPart(tune, { melody: false, harmony: true })}</part></score-partwise>`;
  if (version === 'accomp') return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: false, harmony: true })}</part></score-partwise>`;
  if (version === 'easy') return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: true, harmony: true, easy: true })}</part></score-partwise>`;
  return head(tune.title, ['Piano']) + `<part id="P1">${pianoPart(tune, { melody: true, harmony: true })}</part></score-partwise>`;
}

// playback notes in quarter-note time: [{q, d, n, v}]
export function tuneNotes(tune, version) {
  const out = [];
  tune.measures.forEach((m, i) => {
    const q0 = i * tune.beats;
    let q = q0;
    if (version !== 'accomp') for (const [p, d] of m.mel) { if (p !== 'r') out.push({ q, d, n: midiOf(p) + (version === 'duet' ? 12 : 0), v: 96 }); q += d; }
    const { bass, rh } = voicing(m.chord);
    if (version === 'easy' || tune.beats === 3) out.push({ q: q0, d: tune.beats, n: midiOf(bass), v: 70 });
    else { out.push({ q: q0, d: 2, n: midiOf(bass), v: 70 }); out.push({ q: q0 + 2, d: 2, n: midiOf(bass) + 7, v: 62 }); }
    if (['vocal', 'duet', 'accomp', 'pro'].includes(version)) rh.forEach((p) => out.push({ q: q0, d: tune.beats, n: midiOf(p), v: 52 }));
  });
  return out.sort((a, b) => a.q - b.q);
}
