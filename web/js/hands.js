// Parts to play (score toolbar and Edit notes): one on / off toggle per part, several on at once — V (Vocal), R (Right
// hand), L (Left hand), one per staff from musicxml.js xmlInfo (`staves`, staffLabels; other staves are numbered), and
// C (Chords: the chord names above the bars, chordplay.js, played as a soft pad) when the score has chord names; one
// staff with chord names: M (Melody) and C. No "Both": two hands are just L and R both on. One staff and no chords: no toggles. At least one stays on: a tap on
// the last one on does nothing (it is marked aria-disabled). Short labels; the aria-label and title give the full name.
// Remembered per score on this device (`meowsic-parts-<id>` = {off: [staff labels], chords: bool}); a score never set
// starts with every part on, and Chords as it was last set on this device (`meowsic-chordplay`, off at first).
// The singing voice (Voice) plays as it is (no toggles then).
const KEY = (id) => `meowsic-parts-${id}`;
const CP_KEY = 'meowsic-chordplay';
export function savedParts(id) {
  let chords = false;
  try { chords = localStorage.getItem(CP_KEY) === '1'; } catch {}
  try {
    const v = JSON.parse(localStorage.getItem(KEY(id)) || 'null');
    if (v && typeof v === 'object') return { off: Array.isArray(v.off) ? v.off.map(String) : [], chords: typeof v.chords === 'boolean' ? v.chords : chords };
  } catch {}
  return { off: [], chords };
}
export function saveParts(id, { off, chords }) {
  try { localStorage.setItem(KEY(id), JSON.stringify({ off: [...off], chords: !!chords })); localStorage.setItem(CP_KEY, chords ? '1' : '0'); } catch {}
}
// the muted staves that apply to these staves; never every part off (all staves off with no chords → all on)
export function effectiveMuted(staves, labels, chordsOn = false) {
  const m = (labels || []).filter((l) => staves.includes(l));
  return m.length >= staves.length && !chordsOn ? [] : m;
}
const NAME = { R: 'Right hand', L: 'Left hand', V: 'Vocal' };
export const partName = (l) => { const base = l.replace(/\d+$/, ''), n = l.slice(base.length); return NAME[base] ? `${NAME[base]}${n ? ` ${n}` : ''}` : `Staff ${l}`; };

// the toggles' HTML ('' when there is nothing to pick); chords = {has, on}; clicks go to handsClick
export function handsHtml(staves, muted, { chords = null, hidden = false, id = '' } = {}) {
  staves = staves || [];
  const hasC = !!chords?.has;
  if (staves.length + (hasC ? 1 : 0) < 2) return '';
  const h = hidden ? ' hidden' : '', i = id ? ` id="${id}"` : '';
  const solo = staves.length === 1; // one staff (with chords): M (Melody) and C
  const ons = staves.filter((l) => !muted.includes(l)).length + (hasC && chords.on ? 1 : 0);
  const btn = (attr, label, name, on) => {
    const last = on && ons === 1;
    return `<button ${attr} class="${on ? 'on' : ''}" aria-pressed="${on}"${last ? ' aria-disabled="true"' : ''} title="${name}: ${on ? (last ? 'plays (the last one on stays on)' : 'plays (tap to mute)') : 'muted (tap to play)'}" aria-label="${name}">${label}</button>`;
  };
  return `<span class="seg small hands parts"${i} role="group" aria-label="Parts to play"${h}>${staves.map((l) => btn(`data-staff="${l}"`, solo ? 'M' : l, solo ? 'Melody' : partName(l), !muted.includes(l))).join('')}${hasC ? btn('data-part="chords"', 'C', 'Chords', !!chords.on) : ''}</span>`;
}
// a click inside the toggles → {muted, chords} (the new state), or null (not a toggle / the last one on)
export function handsClick(e, staves, muted, chordsOn = false, hasChords = false) {
  const sb = e.target.closest?.('[data-staff]'), cb = e.target.closest?.('[data-part="chords"]');
  if (!sb && !cb) return null;
  let m = [...muted], c = !!chordsOn && hasChords;
  if (sb) { const l = sb.dataset.staff; m = m.includes(l) ? m.filter((x) => x !== l) : [...m, l]; }
  else if (hasChords) c = !c;
  const ons = staves.filter((l) => !m.includes(l)).length + (c ? 1 : 0);
  return ons ? { muted: m, chords: c } : null; // the last one playing stays on
}
