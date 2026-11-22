// One item (sheet, chord chart or score): header, toolbar, body, details panel.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, mins, CAT } from '../ui.js';
import { go } from '../app.js';
import { itemMenu, editTags, rename, metaText } from './actions.js';
import { sheetBody, sheetToolbar, sheetExtraMenu, startInk } from './sheet.js';
import { chordsBody, chordsToolbar } from './chordsview.js';
import { scoreBody, scoreToolbar, scoreExportMenu } from './score.js';

export function itemView(main, { parts }) {
  const it = store.get(parts[1]);
  if (!it) {
    main.innerHTML = `<div class="empty big">${CAT}<p>This item is not in the library.</p><a class="btn" href="#/library">Back to library</a></div>`;
    return;
  }
  const back = history.length > 1 ? 'javascript:history.back()' : '#/library';
  main.innerHTML = `
    <div class="viewer k-${it.kind}">
      <header class="top item-top">
        <a class="icon-btn back" href="${back}" aria-label="Back">‹ Back</a>
        <h1 class="item-title" id="it-title" title="${esc(it.title)}${it.artist ? ' — ' + esc(it.artist) : ''} (tap to rename)">${esc(it.title)}</h1>
        <div class="toolbar inline" id="it-bar"></div>
        <button class="icon-btn" id="it-more" aria-label="More" title="More">${iconOn('more')}</button>
      </header>
      <div class="viewer-body">
        <div class="scroll-host" id="it-body"></div>
        <aside class="details" id="it-details" hidden></aside>
      </div>
    </div>`;

  const body = $('#it-body', main), bar = $('#it-bar', main);
  let view, offBar;
  if (it.kind === 'sheet') {
    view = sheetBody(body, it);
    sheetToolbar(bar, it, view);
    $('.viewer', main).addEventListener('pagechange', (e) => {
      const { show, pages } = e.detail;
      const el = $('#pageno', main);
      if (el) el.textContent = `Page ${show.join('–')} of ${pages}`;
    });
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
      <div class="details-head"><h2>Details</h2><button class="icon-btn" id="dt-close" aria-label="Close details">Close</button></div>
      <dl>
        <dt>Type</dt><dd>${badge(it.kind)} ${metaText(it)}</dd>
        ${it.kind === 'chords' ? `<dt>Source</dt><dd><a href="${esc(it.url)}" target="_blank" rel="noopener">${it.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : 'Ultimate Guitar'}</a></dd>` : ''}
        ${it.kind === 'score' ? `<dt>Made from</dt><dd>${esc(it.source)}<br><small>${it.bpm} bpm</small></dd>` : ''}
        <dt>Tags</dt><dd><div class="row-tags">${it.tags.map((t) => `<a class="tagchip" href="#/library?tags=${encodeURIComponent(t)}">${esc(t)}</a>`).join('') || '<span class="muted">None</span>'}</div><button class="link" id="dt-tags">Edit tags</button></dd>
        <dt>Practice</dt><dd>${plays.length} session${plays.length === 1 ? '' : 's'} · ${mins(total)}<br><small>Last played ${ago(store.lastPlayed(it.id))}</small></dd>
        <dt>Added</dt><dd>${new Date(it.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
      </dl>`;
    $('#dt-close', details).onclick = () => (details.hidden = true);
    $('#dt-tags', details).onclick = () => editTags(it.id);
  };
  const toggleDetails = () => { details.hidden = !details.hidden; if (!details.hidden) drawDetails(); };
  $('#it-title', main).onclick = () => rename(it.id);
  $('#it-more', main).onclick = (e) => itemMenu(e.currentTarget, it.id, [
    { label: 'Details', icon: 'info', run: toggleDetails },
    ...(it.kind === 'sheet' ? sheetExtraMenu(it, view) : []),
    ...(it.kind === 'score' ? scoreExportMenu(it, view) : []),
  ]);

  const off = store.on(() => {
    if (!store.get(it.id) || it.deleted) return go('#/library');
    $('#it-title', main).textContent = it.title;
    if (!details.hidden) drawDetails();
  });
  const opened = Date.now();
  return () => { off(); offBar?.(); view.destroy(); store.logPlay(it.id, opened, Date.now()); };
}
