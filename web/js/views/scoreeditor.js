// Score note editor (like MuseScore / Flat): click a note on the staff, change it with the one-line
// bar or the keys. Works on sample scores (TuneModel) and real MusicXML scores (XmlModel).
import { iconOn, toast } from '../ui.js';
import { isTriplet, twelfths, midiOf, nameOf } from '../musicxml.js';
import { TuneModel, XmlModel } from '../scoremodel.js';

// ================= score editor =================
// Like MuseScore / Flat: click a note on the staff to select it, then change it with the palette or keys:
// ↑/↓ semitone · ⌘↑/⌘↓ octave · ←/→ previous/next note · A–G set the note · 2 3 4 5 6 = 1/16 ⅛ ¼ ½ whole ·
// . dot · T triplet · R rest · N add a note after · Delete remove · ⌘Z undo. A bar whose notes no longer fit the
// song's meter gets its own time signature (5 beats in a 4/4 song → that bar becomes 5/4).
// small pictures of each note (head, stem, flags), drawn as SVG
const head = (filled) => `<ellipse cx="8" cy="18" rx="4.6" ry="3.4" transform="rotate(-22 8 18)" ${filled ? '' : 'fill="none" stroke-width="1.6"'}/>`;
const stem = '<path d="M12.2 17V3" stroke-width="1.5" fill="none"/>';
const flag = (y) => `<path d="M12.2 ${y}c2.5 2 5 3.5 4 8" stroke-width="1.6" fill="none"/>`;
const pic = (inner) => `<svg class="notepic" viewBox="0 0 20 24" aria-hidden="true">${inner}</svg>`;
const dot = '<circle cx="17" cy="19" r="1.7"/>';
const NOTE_PICS = { 0.25: pic(head(1) + stem + flag(3) + flag(7)), 0.5: pic(head(1) + stem + flag(3)), 0.75: pic(head(1) + stem + flag(3) + dot),
  1: pic(head(1) + stem), 1.5: pic(head(1) + stem + dot), 2: pic(head(0) + stem), 3: pic(head(0) + stem + dot), 4: pic(head(0)) };
const DOT_PIC = pic('<circle cx="10" cy="17" r="2.6"/>');
const rdot = '<circle cx="16" cy="13" r="1.6"/>';
const r8 = '<circle cx="8" cy="8" r="2.2"/><path d="M8 9.5c2 1 4 .5 5.5-1.5L9 21" stroke-width="1.6" fill="none"/>';
const REST_PICS = { 0.25: pic(r8 + '<circle cx="6.5" cy="13" r="2.2"/><path d="M6.5 14.5c2 1 4 .5 5.5-1.5" stroke-width="1.6" fill="none"/>'), 0.5: pic(r8), 0.75: pic(r8 + rdot),
  1: pic('<path d="M8 3l4.5 5-3.5 4 4.5 5c-3-1.5-5 0-3 3.5-4-2.5-3-6 0-5L6 9z"/>'), 1.5: pic('<path d="M7 3l4.5 5-3.5 4 4.5 5c-3-1.5-5 0-3 3.5-4-2.5-3-6 0-5L5 9z"/>' + rdot),
  2: pic('<path d="M3 13h14" stroke-width="1.4"/><rect x="6" y="9.5" width="8" height="3.5"/>'), 3: pic('<path d="M2 13h13" stroke-width="1.4"/><rect x="4.5" y="9.5" width="8" height="3.5"/>' + rdot),
  4: pic('<path d="M3 9h14" stroke-width="1.4"/><rect x="6" y="9" width="8" height="3.5"/>') };
const MODE_NOTE = pic(head(1) + stem), MODE_REST = REST_PICS[1];
const OCT_UP = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11l5-5 5 5M12 6v13" fill="none" stroke-width="1.8"/><text x="19" y="22" font-size="9" font-weight="700" stroke="none">8</text></svg>`;
const OCT_DOWN = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 13l5 5 5-5M12 18V5" fill="none" stroke-width="1.8"/><text x="19" y="9" font-size="9" font-weight="700" stroke="none">8</text></svg>`;
const TRIP_PIC = `<svg class="notepic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V5h18v4" fill="none" stroke-width="1.4"/><text x="12" y="20" text-anchor="middle" font-size="12" font-weight="700" stroke="none">3</text></svg>`;
const LENGTHS = [[0.25, '16th note', '2'], [0.5, 'Eighth note', '3'], [0.75, 'Dotted eighth', ''], [1, 'Quarter note', '4'], [1.5, 'Dotted quarter (¼ + ⅛)', ''], [2, 'Half note', '5'], [3, 'Dotted half', ''], [4, 'Whole note', '6']];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function scoreEditor(view, it, host, btn) {
  if (host.querySelector('.editbar')) { host.querySelector('.editbar').dispatchEvent(new Event('close')); return; }
  if (!view.editable) return toast('This version has no melody to edit.');
  btn.classList.add('on');
  // sample scores edit their bars; real scores edit their MusicXML (upper staff)
  const model = view.real ? new XmlModel(view.xml()) : new TuneModel(view.tune);
  window.__editModel = model; // for automated tests
  let bi = 0, ni = 0;
  const undo = [];
  const panel = document.createElement('div');
  panel.className = 'editbar';
  host.append(panel);
  const paper = host.querySelector('#paper');
  paper.classList.add('editing');
  const draw = () => {
    ni = Math.max(0, Math.min(ni, model.count(bi) - 1));
    const n = model.get(bi, ni);
    const trip = isTriplet(n[1]);
    const base = trip ? n[1] * 1.5 : n[1]; // length button to light up (a triplet lights its plain note)
    const rest = n[0] === 'r';
    const pics = rest ? REST_PICS : NOTE_PICS;
    // one line: [note] · note/rest · lengths · triplet · + · Delete · undo · reset · done
    panel.innerHTML = `
      <div class="eb-row one">
        <input id="eb-pitch" class="eb-pitch" value="${rest ? '' : n[0]}" placeholder="${rest ? 'rest' : 'C4'}" aria-label="Note (e.g. C4, F#5, Bb)" title="Type a note: C, D#, Eb5… then Enter">
        <button class="eb-mode" data-a="rest" title="${rest ? 'Rest — click for note' : 'Note — click for rest'} (R)" aria-label="${rest ? 'Rest' : 'Note'}">${rest ? MODE_REST : MODE_NOTE}</button>
        <div class="stepper eb-len">${LENGTHS.map(([d, l, k]) => `<button data-len="${d}" class="${base === d ? 'on' : ''}" title="${rest ? l.replace('note', 'rest') : l}${k ? ` (${k})` : ''}" aria-label="${l}">${pics[d]}</button>`).join('')}<button data-a="trip" class="${trip ? 'on' : ''}" title="Triplet (T)" aria-label="Triplet">${TRIP_PIC}</button></div>
        <button class="icon-btn" data-a="add" title="Add a note after this one (N)" aria-label="Add note">${iconOn('plus')}</button>
        <button class="danger-text" data-a="del" ${model.count(bi) > 1 ? '' : 'disabled'} title="Delete note (⌫)">Delete</button>
        <span class="grow"></span>
        <button class="icon-btn" data-a="undo" ${undo.length ? '' : 'disabled'} title="Undo (⌘Z)" aria-label="Undo">${iconOn('undo')}</button>
        <button class="icon-btn" data-a="reset" title="Reset to the original notes" aria-label="Reset">${iconOn('restore')}</button>
        <button class="icon-btn eb-done" data-a="done" title="Done" aria-label="Done">${iconOn('check')}</button>
      </div>`;
    view.pickNote(bi, ni);
  };
  const save = async () => { if (view.real) await view.setXml(model.toString()); else await view.setMeasures(structuredClone(model.ms)); draw(); };
  const edit = async (fn) => { undo.push(model.snapshot()); fn(); await save(); };
  const step = (d) => { // next / previous note across bars
    ni += d;
    if (ni < 0 && bi > 0) { bi--; ni = model.count(bi) - 1; }
    else if (ni >= model.count(bi) && bi < model.bars() - 1) { bi++; ni = 0; }
    draw();
  };
  const nearest = (pc, ref) => { let v = null; for (let o = 2; o <= 7; o++) { const c = 12 * (o + 1) + pc; if (v === null || Math.abs(c - ref) < Math.abs(v - ref)) v = c; } return v; };
  const refOf = () => { const p = model.get(bi, ni)[0]; return p === 'r' ? 72 : midiOf(p); };
  const act = async (a, arg) => {
    if (a === 'up' || a === 'down') { const p = model.get(bi, ni)[0]; if (p !== 'r') await edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, midiOf(p) + (a === 'up' ? 1 : -1)))))); }
    if (a === 'o+' || a === 'o-') { const p = model.get(bi, ni)[0]; if (p !== 'r') await edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, midiOf(p) + (a === 'o+' ? 12 : -12)))))); }
    if (a === 'len') await edit(() => model.setLen(bi, ni, arg));
    if (a === 'dot') {
      const d = model.get(bi, ni)[1], t = twelfths(d);
      if (isTriplet(d) || t === 3) return toast('A triplet or 1/16 note can’t be dotted here.');
      await edit(() => model.setLen(bi, ni, [9, 18, 36].includes(t) ? d / 1.5 : d * 1.5));
    }
    if (a === 'trip') {
      const d = model.get(bi, ni)[1];
      if (!isTriplet(d) && !isTriplet(d / 3)) return toast('Pick a ⅛, ¼ or ½ note to make a triplet.');
      let g = ni;
      await edit(() => { g = model.triplet(bi, ni) ?? ni; });
      ni = g; draw();
    }
    if (a === 'rest') await edit(() => model.toggleRest(bi, ni));
    if (a === 'add') { await edit(() => model.add(bi, ni)); step(1); }
    if (a === 'del') await edit(() => model.del(bi, ni));
    if (a === 'letter') await edit(() => model.setPitch(bi, ni, nameOf(nearest(LETTER[arg], refOf()))));
    if (a === 'undo' && undo.length) { model.restore(undo.pop()); await save(); }
    if (a === 'reset') { undo.push(model.snapshot()); await view.revert(); model.restore(view.real ? view.xml() : view.tune.measures && new TuneModel(view.tune).snapshot()); draw(); } // undo brings the edits back
    if (a === 'done') close();
  };
  panel.onclick = (e) => {
    const lb = e.target.closest('[data-len]');
    if (lb) return act('len', +lb.dataset.len);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) act(a);
  };
  // type a note: "C", "c#", "Eb5" … a letter without octave goes to the nearest one
  const setPitch = (txt) => {
    const mm = String(txt).trim().match(/^([a-gA-G])([#b♯♭]?)(\d)?$/);
    if (!mm) { toast('Type a note like C4, F#5 or Bb'); draw(); return; }
    const pc = (LETTER[mm[1].toUpperCase()] + (/[#♯]/.test(mm[2]) ? 1 : /[b♭]/.test(mm[2]) ? -1 : 0) + 12) % 12;
    const v = mm[3] ? 12 * (+mm[3] + 1) + pc : nearest(pc, refOf());
    edit(() => model.setPitch(bi, ni, nameOf(Math.max(36, Math.min(96, v)))));
  };
  panel.addEventListener('keydown', (e) => { if (e.target.id === 'eb-pitch') { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); setPitch(e.target.value); } if (e.key === 'Escape') { e.target.blur(); draw(); } } });
  panel.onchange = (e) => { if (e.target.id === 'eb-pitch') setPitch(e.target.value); };
  const pick = (e) => { const g = e.target.closest('g[data-note]'); if (g) { bi = +g.dataset.bar; ni = +g.dataset.note; draw(); } };
  paper.addEventListener('click', pick);
  const keys = (e) => {
    if (e.target.closest('input,textarea,select')) return;
    const k = e.key, cmd = e.metaKey || e.ctrlKey;
    const map = { ArrowUp: cmd ? 'o+' : 'up', ArrowDown: cmd ? 'o-' : 'down', '.': 'dot', t: 'trip', T: 'trip', r: 'rest', R: 'rest', n: 'add', N: 'add', Backspace: 'del', Delete: 'del' };
    if (cmd && (k === 'z' || k === 'Z')) { e.preventDefault(); return act('undo'); }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); return step(k === 'ArrowRight' ? 1 : -1); }
    if (map[k]) { e.preventDefault(); e.stopImmediatePropagation(); return act(map[k]); }
    const len = k.length === 1 && LENGTHS.find((l) => l[2] === k);
    if (len && !cmd) { e.preventDefault(); e.stopImmediatePropagation(); return act('len', len[0]); }
    if (/^[a-gA-G]$/.test(k) && !cmd) { e.preventDefault(); return act('letter', k.toUpperCase()); }
    if (k === 'Escape') close();
  };
  document.addEventListener('keydown', keys, true);
  function close() {
    panel.remove(); view.pickNote(-1); btn.classList.remove('on'); paper.classList.remove('editing');
    paper.removeEventListener('click', pick); document.removeEventListener('keydown', keys, true);
  }
  panel.addEventListener('close', close);
  draw();
}
