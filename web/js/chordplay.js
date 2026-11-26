// Play the chord symbols (MusicXML <harmony>, the names above the bars) as piano chords with the score (the score
// toolbar's "Chords" toggle). The chord grammar mirrors server/meowsic/chordname.py (parse, tones; omr.py's grammar)
// and the reading of a <harmony> its name_of; server/tests/test_chordplay.py runs this file in node and checks it
// gives the same tones as the Python for a list of names. No DOM here (node can import it).
//
// voicing(name) -> { bass, upper }: the root (or slash bass) between C2 and B2, and the chord in close root position
//   from its root between B♭2 and A3 with up to three tones above it (the third / sus tone and the seventh first, the
//   fifth dropped first, as chordops.voicing orders them), so it sits under the melody.
// chordEvents(chords, barQ, endQ) -> [{q, d, n, v}]: each chord held until the next chord name or the end of the bar,
//   struck again on beat 1 of each bar it lasts through; N.C. is silence. A bit softer than the melody (v 90).

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC = (a) => ({ '#': 1, b: -1 }[a] || 0);
const CHORD_RE = /^(?<root>[A-G])(?<acc>[#b]?)(?<qual>maj|ma|M|Δ|min|mi|m|dim|°|o|aug|\+|ø|sus)?(?<ext>6\/9|69|13|11|9|7|6|5|4|2)?(?<alt>(?:\(?(?:add|sus|maj|M|b|#|\+)?(?:13|11|9|7|6|5|4|2)\)?|sus)*)(?:\/(?<bass>[A-G][#b]?))?$/;
const QUAL = { maj: 'maj', ma: 'maj', M: 'maj', 'Δ': 'maj', min: 'm', mi: 'm', m: 'm', dim: 'dim', '°': 'dim', o: 'dim', aug: 'aug', '+': 'aug', 'ø': 'm7b5', sus: 'sus' };
const NAME_RE = /^(?<root>[A-G])(?<acc>[#b]?)(?<q>m7b5|mmaj7|maj|m|dim|aug|sus2|sus4)?(?<ext>69|13|11|9|7|6|5)?(?<alt>.*?)(?:\/(?<bass>[A-G][#b]?))?$/;

// a chord name in the grammar → its plain spelling ('Bbm7', 'C/E', 'N.C.'); null if it is not one (chordname.parse)
export function parse(tok) {
  const t = String(tok || '').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/ /g, '');
  if (/^N\.?C\.?$/.test(t)) return 'N.C.';
  const m = t.match(CHORD_RE);
  if (!m) return null;
  const g = m.groups;
  let q = QUAL[g.qual || ''] || '', ext = (g.ext || '').replace('6/9', '69'), alt = (g.alt || '').replace(/[()]/g, '').replace(/\+/g, '#');
  if (q === 'maj' && !ext && !alt) q = '';
  if (q === 'm7b5') { ext = ext === '7' ? '' : ext; }
  if (q === 'aug' && ext) { q = ''; ext += '#5'; }
  if (q === 'sus' && (ext === '2' || ext === '4')) { q = 'sus' + ext; ext = ''; }
  if (q === 'sus' && ext && !alt.startsWith('sus')) { q = ''; alt = 'sus4' + alt; }
  if (ext === '5' && !q && !alt) return null;
  return g.root + g.acc + q + ext + alt + (g.bass ? '/' + g.bass : '');
}

// quality + extension → intervals (chordname.KINDS)
const KINDS = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim: [0, 3, 6], dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], aug: [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 11: [0, 4, 7, 10, 14, 17], 13: [0, 4, 7, 10, 14, 21],
  mmaj7: [0, 3, 7, 11], 5: [0, 7], 69: [0, 4, 7, 9, 14], m69: [0, 3, 7, 9, 14], maj: [0, 4, 7], dim9: [0, 3, 6, 9],
  m11: [0, 3, 7, 10, 14, 17], m13: [0, 3, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21], maj11: [0, 4, 7, 11, 14, 17], aug7: [0, 4, 8, 10] };
const SEMIS = { 2: 2, 4: 5, 5: 7, 6: 9, 7: 10, 9: 14, 11: 17, 13: 21 };

// (root pc, intervals above the root, bass pc) of a chord name; null for N.C. / not a chord (chordname.tones)
export function tones(name) {
  if (!name || name === 'N.C.') return null;
  const m = String(name).replace(/sus(?!\d)/g, 'sus4').match(NAME_RE); // a bare "sus" is sus4 (Csus, C7sus)
  if (!m) return null;
  const g = m.groups;
  let key = (g.q || '') + (g.ext || '');
  if (!(key in KINDS)) key = (g.q || '') in KINDS ? g.q || '' : '';
  let iv = [...KINDS[key]];
  for (const [, how, n] of (g.alt || '').matchAll(/(add|sus|b|#)?(13|11|9|7|6|5|4|2)/g)) {
    const semis = SEMIS[n];
    if (how === 'sus') iv = [...iv.filter((x) => x !== 3 && x !== 4), semis];
    else if (how === 'b' || how === '#') {
      const d = how === 'b' ? -1 : 1;
      if (n === '5' && iv.includes(7)) iv[iv.indexOf(7)] = 7 + d; else iv.push(semis + d);
    } else iv.push(semis);
  }
  iv = [...new Set(iv)].sort((a, b) => a - b);
  const root = (((STEP[g.root] + ACC(g.acc)) % 12) + 12) % 12;
  const bass = g.bass ? (((STEP[g.bass[0]] + ACC(g.bass.slice(1))) % 12) + 12) % 12 : root;
  return [root, iv, bass];
}

// the name a <harmony> shows, from its parts (chordname.name_of; chordfind.KIND_SUFFIX)
const KIND_SUFFIX = { major: '', minor: 'm', dominant: '7', 'dominant-seventh': '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
  diminished: 'dim', 'diminished-seventh': 'dim7', 'half-diminished': 'm7b5', augmented: 'aug', 'suspended-fourth': 'sus4',
  'suspended-second': 'sus2', 'major-sixth': '6', 'minor-sixth': 'm6', 'dominant-ninth': '9', power: '5', none: 'N.C.',
  // MusicXML kinds chordfind does not name: their chordname.KINDS spelling
  'major-ninth': 'maj9', 'minor-ninth': 'm9', 'dominant-11th': '11', 'dominant-13th': '13', 'major-minor': 'mmaj7',
  'minor-11th': 'm11', 'minor-13th': 'm13', 'major-13th': 'maj13', 'major-11th': 'maj11', 'augmented-seventh': 'aug7' };
const accOf = (x) => ({ 1: '#', '-1': 'b' }[Math.round(+x || 0)] || '');
export function harmonyName({ rootStep, rootAlter, kind, kindText, bassStep, bassAlter }) {
  if ((kind || '').trim() === 'none') return 'N.C.';
  const rs = (rootStep || '').trim();
  if (!rs) return '';
  const suf = kindText != null ? kindText.replace(/♭/g, 'b').replace(/♯/g, '#') : KIND_SUFFIX[(kind || 'major').trim()] ?? '';
  const bs = (bassStep || '').trim();
  return rs + accOf(rootAlter) + suf + (bs ? '/' + bs + accOf(bassAlter) : '');
}

// bass C2–B2 (MIDI 36–47; an octave lower if it would not be under the chord); the chord's root B♭2–A3 (46–57)
export function voicing(name) {
  const t = tones(parse(name) || name);
  if (!t) return null;
  const [root, iv, bassPc] = t;
  const r = 46 + ((root - 46) % 12 + 12) % 12;
  let bass = 36 + bassPc;
  if (bass >= r) bass -= 12;
  // chordops.voicing's order: the third, then the seventh / sixth, then the fifth; added tones last
  const rank = (i) => ({ 3: 0, 4: 0, 2: 0, 5: 0, 10: 1, 11: 1, 9: 1, 6: 2, 7: 2, 8: 2 }[i] ?? 3);
  const pcs = [...new Set(iv.map((i) => i % 12).filter((i) => i))];
  const keep = pcs.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  const upper = [r, ...keep.map((i) => r + i)].sort((a, b) => a - b);
  return { bass, upper };
}

const BASS_V = 58, UPPER_V = 48;
// chords: [{q, name}] in score time (quarters), in order; barQ: where each bar starts; endQ: the end of the score
export function chordEvents(chords, barQ, endQ) {
  const out = [];
  const cs = [...chords].sort((a, b) => a.q - b.q);
  const bars = [...barQ, endQ];
  cs.forEach((c, k) => {
    const v = c.name === 'N.C.' ? null : voicing(c.name);
    if (!v) return;
    const to = k + 1 < cs.length ? cs[k + 1].q : endQ;
    // cut at each bar line: struck again on beat 1
    const cuts = [c.q, ...bars.filter((b) => b > c.q + 1e-6 && b < to - 1e-6), to];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const q = cuts[i], d = cuts[i + 1] - q;
      if (d <= 1e-6) continue;
      out.push({ q, d, n: v.bass, v: BASS_V, chord: c.name });
      for (const n of v.upper) out.push({ q, d, n, v: UPPER_V, chord: c.name });
    }
  });
  return out;
}
