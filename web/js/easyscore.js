// Kids note names (the kitten button): big noteheads with the note's letter inside, on every staff, like an
// E-Z Play / big-note children's sheet — white letters on filled heads, black on open ones. The notes are
// spaced wider so the big heads have room; everything else stays OSMD's classic engraving (title, composer,
// tempo, chord symbols, lyrics). No chord diagrams (those are the ukulele panel's, ukepanel.js).
// Works on a rendered OpenSheetMusicDisplay instance (screen and print).
import { splitChord, chordIntervals, notePc, esc } from './chords.js';

const LETTER = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const LETTERS = 'CDEFGAB';
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// off by default; the toggle is remembered on this device, for every score (`it` unused, kept for callers)
export const isAiScore = (it) => !!it.ai || /^meowsic ai$/i.test(String(it.source || '').trim());
export const KIDS_KEY = 'meowsic-kids';
export const easyKey = () => KIDS_KEY;
export function easyOn() {
  try { return localStorage.getItem(KIDS_KEY) === '1'; } catch { return false; }
}
export function setEasy(it, on) { try { localStorage.setItem(KIDS_KEY, on ? '1' : '0'); } catch {} }

// how big the heads get (× a normal head), and the wider spacing that makes room for them
export const KIDS_GROW = 1.85;
export function kidsRules(r) {
  r.VoiceSpacingMultiplierVexflow = 1.25; r.VoiceSpacingAddendVexflow = 5; r.MinNoteDistance = 4;
  r.BetweenStaffDistance += 2.5; r.StaffDistance += 3;
}

// the credit line ("Words and Music by …"): the MusicXML creator, composer first, shown as given
export function creditOf(xmlText) {
  if (!xmlText) return '';
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const cs = [...doc.querySelectorAll('identification > creator')];
  const c = cs.find((x) => x.getAttribute('type') === 'composer') || cs[0];
  const t = (c?.textContent || '').trim();
  return /^music21$/i.test(t) ? '' : t === 'Meowsic AI' ? 'Meowsic' : t; // music21's default stamp is not a credit; the old name reads "Meowsic"
}

// the MusicXML as OSMD should draw it: music21's stand-in title ("Music21 Fragment") becomes the
// item's title, its "Music21" composer stamp goes, and an AI piece's composer reads "Meowsic" (an old "Meowsic AI" too)
export function classicXml(xml, it) {
  if (!xml) return xml;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return xml;
  const root = doc.documentElement;
  const mk = (tag, text) => { const e = doc.createElement(tag); e.textContent = text; return e; };
  let changed = false;
  const titles = [...root.querySelectorAll(':scope > movement-title, :scope > work > work-title')];
  // the drawn title is always the item's Info title (a transcription's file says the video's name)
  const credTitles = [...root.querySelectorAll(':scope > credit')].filter((c) => c.querySelector('credit-type')?.textContent.trim() === 'title');
  if (it?.title && (titles.some((t) => t.textContent.trim() !== it.title) || !titles.length || credTitles.length)) {
    titles.forEach((t) => t.remove());
    credTitles.forEach((c) => c.remove());
    root.querySelector(':scope > work')?.childElementCount === 0 && root.querySelector(':scope > work').remove();
    root.insertBefore(mk('movement-title', it.title), root.firstElementChild);
    changed = true;
  }
  if (snapHarmonies(doc)) changed = true;
  let ident = root.querySelector(':scope > identification');
  root.querySelectorAll(':scope > identification > creator').forEach((c) => { const t = c.textContent.trim(); if (/^music21$/i.test(t)) { c.remove(); changed = true; } else if (t === 'Meowsic AI') { c.textContent = 'Meowsic'; changed = true; } });
  if (it && isAiScore(it) && ![...root.querySelectorAll(':scope > identification > creator')].some((c) => c.getAttribute('type') === 'composer')) {
    if (!ident) { ident = doc.createElement('identification'); const after = root.querySelector(':scope > movement-title') || root.querySelector(':scope > work'); root.insertBefore(ident, after ? after.nextElementSibling : root.firstElementChild); }
    const c = mk('creator', 'Meowsic'); c.setAttribute('type', 'composer');
    ident.insertBefore(c, ident.firstElementChild);
    changed = true;
  }
  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}
// A chord symbol must start where a note (or rest) of its own staff starts. One that sits between them —
// e.g. a <harmony><staff>1</staff> written among the left hand's notes, or one with an <offset> — makes OSMD
// build an empty staff entry and crash ("Cannot read properties of undefined (reading 'parentVoiceEntry')").
// Such a symbol moves to the nearest note start of its staff (an earlier one on a tie); returns how many moved.
export function snapHarmonies(doc) {
  let moved = 0;
  for (const m of doc.querySelectorAll('part > measure')) {
    if (!m.querySelector(':scope > harmony')) continue;
    let cur = 0;
    const starts = new Map(), hs = []; // staff → [{t, el}], harmonies
    const num = (el, sel) => +(el.querySelector(sel)?.textContent || 0);
    for (const el of m.children) {
      const tag = el.tagName;
      if (tag === 'note') {
        if (el.querySelector(':scope > grace')) continue;
        if (el.querySelector(':scope > chord')) continue;
        const s = num(el, ':scope > staff') || 1;
        if (!starts.has(s)) starts.set(s, []);
        starts.get(s).push({ t: cur, el });
        cur += num(el, ':scope > duration');
      } else if (tag === 'backup') cur = Math.max(0, cur - num(el, ':scope > duration'));
      else if (tag === 'forward') cur += num(el, ':scope > duration');
      else if (tag === 'harmony') hs.push({ el, t: cur + num(el, ':scope > offset'), off: !!el.querySelector(':scope > offset'), s: num(el, ':scope > staff') || 1 });
    }
    for (const h of hs) {
      const list = starts.get(h.s) || [];
      if (!h.off && list.some((x) => x.t === h.t)) continue;
      if (!list.length) { h.el.remove(); moved++; continue; }
      const near = list.reduce((b, x) => (Math.abs(x.t - h.t) < Math.abs(b.t - h.t) ? x : b), list[0]);
      h.el.querySelector(':scope > offset')?.remove();
      m.insertBefore(h.el, near.el);
      moved++;
    }
  }
  return moved;
}
export const hasChordSymbols =(xml) => /<harmony[\s>]/.test(xml || '');

// every graphical note of the drawn score, staff by staff (tab staves left out)
function* graphicalNotes(osmd) {
  for (const staves of osmd.GraphicSheet?.MeasureList || []) {
    for (const gm of staves || []) {
      if (!gm || gm.ParentStaff?.isTab) continue;
      for (const se of gm.staffEntries || []) for (const gve of se.graphicalVoiceEntries || []) yield gve;
    }
  }
}

// chord symbols as drawn (so they follow transpose), in order of first appearance
export function chordsOf(osmd) {
  const seen = [];
  for (const staves of osmd.GraphicSheet?.MeasureList || []) {
    for (const gm of staves || []) for (const se of gm?.staffEntries || []) for (const cc of se.graphicalChordContainers || []) {
      const t = (cc.GraphicalLabel?.Label?.text || '').trim();
      if (t && !seen.includes(t)) seen.push(t);
    }
  }
  return seen;
}

// the drawn pitch's letter (accidentals are drawn as signs, so just A–G)
export const noteLetter = (gn) => LETTER[(gn.sourceNote.TransposedPitch || gn.sourceNote.Pitch)?.FundamentalNote];

// letters inside the noteheads, the heads grown `grow` times (away from the stem, so it stays attached; a
// chord's heads only as far as the room between them allows). White on filled heads (quarter and shorter),
// black on open ones (half, whole). No letters on rests. minPx: on a small screen (iPhone) the heads grow
// more if needed for the letter to be at least this many pixels high on screen.
export function drawNoteLetters(osmd, { grow: grow0 = KIDS_GROW, minPx = 0 } = {}) {
  const svgs = new Set();
  const pxPer = new Map(); // svg → screen px per svg unit
  for (const gve of graphicalNotes(osmd)) {
    const notes = gve.notes.filter((n) => n.sourceNote && !n.sourceNote.isRest() && (n.sourceNote.TransposedPitch || n.sourceNote.Pitch));
    if (!notes.length) continue;
    const g = notes[0].getSVGGElement?.();
    if (!g) continue;
    const heads = [...g.querySelectorAll('.vf-notehead')].filter((h) => h.closest('.vf-stavenote') === g);
    if (!heads.length) continue;
    const svg = g.ownerSVGElement;
    let layer = svg.querySelector(':scope > g.nl-letters');
    if (!layer) { layer = document.createElementNS('http://www.w3.org/2000/svg', 'g'); layer.setAttribute('class', 'nl-letters'); layer.setAttribute('pointer-events', 'none'); svg.append(layer); svgs.add(svg); }
    // lowest head first ↔ lowest pitch first
    const boxes = heads.map((h) => ({ h, b: h.getBBox() })).sort((a, b) => b.b.y - a.b.y);
    let grow = grow0;
    // a chord: heads a step or a third apart only grow into the room between them
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1].b, c = boxes[i].b;
      if (Math.abs(a.x - c.x) < a.width * 0.6) grow = Math.min(grow, Math.max(1, (Math.abs(a.y - c.y) / a.height) * 0.98));
    }
    if (minPx) {
      if (!pxPer.has(svg)) { const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number); pxPer.set(svg, vb[2] ? svg.getBoundingClientRect().width / vb[2] : 1); }
      const px = boxes[0].b.height * 0.8 * pxPer.get(svg);
      if (px > 0 && px < minPx) grow = Math.max(grow, Math.min(2.2, minPx / px));
    }
    const sorted = [...notes].sort((a, b) => (a.sourceNote.TransposedPitch || a.sourceNote.Pitch).getHalfTone() - (b.sourceNote.TransposedPitch || b.sourceNote.Pitch).getHalfTone());
    const stem = g.querySelector('.vf-stem path, path.vf-stem');
    const sx = stem ? stem.getBBox().x : null;
    boxes.forEach(({ h, b }, i) => {
      const gn = sorted[Math.min(i, sorted.length - 1)];
      const L = noteLetter(gn);
      if (!L || h.dataset.nl) return;
      h.dataset.nl = L;
      // grow the head away from its stem, so the stem stays attached
      const cy = b.y + b.height / 2;
      let ax = b.x + b.width / 2;
      if (sx != null && boxes.length === 1) ax = Math.abs(sx - (b.x + b.width)) < Math.abs(sx - b.x) ? b.x + b.width : b.x;
      if (grow !== 1) h.setAttribute('transform', `translate(${ax} ${cy}) scale(${grow}) translate(${-ax} ${-cy})`);
      const cx = ax + (b.x + b.width / 2 - ax) * grow;
      const filled = gn.sourceNote.Length.RealValue < 0.5;
      const fs = b.height * grow * (filled ? 0.8 : 0.76);
      // an open head is drawn as a clean white oval so the black letter reads inside it
      if (!filled) {
        const e = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        const sw = b.height * 0.14, rx = (b.width * grow) / 2 - sw / 4, ry = (b.height * grow) / 2 - sw / 4;
        e.setAttribute('cx', cx.toFixed(2)); e.setAttribute('cy', cy.toFixed(2));
        e.setAttribute('rx', rx.toFixed(2)); e.setAttribute('ry', ry.toFixed(2));
        if (gn.sourceNote.Length.RealValue < 1) e.setAttribute('transform', `rotate(-15 ${cx.toFixed(2)} ${cy.toFixed(2)})`);
        e.setAttribute('fill', '#fff'); e.setAttribute('stroke', '#000'); e.setAttribute('stroke-width', sw.toFixed(2));
        e.setAttribute('class', 'nl-head');
        layer.append(e);
        h.setAttribute('opacity', '0');
      }
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', cx.toFixed(2));
      t.setAttribute('y', (cy + fs * 0.36).toFixed(2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', SANS);
      t.setAttribute('font-weight', '700');
      t.setAttribute('font-size', fs.toFixed(2));
      t.setAttribute('fill', filled ? '#fff' : '#000');
      t.setAttribute('class', 'nl');
      t.textContent = L;
      layer.append(t);
    });
  }
  return svgs.size;
}

// ---------- piano chord diagrams ----------

// "D7" -> [{ midi, name }] in an easy right-hand position near middle C:
// the root, third or fifth in the bass, as low as possible from C4 up
export function chordVoicing(name) {
  const c = splitChord(String(name).replace(/△/g, 'maj').replace(/Δ/g, 'maj'));
  if (!c) return null;
  const iv = chordIntervals(c.suffix);
  if (!iv) return null;
  const rootPc = notePc(c.root);
  const dim7 = iv.includes(3) && iv.includes(6) && iv.includes(9);
  const DEG = { 0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 5, 7: 5, 8: 5, 9: dim7 ? 7 : 6, 10: 7, 11: 7 };
  const tones = iv.map((s) => {
    const deg = s === 6 && iv.includes(7) ? 4 : DEG[s];
    const pc = (rootPc + s) % 12;
    const letter = LETTERS[(LETTERS.indexOf(c.root[0]) + deg - 1) % 7];
    const acc = ((pc - NAT[letter] + 18) % 12) - 6;
    return { pc, deg, name: letter + (ACC[acc] ?? '') };
  });
  const bassOk = tones.filter((t) => [1, 3, 5].includes(t.deg));
  let best = null;
  for (const b of bassOk.length ? bassOk : tones) {
    const bass = 60 + b.pc;
    if (!best || bass < best.bass) best = { bass, b };
  }
  return tones.map((t) => ({ midi: best.bass + ((t.pc - best.b.pc + 12) % 12), name: t.name })).sort((a, b) => a.midi - b.midi);
}

const BLACK = new Set([1, 3, 6, 8, 10]);
// one diagram: chord name on top, ~1.5 octaves of keys with the chord's keys grey, note names under them
export function keyboardSvg(name, { scale = 1 } = {}) {
  const v = chordVoicing(name);
  const W = 12, H = 46, BW = 7.4, BH = 28, top = 18;
  const lo = 60, hiNeed = Math.max(77, ...(v || []).map((n) => n.midi));
  let hi = hiNeed; while (![4, 11, 5].includes(hi % 12) || hi < 77) hi++;
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
  const width = whites.length * W + 1, height = top + H + 16;
  const on = new Map((v || []).map((n) => [n.midi, n.name]));
  const xOf = (m) => { const wi = whites.indexOf(BLACK.has(m % 12) ? m - 1 : m); return BLACK.has(m % 12) ? (wi + 1) * W - BW / 2 + 0.5 : wi * W + 0.5; };
  let s = '';
  for (const m of whites) s += `<rect x="${xOf(m)}" y="${top}" width="${W}" height="${H}" fill="${on.has(m) ? '#b4b4b4' : '#fff'}" stroke="#222" stroke-width="1"/>`;
  for (let m = lo; m <= hi; m++) if (BLACK.has(m % 12)) s += `<rect x="${xOf(m)}" y="${top}" width="${BW}" height="${BH}" fill="${on.has(m) ? '#9a9a9a' : '#222'}" stroke="#222" stroke-width="1"/>`;
  // names under their keys, nudged apart when two are close
  const labels = (v || []).map((n) => ({ x: xOf(n.midi) + (BLACK.has(n.midi % 12) ? BW / 2 : W / 2), t: n.name }));
  for (let i = 1; i < labels.length; i++) labels[i].x = Math.max(labels[i].x, labels[i - 1].x + 11);
  s += labels.map((l) => `<text x="${l.x.toFixed(1)}" y="${top + H + 12}" text-anchor="middle" font-family="${esc(SANS)}" font-size="10" fill="#000">${esc(l.t)}</text>`).join('');
  s += `<text x="${width / 2}" y="13" text-anchor="middle" font-family="${esc(SANS)}" font-size="13" font-weight="700" fill="#000">${esc(name)}</text>`;
  return { width: width * scale, height: height * scale, inner: s, svg: `<svg class="kbd" data-chord="${esc(name)}" data-notes="${esc((v || []).map((n) => n.name).join(' '))}" width="${(width * scale).toFixed(1)}" height="${(height * scale).toFixed(1)}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${s}</svg>` };
}

// the keyboard row drawn into OSMD's first page, in the room left under the title
// (TitleBottomDistance += KBD_ROOM when laying out). Screen and print.
export const KBD_ROOM = 10; // OSMD units (10 svg units each) kept free under the title
export const PRINT_ROOM = KBD_ROOM;
export function drawKeyboardRow(osmd, svg, { title } = {}) {
  svg.querySelector(':scope > g.easy-kbd-row')?.remove();
  const chords = chordsOf(osmd);
  if (!chords.length) return 0;
  const t = [...svg.querySelectorAll('text')].find((x) => x.textContent.trim() === String(title || osmd.Sheet?.TitleString || '').trim());
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const W = vb[2] || +svg.getAttribute('width') || 794;
  let y = 60;
  if (t) { const bb = t.getBBox(); y = bb.y + bb.height + 8; }
  const ks = chords.map((c) => ({ c, ...keyboardSvg(c) }));
  const gap = 16, sum = ks.reduce((a, k) => a + k.width, 0);
  const room = KBD_ROOM * 10 - 6;
  const scale = Math.min(room / ks[0].height, (W * 0.9 - gap * Math.max(0, ks.length - 1)) / Math.max(1, sum));
  const total = sum * scale + gap * Math.max(0, ks.length - 1);
  let x = (W - total) / 2, out = '';
  for (const k of ks) {
    out += `<g class="kbd" data-chord="${esc(k.c)}" data-notes="${esc((chordVoicing(k.c) || []).map((n) => n.name).join(' '))}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})">${k.inner}</g>`;
    x += k.width * scale + gap;
  }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'easy-kbd-row');
  g.innerHTML = out;
  svg.append(g);
  return chords.length;
}
export function decoratePrintPage(osmd) {
  drawNoteLetters(osmd);
}
