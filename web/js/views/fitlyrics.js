// Fit lyrics (score ⋯ → "Fit lyrics…"): put words under a score's melody by hand.
// The words are split into syllables (English hyphenation, Vietnamese one per word: syllables.js) and laid
// one per note as a start, or come from a sheet (the Mac reads it and lines its tune up with this one:
// lyricsfit.py). The melody is a strip of notes per bar (name, length, a dot for its height) with the
// syllable under each note: tap a chip to pick it, tap again to change its words; shift the rest left /
// right, hold (melisma: the syllable before goes on over this note), skip (no syllable), merge / split,
// insert / delete, drag a chip onto another note (iPad / iPhone: press and hold, then drag); play from a
// note with the score's own player. Undo / redo inside the editor; Preview draws the score with the words.
// Save writes <lyric> elements (syllabic, extend, verse numbers) into this score — the file before is kept
// in its .history/ and Activities can undo it — or into a new score next to it (server: lyricsedit.py).
import { store } from '../store.js';
import { $, esc, iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { go } from '../app.js';
import { isTouch } from '../device.js';
import { syllabify, wordSyllables, syllablesText, guessLang } from '../syllables.js';
import { pageSrc } from './sheet.js';

const H = () => ({ t: 'h' }), K = () => ({ t: 'k' });
const isS = (x) => x?.t === 's';
const opens = (s) => s === 'single' || s === 'begin'; // a word starts on this syllable
const closes = (s) => s === 'single' || s === 'end'; // …and ends on it
const sylOf = (start, end) => (start ? (end ? 'single' : 'begin') : end ? 'end' : 'middle');
const LANG_KEY = 'meowsic-fitlyrics-lang';

async function api(path, opts) {
  const r = await fetch('/api' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`);
  return j;
}
const post = (path, body, raw = false) => fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); } return raw ? r.text() : r.json(); });

// small pictures of the note lengths (head, stem, flags), like the note editor's
const head = (filled) => `<ellipse cx="8" cy="18" rx="4.6" ry="3.4" transform="rotate(-22 8 18)" ${filled ? '' : 'fill="none" stroke-width="1.6"'}/>`;
const stem = '<path d="M12.2 17V3" stroke-width="1.5" fill="none"/>';
const flag = (y) => `<path d="M12.2 ${y}c2.5 2 5 3.5 4 8" stroke-width="1.6" fill="none"/>`;
const dotP = '<circle cx="17.5" cy="19" r="1.7"/>';
const PIC = { whole: head(0), half: head(0) + stem, quarter: head(1) + stem, eighth: head(1) + stem + flag(3), '16th': head(1) + stem + flag(3) + flag(7), '32nd': head(1) + stem + flag(3) + flag(7) + flag(11) };
const typeOf = (d) => (d >= 4 ? 'whole' : d >= 2 ? 'half' : d >= 1 ? 'quarter' : d >= 0.5 ? 'eighth' : d >= 0.25 ? '16th' : '32nd');
const notePic = (n) => `<svg class="fl-pic" viewBox="0 0 22 24" aria-hidden="true">${PIC[n.type] || PIC[typeOf(n.dur)]}${n.dots ? dotP : ''}</svg>`;
const REST = '<svg class="fl-pic" viewBox="0 0 20 24" aria-hidden="true"><path d="M8 3l4.5 5-3.5 4 4.5 5c-3-1.5-5 0-3 3.5-4-2.5-3-6 0-5L6 9z"/></svg>';

export async function fitLyrics(view, it, host) {
  if (!host || host.querySelector('.fitly')) return;
  if (!view.real) return toast('Fit lyrics works on scores from the Mac.');
  host.querySelector('.editbar')?.dispatchEvent(new Event('close'));
  const panel = document.createElement('div');
  panel.className = 'fitly';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Fit lyrics');
  panel.innerHTML = '<div class="fl-head"><b class="fl-title">Fit lyrics</b><span class="muted">Reading the melody…</span></div>';
  host.append(panel);
  host.classList.add('fitting');

  let mel; // {line, lines, verses, notes, bars, sha}
  const load = async (line) => { mel = await api(`/items/${encodeURIComponent(it.id)}/lyrics${line ? `?line=${encodeURIComponent(line)}` : ''}`); };
  try { await load(); } catch (e) { panel.remove(); host.classList.remove('fitting'); return toast(e.message); }

  let verse = '1', sel = 0, mode = 'edit', mini = false, previewed = false, playing = false, closed = false, reading = null;
  let lang = (() => { try { return localStorage.getItem(LANG_KEY) || 'auto'; } catch { return 'auto'; } })();
  const V = {}; // verse -> tokens, one per note (and leftover syllables after the last note)
  const dirty = new Set();
  let undo = [], redo = [];
  const N = () => mel.notes.length;
  const T = () => V[verse];
  const tok = (k) => T()[k] || K();
  const pad = (k) => { while (T().length < k) T().push(K()); };
  const leftover = () => T().slice(N()).filter(isS);

  // words already in the score -> tokens: a note with no words after a syllable that goes on (extend, or a word
  // not finished yet) is a hold; any other is a skip
  const fromScore = (v) => {
    const out = [];
    let last = null, open = false;
    for (const n of mel.notes) {
      const ly = n.lyrics?.[v];
      if (ly?.text) { last = { t: 's', text: ly.text, syl: ly.syllabic || 'single' }; out.push(last); open = !!ly.extend || !closes(last.syl); }
      else if (ly?.extend || (last && open)) out.push(H());
      else { out.push(K()); open = false; }
    }
    while (out.length && !isS(out[out.length - 1])) out.pop();
    return out;
  };
  const resetVerses = () => {
    for (const k of Object.keys(V)) delete V[k];
    for (const v of mel.verses) V[v] = fromScore(v);
    verse = mel.verses[0] || '1';
    if (!V[verse]) V[verse] = [];
    undo = []; redo = []; dirty.clear(); sel = 0;
    mode = T().some(isS) ? 'edit' : 'words';
  };
  resetVerses();

  // ---- auto fit: one syllable per note; a new text line starts at the next phrase (after a rest or a long note) if one is near
  const phraseStart = (k) => {
    if (k <= 0) return true;
    const a = mel.notes[k - 1], b = mel.notes[k];
    return !!b && (b.on - (a.on + a.dur) >= 0.5 - 1e-6 || a.dur >= 2);
  };
  const autoFit = (syls) => {
    const out = [];
    let k = 0;
    syls.forEach((s, j) => {
      if (s.line && j > 0 && !phraseStart(k)) {
        for (let d = 1; d <= 4; d++) if (phraseStart(k + d) && N() - (k + d) >= syls.length - j) { for (let x = 0; x < d; x++) out.push(K()); k += d; break; }
      }
      out.push({ t: 's', text: s.text, syl: s.syllabic });
      k++;
    });
    return out;
  };

  // ---- editing (every change: one undo step) ----
  const snap = () => ({ v: verse, toks: JSON.stringify(T()) });
  const edit = (fn, keepSel) => {
    const before = snap();
    const r = fn();
    if (r === false) return;
    undo.push(before); if (undo.length > 300) undo.shift();
    redo = [];
    dirty.add(verse);
    if (typeof keepSel === 'number') sel = keepSel;
    while (T().length > N() && !isS(T()[T().length - 1])) T().pop();
    draw();
  };
  const restore = (from, to) => {
    const s = from.pop();
    if (!s) return;
    to.push({ v: s.v, toks: JSON.stringify(V[s.v] || []) });
    V[s.v] = JSON.parse(s.toks);
    verse = s.v;
    dirty.add(s.v);
    mode = 'edit';
    draw();
  };
  // text typed for a note -> tokens; a word cut by "-" keeps the start / end of the syllable it replaces
  const parse = (text, was) => {
    const parts = [];
    const words = text.trim().split(/\s+/).filter(Boolean);
    words.forEach((w, wi) => {
      const ps = w.replace(/[_~]/g, ' ').split('-').filter(Boolean);
      ps.forEach((p, k) => parts.push({ t: 's', text: p, start: k === 0, end: k === ps.length - 1, wi }));
    });
    if (!parts.length) return [];
    if (isS(was)) { parts[0].start = opens(was.syl); parts[parts.length - 1].end = closes(was.syl); }
    return parts.map((p) => ({ t: 's', text: p.text, syl: sylOf(p.start, p.end) }));
  };
  const A = {
    text(k, text) {
      const parts = parse(text, tok(k));
      edit(() => { pad(k); if (!parts.length) { if (isS(tok(k))) T().splice(k, 1); else return false; } else T().splice(k, 1, ...parts); }, k);
    },
    insert(k, text) { const parts = parse(text, null); if (parts.length) edit(() => { pad(k); T().splice(k, 0, ...parts); }, k); },
    del(k) { if (k >= T().length) return toast('Nothing to delete on this note'); edit(() => { T().splice(k, 1); }, k); },
    right(k) { edit(() => { pad(k); T().splice(k, 0, K()); }, k + 1); },
    left(k) {
      if (k === 0) return toast('This is the first note');
      const b = tok(k - 1);
      if (isS(b)) return toast('The note before has a syllable — skip, hold or delete one first');
      edit(() => { pad(k); T().splice(k - 1, 1); }, k - 1);
    },
    hold(k) {
      if (!T().slice(0, k).some(isS)) return toast('Hold carries on the syllable before — there is none yet');
      const t = tok(k);
      edit(() => { pad(k); if (t.t === 'h') T().splice(k, 1); else if (t.t === 'k' && k < T().length) T()[k] = H(); else T().splice(k, 0, H()); }, k);
    },
    skip(k) {
      const t = tok(k);
      if (t.t === 'k' && k >= T().length) return toast('No syllable on this note already');
      edit(() => { pad(k); if (t.t === 'k') T().splice(k, 1); else if (t.t === 'h') T()[k] = K(); else T().splice(k, 0, K()); }, k);
    },
    merge(k) {
      const a = tok(k);
      if (!isS(a)) return toast('Pick a syllable to merge with the next one');
      const j = T().findIndex((x, i) => i > k && isS(x));
      if (j < 0) return toast('There is no syllable after this one');
      const b = T()[j];
      edit(() => { T()[k] = { t: 's', text: a.text + (closes(a.syl) && opens(b.syl) ? ' ' : '') + b.text, syl: sylOf(opens(a.syl), closes(b.syl)) }; T().splice(j, 1); }, k);
    },
    split(k) {
      const a = tok(k);
      if (!isS(a)) return toast('Pick a syllable to split');
      let ps = a.text.includes(' ') ? a.text.split(/\s+/) : wordSyllables(a.text, lang === 'auto' ? guessLang(a.text) : lang);
      if (ps.length < 2) {
        if ([...a.text].length < 2) return toast('Too short to split');
        const ch = [...a.text], m = Math.ceil(ch.length / 2);
        ps = [ch.slice(0, m).join(''), ch.slice(m).join('')];
      }
      const words = a.text.includes(' ');
      edit(() => {
        T().splice(k, 1, ...ps.map((p, i) => ({ t: 's', text: p,
          syl: words ? (i === 0 ? sylOf(opens(a.syl), true) : i === ps.length - 1 ? sylOf(true, closes(a.syl)) : 'single')
            : sylOf(i === 0 ? opens(a.syl) : false, i === ps.length - 1 ? closes(a.syl) : false) })));
      }, k);
    },
    move(from, to) {
      if (from === to || !isS(tok(from))) return;
      const s = tok(from);
      edit(() => { pad(Math.max(from, to) + 1); T()[from] = K(); if (isS(T()[to])) T().splice(to, 0, s); else T()[to] = s; }, to);
    },
  };

  // ---- drawing ----
  const lo = Math.min(...mel.notes.map((n) => n.midi)), hi = Math.max(...mel.notes.map((n) => n.midi));
  const yOf = (m) => (hi > lo ? (m - lo) / (hi - lo) : 0.5);
  const chip = (t, k) => {
    if (isS(t)) return `<span class="fl-chip s${t.sure === false ? ' unsure' : ''}" data-chip="${k}">${esc(t.text)}${closes(t.syl) ? '' : '<i class="hy">-</i>'}</span>`;
    if (t.t === 'h') return `<span class="fl-chip h" data-chip="${k}" title="Hold: the syllable before goes on"><i></i></span>`;
    return `<span class="fl-chip k" data-chip="${k}" title="No syllable"></span>`;
  };
  const counts = () => {
    const fit = T().slice(0, N()).filter(isS).length, left = leftover().length;
    return { fit, left };
  };
  const head = () => {
    const { fit, left } = counts();
    const lines = mel.lines.length > 1 ? `<select id="fl-line" aria-label="Melody line">${mel.lines.map((l) => `<option value="${esc(l.key)}" ${l.key === mel.line ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select>` : '';
    const vs = Object.keys(V).sort((a, b) => a - b);
    return `<div class="fl-head">
      <b class="fl-title">Fit lyrics</b>
      ${lines}
      <div class="seg small fl-verse" role="radiogroup" aria-label="Verse">${vs.map((v) => `<button role="radio" data-verse="${v}" class="${v === verse ? 'on' : ''}" aria-checked="${v === verse}">Verse ${v}${dirty.has(v) ? ' •' : ''}</button>`).join('')}<button data-a="addverse" aria-label="Add a verse" title="Add a verse">+</button></div>
      <span class="fl-count" id="fl-count">${fit} on notes${left ? ` · <b class="bad">${left} not fitted</b>` : ''}</span>
      <span class="grow"></span>
      <button class="icon-btn" data-a="undo" ${undo.length ? '' : 'disabled'} title="Undo (⌘Z)" aria-label="Undo">${iconOn('undo')}</button>
      <button class="icon-btn" data-a="redo" ${redo.length ? '' : 'disabled'} title="Redo (⇧⌘Z)" aria-label="Redo"><span class="flip">${iconOn('undo')}</span></button>
      <button data-a="words" class="${mode === 'words' ? 'on' : ''}">Words</button>
      <button data-a="preview" class="${mini ? 'on' : ''}">${mini ? 'Edit' : 'Preview'}</button>
      <button class="primary" data-a="save" ${dirty.size ? '' : 'disabled'}>Save</button>
      <button class="icon-btn" data-a="close" title="Close (Esc)" aria-label="Close">${iconOn('close')}</button>
    </div>`;
  };
  const strip = () => {
    let h = '', prevEnd = 0, k = 0;
    for (const b of mel.bars) {
      let notes = '';
      if (k < N() && mel.notes[k].bar !== b.i && mel.notes[k].bar > b.i) { // a bar with no melody notes
        notes = `<span class="fl-rest wide" title="Rest">${REST}</span>`;
      }
      while (k < N() && mel.notes[k].bar === b.i) {
        const n = mel.notes[k];
        if (n.on - prevEnd >= 0.25 - 1e-6) notes += `<span class="fl-rest" title="Rest">${REST}</span>`;
        const t = tok(k);
        const w = Math.round(58 + 22 * Math.min(Math.sqrt(n.dur), 2));
        notes += `<div class="fl-n${k === sel ? ' on' : ''}" data-k="${k}" style="min-width:${w}px" role="button" tabindex="-1" aria-label="${esc(n.name)}${isS(t) ? ': ' + esc(t.text) : t.t === 'h' ? ': hold' : ''}">
          <span class="fl-pitch"><i style="bottom:${Math.round(yOf(n.midi) * 100)}%"></i></span>
          <span class="fl-name">${esc(n.name)}</span>${notePic(n)}
          ${chip(t, k)}</div>`;
        prevEnd = n.on + n.dur; k++;
      }
      h += `<div class="fl-bar" data-bar="${b.i}"><span class="fl-bn">${esc(b.number)}</span><div class="fl-notes">${notes}</div></div>`;
    }
    const left = leftover();
    if (left.length) h += `<div class="fl-bar fl-leftbar"><span class="fl-bn bad">Not fitted</span><div class="fl-notes">${left.map((t) => `<span class="fl-chip s left">${esc(t.text)}${closes(t.syl) ? '' : '<i class="hy">-</i>'}</span>`).join('')}</div></div>`;
    return `<div class="fl-strip" id="fl-strip">${h}</div>`;
  };
  const acts = () => {
    const t = tok(sel), s = isS(t);
    const b = (a, label, title, dis = false, cls = '') => `<button data-a="${a}" class="${cls}" title="${esc(title)}" ${dis ? 'disabled' : ''}>${label}</button>`;
    return `<div class="fl-acts">
      ${b('play', playing ? '■ Stop' : '▶ Play', 'Play from this note (P)', false, 'fl-play')}
      ${b('edit', s ? 'Edit' : 'Type', 'Change the words on this note (Enter)')}
      ${b('left', '◀ Shift', 'Move this syllable and all after it one note earlier ([)', sel === 0 || isS(tok(sel - 1)))}
      ${b('right', 'Shift ▶', 'Move this syllable and all after it one note later (])')}
      ${b('hold', t.t === 'h' ? 'Unhold' : 'Hold', 'Hold: the syllable before goes on over this note (H)', !T().slice(0, sel).some(isS), t.t === 'h' ? 'on' : '')}
      ${b('skip', t.t === 'k' ? 'Unskip' : 'Skip', 'No syllable on this note (K)', t.t === 'k' && sel >= T().length, t.t === 'k' ? 'on' : '')}
      ${b('merge', 'Merge', 'Join with the next syllable (M)', !s)}
      ${b('split', 'Split', 'Split into syllables (/)', !s)}
      ${b('insert', 'Insert', 'A new syllable before this note (I)')}
      ${b('del', 'Delete', 'Take this off; the rest moves one note earlier (⌫)', sel >= T().length, 'danger-text')}
    </div>`;
  };
  const words = () => {
    const syls = T().filter(isS).map((x) => ({ text: x.text, syllabic: x.syl }));
    return `<div class="fl-words">
      <textarea id="fl-text" rows="4" placeholder="Paste or type the words of verse ${verse}. One line per sung line. Hal-le-lu-jah: a “-” splits a word yourself; and_the: one note for two words." aria-label="Lyrics">${esc(syllablesText(syls))}</textarea>
      <div class="fl-wrow">
        <div class="seg small" id="fl-lang" role="radiogroup" aria-label="Language">${[['auto', 'Auto'], ['en', 'English'], ['vi', 'Tiếng Việt']].map(([l, n]) => `<button role="radio" data-lang="${l}" class="${lang === l ? 'on' : ''}" aria-checked="${lang === l}">${n}</button>`).join('')}</div>
        <button data-a="sheet" ${store.mode === 'server' ? '' : 'disabled'}>From a sheet…</button>
        <span class="muted small" id="fl-msg"></span>
        <span class="grow"></span>
        ${T().some(isS) ? '<button data-a="back">Cancel</button>' : ''}
        <button class="primary" data-a="fit">Fit to notes</button>
      </div></div>`;
  };
  const draw = () => {
    if (closed) return;
    const keep = $('#fl-strip', panel)?.scrollLeft || 0;
    const typed = mode === 'words' ? $('#fl-text', panel)?.value : null;
    panel.classList.toggle('mini', mini);
    panel.innerHTML = head() + (mini ? '' : mode === 'words' ? words() : strip() + acts());
    if (typed != null && $('#fl-text', panel)) $('#fl-text', panel).value = typed;
    const st = $('#fl-strip', panel);
    if (st) { st.scrollLeft = keep; showSel(false); }
    host.style.setProperty('--fl-h', panel.offsetHeight + 'px');
  };
  const showSel = (smooth = true) => {
    const st = $('#fl-strip', panel), el = st?.querySelector(`.fl-n[data-k="${sel}"]`);
    if (!el) return;
    const l = el.offsetLeft - st.offsetLeft, r = l + el.offsetWidth;
    if (l < st.scrollLeft + 30 || r > st.scrollLeft + st.clientWidth - 30) st.scrollTo({ left: Math.max(0, l - st.clientWidth / 3), behavior: smooth ? 'smooth' : 'auto' });
  };
  const select = (k) => {
    sel = Math.max(0, Math.min(N() - 1, k));
    panel.querySelectorAll('.fl-n.on').forEach((x) => x.classList.remove('on'));
    panel.querySelector(`.fl-n[data-k="${sel}"]`)?.classList.add('on');
    const a = panel.querySelector('.fl-acts');
    if (a) a.outerHTML = acts();
    showSel();
  };

  // ---- a text box for one note's words ----
  const ask = (title, value, hint) => new Promise((resolve) => {
    let done = false;
    const s = modal(`<h2>${esc(title)}</h2><form><input id="fl-edit" value="${esc(value)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Words for this note">
      <p class="muted small">${hint}</p>
      <div class="modal-actions"><button type="button" data-close>Cancel</button><button class="primary">OK</button></div></form>`, { onClose: () => { if (!done) resolve(null); } });
    const input = s.el.querySelector('input');
    setTimeout(() => input.select(), 40);
    s.el.querySelector('form').onsubmit = (e) => { e.preventDefault(); done = true; s.close(); resolve(input.value); };
  });
  const HINT = '“-” splits it into syllables (lov-ing), a space into words, one per note. Empty = take it off.';
  const editSel = async () => {
    const t = tok(sel), n = mel.notes[sel];
    const v = await ask(`Words on ${n.name} (bar ${mel.bars[n.bar]?.number})`, isS(t) ? t.text + (closes(t.syl) ? '' : '-') : '', HINT);
    if (v == null) return;
    A.text(sel, v.replace(/-+$/, (m) => (isS(t) && !closes(t.syl) ? '' : m)));
  };
  const insertSel = async () => {
    const v = await ask(`New syllable before ${mel.notes[sel].name}`, '', '“-” or a space make more than one; the rest moves on.');
    if (v != null && v.trim()) A.insert(sel, v);
  };

  // ---- playing from a note (the score's own player) ----
  const tick = (e) => {
    if (!playing) return;
    const q = e.detail.q;
    let k = -1;
    for (let i = 0; i < N(); i++) { if (mel.notes[i].on <= q + 1e-3) k = i; else break; }
    panel.querySelectorAll('.fl-n.now').forEach((x) => x.classList.remove('now'));
    const el = panel.querySelector(`.fl-n[data-k="${k}"]`);
    if (el) {
      el.classList.add('now');
      const st = $('#fl-strip', panel), l = el.offsetLeft - st.offsetLeft;
      if (l < st.scrollLeft || l + el.offsetWidth > st.scrollLeft + st.clientWidth) st.scrollTo({ left: Math.max(0, l - 40) });
    }
  };
  const stopPlay = () => { if (playing) { playing = false; view.player?.pause(); panel.querySelectorAll('.fl-n.now').forEach((x) => x.classList.remove('now')); } };
  const ended = () => { playing = false; draw(); };
  host.addEventListener('tick', tick);
  host.addEventListener('ended', ended);
  const play = async () => {
    const p = view.player;
    if (!p) return;
    if (playing) { stopPlay(); select(sel); return; }
    p.pause();
    p.seek(mel.notes[sel].on);
    playing = true; select(sel);
    try { await p.play(); } catch { playing = false; toast('Could not start playback'); select(sel); }
  };

  // ---- the requests ----
  const payload = () => {
    const verses = {};
    for (const v of Object.keys(V)) {
      if (!dirty.has(v) && !previewed) continue;
      const toks = V[v], notes = [], holds = [];
      const ss = toks.map((t, i) => [t, i]).filter(([t]) => isS(t));
      ss.forEach(([t, i], j) => {
        if (i >= N()) return;
        const prev = ss[j - 1], next = ss[j + 1];
        // a word cut short (its next syllable did not fit, or was taken off) still reads right
        const start = opens(t.syl) || !prev || closes(prev[0].syl);
        const end = closes(t.syl) || !next || next[1] >= N() || opens(next[0].syl);
        notes.push({ ref: mel.notes[i].ref, text: t.text, syllabic: sylOf(start, end) });
      });
      toks.forEach((t, i) => { if (t.t === 'h' && i < N() && toks.slice(0, i).some(isS)) holds.push(mel.notes[i].ref); });
      verses[v] = { notes, holds };
    }
    return { line: mel.line, verses, sha: mel.sha };
  };
  const preview = async () => {
    const body = payload();
    if (!Object.keys(body.verses).length) body.verses[verse] = payload().verses[verse] || { notes: [], holds: [] };
    try {
      const xml = await post(`/items/${encodeURIComponent(it.id)}/lyrics/preview`, body, true);
      stopPlay();
      await view.showXml(xml);
      previewed = true;
    } catch (e) { toast(e.message); }
  };
  const save = async () => {
    const { left } = counts();
    const total = Object.keys(V).filter((v) => dirty.has(v)).length;
    const s = modal(`<h2>Save the lyrics?</h2>
      <p class="muted">${total > 1 ? `${total} verses` : `Verse ${[...dirty][0] || verse}`}${left ? ` · <b class="bad">${left} syllable${left > 1 ? 's' : ''} not fitted will be left out</b>` : ''}.
      Saving into this score keeps the score before in its history — Activities can undo it. A new score is its own entry next to this one; this score stays as it is.</p>
      <div class="modal-actions fl-save"><button data-close>Cancel</button><button data-mode="new">Save as new score</button><button class="primary" data-mode="this">Save to this score</button></div>`);
    s.el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = async () => {
      const m = b.dataset.mode;
      s.el.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        const j = await post(`/items/${encodeURIComponent(it.id)}/lyrics`, { ...payload(), mode: m });
        s.close();
        if (m === 'new') {
          store.putItem(j.item);
          close(true);
          toast('Saved as a new score — this one is unchanged', { label: 'Activities', run: () => go('#/activity') });
          go(`#/item/${encodeURIComponent(j.item.id)}`);
        } else {
          const cur = store.get(it.id);
          if (cur) Object.assign(cur, { updatedAt: j.item.updatedAt, musicxmlOriginal: j.item.musicxmlOriginal });
          close(true);
          await view.reload();
          toast('Lyrics saved — Activities can undo it', { label: 'Activities', run: () => go('#/activity') });
        }
      } catch (e) { s.close(); toast(e.message); }
    }));
  };

  // ---- the words of a sheet ----
  const fold = (t) => (t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const fromSheet = () => {
    const me = fold(it.title);
    const near = (x) => { const t = fold(x.title); return t && me && (t === me || t.includes(me) || me.includes(t)); };
    const sheets = store.items().filter((x) => x.kind === 'sheet' && !x.deleted && !x.book).sort((a, b) => near(b) - near(a) || a.title.localeCompare(b.title));
    const s = modal(`<h2>Words from a sheet</h2><p class="muted">Pick the sheet with the words. The Mac reads it (about 20 s a page the first time) and lines its tune up with this score's notes.</p>
      <input type="search" placeholder="Find a sheet" id="fl-q">
      <div class="list-pick" id="fl-list"></div><div class="modal-actions"><button data-close>Cancel</button></div>`, { wide: true });
    const list = $('#fl-list', s.el);
    const dr = (q = '') => (list.innerHTML = sheets.filter((x) => x.title.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
      .map((x) => `<button data-id="${x.id}">${x.pages ? `<img src="${pageSrc(x, 1)}" alt="">` : ''}<span>${esc(x.title)}${near(x) ? ' <small class="have">· same song</small>' : ''}</span><i>${x.pages || 0} p</i></button>`).join('')
      || '<p class="muted">No sheet with that name.</p>');
    dr();
    $('#fl-q', s.el).oninput = (e) => dr(e.target.value);
    list.onclick = (e) => { const b = e.target.closest('[data-id]'); if (!b) return; s.close(); readSheet(b.dataset.id); };
  };
  const readSheet = async (sheetId) => {
    const token = (reading = {});
    const msg = (t) => { const m = $('#fl-msg', panel); if (m) m.textContent = t; };
    msg('Reading the sheet…');
    try {
      for (;;) {
        const r = await post(`/items/${encodeURIComponent(it.id)}/lyrics/sheet`, { sheetId, line: mel.line });
        if (closed || reading !== token) return;
        if (r.status === 'done') { useSheet(r); return; }
        msg(`Reading the sheet… ${Math.round((r.progress || 0) * 100)}%`);
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    } catch (e) { if (!closed) { msg(''); toast(e.message); } }
  };
  const useSheet = (r) => {
    const by = new Map(r.assign.map((a) => [a.ref, a]));
    const out = [];
    let lastS = -1;
    mel.notes.forEach((n, k) => {
      const a = by.get(n.ref);
      if (a) { out.push({ t: 's', text: a.text, syl: a.syllabic, ...(a.sure ? {} : { sure: false }) }); lastS = k; return; }
      // a note between two placed syllables, close to the one before: most likely the syllable goes on (melisma)
      const nextS = mel.notes.findIndex((m, j) => j > k && by.has(m.ref));
      out.push(lastS >= 0 && nextS > 0 && nextS - lastS <= 3 ? H() : K());
    });
    while (out.length && !isS(out[out.length - 1])) out.pop();
    const extra = [];
    for (const u of r.unplaced) { // a syllable that found no note: on a free note right after the one before it, else left over
      const k = u.after == null ? -1 : mel.notes.findIndex((n) => n.ref === u.after);
      if (k + 1 < out.length && !isS(out[k + 1])) out[k + 1] = { t: 's', text: u.text, syl: u.syllabic, sure: false };
      else extra.push({ t: 's', text: u.text, syl: u.syllabic, sure: false });
    }
    edit(() => { V[verse] = [...out, ...extra]; }, 0);
    mode = 'edit';
    draw();
    toast(`${r.assign.length} of ${r.syllables} syllables from the sheet are on notes${r.unplaced.length ? ' — red ones are unsure' : ''}`);
  };

  // ---- input ----
  const close = (force) => {
    if (closed) return;
    const go2 = () => {
      closed = true; reading = null; stopPlay();
      panel.remove(); host.classList.remove('fitting'); host.style.removeProperty('--fl-h');
      host.removeEventListener('tick', tick); host.removeEventListener('ended', ended);
      document.removeEventListener('keydown', keys, true);
      if (previewed && force !== true) view.reload();
    };
    if (force === true || !dirty.size) return go2();
    confirmSheet({ title: 'Close without saving?', body: 'The lyrics you fitted here are not saved yet.', ok: 'Close', danger: true }).then((ok) => ok && go2());
  };
  const act = async (a) => {
    if (a === 'close') return close();
    if (a === 'undo') return restore(undo, redo);
    if (a === 'redo') return restore(redo, undo);
    if (a === 'words') { mode = mode === 'words' ? 'edit' : 'words'; mini = false; return draw(); }
    if (a === 'back') { mode = 'edit'; return draw(); }
    if (a === 'preview') { if (mini) { mini = false; draw(); return; } mini = true; draw(); return preview(); }
    if (a === 'save') return save();
    if (a === 'sheet') return fromSheet();
    if (a === 'addverse') {
      const n = String(Math.max(0, ...Object.keys(V).map(Number)) + 1);
      V[n] = []; verse = n; mode = 'words'; mini = false; sel = 0; return draw();
    }
    if (a === 'fit') {
      const text = $('#fl-text', panel).value;
      const syls = syllabify(text, lang);
      if (!syls.length) return toast('Type or paste the words first');
      edit(() => { V[verse] = autoFit(syls); }, 0);
      mode = 'edit';
      draw();
      const { left } = counts();
      return toast(left ? `${syls.length} syllables, ${left} more than the notes — they are red at the end` : `${syls.length} syllables on ${N()} notes`);
    }
    if (a === 'play') return play();
    if (a === 'edit') return editSel();
    if (a === 'insert') return insertSel();
    if (A[a]) return A[a](sel);
  };
  panel.addEventListener('click', (e) => {
    if (dragged) { dragged = false; return; }
    const v = e.target.closest('[data-verse]');
    if (v) { verse = v.dataset.verse; V[verse] ||= []; mode = T().some(isS) ? 'edit' : 'words'; sel = Math.min(sel, N() - 1); mini = false; return draw(); }
    const l = e.target.closest('[data-lang]');
    if (l) { lang = l.dataset.lang; try { localStorage.setItem(LANG_KEY, lang); } catch {} panel.querySelectorAll('#fl-lang button').forEach((b) => { b.classList.toggle('on', b === l); b.setAttribute('aria-checked', String(b === l)); }); return; }
    const b = e.target.closest('[data-a]');
    if (b && !b.disabled) return act(b.dataset.a);
    const n = e.target.closest('.fl-n');
    if (n) {
      const k = +n.dataset.k;
      if (k === sel && e.target.closest('.fl-chip')) return editSel(); // tap the picked chip again: change its words
      select(k);
    }
  });
  panel.addEventListener('change', async (e) => {
    if (e.target.id !== 'fl-line') return;
    const want = e.target.value;
    if (dirty.size && !(await confirmSheet({ title: 'Switch the melody line?', body: 'The lyrics fitted to this line are not saved yet.', ok: 'Switch', danger: true }))) { e.target.value = mel.line; return; }
    try { await load(want); resetVerses(); draw(); } catch (er) { toast(er.message); }
  });

  // drag a chip onto another note (mouse: just drag; touch: press and hold first)
  let drag = null, dragged = false;
  const target = (x, y) => document.elementFromPoint(x, y)?.closest?.('.fitly .fl-n');
  panel.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.fl-chip.s[data-chip]');
    if (!c || e.button > 0) return;
    drag = { k: +c.dataset.chip, x: e.clientX, y: e.clientY, id: e.pointerId, on: false, el: c, touch: e.pointerType !== 'mouse', t: Date.now() };
    if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.on) startDrag(e.clientX, e.clientY); }, 280);
  });
  const startDrag = (x, y) => {
    drag.on = true;
    const g = drag.el.cloneNode(true);
    g.classList.add('fl-ghost');
    document.body.append(g);
    drag.g = g; moveGhost(x, y);
    drag.el.classList.add('dragging');
    try { panel.setPointerCapture(drag.id); } catch {}
  };
  const moveGhost = (x, y) => {
    drag.g.style.transform = `translate(${x - drag.g.offsetWidth / 2}px, ${y - drag.g.offsetHeight / 2}px)`;
    panel.querySelectorAll('.fl-n.drop').forEach((n) => n.classList.remove('drop'));
    target(x, y)?.classList.add('drop');
    const st = $('#fl-strip', panel), r = st?.getBoundingClientRect();
    if (r && x < r.left + 40) st.scrollLeft -= 14; else if (r && x > r.right - 40) st.scrollLeft += 14;
  };
  panel.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.on) {
      if (drag.touch) { if (d > 8) { clearTimeout(drag.timer); drag = null; } return; } // a swipe: the strip scrolls
      if (d > 6) startDrag(e.clientX, e.clientY); else return;
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    clearTimeout(drag.timer);
    const d = drag; drag = null;
    if (!d.on) return;
    d.g.remove(); d.el.classList.remove('dragging');
    panel.querySelectorAll('.fl-n.drop').forEach((n) => n.classList.remove('drop'));
    dragged = true; setTimeout(() => (dragged = false), 50);
    const t = e.type === 'pointerup' ? target(e.clientX, e.clientY) : null;
    if (t) A.move(d.k, +t.dataset.k);
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
  // iOS: once a hold turned into a drag, the strip must not scroll under the finger
  panel.addEventListener('touchmove', (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
  panel.addEventListener('contextmenu', (e) => { if (e.target.closest('.fl-chip')) e.preventDefault(); });

  // keys (Mac): ← → pick · Enter words · H hold · K skip · [ ] shift · M merge · / split · I insert · ⌫ delete · P play · ⌘Z / ⇧⌘Z · Esc
  const keys = (e) => {
    if (closed || document.querySelector('.modal-wrap')) return;
    if (e.target.closest?.('input,textarea,select')) { if (e.key === 'Escape') e.target.blur(); return; }
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    const map = { ArrowLeft: () => select(sel - 1), ArrowRight: () => select(sel + 1), Enter: editSel, h: () => A.hold(sel), k: () => A.skip(sel), '[': () => A.left(sel), ']': () => A.right(sel),
      m: () => A.merge(sel), '/': () => A.split(sel), i: insertSel, Backspace: () => A.del(sel), Delete: () => A.del(sel), p: play, ' ': play, Escape: () => close() };
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); return restore(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); }
    if (mod || mode !== 'edit' && k !== 'Escape') return;
    const f = map[k.length === 1 ? k.toLowerCase() : k];
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    f();
  };
  document.addEventListener('keydown', keys, true);
  draw();
  if (mode === 'words' && !isTouch()) setTimeout(() => $('#fl-text', panel)?.focus(), 50);
  window.__fitLyrics = { get tokens() { return V[verse]; }, get verse() { return verse; }, get sel() { return sel; }, get notes() { return mel.notes; }, payload }; // for automated tests
}
