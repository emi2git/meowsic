// Note-value and rest glyphs as inline SVG (one size and baseline, currentColor so they follow light / dark, and
// drawn here because iOS Safari lacks the Unicode musical symbols block): whole … 32nd notes and rests, dotted too.
// noteIcon(q, { rest, cls }) — q in quarters (4 whole, 2 half, 1 quarter, ½ 8th, ¼ 16th, ⅛ 32nd; ×1.5: dotted).
// Lengths with no single glyph come back as text ("2.5"). valueName(q, rest) is the words for aria-label / title.
const BASE = [4, 2, 1, 0.5, 0.25, 0.125];
const NAMES = { 4: 'whole', 2: 'half', 1: 'quarter', 0.5: 'eighth', 0.25: '16th', 0.125: '32nd' };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// [base value, dotted] of q, or null
export function valueOf(q) {
  for (const b of BASE) { if (near(q, b)) return [b, false]; if (near(q, b * 1.5)) return [b, true]; }
  return null;
}
export function valueName(q, rest = false) {
  const v = valueOf(q);
  const w = v ? `${v[1] ? 'dotted ' : ''}${NAMES[v[0]]}` : `${+q.toFixed(3)}-beat`;
  return `${w} ${rest ? 'rest' : 'note'}`;
}

const SW = 'stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"';
// a note: head at (7, 18.5), stem up on its right at x 11.1, flags hanging off the top
function noteBody(b) {
  const flags = { 0.5: 1, 0.25: 2, 0.125: 3 }[b] || 0;
  if (b === 4) return '<ellipse cx="8" cy="15" rx="5.2" ry="3.6" fill="none" stroke="currentColor" stroke-width="2"/>';
  const open = b === 2;
  let s = `<ellipse cx="7" cy="18.5" rx="4.4" ry="3.1" transform="rotate(-22 7 18.5)" ${open ? 'fill="none" stroke="currentColor" stroke-width="1.7"' : 'fill="currentColor"'}/>`;
  const top = flags === 3 ? 1.5 : 2.5;
  s += `<path d="M11.1 18V${top}" stroke="currentColor" stroke-width="1.5"/>`;
  for (let k = 0; k < flags; k++) {
    const y = top + k * (flags === 3 ? 3.6 : 4.2);
    s += `<path d="M11.1 ${y}c.6 2.6 4.6 3.6 4.1 7.6" ${SW}/>`;
  }
  return s;
}
// a rest: whole hangs from a line, half sits on one, quarter the zig-zag, 8th … 32nd a slash with 1–3 hooks
function restBody(b) {
  if (b === 4) return '<path d="M2.5 9h13" stroke="currentColor" stroke-width="1.4"/><rect x="4" y="9" width="10" height="4.6" fill="currentColor"/>';
  if (b === 2) return '<path d="M2.5 15h13" stroke="currentColor" stroke-width="1.4"/><rect x="4" y="10.4" width="10" height="4.6" fill="currentColor"/>';
  if (b === 1) return '<path d="M7.2 2.5l5 6c-2 1.9-2.3 3.7-.5 5.9l1.5 1.9c-2.5-.9-4.7.2-3.2 4.8-3.4-2.6-3-6.4.3-5.5L5.6 9.7c1.9-1.8 2.6-4 1.6-7.2z" fill="currentColor"/>';
  const hooks = { 0.5: 1, 0.25: 2, 0.125: 3 }[b];
  // the slash: from (14, 3) down to the left; each hook a ball with a curl up to the slash
  const x = (y) => 14 - (y - 3) * 0.28;
  const end = 9 + hooks * 4.5;
  let s = `<path d="M${x(3)} 3L${x(end).toFixed(2)} ${end}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;
  for (let k = 0; k < hooks; k++) {
    const y = 3.6 + k * 4.6, xs = x(y);
    s += `<circle cx="${(xs - 7.2).toFixed(2)}" cy="${(y + 1.4).toFixed(2)}" r="2" fill="currentColor"/>`;
    s += `<path d="M${(xs - 7.6).toFixed(2)} ${(y + 2.4).toFixed(2)}c2.4 1.2 5 .6 ${7.4 - 0.2} -2.2" ${SW}/>`;
  }
  return s;
}
const DOT = (b, rest) => `<circle cx="${b === 4 ? 16.6 : rest ? 16.8 : 17.8}" cy="${b === 4 ? 15 : rest ? 15 : 19}" r="1.7" fill="currentColor"/>`;

export function noteIcon(q, { rest = false, cls = '' } = {}) {
  const v = valueOf(q);
  if (!v) return `<span class="nv-txt${cls ? ' ' + cls : ''}">${+q.toFixed(3)}</span>`;
  const [b, dot] = v;
  return `<svg class="nv${cls ? ' ' + cls : ''}" viewBox="0 0 20 24" aria-hidden="true" focusable="false">${rest ? restBody(b) : noteBody(b)}${dot ? DOT(b, rest) : ''}</svg>`;
}
// the dot on its own (the Dotted button)
export const DOT_IC = '<svg class="nv" viewBox="0 0 20 24" aria-hidden="true" focusable="false"><circle cx="10" cy="16" r="2.6" fill="currentColor"/></svg>';
