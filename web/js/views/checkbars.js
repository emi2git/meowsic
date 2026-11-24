// Check bars: a score read from a sheet (photo → score) marks the bars it is not sure of — the two readers
// disagreed, or a bar was changed so it adds up (<miscellaneous-field name="meowsic-check-bars"> in the MusicXML;
// GET /api/items/{id}/check adds per bar: why, the other reading(s), and where the bar is on the sheet photo).
// The score toolbar shows "N to check"; tapping it opens a review: one bar at a time (Prev / Next), the bar boxed
// in the score and brought into view, why it is flagged in plain words, the printed bar from the sheet next to it
// (cropped to the bar, or the whole page; tap to zoom), and what to do:
//   Looks right · Use other reading (preview first, then keep it) · Edit notes (that bar, in the note editor) · Play bar;
//   words read too poorly to write ("lyrics unsure"): Fix lyrics (Edit notes in Lyrics mode on that verse and bar; saved →
//   those bars are checked); Mark all as looks right (asks first; one Activities undo).
// Every change is saved into the score with history + Activities undo: Looks right / Use other reading through
// POST /api/items/{id}/check (server/meowsic/barcheck.py; scores without check.json: through Edit notes), note
// edits through Edit notes (server/meowsic/staffmove.py), which marks the bar checked in the same save.
import { esc, iconOn, toast, sheet as modal, confirmSheet } from '../ui.js';
import { store } from '../store.js';
import { go } from '../app.js';
import { pageSrc } from './sheet.js';
import { editNotes, post } from './editnotes.js';
const LYRICS = 'lyrics unsure — use Fit lyrics';

const WHY = 'The two ways of reading the sheet did not agree here, or the bar was changed so its notes add up. Compare it with the printed bar.';
const REASONS = { disagree: 'The two readers disagree about this bar.', filled: 'This bar did not add up, so notes or rests were changed to fill it.',
  taken: 'This bar came from the second reader.', rhythm: 'The note lengths in this bar did not add up.', pitch: 'The readers saw different notes here.' };

// the bars still to check, from the MusicXML
export function markedBars(xml) {
  const m = /<miscellaneous-field[^>]*name="meowsic-check-bars"[^>]*>([^<]*)</.exec(xml || '');
  return m ? [...new Set(m[1].split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number))].sort((a, b) => a - b) : [];
}

// [{bar, reason, alts: [{id, label, measure}], page, box: [x, y, w, h] in the page image's pixels, image, sheetId}];
// list.api = true when the Mac keeps the check (GET /api/items/{id}/check, barcheck.py); without it (404: an older
// score) the bars alone, from the MusicXML
export async function checkList(it, xml) {
  const marked = markedBars(xml);
  let j = null;
  try {
    const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/check`);
    if (r.ok) j = await r.json();
    else await r.text(); // read it all, or the request stays open (through the service worker)
  } catch {}
  const why = (x) => {
    const r = x.reasons ?? x.reason ?? x.why;
    const list = (Array.isArray(r) ? r : r ? [r] : []).map((s) => REASONS[s] || String(s));
    return list.length ? list.map((s) => s[0].toUpperCase() + s.slice(1).replace(/\.?$/, '.')).join(' ') : WHY;
  };
  const pages = new Map((j?.pages || []).map((p) => [p.page, p]));
  const box = (b) => (Array.isArray(b) && b.length === 4 ? [b[0], b[1], b[2] - b[0], b[3] - b[1]] : null); // [x0, y0, x1, y1] → [x, y, w, h]
  const rows = j ? (j.bars || []).filter((x) => x.open !== false) : marked.map((bar) => ({ bar }));
  let out = rows.map((x) => ({
    bar: +x.bar, reason: why(x), page: x.page ?? null, box: box(x.box), image: pages.get(x.page)?.url || null, sheetId: j?.sheetId || null,
    alts: (x.alternatives || []).map((a, k) => ({ id: a.id, label: a.label || `Reading ${k + 2}`, measure: a.musicxml })).filter((a) => a.measure),
    lyrics: x.lyrics?.verse != null ? { verse: String(x.lyrics.verse), bars: (x.lyrics.bars || [x.bar]).map(Number) } : null,
    lyricsOnly: (x.reasons || []).length > 0 && (x.reasons || []).every((r) => r === LYRICS),
  })).filter((x) => x.bar > 0 && marked.includes(x.bar)); // the score says which bars are left
  if (j) for (const bar of marked) if (!out.some((x) => x.bar === bar)) out.push({ bar, reason: WHY, alts: [], page: null, box: null, image: null, sheetId: j.sheetId || null });
  out = out.sort((a, b) => a.bar - b.bar);
  out.api = !!j;
  return out;
}

// where each bar starts and how long it is, in quarters (the part that is edited: piano, else the first)
export function barTimes(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parts = [...doc.querySelectorAll('part')];
  const part = parts.find((p) => [...p.querySelectorAll('attributes > staves')].some((s) => +s.textContent.trim() >= 2)) || parts[0];
  const out = [];
  let div = 1, start = 0;
  for (const m of part ? part.querySelectorAll(':scope > measure') : []) {
    let t = 0, longest = 0;
    for (const e of m.children) {
      if (e.tagName === 'attributes' && e.querySelector('divisions')) div = +e.querySelector('divisions').textContent || 1;
      const d = +(e.querySelector(':scope > duration')?.textContent || 0) / div;
      if (e.tagName === 'backup') t -= d;
      else if (e.tagName === 'forward') { t += d; longest = Math.max(longest, t); }
      else if (e.tagName === 'note' && !e.querySelector('grace') && !e.querySelector('chord')) { t += d; longest = Math.max(longest, t); }
    }
    out.push({ start, len: longest });
    start += longest;
  }
  return out;
}

// the "N to check" button on the score toolbar
export function checkBadge(btn, view, it, host) {
  if (!btn || store.mode !== 'server') return () => {};
  let list = [];
  const refresh = async () => {
    if (!view.real) { btn.hidden = true; return; }
    list = await checkList(it, view.xml());
    btn.hidden = !list.length;
    btn.textContent = `${list.length} to check`;
    btn.title = `${list.length} bar${list.length === 1 ? '' : 's'} the sheet reader was not sure of — tap to check them`;
  };
  btn.onclick = () => { if (list.length) reviewChecks(view, it, host, list, 0, refresh); };
  view.ready.then(refresh);
  host?.addEventListener('checkchange', refresh);
  return () => host?.removeEventListener('checkchange', refresh);
}

export async function reviewChecks(view, it, host, list, start = 0, refreshBadge = () => {}) {
  if (!host || host.querySelector('.cb-panel') || host.querySelector('.notes-panel')) return;
  view.player?.pause();
  const url = `/items/${encodeURIComponent(it.id)}/editnotes`;
  const panel = document.createElement('div');
  panel.className = 'cb-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Check bars');
  host.append(panel);
  host.classList.add('checking');
  let k = Math.max(0, Math.min(start, list.length - 1)), times = barTimes(view.xml()), alt = null, busy = false, closed = false, hl = null, stopAt = null;
  const now = () => list[k];

  // ---- the bar in the score: a box around it, brought into view ----
  const boxBar = () => {
    hl?.remove(); hl = null;
    const osmd = view.osmd, osv = host.querySelector('#osmd'), svg = osv?.querySelector('svg');
    if (!osmd || !svg || !now()) return;
    const gms = (osmd.GraphicSheet.MeasureList[now().bar - 1] || []).filter(Boolean);
    if (!gms.length) return;
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const sr = svg.getBoundingClientRect(), or = osv.getBoundingClientRect();
    const unit = (vb[2] ? sr.width / vb[2] : view.zoom) * 10;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const gm of gms) {
      const ps = gm.PositionAndShape, p = ps.AbsolutePosition;
      x0 = Math.min(x0, p.x + ps.BorderLeft); x1 = Math.max(x1, p.x + ps.BorderRight);
      y0 = Math.min(y0, p.y + ps.BorderTop); y1 = Math.max(y1, p.y + ps.BorderBottom);
    }
    hl = document.createElement('div');
    hl.className = 'cb-box';
    Object.assign(hl.style, { left: sr.left - or.left + x0 * unit - 4 + 'px', top: sr.top - or.top + y0 * unit - 8 + 'px', width: (x1 - x0) * unit + 8 + 'px', height: (y1 - y0) * unit + 16 + 'px' });
    osv.append(hl);
  };
  const bringIn = () => {
    const t = times[now().bar - 1];
    if (t) view.seek(t.start + 1e-3); // the orange line goes to the bar; pages turn to it
    boxBar();
    if (hl && !host.querySelector('.score-wrap.paged')) {
      const sc = host.querySelector('.scroll-host') || hl.closest('.scroll-host');
      const r = hl.getBoundingClientRect(), vr = sc?.getBoundingClientRect();
      if (sc && vr && (r.top < vr.top + 20 || r.bottom > vr.bottom - (panel.offsetHeight + 20))) sc.scrollBy({ top: r.top - vr.top - 80 });
    }
  };
  const onDrawn = () => { if (!closed) { times = barTimes(view.xml()); boxBar(); } };
  host.addEventListener('scoredrawn', onDrawn);

  // ---- the printed bar from the sheet ----
  const sheetImg = (c) => {
    if (c.image) return c.image;
    const sh = c.sheetId && store.get(c.sheetId);
    return sh && c.page ? pageSrc(sh, c.page) : null;
  };
  const crop = (c) => {
    const src = sheetImg(c);
    if (!src) return '<p class="muted cb-nosheet">The printed sheet is not linked to this score, so compare with your copy.</p>';
    return `<button class="cb-sheet" data-a="zoom" title="Tap to see the whole page" aria-label="The printed bar — tap for the whole page"><img alt="The bar on the printed sheet" src="${esc(src)}"></button>`;
  };
  const fitCrop = () => {
    const c = now(), b = panel.querySelector('.cb-sheet'), img = b?.querySelector('img');
    if (!img) return;
    const go2 = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const bb = c.box;
      if (!bb || bb.some((v) => typeof v !== 'number') || !W) { b.classList.add('whole'); return; }
      const pad = Math.max(bb[3] * 0.25, 10);
      const [x, y, w, h] = [bb[0] - pad, bb[1] - pad, bb[2] + 2 * pad, bb[3] + 2 * pad];
      const maxW = b.clientWidth || 320, maxH = 150, s = Math.min(maxW / w, maxH / h);
      Object.assign(b.style, { width: w * s + 'px', height: h * s + 'px' });
      Object.assign(img.style, { width: W * s + 'px', height: H * s + 'px', left: -x * s + 'px', top: -y * s + 'px' });
      b.classList.add('cropped');
    };
    if (img.complete && img.naturalWidth) go2(); else img.onload = go2;
  };
  const zoom = () => {
    const src = sheetImg(now());
    if (!src) return;
    const s = modal(`<h2>Bar ${now().bar} on the sheet${now().page ? ` (page ${now().page})` : ''}</h2>
      <div class="cb-page"><img alt="The printed page" src="${esc(src)}"></div>
      <div class="modal-actions"><button data-a="z">Zoom</button><button class="primary" data-close>Done</button></div>`, { wide: true });
    s.el.querySelector('[data-a="z"]').onclick = () => s.el.querySelector('.cb-page').classList.toggle('big');
  };

  // ---- the panel ----
  const draw = () => {
    if (closed) return;
    const c = now();
    panel.innerHTML = `<div class="np-row"><b class="np-title">Check bars</b><span class="np-count" id="cb-count">Bar ${c.bar} · ${k + 1} of ${list.length}</span><span class="grow"></span>
      <button class="icon-btn" data-a="prev" ${k > 0 ? '' : 'disabled'} title="Bar before (←)" aria-label="Bar before">${iconOn('left')}</button>
      <button class="icon-btn" data-a="next" ${k < list.length - 1 ? '' : 'disabled'} title="Next bar (→)" aria-label="Next bar">${iconOn('right')}</button>
      <button class="icon-btn" data-a="close" title="Close (Esc)" aria-label="Close">${iconOn('close')}</button></div>
      <div class="cb-body">${crop(c)}<div class="cb-what"><p class="cb-why">${esc(c.reason)}</p>
        ${alt ? `<p class="cb-alt-on">Showing <b>${esc(c.alts[alt.i].label)}</b> in the score${c.alts.length > 1 ? ` (${alt.i + 1} of ${c.alts.length})` : ''}.</p>` : '<p class="muted cb-ask">Does the bar in the score match the printed bar?</p>'}</div></div>
      <div class="np-acts cb-acts">${alt ? `
        <button data-a="alt-back">Back to the score's reading</button>${c.alts.length > 1 ? '<button data-a="alt-next">Next reading</button>' : ''}<span class="grow"></span>
        <button data-a="play">Play bar</button><button class="primary" data-a="alt-keep">Use this reading</button>` : `
        <button data-a="play">Play bar</button>${c.lyrics ? '<button data-a="lyrics">Fix lyrics</button>' : ''}<button data-a="edit">Edit notes</button>
        ${c.alts.length ? '<button data-a="alt">Use other reading</button>' : ''}<span class="grow"></span>
        ${list.api && list.length > 1 ? '<button data-a="all">Mark all as looks right</button>' : ''}
        <button class="primary" data-a="ok">Looks right</button>`}</div>`;
    host.style.setProperty('--np-h', panel.offsetHeight + 'px');
    fitCrop();
  };
  const show = (i) => { k = Math.max(0, Math.min(i, list.length - 1)); alt = null; draw(); bringIn(); };

  // ---- actions (each saved into the score: history + Activities undo) ----
  // a score with the Mac's check (barcheck.py): its POST /check logs the decision; else through Edit notes
  const saveOps = async (ops, msg, check) => {
    if (busy) return false;
    busy = true;
    try {
      const pv = await post(`${url}/preview`, { ops: [] });
      if (list.api && check) await post(`/items/${encodeURIComponent(it.id)}/check`, { ...check, bar: now().bar, sha: pv.sha });
      else {
        const j = await post(url, { ops, mode: 'this', sha: pv.sha });
        const was = store.get(it.id);
        if (was) Object.assign(was, { updatedAt: j.item.updatedAt, musicxmlOriginal: j.item.musicxmlOriginal });
      }
      await view.reload();
      times = barTimes(view.xml());
      toast(msg, { label: 'Activities', run: () => go('#/activity') });
      return true;
    } catch (e) { toast(e.message); return false; } finally { busy = false; }
  };
  const done = async () => { // this bar is off the list
    list.splice(k, 1);
    host.dispatchEvent(new CustomEvent('checkchange'));
    refreshBadge();
    if (!list.length) { close(); toast('All bars checked'); return; }
    show(Math.min(k, list.length - 1));
  };
  const ok = async () => { if (await saveOps([{ op: 'unmark', bars: [now().bar] }], `Bar ${now().bar} checked — Activities can undo it`, { action: 'ok' })) done(); };
  // the preview goes through Edit notes' 'alt' step, which puts the reading in the way barcheck.py does
  const altOps = (i) => [{ op: 'alt', bar: now().bar, measure: now().alts[i].measure }, { op: 'unmark', bars: [now().bar] }];
  const tryAlt = async (i) => {
    if (busy) return;
    busy = true;
    try { const j = await post(`${url}/preview`, { ops: altOps(i) }); alt = { i }; draw(); await view.showXml(j.xml); bringIn(); }
    catch (e) { toast(e.message); } finally { busy = false; }
  };
  const altBack = async () => { alt = null; draw(); await view.reload(); bringIn(); };
  const altKeep = async () => { if (await saveOps(altOps(alt.i), `Bar ${now().bar}: the other reading is in — Activities can undo it`, { action: 'use', alt: now().alts[alt.i].id })) { alt = null; done(); } };
  const play = async () => {
    const t = times[now().bar - 1], p = view.player;
    if (!t || !p) return;
    if (p.playing) { p.pause(); return; }
    view.seek(t.start);
    stopAt = t.start + t.len;
    try { await p.play(); } catch { toast('Could not start playback.'); }
  };
  const onTick = (e) => { if (stopAt != null && e.detail.q >= stopAt - 0.02) { stopAt = null; view.player?.pause(); view.seek(times[now()?.bar - 1]?.start || 0); } };
  host.addEventListener('tick', onTick);
  const edit = () => {
    const c = now(), i = k;
    hide();
    editNotes(view, it, host, { bar: c.bar, title: `Edit bar ${c.bar}`, extraOps: () => [{ op: 'unmark', bars: [c.bar] }],
      onDone: (j) => {
        if (j && j.mode === 'this') { list.splice(i, 1); host.dispatchEvent(new CustomEvent('checkchange')); refreshBadge(); }
        if (list.length) reviewChecks(view, it, host, list, Math.min(i, list.length - 1), refreshBadge);
        else if (j) toast('All bars checked');
      } });
  };

  // words read too poorly to write: Edit notes in Lyrics mode on that verse, at the line's first bar; once saved into
  // this score, the line's bars that were flagged for their words alone are checked
  const fixLyrics = () => {
    const c = now(), i = k;
    hide();
    editNotes(view, it, host, { mode: 'lyrics', verse: c.lyrics.verse, bar: c.lyrics.bars[0], title: `Lyrics from bar ${c.lyrics.bars[0]}`, onDone: async (j) => {
      const saved = !!j && j.mode === 'this';
      if (saved && list.api) {
        const bars = list.filter((x) => x.lyricsOnly && x.lyrics?.verse === c.lyrics.verse && c.lyrics.bars.includes(x.bar)).map((x) => x.bar);
        try {
          if (bars.length) await post(`/items/${encodeURIComponent(it.id)}/check`, { bars, action: 'ok', act: 'bar-check' });
          for (const b of bars) list.splice(list.findIndex((x) => x.bar === b), 1);
          await view.reload();
        } catch (e) { toast(e.message); }
        host.dispatchEvent(new CustomEvent('checkchange')); refreshBadge();
      }
      if (list.length) reviewChecks(view, it, host, list, Math.min(i, list.length - 1), refreshBadge);
      else if (saved) toast('All bars checked');
    } });
  };
  const allOk = async () => {
    const n = list.length;
    if (!(await confirmSheet({ title: `Mark all ${n} bars as looking right?`, body: 'Every bar still to check is marked fine as it is, without looking at each one. Activities can undo it.', ok: 'Mark all' }))) return;
    if (busy) return;
    busy = true;
    try {
      const pv = await post(`${url}/preview`, { ops: [] });
      await post(`/items/${encodeURIComponent(it.id)}/check`, { bars: 'all', action: 'ok', sha: pv.sha });
      list.splice(0, list.length);
      await view.reload();
      host.dispatchEvent(new CustomEvent('checkchange')); refreshBadge();
      busy = false;
      close();
      toast(`${n} bars marked as looking right — Activities can undo it`, { label: 'Activities', run: () => go('#/activity') });
    } catch (e) { toast(e.message); } finally { busy = false; }
  };

  const hide = () => {
    closed = true; stopAt = null;
    hl?.remove(); panel.remove();
    host.classList.remove('checking'); host.style.removeProperty('--np-h');
    host.removeEventListener('scoredrawn', onDrawn); host.removeEventListener('tick', onTick);
    document.removeEventListener('keydown', onKey, true);
    if (window.__checkBars === api) delete window.__checkBars;
  };
  const close = async () => { const back = !!alt; hide(); view.player?.pause(); if (back) await view.reload(); };
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a || busy) return;
    ({ close, prev: () => show(k - 1), next: () => show(k + 1), ok, edit, play, zoom, alt: () => tryAlt(0), lyrics: fixLyrics, all: allOk,
      'alt-next': () => tryAlt((alt.i + 1) % now().alts.length), 'alt-back': altBack, 'alt-keep': altKeep })[a]?.();
  });
  const onKey = (e) => {
    if (closed || document.querySelector('.modal-wrap') || e.target.closest?.('input,textarea,select')) return;
    const f = { ArrowLeft: () => show(k - 1), ArrowRight: () => show(k + 1), Escape: close, Enter: () => (alt ? altKeep() : ok()), p: play, e: edit }[e.key];
    if (!f) return;
    e.preventDefault(); e.stopPropagation(); f();
  };
  document.addEventListener('keydown', onKey, true);
  const api = { get list() { return list; }, get at() { return k; }, get bar() { return now()?.bar; }, get alt() { return alt; }, get busy() { return busy; } };
  window.__checkBars = api; // for automated tests
  show(k);
}
