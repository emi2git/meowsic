// Kids note names (the kitten button): noteheads with the note's letter inside, on every staff, like an
// E-Z Play / big-note children's sheet — white letters on filled heads, black on open ones. A head is never
// taller than one staff space, so a space note (F in the treble) sits between its two lines and a line note is
// centred on its line (kidsheads.mjs measures it). The notes are spaced a little wider for the letters; everything else stays OSMD's classic engraving (title, composer,
// tempo, chord symbols, lyrics). No chord diagrams (those are the ukulele panel's, ukepanel.js).
// Works on a rendered OpenSheetMusicDisplay instance (screen and print).
import { splitChord, chordIntervals, notePc, esc } from './chords.js';

const LETTER = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const LETTERS = 'CDEFGAB';
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// note-name stems (kids): off by default; the toggle is remembered on this device, for every score
export const KIDS_KEY = 'meowsic-kids';
export function easyOn() {
  try { return localStorage.getItem(KIDS_KEY) === '1'; } catch { return false; }
}
export function setEasy(it, on) { try { localStorage.setItem(KIDS_KEY, on ? '1' : '0'); } catch {} }

// how big the heads are (× a normal head): a normal head is ~1.15 staff spaces tall as drawn, so 0.78 makes it
// ~0.9 — inside a space with both lines still showing. Never more than 1 space: bigger heads hide which line or space a
// note is on (they were 1.85× until 2026-11-26: ~2 spaces tall, covering both lines). The spacing is a bit wider
// so the letters have room.
export const KIDS_GROW = 0.78;
// …and the staff is drawn this much bigger in kids mode (screen and print), so those heads are big enough to read
export const KIDS_STAFF = 1.5;
export function kidsRules(r) {
  r.VoiceSpacingMultiplierVexflow = 1.1; r.VoiceSpacingAddendVexflow = 4; r.MinNoteDistance = 3;
  r.KidsHeadScale = KIDS_GROW; // read by the VexFlow hook below: heads are sized before layout
  hookBigHeads();
}

// Kids heads, engraved properly: each VexFlow StaveNote OSMD builds gets its noteheads scaled (glyph_font_scale)
// *before* layout, so VexFlow itself puts the stem at the head's edge (right going up, left going down), and
// spaces beams, flags, dots, accidentals and ties for the big head. Only for scores whose rules ask for it
// (kidsRules); grace and cue notes stay small. Ledger lines are widened to fit (VexFlow sizes them unscaled).
function hookBigHeads() {
  const C = window.opensheetmusicdisplay?.VexFlowConverter;
  if (!C?.StaveNote || C.StaveNote.kidsHook) return;
  const orig = C.StaveNote;
  const hooked = function (gve, ...rest) {
    const vf = orig.call(this, gve, ...rest);
    try {
      const g = gve?.parentStaffEntry?.parentMeasure?.parentSourceMeasure?.Rules?.KidsHeadScale;
      if (g && vf && !gve.parentVoiceEntry?.IsGrace && !gve.notes?.[0]?.sourceNote?.IsCueNote) growHeads(vf, g);
    } catch (e) { console.warn('kids heads', e); }
    return vf;
  };
  hooked.kidsHook = true;
  C.StaveNote = hooked;
}
function growHeads(vf, grow) {
  if (vf.isRest?.() || !vf.render_options || !vf.keyProps?.length) return;
  // a chord: heads a third apart (one staff space) would overlap when big, so they grow less
  const lines = vf.keyProps.map((k) => k.line).sort((a, b) => a - b);
  let s = grow;
  for (let i = 1; i < lines.length; i++) { const d = lines[i] - lines[i - 1]; if (d >= 1 && d < 2) s = Math.min(s, 1.15 * d); }
  const base = vf.render_options.glyph_font_scale;
  vf.render_options.glyph_font_scale = base * s;
  vf.kidsScale = s;
  vf.reset();
  // ledger lines: VexFlow sizes them by the unscaled glyph width — draw them with the big head's width
  const draw = vf.drawLedgerLines;
  if (typeof draw === 'function') {
    vf.drawLedgerLines = function () {
      const gl = this.glyph, sc = this.render_options.glyph_font_scale;
      this.glyph = Object.create(gl, { getWidth: { value: () => gl.getWidth(sc) } });
      try { return draw.call(this); } finally { this.glyph = gl; }
    };
  }
}

// what Meowsic did, drawn small on a score: Arranged (a version made from another score), Read (photo → score),
// Made (a piece Meowsic wrote), Transcribed (a recording / video / audio file) — the server writes the same (db.score_byline)
export function byline(it) {
  const src = it.source || '';
  return src.startsWith('From the score') ? 'Arranged by Meowsic' : src.startsWith('From the sheet') ? 'Read by Meowsic'
    : it.ai || /^Meowsic( AI)?$/.test(src) ? 'Made by Meowsic' : 'Transcribed by Meowsic';
}

// no tempo on a drawn score (screen and print): metronome marks (♩ = 72), tempo words (Moderato, Slowly, rit.,
// "a tempo", "= 72", "bpm"…) and <sound tempo> go. Only what is drawn: the player reads the tempo from the file.
const TEMPO_WORDS = /^\s*[(\[]?\s*(?:(?:molto|poco|un poco|più|piu|meno|very|quite|a little|fairly|not too|not)\s+)*(?:larghissimo|largo|larghetto|lento|grave|adagio|adagietto|andante|andantino|moderato|allegretto|allegro|vivace|vivacissimo|presto|prestissimo|tempo(?:\s+(?:i|1|primo|di\s+\w+))?|a\s+tempo|rubato|ad\s+lib\.?|rit\.?|ritard\.?|ritardando|ritenuto|riten\.?|rall\.?|rallentando|accel\.?|accelerando|stringendo|allargando|slowly|slow|fast|quickly|briskly|brightly|moderately|moderate|lively|freely|steadily|steady|gently|leisurely)\b/i;
const tempoText = (t) => { const s = t.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').trim(); return !!s && (TEMPO_WORDS.test(s) || /=\s*(?:c\.\s*|ca\.\s*)?\d{2,3}\b|\b\d{2,3}\s*bpm\b|[♩♪𝅘𝅥𝅗𝅥]/i.test(s)); };
export function noTempoXml(xml) {
  if (!xml) return xml;
  const dropTempo = (sound) => { const s = sound.replace(/\s+tempo\s*=\s*"[^"]*"/g, ''); return /^<sound\s*\/?>(?:<\/sound>)?$/.test(s.replace(/\s+(?=\/?>)/g, '')) ? '' : s; };
  return xml
    .replace(/<direction\b[^>]*>[\s\S]*?<\/direction>/g, (d) => {
      const types = d.match(/<direction-type\b[^>]*>[\s\S]*?<\/direction-type>/g) || [];
      const keep = types.filter((t) => !/<metronome\b/.test(t) && !((t.match(/<words\b[^>]*>([\s\S]*?)<\/words>/g) || []).some(tempoText) && !/<(?:dynamics|segno|coda|rehearsal|wedge|pedal|octave-shift|bracket|dashes)\b/.test(t)));
      const out = d.replace(/<sound\b[^>]*\/>|<sound\b[^>]*>[\s\S]*?<\/sound>/g, (s) => dropTempo(s));
      if (keep.length === types.length) return out;
      if (keep.length) return out.replace(/<direction-type\b[^>]*>[\s\S]*?<\/direction-type>/g, (t) => (keep.includes(t) ? t : ''));
      return (out.match(/<sound\b[^>]*\/>|<sound\b[^>]*>[\s\S]*?<\/sound>/g) || []).join(''); // a <sound> with other settings stays, as a measure child
    })
    .replace(/<sound\b[^>]*\btempo\s*=[^>]*\/>/g, (s) => dropTempo(s));
}

// the MusicXML as OSMD should draw it: music21's stand-in title ("Music21 Fragment") becomes the item's title, its
// "Music21" stamp goes; the credits are the item's real Artist (composer) + what Meowsic did (byline)
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
  root.querySelectorAll(':scope > identification > creator').forEach((c) => { const t = c.textContent.trim(); if (/^music21$/i.test(t)) { c.remove(); changed = true; } });
  if (it) {  // the credits drawn: composer = the item's real Artist; on the left, what Meowsic did (OSMD's lyricist place)
    root.querySelectorAll(':scope > identification > creator').forEach((c) => c.remove());
    if (!ident) { ident = doc.createElement('identification'); const after = root.querySelector(':scope > movement-title') || root.querySelector(':scope > work'); root.insertBefore(ident, after ? after.nextElementSibling : root.firstElementChild); }
    const a = (it.artist || '').trim();
    if (a && !/^Meowsic( AI)?$/.test(a)) { const c = mk('creator', a); c.setAttribute('type', 'composer'); ident.insertBefore(c, ident.firstElementChild); }
    const by = mk('creator', byline(it)); by.setAttribute('type', 'lyricist'); ident.append(by);
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

// letters inside the noteheads. Heads are sized by VexFlow (hookBigHeads); if that hook is missing, they are
// scaled here by `grow` (away from the stem, so it stays attached; a chord's heads only as far as the room
// between them allows). White on filled heads (quarter and shorter), black on open ones (half, whole), the
// letter as big as the head allows (scales with it at every zoom). No letters on rests. The head never grows
// past one staff space: that would hide its line / space.
export function drawNoteLetters(osmd, { grow: grow0 = KIDS_GROW } = {}) {
  const svgs = new Set();
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
    // heads already made big by VexFlow (hookBigHeads): stems sit at their edges — no growing here
    const native = !!gve.vfStaveNote?.kidsScale;
    let grow = native ? 1 : grow0;
    // a chord: heads a step or a third apart only grow into the room between them
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1].b, c = boxes[i].b;
      if (!native && Math.abs(a.x - c.x) < a.width * 0.6) grow = Math.min(grow, Math.max(1, (Math.abs(a.y - c.y) / a.height) * 0.98));
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
      const H = b.height * grow; // the head's drawn height (≤ 1 staff space)
      // a bold capital's cap height is ~0.72 em: the letter fills ~2/3 of the head's height
      const fs = H * (filled ? 0.95 : 0.88);
      // an open head is drawn as a clean white oval so the black letter reads inside it, no taller than the glyph
      // it replaces (outer edge of the tilted, stroked oval = the glyph's height)
      if (!filled) {
        const e = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        const tilt = gn.sourceNote.Length.RealValue < 1 ? 15 : 0, th = (tilt * Math.PI) / 180;
        const sw = H * 0.12, rx = (b.width * grow) / 2 - sw / 2, half = H / 2 - sw / 2;
        const ry = Math.sqrt(Math.max(half * half - (rx * Math.sin(th)) ** 2, (half * 0.6) ** 2)) / Math.cos(th);
        e.setAttribute('cx', cx.toFixed(2)); e.setAttribute('cy', cy.toFixed(2));
        e.setAttribute('rx', rx.toFixed(2)); e.setAttribute('ry', ry.toFixed(2));
        if (tilt) e.setAttribute('transform', `rotate(-${tilt} ${cx.toFixed(2)} ${cy.toFixed(2)})`);
        e.setAttribute('fill', '#fff'); e.setAttribute('stroke', '#000'); e.setAttribute('stroke-width', sw.toFixed(2));
        e.setAttribute('class', 'nl-head');
        layer.append(e);
        h.__nlOval = e; // for tests (kidsheads.mjs)
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
      t.__nlHead = h; // for tests (kidsheads.mjs)
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

export function decoratePrintPage(osmd) {
  drawNoteLetters(osmd);
}
