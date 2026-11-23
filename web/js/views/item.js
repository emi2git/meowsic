// One item (sheet, chord chart or score): header, toolbar, body, Info popup (info.js).
import { store } from '../store.js';
import { $, esc, iconOn, menu, CAT } from '../ui.js';
import { go, HOME } from '../app.js';
import { rename } from './actions.js';
import { openInfo } from './info.js';
import { autoTag } from './autotag.js';
import { sheetBody, sheetToolbar, sheetExtraMenu, startInk } from './sheet.js';
import { chordsBody, chordsToolbar } from './chordsview.js';
import { scoreBody, scoreToolbar, scoreExportMenu, scoreTools } from './score.js';

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
        <h1 class="item-title" id="it-title" title="${esc(it.title)}${it.artist ? ' — ' + esc(it.artist) : ''} (tap to rename)">${esc(it.title)}</h1>
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
  // "Page n of N": scores / chord charts shown as pages on iPad / iPhone (sheets show page dots instead)
  $('.viewer', main).addEventListener('pagechange', (e) => {
    const { show, pages } = e.detail;
    const el = $('#pageno', main);
    if (el) el.textContent = `Page ${show.join('–')} of ${pages}`;
  });
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

  // ⋯ = Info only: the popup shows and edits everything, and holds the item's actions (info.js)
  const info = () => openInfo(it.id, {
    anchor: $('#it-more', main),
    tools: [...(store.mode === 'server' ? [{ label: 'Auto-tag…', icon: 'tag', run: () => autoTag([it.id]) }] : []), ...(it.kind === 'sheet' ? sheetExtraMenu(it, view) : it.kind === 'score' ? scoreTools(it, view) : [])],
    exports: it.kind === 'score' ? scoreExportMenu(it, view) : [],
  });
  $('#it-title', main).onclick = () => rename(it.id);
  $('#it-more', main).onclick = (e) => menu(e.currentTarget, [{ label: 'Info', icon: 'info', run: info }]);

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
    // page files renamed (title change), regrouped, reordered or deleted on the Mac (Organize pages): draw the pages again
    const pf = filesKey();
    if (pf !== lastFiles) { lastFiles = pf; view?.redraw?.(); }
  });
  const opened = Date.now();
  return () => { document.removeEventListener('keydown', zoomKey); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); off(); offBar?.(); view.destroy(); store.logPlay(it.id, opened, Date.now()); };
}
