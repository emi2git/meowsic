// Edit notes (the score toolbar ✎, or "Edit notes" on a bar in Check bars): pick notes on the score and change
// them. Tap / click a note (or a rest) to pick it; ⌘ / Ctrl-click (iPad / iPhone: "Pick several") adds or takes one
// away; drag a box to pick everything in it; "Whole bar" picks every note of the picked notes' bars on their staves.
// A range (a blue box): Shift-click (iPad / iPhone: long-press a note, then tap or drag to another) picks everything
// from one note to the other on every staff between them; Shift ← / → makes it a note longer / shorter, ⌘A is the
// whole score, Esc lets it go. Every tool works on the range. Copy / Cut (⌘C / ⌘X: a cut leaves rests) / Paste (⌘V:
// at the picked note, written over what follows, bars added at the end when needed) / ⟳ Repeat (R: the selection
// again right after itself) — ties, slurs, lyrics and chord names come along (rangeops.py). ♯/♭ (J) spells the
// picked notes another way (C♯ → D♭ …); held down (right-click): ♯ ♭ ♮ and a courtesy accidental. Then:
//   ♭ / ♯ a semitone down / up (↓ / ↑), 8↓ / 8↑ an octave (⌘↓ / ⌘↑), a length (1–6 = 32nd … whole, . = dotted) —
//   of a note or a rest (a rest made shorter leaves a rest after it, or "Pull the next notes earlier"; made longer it
//   takes the time of what follows in the bar — the notes it shortened or took are named and shown, Undo brings them
//   back; too long for the bar: refused) —, = Even out (Q, shown when 2+ notes / rests one after the other in one
//   voice are picked: one length each, the same total — dotted 8th + 16th → two 8ths; evenops.py), →| Fill next rest (E: the note takes in the one rest after it, each press
//   one more; never a note), Delete (a rest stays; on a rest: Remove rest — what follows comes earlier and the bar is
//   left short, "Previous note fills it" a tap away; a rest at the end of its bar: pull notes from the next bar or the
//   note before fills it; a whole-bar rest: Delete this bar), + Note (a third above, in the chord; on a rest: "+ Note here"
//   turns it into a note, then move it up / down),
//   and, in a piano part, to the right / left hand (Shift ↑ / Shift ↓); ⌒ Tie (T) to the next note of the same
//   pitch, ⁀ Slur (S) over the picked notes (on a slurred note: takes it away). Ties and slurs stay through every edit.
// ← / → pick the note before / after on that staff (the page turns with it); Shift ← / → or ‹ › / the page dots turn
// the page; the picked notes, the edits and the play start stay. After every edit (and a save) the play start (the
// orange line) goes to one bar before the first bar edited, so Play — or "▶ From here", which starts a bar before the picked
// notes — plays the change as it is drawn (not saved yet). Tapping the score here picks notes; it never moves
// the line.
// Mac, mouse: press a notehead and drag it — up / down a line or space at a time in the key (⌥: a semitone), sideways
// to another beat of this bar or another (onto rests; onto a note of the same length: the two swap; else refused) —
// a ghost note and its name show where it goes, Esc cancels, letting go is one edit (op shift / pitch). Click a tie
// or a slur to pick it; its ✕ or ⌫ / Delete takes it away. (Touch keeps tap to pick; the keys are in Help.)
// A bar left short / over-full is never filled on its own: it is tinted with a badge ("3 of 4 beats", score.js +
// incomplete.js); tapping the badge here offers Fill with rest / Change time for this bar / Keep editing (one undo
// step); saving with such bars is allowed and says how many.
// The Mac rebuilds the bars (server/meowsic/staffmove.py: every voice of both staves stays full, chords together,
// rests where a hand has nothing to play) and the score draws again at once. Undo / redo inside the editor;
// Save into this score (the file before stays in .history, Activities can undo it) or as a new version.
// Never lost (editdraft.js + server editsafe.py): the edits are a draft in this browser after every edit and on the
// Mac every ~30 s / when the page hides; reopening offers "Restore unsaved edits". While open, an edit session locks
// the score against other API writes (423). Previews replay on the score as it opened (sha); a Save after another
// client changed the score merges onto it (or keeps the full edit as "<title> (my edits)"), never a dead end.
import { iconOn, toast, sheet as modal, confirmSheet, menu } from '../ui.js';
import { store, setEditSession } from '../store.js';
import { go } from '../app.js';
import { isTouch } from '../device.js';
import { barFixSheet, fixBarOp } from '../incomplete.js';
import { lyricMode } from './lyricmode.js'; // [lyrics]
import { attachMidi } from '../midiedit.js';
import { barMarks, ottavaLines, ottavaAt } from '../musicxml.js';
import { noteIcon, DOT_IC, EVEN_IC } from '../notevalue.js';
import { handsHtml, handsClick } from '../hands.js';
import { newSession, findDraft, dropDrafts, dropLocal, editGuard, saveNote } from '../editdraft.js';

let EDIT_SESSION = null; // the open editor's session (editdraft.js): its own writes pass the Mac's lock
export const post = (path, body) => fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(EDIT_SESSION ? { 'X-Edit-Session': EDIT_SESSION } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); return j; });

export const hasPiano = (xml) => /<staves>\s*[2-9]\s*<\/staves>/.test(xml || '');
// times in quarters, rounded (float sums) to 1/10000: a dotted 32nd (0.1875) and its places stay exact
const r3 = (x) => Math.round(x * 10000) / 10000;
// a note's own notehead (the notes of a chord share one VexFlow note; its heads are drawn in order, one group each)
const headEl = (gn) => {
  const g = gn.getSVGGElement?.();
  const heads = g?.querySelectorAll(':scope > .vf-note > .vf-notehead');
  return heads?.[gn.vfnoteIndex ?? gn.vfnote?.[1] ?? 0] || g;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// the length buttons and number keys: [quarters, name, key] — 1 = 32nd … 6 = whole (MuseScore's 2–7 one lower:
// the keys 2–6 were here first and stay); drawn as note / rest glyphs (notevalue.js)
const LENS = [[0.125, '32nd note', '1'], [0.25, '16th note', '2'], [0.5, 'Eighth note', '3'], [1, 'Quarter note', '4'], [2, 'Half note', '5'], [4, 'Whole note', '6']];
const DOTTED = new Set([0.1875, 0.375, 0.75, 1.5, 3]);
const LONG_MS = 450; // a long press
const fq = (x) => { const [a, b] = String(x).split('/'); return +a / (+b || 1); }; // "3/2" → 1.5
// what a staff is called (1-based, of n): a melody; right / left hand; voice + both hands; else its number
export const staffName = (s, n) => (n === 1 ? 'melody' : n === 2 ? (s === 1 ? 'right hand' : 'left hand') : n === 3 ? ['voice', 'right hand', 'left hand'][s - 1] : `staff ${s}`);
const SVGNS = 'http://www.w3.org/2000/svg';
const CLIP_KEY = 'meowsic-noteclip'; // what Copy / Cut took (this device; pastes into any score)
const COPY_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/></svg>';
const CUT_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.2 15.8L19 3M15.8 15.8L5 3"/></svg>';
const PASTE_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M8 12h8M8 16h5"/></svg>';
// the tie and slur buttons: two noteheads with a short flat arc / three rising noteheads under a long arc
const TIE_IC = '<svg class="ic np-arcic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12c3 -4 11 -4 14 0"/><ellipse cx="5" cy="16" rx="2.4" ry="1.7" fill="currentColor"/><ellipse cx="19" cy="16" rx="2.4" ry="1.7" fill="currentColor"/></svg>';
const SLUR_IC = '<svg class="ic np-arcic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13c3 -10 15 -10 18 -6"/><ellipse cx="4" cy="18" rx="2.2" ry="1.6" fill="currentColor"/><ellipse cx="12" cy="14" rx="2.2" ry="1.6" fill="currentColor"/><ellipse cx="20" cy="11" rx="2.2" ry="1.6" fill="currentColor"/></svg>';

// opts: { bar: 1-based bar to start on (its notes picked), extraOps: () => [ops added on Save], title, onDone(result | null) }
export async function editNotes(view, it, host, opts = {}) {
  if (!host || host.querySelector('.notes-panel')) return;
  host.querySelector('.editbar')?.dispatchEvent(new Event('close'));
  view.player?.pause();
  const url = `/items/${encodeURIComponent(it.id)}/editnotes`;
  let base;
  try { base = await post(`${url}/preview`, { ops: [] }); } catch (e) { toast(e.message); opts.onDone?.(null); return; }
  // unsaved edits of this score from before (a reload, a crash, the Mac restarted, another device): offer them back
  let session = newSession(), restored = null;
  const draft = await findDraft(it.id);
  if (draft) {
    if (await restoreSheet(draft)) {
      try {
        const b0 = draft.sha && draft.sha !== base.sha ? await post(`${url}/preview`, { ops: [], sha: draft.sha }) : base; // the score as that editor saw it
        const j = await post(`${url}/preview`, { ops: draft.ops, sha: b0.sha });
        base = b0; restored = { ops: draft.ops, xml: j.xml, notes: j.notes };
        if (draft.session) session = draft.session;
      } catch (e) {
        saveNote(`Could not restore the unsaved edits (${e.message}). They are still kept: open Edit notes again to try once more.`, { error: true, action: { label: 'Discard them', run: () => dropDrafts(it.id) } });
        opts.onDone?.(null); return;
      }
    } else await dropDrafts(it.id);
  }
  if (host.querySelector('.notes-panel')) return;
  EDIT_SESSION = session; setEditSession(session);
  const paper = host.querySelector('#paper');
  const panel = document.createElement('div');
  panel.className = 'notes-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Edit notes');
  host.append(panel);
  // [lyrics] the notes part of the panel draws again on every change; the lyrics bar (lyricmode.js) stays beside it
  const npBody = document.createElement('div');
  npBody.className = 'np-body';
  panel.append(npBody);
  let lyr = null; // [lyrics] Lyrics mode (lyricmode.js)
  host.classList.add('noting');
  // steps[0] = the score as saved; each edit adds one (its ops = every edit so far, replayed by the Mac)
  let steps = [{ ops: [], xml: base.xml, notes: base.notes }], at = 0;
  if (restored) { steps.push({ ops: restored.ops, xml: restored.xml, notes: restored.notes, sel: [], bar: null }); at = 1; }
  // the edit session (the Mac's lock) and the drafts: this browser after every edit, the Mac every ~30 s
  const guard = editGuard(it, session, () => ({ sha: base.sha, ops: cur().ops, n: at, xml: cur().xml }), () => panel.isConnected && !closed);
  guard.start(base.sha);
  let sel = new Set(), anchor = null, several = false, busy = false, shown = false, closed = false, cueAt = null, took = new Set();
  let dropped = false; // the orange line was dragged since the last pick: ▶ From here plays from it, not the picked notes
  let barPick = null; // a bar picked by tapping its empty space: { bar (0-based), staff }
  let midiCtl = null; // a MIDI keyboard (midiedit.js): its chip in the bar
  // a range: { a, b (quarters from the start, b not in it), s0, s1 (staves) }; drawn as a blue box
  let rng = null, rangeArm = false, rangeEnd = 1;
  let clip = (() => { try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { return null; } })();
  const cur = () => steps[at];
  const nStaves = () => Math.max(1, +(cur().xml.match(/<staves>\s*(\d+)/)?.[1] || 1), ...cur().notes.map((n) => n.staff));
  const byRef = () => new Map(cur().notes.map((n) => [n.ref, n]));

  // ---- the drawn notes: data-ref on each notehead (matched by bar, staff, time, then pitch order) and rest ----
  const tag = () => {
    const osmd = view.osmd;
    if (!osmd || closed) return;
    const inst = osmd.Sheet?.Instruments?.[base.part];
    if (!inst) return;
    const groups = new Map();
    for (const n of cur().notes) {
      const k = `${n.rest ? 'R' : 'N'}|${n.bar}|${n.staff}|${r3(n.on)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(n);
    }
    groups.forEach((g) => g.sort((a, b) => (a.midi ?? 0) - (b.midi ?? 0)));
    const srcRef = new Map(), vfIdx = new Map(); // OSMD note → ref; VexFlow note → (key index → ref), for the arcs
    osmd.GraphicSheet.MeasureList.forEach((gms, bi) => {
      for (const gm of gms || []) {
        const si = gm ? inst.Staves.indexOf(gm.ParentStaff) : -1;
        if (si < 0) continue;
        const drawn = new Map();
        for (const se of gm.staffEntries || []) {
          const on = r3((se.relInMeasureTimestamp?.RealValue || 0) * 4);
          for (const gve of se.graphicalVoiceEntries || []) {
            if (gve.parentVoiceEntry?.IsGrace) continue;
            for (const gn of gve.notes || []) {
              const sn = gn.sourceNote;
              if (!sn || sn.IsGraceNote) continue;
              const rest = !!sn.isRest?.();
              const k = `${rest ? 'R' : 'N'}|${bi}|${si + 1}|${on}`;
              (drawn.get(k) || drawn.set(k, []).get(k)).push({ gn, ht: rest ? 0 : sn.halfTone ?? 0, rest });
            }
          }
        }
        drawn.forEach((d, k) => {
          const g = groups.get(k);
          if (!g) return;
          d.sort((a, b) => a.ht - b.ht);
          d.slice(0, g.length).forEach((x, i) => {
            const el = x.rest ? x.gn.getSVGGElement?.() : headEl(x.gn);
            srcRef.set(x.gn.sourceNote, g[i].ref);
            const vn = x.gn.vfnote?.[0];
            if (!x.rest && vn) (vfIdx.get(vn) || vfIdx.set(vn, new Map()).get(vn)).set(x.gn.vfnoteIndex ?? x.gn.vfnote?.[1] ?? 0, g[i].ref);
            if (!el) return;
            el.dataset.ref = g[i].ref;
            el.classList.add('nh-hit');
            el.classList.toggle('nh-rest', x.rest);
            el.classList.toggle('nh-on', sel.has(g[i].ref));
            el.classList.toggle('nh-took', took.has(g[i].ref));
          });
        });
      }
    });
    tagArcs(srcRef, vfIdx);
  };
  // ---- ties and slurs on the score: click one to pick it, then ⌫ / Delete or its ✕ takes it away ----
  let arcSel = null; // { kind: 'tie' | 'slur', ref: the note it starts on }
  const tagArcs = (srcRef, vfIdx) => {
    const osmd = view.osmd, s = starts(), notes = cur().notes, m = byRef();
    const put = (el, kind, ref) => {
      if (!el || ref == null || !el.classList) return;
      el.classList.add('np-arc-hit');
      el.dataset.arc = kind; el.dataset.arcRef = ref;
    };
    // a tie drawn from the start of a line: its start note is the same pitch ending where this one starts
    const tieInto = (stop) => {
      const z = m.get(stop);
      return z && notes.find((n) => n.tie && n.staff === z.staff && n.midi === z.midi && Math.abs(absOf(n, s) + n.dur - absOf(z, s)) < 1e-6)?.ref;
    };
    for (const gms of osmd.GraphicSheet.MeasureList || []) for (const gm of gms || []) for (const t of gm?.vfTies || []) {
      const tn = t.notes || t, el = t.getAttribute?.('el');
      if (tn.first_note) put(el, 'tie', vfIdx.get(tn.first_note)?.get(tn.first_indices?.[0] ?? 0));
      else if (tn.last_note) put(el, 'tie', tieInto(vfIdx.get(tn.last_note)?.get(tn.last_indices?.[0] ?? 0)));
    }
    for (const pg of osmd.GraphicSheet.MusicPages || []) for (const sys of pg.MusicSystems || []) for (const sl of sys.StaffLines || [])
      for (const gs of sl.GraphicalSlurs || []) put(gs.SVGElement, 'slur', srcRef.get(gs.slur?.StartNote));
    markArc();
  };
  const arcEl = () => arcSel && paper.querySelector(`.np-arc-hit[data-arc="${arcSel.kind}"][data-arc-ref="${arcSel.ref}"]`);
  let arcX = null;
  const markArc = () => {
    paper.querySelectorAll('.np-arc-on').forEach((g) => g.classList.remove('np-arc-on'));
    const el = !closed && arcEl();
    if (!el) { arcX?.remove(); arcX = null; return; }
    el.classList.add('np-arc-on');
    if (!arcX) {
      arcX = document.createElement('button');
      arcX.className = 'np-arc-x';
      arcX.textContent = '✕';
      arcX.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
      arcX.addEventListener('click', (e) => { e.stopPropagation(); removeArc(); });
      document.body.append(arcX);
    }
    const word = arcSel.kind === 'tie' ? 'tie' : 'slur';
    arcX.title = `Remove this ${word} (⌫)`; arcX.setAttribute('aria-label', `Remove ${word}`);
    const r = el.getBoundingClientRect();
    Object.assign(arcX.style, { left: `${r.right - 4}px`, top: `${r.top - 26}px` });
  };
  const pickArc = (el) => {
    arcSel = { kind: el.dataset.arc, ref: +el.dataset.arcRef };
    sel = new Set(); rng = null; rangeArm = false; barPick = null;
    paint();
  };
  const removeArc = () => {
    const a = arcSel;
    if (!a) return;
    arcSel = null; markArc();
    act(() => run(a.kind === 'tie' ? { op: 'tie', refs: [a.ref] } : { op: 'unslur', refs: [a.ref], at: 'start' }));
  };
  const onScroll = () => arcX && markArc();
  document.addEventListener('scroll', onScroll, true);
  const paint = () => {
    paper.querySelectorAll('g[data-ref]').forEach((g) => g.classList.toggle('nh-on', sel.has(+g.dataset.ref)));
    if (sel.size || rng || barPick) arcSel = null;
    markBar();
    markRange();
    markArc();
    draw();
  };
  // ---- a range: times from the start of the score (each bar as long as its longest voice) ----
  const starts = () => {
    const len = [];
    for (const n of cur().notes) len[n.bar] = Math.max(len[n.bar] || 0, n.on + n.dur);
    const s = [0];
    for (let i = 0; i < len.length; i++) s.push(r3(s[i] + (len[i] || 0)));
    return s; // s[bars] = the end
  };
  const absOf = (n, s = starts()) => s[n.bar] + n.on;
  const placeOf = (q, s = starts()) => { let b = 0; while (b + 2 < s.length && s[b + 1] <= q + 1e-6) b++; return [b, r3(q - s[b])]; };
  const spanOf = (ns) => {
    const s = starts();
    return { a: Math.min(...ns.map((n) => absOf(n, s))), b: Math.max(...ns.map((n) => absOf(n, s) + n.dur)), s0: Math.min(...ns.map((n) => n.staff)), s1: Math.max(...ns.map((n) => n.staff)) };
  };
  const inRange = (r) => { const s = starts(); return cur().notes.filter((n) => n.staff >= r.s0 && n.staff <= r.s1 && absOf(n, s) >= r.a - 1e-6 && absOf(n, s) < r.b - 1e-6).map((n) => n.ref); };
  const setRange = (r) => { rng = r; rangeArm = false; if (r) barPick = null; sel = new Set(r ? inRange(r) : []); paint(); };
  const wholeScore = () => { const s = starts(); setRange({ a: 0, b: s.at(-1), s0: 1, s1: nStaves() }); };
  // the window the copy / cut / repeat tools take: the range, else from the first picked note to the end of the last
  const windowOf = () => {
    const s = starts();
    const r = rng || (picked().length ? spanOf(picked()) : barPick ? { a: s[barPick.bar], b: s[barPick.bar + 1], s0: barPick.staff, s1: barPick.staff } : null);
    return r && { ...r, start: placeOf(r.a, s), end: r.b >= s.at(-1) - 1e-6 ? [s.length - 1, 0] : placeOf(r.b, s) };
  };
  const markRange = () => {
    paper.querySelectorAll('.np-range').forEach((r) => r.remove());
    if (!rng || closed) return;
    const s = starts(), rows = new Map();
    for (const b of barBoxes()) {
      if (b.staff < rng.s0 || b.staff > rng.s1 || s[b.bar + 1] <= rng.a + 1e-6 || s[b.bar] >= rng.b - 1e-6) continue;
      const k = `${b.bar}|${pagesOf(b.svg)}`, y = rows.get(k);
      rows.set(k, y ? { ...y, y0: Math.min(y.y0, b.y), y1: Math.max(y.y1, b.y + b.h) } : { ...b, y0: b.y, y1: b.y + b.h });
    }
    const heads = [...paper.querySelectorAll('g[data-ref].nh-on')];
    rows.forEach((b) => {
      let x0 = b.x * 10, x1 = (b.x + b.w) * 10;
      const mine = heads.map((g) => [g, byRef().get(+g.dataset.ref)]).filter(([, n]) => n?.bar === b.bar).map(([g]) => { try { return g.getBBox(); } catch { return null; } }).filter(Boolean);
      if (s[b.bar] < rng.a - 1e-6 && mine.length) x0 = Math.min(...mine.map((r) => r.x)) - 12;
      if (s[b.bar + 1] > rng.b + 1e-6 && mine.length) x1 = Math.max(...mine.map((r) => r.x + r.width)) + 12;
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('class', 'np-range');
      r.setAttribute('x', x0); r.setAttribute('y', b.y0 * 10); r.setAttribute('width', Math.max(10, x1 - x0)); r.setAttribute('height', (b.y1 - b.y0) * 10);
      r.dataset.bar = b.bar;
      b.svg.insertBefore(r, b.svg.firstChild);
    });
  };
  const pagesOf = (svg) => [...paper.querySelectorAll('#osmd svg')].indexOf(svg);
  // ---- bars: where each drawn bar is (per staff), the picked one shaded ----
  const barBoxes = function* () {
    const osmd = view.osmd, inst = osmd?.Sheet?.Instruments?.[base.part];
    if (!inst) return;
    const pages = osmd.GraphicSheet.MusicPages, svgs = [...paper.querySelectorAll('#osmd svg')];
    for (const [bi, gms] of (osmd.GraphicSheet.MeasureList || []).entries()) {
      for (const gm of gms || []) {
        const si = gm ? inst.Staves.indexOf(gm.ParentStaff) : -1, ps = gm?.PositionAndShape;
        if (si < 0 || !ps) continue;
        const svg = svgs[Math.max(0, pages.indexOf(gm.ParentMusicSystem?.Parent))];
        const y0 = (gm.ParentStaffLine?.PositionAndShape || ps).AbsolutePosition.y;
        if (svg) yield { bar: bi, staff: si + 1, svg, x: ps.AbsolutePosition.x + ps.BorderLeft, w: ps.BorderRight - ps.BorderLeft, y: y0 - 1.5, h: 7 };
      }
    }
  };
  const barAt = (cx, cy) => {
    for (const b of barBoxes()) {
      const m = b.svg.getScreenCTM?.();
      if (!m) continue;
      const p = new DOMPoint(cx, cy).matrixTransform(m.inverse()), x = p.x / 10, y = p.y / 10;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { bar: b.bar, staff: b.staff };
    }
    return null;
  };
  const markBar = () => {
    paper.querySelectorAll('.np-barpick').forEach((r) => r.remove());
    if (!barPick || closed) return;
    for (const b of barBoxes()) {
      if (b.bar !== barPick.bar) continue;
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('class', 'np-barpick' + (b.staff === barPick.staff ? ' on' : ''));
      r.setAttribute('x', b.x * 10); r.setAttribute('y', b.y * 10); r.setAttribute('width', b.w * 10); r.setAttribute('height', b.h * 10); r.setAttribute('rx', 6);
      r.dataset.bar = b.bar; r.dataset.staff = b.staff;
      b.svg.insertBefore(r, b.svg.firstChild);
    }
  };
  const untag = () => paper.querySelectorAll('g[data-ref]').forEach((g) => { g.classList.remove('nh-hit', 'nh-on', 'nh-rest', 'nh-took'); delete g.dataset.ref; });
  host.addEventListener('scoredrawn', tag);
  host.addEventListener('scoredrawn', markBar);
  host.addEventListener('scoredrawn', markRange);
  const onBarFix = async (e) => {
    e.stopPropagation();
    const b = e.detail, how = await barFixSheet(b);
    if (how) run(fixBarOp(b, how), null, { bar: b.bar - 1 });
  };
  host.addEventListener('barfix', onBarFix, true);

  // ---- the panel ----
  const picked = () => [...sel].map((r) => byRef().get(r)).filter(Boolean);
  const draw = () => {
    if (closed) return;
    const p = picked(), ns = p.filter((n) => !n.rest), rs = p.filter((n) => n.rest);
    const nst = nStaves(), [toUp, toDown] = [moveDest(-1), moveDest(1)];
    const up = toUp ? ns.filter((n) => n.staff !== toUp).length : 0, down = toDown ? ns.filter((n) => n.staff !== toDown).length : 0;
    const tgt = target();
    // the length buttons: of the notes picked, else of the rests picked
    const ls = ns.length ? ns : rs;
    const len = ls.length && ls.every((n) => n.dur === ls[0].dur) ? ls[0].dur : null;
    const onlyRests = rs.length && !ns.length;
    const lname = (l) => (onlyRests ? `${l.replace(' note', '')} rest` : l);
    const baseLen = len == null ? null : DOTTED.has(len) ? len / 1.5 : len;
    const pages = view.pages > 1;
    const off = (c) => (c ? '' : 'disabled');
    npBody.innerHTML = `<div class="np-row"><b class="np-title">${opts.title || 'Edit notes'}</b>
      ${view.voice ? '' : handsHtml(view.staves || [], view.muted || [], { id: 'np-hands', chords: { has: !!view.hasChords, on: !!view.chordPlay } })}
      <span class="np-count" id="np-count">${arcSel ? `${arcSel.kind === 'tie' ? 'Tie' : 'Slur'} picked · ⌫ or ✕ takes it away` : p.length ? `${plural(ns.length, 'note')}${rs.length ? ` · ${plural(rs.length, 'rest')}` : ''} ${rng ? 'in the range' : 'picked'}` : barPick ? `Bar ${barPick.bar + 1} picked (${staffName(barPick.staff, nst)})` : 'Pick notes on the score'}</span>
      ${midiCtl ? '<span class="np-midi-slot"></span>' : ''}<span class="grow"></span>
      <button data-a="playhere" class="np-play ${view.player?.playing ? 'on' : ''}" title="${view.player?.playing ? 'Pause (space)' : 'Play from the bar before the picked notes, as edited (space)'}" aria-label="${view.player?.playing ? 'Pause' : 'Play from here'}">${view.player?.playing ? '❚❚ Pause' : '▶ From here'}</button>
      ${pages ? `<span class="np-pages"><button class="icon-btn" data-a="prev" title="Page before (Shift ←)" aria-label="Page before" ${off(view.page > 1)}>${iconOn('left')}</button><span class="np-pageno" id="np-pageno">${view.page}/${view.pages}</span><button class="icon-btn" data-a="next" title="Next page (Shift →)" aria-label="Next page" ${off(view.page < view.pages)}>${iconOn('right')}</button></span>` : ''}
      <button class="icon-btn" data-a="undo" ${off(at > 0)} title="Undo (⌘Z)" aria-label="Undo">${iconOn('undo')}</button>
      <button class="icon-btn" data-a="redo" ${off(at < steps.length - 1)} title="Redo (⇧⌘Z)" aria-label="Redo"><span class="flip">${iconOn('undo')}</span></button>
      <button class="icon-btn" data-a="close" title="Close (Esc)" aria-label="Close">${iconOn('close')}</button></div>
      <div class="np-acts np-tools">
        ${isTouch() ? `<button data-a="several" class="${several ? 'on' : ''}" aria-pressed="${several}" title="Pick several: each tap adds a note">Several</button>` : ''}
        <button data-a="barmenu" class="np-barmenu" aria-haspopup="menu" title="Bar and staff tools: clear or add a hand, insert or delete a bar, add or remove a staff">${tgt ? `Bar ${tgt.bar + 1}` : 'Bar'} ▾</button>
        <span class="stepper np-pitch" aria-label="Pitch"><button data-a="oct-" ${off(ns.length)} title="Octave down (⌘↓)" aria-label="Octave down">8↓</button><button data-a="semi-" ${off(ns.length)} title="Semitone down (↓)" aria-label="Semitone down">♭</button><button data-a="semi+" ${off(ns.length)} title="Semitone up (↑)" aria-label="Semitone up">♯</button><button data-a="oct+" ${off(ns.length)} title="Octave up (⌘↑)" aria-label="Octave up">8↑</button><button data-a="respell" class="np-respell" ${off(ns.length)} title="Spell another way (J): C♯ ⇄ D♭ — hold (right-click) for ♯ ♭ ♮ and a courtesy accidental" aria-label="Respell" aria-haspopup="menu">♯/♭</button></span>
        <span class="stepper np-len" aria-label="Length">${LENS.map(([q, l, k]) => `<button data-len="${q}" class="${baseLen === q ? 'on' : ''}" ${off(p.length)} title="${lname(l)} (${k})" aria-label="${lname(l)}">${noteIcon(q, { rest: !!onlyRests })}</button>`).join('')}<button data-a="dot" class="${len != null && DOTTED.has(len) ? 'on' : ''}" ${off(len != null)} title="Dotted (.)" aria-label="Dotted">${DOT_IC}</button></span>
        <button data-a="fill" class="np-fill np-icon" ${off(ns.some((n) => n.fill))} title="Fill next rest (L): the note takes in the rest right after it — press again for the next one" aria-label="Fill next rest">→|</button>
        ${onlyRests ? '' : `<button data-a="tie" class="np-arc ${ns.length && ns.every((n) => n.tie) ? 'on' : ''}" ${off(ns.length)} title="Tie (T): to the next note of the same pitch (tied: takes it away)" aria-label="Tie">${TIE_IC}</button>
        <button data-a="slur" class="np-arc ${ns.length && ns.every((n) => n.slur) ? 'on' : ''}" ${off(ns.length)} title="Slur (S): over the picked notes; one note: to the next one (slurred: takes it away)" aria-label="Slur">${SLUR_IC}</button>`}
        <button data-a="add" ${off(p.length)} title="${onlyRests ? 'Turn the rest into a note (N), then move it with ↑ ↓' : 'Add a note (N): a third above, or on a rest'}" aria-label="${onlyRests ? 'Note here' : 'Add a note'}">${onlyRests ? '+ Note here' : '+♪'}</button>
        <button data-a="del" class="np-icon" ${off(p.length)} title="${onlyRests ? 'Remove rest (⌫): what follows comes earlier' : 'Delete (⌫): a rest takes its place'}" aria-label="${onlyRests ? 'Remove rest' : 'Delete'}">${iconOn('bin')}</button>
      </div>
      <div class="np-acts">
        <button data-a="none" ${off(p.length)}>Clear</button>
        <span class="stepper np-clip" aria-label="Copy and paste">
        <button data-a="copy" class="np-icon" ${off(p.length || barPick)} title="Copy (⌘C)" aria-label="Copy">${COPY_IC}</button><button data-a="cut" class="np-icon" ${off(p.length || barPick)} title="Cut (⌘X): rests are left" aria-label="Cut">${CUT_IC}</button><button data-a="paste" class="np-icon" ${off(clip && (p.length || barPick))} title="${clip ? `Paste (⌘V) ${clipWords(clip)} here, over what follows` : 'Paste (⌘V): copy something first'}" aria-label="Paste">${PASTE_IC}</button><button data-a="repeat" class="np-icon np-repeat" ${off(p.length || barPick)} title="Repeat (R): the selection again right after itself" aria-label="Repeat">⟳</button>
        </span>
        ${evenGroup()?.some((n, i, g) => Math.abs(n.dur - g[0].dur) > 1e-6) ? `<button data-a="even" class="np-icon np-even" title="Even out (Q): the picked notes get one length each, the same total — a dotted note and its short partner become two equal notes" aria-label="Even out">${EVEN_IC}</button>` : ''}
        <span class="grow"></span>
        ${nst > 1 ? `<button data-a="up" class="np-move" ${off(up)} title="Move to the staff above (Shift ↑)">↑ ${nst === 2 ? 'To right hand' : toUp ? `To ${staffName(toUp, nst)}` : 'Staff up'}${up ? ` (${up})` : ''}</button>
        <button data-a="down" class="np-move" ${off(down)} title="Move to the staff below (Shift ↓)">↓ ${nst === 2 ? 'To left hand' : toDown ? `To ${staffName(toDown, nst)}` : 'Staff down'}${down ? ` (${down})` : ''}</button>` : ''}
        <button class="primary" data-a="save" ${off(at > 0)}>Save…</button>
      </div>`;
    lyr?.drawn(); // [lyrics] the Notes | Lyrics switch, the picked note
    midiCtl?.paint(panel.querySelector('.np-midi-slot'));
    host.style.setProperty('--np-h', panel.offsetHeight + 'px');
  };

  // ---- picking ----
  const setSel = (refs, add = false) => { dropped = false; rng = null; rangeArm = false; sel = add ? new Set([...sel, ...refs]) : new Set(refs); paint(); };
  // a range from the anchor note to this one (every staff between them)
  const rangeTo = (ref) => {
    const a = byRef().get(anchor), z = byRef().get(ref);
    if (!a || !z) return setSel([ref]);
    rangeEnd = absOf(z) >= absOf(a) ? 1 : -1;
    setRange(spanOf([a, z]));
  };
  const tapNote = (ref, e) => {
    if ((e.shiftKey || rangeArm) && anchor != null) return rangeTo(ref);
    if (e.metaKey || e.ctrlKey || several) { sel.has(ref) ? sel.delete(ref) : sel.add(ref); anchor = ref; return paint(); }
    anchor = ref;
    setSel(sel.size === 1 && sel.has(ref) ? [] : [ref]);
  };
  const wholeBar = () => {
    const bars = new Set(picked().map((n) => `${n.bar}|${n.staff}`));
    setSel(cur().notes.filter((n) => !n.rest && bars.has(`${n.bar}|${n.staff}`)).map((n) => n.ref), true);
  };

  // pointer on the score: tap a note, or drag a box (the score's own tap-to-seek / swipes wait while editing)
  let press = null, box = null;
  // the orange play line (and its grip) is the score's own: its drag wins over picking
  const inPaper = (e) => !!e.target.closest?.('#paper') && !e.target.closest('.notes-panel') && !e.target.closest('.ib-badge') && !e.target.closest('.playbar');
  const onDown = (e) => {
    if (!inPaper(e) || e.button > 0) return;
    if (e.target.closest('.playbar')) return; // the orange line: score.js drags it (no pick, no box, no swipe)
    e.stopPropagation();
    const dot = e.target.closest('.score-dots i');
    if (dot) { e.preventDefault(); press = null; view.goTo([...dot.parentElement.children].indexOf(dot) + 1); return draw(); }
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, ref: e.target.closest('g[data-ref]')?.dataset.ref, near: nearRef(e.clientX, e.clientY), arc: e.target.closest('.np-arc-hit') };
    // Mac: a press on a notehead can drag the note (up / down: pitch, sideways: another beat)
    if (e.pointerType === 'mouse' && press.ref != null && !e.shiftKey && !e.metaKey && !e.ctrlKey && !byRef().get(+press.ref)?.rest) press.canDrag = true;
    // touch: a long press on a note starts a range — then tap another note, or drag to it
    if (e.pointerType !== 'mouse' && (press.ref ?? press.near) != null) {
      const p = press;
      p.timer = setTimeout(() => {
        if (press !== p || box) return;
        p.long = true;
        anchor = +(p.ref ?? p.near); barPick = null;
        const n = byRef().get(anchor);
        rangeEnd = 1;
        if (n) setRange(spanOf([n]));
        rangeArm = true;
        navigator.vibrate?.(10);
        toast('Range: tap or drag to the last note');
      }, LONG_MS);
    }
  };
  const nearRef = (cx, cy) => {
    let best = 24, ref = null;
    for (const g of paper.querySelectorAll('g[data-ref]')) {
      const b = g.getBoundingClientRect(), d = Math.hypot(cx - (b.left + b.right) / 2, cy - (b.top + b.bottom) / 2);
      if (d < best) { best = d; ref = g.dataset.ref; }
    }
    return ref;
  };
  // ---- drag a note (Mac): up / down a staff line or space at a time (in the key; ⌥: a semitone), sideways to
  // another beat of this bar or another one; a ghost note + its name show where it goes; Esc cancels ----
  let drag = null;
  const clientOf = (svg, x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
  const boxOf = (bar, staff) => { for (const b of barBoxes()) if (b.bar === bar && b.staff === staff) return b; return null; };
  // bar bi on screen: [{ on, x }] (x in px) from its drawn notes and rests, then its end
  const timeMap = (bi) => {
    const xs = new Map();
    for (const n of cur().notes) {
      if (n.bar !== bi) continue;
      const g = paper.querySelector(`g[data-ref="${n.ref}"]`);
      if (!g) continue;
      const r = g.getBoundingClientRect(), k = r3(n.on);
      (xs.get(k) || xs.set(k, []).get(k)).push(r.left + r.width / 2);
    }
    const pts = [...xs].map(([on, v]) => ({ on, x: Math.min(...v) })).sort((a, b) => a.on - b.on);
    const len = Math.max(0, ...cur().notes.filter((n) => n.bar === bi).map((n) => n.on + n.dur)) || 4;
    const bx = boxOf(bi, 1);
    if (bx) pts.push({ on: len, x: clientOf(bx.svg, (bx.x + bx.w) * 10, 0).x });
    return { pts, len };
  };
  const xToOn = (pts, x) => {
    if (!pts.length) return 0;
    if (x <= pts[0].x) return pts[0].on;
    for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) { const a = pts[i - 1], b = pts[i]; return a.on + ((b.on - a.on) * (x - a.x)) / Math.max(1, b.x - a.x); }
    return pts.at(-1).on;
  };
  const onToX = (pts, on) => {
    if (!pts.length) return null;
    for (let i = 1; i < pts.length; i++) if (on <= pts[i].on + 1e-6) { const a = pts[i - 1], b = pts[i]; return a.x + ((b.x - a.x) * (on - a.on)) / Math.max(1e-6, b.on - a.on); }
    return pts[0].x;
  };
  const NAME_S = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'], NAME_F = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const LET_S = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6], LET_F = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
  const pc = (m) => ((m % 12) + 12) % 12;
  const nameOf = (m, flats) => `${(flats ? NAME_F : NAME_S)[pc(m)]}${Math.floor(m / 12) - 1}`;
  const diaOf = (m, flats) => (Math.floor(m / 12) - 1) * 7 + (flats ? LET_F : LET_S)[pc(m)]; // its line / space
  // k staff steps from midi m: each one the next note of the key (C major: C D E F …); ⌥: k semitones
  const stepPitch = (m, k, fifths, chromatic) => {
    if (chromatic) return m + k;
    const tonic = pc(7 * fifths), inKey = (x) => [0, 2, 4, 5, 7, 9, 11].includes(pc(x - tonic));
    let x = m;
    for (let i = 0; i < Math.abs(k); i++) do x += Math.sign(k); while (!inKey(x));
    return x;
  };
  const startDrag = (p) => {
    const ref = +p.ref, n = byRef().get(ref), g = paper.querySelector(`g[data-ref="${ref}"]`), svg = g?.ownerSVGElement;
    if (!n || !g || !svg || busy) { p.canDrag = false; return false; }
    if (!sel.has(ref)) { anchor = ref; setSel([ref]); }
    const r = g.getBoundingClientRect(), fifths = barState(n.bar).fifths;
    const ghost = g.cloneNode(true);
    ghost.removeAttribute('data-ref'); ghost.removeAttribute('id');
    ghost.setAttribute('class', 'np-ghost');
    svg.append(ghost);
    const label = document.createElement('div');
    label.className = 'np-draglabel';
    document.body.append(label);
    drag = { ref, n, g, svg, ghost, label, x0: p.x, y0: p.y, cx: r.left + r.width / 2, cy: r.top + r.height / 2, fifths, flats: fifths < 0, by: 0, bar: n.bar, on: n.on, maps: new Map() };
    host.classList.add('np-dragging');
    try { host.setPointerCapture(p.id); } catch {}
    return true;
  };
  const dragTo = (e) => {
    const d = drag, n = d.n, m = d.svg.getScreenCTM();
    if (!m) return;
    // pitch: half a staff space (5 units) a step
    const steps = Math.round(-(e.clientY - d.y0) / (5 * m.d));
    const midi = Math.max(21, Math.min(108, stepPitch(n.midi, steps, d.fifths, e.altKey)));
    d.by = midi - n.midi;
    // time: the bar under the pointer (on this note's row first), a grid of the note's length (at most a beat)
    const b = barAt(e.clientX, d.cy) || barAt(e.clientX, e.clientY);
    let bar = b ? b.bar : d.bar, tm = d.maps.get(bar);
    if (!tm) { tm = timeMap(bar); d.maps.set(bar, tm); }
    const grid = n.dur < 1 ? n.dur : n.dur % 1 ? 0.5 : 1;
    let on = Math.round(xToOn(tm.pts, e.clientX - (d.x0 - d.cx)) / grid) * grid;
    on = r3(Math.max(0, Math.min(tm.len - n.dur, on)));
    if (on < 0 || n.dur > tm.len + 1e-6) { bar = n.bar; on = n.on; }
    d.bar = bar; d.on = on;
    // the ghost: on the target line / space, at the target beat (same page: drawn there; else it stays here)
    const moved = bar !== n.bar || Math.abs(on - n.on) > 1e-6;
    const tx = moved ? onToX(tm.pts, on) : d.cx;
    const b0 = boxOf(n.bar, n.staff), b1 = boxOf(bar, n.staff);
    const row = b0 && b1 && b1.svg === b0.svg ? (b1.y - b0.y) * 10 : 0;
    const dx = tx == null || (b1 && b1.svg !== d.svg) ? 0 : (tx - d.cx) / m.a;
    const dy = -(diaOf(midi, d.flats || d.by < 0) - diaOf(n.midi, d.flats || d.by < 0)) * 5 + row;
    d.ghost.setAttribute('transform', `translate(${dx} ${dy})`);
    d.ghost.style.display = d.by || moved ? '' : 'none';
    const beat = on + 1;
    d.label.textContent = `${nameOf(midi, d.flats || d.by < 0)}${moved ? ` · bar ${bar + 1}, beat ${Number.isInteger(beat) ? beat : beat.toFixed(2).replace(/0$/, '')}` : ''}`;
    Object.assign(d.label.style, { left: `${e.clientX + 14}px`, top: `${e.clientY - 30}px` });
  };
  const endDrag = () => {
    if (!drag) return;
    drag.ghost.remove(); drag.label.remove();
    host.classList.remove('np-dragging');
    drag = null;
  };
  const dropDrag = () => {
    const d = drag;
    endDrag();
    const n = d.n, moved = d.bar !== n.bar || Math.abs(d.on - n.on) > 1e-6;
    if (moved) {
      // the chord's picked notes go together (the note pressed, at least)
      const refs = picked().filter((x) => !x.rest && x.bar === n.bar && x.staff === n.staff && x.voice === n.voice && Math.abs(x.on - n.on) < 1e-6).map((x) => x.ref);
      run({ op: 'shift', refs: refs.length ? refs : [n.ref], bar: d.bar, on: d.on, by: d.by }, null, { bar: Math.min(d.bar, n.bar) });
    } else if (d.by) {
      const refs = noteRefs();
      run({ op: 'pitch', refs: refs.includes(n.ref) ? refs : [n.ref], by: d.by });
    }
  };
  const onMove = (e) => {
    if (!press || e.pointerId !== press.id) return;
    e.stopPropagation();
    if (press.long) { // dragging after a long press: the range runs to the note under the finger
      e.preventDefault();
      const ref = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('g[data-ref]')?.dataset.ref ?? nearRef(e.clientX, e.clientY);
      if (ref != null && +ref !== press.last) { press.last = +ref; rangeTo(+ref); rangeArm = true; press.dragged = true; }
      return;
    }
    if (drag) { e.preventDefault(); return dragTo(e); }
    if (press.canDrag && !box && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= 4) { e.preventDefault(); if (startDrag(press)) return dragTo(e); }
    if (!box && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
    clearTimeout(press.timer);
    e.preventDefault();
    if (!box) { box = document.createElement('div'); box.className = 'np-box'; document.body.append(box); }
    const l = Math.min(press.x, e.clientX), t = Math.min(press.y, e.clientY);
    Object.assign(box.style, { left: l + 'px', top: t + 'px', width: Math.abs(e.clientX - press.x) + 'px', height: Math.abs(e.clientY - press.y) + 'px' });
  };
  const onUp = (e) => {
    if (!press || e.pointerId !== press.id) return;
    e.stopPropagation();
    const p = press; press = null;
    clearTimeout(p.timer);
    if (drag) { if (e.type === 'pointerup') dropDrag(); else endDrag(); return; }
    if (p.long) { if (p.dragged) rangeArm = false; return; } // a long press (and drag) made the range; a tap ends it
    if (box) {
      const r = box.getBoundingClientRect();
      box.remove(); box = null;
      if (e.type !== 'pointerup') return;
      const hit = [...paper.querySelectorAll('g[data-ref]:not(.nh-rest)')].filter((g) => { const b = g.getBoundingClientRect(); return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom; }).map((g) => +g.dataset.ref);
      if (hit.length) anchor = hit[hit.length - 1];
      return setSel(hit, e.shiftKey || e.metaKey || e.ctrlKey || several);
    }
    if (e.type !== 'pointerup') return;
    if (p.arc && p.ref == null) return pickArc(p.arc); // a tie / slur: picked, ⌫ or its ✕ takes it away
    arcSel = null;
    // not right on a notehead: the nearest one within a finger's width
    // right on a notehead: that note; above the top staff: its chord name; else the nearest note within a finger
    const ch = p.ref == null && !e.shiftKey && !e.metaKey && !e.ctrlKey && chordAt(e.clientX, e.clientY);
    if (ch) return chordSheet(ch.bar, ch.on);
    const ref = p.ref ?? nearRef(e.clientX, e.clientY);
    if (ref != null) { barPick = null; tapNote(+ref, e); return; }
    const b = barAt(e.clientX, e.clientY);
    barPick = b && !(barPick && barPick.bar === b.bar && barPick.staff === b.staff) ? b : null;
    if (barPick || !several) setSel([]); else paint();
  };
  const stop = (e) => { if (inPaper(e)) e.stopPropagation(); };
  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);
  host.addEventListener('pointercancel', onUp, true);
  for (const t of ['touchstart', 'touchmove', 'touchend', 'click']) host.addEventListener(t, stop, true);
  const noMenu = (e) => { if (inPaper(e)) e.preventDefault(); }; // a long press is a range, not the page's menu
  host.addEventListener('contextmenu', noMenu, true);

  // ---- editing, undo / redo ----
  const show = async (xml) => { shown = true; await view.showXml(xml); };
  // the play start: one bar before bar bi (0-based), the page stays; the toast says where when it moves
  const cue = (bi, say = true) => {
    if (bi == null || closed) return;
    const n = view.cueBar(bi);
    if (say && n !== cueAt) toast(`Ready to play from bar ${n}`);
    cueAt = n; dropped = false;
    draw();
  };
  const firstBar = (refs, notes = cur().notes) => {
    const m = new Map(notes.map((n) => [n.ref, n.bar]));
    const bs = (refs || []).map((r) => m.get(+r)).filter((b) => b != null);
    return bs.length ? Math.min(...bs) : null;
  };
  const keepInView = () => { const r = [...sel][0]; if (r != null) view.showEl(paper.querySelector(`g[data-ref="${r}"]`)); };
  // replace: this op takes the place of the last edit (still one undo step), e.g. "Pull the next notes earlier";
  // after(j): an offer shown when nothing else needs saying ({ text, label, run })
  const KEEP_RANGE = new Set(['pitch', 'respell', 'accidental', 'courtesy', 'clear', 'len', 'tie', 'slur', 'unslur', 'delete', 'move']);
  // keys / buttons pressed while an edit is on its way wait in `queue` (each reads the picked notes when its turn
  // comes) instead of being lost; while more are waiting an edit's result is not drawn (`stale`): only the last is
  const queue = [];
  let stale = false;
  const act = (f) => { if (busy || queue.length) { if (queue.length < 12) queue.push(f); return; } f(); };
  const drain = async () => {
    while (!busy && queue.length && !closed) { try { await queue.shift()(); } catch (e) { toast(e.message); } }
    if (busy || queue.length || !stale || closed) return;
    stale = false; busy = true;
    try { await show(cur().xml); cue(cur().bar, false); keepInView(); } finally { busy = false; }
    if (queue.length) drain();
  };
  // the picked notes dim at once: the edit is seen to start before the score is drawn again
  const waitMark = () => paper.querySelectorAll('g[data-ref].nh-on').forEach((g) => g.classList.add('nh-wait'));
  // then(): right after the edit is in (before a waiting key runs), e.g. A–G picks the next note
  const run = async (op, onErr, { replace = false, after, bar: atBar, range: newRange, then } = {}) => {
    if (busy || (replace && at === 0)) return;
    busy = true;
    arcSel = null;
    waitMark();
    try {
      const from = replace ? at - 1 : at;
      const ops = [...steps[from].ops, op];
      const bar = atBar ?? (op.bar != null ? op.bar : firstBar(op.refs, steps[from].notes));
      const j = await post(`${url}/preview`, { ops, sha: base.sha });
      const prevSel = replace ? steps[at].sel : [...sel], prevPick = replace ? steps[at].barPick : barPick, prevRng = replace ? steps[at].rng : rng;
      steps = steps.slice(0, from + 1);
      steps.push({ ops, xml: j.xml, notes: j.notes, sel: prevSel, bar: bar ?? firstBar(j.moved, j.notes), barPick: prevPick, rng: prevRng });
      at = from + 1;
      guard.changed();
      if (op.op !== 'lyrics') { // [lyrics] words: the picked note stays
        sel = new Set(op.op === 'addstaff' ? [] : j.moved);
        // a range stays a range through the tools; a paste / repeat picks what it wrote
        rng = newRange || (rng && KEEP_RANGE.has(op.op) ? rng : null);
        if (rng) sel = new Set(inRange(rng));
        const bars = new Set(j.notes.map((n) => n.bar)).size;
        barPick = op.op === 'delbar' && bars ? { bar: Math.min(op.bar, bars - 1), staff: 1 } : sel.size ? null : barPick && barPick.staff <= nStaves() ? barPick : null;
      }
      took = new Set(j.tookRefs || []);
      draw();
      if (queue.length) stale = true; // more edits waiting: draw only the last
      else { stale = false; await show(j.xml); }
      const said = [];
      if (j.took?.length) said.push(tookWords(j.took));
      if (j.said?.length) said.push(...j.said);
      const why = op.op === 'delbar' ? 'it went into the deleted bar' : op.op === 'insbar' ? 'the new bar is between its notes' : null;
      if (j.tiesGone) said.push(why ? (j.tiesGone === 1 ? `A tie was taken away: ${why}` : `${j.tiesGone} ties were taken away: ${why}`)
        : j.tiesGone === 1 ? 'A tie was taken away: its two notes no longer meet on one pitch' : `${j.tiesGone} ties were taken away: their notes no longer meet on one pitch`);
      const offer = !said.length && after?.(j);
      cue(cur().bar, !said.length && !offer);
      if (said.length) toast(said.join(' · '));
      else if (offer) toast(offer.text, offer);
      keepInView();
      then?.();
    } catch (e) {
      paper.querySelectorAll('.nh-wait').forEach((g) => g.classList.remove('nh-wait'));
      queue.length = 0; // the keys pressed after a refused edit were meant for its result: dropped
      if (!onErr?.(e)) toast(e.message);
    } finally { busy = false; drain(); }
  };
  const LEN_NAME = { 4: 'whole', 3: 'dotted half', 2: 'half', 1.5: 'dotted quarter', 1: 'quarter', 0.75: 'dotted 8th', 0.5: '8th', 0.375: 'dotted 16th', 0.25: '16th', 0.1875: 'dotted 32nd', 0.125: '32nd' };
  const lenName = (q) => LEN_NAME[q] || `${q}-beat`;
  // "The rest took time from D5 on beat 2 (gone), F5 on beat 4 (now a 8th) · 1 lyric syllable went with it — Undo brings them back"
  const tookWords = (t) => {
    const ly = t.reduce((a, x) => a + (x.lyrics || 0), 0);
    return `The rest took time from ${t.map((x) => `${x.what} on beat ${x.beat}${x.now ? ` (now ${/^[aeiou8]/.test(lenName(x.now)) ? 'an' : 'a'} ${lenName(x.now)})` : ' (gone)'}`).join(', ')}`
      + (ly ? ` · ${plural(ly, 'lyric syllable')} went with ${t.length === 1 ? 'it' : 'them'}` : '') + ' — Undo brings them back';
  };
  const noteRefs = () => picked().filter((n) => !n.rest).map((n) => n.ref);
  const need = (refs, f) => (refs.length ? f(refs) : toast('Pick a note first'));
  // ↑ / ↓: the picked notes to the staff above the highest one picked (below the lowest); on the top (bottom) staff
  // already: the others join them there
  function moveDest(d) {
    const n = nStaves(), st = picked().filter((x) => !x.rest).map((x) => x.staff);
    if (n < 2 || !st.length) return null;
    const to = d < 0 ? Math.min(...st) - 1 : Math.max(...st) + 1;
    return to < 1 ? 1 : to > n ? n : to;
  }
  const moveTo = (d) => {
    if (nStaves() < 2) return;
    const to = moveDest(d);
    if (!to) return toast('Pick a note first');
    const refs = picked().filter((n) => !n.rest && n.staff !== to).map((n) => n.ref);
    if (!refs.length) return toast(`Those notes are in the ${staffName(to, nStaves())} already`);
    run({ op: 'move', refs, to });
  };
  // ---- Bar ▾: the bar picked (its empty space tapped), else the bar and staff of the first note picked ----
  function target() {
    if (barPick) return barPick;
    const n = picked()[0];
    return n ? { bar: n.bar, staff: n.staff } : null;
  }
  const inBar = (b, s) => cur().notes.filter((n) => n.bar === b && (s == null || n.staff === s));
  const addStaff = () => {
    const n = nStaves(), pos = Array.from({ length: n + 1 }, (_, k) => k + 1);
    const where = (k) => (k === 1 ? `On top${n > 1 ? `, above the ${staffName(1, n)}` : ''}` : k === n + 1 ? `At the bottom, below the ${staffName(n, n)}` : `Between the ${staffName(k - 1, n)} and the ${staffName(k, n)}`);
    const s = modal(`<h2>Add a staff</h2><p class="muted">Every bar gets a whole rest on it; pick a rest and use + Note to write on it. Undo takes it away.</p>
      <div class="np-addstaff"><label>Clef <select id="np-clef"><option value="treble">Treble 𝄞</option><option value="bass">Bass 𝄢</option></select></label>
      <label>Place <select id="np-at">${pos.map((k) => `<option value="${k}" ${k === (n === 1 ? 2 : 1) ? 'selected' : ''}>${where(k)}</option>`).join('')}</select></label></div>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Add staff</button></div>`);
    const clef = s.el.querySelector('#np-clef'), at = s.el.querySelector('#np-at');
    clef.value = n === 1 ? 'bass' : 'treble';
    at.onchange = () => { clef.value = +at.value === 1 && n > 1 ? 'treble' : +at.value > n ? 'bass' : clef.value; };
    s.el.querySelector('[data-ok]').onclick = () => { s.close(); run({ op: 'addstaff', at: +at.value, clef: clef.value }); };
  };
  // ---- bar structure (structops.py): pickup, key / time from here, repeats, endings ----
  const KEYS = [['C♭', 'a♭'], ['G♭', 'e♭'], ['D♭', 'b♭'], ['A♭', 'f'], ['E♭', 'c'], ['B♭', 'g'], ['F', 'd'], ['C', 'a'], ['G', 'e'], ['D', 'b'], ['A', 'f♯'], ['E', 'c♯'], ['B', 'g♯'], ['F♯', 'd♯'], ['C♯', 'a♯']];
  // what is in force at bar b (0-based) of the edited part: key, time, repeat signs, the ending over it
  const barState = (b) => {
    const doc = new DOMParser().parseFromString(cur().xml, 'application/xml');
    const part = doc.querySelectorAll('part')[base.part] || doc.querySelector('part');
    const ms = [...part.querySelectorAll(':scope > measure')];
    let fifths = 0, time = [4, 4];
    const clefs = {}; // staff → 'G' | 'F' | … at the start of bar b
    ms.slice(0, b + 1).forEach((m, i) => {
      const k = m.querySelector('attributes key fifths'); if (k) fifths = +k.textContent;
      const t = m.querySelector('attributes time'); if (t) time = [+t.querySelector('beats').textContent, +t.querySelector('beat-type').textContent];
      let notes = false;
      for (const el of m.children) {
        if (el.tagName === 'note') notes = true;
        if (el.tagName !== 'attributes' || (i === b && notes)) continue;
        el.querySelectorAll('clef').forEach((c) => (clefs[+(c.getAttribute('number') || 1)] = c.querySelector('sign')?.textContent));
      }
    });
    const ott = ottavaLines(part);
    return { fifths, time, clefs, mark: barMarks(part)[b] || {}, pickup: ms[0]?.getAttribute('implicit') === 'yes', bars: ms.length, ott: (st, q = 0) => ottavaAt(ott, st, b, q), ottLines: ott };
  };
  const pickupSheet = () => {
    const st = barState(0), n = st.time[0];
    const s = modal(`<h2>Pickup</h2><p class="muted">The first bar becomes a short bar (an upbeat) of this many beats: its last beats stay. Full bar puts it back.</p>
      <div class="np-choices">${Array.from({ length: n }, (_, k) => k).map((k) => `<button data-b="${k}">${k ? plural(k, 'beat') : 'Full bar'}</button>`).join('')}</div>
      <div class="modal-actions"><button data-close>Cancel</button></div>`);
    s.el.querySelectorAll('[data-b]').forEach((x) => (x.onclick = () => { s.close(); run({ op: 'pickup', beats: +x.dataset.b }, null, { bar: 0 }); }));
  };
  const keySheet = (b) => {
    const st = barState(b);
    // the circle of fifths: C on top, sharps clockwise, flats anticlockwise; 6–7 sharps / flats on an inner ring
    const pos = (f) => { const a = ((f + 12) % 12) * (Math.PI / 6) - Math.PI / 2, r = Math.abs(f) >= 6 && f !== 6 ? 21 : 42; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; };
    const s = modal(`<h2>Key from bar ${b + 1}</h2><p class="muted">The notes keep their pitch; accidentals are written for the new key.</p>
      <div class="np-fifths" role="group" aria-label="Circle of fifths">${KEYS.map(([maj, min], k) => { const f = k - 7, [x, y] = pos(f); return `<button data-f="${f}" class="${f === st.fifths ? 'on' : ''}" style="left:${x}%;top:${y}%" title="${maj} major / ${min} minor · ${f ? `${Math.abs(f)} ${f > 0 ? 'sharp' : 'flat'}${Math.abs(f) > 1 ? 's' : ''}` : 'no sharps or flats'}" aria-label="${maj} major">${maj}<small>${min}</small></button>`; }).join('')}</div>
      <div class="modal-actions"><button data-close>Cancel</button></div>`);
    s.el.querySelectorAll('[data-f]').forEach((x) => (x.onclick = () => { s.close(); run({ op: 'keysig', bar: b, fifths: +x.dataset.f }, null, { bar: b }); }));
  };
  const timeSheet = (b) => {
    const st = barState(b), now = st.time.join('/');
    const common = ['2/4', '3/4', '4/4', '2/2', '3/8', '6/8', '9/8', '12/8', '5/4'];
    const s = modal(`<h2>Time from bar ${b + 1}</h2><p class="muted">Now ${now}. The music from here to the next time change is barred again (notes over a new bar line are tied).</p>
      <div class="np-choices">${common.map((t) => `<button data-t="${t}" class="${t === now ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="np-addstaff"><label>Other <input id="np-tb" type="number" min="1" max="32" value="${st.time[0]}" inputmode="numeric"> / <select id="np-tt">${[2, 4, 8, 16, 32].map((x) => `<option ${x === st.time[1] ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Use</button></div>`);
    const use = (t) => { const [n, d] = t.split('/').map(Number); s.close(); run({ op: 'timesig', bar: b, beats: n, beatType: d }, null, { bar: b }); };
    s.el.querySelectorAll('[data-t]').forEach((x) => (x.onclick = () => use(x.dataset.t)));
    s.el.querySelector('[data-ok]').onclick = () => use(`${s.el.querySelector('#np-tb').value}/${s.el.querySelector('#np-tt').value}`);
  };
  // the bars the structure tools take: the range's, else the picked notes' bars, else the bar picked
  const barsPicked = (t) => {
    if (rng) { const s = starts(); return [placeOf(rng.a, s)[0], placeOf(Math.max(rng.a, rng.b - 1e-3), s)[0]]; }
    if (sel.size > 1) { const bs = picked().map((n) => n.bar); return [Math.min(...bs), Math.max(...bs)]; }
    return t ? [t.bar, t.bar] : null;
  };
  const structEntries = (t) => {
    const bs = barsPicked(t);
    if (!t || !bs) return [];
    const b = t.bar, st = barState(b), [b0, b1] = bs, first = barState(b0);
    const span = b0 === b1 ? `bar ${b0 + 1}` : `bars ${b0 + 1}–${b1 + 1}`;
    const endingOn = (k) => { const e = first.mark.ending; return !!e && e.a === b0 && e.z === b1 && e.nums.includes(k); };
    const out = [];
    if (b === 0) out.push({ label: st.pickup ? 'Pickup: change or remove…' : 'Pickup: n beats…', run: pickupSheet });
    const sc = t.staff || 1, cl = first.clefs[sc] || (sc === 1 ? 'G' : 'F'), who = nStaves() > 1 ? `${staffName(sc, nStaves())}, ` : '';
    // a clef over the picked bars of this staff; the bar after them keeps its clef (structops 'clef' until)
    const clefOp = (clef) => run({ op: 'clef', bar: b0, until: b1, staff: sc, clef }, null, { bar: b0 });
    out.push({ label: `Key from bar ${b + 1}…`, run: () => keySheet(b) }, { label: `Time from bar ${b + 1}…`, run: () => timeSheet(b) },
      { label: `Clef: Treble (${who}${span})`, checked: cl === 'G', run: () => clefOp('treble') },
      { label: `Clef: Bass (${who}${span})`, checked: cl === 'F', run: () => clefOp('bass') }, '-',
      { label: `Start repeat at bar ${b0 + 1}`, checked: !!first.mark.start, run: () => run({ op: 'repeat', bar: b0, kind: 'start' }, null, { bar: b0 }) },
      { label: `End repeat after bar ${b1 + 1}`, checked: !!barState(b1).mark.end, run: () => run({ op: 'repeat', bar: b1, kind: 'end' }, null, { bar: b1 }) },
      { label: `Ending 1 over ${span}`, checked: endingOn(1), run: () => run({ op: 'ending', bars: [b0, b1], number: '1' }, null, { bar: b0 }) },
      { label: `Ending 2 over ${span}`, checked: endingOn(2), run: () => run({ op: 'ending', bars: [b0, b1], number: '2' }, null, { bar: b0 }) }, '-');
    // 8va / 8vb lines (octaveops.py) over those bars of the staff: only the drawing moves, the sound stays. Notes
    // picked (2+) or a range inside a bar: the line covers just them (from_beat / to_beat), else whole bars.
    const all = cur().notes.filter((n) => n.staff === sc);
    let fromQ = null, toQ = null;
    if (rng) {
      const s = starts(), [ba, qa] = placeOf(rng.a, s), [bz, qz] = placeOf(rng.b, s);
      if (ba === b0 && qa > 1e-6) fromQ = qa;
      if (bz === b1 && qz > 1e-6 && qz < s[b1 + 1] - s[b1] - 1e-6) toQ = qz;
    } else if (sel.size > 1) {
      const mine = picked().filter((n) => n.staff === sc), ons = (b) => mine.filter((n) => n.bar === b).map((n) => n.on);
      if (ons(b0).length) { const q = Math.min(...ons(b0)); if (all.some((n) => n.bar === b0 && n.on < q - 1e-6)) fromQ = q; }
      if (ons(b1).length) { const q = Math.max(...ons(b1)), later = all.filter((n) => n.bar === b1 && n.on > q + 1e-6); if (later.length) toQ = Math.min(...later.map((n) => n.on)); }
    }
    const beatOf = (b, q) => Math.round((1 + (q * barState(b).time[1]) / 4) * 1e4) / 1e4;
    const fromBeat = fromQ == null ? null : beatOf(b0, fromQ), toBeat = toQ == null ? null : beatOf(b1, toQ);
    const inside = all.filter((n) => (n.bar > b0 || (n.bar === b0 && n.on >= (fromQ ?? 0) - 1e-6)) && (n.bar < b1 || (n.bar === b1 && (toQ == null || n.on < toQ - 1e-6))));
    const on = (v) => (inside.length ? inside.every((n) => ottavaAt(first.ottLines, sc, n.bar, n.on) === v)
      : Array.from({ length: b1 - b0 + 1 }, (_, k) => ottavaAt(first.ottLines, sc, b0 + k, 0)).every((x) => x === v));
    const where = nStaves() > 1 ? ` (${staffName(sc, nStaves())})` : '';
    const beatTxt = `${fromBeat != null ? `, from beat ${fromBeat}` : ''}${toBeat != null ? `, before beat ${toBeat}${b0 !== b1 ? ` of bar ${b1 + 1}` : ''}` : ''}`;
    const beats = { ...(fromBeat != null ? { from_beat: fromBeat } : {}), ...(toBeat != null ? { to_beat: toBeat } : {}) };
    for (const [v, name] of [[8, '8va'], [-8, '8vb']]) {
      out.push({ label: `${name} over ${span}${beatTxt}${where}`, checked: on(v), run: () => run({ op: 'ottava', staff: sc, from_bar: b0, to_bar: b1, ...beats, shift: on(v) ? 0 : v }, null, { bar: b0 }) });
    }
    out.push('-');
    return out;
  };
  // ---- chord names (chordops.py): tap one above the top staff (or an empty beat there), or K on a picked note ----
  const KIND_SUFFIX = { major: '', minor: 'm', dominant: '7', 'dominant-seventh': '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7', diminished: 'dim',
    'diminished-seventh': 'dim7', 'half-diminished': 'm7b5', augmented: 'aug', 'suspended-fourth': 'sus4', 'suspended-second': 'sus2', 'major-sixth': '6',
    'minor-sixth': 'm6', 'dominant-ninth': '9', power: '5' };
  // [{ bar, on, name }] of the chord part (chordops.chord_part: the first part with chord names, else the top part)
  const chordsOf = () => {
    const doc = new DOMParser().parseFromString(cur().xml, 'application/xml');
    const parts = [...doc.querySelectorAll('part')];
    const part = parts.find((p) => p.querySelector(':scope > measure > harmony')) || parts[0];
    const out = [];
    let div = 1;
    [...part.querySelectorAll(':scope > measure')].forEach((m, bar) => {
      let t = 0, last = 0;
      for (const el of m.children) {
        if (el.tagName === 'attributes') div = +(el.querySelector('divisions')?.textContent || div);
        else if (el.tagName === 'backup') t -= +el.querySelector('duration').textContent;
        else if (el.tagName === 'forward') t += +el.querySelector('duration').textContent;
        else if (el.tagName === 'note' && !el.querySelector('grace')) { const d = +(el.querySelector('duration')?.textContent || 0); if (!el.querySelector('chord')) { last = t; t += d; } }
        else if (el.tagName === 'harmony') {
          const k = el.querySelector('kind'), rs = el.querySelector('root-step')?.textContent || '';
          const acc = (a) => ({ 1: '#', '-1': 'b' })[Math.round(+(a?.textContent || 0))] || '';
          const name = k?.textContent === 'none' ? 'N.C.' : rs + acc(el.querySelector('root-alter')) + (k?.getAttribute('text') ?? KIND_SUFFIX[k?.textContent] ?? '').replace(/♭/g, 'b').replace(/♯/g, '#')
            + (el.querySelector('bass-step') ? '/' + el.querySelector('bass-step').textContent + acc(el.querySelector('bass-alter')) : '');
          out.push({ bar, on: r3((t + +(el.querySelector('offset')?.textContent || 0)) / div), name });
        }
      }
    });
    return out;
  };
  // a point above the top staff → { bar, on }: the nearest onset in that bar, else the beat under it
  const chordAt = (cx, cy) => {
    for (const b of barBoxes()) {
      if (b.staff !== 1) continue;
      const m = b.svg.getScreenCTM?.();
      if (!m) continue;
      const p = new DOMPoint(cx, cy).matrixTransform(m.inverse()), x = p.x / 10, y = p.y / 10;
      if (x < b.x || x > b.x + b.w || y < b.y - 5.5 || y > b.y + 1.3) continue;
      const len = Math.max(0, ...cur().notes.filter((n) => n.bar === b.bar).map((n) => n.on + n.dur)) || 4;
      const ons = [];
      for (const n of cur().notes.filter((n) => n.bar === b.bar)) {
        const g = paper.querySelector(`g[data-ref="${n.ref}"]`);
        if (!g || g.ownerSVGElement !== b.svg) continue;
        const bb = g.getBBox();
        ons.push({ x: (bb.x + bb.width / 2) / 10, on: n.on });
      }
      ons.sort((p_, q) => Math.abs(p_.x - x) - Math.abs(q.x - x));
      if (ons.length && Math.abs(ons[0].x - x) < 2.5) return { bar: b.bar, on: ons[0].on };
      const first = ons.length ? Math.min(...ons.map((o) => o.x)) : b.x + 2;
      const f = Math.max(0, Math.min(0.999, (x - first) / Math.max(1, b.x + b.w - first)));
      const unit = len % 1.5 === 0 && len >= 3 && len !== 4 ? 1.5 : 1;
      return { bar: b.bar, on: Math.min(len - unit, Math.max(0, Math.floor((f * len) / unit) * unit)) };
    }
    return null;
  };
  const CHORD_RE = /^([A-G])([#b]?)(maj|ma|M|Δ|min|mi|m|dim|°|o|aug|\+|ø|sus)?(6\/9|69|13|11|9|7|6|5|4|2)?((?:\(?(?:add|sus|maj|M|b|#|\+)?(?:13|11|9|7|6|5|4|2)\)?|sus)*)(?:\/([A-G][#b]?))?$/;
  const chordOk = (t) => { t = t.replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s/g, ''); if (/^N\.?C\.?$/.test(t)) return true; const m = CHORD_RE.exec(t); return !!m && !(m[4] === '5' && !m[3] && !m[5]); };
  const chordSheet = (bar, on) => {
    const all = chordsOf(), have = all.find((c) => c.bar === bar && Math.abs(c.on - on) < 1e-3);
    const used = [...new Set(all.map((c) => c.name))].slice(0, 12);
    const beat = on + 1;
    const s = modal(`<h2>Chord name · bar ${bar + 1}, beat ${Number.isInteger(beat) ? beat : beat.toFixed(2)}</h2>
      <p class="muted">Like C, Am7, F/A, B♭maj7, G7sus4 or N.C. It is drawn above the top staff; “Realize to left hand” in Bar ▾ writes the left hand from them.</p>
      <label class="np-chord"><input id="np-chord" autocomplete="off" autocapitalize="off" spellcheck="false" value="${have ? have.name : ''}" placeholder="C, Am7, F/A …"></label>
      <p class="np-chord-err muted" id="np-chord-err"></p>
      ${used.length ? `<div class="np-choices np-used">${used.map((n) => `<button data-n="${n}">${n}</button>`).join('')}</div>` : ''}
      <div class="modal-actions"><button data-close>Cancel</button>${have ? '<button class="danger" data-del>Take away</button>' : ''}<button class="primary" data-ok>Use</button></div>`);
    const inp = s.el.querySelector('#np-chord'), ok = s.el.querySelector('[data-ok]'), err = s.el.querySelector('#np-chord-err');
    const check = () => { const v = inp.value.trim(), good = !v || chordOk(v); ok.disabled = !v || !good; err.textContent = good ? '' : `“${v}” is not a chord name`; };
    inp.addEventListener('input', check);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); } });
    check();
    const use = (text) => { s.close(); run({ op: 'chord', bar, on, text }, null, { bar }); };
    ok.onclick = () => use(inp.value.trim());
    s.el.querySelector('[data-del]')?.addEventListener('click', () => use(''));
    s.el.querySelectorAll('[data-n]').forEach((x) => (x.onclick = () => use(x.dataset.n)));
  };
  const chordHere = () => {
    const p = picked().sort((a, b) => a.bar - b.bar || a.on - b.on)[0];
    if (p) return chordSheet(p.bar, p.on);
    if (barPick) return chordSheet(barPick.bar, 0);
    toast('Pick a note first, or tap above the top staff');
  };
  // Realize to left hand: the range / the picked bars, else the whole score
  const realizeSheet = () => {
    const s0 = starts(), w = rng ? windowOf() : null, bs = barsPicked(target());
    const where = w ? { start: w.start, end: w.end } : bs && (sel.size > 1 || barPick) ? { start: [bs[0], 0], end: [bs[1] + 1, 0] } : {};
    const to = where.end ? (where.end[1] > 1e-6 ? where.end[0] : where.end[0] - 1) : 0;
    const span = where.start ? (to === where.start[0] ? `bar ${to + 1}` : `bars ${where.start[0] + 1}–${to + 1}`) : `the whole score (${plural(s0.length - 1, 'bar')})`;
    if (!chordsOf().length) return toast('No chord names yet: tap above the top staff to write one');
    const s = modal(`<h2>Realize chords to the left hand</h2><p class="muted">Over ${span}: the lowest staff is written again from the chord names (what it has there now goes — Undo brings it back).</p>
      <div class="np-choices np-patterns"><button data-p="block"><b>Block chord</b><small>the chord held</small></button><button data-p="root5"><b>Root – fifth</b><small>one a beat</small></button><button data-p="broken"><b>Broken chord</b><small>in eighths</small></button></div>
      <div class="modal-actions"><button data-close>Cancel</button></div>`);
    s.el.querySelectorAll('[data-p]').forEach((x) => (x.onclick = () => { s.close(); run({ op: 'realize', pattern: x.dataset.p, ...where }, null, { bar: where.start?.[0] ?? 0 }); }));
  };
  const barMenu = (anchor) => {
    const t = target(), n = nStaves(), entries = [];
    if (sel.size) entries.push({ label: 'Whole bar: pick every note of these bars (W)', run: wholeBar }, '-');
    const the = (s) => `the ${staffName(s, n)}`;
    if (t) {
      const b = t.bar, label = `bar ${b + 1}`;
      for (let s = 1; s <= n; s++) entries.push({ label: `Clear ${the(s)} in ${label}`, disabled: !inBar(b, s).some((x) => !x.rest), run: () => run({ op: 'clearbar', bar: b, staff: s }) });
      for (let s = 1; s <= n; s++) {
        const here = inBar(b, s);
        entries.push({ label: `Add ${the(s)} to ${label}`, run: () => {
          if (!here.length) return run({ op: 'addhand', bar: b, staff: s });
          barPick = null; setSel(here.filter((x) => x.rest).map((x) => x.ref));
          toast(here.some((x) => !x.rest) ? `${label[0].toUpperCase() + label.slice(1)} has ${the(s)} already` : `${the(s)[0].toUpperCase() + the(s).slice(1)} rests in ${label}: its rest is picked — use + Note`);
        } });
      }
      if (n === 1) entries.push({ label: 'Add a left-hand staff', run: () => run({ op: 'addstaff', at: 2, clef: 'bass' }) });
      entries.push('-', ...structEntries(t), { label: `Chord name at bar ${t.bar + 1}… (K)`, run: chordHere }, { label: 'Realize chords to left hand…', run: realizeSheet }, '-',
        { label: `Insert an empty bar before ${label}`, run: () => run({ op: 'insbar', bar: b, after: false }) },
        { label: `Insert an empty bar after ${label}`, run: () => run({ op: 'insbar', bar: b, after: true }) },
        { label: `Delete ${label}`, danger: true, run: async () => {
          if (new Set(cur().notes.map((x) => x.bar)).size < 2) return toast('A score keeps one bar at least');
          if (inBar(b).some((x) => !x.rest) && !(await confirmSheet({ title: `Delete ${label}?`, body: 'Its notes on every staff go, and the bars after it move up. Undo brings it back.', ok: 'Delete bar', danger: true }))) return;
          run({ op: 'delbar', bar: b });
        } });
    } else entries.push({ label: 'Tap a bar’s empty space or a note first', disabled: true, run: () => {} }, { label: 'Realize chords to left hand…', run: realizeSheet });
    entries.push('-');
    if (n === 1 && !t) entries.push({ label: 'Add a left-hand staff', run: () => run({ op: 'addstaff', at: 2, clef: 'bass' }) });
    if (n === 2) entries.push({ label: 'Add a voice staff on top (for lyrics)', run: () => run({ op: 'addstaff', at: 1, clef: 'treble' }) });
    entries.push({ label: 'Add a staff…', run: addStaff });
    if (n > 1) for (let s = 1; s <= n; s++) entries.push({ label: `Remove ${the(s)} staff…`, danger: true, run: async () => {
      if (!(await confirmSheet({ title: `Remove ${the(s)} staff?`, body: 'Its notes in every bar go, with any lyrics on them; chord names stay. Undo brings it back.', ok: 'Remove staff', danger: true }))) return;
      barPick = null; sel = new Set();
      run({ op: 'delstaff', staff: s });
    } });
    menu(anchor, entries);
  };
  const pitch = (by) => need(noteRefs(), (refs) => run({ op: 'pitch', refs, by }));
  // a length: of the picked notes, or (only rests picked) of the rests. A rest made shorter: offer to pull the
  // notes after it earlier instead of the rest it leaves (that replaces this edit: still one undo step)
  const lenRefs = () => { const p = picked(), ns = p.filter((n) => !n.rest); return (ns.length ? ns : p).map((n) => n.ref); };
  const setLen = (q) => {
    const refs = lenRefs();
    if (!refs.length) return toast('Pick a note or rest first');
    const m = byRef(), rs = refs.map((r) => m.get(r)).filter((n) => n?.rest);
    const op = { op: 'len', refs, q };
    const shorter = rs.length && rs.every((n) => q < n.dur);
    run(op, null, shorter ? { after: () => ({ text: 'Rest shorter: a rest fills the time after it', label: 'Pull the next notes earlier',
      run: () => { if (steps[at].ops.at(-1) === op) run({ ...op, pull: true }, null, { replace: true }); } }) } : {});
  };
  const dot = () => {
    const p = picked(), ns = p.filter((n) => !n.rest), ls = ns.length ? ns : p;
    if (!ls.length) return toast('Pick a note or rest first');
    const d = ls[0].dur;
    setLen(DOTTED.has(d) ? d / 1.5 : d * 1.5);
  };
  // = Even out (Q): 2+ notes / rests one after the other in one voice of one staff and bar (any note of a chord
  // picks the chord) → one length each, the same total (dotted 8th + 16th → two 8ths; evenops.py). The group, or null
  const evenGroup = () => {
    const p = picked();
    if (p.length < 2) return null;
    const k0 = `${p[0].bar}|${p[0].staff}|${p[0].voice}`;
    if (p.some((n) => `${n.bar}|${n.staff}|${n.voice}` !== k0)) return null;
    const evs = [...new Map(p.map((n) => [r3(n.on), n])).values()].sort((a, b) => a.on - b.on);
    if (evs.length < 2 || evs.some((n, i) => i && Math.abs(evs[i - 1].on + evs[i - 1].dur - n.on) > 1e-6)) return null;
    return evs;
  };
  const evenOut = () => {
    const g = evenGroup();
    if (!g) return toast('Pick 2 or more notes one after the other (one hand, one bar) to even them out');
    if (g.every((n) => Math.abs(n.dur - g[0].dur) < 1e-6)) return toast('These notes are already the same length');
    run({ op: 'even', refs: g.map((n) => n.ref) });
  };
  // →| Fill next rest: each press, the picked note takes in the one rest right after it (the note stays picked)
  const fill = () => {
    const ns = picked().filter((n) => !n.rest);
    if (!ns.length) return toast('Pick a note first');
    const go = ns.filter((n) => n.fill);
    if (!go.length) return toast('No rest after this note to fill');
    run({ op: 'fill', refs: go.map((n) => n.ref) });
  };
  // Delete: notes (a rest takes their place); only rests picked: Remove rest
  const del = () => {
    const p = picked();
    if (p.some((n) => !n.rest)) return run({ op: 'delete', refs: noteRefs() });
    if (!p.length) return toast('Pick a note or rest first');
    removeRest(p);
  };
  const sameVoice = (r) => cur().notes.filter((n) => n.bar === r.bar && n.staff === r.staff && n.voice === r.voice && n.ref !== r.ref);
  const removeRest = async (rs) => {
    const refs = rs.map((n) => n.ref);
    const r = rs[0];
    // a whole-bar rest (all its voice has in the bar): the bar itself can go
    if (rs.length === 1 && !sameVoice(r).length) {
      const others = cur().notes.filter((n) => n.bar === r.bar && !n.rest).length;
      if (!(await confirmSheet({ title: `Delete bar ${r.bar + 1}?`, body: `This rest is the whole bar. Delete this bar${others ? ` — and the ${plural(others, 'note')} the other hand plays in it` : ''}? The bars after it move up. Undo brings it back.`, ok: 'Delete this bar', danger: !!others }))) return;
      return run({ op: 'delbar', bar: r.bar });
    }
    // the rest ends its bar: nothing to close up in the bar — pull from the next bar, or the note before fills it
    if (rs.length === 1 && !sameVoice(r).some((n) => n.on > r.on + 1e-6)) {
      const how = await new Promise((done) => {
        let k = null;
        const s = modal(`<h2>Remove this rest</h2><p class="muted">It ends bar ${r.bar + 1}, so nothing in the bar comes after it.</p>
          <div class="modal-actions np-rmrest"><button data-close>Cancel</button><button data-k="ripple">Pull notes from the next bar</button><button class="primary" data-k="fill">Previous note fills it</button></div>`, { onClose: () => done(k) });
        s.el.querySelectorAll('[data-k]').forEach((x) => x.addEventListener('click', () => { k = x.dataset.k; s.close(); }));
      });
      if (how) run({ op: 'restdel', refs, how });
      return;
    }
    const op = { op: 'restdel', refs, how: 'close' };
    run(op, null, { after: () => ({ text: 'Rest removed: the notes after it came earlier — the bar is short now', label: 'Previous note fills it instead',
      run: () => { if (steps[at].ops.at(-1) === op) run({ ...op, how: 'fill' }, null, { replace: true }); } }) });
  };
  // a tie: to the next note of the same pitch; not the same pitch → offer a slur instead
  const tie = () => need(noteRefs(), (refs) => run({ op: 'tie', refs }, (e) => {
    if (!/Slur/.test(e.message)) return false;
    toast('The next note is another pitch: a tie needs the same note.', { label: 'Make it a slur', run: () => run({ op: 'slur', refs: [refs[0]], next: true }) });
    return true;
  }));
  const slur = () => need(noteRefs(), (refs) => {
    const ns = picked().filter((n) => !n.rest);
    if (ns.every((n) => n.slur)) return run({ op: 'unslur', refs });
    return run({ op: 'slur', refs, next: new Set(ns.map((n) => `${n.bar}|${n.on}`)).size === 1 });
  });
  // ← / →: the note (or rest) before / after the last one picked, on its staff; the page turns with it
  const stepNote = (d) => {
    const all = cur().notes, m = byRef(), a = m.get(anchor ?? [...sel].at(-1));
    const key = (n) => n.bar * 1e4 + n.on;
    let next;
    if (!a) next = all.filter((n) => n.staff === 1).sort((x, y) => key(x) - key(y))[0];
    else {
      const row = all.filter((n) => n.staff === a.staff && (d > 0 ? key(n) > key(a) + 1e-6 : key(n) < key(a) - 1e-6))
        .sort((x, y) => d * (key(x) - key(y)) || (x.midi ?? 0) - (y.midi ?? 0));
      next = row[0];
    }
    if (!next) return;
    anchor = next.ref;
    setSel([next.ref]);
    keepInView();
  };
  const turn = (d) => {
    if (view.paged) { view.goTo(view.page + d); draw(); return; }
    const h = host.querySelector('.scroll-host') || host.closest('.scroll-host') || document.scrollingElement;
    h?.scrollBy?.({ top: d * h.clientHeight * 0.8 });
  };
  // ▶ From here: plays the drawn (edited) notes from the bar before the picked notes (none picked: from the cue)
  const playHere = () => {
    const pl = view.player;
    if (!pl) return;
    if (pl.playing) { pl.pause(); host.dispatchEvent(new CustomEvent('playstate', { bubbles: true })); return draw(); }
    const b = firstBar([...sel]);
    if (b != null && !dropped) cueAt = view.cueBar(b); // one bar of lead-in, like the cue after an edit
    const pr = pl.play();
    host.dispatchEvent(new CustomEvent('playstate', { bubbles: true }));
    draw();
    Promise.resolve(pr).then(() => { draw(); host.dispatchEvent(new CustomEvent('playstate', { bubbles: true })); }, () => { draw(); toast('No sound yet — tap again.'); });
  };
  const onEnded = () => !closed && draw();
  host.addEventListener('ended', onEnded);
  // the orange line dragged (score.js): Play / ▶ From here start where it was dropped
  const onCueDrag = (e) => { if (closed) return; cueAt = e.detail.bar + 1; dropped = true; draw(); };
  host.addEventListener('cuedrag', onCueDrag);
  host.addEventListener('handschange', onEnded); // Hands changed (here or on the toolbar): the picker draws again
  view.keepBar?.(true);
  const add = () => need([...sel], (refs) => run({ op: 'add', refs, by: 4 }));
  // ---- A–G typed: the picked note takes that letter (the octave nearest it), a picked rest becomes that note (the
  // octave nearest the note before it); the key's sharps / flats apply (then ↑ ↓, # + / - a semitone); nothing picked:
  // the next rest from the play start. Then the next note / rest of that staff and voice is picked, so "CDEFG" is a run.
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const letter = async (L, up) => {
    const key = (n) => n.bar * 1e4 + n.on;
    let a = byRef().get(anchor);
    if (!a || !sel.has(a.ref)) a = picked().sort((x, y) => key(x) - key(y) || x.staff - y.staff)[0];
    if (!a) {
      const from = Math.max(0, (cueAt ?? 1) - 1);
      const rests = cur().notes.filter((n) => n.rest).sort((x, y) => x.staff - y.staff || key(x) - key(y));
      a = rests.find((n) => n.staff === 1 && n.bar >= from) || rests.find((n) => n.bar >= from) || rests[0];
      if (!a) return toast('No rest to write into: pick a note first');
    }
    const fifths = barState(a.bar).fifths;
    const alter = fifths > 0 ? ('FCGDAEB'.indexOf(L) < fifths ? 1 : 0) : fifths < 0 ? ('BEADGCF'.indexOf(L) < -fifths ? -1 : 0) : 0;
    const before = cur().notes.filter((n) => !n.rest && n.staff === a.staff && key(n) < key(a)).sort((x, y) => key(y) - key(x))[0];
    // a rest: the middle of its staff as drawn (an 8va line: the note sounds an octave up); a note: nearest to it (its
    // sounding pitch, so under 8va the letter lands where it is seen)
    const drawnUp = (n) => ({ 8: 12, '-8': -12, 15: 24, '-15': -24 })[barState(n.bar).ott(n.staff, n.on)] || 0;
    const near = !a.rest ? a.midi : before ? before.midi + drawnUp(a) - drawnUp(before) : (a.staff === nStaves() && nStaves() > 1 ? 50 : 71) + drawnUp(a);
    const p = LETTER_PC[L] + alter;
    let m = p + 12 * Math.round((near - p) / 12);
    if (up) m += 12;
    m = Math.max(21, Math.min(108, m));
    const place = { bar: a.bar, on: a.on, staff: a.staff, voice: a.voice };
    await run({ op: 'set', refs: [a.ref], midis: [m] }, null, { then: () => nextAfter(place) });
  };
  // the next onset of that staff and voice (another voice of the staff when that one ends) is picked
  const nextAfter = (place) => {
    const key = (n) => n.bar * 1e4 + n.on;
    const later = (same) => cur().notes.filter((n) => n.staff === place.staff && (!same || n.voice === place.voice) && key(n) > key(place) + 1e-6);
    let row = later(true);
    if (!row.length) row = later(false);
    if (!row.length) return;
    const k = Math.min(...row.map(key)), next = row.filter((n) => Math.abs(key(n) - k) < 1e-6).sort((x, y) => (x.voice === place.voice ? 0 : 1) - (y.voice === place.voice ? 0 : 1) || (y.midi ?? 0) - (x.midi ?? 0))[0];
    anchor = next.ref;
    setSel([next.ref]);
    keepInView();
  };
  // ---- copy / cut / paste / repeat (rangeops.py) ----
  const takeClip = async (w) => {
    const j = await post(`${url}/clip`, { ops: cur().ops, sha: base.sha, start: w.start, end: w.end, staves: [w.s0, w.s1] });
    return j.clip;
  };
  const keepClip = (c) => { clip = c; try { localStorage.setItem(CLIP_KEY, JSON.stringify(c)); } catch {} };
  const clipWords = (c) => (c.whole ? plural(c.bars, 'bar') : plural(c.notes, 'note')) + (c.staves > 1 ? ` on ${c.staves} staves` : '');
  const copy = async (cut = false) => {
    if (busy) return;
    const w = windowOf();
    if (!w) return toast('Pick notes or a range first');
    let c;
    try { busy = true; c = await takeClip(w); } catch (e) { return toast(e.message); } finally { busy = false; }
    keepClip(c);
    if (!cut) { toast(`Copied ${clipWords(c)} — pick where it goes, then Paste`); return draw(); }
    const r = rng;
    await run({ op: 'clear', start: w.start, end: w.end, staves: [w.s0, w.s1] }, null, { range: r || undefined });
    toast(`Cut ${clipWords(c)}: rests are left — Paste puts it back anywhere`);
  };
  // where a paste goes: the range's start, else the first picked note, else the bar picked
  const pasteAt = () => {
    const s = starts();
    if (rng) return { q: rng.a, staff: rng.s0 };
    const p = picked().sort((x, y) => absOf(x, s) - absOf(y, s) || y.staff - x.staff)[0];
    if (p) return { q: absOf(p, s), staff: Math.min(...picked().map((n) => n.staff)) };
    if (barPick) return { q: s[barPick.bar], staff: barPick.staff };
    return null;
  };
  const pasteClip = (c, to) => {
    const s = starts();
    const op = { op: 'paste', at: placeOf(to.q, s), staff: to.staff, clip: c };
    const len = fq(c.len);
    run(op, null, { range: { a: to.q, b: to.q + len, s0: to.staff, s1: Math.min(nStaves(), to.staff + c.staves - 1) } });
  };
  const paste = () => {
    if (!clip) return toast('Nothing copied yet: pick notes, then Copy');
    const to = pasteAt();
    if (!to) return toast('Pick the note where it goes first');
    pasteClip(clip, to);
  };
  // ⟳ Repeat: the selection (a range, the picked notes, one note) again right after itself, written over what follows
  const repeat = async () => {
    if (busy) return;
    const w = windowOf();
    if (!w) return toast('Pick notes or a range first');
    let c;
    try { busy = true; c = await takeClip(w); } catch (e) { return toast(e.message); } finally { busy = false; }
    pasteClip(c, { q: w.b, staff: w.s0 });
  };
  // Shift ← / →: the range a note longer / shorter at its moving end (a note picked: the range starts there)
  const extendRange = (d) => {
    const s = starts();
    let r = rng;
    if (!r) {
      const p = picked();
      if (!p.length) return turn(d);
      r = spanOf(p); rangeEnd = d;
    }
    const all = cur().notes.filter((n) => n.staff >= r.s0 && n.staff <= r.s1);
    const ons = [...new Set(all.map((n) => r3(absOf(n, s))))].sort((x, y) => x - y);
    const ends = [...new Set(all.map((n) => r3(absOf(n, s) + n.dur)))].sort((x, y) => x - y);
    if (rangeEnd > 0) {
      const b = d > 0 ? ends.find((x) => x > r.b + 1e-6) : [...ends].reverse().find((x) => x < r.b - 1e-6 && x > r.a + 1e-6);
      if (b == null) { if (d < 0 && r.b > r.a) { rangeEnd = -1; return extendRange(d); } return; }
      r = { ...r, b };
    } else {
      const a = d < 0 ? [...ons].reverse().find((x) => x < r.a - 1e-6) : ons.find((x) => x > r.a + 1e-6 && x < r.b - 1e-6);
      if (a == null) { if (d > 0) { rangeEnd = 1; return extendRange(d); } return; }
      r = { ...r, a };
    }
    setRange(r);
    keepInView();
  };
  // ♯/♭: the next spelling of the same pitch; held down / right-click: ♯ ♭ ♮, courtesy accidental
  const respell = () => need(noteRefs(), (refs) => run({ op: 'respell', refs }));
  const accMenu = (anchorEl) => {
    const refs = noteRefs();
    if (!refs.length) return toast('Pick a note first');
    menu(anchorEl, [
      { label: '♯ Sharp', run: () => run({ op: 'accidental', refs, alter: 1 }) },
      { label: '♭ Flat', run: () => run({ op: 'accidental', refs, alter: -1 }) },
      { label: '♮ Natural', run: () => run({ op: 'accidental', refs, alter: 0 }) },
      '-',
      { label: '( ♮ ) Courtesy accidental on / off', run: () => run({ op: 'courtesy', refs }) },
      { label: '♯/♭ Spell another way (J)', run: respell },
    ]);
  };
  const goStep = async (k) => {
    if (lyr?.pending) await lyr.flush(); // [lyrics] words typed but not sent yet: a step first
    if (busy || k < 0 || k >= steps.length || k === at) return;
    busy = true;
    sel = new Set(k < at ? steps[at].sel || [] : []);
    barPick = k < at ? steps[at].barPick || null : null;
    rng = k < at ? steps[at].rng || null : null;
    rangeArm = false;
    arcSel = null;
    took = new Set();
    const bar = steps[Math.max(at, k)].bar;
    at = k;
    guard.changed();
    draw();
    try {
      if (queue.length) stale = true; // another undo / edit waits: draw only the last
      else { stale = false; await show(cur().xml); cue(bar); }
    } finally { busy = false; drain(); }
  };

  // ---- save / close ----
  const save = () => {
    if (at === 0 || busy) return;
    const s = modal(`<h2>Save the edited notes?</h2><p class="muted">Saving into this score keeps the score before in its history — Activities can undo it. A new version is its own entry next to this one; this score stays as it is.</p>
      <div class="modal-actions np-save"><button data-close>Cancel</button><button data-mode="new">Save as new version</button><button class="primary" data-mode="this">Save to this score</button></div>`);
    s.el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = async () => {
      const mode = b.dataset.mode;
      busy = true;
      s.el.querySelectorAll('button').forEach((x) => (x.disabled = true));
      const bs = steps.slice(1, at + 1).map((x) => x.bar).filter((b) => b != null);
      const edited = bs.length ? Math.min(...bs) : null;
      try {
        await guard.hold();
        const j = await post(url, { ops: [...cur().ops, ...(mode === 'this' ? opts.extraOps?.() || [] : [])], mode, sha: base.sha, session, xml: cur().xml });
        await dropLocal(it.id); // saved: the draft goes (the Mac drops its copy itself)
        s.close();
        await close(true);
        const short = j.incomplete?.length || 0;
        const notDone = short ? ` · ${plural(short, 'bar')} not complete` : '';
        if (j.copy) store.putItem(j.copy);
        const acts = { label: 'Activities', run: () => go('#/activity') };
        if (mode === 'new') {
          store.putItem(j.item);
          if (edited != null) window.__meowsicCue = { id: j.item.id, bar: edited }; // the new score opens cued there
          saveNote(`Saved as a new version — this score is unchanged${notDone}`, { action: acts });
          go(`#/item/${encodeURIComponent(j.item.id)}`);
        } else {
          const was = store.get(it.id);
          if (was) Object.assign(was, { updatedAt: j.item.updatedAt, musicxmlOriginal: j.item.musicxmlOriginal });
          await view.reload();
          if (edited != null && !j.failed) view.cueBar(edited);
          if (j.copy) saveNote(`${j.message}${notDone}`, { stay: true, action: { label: 'Open my edits', run: () => go(`#/item/${encodeURIComponent(j.copy.id)}`) } });
          else saveNote(`${j.merged ? j.message : 'Notes saved — Activities can undo it'}${notDone}`, { action: acts });
        }
        opts.onDone?.(j);
      } catch (e) {
        s.close();
        guard.release(); guard.flush();
        saveNote(`Not saved: ${e instanceof TypeError ? 'the Mac could not be reached' : e.message}. Your edits are still here (and kept as a draft) — try Save again.`, { error: true });
      } finally { busy = false; }
    }));
  };
  const close = async (saved) => {
    if (closed) return;
    if (saved !== true) await lyr?.flush(); // [lyrics]
    if (saved !== true && at > 0 && !(await confirmSheet({ title: 'Close without saving?', body: 'The notes you changed here are not saved yet.', ok: 'Close', danger: true }))) return;
    closed = true;
    guard.stop();
    if (EDIT_SESSION === session) { EDIT_SESSION = null; setEditSession(null); }
    if (saved !== true) dropDrafts(it.id); // closed without saving, on purpose: no draft to offer back
    midiCtl?.destroy();
    host.removeEventListener('scoredrawn', tag);
    host.removeEventListener('scoredrawn', markBar);
    host.removeEventListener('scoredrawn', markRange);
    paper.querySelectorAll('.np-barpick, .np-range').forEach((r) => r.remove());
    document.querySelector('.menu')?.remove();
    host.removeEventListener('barfix', onBarFix, true);
    host.removeEventListener('pointerdown', onDown, true); host.removeEventListener('pointermove', onMove, true);
    host.removeEventListener('pointerup', onUp, true); host.removeEventListener('pointercancel', onUp, true);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'click']) host.removeEventListener(t, stop, true);
    host.removeEventListener('contextmenu', noMenu, true);
    document.removeEventListener('keydown', onKey, true);
    host.removeEventListener('ended', onEnded); host.removeEventListener('handschange', onEnded);
    host.removeEventListener('cuedrag', onCueDrag); view.keepBar?.(false);
    lyr?.destroy(); // [lyrics]
    box?.remove(); endDrag(); arcSel = null; markArc(); document.removeEventListener('scroll', onScroll, true); untag(); panel.remove();
    host.classList.remove('noting'); host.style.removeProperty('--np-h');
    if (window.__editNotes === api) delete window.__editNotes;
    if (shown && saved !== true) await view.reload();
    if (saved !== true) opts.onDone?.(null);
  };

  panel.addEventListener('click', (e) => {
    if (e.target.closest('#np-hands')) { const m = handsClick(e, view.staves, view.muted, view.chordPlay, view.hasChords); if (m) view.setParts(m); return; } // Parts to play (hands.js): at once, playing or not
    const l = e.target.closest('[data-len]');
    if (l) return act(() => setLen(+l.dataset.len));
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const fn = ({ close: () => close(), undo: () => goStep(at - 1), redo: () => goStep(at + 1), save, up: () => moveTo(-1), down: () => moveTo(1), barmenu: () => barMenu(e.target.closest('[data-a]')),
      'semi-': () => pitch(-1), 'semi+': () => pitch(1), 'oct-': () => pitch(-12), 'oct+': () => pitch(12), dot, del, add, fill, even: evenOut,
      copy: () => copy(), cut: () => copy(true), paste, repeat, respell: () => (heldMenu ? (heldMenu = false) : respell()),
      bar: wholeBar, none: () => setSel([]), several: () => { several = !several; draw(); }, tie, slur, playhere: playHere,
      prev: () => turn(-1), next: () => turn(1) })[a];
    if (fn) act(fn);
  });
  // ♯/♭ held down (or right-clicked): the accidentals menu
  let heldMenu = false, holdT = null;
  panel.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-a="respell"]');
    if (!b || b.disabled) return;
    clearTimeout(holdT);
    holdT = setTimeout(() => { heldMenu = true; accMenu(b); }, LONG_MS);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) panel.addEventListener(t, () => clearTimeout(holdT));
  panel.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-a="respell"]');
    if (!b) return;
    e.preventDefault(); clearTimeout(holdT);
    if (!b.disabled) accMenu(b);
  });
  const onKey = (e) => {
    if (closed || document.querySelector('.modal-wrap') || e.target.closest?.('input,textarea,select')) return;
    if (lyr?.key(e)) return; // [lyrics] in Lyrics mode the note keys rest
    if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); press = null; return endDrag(); } // a drag let go: nothing changes
    if (drag) return;
    if (arcSel && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape')) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') { arcSel = null; return paint(); } return removeArc(); }
    const mod = e.metaKey || e.ctrlKey;
    let f = null;
    if (mod && e.key.toLowerCase() === 'z') f = () => goStep(e.shiftKey ? at + 1 : at - 1);
    else if (mod && e.key.toLowerCase() === 'a') f = wholeScore;
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'c') f = () => copy();
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'x') f = () => copy(true);
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'v') f = paste;
    else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) f = () => moveTo(e.key === 'ArrowUp' ? -1 : 1);
    else if (e.shiftKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) f = () => extendRange(e.key === 'ArrowRight' ? 1 : -1); // nothing picked: the page
    else if (!mod && (e.key === 'PageDown' || e.key === 'PageUp')) f = () => turn(e.key === 'PageDown' ? 1 : -1);
    else if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) f = () => pitch(e.key === 'ArrowUp' ? 12 : -12);
    else if (!mod && !e.altKey && /^[a-g]$/i.test(e.key)) f = () => letter(e.key.toUpperCase(), e.shiftKey); // A–G: that note (Shift: an octave up)
    else if (!mod) {
      const len = LENS.find((x) => x[2] === e.key);
      f = len ? () => setLen(len[0]) : { ArrowUp: () => pitch(1), ArrowDown: () => pitch(-1), ArrowLeft: () => stepNote(-1), ArrowRight: () => stepNote(1),
        '.': dot, q: evenOut, Q: evenOut, l: fill, L: fill, n: add, N: add, '#': () => pitch(1), '+': () => pitch(1), '=': () => pitch(1), '-': () => pitch(-1), t: tie, T: tie, s: slur, S: slur, ...(e.target.closest?.('button') ? {} : { ' ': playHere }), Delete: del, Backspace: del,
        w: wholeBar, W: wholeBar, r: repeat, R: repeat, j: respell, J: respell, k: chordHere, K: chordHere, Escape: () => (sel.size || rng ? setSel([]) : close()) }[e.key];
    }
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    act(f); // busy: it waits its turn (queue)
  };
  document.addEventListener('keydown', onKey, true);
  host.addEventListener('pagechange', () => !closed && draw());

  const api = { get sel() { return [...sel]; }, get notes() { return cur().notes; }, get step() { return at; }, get steps() { return steps.length; },
    get ops() { return cur().ops; }, get xml() { return cur().xml; }, select: (refs) => setSel(refs), get busy() { return busy || queue.length > 0 || stale; }, close,
    get cueBar() { return cueAt; }, run: (op) => run(op), get barPick() { return barPick; }, pickBar: (bar, staff = 1) => { barPick = { bar, staff }; setSel([]); },
    get staves() { return nStaves(); }, get took() { return [...took]; }, get lyrics() { return lyr; },
    get range() { return rng && { ...rng }; }, get chords() { return chordsOf(); }, chordAt: (x, y) => chordAt(x, y), setRange: (r) => setRange(r), get clip() { return clip; }, get rangeArm() { return rangeArm; }, get arc() { return arcSel && { ...arcSel }; }, get dragging() { return !!drag; } };
  window.__editNotes = api; // for automated tests
  // a MIDI keyboard plays into the picked notes: midiedit.js, through these edits
  midiCtl = attachMidi({ get notes() { return cur().notes; }, get sel() { return picked(); }, get busy() { return busy; }, get step() { return at; },
    select: (refs) => { anchor = refs.at(-1) ?? null; setSel(refs); keepInView(); }, setPitch: (refs, midis) => run({ op: 'set', refs, midis }),
    setLength: (q) => setLen(q), dot: () => dot(), tie: () => tie(), rest: () => del(), toast });
  if (opts.bar) sel = new Set(base.notes.filter((n) => !n.rest && n.bar === opts.bar - 1).map((n) => n.ref));
  // [lyrics] Lyrics mode: the hooks it needs (opts.mode 'lyrics' opens on it; opts.verse, opts.bar: where)
  lyr = lyricMode({ view, it, host, panel, paper, base, opts, cur, sel: () => [...sel], select: (refs) => setSel(refs), run, busy: () => busy,
    save, draw, close, steps: () => at + 1, goStep: (d) => goStep(at + d) });
  draw();
  tag();
  if (restored) { guard.changed(); await show(cur().xml); draw(); toast(`Unsaved edits restored (${plural(restored.ops.length, 'change')}) — Save to keep them`); }
  if (opts.mode === 'lyrics') lyr.set(true); // [lyrics]
  return api;
}

// "Restore unsaved edits (N changes, 14:05)" / "Discard" -> true: restore (closing the sheet restores too: never lost)
function restoreSheet(d) {
  return new Promise((resolve) => {
    let said = null;
    const when = new Date(d.savedAt || Date.now());
    const hm = when.toTimeString().slice(0, 5), day = when.toDateString() === new Date().toDateString() ? hm : `${when.toLocaleDateString()} ${hm}`;
    const n = d.ops.length;
    const s = modal(`<h2>Unsaved edits</h2><p class="muted">This score has edits from ${day} that were never saved (${n} change${n === 1 ? '' : 's'}).</p>
      <div class="modal-actions np-restore"><button class="danger" data-k="discard">Discard</button><button class="primary" data-k="restore">Restore unsaved edits (${n} change${n === 1 ? '' : 's'}, ${day})</button></div>`,
    { onClose: () => resolve(said !== 'discard') });
    s.el.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { said = b.dataset.k; s.close(); }));
  });
}
