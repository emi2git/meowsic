// Edit notes (score ⋯ → "Edit notes…", or "Edit notes" on a bar in Check bars): pick notes on the score and change
// them. Tap / click a note (or a rest) to pick it; ⌘ / Ctrl-click (iPad / iPhone: "Pick several") adds or takes one
// away; Shift-click picks the range on that staff from the last note picked; drag a box to pick everything in it;
// "Whole bar" picks every note of the picked notes' bars on their staves. Then:
//   ♭ / ♯ a semitone down / up (↓ / ↑), 8↓ / 8↑ an octave (⌘↓ / ⌘↑), a length (2–6 = 1/16 … whole, . = dotted),
//   Delete (a rest stays), + Note (a third above, in the chord; on a rest: a note there, then move it up / down),
//   and, in a piano part, to the right / left hand (Shift ↑ / Shift ↓).
// The Mac rebuilds the bars (server/meowsic/staffmove.py: every voice of both staves stays full, chords together,
// rests where a hand has nothing to play) and the score draws again at once. Undo / redo inside the editor;
// Save into this score (the file before stays in .history, Activities can undo it) or as a new version.
import { iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { store } from '../store.js';
import { go } from '../app.js';
import { isTouch } from '../device.js';

export const post = (path, body) => fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); return j; });

export const hasPiano = (xml) => /<staves>\s*2\s*<\/staves>/.test(xml || '');
const r3 = (x) => Math.round(x * 1000) / 1000;
// a note's own notehead (the notes of a chord share one VexFlow note; its heads are drawn in order, one group each)
const headEl = (gn) => {
  const g = gn.getSVGGElement?.();
  const heads = g?.querySelectorAll(':scope > .vf-note > .vf-notehead');
  return heads?.[gn.vfnoteIndex ?? gn.vfnote?.[1] ?? 0] || g;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const LENS = [[0.25, '1/16', '16th note', '2'], [0.5, '⅛', 'Eighth note', '3'], [1, '¼', 'Quarter note', '4'], [2, '½', 'Half note', '5'], [4, '1', 'Whole note', '6']];
const DOTTED = new Set([0.375, 0.75, 1.5, 3]);

// opts: { bar: 1-based bar to start on (its notes picked), extraOps: () => [ops added on Save], title, onDone(result | null) }
export async function editNotes(view, it, host, opts = {}) {
  if (!host || host.querySelector('.notes-panel')) return;
  host.querySelector('.editbar')?.dispatchEvent(new Event('close'));
  view.player?.pause();
  const url = `/items/${encodeURIComponent(it.id)}/editnotes`;
  let base;
  try { base = await post(`${url}/preview`, { ops: [] }); } catch (e) { toast(e.message); opts.onDone?.(null); return; }
  const paper = host.querySelector('#paper');
  const panel = document.createElement('div');
  panel.className = 'notes-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Edit notes');
  host.append(panel);
  host.classList.add('noting');
  // steps[0] = the score as saved; each edit adds one (its ops = every edit so far, replayed by the Mac)
  let steps = [{ ops: [], xml: base.xml, notes: base.notes }], at = 0;
  let sel = new Set(), anchor = null, several = false, busy = false, shown = false, closed = false;
  const cur = () => steps[at];
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
            if (!el) return;
            el.dataset.ref = g[i].ref;
            el.classList.add('nh-hit');
            el.classList.toggle('nh-rest', x.rest);
            el.classList.toggle('nh-on', sel.has(g[i].ref));
          });
        });
      }
    });
  };
  const paint = () => {
    paper.querySelectorAll('g[data-ref]').forEach((g) => g.classList.toggle('nh-on', sel.has(+g.dataset.ref)));
    draw();
  };
  const untag = () => paper.querySelectorAll('g[data-ref]').forEach((g) => { g.classList.remove('nh-hit', 'nh-on', 'nh-rest'); delete g.dataset.ref; });
  host.addEventListener('scoredrawn', tag);

  // ---- the panel ----
  const picked = () => [...sel].map((r) => byRef().get(r)).filter(Boolean);
  const draw = () => {
    if (closed) return;
    const p = picked(), ns = p.filter((n) => !n.rest), rs = p.filter((n) => n.rest);
    const up = ns.filter((n) => n.staff === 2).length, down = ns.filter((n) => n.staff === 1).length;
    const len = ns.length && ns.every((n) => n.dur === ns[0].dur) ? ns[0].dur : null;
    const baseLen = len == null ? null : DOTTED.has(len) ? len / 1.5 : len;
    const pages = view.pages > 1;
    const off = (c) => (c ? '' : 'disabled');
    panel.innerHTML = `<div class="np-row"><b class="np-title">${opts.title || 'Edit notes'}</b>
      <span class="np-count" id="np-count">${p.length ? `${plural(ns.length, 'note')}${rs.length ? ` · ${plural(rs.length, 'rest')}` : ''} picked` : 'Pick notes on the score'}</span>
      <span class="grow"></span>
      ${pages ? `<button class="icon-btn" data-a="prev" title="Page before" aria-label="Page before" ${off(view.page > 1)}>${iconOn('left')}</button><button class="icon-btn" data-a="next" title="Next page" aria-label="Next page" ${off(view.page < view.pages)}>${iconOn('right')}</button>` : ''}
      <button class="icon-btn" data-a="undo" ${off(at > 0)} title="Undo (⌘Z)" aria-label="Undo">${iconOn('undo')}</button>
      <button class="icon-btn" data-a="redo" ${off(at < steps.length - 1)} title="Redo (⇧⌘Z)" aria-label="Redo"><span class="flip">${iconOn('undo')}</span></button>
      <button class="icon-btn" data-a="close" title="Close (Esc)" aria-label="Close">${iconOn('close')}</button></div>
      <p class="muted np-help">${isTouch() ? 'Tap notes or rests to pick them, or drag a box around them. “Pick several” adds each tap.' : 'Click a note or rest to pick it · ⌘-click adds one · Shift-click picks a range · drag a box around notes. Keys: ↑ ↓ semitone, ⌘↑ ⌘↓ octave, 2–6 length, . dotted, N add, Delete.'} Every bar stays full.</p>
      <div class="np-acts np-tools">
        ${isTouch() ? `<button data-a="several" class="${several ? 'on' : ''}" aria-pressed="${several}">Pick several</button>` : ''}
        <button data-a="bar" ${off(p.length)} title="Every note of these bars on these staves (B)">Whole bar</button>
        <span class="stepper np-pitch" aria-label="Pitch"><button data-a="oct-" ${off(ns.length)} title="Octave down (⌘↓)" aria-label="Octave down">8↓</button><button data-a="semi-" ${off(ns.length)} title="Semitone down (↓)" aria-label="Semitone down">♭</button><button data-a="semi+" ${off(ns.length)} title="Semitone up (↑)" aria-label="Semitone up">♯</button><button data-a="oct+" ${off(ns.length)} title="Octave up (⌘↑)" aria-label="Octave up">8↑</button></span>
        <span class="stepper np-len" aria-label="Length">${LENS.map(([q, g, l, k]) => `<button data-len="${q}" class="${baseLen === q ? 'on' : ''}" ${off(ns.length)} title="${l} (${k})" aria-label="${l}">${g}</button>`).join('')}<button data-a="dot" class="${len != null && DOTTED.has(len) ? 'on' : ''}" ${off(len != null)} title="Dotted (.)" aria-label="Dotted">•</button></span>
        <button data-a="add" ${off(p.length)} title="Add a note (N): a third above, or on a rest">+ Note</button>
        <button data-a="del" ${off(ns.length)} title="Delete (⌫): a rest takes its place">Delete</button>
      </div>
      <div class="np-acts">
        <button data-a="none" ${off(p.length)}>Clear</button>
        <span class="grow"></span>
        ${base.hands ? `<button data-a="up" class="np-move" ${off(up)} title="Move to the upper staff (Shift ↑)">↑ To right hand${up ? ` (${up})` : ''}</button>
        <button data-a="down" class="np-move" ${off(down)} title="Move to the lower staff (Shift ↓)">↓ To left hand${down ? ` (${down})` : ''}</button>` : ''}
        <button class="primary" data-a="save" ${off(at > 0)}>Save…</button>
      </div>`;
    host.style.setProperty('--np-h', panel.offsetHeight + 'px');
  };

  // ---- picking ----
  const setSel = (refs, add = false) => { sel = add ? new Set([...sel, ...refs]) : new Set(refs); paint(); };
  const range = (a, b) => {
    const m = byRef(), x = m.get(a), y = m.get(b);
    if (!x || !y || x.staff !== y.staff) return [b];
    const key = (n) => n.bar * 1e4 + n.on;
    const [lo, hi] = [Math.min(key(x), key(y)), Math.max(key(x), key(y))];
    return cur().notes.filter((n) => n.staff === x.staff && key(n) >= lo - 1e-6 && key(n) <= hi + 1e-6).map((n) => n.ref);
  };
  const tapNote = (ref, e) => {
    if (e.shiftKey && anchor != null) return setSel(range(anchor, ref), e.metaKey || e.ctrlKey);
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
  const inPaper = (e) => !!e.target.closest?.('#paper') && !e.target.closest('.notes-panel');
  const onDown = (e) => {
    if (!inPaper(e) || e.button > 0) return;
    e.stopPropagation();
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, ref: e.target.closest('g[data-ref]')?.dataset.ref };
  };
  const onMove = (e) => {
    if (!press || e.pointerId !== press.id) return;
    e.stopPropagation();
    if (!box && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
    e.preventDefault();
    if (!box) { box = document.createElement('div'); box.className = 'np-box'; document.body.append(box); }
    const l = Math.min(press.x, e.clientX), t = Math.min(press.y, e.clientY);
    Object.assign(box.style, { left: l + 'px', top: t + 'px', width: Math.abs(e.clientX - press.x) + 'px', height: Math.abs(e.clientY - press.y) + 'px' });
  };
  const onUp = (e) => {
    if (!press || e.pointerId !== press.id) return;
    e.stopPropagation();
    const p = press; press = null;
    if (box) {
      const r = box.getBoundingClientRect();
      box.remove(); box = null;
      if (e.type !== 'pointerup') return;
      const hit = [...paper.querySelectorAll('g[data-ref]:not(.nh-rest)')].filter((g) => { const b = g.getBoundingClientRect(); return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom; }).map((g) => +g.dataset.ref);
      if (hit.length) anchor = hit[hit.length - 1];
      return setSel(hit, e.shiftKey || e.metaKey || e.ctrlKey || several);
    }
    if (e.type !== 'pointerup') return;
    // not right on a notehead: the nearest one within a finger's width
    let ref = p.ref;
    if (ref == null) {
      let best = 24;
      for (const g of paper.querySelectorAll('g[data-ref]')) {
        const b = g.getBoundingClientRect(), d = Math.hypot(e.clientX - (b.left + b.right) / 2, e.clientY - (b.top + b.bottom) / 2);
        if (d < best) { best = d; ref = g.dataset.ref; }
      }
    }
    if (ref != null) tapNote(+ref, e);
    else if (!several && sel.size) setSel([]);
  };
  const stop = (e) => { if (inPaper(e)) e.stopPropagation(); };
  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);
  host.addEventListener('pointercancel', onUp, true);
  for (const t of ['touchstart', 'touchmove', 'touchend', 'click']) host.addEventListener(t, stop, true);

  // ---- editing, undo / redo ----
  const show = async (xml) => { shown = true; await view.showXml(xml); };
  const run = async (op) => {
    if (busy) return;
    busy = true;
    try {
      const ops = [...cur().ops, op];
      const j = await post(`${url}/preview`, { ops });
      steps = steps.slice(0, at + 1);
      steps.push({ ops, xml: j.xml, notes: j.notes, sel: [...sel] });
      at++;
      sel = new Set(j.moved);
      draw();
      await show(j.xml);
    } catch (e) { toast(e.message); } finally { busy = false; }
  };
  const noteRefs = () => picked().filter((n) => !n.rest).map((n) => n.ref);
  const need = (refs, f) => (refs.length ? f(refs) : toast('Pick a note first'));
  const moveTo = (to) => {
    if (!base.hands) return;
    const refs = picked().filter((n) => !n.rest && n.staff !== to).map((n) => n.ref);
    if (!refs.length) return toast(to === 1 ? 'Those notes are in the right hand already' : 'Those notes are in the left hand already');
    run({ op: 'move', refs, to });
  };
  const pitch = (by) => need(noteRefs(), (refs) => run({ op: 'pitch', refs, by }));
  const setLen = (q) => need(noteRefs(), (refs) => run({ op: 'len', refs, q }));
  const dot = () => {
    const ns = picked().filter((n) => !n.rest);
    if (!ns.length) return toast('Pick a note first');
    const d = ns[0].dur;
    setLen(DOTTED.has(d) ? d / 1.5 : d * 1.5);
  };
  const del = () => need(noteRefs(), (refs) => run({ op: 'delete', refs }));
  const add = () => need([...sel], (refs) => run({ op: 'add', refs, by: 4 }));
  const goStep = async (k) => {
    if (busy || k < 0 || k >= steps.length || k === at) return;
    busy = true;
    sel = new Set(k < at ? steps[at].sel || [] : []);
    at = k;
    draw();
    try { await show(cur().xml); } finally { busy = false; }
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
      try {
        const j = await post(url, { ops: [...cur().ops, ...(mode === 'this' ? opts.extraOps?.() || [] : [])], mode, sha: base.sha });
        s.close();
        await close(true);
        if (mode === 'new') {
          store.putItem(j.item);
          toast('Saved as a new version — this score is unchanged', { label: 'Activities', run: () => go('#/activity') });
          go(`#/item/${encodeURIComponent(j.item.id)}`);
        } else {
          const was = store.get(it.id);
          if (was) Object.assign(was, { updatedAt: j.item.updatedAt, musicxmlOriginal: j.item.musicxmlOriginal });
          await view.reload();
          toast('Notes saved — Activities can undo it', { label: 'Activities', run: () => go('#/activity') });
        }
        opts.onDone?.(j);
      } catch (e) { s.close(); toast(e.message); } finally { busy = false; }
    }));
  };
  const close = async (saved) => {
    if (closed) return;
    if (saved !== true && at > 0 && !(await confirmSheet({ title: 'Close without saving?', body: 'The notes you changed here are not saved yet.', ok: 'Close', danger: true }))) return;
    closed = true;
    host.removeEventListener('scoredrawn', tag);
    host.removeEventListener('pointerdown', onDown, true); host.removeEventListener('pointermove', onMove, true);
    host.removeEventListener('pointerup', onUp, true); host.removeEventListener('pointercancel', onUp, true);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'click']) host.removeEventListener(t, stop, true);
    document.removeEventListener('keydown', onKey, true);
    box?.remove(); untag(); panel.remove();
    host.classList.remove('noting'); host.style.removeProperty('--np-h');
    if (window.__editNotes === api) delete window.__editNotes;
    if (shown && saved !== true) await view.reload();
    if (saved !== true) opts.onDone?.(null);
  };

  panel.addEventListener('click', (e) => {
    const l = e.target.closest('[data-len]');
    if (l) return setLen(+l.dataset.len);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    ({ close: () => close(), undo: () => goStep(at - 1), redo: () => goStep(at + 1), save, up: () => moveTo(1), down: () => moveTo(2),
      'semi-': () => pitch(-1), 'semi+': () => pitch(1), 'oct-': () => pitch(-12), 'oct+': () => pitch(12), dot, del, add,
      bar: wholeBar, none: () => setSel([]), several: () => { several = !several; draw(); },
      prev: () => { view.goTo(view.page - 1); draw(); }, next: () => { view.goTo(view.page + 1); draw(); } })[a]?.();
  });
  const onKey = (e) => {
    if (closed || document.querySelector('.modal-wrap') || e.target.closest?.('input,textarea,select')) return;
    const mod = e.metaKey || e.ctrlKey;
    let f = null;
    if (mod && e.key.toLowerCase() === 'z') f = () => goStep(e.shiftKey ? at + 1 : at - 1);
    else if (mod && e.key.toLowerCase() === 'a') f = () => setSel(cur().notes.filter((n) => !n.rest).map((n) => n.ref));
    else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) f = () => moveTo(e.key === 'ArrowUp' ? 1 : 2);
    else if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) f = () => pitch(e.key === 'ArrowUp' ? 12 : -12);
    else if (!mod) {
      const len = LENS.find((x) => x[3] === e.key);
      f = len ? () => setLen(len[0]) : { ArrowUp: () => pitch(1), ArrowDown: () => pitch(-1), '.': dot, n: add, N: add, Delete: del, Backspace: del,
        b: wholeBar, B: wholeBar, Escape: () => (sel.size ? setSel([]) : close()) }[e.key];
    }
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    f();
  };
  document.addEventListener('keydown', onKey, true);
  host.addEventListener('pagechange', () => !closed && draw());

  const api = { get sel() { return [...sel]; }, get notes() { return cur().notes; }, get step() { return at; }, get steps() { return steps.length; },
    get ops() { return cur().ops; }, get xml() { return cur().xml; }, select: (refs) => setSel(refs), get busy() { return busy; }, close };
  window.__editNotes = api; // for automated tests
  if (opts.bar) sel = new Set(base.notes.filter((n) => !n.rest && n.bar === opts.bar - 1).map((n) => n.ref));
  draw();
  tag();
  return api;
}
