// Print: an item, a selection or a tag, as a book. An even-length piece that would start on a
// right-hand page gets a blank before it, so it needs the fewest page turns.
import { store } from '../store.js';
import { $, esc, icon, badge, CAT, toast } from '../ui.js';
import { pageSrc } from './sheet.js';
import { sheetUrl } from '../sheet-art.js';
import { linesHtml, diagramsHtml } from '../chordchart.js';

const LINES_PER_PAGE = { A4: 34, Letter: 32 };
export function printedPages(it, paper = 'A4') {
  if (it.kind === 'sheet') return it.pages;
  if (it.kind === 'score') return Math.max(1, Math.ceil((it.tune === 'grace' ? 9 : 12) / 10));
  const n = (it.lines || []).filter((l) => l.t !== 'blank').length + (it.lines || []).filter((l) => l.t === 'line' && l.parts.some((p) => p.chord)).length * 0.6;
  return Math.max(1, Math.ceil(n / LINES_PER_PAGE[paper]));
}

let opts = { paper: 'A4', facing: true };
try { Object.assign(opts, JSON.parse(localStorage.getItem('meowsic-print') || '{}')); } catch {}

function sourceOf(q) {
  const tags = (q.get('tags') || q.get('tag') || '').split(',').filter(Boolean);
  if (tags.length) return { name: `Tag${tags.length > 1 ? 's' : ''}: ${tags.join(' + ')}`, ids: store.tagItems(tags).map((x) => x.id) };
  if (q.get('items')) return { name: 'Selected music', ids: q.get('items').split(',') };
  const it = store.get(q.get('item'));
  return { name: it?.title || 'Print', ids: it ? [it.id] : [] };
}

// -> [{blank} | {it, page, of}]
function layout(items) {
  const out = [];
  for (const it of items) {
    const n = printedPages(it, opts.paper);
    // A blank only saves a page turn when a piece has an even number of pages and would start on a
    // right-hand page (page 1, 3, 5… of the book). Odd-length pieces need the same turns either way.
    if (opts.facing && n > 1 && n % 2 === 0 && out.length % 2 === 0) out.push({ blank: true, before: it.title });
    for (let p = 1; p <= n; p++) out.push({ it, page: p, of: n });
  }
  return out;
}

function pageHtml(pg, full) {
  if (pg.blank) return `<div class="pp blank">${full ? '' : '<span>Blank</span>'}</div>`;
  const { it, page, of } = pg;
  if (it.kind === 'sheet') return `<div class="pp"><img src="${pageSrc(it, page)}" alt=""></div>`;
  if (it.kind === 'score') return `<div class="pp"><img src="${sheetUrl(it.title + ' score', page, of, { artist: it.artist })}" alt=""></div>`;
  // chord chart: frame, chords at the top of every page, one small cat bottom-right
  return `<div class="pp chordpage"><div class="frame">
      ${page === 1 ? `<h1>${esc(it.title)}</h1><p class="meta">${esc(it.artist || '')}</p>` : `<p class="meta">${esc(it.title)} (${page}/${of})</p>`}
      <div class="diagrams">${diagramsHtml(it)}</div>
      ${full || page === 1 ? `<div class="lyrics">${linesHtml(it)}</div>` : '<div class="lyrics muted">…</div>'}</div></div>`;
}

export function printView(main, { q }) {
  const src = sourceOf(q);
  main.innerHTML = `<header class="top"><button class="icon-btn back" onclick="history.back()" aria-label="Back">‹ Back</button><h1>Print · ${esc(src.name)}</h1><span class="grow"></span>
      <button class="primary" id="pr-go">${icon('print')}Print</button></header>
    <div class="toolbar">
      <label class="ctl">Paper <select id="pr-paper"><option ${opts.paper === 'A4' ? 'selected' : ''}>A4</option><option ${opts.paper === 'Letter' ? 'selected' : ''}>Letter</option></select></label>
      <label class="ctl check"><input type="checkbox" id="pr-facing" ${opts.facing ? 'checked' : ''}> Facing pages <small>(adds a blank only where it saves a page turn)</small></label>
      <span class="grow"></span><span class="muted" id="pr-sum"></span>
    </div>
    <div class="pad"><ul class="rows compact" id="pr-list"></ul><h3>Preview</h3><div class="spreads" id="pr-prev"></div></div>`;
  const draw = () => {
    const items = src.ids.map((id) => store.get(id)).filter((x) => x && !x.deleted);
    const pages = layout(items);
    const blanks = pages.filter((p) => p.blank).length;
    $('#pr-sum', main).textContent = `${pages.length} pages · ${Math.ceil(pages.length / 2)} sheets of paper double-sided${blanks ? ` · ${blanks} blank${blanks > 1 ? 's' : ''}` : ''}`;
    $('#pr-list', main).innerHTML = items.map((it) => `<li class="row"><div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${badge(it.kind)}<span>${printedPages(it, opts.paper)} page${printedPages(it, opts.paper) > 1 ? 's' : ''}</span></div></div></li>`).join('');
    // book spreads: page 1 is a right-hand page on its own
    const spreads = [[null, pages[0]]];
    for (let i = 1; i < pages.length; i += 2) spreads.push([pages[i], pages[i + 1] || null]);
    $('#pr-prev', main).innerHTML = pages.length ? spreads.map((s, i) => `<div class="spread paper-${opts.paper}">${s.map((p, k) => p ? pageHtml(p) : '<div class="pp none"></div>').join('')}<small>${i === 0 ? 'Cover side' : `Pages ${i * 2}–${i * 2 + 1}`}</small></div>`).join('') : '<p class="muted">Nothing to print.</p>';
    $('#print-root').innerHTML = pages.map((p) => pageHtml(p, true)).join('');
    document.documentElement.dataset.paper = opts.paper;
  };
  const saveOpts = () => { try { localStorage.setItem('meowsic-print', JSON.stringify(opts)); } catch {} draw(); };
  $('#pr-paper', main).onchange = (e) => { opts.paper = e.target.value; saveOpts(); };
  $('#pr-facing', main).onchange = (e) => { opts.facing = e.target.checked; saveOpts(); };
  $('#pr-go', main).onclick = () => {
    if (!src.ids.length) return toast('Nothing to print.');
    window.print();
    store.markPrinted(src.ids);
    store.logEvent('print', src.name, `${src.ids.length} item${src.ids.length === 1 ? '' : 's'}`);
  };
  draw();
  return () => { $('#print-root').innerHTML = ''; };
}
