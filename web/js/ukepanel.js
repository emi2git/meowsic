// Chords of the score (score toolbar → chords button: piano → ukulele → off): every chord of the score — its chord symbols as drawn (so they
// follow transpose), in order of first use, each once; a score without symbols gets them from its notes (the Mac's
// chord finder, server/meowsic/scorechords.py) — as GCEA ukulele chord boxes: fret dots with finger numbers, a
// barre, open strings, the position — or as small piano keyboards with the chord's keys shaded. Slash chords show their base chord (D/F♯ → D). Tap a box: the places the
// chord is used light up in the score. Remembered on this device, off by default. Every device: one compact row at the
// top of the score (under the toolbar, above the music), scrolling sideways when there are many chords; the score
// below fits the rest of the height (its ResizeObserver lays it out again). Off = no strip, full height.
// While the score plays (piano or voice, Play chords on or off): only the chord sounding at the playhead and the next 3 in
// the order they are played (repeats, D.S. / coda, an A–B loop: chordplay.chordWindow), the sounding one marked
// (.uk-now); paused or stopped: every chord again. The ticks only swap 4 small boxes when the chord changes, the score
// is not drawn again. A score without chord symbols (chords worked out from its notes) keeps the full list.
import { ukeShape, transposeChord, splitChord, notePc, esc } from './chords.js';
import { chordsOf, keyboardSvg } from './easyscore.js';
import { chordWindow } from './chordplay.js';

// the score toolbar's chords button cycles piano → ukulele → off (this device; off by default)
const KEY = 'meowsic-chords';
export const MODES = ['piano', 'uke', 'off'];
export const chordsMode = () => { try { const m = localStorage.getItem(KEY); return MODES.includes(m) ? m : 'off'; } catch { return 'off'; } };
export const setChordsMode = (m) => { try { localStorage.setItem(KEY, MODES.includes(m) ? m : 'off'); } catch {} };
export const nextMode = (m) => MODES[(MODES.indexOf(m) + 1) % MODES.length];
export const MODE_LABEL = { piano: 'Piano chords', uke: 'Ukulele chords', off: 'Chords off' };

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
    liveKey = null;
    panel.classList.remove('uk-playing');
    panel.innerHTML = `<div class="uk-row">${list.length ? list.map((c) => `<button class="uk-chord ${c === pick ? 'on' : ''}" data-chord="${esc(c)}" aria-pressed="${c === pick}" title="Show where ${esc(c)} is played">${mode === 'piano' ? pianoBox(c) : ukeBox(c)}</button>`).join('')
        : '<p class="muted uk-none">No chords in this score</p>'}</div><div class="uk-row uk-next" role="list" aria-label="Playing now and next" hidden></div>
      <button class="icon-btn uk-close" aria-label="Close the chords" title="Close">✕</button>`;
    panel.querySelector('.uk-row').scrollLeft = sx;
    light();
  };
  // playing: the chord now + the next 3 (chord symbols only: they have their times)
  let liveKey = null, idle = 0, tCache = null, tFor = null;
  const same = (x) => { const c = splitChord(baseChord(x).replace(/♯/g, '#').replace(/♭/g, 'b')); return c ? `${notePc(c.root)}|${c.suffix}` : x; };
  const timed = () => {
    const src = view.chordTimes || [], n = it.transpose || 0, drawn = chordsOf(view.osmd || {}).map(baseChord);
    if (tFor && tFor[0] === src && tFor[1] === n && tFor[2] === drawn.join()) return tCache;
    const spell = new Map(drawn.map((d) => [same(d), d])); // the drawn spelling (C♯ or D♭) of each chord
    tCache = [];
    for (const c of src) {
      const b = baseChord(n ? transposeChord(c.name, n) : c.name);
      if (b && b !== 'N.C.' && splitChord(b.replace(/♯/g, '#').replace(/♭/g, 'b'))) tCache.push({ q: c.q, name: spell.get(same(b)) || b.replace(/^([A-G])#/, '$1♯').replace(/^([A-G])b/, '$1♭') });
    }
    tFor = [src, n, drawn.join()];
    return tCache;
  };
  // the segment playing now: the piano's own index (one back while its jump is still on its way), the voice's from its audio time
  const segNow = (p) => {
    if (!p?.segments?.length) return 0;
    if (typeof p.seg === 'number') { const a = p.anchors?.at(-1); return p.seg > 0 && a && p.ctx && a.t0 > p.ctx.currentTime && a.q0 === p.segments[p.seg][0] ? p.seg - 1 : p.seg; }
    if (p.el) { const pq = p.el.currentTime * p.qps; let acc = 0; for (let j = 0; j < p.segments.length; j++) { const [a, z] = p.segments[j]; if (pq < acc + z - a) return j; acc += z - a; } return p.segments.length - 1; }
    return 0;
  };
  const showAll = () => {
    clearTimeout(idle);
    if (liveKey == null) return;
    liveKey = null; panel.classList.remove('uk-playing');
    const row = panel.querySelector('.uk-row:not(.uk-next)'), next = panel.querySelector('.uk-next');
    if (row) row.hidden = false;
    if (next) { next.hidden = true; next.innerHTML = ''; }
  };
  const boxOf = (c) => (mode === 'piano' ? pianoBox(c) : ukeBox(c));
  const onTick = (e) => {
    const p = view.player;
    if (!p?.playing) { showAll(); return; }
    clearTimeout(idle);
    idle = setTimeout(function look() { if (view.player?.playing) idle = setTimeout(look, 300); else showAll(); }, 300); // paused: no more ticks
    const next = panel.querySelector('.uk-next'), list = timed();
    if (!next || !list.length) return;
    const q = e?.detail?.q ?? p.now();
    const win = chordWindow(list, { q, segments: p.segments, seg: segNow(p), loop: p.loop, n: 4 });
    const key = win.map((w) => `${w.now ? '*' : ''}${w.name}@${w.k}:${w.q}`).join('|');
    if (key === liveKey) return;
    liveKey = key;
    panel.classList.add('uk-playing');
    panel.querySelector('.uk-row:not(.uk-next)').hidden = true;
    next.hidden = false;
    next.innerHTML = win.map((w) => `<button class="uk-chord ${w.now ? 'uk-now' : ''} ${w.name === pick ? 'on' : ''}" data-chord="${esc(w.name)}" aria-pressed="${w.name === pick}"${w.now ? ' aria-current="true"' : ''} title="${w.now ? 'Playing now' : 'Coming up'}: ${esc(w.name)}">${boxOf(w.name)}</button>`).join('');
  };
  const onStop = () => { if (!view.player?.playing) showAll(); };
  host.addEventListener('tick', onTick);
  host.addEventListener('ended', onStop);
  host.addEventListener('playstate', onStop);
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
  return { el: panel, refresh: draw, setMode(m) { mode = m; liveKey = null; panel.dataset.mode = m; panel.setAttribute('aria-label', MODE_LABEL[m]); draw(); }, destroy() { clearTimeout(idle); host.removeEventListener('scoredrawn', onDrawn); host.removeEventListener('tick', onTick); host.removeEventListener('ended', onStop); host.removeEventListener('playstate', onStop); host.querySelectorAll('.uke-hit').forEach((e) => e.classList.remove('uke-hit')); panel.remove(); host.classList.remove('uke-on'); } };
}
