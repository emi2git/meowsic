// Logs: every job and change, newest first. Plain list; tap a row for its log.
import { store } from '../store.js';
import { $, esc, ago } from '../ui.js';

const WHAT = { transcribe: 'Score from recording', version: 'Make another version', 'add-sheet': 'Add sheets', 'add-chords': 'Add chords',
  bin: 'Moved to Trash', print: 'Printed', 'make-tags': 'Make tags', restore: 'Restored', delete: 'Deleted for good', import: 'Import' };
const fmt = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS = { running: 'Running', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' };

export function activityView(main) {
  let filter = 'all';
  const open = new Set();
  main.innerHTML = `<header class="top"><h1>Logs</h1><span class="grow"></span>
      <select id="ac-f" aria-label="Show"><option value="all">Everything</option><option value="jobs">Jobs only</option><option value="running">Running</option><option value="failed">Failed or cancelled</option></select></header>
    <table class="activity"><thead><tr><th>When</th><th>What</th><th>Item</th><th>Status</th></tr></thead><tbody id="ac"></tbody></table>`;
  const draw = () => {
    const rows = store.activity().filter((a) => filter === 'all' || (filter === 'jobs' && (a.type === 'transcribe' || a.type === 'version')) ||
      (filter === 'running' && a.status === 'running') || (filter === 'failed' && (a.status === 'failed' || a.status === 'cancelled')));
    $('#ac', main).innerHTML = rows.map((a) => `
      <tr class="ac-row ${a.log ? 'has-log' : ''}" data-id="${a.id}">
        <td title="${fmt(a.at)}">${ago(a.at)}</td>
        <td>${WHAT[a.type] || a.type}${a.output ? ` <small class="muted">· ${esc(a.output)}</small>` : ''}</td>
        <td>${esc(a.title || '')}${a.detail && a.detail !== a.title ? `<br><small class="muted">${esc(a.detail)}</small>` : ''}</td>
        <td><span class="st st-${a.status}">${STATUS[a.status] || a.status}${a.status === 'running' ? ` ${Math.round(((a.stage + a.progress) / (a.gen ? 4 : 7)) * 100)}%` : ''}</span>${a.log ? ` <small class="muted">${open.has(a.id) ? '▾' : '▸'} log</small>` : ''}</td>
      </tr>${a.log && open.has(a.id) ? `<tr class="ac-log"><td></td><td colspan="3">${a.source ? `<div class="muted">${esc(a.source)}</div>` : ''}${a.log.map((l) => `<div><code>${fmt(l.t)}</code> ${esc(l.msg)}</div>`).join('')}</td></tr>` : ''}`).join('') ||
      '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>';
  };
  $('#ac-f', main).onchange = (e) => { filter = e.target.value; draw(); };
  $('#ac', main).onclick = (e) => { const r = e.target.closest('.has-log'); if (!r) return; open.has(r.dataset.id) ? open.delete(r.dataset.id) : open.add(r.dataset.id); draw(); };
  draw();
  const a = store.on(draw), b = store.onJobs(draw);
  return () => { a(); b(); };
}
