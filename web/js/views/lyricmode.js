// Edit notes → Lyrics (the Notes | Lyrics switch in the edit bar; Check bars' "Fix lyrics" opens it on a verse and bar):
// put words under the notes of the real score. Pick a note (either staff; the top note of a chord carries the words)
// and type its syllable in the box of the lyrics bar; it shows at once under the note:
//   Enter / Tab  next note · Shift-Tab  the one before · "-"  the word goes on (begin / middle) and on to the next
//   note · space  the word ends, next note · "_" or Hold  melisma: the syllable before goes on over this note ·
//   Backspace in an empty box  takes the syllable off and goes back.
// "Paste text…" (or the Lyrics text panel's "Use from selected note") lays a phrase or verse out one syllable per
// note from the picked note (syllables.js: English hyphenation, Vietnamese one per word); rests and tied notes are
// skipped. Verses 1, 2, … (+ adds one): the verse picked is edited, the others are drawn faded. ◀ Shift / Shift ▶
// move this syllable and every one after it a note earlier / later; Skip (no syllable here, the rest moves on);
// Clear from here.
// Every change is a step of Edit notes ({op: 'lyrics', staff, verse, notes}: server lyricsedit.set_lyrics) — so
// undo / redo, ▶ From here, the pages and Save (into this score: .history + Activities undo, or a new version) work
// as for notes, and notes and words changed in one session save together. Typing shows at once (drawn over the
// score) and is sent when the note is left, or after a short pause.
import { esc, toast, sheet as modal } from '../ui.js';
import { isTouch } from '../device.js';
import { syllabify } from '../syllables.js';
import { lyricsPanel } from './lyricspanel.js';

const LANG_KEY = 'meowsic-fitlyrics-lang';
const S = (text, hy = false) => ({ t: 's', text, hy }), H = () => ({ t: 'h' }), K = () => ({ t: 'k' });
const isS = (x) => x?.t === 's';
const SVGNS = 'http://www.w3.org/2000/svg';

// ctx (from editnotes.js): { view, host, panel, paper, base, opts, cur(), sel(), select(refs), run(op), busy(),
//   save(), draw(), close() }
export function lyricMode(ctx) {
  const { view, host, panel, paper } = ctx;
  let on = false, first = true, staff = 1, verse = '1', at = -1, lastSel = '', typed = false, timer = 0, flushing = null, nudge = 0, closed = false;
  let lang = (() => { try { return localStorage.getItem(LANG_KEY) || 'auto'; } catch { return 'auto'; } })();
  const added = new Set();
  const work = new Map(); // `${staff}|${verse}` -> { toks, ver, done }: words changed here, not yet a step

  // ---- the score as the current step has it: melody line per staff, words per note and verse ----
  let parsed = null;
  const doc = () => {
    const xml = ctx.cur().xml;
    if (parsed?.xml === xml) return parsed;
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    const part = d.getElementsByTagName('part')[ctx.base.part] || d.getElementsByTagName('part')[0];
    const els = part ? [...part.getElementsByTagName('note')] : [];
    const verses = new Set();
    for (const e of els) for (const ly of e.getElementsByTagName('lyric')) verses.add((ly.getAttribute('number') || '1').trim());
    parsed = { xml, els, verses, lines: {} };
    return parsed;
  };
  // the notes that carry words on a staff: the top note of each onset, no tied continuations, no rests
  const line = (s = staff) => {
    const p = doc();
    if (p.lines[s]) return p.lines[s];
    const top = new Map();
    for (const n of ctx.cur().notes) {
      if (n.rest || n.staff !== s) continue;
      const k = `${n.bar}|${Math.round(n.on * 1000)}`;
      if (!top.has(k) || (n.midi ?? 0) > (top.get(k).midi ?? 0)) top.set(k, n);
    }
    const tiedIn = (n) => [...(p.els[n.ref]?.children || [])].some((c) => c.tagName === 'tie' && c.getAttribute('type') === 'stop');
    return (p.lines[s] = [...top.values()].filter((n) => !tiedIn(n)).sort((a, b) => a.bar - b.bar || a.on - b.on));
  };
  const lyricOf = (ref, v) => {
    const e = doc().els[ref];
    for (const ly of e?.children || []) {
      if (ly.tagName !== 'lyric' || (ly.getAttribute('number') || '1').trim() !== v) continue;
      const text = [...ly.getElementsByTagName('text')].map((t) => t.textContent).join('').trim();
      const syl = ly.getElementsByTagName('syllabic')[0]?.textContent.trim() || 'single';
      return { text, hy: syl === 'begin' || syl === 'middle', ext: ly.getElementsByTagName('extend').length > 0 };
    }
    return null;
  };
  // the words of the score -> tokens, one per note of the line: s (a syllable), h (hold: the one before goes on), k (none)
  const fromScore = (s, v) => {
    let open = false;
    return line(s).map((n) => {
      const ly = lyricOf(n.ref, v);
      if (ly?.text) { open = ly.ext; return S(ly.text, ly.hy); }
      if (ly?.ext || open) return H();
      return K();
    });
  };
  const key = (s = staff, v = verse) => `${s}|${v}`;
  const toks = () => {
    let w = work.get(key());
    if (!w) { w = { toks: fromScore(staff, verse), ver: 0, done: 0 }; work.set(key(), w); }
    return w.toks;
  };
  const tok = (k) => toks()[k] || K();
  const pad = (k) => { const T = toks(); while (T.length <= k) T.push(K()); };
  const changed = (later = 900) => {
    const w = work.get(key());
    w.ver++;
    overlay();
    clearTimeout(timer);
    timer = setTimeout(() => flush(), later);
  };
  // tokens -> the op: syllabic from the hyphens, extend when the next note holds
  const opOf = (s, v, T) => {
    const L = line(s), notes = [];
    const idx = T.map((t, i) => (isS(t) && i < L.length ? i : -1)).filter((i) => i >= 0);
    idx.forEach((i, j) => {
      const t = T[i], prev = T[idx[j - 1]], start = !prev || !prev.hy, end = !t.hy || j === idx.length - 1;
      notes.push({ ref: L[i].ref, text: t.text.trim(), syllabic: start ? (end ? 'single' : 'begin') : end ? 'end' : 'middle', ...(T[i + 1]?.t === 'h' ? { extend: true } : {}) });
    });
    return { op: 'lyrics', staff: s, verse: +v, notes: notes.filter((n) => n.text) };
  };
  const same = (a, b) => JSON.stringify(a.notes) === JSON.stringify(b.notes);

  // ---- sending: every change becomes one Edit-notes step (one at a time; typing goes on meanwhile) ----
  const flush = () => {
    clearTimeout(timer);
    if (flushing) return flushing.then(() => (pending() ? flush() : undefined));
    if (!pending()) return Promise.resolve();
    flushing = (async () => {
      for (;;) {
        const k = [...work.keys()].find((x) => work.get(x).ver !== work.get(x).done);
        if (!k) break;
        while (ctx.busy()) await new Promise((r) => setTimeout(r, 50));
        const w = work.get(k), v = w.ver, [s, vv] = k.split('|');
        const op = opOf(+s, vv, w.toks);
        if (!same(op, opOf(+s, vv, fromScore(+s, vv)))) await ctx.run(op);
        w.done = v;
      }
    })().finally(() => { flushing = null; });
    return flushing;
  };
  const pending = () => [...work.values()].some((w) => w.ver !== w.done);
  // a new step drawn (an edit, undo / redo): words not changed since come from the score again
  const fresh = () => { for (const [k, w] of work) if (w.ver === w.done) work.delete(k); };

  // ---- the drawn words: other verses faded, the note being typed and changed words drawn over the score ----
  let labels = new Map(); // `${ref}|${verse}` -> the drawn <text> (OSMD), plus every lyric node
  const readLabels = () => {
    labels = new Map();
    const osmd = view.osmd, inst = osmd?.Sheet?.Instruments?.[ctx.base.part];
    if (!inst) return;
    osmd.GraphicSheet.MeasureList.forEach((gms) => {
      for (const gm of gms || []) {
        if (!gm || inst.Staves.indexOf(gm.ParentStaff) < 0) continue;
        for (const se of gm.staffEntries || []) {
          for (const gle of se.LyricsEntries || []) {
            const node = gle.GraphicalLabel?.SVGNode, le = gle.LyricsEntry;
            if (!node || !le) continue;
            const v = String(le.VerseNumber ?? 1);
            node.dataset.verse = v;
            const gve = (se.graphicalVoiceEntries || []).find((g) => g.parentVoiceEntry === le.Parent);
            for (const gn of gve?.notes || []) {
              const g = gn.getSVGGElement?.();
              const refs = g ? [g, ...g.querySelectorAll('[data-ref]')].map((x) => x.dataset?.ref).filter((r) => r != null) : [];
              for (const r of refs) labels.set(`${r}|${v}`, node);
            }
          }
        }
      }
    });
  };
  const fade = () => paper.querySelectorAll('svg .lyrics').forEach((n) => n.classList.toggle('ly-other', on && n.dataset.verse != null && n.dataset.verse !== verse));
  const head = (ref) => paper.querySelector(`[data-ref="${ref}"]`);
  const overlay = () => {
    paper.querySelectorAll('.ly-live').forEach((x) => x.remove());
    paper.querySelectorAll('.ly-hidden').forEach((x) => x.classList.remove('ly-hidden'));
    if (!on) return;
    const L = line(), T = toks(), base = fromScore(staff, verse);
    const show = new Set();
    L.forEach((n, i) => { if (JSON.stringify(T[i] || K()) !== JSON.stringify(base[i] || K())) show.add(i); });
    if (at >= 0) show.add(at);
    for (const i of show) {
      const n = L[i], el = n && head(n.ref);
      const svg = el?.ownerSVGElement;
      if (!svg) continue;
      const lab = labels.get(`${n.ref}|${verse}`);
      const hb = el.getBBox();
      let y, size = 18;
      const any = paper.querySelector('svg .lyrics');
      if (any) size = parseFloat(any.getAttribute('font-size')) || size;
      if (lab && lab.ownerSVGElement === svg) { const b = lab.getBBox(); y = b.y + b.height * 0.78; lab.classList.add('ly-hidden'); }
      else {
        // no words drawn there yet: under the staff (as OSMD puts them), one row per verse
        const gn = staffBottom(n.ref);
        y = (gn ?? hb.y + hb.height + 30) + size * 1.6 + (Math.max(1, +verse) - 1) * size * 1.25;
      }
      const t = T[i] || K();
      const txt = isS(t) ? t.text + (t.hy ? ' -' : '') : t.t === 'h' ? '__' : '';
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', `ly-live${i === at ? ' ly-cur' : ''}`);
      const x = hb.x + hb.width / 2;
      const text = document.createElementNS(SVGNS, 'text');
      Object.entries({ x, y, 'text-anchor': 'middle', 'font-size': size }).forEach(([a, b]) => text.setAttribute(a, b));
      text.textContent = txt || ' ';
      g.append(text);
      svg.append(g);
      if (i === at) {
        const tb = text.getBBox(), w = Math.max(tb.width + 10, size * 1.6), r = document.createElementNS(SVGNS, 'rect');
        Object.entries({ x: x - w / 2, y: y - size * 0.95, width: w, height: size * 1.3, rx: 4 }).forEach(([a, b]) => r.setAttribute(a, b));
        g.insertBefore(r, text);
      }
    }
  };
  const bottoms = new Map();
  const staffBottom = (ref) => bottoms.get(+ref);
  const readStaves = () => {
    bottoms.clear();
    const osmd = view.osmd, inst = osmd?.Sheet?.Instruments?.[ctx.base.part];
    if (!inst) return;
    osmd.GraphicSheet.MeasureList.forEach((gms) => {
      for (const gm of gms || []) {
        if (!gm || inst.Staves.indexOf(gm.ParentStaff) < 0) continue;
        const st = gm.getVFStave?.();
        const y = st?.getBottomLineY?.() ?? st?.getYForLine?.(4);
        if (y == null) continue;
        for (const se of gm.staffEntries || []) for (const gve of se.graphicalVoiceEntries || []) for (const gn of gve.notes || []) {
          const g = gn.getSVGGElement?.();
          if (g) for (const x of [g, ...g.querySelectorAll('[data-ref]')]) if (x.dataset?.ref != null) bottoms.set(+x.dataset.ref, y);
        }
      }
    });
  };
  const onDrawn = () => {
    if (closed) return;
    fresh();
    readLabels(); readStaves();
    if (on && !typed) fill(false);
    if (on) drawBar();
    fade(); overlay();
  };
  host.addEventListener('scoredrawn', onDrawn);

  // ---- the lyrics bar (stays put while the rest of the panel draws again: typing keeps its focus) ----
  const bar = document.createElement('div');
  bar.className = 'ly-bar';
  bar.innerHTML = `<div class="ly-row ly-top">
      <span class="seg small ly-verse" role="radiogroup" aria-label="Verse"></span>
      <span class="ly-where muted" id="ly-where"></span>
      <span class="grow"></span>
      <button data-ly="paste" title="Paste or type a line or verse: one syllable per note from the picked note">Paste text…</button>
      <button class="primary" data-ly="save">Save…</button>
    </div>
    <div class="ly-row ly-type">
      <button class="ly-step" data-ly="prev" title="The note before (Shift-Tab)" aria-label="The note before">‹</button>
      <input id="ly-text" class="ly-text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" placeholder="Syllable" aria-label="Syllable for the picked note">
      <button class="ly-step" data-ly="next" title="Next note (Enter / Tab)" aria-label="Next note">›</button>
      <button data-ly="hyphen" title="The word goes on: a hyphen, then the next note (-)">-</button>
      <button data-ly="hold" title="Hold (_): the syllable before goes on over this note">_ Hold</button>
    </div>
    <div class="ly-row ly-tools">
      <button data-ly="left" title="Move this syllable and all after it one note earlier">◀ Shift</button>
      <button data-ly="right" title="Move this syllable and all after it one note later">Shift ▶</button>
      <button data-ly="skip" title="No syllable on this note; the rest moves on">Skip note</button>
      <button data-ly="clear" class="danger-text" title="Take the words of this verse off from this note on">Clear from here</button>
    </div>
    ${isTouch() ? '' : '<p class="muted ly-help">Click a note, type its syllable: “-” the word goes on, space a new word, Enter / Tab next note, Shift-Tab back, “_” hold, Backspace in an empty box takes it off.</p>'}`;
  const input = bar.querySelector('#ly-text');
  const L = () => line();
  const where = () => {
    const n = L()[at];
    const w = bar.querySelector('#ly-where');
    if (w) w.textContent = n ? `Bar ${n.bar + 1} · ${ctx.base.hands ? (staff === 1 ? 'right hand' : 'left hand') : `staff ${staff}`}` : 'Pick a note';
  };
  const verses = () => [...new Set([...doc().verses, ...added, ...[...work.keys()].map((k) => k.split('|')[1]), verse])].sort((a, b) => a - b);
  const drawBar = () => {
    const vs = verses();
    bar.querySelector('.ly-verse').innerHTML = vs.map((v) => `<button role="radio" data-ly="verse" data-v="${v}" class="${v === verse ? 'on' : ''}" aria-checked="${v === verse}">${vs.length > 1 || v !== '1' ? '' : 'Verse '}${esc(v)}</button>`).join('')
      + `<button data-ly="addverse" title="Add a verse" aria-label="Add a verse" ${vs.length >= 12 ? 'disabled' : ''}>+</button>`;
    const t = tok(at);
    bar.querySelector('[data-ly="hold"]').classList.toggle('on', t.t === 'h');
    bar.querySelector('[data-ly="save"]').disabled = ctx.steps() < 2 && !pending();
    input.disabled = at < 0;
    where();
  };
  const fill = (pick = true) => {
    const t = tok(at), v = isS(t) ? t.text : '';
    if (!pick && input.value === v) return;
    input.value = v;
    typed = false;
    if (pick && document.activeElement === input && !isTouch()) input.select();
  };

  // ---- moving between notes ----
  const goTo = (k, focus = true) => {
    const n = L()[k];
    if (!n) return false;
    at = k;
    lastSel = String(n.ref);
    ctx.select([n.ref]);
    fill(); drawBar(); overlay(); reveal();
    if (focus) input.focus({ preventScroll: true });
    return true;
  };
  const step = (d) => {
    if (at < 0) return goTo(0);
    if (!goTo(at + d, true)) { if (d > 0) toast('That was the last note of this staff'); }
    flush();
  };
  // the picked note on the score -> the note of the line that carries its words (a rest / tied note / lower note of a
  // chord: the nearest line note from there)
  const fromSel = () => {
    const sel = ctx.sel();
    const s = sel.join(',');
    if (s === lastSel) return;
    const m = new Map(ctx.cur().notes.map((n) => [n.ref, n]));
    const n = m.get(sel.at(-1));
    if (!n) { if (at >= 0 && L()[at]) { lastSel = String(L()[at].ref); ctx.select([L()[at].ref]); input.focus({ preventScroll: true }); } return; } // the picked note tapped again: type on it
    if (n.staff !== staff) { staff = n.staff; }
    const Ls = L(), key0 = (x) => x.bar * 1e4 + x.on;
    let k = Ls.findIndex((x) => x.ref === n.ref);
    if (k < 0) k = Ls.findIndex((x) => key0(x) >= key0(n) - 1e-6);
    if (k < 0) k = Ls.length - 1;
    flush();
    if (k < 0) { at = -1; lastSel = s; drawBar(); overlay(); return; }
    at = k;
    lastSel = String(Ls[k].ref);
    if (s !== lastSel) ctx.select([Ls[k].ref]);
    fill(); drawBar(); overlay();
    input.focus({ preventScroll: true });
    reveal();
  };

  // ---- editing the tokens ----
  const setTok = (k, t) => { pad(k); toks()[k] = t; };
  const typeIn = () => {
    if (at < 0) return;
    const v = input.value;
    if (/[\s_]/.test(v) || /-/.test(v)) {
      const m = v.match(/^([^\s_-]*)([\s_-])$/);
      if (m) { // one syllable and how it ends
        const [, txt, end] = m;
        if (end === '_') {
          if (txt) { setTok(at, S(txt)); changed(0); step(1); }
          return hold();
        }
        if (txt) setTok(at, S(txt, end === '-'));
        else if (isS(tok(at))) toks()[at].hy = end === '-';
        changed(0); input.value = txt; return step(1);
      }
      return lay(v, false); // a phrase pasted into the box
    }
    typed = true;
    setTok(at, v ? S(v, isS(tok(at)) ? tok(at).hy : false) : K());
    changed();
  };
  input.addEventListener('input', (e) => { if (!e.isComposing) typeIn(); });
  input.addEventListener('compositionend', () => typeIn());
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const k = e.key;
    if (k === 'Enter' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); return step(1); }
    if (k === 'Tab' && e.shiftKey) { e.preventDefault(); return step(-1); }
    if (k === 'Backspace' && !input.value) {
      e.preventDefault();
      if (tok(at).t !== 'k') { setTok(at, K()); changed(0); }
      if (at > 0) { goTo(at - 1); const t = tok(at); input.value = isS(t) ? t.text : ''; input.setSelectionRange(input.value.length, input.value.length); typed = true; }
      return flush();
    }
    if (k === 'Escape') { e.preventDefault(); input.blur(); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z' && !typed) { e.preventDefault(); flush().then(() => ctx.goStep(e.shiftKey ? 1 : -1)); }
  });
  const hold = () => {
    if (at < 0) return;
    if (!toks().slice(0, at).some(isS)) { toast('Hold carries on the syllable before — there is none yet'); return; }
    setTok(at, tok(at).t === 'h' ? K() : H());
    changed(0);
    if (tok(at).t === 'h') step(1); else { fill(); drawBar(); }
  };
  const A = {
    left() {
      if (at <= 0) return toast('This is the first note');
      if (isS(tok(at - 1))) return toast('The note before has a syllable — skip, hold or clear one first');
      const T = toks(); pad(at); T.splice(at - 1, 1); changed(0); goTo(at - 1);
    },
    right() { pad(at); toks().splice(at, 0, K()); changed(0); goTo(at + 1); },
    skip() {
      const t = tok(at);
      if (t.t === 'h') setTok(at, K()); else if (isS(t)) { pad(at); toks().splice(at, 0, K()); }
      changed(0); step(1);
    },
    clear() {
      const T = toks();
      if (at >= T.length || !T.slice(at).some((t) => t.t !== 'k')) return toast('No words from here on in this verse');
      T.splice(at); changed(0); fill(); drawBar();
      toast(`Verse ${verse}: words taken off from bar ${L()[at].bar + 1} on`);
    },
    hyphen() { if (isS(tok(at))) { toks()[at].hy = true; changed(0); } step(1); },
  };
  // a phrase / verse -> one syllable per note from the picked note (rests and tied notes are not in the line)
  const lay = (text, say = true) => {
    if (at < 0) { toast('Pick the note the words start on'); return 0; }
    const syls = syllabify(text, lang);
    if (!syls.length) { toast('No words in that text'); return 0; }
    const n = L().length, from = at;
    const put = syls.slice(0, Math.max(0, n - from));
    put.forEach((s, j) => setTok(from + j, S(s.text, s.syllabic === 'begin' || s.syllabic === 'middle')));
    changed(0);
    fill(); drawBar();
    const left = syls.length - put.length;
    if (say || left) toast(`${put.length} syllable${put.length === 1 ? '' : 's'} from bar ${L()[from].bar + 1}${left ? ` · ${left} did not fit (no notes left on this staff)` : ''}`);
    flush();
    return put.length;
  };
  const paste = () => {
    if (at < 0) return toast('Pick the note the words start on');
    const s = modal(`<h2>Paste words</h2><p class="muted">From the picked note (bar ${L()[at].bar + 1}) on, one syllable per note; rests and tied notes are skipped.
      Hal-le-lu-jah: a “-” splits a word yourself; and_the: two words on one note.</p>
      <textarea id="ly-paste" rows="6" aria-label="Words to lay out"></textarea>
      <div class="seg small" id="ly-lang" role="radiogroup" aria-label="Language">${[['auto', 'Auto'], ['en', 'English'], ['vi', 'Tiếng Việt']].map(([l, n]) => `<button role="radio" data-lang="${l}" class="${lang === l ? 'on' : ''}" aria-checked="${lang === l}">${n}</button>`).join('')}</div>
      <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Lay out</button></div>`);
    s.el.querySelector('#ly-lang').onclick = (e) => {
      const b = e.target.closest('[data-lang]');
      if (!b) return;
      lang = b.dataset.lang;
      try { localStorage.setItem(LANG_KEY, lang); } catch {}
      s.el.querySelectorAll('#ly-lang button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    };
    s.el.querySelector('[data-ok]').onclick = () => { const t = s.el.querySelector('#ly-paste').value; s.close(); lay(t); };
  };
  const setVerse = (v) => {
    if (v === verse) return;
    flush();
    verse = v;
    fill(); drawBar(); fade(); overlay();
  };

  // ---- keeping the picked note in sight (iPad / iPhone: above the on-screen keyboard and the panel) ----
  const vv = window.visualViewport;
  const kb = () => (vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0);
  const sheetEl = () => paper.querySelector('#sheet') || paper.firstElementChild;
  const reveal = () => {
    if (!on || at < 0) return;
    const el = head(L()[at]?.ref);
    if (!el) return;
    view.showEl?.(el);
    const lift = kb(), sh = sheetEl();
    host.style.setProperty('--kb', lift + 'px');
    if (!lift) { nudge = 0; if (sh) sh.style.translate = ''; return; }
    const bottom = () => panel.getBoundingClientRect().top - 12, top = (vv?.offsetTop || 0) + 8;
    const sc = paper.closest('.scroll-host');
    let r = el.getBoundingClientRect();
    if (sc && sc.scrollHeight > sc.clientHeight + 1) { const need = r.bottom + 46 - bottom(); if (need > 0) { sc.scrollTop += need; r = el.getBoundingClientRect(); } }
    // what is left: the score slides up (only while the keyboard is up) so the note and its words sit above the panel
    nudge = Math.max(0, Math.min(r.bottom + nudge + 46 - bottom(), r.top + nudge - top - 20));
    if (sh) sh.style.translate = nudge ? `0 ${-nudge}px` : '';
  };
  const onVV = () => { if (on) reveal(); };
  vv?.addEventListener('resize', onVV);
  vv?.addEventListener('scroll', onVV);

  // ---- clicks in the bar and the mode switch ----
  const act = (a, b) => {
    if (a === 'mode') return set(b.dataset.m === 'lyrics');
    if (a === 'verse') return setVerse(b.dataset.v);
    if (a === 'addverse') { const n = String(Math.max(0, ...verses().map(Number)) + 1); added.add(n); flush(); verse = n; fill(); drawBar(); fade(); overlay(); return toast(`Verse ${n}: type or paste its words`); }
    if (a === 'paste') return paste();
    if (a === 'save') return flush().then(() => ctx.save());
    if (a === 'prev') return step(-1);
    if (a === 'next') return step(1);
    if (a === 'hold') return hold();
    if (at < 0) return toast('Pick a note first');
    A[a]?.();
  };
  const onClick = (e) => {
    const b = e.target.closest('[data-ly]');
    if (!b || b.disabled) return;
    const wasIn = document.activeElement === input;
    act(b.dataset.ly, b);
    if (wasIn && on && !['paste', 'save', 'mode'].includes(b.dataset.ly)) input.focus({ preventScroll: true });
  };
  panel.addEventListener('click', onClick);
  // a button tap must not take the focus from the box (iPad / iPhone: the keyboard would go)
  const keepFocus = (e) => { if (e.target.closest('.ly-bar button') && document.activeElement === input) e.preventDefault(); };
  panel.addEventListener('mousedown', keepFocus);
  panel.addEventListener('pointerdown', keepFocus);
  // a tap on the score: no mouse events after it, so the box keeps the focus it just got (and the keyboard stays)
  const onTouchEnd = (e) => { if (on && e.target.closest?.('#paper') && e.cancelable) e.preventDefault(); };
  host.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });

  // ---- the mode ----
  const set = async (v) => {
    if (v === on) return;
    if (!v) await flush();
    on = v;
    panel.classList.toggle('lyrics', on);
    host.classList.toggle('lyricing', on);
    if (on) {
      if (!bar.isConnected) panel.append(bar);
      lastSel = '';
      const sel = ctx.sel();
      if (!sel.length || first) {
        if (first && ctx.opts.verse != null) verse = String(ctx.opts.verse);
        const start = first && ctx.opts.bar ? L().findIndex((n) => n.bar >= ctx.opts.bar - 1) : 0;
        if (L().length) goTo(Math.max(0, start), !isTouch());
      } else fromSel();
      first = false;
    } else {
      bar.remove();
      at = -1;
      host.style.removeProperty('--kb');
      nudge = 0; const sh = sheetEl(); if (sh) sh.style.translate = '';
    }
    readLabels(); readStaves(); fade(); overlay();
    lt.refresh();
    ctx.draw();
  };
  // after every draw of the panel: the Notes | Lyrics switch in the edit bar, the picked note, the bar
  const drawn = () => {
    if (closed) return;
    const row = panel.querySelector('.np-body .np-row');
    if (row && !row.querySelector('.np-mode')) {
      const sw = document.createElement('span');
      sw.className = 'seg small np-mode';
      sw.setAttribute('role', 'radiogroup');
      sw.setAttribute('aria-label', 'Edit');
      sw.innerHTML = `<button role="radio" data-ly="mode" data-m="notes" class="${on ? '' : 'on'}" aria-checked="${!on}">Notes</button><button role="radio" data-ly="mode" data-m="lyrics" class="${on ? 'on' : ''}" aria-checked="${on}">Lyrics</button>`;
      row.querySelector('.np-title')?.after(sw);
    }
    lt.drawn(row);
    if (!on) return;
    const c = panel.querySelector('#np-count');
    if (c) c.textContent = `Verse ${verse}`;
    fromSel();
    drawBar();
  };
  // keys on the score (not in the box): only moving, paging, playing, undo and Esc; a letter starts typing
  const keyFor = (e) => {
    if (!on) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') return false;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.shiftKey) { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); return true; }
    if (e.key === ' ' || ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey && !mod)) return false;
    if (e.key === 'Escape') { e.preventDefault(); ctx.close(); return true; }
    if (!mod && e.key.length === 1 && at >= 0) { input.focus({ preventScroll: true }); return true; } // the letter goes into the box
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return true; }
    return true; // note editing keys do nothing here
  };
  const destroy = () => {
    closed = true;
    clearTimeout(timer);
    host.removeEventListener('scoredrawn', onDrawn);
    vv?.removeEventListener('resize', onVV); vv?.removeEventListener('scroll', onVV);
    panel.removeEventListener('click', onClick);
    host.removeEventListener('touchend', onTouchEnd, true);
    panel.querySelectorAll('.ly-live').forEach((x) => x.remove());
    paper.querySelectorAll('.ly-live, .ly-hidden, .ly-other').forEach((x) => (x.classList.contains('ly-live') ? x.remove() : x.classList.remove('ly-hidden', 'ly-other')));
    host.classList.remove('lyricing'); host.style.removeProperty('--kb');
    const sh = sheetEl(); if (sh) sh.style.translate = '';
    bar.remove();
    lt.destroy();
  };
  // the lyrics text beside the score (lyricspanel.js): its "Use from selected note" lays words out here
  const lt = lyricsPanel({ it: ctx.it, host, panel, onUse: (t) => lay(t), canUse: () => on });
  return {
    get text() { return lt; },
    get on() { return on; }, set, drawn, key: keyFor, flush, destroy, lay,
    get pending() { return pending(); },
    // for automated tests
    get at() { return at; }, get verse() { return verse; }, get staff() { return staff; },
    get tokens() { return toks().map((t) => (isS(t) ? t.text + (t.hy ? '-' : '') : t.t === 'h' ? '_' : '.')).join(' ').replace(/( \.)+$/, ''); },
    get line() { return L().map((n) => n.ref); },
  };
}
