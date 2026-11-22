// Chord parsing, transposition and ukulele (GCEA) fingerings.
// Runs in the browser and in node (tests).

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function notePc(n) {
  let pc = NOTE_PC[n[0].toUpperCase()];
  if (pc === undefined) return null;
  for (const a of n.slice(1)) pc += a === '#' || a === '♯' ? 1 : a === 'b' || a === '♭' ? -1 : 0;
  return ((pc % 12) + 12) % 12;
}

// "F#m7/C#" -> { root:'F#', suffix:'m7', bass:'C#' }
export function splitChord(name) {
  const m = String(name).trim().match(/^([A-G][#b♯♭]?)([^/]*)(?:\/([A-G][#b♯♭]?))?$/);
  return m ? { root: m[1], suffix: m[2], bass: m[3] || null } : null;
}

const isMinorSuffix = (s) => /^(m(?!aj)|min|-)/.test(s);

// flat spelling for keys that are written with flats
export function prefersFlat(keyName) {
  const c = splitChord(keyName || '');
  if (!c) return false;
  const pc = notePc(c.root);
  return isMinorSuffix(c.suffix) ? [2, 7, 0, 5, 10, 3].includes(pc) : [5, 10, 3, 8, 1].includes(pc);
}

export function transposeChord(name, steps, flat = false) {
  const c = splitChord(name);
  if (!c) return name;
  if (!steps) return name;
  const names = flat ? FLAT : SHARP;
  const tr = (n) => names[(notePc(n) + steps + 120) % 12];
  return tr(c.root) + c.suffix + (c.bass ? '/' + tr(c.bass) : '');
}

// suffix -> interval set (semitones above the root)
export function chordIntervals(suffixIn) {
  let s = suffixIn.replace(/[()\s]/g, '').replace(/♯/g, '#').replace(/♭/g, 'b').replace(/Δ/g, 'maj').replace(/°/g, 'dim').replace(/ø/g, 'm7b5');
  let third = 4;
  let fifth = 7;
  let seventh = null;
  const extra = new Set();
  let majorSeven = false;

  const eat = (re) => {
    const m = s.match(re);
    if (m) s = s.slice(m[0].length);
    return m;
  };

  if (eat(/^(maj|Maj|MAJ|M(?!in))/)) majorSeven = true;
  else if (eat(/^dim/)) {
    third = 3;
    fifth = 6;
    if (eat(/^7/)) seventh = 9;
  } else if (eat(/^(aug|\+)/)) fifth = 8;
  else if (eat(/^(min|mi|m|-)/)) {
    third = 3;
    if (eat(/^(maj|Maj|M)/)) majorSeven = true;
  }

  const num = eat(/^(13|11|9|7|6|5|2|4)/);
  if (num) {
    const n = num[0];
    const sev = majorSeven ? 11 : 10;
    if (n === '5') third = null;
    else if (n === '6') extra.add(9);
    else if (n === '2') extra.add(2);
    else if (n === '4') extra.add(5);
    else {
      seventh = sev;
      if (n === '9') extra.add(2);
      if (n === '11') extra.add(2), extra.add(5);
      if (n === '13') extra.add(2), extra.add(9);
    }
  } else if (majorSeven) {
    // plain "maj" / "M" = major triad
    majorSeven = false;
  }

  while (s.length) {
    let m;
    if ((m = eat(/^sus(2|4)?/))) {
      third = null;
      extra.add(m[1] === '2' ? 2 : 5);
    } else if ((m = eat(/^add(2|4|9|11)/))) extra.add(m[1] === '2' || m[1] === '9' ? 2 : 5);
    else if (eat(/^(maj|M)7/)) seventh = 11;
    else if (eat(/^b5/)) fifth = 6;
    else if (eat(/^(#5|\+5|\+)/)) fifth = 8;
    else if (eat(/^b9/)) extra.add(1);
    else if (eat(/^#9/)) extra.add(3);
    else if (eat(/^#11/)) extra.add(6);
    else if (eat(/^b13/)) extra.add(8);
    else if (eat(/^6/)) extra.add(9);
    else if (eat(/^9/)) extra.add(2);
    else if (eat(/^7/)) seventh = seventh ?? 10;
    else return null; // unknown notation
  }

  const out = [0];
  if (third !== null) out.push(third);
  out.push(fifth);
  if (seventh !== null) out.push(seventh);
  for (const e of extra) if (!out.includes(e)) out.push(e);
  return out;
}

export function chordTones(name) {
  const c = splitChord(name);
  if (!c) return null;
  const iv = chordIntervals(c.suffix);
  if (!iv) return null;
  const root = notePc(c.root);
  return iv.map((i) => (root + i) % 12);
}

// ---------- ukulele ----------

export const UKE_TUNING = [7, 0, 4, 9]; // G C E A

// Well-known shapes, keyed by "<root pitch class>|<normalised quality>".
const COMMON = {
  '': ['0003', '1114', '2220', '0331', '4442', '2010', '3121', '0232', '5343', '2100', '3211', '4322'],
  m: ['0333', '1104', '2210', '3321', '0432', '1013', '2120', '0231', '4342', '2000', '3111', '4222'],
  7: ['0001', '1112', '2223', '3334', '1202', '2310', '3424', '0212', '1323', '0100', '1211', '2322'],
  m7: ['3333', '1102', '2213', '3324', '0202', '1313', '2424', '0211', '1322', '0000', '1111', '2222'],
  maj7: ['0002', '1113', '2224', '3335', '1302', '2413', '3524', '0222', '1333', '1100', '3210', '4321'],
};

function quality(iv) {
  const k = [...iv].sort((a, b) => a - b).join(',');
  return { '0,4,7': '', '0,3,7': 'm', '0,4,7,10': '7', '0,3,7,10': 'm7', '0,4,7,11': 'maj7' }[k];
}

function searchShape(tones, rootPc) {
  const all = [...new Set(tones)];
  const fifth = (rootPc + 7) % 12;
  // with more notes than strings (or no playable shape) drop the fifth, then the root
  const tries = [all, all.filter((t) => t !== fifth), all.filter((t) => t !== fifth && t !== rootPc)];
  for (const required of tries) {
    if (required.length > 4) continue;
    const fr = searchRequired(new Set(all), required, 4);
    if (fr) return fr;
  }
  return searchRequired(new Set(all), all.length > 4 ? tries[1] : all, 5); // allow a wider stretch
}

function searchRequired(set, required, span) {
  let best = null;
  for (let base = 1; base <= 9; base++) {
    const opts = UKE_TUNING.map((open) => {
      const f = [];
      if (set.has(open)) f.push(0);
      for (let x = base; x < base + span; x++) if (set.has((open + x) % 12)) f.push(x);
      return f;
    });
    if (opts.some((o) => !o.length)) continue;
    for (const a of opts[0]) for (const b of opts[1]) for (const c of opts[2]) for (const d of opts[3]) {
      const fr = [a, b, c, d];
      const played = new Set(fr.map((f, i) => (UKE_TUNING[i] + f) % 12));
      if (!required.every((t) => played.has(t))) continue;
      const pressed = fr.filter((f) => f > 0);
      const max = Math.max(0, ...pressed);
      // a full barre counts as one finger
      const min = pressed.length === 4 ? Math.min(...pressed) : 0;
      const fingers = min ? 1 + pressed.filter((f) => f > min).length : pressed.length;
      if (fingers > 4) continue;
      const score = max * 10 + fingers * 4 + pressed.reduce((s, f) => s + f, 0);
      if (!best || score < best.score) best = { fr, score };
    }
  }
  return best ? best.fr : null;
}

const cache = new Map();

// -> [g, c, e, a] fret numbers, or null when the chord name is not understood
export function ukeShape(name) {
  if (cache.has(name)) return cache.get(name);
  let shape = null;
  const c = splitChord(name);
  const iv = c && chordIntervals(c.suffix);
  if (iv) {
    const root = notePc(c.root);
    const q = quality(iv);
    if (q !== undefined) shape = COMMON[q][root].split('').map(Number);
    else shape = searchShape(iv.map((i) => (root + i) % 12), root);
  }
  cache.set(name, shape);
  return shape;
}

// SVG chord box
export function ukeDiagram(name) {
  const shape = ukeShape(name);
  const W = 64, H = 96, x0 = 14, y0 = 30, sx = 12, fy = 13, rows = 4;
  let g = `<text x="${W / 2}" y="13" text-anchor="middle" class="cd-name">${esc(name)}</text>`;
  if (!shape) {
    g += `<text x="${W / 2}" y="${y0 + 30}" text-anchor="middle" class="cd-q">?</text>`;
    return `<svg class="cd" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)}">${g}</svg>`;
  }
  const pressed = shape.filter((f) => f > 0);
  const max = Math.max(0, ...pressed);
  const base = max > rows ? Math.min(...pressed) : 1;
  for (let i = 0; i < 4; i++)
    g += `<line x1="${x0 + i * sx}" y1="${y0}" x2="${x0 + i * sx}" y2="${y0 + rows * fy}" class="cd-l"/>`;
  for (let r = 0; r <= rows; r++)
    g += `<line x1="${x0}" y1="${y0 + r * fy}" x2="${x0 + 3 * sx}" y2="${y0 + r * fy}" class="${r === 0 && base === 1 ? 'cd-nut' : 'cd-l'}"/>`;
  if (base > 1) g += `<text x="${x0 + 3 * sx + 5}" y="${y0 + fy / 2 + 3}" class="cd-fr">${base}</text>`;
  shape.forEach((f, i) => {
    const x = x0 + i * sx;
    if (f === 0) g += `<circle cx="${x}" cy="${y0 - 6}" r="3" class="cd-open"/>`;
    else g += `<circle cx="${x}" cy="${y0 + (f - base + 0.5) * fy}" r="4.3" class="cd-dot"/>`;
  });
  g += `<text x="${W / 2}" y="${H - 2}" text-anchor="middle" class="cd-frets">${shape.join(shape.some((f) => f > 9) ? '-' : '')}</text>`;
  return `<svg class="cd" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)} ${shape.join(' ')}">${g}</svg>`;
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
