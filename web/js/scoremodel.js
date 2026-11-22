// Two ways to hold a score's notes for the editor, with the same small API:
//  - TuneModel: the sample scores (bars of [pitch, beats] that musicxml.js turns into MusicXML)
//  - XmlModel:  a real score's MusicXML, edited in place (first part, upper staff)
// API: bars() · count(bi) · get(bi, ni) → [name | 'r', beats] · setPitch · setLen · toggleRest · add · del ·
//      triplet · beats(bi) · meter · toString() / data()
import { midiOf, nameOf, isTriplet, twelfths, meterOf } from './musicxml.js';

// ---------- sample scores ----------
export class TuneModel {
  constructor(tune) { this.tune = tune; this.ms = structuredClone(tune.measures); this.meter = tune.beats; }
  bars() { return this.ms.length; }
  count(bi) { return this.ms[bi].mel.length; }
  get(bi, ni) { return this.ms[bi].mel[ni]; }
  setPitch(bi, ni, name) { this.ms[bi].mel[ni][0] = name; }
  setLen(bi, ni, q) { this.ms[bi].mel[ni][1] = q; }
  toggleRest(bi, ni) { const n = this.ms[bi].mel[ni]; n[0] = n[0] === 'r' ? 'C5' : 'r'; }
  add(bi, ni) { const [p, d] = this.ms[bi].mel[ni]; this.ms[bi].mel.splice(ni + 1, 0, [p === 'r' ? 'C5' : p, d]); }
  del(bi, ni) { if (this.count(bi) > 1) this.ms[bi].mel.splice(ni, 1); }
  triplet(bi, ni) {
    const mel = this.ms[bi].mel, d = mel[ni][1];
    if (!isTriplet(d)) { mel.splice(ni, 1, [mel[ni][0], d / 3], [mel[ni][0], d / 3], [mel[ni][0], d / 3]); return ni; }
    let s = ni; while (s > 0 && isTriplet(mel[s - 1][1])) s--;
    const g = s + Math.floor((ni - s) / 3) * 3, grp = mel.slice(g, g + 3);
    mel.splice(g, grp.length, [grp[0][0], Math.round(grp.reduce((a, [, x]) => a + x, 0) * 12) / 12]);
    return g;
  }
  beats(bi) { return Math.round(this.ms[bi].mel.reduce((s, [, d]) => s + d, 0) * 12) / 12; }
  snapshot() { return structuredClone(this.ms); }
  restore(s) { this.ms = structuredClone(s); }
}

// ---------- real scores (MusicXML) ----------
const TYPE_OF = { 48: ['whole', 0], 36: ['half', 1], 24: ['half', 0], 18: ['quarter', 1], 12: ['quarter', 0], 9: ['eighth', 1], 6: ['eighth', 0], 3: ['16th', 0],
  16: ['half', 0, 1], 8: ['quarter', 0, 1], 4: ['eighth', 0, 1], 2: ['16th', 0, 1] };
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export class XmlModel {
  constructor(text) { this.load(text); }
  load(text) {
    this.doc = new DOMParser().parseFromString(text, 'application/xml');
    this.part = this.doc.querySelector('part');
    this.measures = [...this.part.querySelectorAll(':scope > measure')];
    this.normalizeDivisions();
    const b = this.part.querySelector('time > beats'), bt = this.part.querySelector('time > beat-type');
    this.meter = b ? (+b.textContent * 4) / (+bt?.textContent || 4) : 4;
  }
  // make every duration a whole number of twelfths of a beat (room for 16ths and triplets)
  normalizeDivisions() {
    const divEl = this.part.querySelector('divisions');
    this.div = +(divEl?.textContent || 1);
    const target = (this.div * 12) / gcd(this.div, 12);
    if (target === this.div) return;
    const k = target / this.div;
    for (const d of this.part.querySelectorAll('duration')) d.textContent = String(Math.round(+d.textContent * k));
    for (const d of this.part.querySelectorAll('divisions')) d.textContent = String(+d.textContent * k);
    this.div = target;
  }
  el(tag, text) { const e = this.doc.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
  staffOf(n) { return n.querySelector('staff')?.textContent || '1'; }
  // walk a bar with one time cursor per voice (works whether or not the file uses <backup>);
  // calls fn(note, start, staff) for every real note and returns each voice's end time
  walk(bi, fn) {
    const cur = {}, last = {};
    let lastVoice = '1';
    for (const e of this.measures[bi].children) {
      if (e.tagName === 'forward') { const v = e.querySelector('voice')?.textContent || lastVoice; cur[v] = (cur[v] || 0) + +e.querySelector('duration').textContent; }
      else if (e.tagName === 'note') {
        if (e.querySelector('grace')) continue;
        const v = (this.staffOf(e)) + ':' + (e.querySelector('voice')?.textContent || '1');
        lastVoice = e.querySelector('voice')?.textContent || lastVoice;
        const d = +(e.querySelector('duration')?.textContent || 0), chord = !!e.querySelector('chord');
        const start = chord ? (last[v] ?? 0) : (cur[v] || 0);
        fn(e, start, this.staffOf(e));
        if (!chord) { last[v] = cur[v] || 0; cur[v] = (cur[v] || 0) + d; }
      }
    }
    return cur;
  }
  // upper-staff notes of a bar, grouped by when they start (a chord or two voices at once = one group)
  groups(bi) {
    const out = [];
    this.walk(bi, (e, start, staff) => {
      if (staff !== '1') return;
      const g = out.find((x) => x.start === start);
      if (g) g.notes.push(e); else out.push({ start, notes: [e] });
    });
    return out.sort((a, b) => a.start - b.start);
  }
  bars() { return this.measures.length; }
  count(bi) { return this.groups(bi).length; }
  main(bi, ni) { return this.groups(bi)[ni]?.notes[0]; }
  nameOfNote(n) {
    if (n.querySelector('rest')) return 'r';
    const p = n.querySelector('pitch');
    return nameOf(12 * (+p.querySelector('octave').textContent + 1) + PC[p.querySelector('step').textContent] + +(p.querySelector('alter')?.textContent || 0));
  }
  get(bi, ni) { const n = this.main(bi, ni); return n ? [this.nameOfNote(n), +n.querySelector('duration').textContent / this.div] : ['r', 1]; }
  writePitch(n, name) {
    const m = name.match(/^([A-G])([#b]?)(\d)$/);
    n.querySelector('rest')?.remove();
    let p = n.querySelector('pitch');
    if (!p) { p = this.el('pitch'); n.insertBefore(p, n.querySelector('duration')); }
    p.textContent = '';
    p.append(this.el('step', m[1]));
    if (m[2]) p.append(this.el('alter', m[2] === '#' ? '1' : '-1'));
    p.append(this.el('octave', m[3]));
    n.querySelector('accidental')?.remove();
  }
  setPitch(bi, ni, name) { this.writePitch(this.main(bi, ni), name); this.fix(bi); }
  writeLen(n, q) {
    const t = twelfths(q), [type, dot, trip] = TYPE_OF[t] || ['quarter', 0];
    n.querySelector('duration').textContent = String(Math.round((q * this.div)));
    n.querySelectorAll('dot, time-modification').forEach((e) => e.remove());
    let ty = n.querySelector('type');
    if (!ty) { ty = this.el('type'); n.insertBefore(ty, n.querySelector('stem, notations, lyric') || null); }
    ty.textContent = type;
    if (dot) ty.after(this.el('dot'));
    if (trip) { const tm = this.el('time-modification'); tm.append(this.el('actual-notes', '3'), this.el('normal-notes', '2')); (n.querySelector('dot') || ty).after(tm); }
    n.querySelectorAll('tie, notations > tied').forEach((e) => e.remove()); // a changed length breaks old ties
  }
  setLen(bi, ni, q) { for (const n of this.groups(bi)[ni].notes) this.writeLen(n, q); this.fix(bi); }
  toggleRest(bi, ni) {
    const g = this.groups(bi)[ni], n = g.notes[0];
    if (n.querySelector('rest')) this.writePitch(n, 'C5');
    else { g.notes.slice(1).forEach((e) => e.remove()); n.querySelector('pitch').replaceWith(this.el('rest')); n.querySelectorAll('stem, beam, accidental, notations, lyric').forEach((e) => e.remove()); }
    this.fix(bi);
  }
  add(bi, ni) {
    const g = this.groups(bi)[ni], copy = g.notes[0].cloneNode(true);
    copy.querySelector('chord')?.remove();
    copy.querySelectorAll('beam, notations, lyric').forEach((e) => e.remove());
    if (copy.querySelector('rest')) this.writePitch(copy, 'C5');
    g.notes[g.notes.length - 1].after(copy);
    this.fix(bi);
  }
  del(bi, ni) { if (this.count(bi) <= 1) return; this.groups(bi)[ni].notes.forEach((e) => e.remove()); this.fix(bi); }
  triplet(bi, ni) {
    const [, d] = this.get(bi, ni);
    if (!isTriplet(d)) {
      if (!TYPE_OF[twelfths(d / 3)]?.[2]) return null;
      const g = this.groups(bi)[ni];
      g.notes.slice(1).forEach((e) => e.remove());
      const n = g.notes[0];
      this.writeLen(n, d / 3);
      const a = n.cloneNode(true), b = n.cloneNode(true);
      [a, b].forEach((x) => x.querySelectorAll('lyric').forEach((e) => e.remove()));
      n.after(a); a.after(b);
      const tup = (x, type) => { let no = x.querySelector('notations'); if (!no) { no = this.el('notations'); x.append(no); } const t = this.el('tuplet'); t.setAttribute('type', type); t.setAttribute('bracket', 'yes'); no.append(t); };
      tup(n, 'start'); tup(b, 'stop');
      this.fix(bi);
      return ni;
    }
    let s = ni; while (s > 0 && isTriplet(this.get(bi, s - 1)[1])) s--;
    const g0 = s + Math.floor((ni - s) / 3) * 3;
    const grp = [0, 1, 2].map((k) => this.groups(bi)[g0 + k]).filter(Boolean);
    const total = grp.reduce((acc, g) => acc + +g.notes[0].querySelector('duration').textContent, 0) / this.div;
    grp.slice(1).forEach((g) => g.notes.forEach((e) => e.remove()));
    grp[0].notes.slice(1).forEach((e) => e.remove());
    this.writeLen(grp[0].notes[0], Math.round(total * 12) / 12);
    grp[0].notes[0].querySelectorAll('notations > tuplet').forEach((e) => e.remove());
    this.fix(bi);
    return g0;
  }
  // length of the bar's longest voice, in beats
  beats(bi) {
    const ends = Object.values(this.walk(bi, () => {}));
    return Math.round(((ends.length ? Math.max(...ends) : 0) / this.div) * 12) / 12;
  }
  // a bar that no longer fits gets its own time signature; the next bar goes back to the song's meter
  fix(bi) {
    const m = this.measures[bi], b = this.beats(bi);
    const setTime = (meas, beats) => {
      let at = meas.querySelector(':scope > attributes');
      if (!at) { at = this.el('attributes'); meas.prepend(at); }
      at.querySelector('time')?.remove();
      const [n, t] = meterOf(beats), time = this.el('time');
      time.append(this.el('beats', String(n)), this.el('beat-type', String(t)));
      const before = at.querySelector('staves, part-symbol, instruments, clef, staff-details, transpose, directive, measure-style');
      at.insertBefore(time, before || null);
    };
    const prevMeter = (i) => { for (let k = i - 1; k >= 0; k--) { const tm = this.measures[k].querySelector(':scope > attributes > time'); if (tm) return (+tm.querySelector('beats').textContent * 4) / +tm.querySelector('beat-type').textContent; } return this.meter; };
    if (b !== prevMeter(bi) || m.querySelector(':scope > attributes > time')) setTime(m, b);
    const next = this.measures[bi + 1];
    if (next && !next.querySelector(':scope > attributes > time') && b !== this.meter) setTime(next, this.meter);
  }
  toString() { return new XMLSerializer().serializeToString(this.doc); }
  snapshot() { return this.toString(); }
  restore(s) { this.load(s); }
}
