// One item (sheet, chord chart or score): header, toolbar, body, Info popup (info.js).
import { store } from '../store.js';
import { $, esc, iconOn, CAT } from '../ui.js';
import { go, HOME } from '../app.js';
import { viewerMenu } from './actions.js';
import { openInfo } from './info.js';
import { sheetBody, sheetToolbar, sheetTools, sheetExports, startInk } from './sheet.js';
import { chordsBody, chordsToolbar, chordsExports } from './chordsview.js';
import { scoreBody, scoreToolbar, scoreExportMenu, scoreTools } from './score.js';
import { verifiedBadgeHtml, wireVerified } from './verified.js';
import { quickFeedbackButton, closeQuickFeedback } from '../quickfeedback.js';

export function itemView(main, { parts }) {
  const it = store.get(parts[1]);
  if (!it) {
    main.innerHTML = `<div class="empty big">${CAT}<p>This item is not in the library.</p><a class="btn" href="${HOME}">Back to library</a></div>`;
    return;
  }
  const back = history.length > 1 ? 'javascript:history.back()' : HOME;
  main.innerHTML = `
    <div class="viewer k-${it.kind}">
      <header class="top item-top">
        <a class="icon-btn back" href="${back}" aria-label="Back">‹ Back</a>
        <h1 class="item-title" id="it-title" title="${esc(it.title)}${it.artist ? ' — ' + esc(it.artist) : ''} (tap for Info)">${esc(it.title)}</h1>
        ${it.kind === 'score' ? verifiedBadgeHtml(it) : ''}
        <div class="toolbar inline" id="it-bar"></div>
        ${document.fullscreenEnabled || document.webkitFullscreenEnabled ? `<button class="icon-btn" id="it-full" aria-label="Full screen" title="Full screen">${iconOn('perform')}</button>` : ''}
        <button class="icon-btn" id="it-more" aria-label="More" title="More">${iconOn('more')}</button>
      </header>
      <div class="viewer-body">
        <div class="scroll-host" id="it-body"></div>
      </div>
    </div>`;

  const body = $('#it-body', main), bar = $('#it-bar', main);
  let view, offBar;
  // Verified (scores): tag-backed toggle beside the title
  const drawVerified = $('#it-verified', main) ? wireVerified($('#it-verified', main), it.id) : null;
  if (it.kind === 'sheet') {
    view = sheetBody(body, it);
    sheetToolbar(bar, it, view);
    view.goTo(1);
  } else if (it.kind === 'chords') {
    view = chordsBody(body, it);
    offBar = chordsToolbar(bar, it, view);
  } else {
    view = scoreBody(body, it);
    view.ready.then(() => { offBar = scoreToolbar(bar, it, view); });
    bar.innerHTML = '<span class="muted">Drawing the score…</span>';
    // annotate scores too
    const ink = document.createElement('button');
    ink.className = 'icon-btn ink-toggle';
    ink.innerHTML = iconOn('write');
    ink.title = 'Annotate';
    ink.setAttribute('aria-label', 'Annotate');
    ink.onclick = () => startInk(view, $('.viewer', main));
    $('#it-more', main).before(ink);
  }

  // speech bubble: quick feedback about this item (quickfeedback.js)
  ($('#it-full', main) || $('#it-more', main)).before(quickFeedbackButton(it, () => view));

  // ⋯ = Info · the kind's tools · Export ▸ · Move to Trash (actions.viewerMenu); Info is where everything is edited
  $('#it-title', main).onclick = () => openInfo(it.id);
  $('#it-more', main).onclick = (e) => viewerMenu(e.currentTarget, it.id, it.kind === 'sheet' ? { tools: sheetTools(it, view), exports: sheetExports(it, view) }
    : it.kind === 'score' ? { tools: scoreTools(it, view), exports: scoreExportMenu(it, view) } : { exports: chordsExports(it) });

  // full screen: hides the browser's tabs and address bar; press again or Esc to leave
  $('#it-full', main)?.addEventListener('click', () => {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  });
  // keyboard: + zooms in, − zooms out (sheet, score, chord text)
  const zoomKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input,textarea,select')) return;
    if (e.key === '0') { e.preventDefault(); if (it.kind === 'sheet') view.zoomReset(); else if (it.kind === 'score') view.zoomReset(); else view.setSize(18); return; }
    const d = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    if (it.kind === 'sheet') view.zoomBy(d);
    else if (it.kind === 'score') view.setZoom(view.zoom + d * 0.15);
    else view.setSize(view.size + d * 2);
  };
  document.addEventListener('keydown', zoomKey);
  const filesKey = () => (it.pageFiles || []).join('|') + '#' + (it.pages || 0) + '#' + (it.pageFiles?.length ? it.updatedAt : '');
  let lastFiles = filesKey();
  const off = store.on(() => {
    if (!store.get(it.id) || it.deleted) return go(HOME);
    $('#it-title', main).textContent = it.title;
    drawVerified?.();
    // page files renamed (title change), regrouped, reordered or deleted on the Mac (Organize pages): draw the pages again
    const pf = filesKey();
    if (pf !== lastFiles) { lastFiles = pf; view?.redraw?.(); }
  });
  const offFit = it.kind === 'sheet' ? null : fitBar($('.item-top', main), bar, $('.viewer', main));
  const opened = Date.now();
  return () => { offFit?.(); closeQuickFeedback(); document.removeEventListener('keydown', zoomKey); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); off(); offBar?.(); view.destroy(); store.logPlay(it.id, opened, Date.now()); };
}

// Score and chord chart toolbars never clip: their controls keep their natural size, and when the
// header can't hold the title (at least TITLE_MIN), the toolbar and the header's buttons in one row,
// the toolbar takes its own row under the title (.bar-row), wrapping there if even that is too narrow.
// Measured from natural widths, so the answer is the same in either layout (no flip-flop).
// Always their own row: phone width (any kind), and an iPad score below 1100px (portrait), as app.css has it.
const TITLE_MIN = 140;
const narrowQ = matchMedia('(max-width: 760px)'), tabletQ = matchMedia('(max-width: 1100px)');
function fitBar(top, bar, viewer) {
  const ownRow = () => narrowQ.matches || (viewer.classList.contains('k-score') && document.documentElement.dataset.device === 'tablet' && tabletQ.matches);
  const gapOf = (el) => parseFloat(getComputedStyle(el).columnGap) || 0;
  const shown = (el) => el.offsetParent !== null;
  // first the normal spacing, then tighter (.bar-tight), then its own row
  const measure = () => {
    if (!top.isConnected) return;
    const cl = viewer.classList;
    cl.remove('bar-tight');
    cl.toggle('bar-row', ownRow());
    if (ownRow() || fits()) return;
    cl.add('bar-tight');
    if (fits()) return;
    cl.remove('bar-tight');
    cl.add('bar-row');
  };
  const fits = () => {
    const kids = [...bar.children].filter(shown);
    const need = kids.reduce((s, k) => s + k.offsetWidth, 0) + gapOf(bar) * Math.max(0, kids.length - 1);
    const title = top.querySelector('.item-title');
    const others = [...top.children].filter((k) => k !== bar && k !== title && shown(k));
    const cs = getComputedStyle(top);
    const room = top.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const used = others.reduce((s, k) => s + k.offsetWidth, 0) + gapOf(top) * (others.length + 1) + Math.min(title?.scrollWidth || 0, TITLE_MIN);
    return need + used <= room;
  };
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
  ro?.observe(top);
  // the toolbar fills in after the score is drawn; buttons show and hide (hands, Play chords, Voice)
  const mo = new MutationObserver(later);
  mo.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  measure();
  return () => { cancelAnimationFrame(raf); ro?.disconnect(); mo.disconnect(); };
}
