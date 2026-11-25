// Chord chart viewer: easiest-key default, key list with original marked, ukulele diagrams
// pinned at the top, text size, auto-scroll (used in performance mode).
import { store } from '../store.js';
import { $, esc, icon, iconOn } from '../ui.js';
import { keyInfo, keyAt, STEPS, linesHtml, diagramsHtml } from '../chordchart.js';
import { attachSwipe, flipBy } from '../swipe.js';
import { isTouch } from '../device.js';
import { paginate, pageOfBlock, showPage, pagerInput } from '../pager.js';
import { printEntry, download } from './actions.js';

let size = 18;
try { size = +localStorage.getItem('meowsic-chord-size') || 18; } catch {}

export function chordsBody(root, it, { perform = false } = {}) {
  // iPad / iPhone: no scrolling; the chord diagrams stay on top of every page and the lines are
  // cut into pages that fit under them, turned like a sheet's
  const paged = isTouch() && !perform;
  root.innerHTML = `<div class="chart ${perform ? 'perform' : ''} ${paged ? 'paged' : ''}" id="chart" style="--chart-size:${perform ? size + 6 : size}px">
      <div class="diagrams" id="diagrams" aria-label="Ukulele chords"></div>
      <div class="lyrics-box" id="lbox"><div class="lyrics-clip" id="lclip"><div class="lyrics" id="lyrics"></div></div></div>
    </div>`;
  const lyrics = $('#lyrics', root), lclip = $('#lclip', root), lbox = $('#lbox', root);
  let pages = [], page = 0;
  const goPage = (k) => {
    if (!pages.length) return;
    page = Math.max(0, Math.min(pages.length - 1, k));
    showPage(lyrics, lclip, pages[page]);
    root.dispatchEvent(new CustomEvent('pagechange', { detail: { page: page + 1, show: [page + 1], pages: pages.length }, bubbles: true }));
  };
  // one block per line (headings stay with the lines after them); measured with the page at its start
  const repaginate = () => {
    if (!paged) return;
    const anchor = pages[page]?.first ?? 0;
    lyrics.style.transform = '';
    const kids = [...lyrics.children];
    const blocks = kids.map((c) => ({ top: c.offsetTop, bottom: c.offsetTop + c.offsetHeight + (parseFloat(getComputedStyle(c).marginBottom) || 0), keep: c.classList.contains('sec') || c.classList.contains('gap') }));
    pages = blocks.length ? paginate(blocks, lbox.clientHeight) : [{ start: 0, end: lbox.clientHeight, first: 0, last: 0 }];
    goPage(pageOfBlock(pages, Math.min(anchor, Math.max(0, blocks.length - 1))));
  };
  const draw = () => {
    $('#diagrams', root).innerHTML = diagramsHtml(it);
    lyrics.innerHTML = linesHtml(it);
    repaginate();
  };
  draw();
  const ro = paged ? new ResizeObserver(() => repaginate()) : null;
  ro?.observe(root);
  if (paged) document.fonts?.ready.then(() => repaginate());

  let speed = 0, raf = 0, last = 0, acc = 0;
  const scroller = () => root.closest('.scroll-host') || root;
  const tick = (t) => {
    if (!speed) return;
    if (last) {
      acc += ((t - last) / 1000) * speed * 12; // px per second
      const whole = Math.floor(acc);
      if (whole) { scroller().scrollTop += whole; acc -= whole; }
    }
    last = t;
    raf = requestAnimationFrame(tick);
  };
  const off = store.on(draw);
  // iPad / iPhone: swipe left / right or tap the left / right half turns the page; up / down = back
  const offSwipe = perform ? () => {} : paged ? pagerInput(root, { next: () => goPage(page + 1), prev: () => goPage(page - 1) })
    : attachSwipe(root, { scroller, upAtEnd: true, onLeft: () => flipBy(scroller(), 1), onRight: () => flipBy(scroller(), -1) });
  return {
    draw,
    setSize(px) { size = Math.max(12, Math.min(40, px)); root.dispatchEvent(new CustomEvent('zoomchange', { bubbles: true })); try { localStorage.setItem('meowsic-chord-size', size); } catch {} $('#chart', root).style.setProperty('--chart-size', (perform ? size + 6 : size) + 'px'); repaginate(); },
    get size() { return size; },
    setSpeed(s) { speed = s; cancelAnimationFrame(raf); last = 0; if (s) raf = requestAnimationFrame(tick); },
    get speed() { return speed; },
    get page() { return page + 1; }, get pages() { return pages.length; },
    goTo(n) { goPage(n - 1); },
    destroy() { off(); offSwipe(); ro?.disconnect(); cancelAnimationFrame(raf); },
  };
}

export function keySelect(it) {
  const info = keyInfo(it);
  const origStep = 0;
  return `<label class="ctl">Key <select id="cv-key">${STEPS.map((n) => {
    const k = keyAt(info.base, n);
    const marks = [n === origStep ? 'original' : '', n === info.easy ? 'easiest' : ''].filter(Boolean).join(', ');
    return `<option value="${n}" ${n === info.steps ? 'selected' : ''}>${esc(k)}${marks ? ` (${marks})` : ''}</option>`;
  }).join('')}</select></label>`;
}

export function chordsToolbar(bar, it, view) {
  window.__chords = view; // for automated tests (page / pages)
  const drawBar = () => {
    bar.innerHTML = `${keySelect(it)}
      <div class="stepper" aria-label="Text size"><button id="cv-sm" aria-label="Smaller text" title="Smaller (−)">${iconOn('zoomout')}</button><button id="cv-reset" class="zreset" title="Reset size (0)">${Math.round(view.size / 18 * 100)}%</button><button id="cv-lg" aria-label="Larger text" title="Larger (+)">${iconOn('zoomin')}</button></div>`;
    $('#cv-key', bar).onchange = (e) => store.update(it.id, { transpose: +e.target.value });
    const sl = () => ($('#cv-reset', bar).textContent = `${Math.round(view.size / 18 * 100)}%`);
    $('#cv-sm', bar).onclick = () => { view.setSize(view.size - 2); sl(); };
    $('#cv-lg', bar).onclick = () => { view.setSize(view.size + 2); sl(); };
    $('#cv-reset', bar).onclick = () => { view.setSize(18); sl(); };
    bar.closest('.viewer')?.addEventListener('zoomchange', sl);
  };
  drawBar();
  return store.on(() => { if (document.activeElement?.id !== 'cv-key') drawBar(); });
}

// Export ▸ for a chord chart: print (or save as PDF), the chart as text (as it came: original key)
export function chordsExports(it) {
  return [printEntry(it.id), ...(it.text ? [{ label: 'Text file', icon: 'download', run: () => download(`${it.title}.txt`, it.text, 'text/plain;charset=utf-8') }] : [])];
}
