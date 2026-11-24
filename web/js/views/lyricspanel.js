// Lyrics text beside the score while editing (Edit notes, Notes and Lyrics modes): the words and chords of the same
// song from the library's chord charts (Chords), read-only, as the chord view shows them (chords above the words;
// "Chords" hides them), text size − / +. The "Lyrics text" button in the edit bar shows / hides it (remembered on this
// device): on the right on a Mac and an iPad held sideways (the score lays out again in the width left), a drawer
// over the edit bar on an iPad held upright and on an iPhone (its title bar folds it away).
// The chart: the one with the same title (case, accents and bracketed parts left out, as autofill.py matches);
// several: a picker; none: "No chord chart for this song" and a search of every chord chart.
// In Lyrics mode, "Use from selected note" lays the words picked (selected) in the text out from the picked note,
// one syllable per note, chords taken out (lyricmode.js lay()).
import { store } from '../store.js';
import { esc, iconOn, toast } from '../ui.js';
import { device } from '../device.js';
import { linesHtml } from '../chordchart.js';

const KEY = 'meowsic-lyricstext';
const prefs = () => { try { return { open: false, chords: true, size: 16, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { open: false, chords: true, size: 16 }; } };
const savePrefs = (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} };
const chartKey = (id) => `${KEY}-chart-${id}`;

// as metafill.fold + autofill.core: no accents (đ → d), no case, no apostrophes, no bracketed parts
export const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/['’`]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const titleKeys = (t) => {
  const nob = (t || '').replace(/\s*[([][^)\]]*[)\]]/g, ' ').trim() || t || '';
  const head = nob.split(/\s[-–—:]\s/)[0];
  return new Set([fold(nob), fold(head)].filter(Boolean));
};
export const chartsFor = (title, charts) => {
  const want = titleKeys(title);
  return charts.filter((c) => [...titleKeys(c.title)].some((k) => want.has(k)));
};

// opts: { it (the score), host (.viewer), panel (the edit panel), onUse(text), canUse() }
export function lyricsPanel({ it, host, panel, onUse, canUse }) {
  let p = prefs(), min = false, q = '', closed = false;
  const all = () => store.items().filter((x) => x.kind === 'chords' && !x.deleted && x.lines);
  const matches = chartsFor(it.title, all());
  let chart = (() => {
    let id = null;
    try { id = localStorage.getItem(chartKey(it.id)); } catch {}
    return all().find((c) => c.id === id) || matches[0] || null;
  })();
  const el = document.createElement('aside');
  el.className = 'lt-panel';
  el.setAttribute('aria-label', 'Lyrics text');
  const body = () => host.querySelector('.viewer-body');
  const layout = () => {
    const d = device(), side = d === 'desktop' || (d === 'tablet' && innerWidth > innerHeight);
    host.classList.toggle('lt-on', p.open);
    host.classList.toggle('lt-side', p.open && side);
    host.classList.toggle('lt-drawer', p.open && !side);
    el.classList.toggle('min', min && !side);
  };
  let lastText = '';
  const picked = () => {
    const s = getSelection();
    if (!s?.rangeCount || s.isCollapsed) return '';
    const r = s.getRangeAt(0);
    const box = el.querySelector('.lt-text');
    if (!box || !box.contains(r.commonAncestorContainer)) return '';
    const f = r.cloneContents();
    f.querySelectorAll('.ch, .sec').forEach((x) => x.remove());
    const lines = f.querySelectorAll('.ln');
    const text = lines.length ? [...lines].map((l) => l.textContent).join('\n') : f.textContent;
    return text.replace(/\[[^\]]*\]/g, ' ').replace(/[ \t ]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  };
  const onSelChange = () => { const t = picked(); if (t) lastText = t; };
  document.addEventListener('selectionchange', onSelChange);

  const list = () => {
    const f = fold(q);
    return all().filter((c) => !f || fold(c.title).includes(f) || fold(c.artist || '').includes(f)).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 40);
  };
  const draw = () => {
    if (closed) return;
    layout();
    if (!p.open) { el.remove(); return; }
    if (!el.isConnected) body()?.append(el);
    const pick = matches.length > 1 || (chart && !matches.includes(chart));
    el.innerHTML = `<div class="lt-head">
        <button class="lt-title" data-lt="min" aria-expanded="${!min}"><b>Lyrics text</b></button>
        ${pick ? `<select class="lt-pick" aria-label="Chord chart">${[...new Set([...matches, ...(chart ? [chart] : [])])].map((c) => `<option value="${c.id}" ${c === chart ? 'selected' : ''}>${esc(c.title)}${c.artist ? ` · ${esc(c.artist)}` : ''}</option>`).join('')}<option value="">Another chord chart…</option></select>` : ''}
        <span class="grow"></span>
        ${chart ? `<button data-lt="chords" class="${p.chords ? 'on' : ''}" aria-pressed="${p.chords}" title="Show the chords above the words">Chords</button>
        <span class="stepper"><button data-lt="smaller" aria-label="Smaller text" title="Smaller text">A−</button><button data-lt="bigger" aria-label="Bigger text" title="Bigger text">A+</button></span>` : ''}
        <button class="icon-btn" data-lt="toggle" title="Hide the lyrics text" aria-label="Hide the lyrics text">${iconOn('close')}</button>
      </div>
      ${chart ? `${canUse() ? '<div class="lt-use"><button class="primary" data-lt="use" title="Select a line or a phrase below, then lay it out from the picked note">Use from selected note</button><span class="muted small">Select a line or phrase first</span></div>' : ''}
        <div class="lt-text chart ${p.chords ? '' : 'nochords'}" style="--lt-size:${p.size}px"><div class="lyrics">${linesHtml(chart)}</div></div>`
        : `<div class="lt-none"><p class="muted">${matches.length ? '' : 'No chord chart for this song.'} Pick any chord chart:</p>
        <input type="search" class="lt-q" placeholder="Find a chord chart" value="${esc(q)}" aria-label="Find a chord chart">
        <div class="lt-list">${list().map((c) => `<button data-lt="chart" data-id="${c.id}">${esc(c.title)}${c.artist ? ` <small>· ${esc(c.artist)}</small>` : ''}</button>`).join('') || '<p class="muted">No chord chart with that name.</p>'}</div></div>`}`;
    const s = el.querySelector('.lt-q');
    if (s) s.oninput = (e) => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = el.querySelector('.lt-q'); n?.focus(); n?.setSelectionRange(pos, pos); };
    const sel = el.querySelector('.lt-pick');
    if (sel) sel.onchange = () => { if (!sel.value) { chart = null; q = ''; } else use(sel.value); draw(); };
  };
  const use = (id) => {
    chart = all().find((c) => c.id === id) || null;
    try { if (chart) localStorage.setItem(chartKey(it.id), chart.id); } catch {}
  };
  const toggle = (v = !p.open) => { p.open = v; savePrefs(p); draw(); button(); };
  const act = (a, b) => {
    if (a === 'toggle') return toggle();
    if (a === 'min') { min = !min; return layout(); }
    if (a === 'chords') { p.chords = !p.chords; savePrefs(p); return draw(); }
    if (a === 'smaller' || a === 'bigger') { p.size = Math.max(11, Math.min(30, p.size + (a === 'bigger' ? 2 : -2))); savePrefs(p); return draw(); }
    if (a === 'chart') { use(b.dataset.id); return draw(); }
    if (a === 'use') {
      const t = picked() || lastText;
      if (!t) return toast('Select a line or a phrase in the lyrics text first');
      onUse(t);
    }
  };
  const onClick = (e) => { const b = e.target.closest('[data-lt]'); if (b && !b.disabled) act(b.dataset.lt, b); };
  el.addEventListener('click', onClick);
  // the button must not drop the words selected
  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-lt="use"]')) e.preventDefault(); });
  const onPanel = (e) => { if (e.target.closest('[data-lt="toggle"]')) toggle(); };
  panel.addEventListener('click', onPanel);
  const onResize = () => layout();
  addEventListener('resize', onResize);
  const button = () => {
    const b = panel.querySelector('.np-lt');
    if (b) { b.classList.toggle('on', p.open); b.setAttribute('aria-pressed', String(p.open)); }
  };
  draw();
  return {
    // the "Lyrics text" button in the edit bar (drawn again with it)
    drawn(row) {
      if (!row || row.querySelector('.np-lt')) return;
      const b = document.createElement('button');
      b.className = 'icon-btn np-lt';
      b.dataset.lt = 'toggle';
      b.title = 'Lyrics text: the words and chords of this song beside the score';
      b.setAttribute('aria-label', 'Lyrics text');
      b.innerHTML = iconOn('text');
      (row.querySelector('[data-a="undo"]') || row.lastElementChild)?.before(b);
      button();
    },
    refresh: draw,
    get open() { return p.open; }, get chart() { return chart; }, get matches() { return matches; },
    destroy() {
      closed = true;
      document.removeEventListener('selectionchange', onSelChange);
      removeEventListener('resize', onResize);
      panel.removeEventListener('click', onPanel);
      el.remove();
      host.classList.remove('lt-on', 'lt-side', 'lt-drawer');
    },
  };
}
