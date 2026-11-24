// Chords of the score (score toolbar → chords button: piano → ukulele → off): every chord of the score — its chord symbols as drawn (so they
// follow transpose), in order of first use, each once; a score without symbols gets them from its notes (the Mac's
// chord finder, server/meowsic/scorechords.py) — as GCEA ukulele chord boxes: fret dots with finger numbers, a
// barre, open strings, the position — or as small piano keyboards with the chord's keys shaded. Slash chords show their base chord (D/F♯ → D). Tap a box: the places the
// chord is used light up in the score. Remembered on this device, off by default. Every device: one compact row at the
// top of the score (under the toolbar, above the music), scrolling sideways when there are many chords; the score
// below fits the rest of the height (its ResizeObserver lays it out again). Off = no strip, full height.
import { ukeShape, transposeChord, splitChord, esc } from './chords.js';
import { chordsOf, keyboardSvg } from './easyscore.js';

// the score toolbar's chords button cycles piano → ukulele → off (this device; off by default)
const KEY = 'meowsic-chords';
export const MODES = ['piano', 'uke', 'off'];
export const chordsMode = () => { try { const m = localStorage.getItem(KEY); return MODES.includes(m) ? m : 'off'; } catch { return 'off'; } };
export const setChordsMode = (m) => { try { localStorage.setItem(KEY, MODES.includes(m) ? m : 'off'); } catch {} };
export const nextMode = (m) => MODES[(MODES.indexOf(m) + 1) % MODES.length];
export const MODE_LABEL = { piano: 'Piano chords', uke: 'Ukulele chords', off: 'Chords off' };
export const ukeOn = () => chordsMode() === 'uke';

export const baseChord = (name) => String(name || '').replace(/\s+/g, '').replace(/\/.*$/, '');

// frets [G, C, E, A] -> { frets, fingers, barre: {fret, from, to} | null, pos }
export function ukeFingering(name) {
  const frets = ukeShape(baseChord(name).replace(/♯/g, '#').replace(/♭/g, 'b'));
  if (!frets) return null;
  const pressed = frets.map((f, i) => ({ f, i })).filter((x) => x.f > 0);
  const min = pressed.length ? Math.min(...pressed.map((x) => x.f)) : 0;
  const atMin = pressed.filter((x) => x.f === min);
  let barre = null;
  if (atMin.length >= 2) {
    const from = atMin[0].i;
    const across = frets.slice(from).every((f) => f >= min);
    if (across && (pressed.length === 4 || atMin.length >= 3) && pressed.length - atMin.length + 1 <= 4) barre = { fret: min, from, to: 3 };
  }
  const fingers = [0, 0, 0, 0];
  let prev = 0;
  if (barre) { for (const x of atMin) fingers[x.i] = 1; prev = 1; }
  const rest = [...pressed].sort((a, b) => a.f - b.f || a.i - b.i).filter((x) => !(barre && x.f === min));
  // more notes than fingers left: notes on the same fret share one finger (a small barre, e.g. E = 4442)
  const share = rest.length + prev > 4;
  let lastF = -1;
  for (const x of rest) {
    if (!(share && x.f === lastF)) prev = Math.min(4, Math.max(prev + 1, x.f - min + 1));
    fingers[x.i] = prev; lastF = x.f;
  }
  const max = Math.max(0, ...frets);
  return { frets, fingers, barre, pos: max <= 4 ? 1 : min };
}

// one chord box (SVG)
export function ukeBox(name) {
  const fg = ukeFingering(name);
  const W = 78, H = 112, x0 = 17, y0 = 34, sx = 14, fy = 15, rows = 4;
  const base = baseChord(name);
  let g = `<text x="${W / 2}" y="16" text-anchor="middle" class="uk-name">${esc(base)}</text>`;
  if (!fg) return `<svg class="uk-box" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(base)}: no diagram">${g}<text x="${W / 2}" y="70" text-anchor="middle" class="uk-q">?</text></svg>`;
  const { frets, fingers, barre, pos } = fg;
  const rowsN = Math.max(rows, Math.max(...frets) - pos + 1);
  for (let i = 0; i < 4; i++) g += `<line x1="${x0 + i * sx}" y1="${y0}" x2="${x0 + i * sx}" y2="${y0 + rowsN * fy}" class="uk-l"/>`;
  for (let r = 0; r <= rowsN; r++) g += `<line x1="${x0 - 0.5}" y1="${y0 + r * fy}" x2="${x0 + 3 * sx + 0.5}" y2="${y0 + r * fy}" class="${r === 0 && pos === 1 ? 'uk-nut' : 'uk-l'}"/>`;
  if (pos > 1) g += `<text x="${x0 - 5}" y="${y0 + fy / 2 + 4}" text-anchor="end" class="uk-fr">${pos}fr</text>`;
  const yOf = (f) => y0 + (f - pos + 0.5) * fy;
  if (barre) g += `<rect class="uk-barre" x="${x0 + barre.from * sx - 6}" y="${yOf(barre.fret) - 6}" width="${(barre.to - barre.from) * sx + 12}" height="12" rx="6"/>`;
  frets.forEach((f, i) => {
    const x = x0 + i * sx;
    if (f === 0) { g += `<circle cx="${x}" cy="${y0 - 7}" r="3.6" class="uk-open"/>`; return; }
    if (!(barre && f === barre.fret && i >= barre.from)) g += `<circle cx="${x}" cy="${yOf(f)}" r="6" class="uk-dot"/>`;
    if (!(barre && f === barre.fret && i > barre.from)) g += `<text x="${barre && f === barre.fret ? x0 + ((barre.from + barre.to) / 2) * sx : x}" y="${yOf(f) + 3.6}" text-anchor="middle" class="uk-fing">${fingers[i]}</text>`;
  });
  ['G', 'C', 'E', 'A'].forEach((s, i) => { g += `<text x="${x0 + i * sx}" y="${H - 4}" text-anchor="middle" class="uk-str">${s}</text>`; });
  return `<svg class="uk-box" viewBox="0 0 ${W} ${H}" role="img" data-frets="${frets.join('')}" data-fingers="${fingers.join('')}" data-barre="${barre ? barre.fret : ''}" aria-label="${esc(base)} ${frets.join(' ')}">${g}</svg>`;
}

// one piano chord: a small keyboard with the chord's keys shaded and named (easyscore.keyboardSvg)
export const pianoBox = (name) => keyboardSvg(baseChord(name).replace(/#/g, '♯')).svg.replace('class="kbd"', 'class="kbd pn-box"');

// the chord symbols as drawn (labels in the SVG, for highlighting)
function chordLabels(osmd) {
  const out = [];
  for (const staves of osmd?.GraphicSheet?.MeasureList || []) for (const gm of staves || []) for (const se of gm?.staffEntries || []) for (const cc of se.graphicalChordContainers || []) {
    const t = (cc.GraphicalLabel?.Label?.text || '').trim();
    const el = cc.GraphicalLabel?.SVGNode;
    if (t) out.push({ t, el });
  }
  return out;
}

// the strip; view = the score view (osmd, transpose, events), host = .viewer (it goes between the toolbar and .viewer-body)
export function ukePanel(view, it, host, mode = 'uke') {
  const panel = document.createElement('div');
  panel.className = 'chord-strip';
  panel.setAttribute('role', 'region');
  panel.dataset.mode = mode;
  panel.setAttribute('aria-label', MODE_LABEL[mode]);
  const body = host.querySelector('.viewer-body');
  if (body) host.insertBefore(panel, body); else host.append(panel);
  host.classList.add('uke-on');
  let found = null, pick = null; // chords from the notes (server), once
  const names = async () => {
    const drawn = chordsOf(view.osmd || {});
    if (drawn.length) return { list: dedupe(drawn), from: 'symbols' };
    if (!view.real) return { list: [], from: 'none' };
    if (!found) {
      try { found = await fetch(`/api/items/${encodeURIComponent(it.id)}/score-chords`).then((r) => (r.ok ? r.json() : { chords: [], from: 'none' })); }
      catch { found = { chords: [], from: 'none' }; }
    }
    const n = it.transpose || 0;
    return { list: dedupe(found.chords.map((c) => (n ? transposeChord(c, n) : c))), from: found.from };
  };
  const dedupe = (xs) => { const s = []; for (const x of xs) { const b = baseChord(x); if (b && !s.includes(b) && splitChord(b.replace(/♯/g, '#').replace(/♭/g, 'b'))) s.push(b); } return s; };
  const light = () => {
    host.querySelectorAll('.uke-hit').forEach((e) => e.classList.remove('uke-hit'));
    if (!pick) return;
    for (const l of chordLabels(view.osmd)) if (baseChord(l.t) === pick && l.el) l.el.classList.add('uke-hit');
  };
  const draw = async () => {
    const { list, from } = await names();
    if (!panel.isConnected) return;
    if (pick && !list.includes(pick)) pick = null;
    const n = `${list.length} chord${list.length > 1 ? 's' : ''}${from === 'notes' ? ' · worked out from the notes' : ''}`;
    const sx = panel.querySelector('.uk-row')?.scrollLeft || 0; // a redraw (transpose, zoom) keeps the strip where it was
    panel.title = list.length ? `${MODE_LABEL[mode]}: ${n}` : MODE_LABEL[mode];
    panel.innerHTML = `<div class="uk-row">${list.length ? list.map((c) => `<button class="uk-chord ${c === pick ? 'on' : ''}" data-chord="${esc(c)}" aria-pressed="${c === pick}" title="Show where ${esc(c)} is played">${mode === 'piano' ? pianoBox(c) : ukeBox(c)}</button>`).join('')
        : '<p class="muted uk-none">No chords in this score</p>'}</div>
      <button class="icon-btn uk-close" aria-label="Close the chords" title="Close">✕</button>`;
    panel.querySelector('.uk-row').scrollLeft = sx;
    light();
  };
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.uk-close')) { host.dispatchEvent(new CustomEvent('ukeclose')); return; }
    const b = e.target.closest('[data-chord]');
    if (!b) return;
    pick = pick === b.dataset.chord ? null : b.dataset.chord;
    panel.querySelectorAll('.uk-chord').forEach((x) => { x.classList.toggle('on', x.dataset.chord === pick); x.setAttribute('aria-pressed', String(x.dataset.chord === pick)); });
    light();
  });
  const onDrawn = () => draw();
  host.addEventListener('scoredrawn', onDrawn);
  draw();
  return { el: panel, refresh: draw, setMode(m) { mode = m; panel.dataset.mode = m; panel.setAttribute('aria-label', MODE_LABEL[m]); draw(); }, destroy() { host.removeEventListener('scoredrawn', onDrawn); host.querySelectorAll('.uke-hit').forEach((e) => e.classList.remove('uke-hit')); panel.remove(); host.classList.remove('uke-on'); } };
}
