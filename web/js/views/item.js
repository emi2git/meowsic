// One item (sheet, chord chart or score): header, toolbar, body, details panel.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, mins, CAT, scoreSource, toast } from '../ui.js';
import { go, HOME } from '../app.js';
import { itemMenu, editTags, rename, metaText, verLabel, verDetail, SHEET_VERSIONS, editKey } from './actions.js';
import { autoTag } from './autotag.js';
import { sheetBody, sheetToolbar, sheetExtraMenu, startInk } from './sheet.js';
import { chordsBody, chordsToolbar } from './chordsview.js';
import { scoreBody, scoreToolbar, scoreExportMenu, scoreTools } from './score.js';
import { VERSIONS } from '../musicxml.js';

const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
// the item's original date: when the photo was taken / the file was made / the score transcribed / the chords fetched
function originRow(it) {
  const label = it.kind === 'sheet' ? (it.source === 'pdf' || !it.pageDates?.some(Boolean) && it.fileDate ? 'File date' : 'Photo taken')
    : it.kind === 'score' ? (it.source?.startsWith('From the score') ? 'Made' : 'Transcribed') : it.source === 'pasted' ? 'Pasted' : 'Fetched from the web';
  const t = it.originAt || (it.kind === 'sheet' ? it.pageDates?.find(Boolean) : null) || it.createdAt;
  const pages = it.kind === 'sheet' && it.pageDates?.length > 1 && new Set(it.pageDates.filter(Boolean).map((d) => new Date(d).toDateString())).size > 1
    ? `<br><small>Pages taken ${it.pageDates.map((d, i) => `${i + 1}: ${d ? new Date(d).toLocaleDateString() : '—'}`).join(' · ')}</small>` : '';
  return `<dt>${label}</dt><dd>${fmtDate(t)}${pages}</dd>`;
}

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
        <aside class="details" id="it-details" hidden></aside>
      </div>
    </div>`;

  const body = $('#it-body', main), bar = $('#it-bar', main);
  let view, offBar;
  // "Page n of N": sheets, and scores / chord charts shown as pages on iPad / iPhone
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

  const details = $('#it-details', main);
  const drawDetails = () => {
    const plays = store.plays(it.id);
    const total = plays.reduce((s, p) => s + (p.closedAt - p.openedAt), 0);
    details.innerHTML = `
      <div class="details-head"><h2>Info</h2><button class="icon-btn" id="dt-close" aria-label="Close info">Close</button></div>
      <dl>
        <dt>Type</dt><dd>${badge(it)} ${metaText(it)}</dd>
        ${it.kind === 'sheet' ? `<dt>File</dt><dd>${it.source === 'pdf' ? 'PDF' : 'Photos (images)'}</dd>` : ''}
        ${it.kind === 'chords' ? `<dt>Source</dt><dd><a href="${esc(it.url)}" target="_blank" rel="noopener">${it.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : 'Ultimate Guitar'}</a></dd>` : ''}
        ${it.kind === 'score' ? ((s) => `<dt>Source</dt><dd id="dt-source"><span class="src-name">${esc(s.name || '—')}</span>${s.url ? `<br><a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><br><button class="link" id="dt-copy">Copy link</button>` : ''}${it.bpm ? `<br><small>${it.bpm} bpm</small>` : ''}</dd>`)(scoreSource(it)) : ''}
        ${it.kind === 'sheet' ? `<dt>Version</dt><dd><div class="seg ver-seg" id="dt-ver" role="radiogroup" aria-label="Version">${Object.entries(SHEET_VERSIONS).map(([v, l]) =>
          `<button role="radio" aria-checked="${it.version === v}" class="${it.version === v ? 'on' : ''}" data-ver="${v}">${l}</button>`).join('')}</div>${it.version ? '' : '<small class="muted">Not set</small>'}</dd>` : ''}
        ${it.kind === 'score' ? `<dt>Version</dt><dd id="dt-ver">${esc(verLabel(it))}${verDetail(it) !== verLabel(it) ? `<br><small class="muted" title="${esc(VERSIONS[it.version] || '')}">${esc(verDetail(it))}</small>` : ''}</dd>` : ''}
        ${it.kind === 'sheet' ? `<dt>Key</dt><dd id="dt-key"><span class="key-val">${esc(it.key || '') || '<span class="muted">Not set</span>'}</span> <button class="link" id="dt-key-edit">${it.key ? 'Change' : 'Set key'}</button></dd>` : ''}
        <dt>Tags</dt><dd><div class="row-tags">${it.tags.map((t) => `<a class="tagchip" href="#/library?tags=${encodeURIComponent(t)}">${esc(t)}</a>`).join('') || '<span class="muted">None</span>'}</div><button class="link" id="dt-tags">Edit tags</button></dd>
        <dt>Practice</dt><dd>${plays.length} session${plays.length === 1 ? '' : 's'} · ${mins(total)}<br><small>Last played ${ago(store.lastPlayed(it.id))}</small></dd>
        ${originRow(it)}
        <dt>Added</dt><dd>${fmtDate(it.createdAt)}</dd>
      </dl>`;
    $('#dt-close', details).onclick = () => (details.hidden = true);
    $('#dt-tags', details).onclick = () => editTags(it.id);
    $('#dt-key-edit', details)?.addEventListener('click', () => editKey(it.id));
    // tap a word to set it; tap the lit one again to clear it
    $('#dt-ver.ver-seg', details)?.addEventListener('click', (e) => { const b = e.target.closest('[data-ver]'); if (b) store.setVersion(it.id, it.version === b.dataset.ver ? '' : b.dataset.ver); });
    const cp = $('#dt-copy', details);
    if (cp) cp.onclick = () => { const url = scoreSource(it).url; (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Link copied'), () => prompt('Copy the link', url)); };
  };
  const toggleDetails = () => { details.hidden = !details.hidden; if (!details.hidden) drawDetails(); };
  $('#it-title', main).onclick = () => rename(it.id);
  $('#it-more', main).onclick = (e) => itemMenu(e.currentTarget, it.id, {
    viewer: true, info: toggleDetails,
    tools: [...(store.mode === 'server' ? [{ label: 'Auto-tag…', icon: 'tag', run: () => autoTag([it.id]) }] : []), ...(it.kind === 'sheet' ? sheetExtraMenu(it, view) : it.kind === 'score' ? scoreTools(it, view) : [])],
    exports: it.kind === 'score' ? scoreExportMenu(it, view) : [],
  });

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
  let lastFiles = (it.pageFiles || []).join('|');
  const off = store.on(() => {
    if (!store.get(it.id) || it.deleted) return go(HOME);
    $('#it-title', main).textContent = it.title;
    if (!details.hidden) drawDetails();
    // page files renamed (title change) or regrouped on the Mac: draw the pages again from the new names
    const pf = (it.pageFiles || []).join('|');
    if (pf !== lastFiles) { lastFiles = pf; view?.redraw?.(); }
  });
  const opened = Date.now();
  return () => { document.removeEventListener('keydown', zoomKey); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); off(); offBar?.(); view.destroy(); store.logPlay(it.id, opened, Date.now()); };
}
