// Activities: every job and change, newest first. Each row that can be rolled back has Undo (a running job: Stop,
// which cancels it and rolls back what it made). A confirm sheet says what will be rolled back; rolled-back rows
// stay, struck through. The Mac keeps the rollback info (GET /api/activity, POST /api/activity/{id}/undo).
// Undo is open for 24 hours ("Can undo until …"); then a row is Final (small badge, no Undo) and the daily clean-up
// deletes the old copies kept for it. "Clean up now" shows a dry run (counts, MB) before deleting anything.
import { store } from '../store.js';
import { $, esc, ago, sheet, toast } from '../ui.js';

const WHAT = { transcribe: 'Score from recording', version: 'Make another version', omr: 'Score from photo', tags: 'AI tag suggestions',
  'add-sheet': 'Add sheets', 'add-chords': 'Add chords', bin: 'Moved to Trash', print: 'Printed', 'make-tags': 'Generate tags', restore: 'Restored',
  delete: 'Deleted for good', import: 'Import', edit: 'Edited', 'tag-rename': 'Tag renamed', 'tag-delete': 'Tag deleted',
  split: 'Split', join: 'Joined', book: 'Made a book', unbook: 'Made a sheet', booksplit: 'Book → sheets', unbooksplit: 'Sheets → book', songsplit: 'Split songs', unsongsplit: 'Songs put back', pages: 'Organize pages', reviewed: 'Complete song', unreviewed: 'Check again', organize: 'Organize pages scan',
  trim: 'Trimmed', 'cleanup-marks': 'Clean up marks', cleanup: 'Clean up', suggest: 'Name suggestion', 'ai-score': 'AI music',
  'import-photos': 'From Photos', 'photo-import': 'From Photos', 'photo-unimport': 'From Photos undone', migrate: 'One-off change', rename: 'Renamed', rollback: 'Undo', change: 'Change', 'lyrics-fit': 'Fit lyrics', metafill: 'Song info filled' };
const what = (a) => (isJob(a) ? WHAT[a.kind || a.type] : a.type === 'version' ? 'Version set' : a.type === 'tags' ? 'Tags' : WHAT[a.type]) || a.type;
const fmt = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS = { running: 'Running', queued: 'Waiting', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' };
const hm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`; };
const until = (t) => `${new Date(t).toDateString() === new Date().toDateString() ? 'today' : 'tomorrow'} ${hm(t)}`;
const mb = (n) => `${(n || 0).toFixed(1)} MB`;
const isJob = (a) => !!a.kind || a.type === 'transcribe' || (a.type === 'version' && a.gen);

// the rows: the Mac's list (with undo info) when connected, else the copy kept here (no undo then)
async function fetchRows() {
  if (store.mode === 'server') {
    try { const r = await fetch('/api/activity', { cache: 'no-store' }); if (r.ok) return { rows: await r.json(), live: true }; } catch {}
  }
  return { rows: store.activity().map((a) => ({ ...a, action: store.mode === 'mock' && isJob(a) && (a.status === 'running' || a.status === 'queued') ? 'stop' : null })), live: false };
}

async function postUndo(id, force) {
  const r = await fetch(`/api/activity/${encodeURIComponent(id)}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const d = j.detail;
  throw Object.assign(new Error(typeof d === 'string' ? d : d?.message || `Failed (${r.status})`), { info: typeof d === 'object' ? d : {} });
}

// confirm sheet: what will be rolled back. Resolves true / false.
function ask({ title, lines, ok, note, danger }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet(`<h2>${esc(title)}</h2>
      ${lines?.length ? `<ul class="ac-will">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
      <div class="modal-actions"><button data-close>Cancel</button><button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    s.el.classList.add('ac-sheet');
    s.el.querySelector('[data-ok]').onclick = () => { answered = true; s.close(); resolve(true); };
  });
}

export function activityView(main) {
  let filter = 'all', rows = [], live = false, busy = false;
  const open = new Set();
  main.innerHTML = `<header class="top"><h1>Activities</h1><span class="grow"></span>
      <div class="seg small" id="ac-f" role="group" aria-label="Show">
        <button data-f="all" class="on">All</button><button data-f="undo">Can undo</button><button data-f="jobs">Jobs</button></div>
      ${store.mode === 'server' ? '<button id="ac-clean" class="small" title="Delete old copies kept for undo (older than 24 hours)">Clean up now…</button>' : ''}</header>
    <p class="pad muted hint" id="ac-hint" hidden>Undo needs the Mac: connect to roll changes back.</p>
    <table class="activity"><thead><tr><th class="c-when">When</th><th>What</th><th class="c-st">Status</th><th class="c-act"><span class="sr">Undo</span></th></tr></thead><tbody id="ac"></tbody></table>`;

  const statusOf = (a) => {
    if (a.undoneAt) return `<span class="st st-undone">Rolled back ${esc(ago(a.undoneAt).toLowerCase())}</span>`;
    const st = a.status || 'done';
    const pct = st === 'running' && a.stage != null ? ` ${Math.round(((a.stage + (a.progress || 0)) / (a.gen ? 4 : 7)) * 100)}%` : '';
    const grace = a.final ? ` <span class="st-final" title="Undo was open for 24 hours; the old copies are no longer kept">Final</span>`
      : a.action === 'undo' && a.undoUntil ? `<small class="ac-until" title="${fmt(a.undoUntil)}">Can undo until ${until(a.undoUntil)} · ${left(a.undoUntil)}</small>` : '';
    return `<span class="st st-${st}">${STATUS[st] || st}${pct}</span>${grace}`;
  };
  const draw = () => {
    const shown = rows.filter((a) => filter === 'all' || (filter === 'undo' && a.action) || (filter === 'jobs' && isJob(a)));
    $('#ac-hint', main).hidden = live || store.mode === 'mock';
    $('#ac', main).innerHTML = shown.map((a) => `
      <tr class="ac-row ${a.log ? 'has-log' : ''} ${a.undoneAt ? 'undone' : ''}" data-id="${esc(a.id)}">
        <td class="c-when" title="${fmt(a.at)}">${ago(a.at)}</td>
        <td class="c-what"><b class="ac-what">${esc(what(a))}</b>${a.output ? ` <small class="muted">· ${esc(a.output)}</small>` : ''}
          <span class="ac-title">${esc(a.title || '')}</span>${a.detail && a.detail !== a.title ? `<small class="muted ac-detail">${esc(a.detail)}</small>` : ''}
          <span class="ac-st-m">${statusOf(a)}</span>
          ${a.log ? `<small class="muted ac-logbtn">${open.has(a.id) ? '▾' : '▸'} log</small>` : ''}</td>
        <td class="c-st">${statusOf(a)}</td>
        <td class="c-act" ${!a.action && a.noUndo ? `title="${esc(a.noUndo)}"` : ''}>${a.action ? `<button class="ac-btn ${a.action === 'stop' ? 'danger-btn' : ''}" data-act="${a.action}" data-id="${esc(a.id)}">${a.action === 'stop' ? 'Stop' : 'Undo'}</button>` : ''}</td>
      </tr>${a.log && open.has(a.id) ? `<tr class="ac-log"><td colspan="4">${a.source ? `<div class="muted">${esc(a.source)}</div>` : ''}${a.log.map((l) => `<div><code>${fmt(l.t)}</code> ${esc(l.msg)}</div>`).join('')}</td></tr>` : ''}`).join('') ||
      `<tr><td colspan="4" class="muted">${filter === 'undo' ? 'Nothing to undo.' : 'Nothing yet.'}</td></tr>`;
  };
  let loading = null, again = false;
  const load = async () => {
    if (loading) { again = true; return loading; }
    loading = (async () => { const r = await fetchRows(); rows = r.rows; live = r.live; if (!busy) draw(); })().finally(() => { loading = null; if (again) { again = false; load(); } });
    return loading;
  };

  const run = async (a) => {
    const stop = a.action === 'stop';
    const label = `${what(a)}${a.title ? ` — ${a.title}` : ''}`;
    if (store.mode === 'mock') { // preview: just stop the pretend job
      if (stop && await ask({ title: `Stop “${a.title}”?`, lines: ['Stop the job'], ok: 'Stop', danger: true })) { store.updateJob(a.id, { status: 'cancelled', msg: 'Stopped' }, { quiet: false }); toast('Stopped'); load(); }
      return;
    }
    const ok = await ask({ title: stop ? `Stop “${a.title}”?` : `Undo ${label}?`, lines: a.undoText, ok: stop ? 'Stop' : 'Undo', danger: stop,
      note: stop ? 'The job is cancelled and anything it already made goes to the Trash.' : 'The change is rolled back; this row stays, marked rolled back.' });
    if (!ok) return;
    busy = true;
    try {
      let res;
      try { res = await postUndo(a.id, false); } catch (e) {
        if (e.info?.reason !== 'conflict' || !e.info.canForce) throw e;
        if (!(await ask({ title: 'Changed since', lines: e.info.conflicts, ok: 'Undo anyway', danger: true,
          note: 'These were changed after this activity. Undo anyway puts the old values back over those later changes.' }))) return;
        res = await postUndo(a.id, true);
      }
      const skipped = res.skipped?.length ? ` · ${res.skipped.length} skipped (${res.skipped.slice(0, 2).map((s) => `${s.what}: ${s.why}`).join('; ')})` : '';
      toast(`${res.message || 'Rolled back'}${skipped}`);
      await store.resync().catch(() => {});
      await store.refreshJobs?.().catch?.(() => {});
    } catch (e) { toast(e.message || 'Could not roll it back'); } finally { busy = false; await load(); }
  };

  // Clean up now: dry run first (what would go, per kind, in MB), then delete
  const cleanNow = async () => {
    if (busy) return;
    let p;
    try { const r = await fetch('/api/daily-cleanup/preview', { cache: 'no-store' }); if (!r.ok) throw new Error(`Failed (${r.status})`); p = await r.json(); } catch (e) { return toast(e.message || 'Could not reach the Mac'); }
    const cats = Object.values(p.categories || {});
    const lines = [
      `${p.activities} activit${p.activities === 1 ? 'y' : 'ies'}${p.jobs ? ` and ${p.jobs} job${p.jobs === 1 ? '' : 's'}` : ''} older than 24 hours become Final (no more Undo)`,
      ...cats.map((c) => `${c.label}: ${c.files} file${c.files === 1 ? '' : 's'}, ${mb(c.mb)}`),
      ...(p.keptBackup ? [`Always kept: the newest backup (${p.keptBackup})`] : []),
    ];
    const ok = await ask({ title: p.files ? `Delete ${p.files} old file${p.files === 1 ? '' : 's'} (${mb(p.mb)})?` : 'Nothing old to delete', lines,
      ok: p.files ? 'Delete' : 'Run clean-up', danger: !!p.files,
      note: `Dry run — nothing has been deleted yet. Only copies kept for undo that are older than 24 hours go; current pages, scores, the library and the Trash are not touched.${p.lastRun ? ` Last clean-up: ${ago(p.lastRun).toLowerCase()}.` : ''} It also runs by itself once a day.` });
    if (!ok) return;
    busy = true;
    try {
      const r = await fetch('/api/daily-cleanup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : `Failed (${r.status})`);
      toast(`Cleaned up: ${j.files} file${j.files === 1 ? '' : 's'} deleted, ${mb(j.mb)} freed`);
    } catch (e) { toast(e.message || 'Clean-up failed'); } finally { busy = false; await load(); }
  };
  $('#ac-clean', main)?.addEventListener('click', cleanNow);
  $('#ac-f', main).onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; main.querySelectorAll('#ac-f button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  $('#ac', main).onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) { const a = rows.find((x) => x.id === btn.dataset.id); if (a && !busy) run(a); return; }
    const r = e.target.closest('.has-log'); if (!r) return;
    open.has(r.dataset.id) ? open.delete(r.dataset.id) : open.add(r.dataset.id); draw();
  };
  draw(); load();
  let t = 0; const soon = () => { clearTimeout(t); t = setTimeout(load, 250); };
  const a = store.on(soon), b = store.onJobs(soon);
  const tick = setInterval(() => { if (rows.some((x) => x.status === 'running' || x.status === 'queued')) load(); }, 2500);
  const minute = setInterval(() => { if (busy) return; if (rows.some((x) => x.undoUntil && x.undoUntil <= Date.now())) load(); else draw(); }, 60000);  // time left; Final when it runs out
  return () => { a(); b(); clearInterval(tick); clearInterval(minute); clearTimeout(t); };
}
