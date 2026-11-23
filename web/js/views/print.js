// Print: an item, a selection or a tag, as a book. An even-length piece that would start on a
// right-hand page gets a blank before it, so it needs the fewest page turns.
import { store } from '../store.js';
import { $, esc, icon, badge, CAT, toast } from '../ui.js';
import { pageSrc } from './sheet.js';
import { sheetUrl } from '../sheet-art.js';
import { linesHtml, diagramsHtml } from '../chordchart.js';
import { loadOsmd } from './score.js';
import { TUNES } from '../mock.js';
import { musicXml } from '../musicxml.js';
import { easyOn, creditOf, decoratePrintPage, PRINT_ROOM } from '../easyscore.js';

// scores print as real notation: OSMD lays the MusicXML out on A4 pages; each page is an SVG
const scorePagesCache = new Map(); // item id (+ easy look) → [svg markup per page]
const ck = (it) => it.id + (easyOn(it) ? '|easy' : '');
async function scorePages(it) {
  if (scorePagesCache.has(ck(it))) return scorePagesCache.get(ck(it));
  let xml;
  if (it.tune && TUNES[it.tune]) xml = musicXml({ ...TUNES[it.tune], ...(it.measures ? { measures: it.measures } : {}), title: it.title }, it.version || 'original');
  else { const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml`); if (!r.ok) return null; xml = await r.text(); }
  await loadOsmd();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px';
  document.body.append(box);
  try {
    // the "super easy piano" look (AI Studio, or switched on in the score's ⋯ menu): sans text, room under the title
    const easy = easyOn(it);
    const osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(box, { backend: 'svg', autoResize: false, drawTitle: true, drawSubtitle: !easy, drawPartNames: !easy, drawComposer: !easy, drawMetronomeMarks: !easy, pageFormat: 'A4_P', pageBackgroundColor: '#FFFFFF' });
    if (easy) { const r = osmd.EngravingRules; r.DefaultFontFamily = 'Helvetica Neue, Helvetica, Arial, sans-serif'; r.TitleBottomDistance += PRINT_ROOM; r.InstantaneousTempoTextHeight = 1.7; r.UnknownTextHeight = 1.7; r.MinNoteDistance = 2.6; }
    await osmd.load(xml);
    if (it.transpose) { osmd.TransposeCalculator = new window.opensheetmusicdisplay.TransposeCalculator(); osmd.Sheet.Transpose = it.transpose; osmd.updateGraphic(); }
    osmd.render();
    if (easy) { const first = box.querySelector('svg'); if (first) decoratePrintPage(osmd, first, { title: osmd.Sheet.TitleString || it.title, credit: creditOf(xml) || (it.source === 'Meowsic AI' || it.ai ? 'Meowsic AI' : it.tune ? it.artist || '' : '') }); }
    const pages = [...box.querySelectorAll('svg')].map((svg) => { svg.setAttribute('preserveAspectRatio', 'xMidYMin meet'); svg.removeAttribute('height'); svg.setAttribute('width', '100%'); return svg.outerHTML; });
    scorePagesCache.set(ck(it), pages);
    return pages;
  } catch { return null; } finally { box.remove(); }
}

const LINES_PER_PAGE = { A4: 34, Letter: 32 };
export function printedPages(it, paper = 'A4') {
  if (it.kind === 'sheet') return it.pages;
  if (it.kind === 'score') return scorePagesCache.get(ck(it))?.length || 1;
  const n = (it.lines || []).filter((l) => l.t !== 'blank').length + (it.lines || []).filter((l) => l.t === 'line' && l.parts.some((p) => p.chord)).length * 0.6;
  return Math.max(1, Math.ceil(n / LINES_PER_PAGE[paper]));
}

let opts = { paper: 'A4', facing: true, cover: false }; // paper is always A4
try { Object.assign(opts, JSON.parse(localStorage.getItem('meowsic-print') || '{}'), { paper: 'A4' }); } catch {}

function sourceOf(q) {
  const tags = (q.get('tags') || q.get('tag') || '').split(',').filter(Boolean);
  if (tags.length) return { name: `Tag${tags.length > 1 ? 's' : ''}: ${tags.join(' + ')}`, ids: store.tagItems(tags).map((x) => x.id) };
  if (q.get('items')) return { name: 'Selected music', ids: q.get('items').split(',') };
  const it = store.get(q.get('item'));
  return { name: it?.title || 'Print', ids: it ? [it.id] : [] };
}

// -> [{blank} | {it, page, of}]
function layout(items, name) {
  const out = [];
  if (opts.cover) out.push({ cover: true, name, items });
  for (const it of items) {
    const n = printedPages(it, opts.paper);
    // A blank only saves a page turn when a piece has an even number of pages and would start on a
    // right-hand page (page 1, 3, 5… of the book). Odd-length pieces need the same turns either way.
    if (opts.facing && n > 1 && n % 2 === 0 && out.length % 2 === 0) out.push({ blank: true, before: it.title });
    for (let p = 1; p <= n; p++) out.push({ it, page: p, of: n });
  }
  // song list on the cover: where each piece starts
  if (opts.cover) out[0].toc = items.map((it) => ({ title: it.title, artist: it.artist, page: out.findIndex((x) => x.it === it && x.page === 1) + 1 }));
  return out;
}

function pageHtml(pg, full) {
  if (pg.cover) return `<div class="pp coverpage"><div class="frame"><h1>${esc(pg.name.replace(/^Tags?: /, ''))}</h1>
    <p class="meta">${pg.items.length} piece${pg.items.length === 1 ? '' : 's'}</p>
    <ol class="toc">${(pg.toc || []).map((t) => `<li><span>${esc(t.title)}${t.artist ? ` <small>· ${esc(t.artist)}</small>` : ''}</span><i>${t.page}</i></li>`).join('')}</ol></div></div>`;
  if (pg.blank) return `<div class="pp blank">${full ? '' : '<span>Blank</span>'}</div>`;
  const { it, page, of } = pg;
  if (it.kind === 'sheet') return `<div class="pp"><img src="${pageSrc(it, page)}" alt=""></div>`;
  if (it.kind === 'score') { const svg = scorePagesCache.get(ck(it))?.[page - 1]; return svg ? `<div class="pp scorepage">${svg}</div>` : `<div class="pp scorepage loading"><span>Laying out…</span></div>`; }
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
      <label class="ctl check"><input type="checkbox" id="pr-facing" ${opts.facing ? 'checked' : ''}> Facing pages <small>(adds a blank only where it saves a page turn)</small></label>
      <label class="ctl check"><input type="checkbox" id="pr-cover" ${opts.cover ? 'checked' : ''}> Cover page with song list</label>
      <span class="grow"></span><span class="muted" id="pr-sum"></span>
    </div>
    <div class="pad"><ul class="rows compact" id="pr-list"></ul><h3>Preview</h3><div class="spreads" id="pr-prev"></div></div>`;
  const draw = () => {
    const items = src.ids.map((id) => store.get(id)).filter((x) => x && !x.deleted);
    const pages = layout(items, src.name);
    const blanks = pages.filter((p) => p.blank).length;
    $('#pr-sum', main).textContent = `${pages.length} pages · ${Math.ceil(pages.length / 2)} sheets of paper double-sided${blanks ? ` · ${blanks} blank${blanks > 1 ? 's' : ''}` : ''}`;
    $('#pr-list', main).innerHTML = items.map((it) => `<li class="row"><div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${badge(it)}<span>${printedPages(it, opts.paper)} page${printedPages(it, opts.paper) > 1 ? 's' : ''}</span></div></div></li>`).join('');
    // book spreads: page 1 is a right-hand page on its own
    const spreads = [[pages[0]]];
    for (let i = 1; i < pages.length; i += 2) spreads.push([pages[i], pages[i + 1] || null]);
    $('#pr-prev', main).innerHTML = pages.length ? spreads.map((s, i) => `<div class="spread paper-${opts.paper}">${s.map((p, k) => p ? pageHtml(p) : '<div class="pp none"></div>').join('')}<small>${i === 0 ? 'Page 1' : `Pages ${i * 2}–${Math.min(i * 2 + 1, pages.length)}`}</small></div>`).join('') : '<p class="muted">Nothing to print.</p>';
    $('#print-root').innerHTML = pages.map((p) => pageHtml(p, true)).join('');
    document.documentElement.dataset.paper = opts.paper;
  };
  const saveOpts = () => { try { localStorage.setItem('meowsic-print', JSON.stringify(opts)); } catch {} draw(); };
  $('#pr-facing', main).onchange = (e) => { opts.facing = e.target.checked; saveOpts(); };
  $('#pr-cover', main).onchange = (e) => { opts.cover = e.target.checked; saveOpts(); };
  $('#pr-go', main).onclick = () => {
    if (!src.ids.length) return toast('Nothing to print.');
    window.print();
    store.markPrinted(src.ids);
    store.logEvent('print', src.name, `${src.ids.length} item${src.ids.length === 1 ? '' : 's'}`);
  };
  draw();
  // lay out the scores, then redraw with their real page counts
  Promise.all(src.ids.map((id) => store.get(id)).filter((x) => x && x.kind === 'score' && !scorePagesCache.has(ck(x))).map(scorePages)).then((r) => { if (r.length && main.isConnected) draw(); });
  return () => { $('#print-root').innerHTML = ''; };
}
