// Hands (score toolbar and Edit notes): play only the right hand, only the left hand, or both.
// The staves come from musicxml.js xmlInfo (`staves`, staffLabels): two staves = R (top) over L (bottom), shown as
// one L · Both · R choice; three or more (a voice over a piano: V R L) = one on / off toggle per staff, at least one on.
// One staff: no picker. This device remembers the muted staves by name (`meowsic-hands`, a JSON list), so "left hand
// only" carries over to the next score. Play chords follows the left hand (no chords while it is muted); the singing
// voice (Voice) plays as it is.
const KEY = 'meowsic-hands';
export const savedMuted = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
export const saveMuted = (labels) => { try { localStorage.setItem(KEY, JSON.stringify(labels)); } catch {} };
// the muted staves that apply to these staves (never all of them)
export function effectiveMuted(staves, labels) {
  const m = (labels || []).filter((l) => staves.includes(l));
  return m.length >= staves.length ? [] : m;
}
export const lhMuted = (muted) => muted.some((l) => /^L\d*$/.test(l));
const NAME = { R: 'Right hand', L: 'Left hand', V: 'Voice' };
const nameOf = (l) => { const base = l.replace(/\d+$/, ''), n = l.slice(base.length); return NAME[base] ? `${NAME[base]}${n ? ` ${n}` : ''}` : `Staff ${l}`; };

// the picker's HTML ('' for one staff); clicks go to handsClick
export function handsHtml(staves, muted, { hidden = false, id = '' } = {}) {
  if (!staves || staves.length < 2) return '';
  const h = hidden ? ' hidden' : '', i = id ? ` id="${id}"` : '';
  if (staves.length === 2) {
    const mode = muted.includes('L') ? 'R' : muted.includes('R') ? 'L' : 'both';
    const b = (k, t, title) => `<button data-hand="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}" title="${title}" aria-label="${title}">${t}</button>`;
    return `<span class="seg small hands"${i} role="group" aria-label="Hands"${h}>${b('L', 'L', 'Left hand only')}${b('both', 'Both', 'Both hands')}${b('R', 'R', 'Right hand only')}</span>`;
  }
  return `<span class="seg small hands multi"${i} role="group" aria-label="Staves to play"${h}>${staves.map((l) => {
    const on = !muted.includes(l);
    return `<button data-staff="${l}" class="${on ? 'on' : ''}" aria-pressed="${on}" title="${nameOf(l)}: ${on ? 'plays (tap to mute)' : 'muted (tap to play)'}" aria-label="${nameOf(l)}">${l}</button>`;
  }).join('')}</span>`;
}
// a click inside the picker → the new muted list, or null (not a picker button / nothing to change)
export function handsClick(e, staves, muted) {
  const hb = e.target.closest?.('[data-hand]'), sb = e.target.closest?.('[data-staff]');
  if (hb) return { L: ['R'], R: ['L'], both: [] }[hb.dataset.hand] || [];
  if (sb) {
    const l = sb.dataset.staff;
    const next = muted.includes(l) ? muted.filter((x) => x !== l) : [...muted, l];
    return next.length >= staves.length ? null : next; // the last one playing stays on
  }
  return null;
}
