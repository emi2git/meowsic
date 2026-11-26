// Play the chord symbols (MusicXML <harmony>, the names above the bars) as a soft pad with the score (the score
// toolbar's C part toggle, hands.js; the sound is audio.js padVoice). The chord grammar mirrors server/meowsic/chordname.py (parse, tones; omr.py's grammar)
// and the reading of a <harmony> its name_of; server/tests/test_chordplay.py runs this file in node and checks it
// gives the same tones as the Python for a list of names. No DOM here (node can import it).
//
// voicing(name) -> { bass, upper }: a close-position block chord in C3–C5, the root (or slash bass) at the bottom
//   (C3–B3) and the other tones just above it (the third / sus tone and the seventh first, the fifth dropped first,
//   as chordops.voicing orders them).
// chordEvents(chords, barQ, endQ) -> [{q, d, n, v}]: each chord struck on its change and held until the next chord
//   name; N.C. is silence. The pad plays it about 9 dB under the melody (audio.js).

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

// close-position block chord in the middle register (C3–C5): the root (or slash bass) as the lowest note, C3–B3
// (MIDI 48–59), and the chord's tones just above it within the octave — the root on top, then the third / sus tone
// and the seventh / sixth, the fifth dropped first when there are more than four (chordops.voicing's order)
export function voicing(name) {
  const t = tones(parse(name) || name);
  if (!t) return null;
  const [root, iv, bassPc] = t;
  const bass = 48 + bassPc;
  const rank = (i) => ({ 3: 0, 4: 0, 2: 0, 5: 0, 10: 1, 11: 1, 9: 1, 6: 2, 7: 2, 8: 2 }[i] ?? 3);
  const pcs = [...new Set(iv.map((i) => i % 12).filter((i) => i))];
  const keep = pcs.sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((i) => (root + i) % 12);
  const above = (pc) => bass + 1 + ((pc - bass - 1) % 12 + 12) % 12; // the first one above the bass
  const upper = [...new Set([root, ...keep].filter((pc) => pc !== bassPc || pc === root).map(above))].sort((a, b) => a - b);
  return { bass, upper };
}

const PAD_V = 64;
// chords: [{q, name}] in score time (quarters), in order; barQ: where each bar starts (kept for callers); endQ: the end
// of the score. Each chord sounds from its change and is held until the next chord name (or N.C., or the end).
export function chordEvents(chords, barQ, endQ) {
  const out = [];
  const cs = [...chords].sort((a, b) => a.q - b.q);
  cs.forEach((c, k) => {
    const v = c.name === 'N.C.' ? null : voicing(c.name);
    if (!v) return;
    const d = (k + 1 < cs.length ? cs[k + 1].q : endQ) - c.q;
    if (d <= 1e-6) return;
    for (const n of [v.bass, ...v.upper]) out.push({ q: c.q, d, n, v: PAD_V, chord: c.name });
  });
  return out;
}

// The chords strip while playing (ukepanel.js): the chord sounding at q and the next ones in the order they are
// played: through repeats, endings, D.S. / coda (segments, as ScorePlayer plays them) or round and round an A–B loop.
// A chord named again right after itself counts once. chords: [{q, name}] (no N.C.); segments: [[a, z], …] or null;
// seg: the segment playing now (a hint: the player's own index; q is looked for from there back); loop: [a, z] or null.
// → up to n [{name, q, k, now}]: k the segment; now = the first one, sounding at q (none before the first chord).
export function chordWindow(chords, { q, segments = null, seg = 0, loop = null, n = 4 }) {
  const E = 1e-6;
  const cs = [...chords].sort((a, b) => a.q - b.q);
  if (!cs.length || n <= 0) return [];
  const segs = loop ? [loop] : segments?.length ? segments : [[0, Infinity]];
  let k = 0;
  if (segs.length > 1) {
    const inSeg = (j) => q >= segs[j][0] - E && q < segs[j][1] - E;
    const h = Math.max(0, Math.min(segs.length - 1, seg | 0));
    k = -1;
    for (let j = h; j >= 0 && k < 0; j--) if (inSeg(j)) k = j;
    for (let j = h + 1; j < segs.length && k < 0; j++) if (inSeg(j)) k = j;
    if (k < 0) k = h;
  }
  const out = [];
  const push = (c, j, now = false) => { if (c && out.at(-1)?.name !== c.name) out.push({ name: c.name, q: c.q, k: j, now }); };
  const lastBefore = (x) => { let r = null; for (const c of cs) { if (c.q <= x) r = c; else break; } return r; };
  push(lastBefore(q + E), k, true); // sounding now (a chord from before a jump goes on sounding, as carryChords plays it)
  for (let step = 0, j = k; out.length < n && step < segs.length + 2 * n + 2; step++) {
    const [a, z] = segs[j];
    if (step > 0) push(lastBefore(a + E), j); // carried over the jump into this segment
    for (const c of cs) if (out.length < n && c.q < z - E && (step === 0 ? c.q > q + E : c.q >= a - E)) push(c, j);
    if (loop) continue; // round again
    if (++j >= segs.length) break;
  }
  return out;
}
