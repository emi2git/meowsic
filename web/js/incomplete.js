import { sheet as modal } from './ui.js';

// the fixes for a bar that is not complete → 'fill' | 'time' | null (Keep editing / closed)
export function barFixSheet(b) {
  return new Promise((done) => {
    let picked = null;
    const s = modal(`<h2>Bar ${b.bar} is not complete</h2>
      <p class="muted">It has ${b.words}${b.over ? ': more than its time signature' : ''}. ${b.over ? '' : '“Fill with rest” adds rests to its end. '}“Change time for this bar” gives only this bar a time signature of its own length; the bar after it goes back to the time before.</p>
      <div class="modal-actions ib-fix"><button data-close data-k="keep">Keep editing</button><button data-k="time">Change time for this bar</button>${b.over ? '' : '<button class="primary" data-k="fill">Fill with rest</button>'}</div>`,
    { onClose: () => done(picked) });
    s.el.querySelectorAll('[data-k]').forEach((x) => x.addEventListener('click', () => { picked = x.dataset.k === 'keep' ? null : x.dataset.k; s.close(); }));
  });
}
export const fixBarOp = (b, how) => ({ op: how === 'fill' ? 'fillbar' : 'bartime', bar: b.bar - 1 });

// Bars that are not complete: a voice shorter (or longer) than the bar's time signature, as staffmove.incomplete_bars
// works it out on the Mac (the same rules, so it shows on load and offline too). The part looked at is the one Edit
// notes edits (the first with two staves, else the first). A short first bar (a pickup) and bars marked implicit
// are not counted. → [{ bar (1-based), have, need (quarters), over, words: '2 of 4 beats' }]
export function incompleteBars(xml) {
  if (!xml || !/<measure\b/.test(xml)) return [];
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return []; }
  if (doc.querySelector('parsererror')) return [];
  const parts = [...doc.getElementsByTagName('part')];
  const part = parts.find((p) => [...p.getElementsByTagName('staves')].some((s) => s.textContent.trim() === '2')) || parts[0];
  if (!part) return [];
  const kid = (e, t) => [...e.children].find((c) => c.tagName === t);
  const num = (e, t) => +(kid(e, t)?.textContent || 0);
  const out = [];
  let div = 1, beats = 4, bt = 4;
  [...part.children].filter((m) => m.tagName === 'measure').forEach((m, bi) => {
    for (const a of [...m.children].filter((c) => c.tagName === 'attributes')) {
      if (kid(a, 'divisions')) div = num(a, 'divisions') || div;
      const tm = kid(a, 'time');
      if (tm && /^\d+$/.test(kid(tm, 'beats')?.textContent.trim() || '')) { beats = num(tm, 'beats'); bt = num(tm, 'beat-type') || 4; }
    }
    if (m.getAttribute('implicit') === 'yes') return;
    let t = 0;
    const ends = {};
    for (const e of m.children) {
      if (e.tagName === 'backup') t -= num(e, 'duration');
      else if (e.tagName === 'forward') t += num(e, 'duration');
      else if (e.tagName === 'note') {
        if (kid(e, 'grace')) continue;
        if (kid(e, 'chord')) continue;
        t += num(e, 'duration');
        const k = `${kid(e, 'staff')?.textContent.trim() || '1'}/${kid(e, 'voice')?.textContent.trim() || '1'}`;
        ends[k] = Math.max(ends[k] || 0, t);
      }
    }
    const es = Object.values(ends).map((x) => x / div);
    if (!es.length) return;
    const L = (4 * beats) / bt, over = Math.max(...es), short = Math.min(...es);
    let have = null;
    if (over > L + 1e-9) have = over;
    else if (short < L - 1e-9 && !(bi === 0 && over < L - 1e-9)) have = short;
    if (have == null) return;
    const unit = 4 / bt;
    out.push({ bar: bi + 1, have, need: L, over: have > L, words: `${Math.round((have / unit) * 1000) / 1000} of ${beats} beats` });
  });
  return out;
}
