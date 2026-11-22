// Chord charts: parse ChordPro-style text ("[C]You are my [F]sunshine"), pick the easiest
// ukulele key, transpose and render. Key logic is carried over from Emi Songbook.
import { transposeChord, prefersFlat, ukeDiagram, ukeShape, splitChord, esc } from './chords.js';

export { ukeDiagram };

// text -> [{t:'line', parts:[{chord,text}]}, {t:'section', text}, {t:'blank'}]
export function parseChordPro(text) {
  return text.split('\n').map((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return { t: 'blank' };
    const sec = line.match(/^\{(?:c|comment|section):\s*(.+)\}$/i) || line.match(/^\[(Verse|Chorus|Bridge|Intro|Outro|Pre-Chorus)[^\]]*\]$/i);
    if (sec) return { t: 'section', text: sec[1] || sec[0].slice(1, -1) };
    const parts = [];
    const re = /\[([^\]]+)\]/g;
    let last = 0, chord = null, m;
    while ((m = re.exec(line))) {
      if (m.index > last || chord !== null) parts.push({ chord, text: line.slice(last, m.index) });
      chord = m[1];
      last = re.lastIndex;
    }
    parts.push({ chord, text: line.slice(last) });
    const filtered = parts.filter((p, i) => p.chord || p.text || i === parts.length - 1);
    const co = filtered.every((p) => !p.text.trim()); // chords only (intro / instrumental)
    return { t: 'line', parts: filtered, co };
  });
}

const norm = (n) => ((((n + 5) % 12) + 12) % 12) - 5; // -5..+6
export const STEPS = [...Array(12)].map((_, i) => i - 5);
const eachChord = (lines) => lines.flatMap((l) => l.parts || []).map((p) => p.chord).filter((c) => c && /^[A-G]/.test(c));

export function keyBase(chart) {
  const c = splitChord(chart.key || eachChord(chart.lines)[0] || '');
  return c ? c.root + (/^(m(?!aj)|min|-)/.test(c.suffix) ? 'm' : '') : '';
}
export const keyAt = (base, n) => (n ? transposeChord(base, n, prefersFlat(transposeChord(base, n))) : base);

function difficulty(name) {
  const shape = ukeShape(name.replace(/\/.*$/, ''));
  if (!shape) return 6;
  const pressed = shape.filter((f) => f > 0);
  return pressed.length + Math.max(0, Math.max(0, ...pressed) - 2) + (pressed.length === 4 ? 1 : 0);
}

export function easySteps(chart) {
  const counts = new Map();
  for (const c of eachChord(chart.lines)) counts.set(c, (counts.get(c) || 0) + 1);
  const base = keyBase(chart);
  let best = null;
  for (const n of STEPS) {
    let cost = 0;
    for (const [c, k] of counts) cost += k * difficulty(transposeChord(c, n));
    const k = keyAt(base, n);
    const rank = [cost, k === 'C' || k === 'Am' ? 0 : 1, Math.abs(n)];
    const i = best ? rank.findIndex((v, j) => v !== best.rank[j]) : 0;
    if (!best || (i >= 0 && rank[i] < best.rank[i])) best = { n, rank };
  }
  return best ? best.n : 0;
}

export function keyInfo(chart) {
  const easy = easySteps(chart);
  const steps = Number.isInteger(chart.transpose) ? norm(chart.transpose) : easy;
  const base = keyBase(chart);
  const flat = steps ? prefersFlat(transposeChord(base, steps)) : false;
  return { steps, flat, easy, base, key: base ? keyAt(base, steps) : '' };
}

export function chordsUsed(chart) {
  const { steps, flat } = keyInfo(chart);
  const seen = new Set();
  for (const c of eachChord(chart.lines)) seen.add(transposeChord(c, steps, flat).replace(/\/.*$/, ''));
  return [...seen];
}

export function linesHtml(chart) {
  const { steps, flat } = keyInfo(chart);
  const tr = (c) => esc(transposeChord(c, steps, flat));
  return chart.lines.map((l) => {
    if (l.t === 'blank') return '<div class="gap"></div>';
    if (l.t === 'section') return `<div class="sec">${esc(l.text)}</div>`;
    if (!l.parts.some((p) => p.chord)) return `<div class="ln txt">${esc(l.parts.map((p) => p.text).join(''))}</div>`;
    if (l.co) return `<div class="ln co">${l.parts.map((p) => (p.chord ? `<span class="ch">${tr(p.chord)}</span>` : '')).join('')}</div>`;
    return `<div class="ln">${l.parts.map((p) =>
      `<span class="cs"><span class="ch">${p.chord ? tr(p.chord) : ''}</span><span class="ly">${esc(p.text) || '&nbsp;'}</span></span>`).join('')}</div>`;
  }).join('');
}

export function diagramsHtml(chart) {
  return chordsUsed(chart).map(ukeDiagram).join('');
}
