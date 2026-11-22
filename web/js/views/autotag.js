// Auto-tag (offline AI on the Mac): ask for tag suggestions, show them for review, save only what is
// ticked. Used from the selection bar, an item's ⋯ menu, and right after new music is added.
import { store } from '../store.js';
import { $, esc, toast, sheet as modal } from '../ui.js';

// the Mac may answer at once, or start a job and finish later; this waits either way
export async function aiCall(path, body, onProgress) {
  const r = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'The Mac could not run the AI.');
  const job = data.job || (data.status && data.id && !data.suggestions && !data.groups ? data : null);
  if (!job) return data;
  for (;;) { // poll the job until it is done
    await new Promise((res) => setTimeout(res, 1500));
    const j = await (await fetch(`/api/jobs/${encodeURIComponent(job.id)}`)).json();
    onProgress?.(j);
    if (j.status === 'done') return typeof j.result === 'object' && !Array.isArray(j.result) ? j.result : { suggestions: j.result || [], groups: j.result || [] };
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.log?.at(-1)?.msg || 'The AI job stopped.');
  }
}

export async function autoTag(ids, { quiet = false } = {}) {
  ids = [].concat(ids);
  if (store.mode !== 'server') { if (!quiet) toast('Auto-tag needs the Mac.'); return; }
  const wait = quiet ? null : modal(`<h2>Auto-tag</h2><p class="muted" id="at-msg">Looking at ${ids.length} song${ids.length > 1 ? 's' : ''}…</p><progress></progress>`);
  let res;
  try {
    res = await aiCall('/ai/autotag', { ids }, (j) => { const m = wait && $('#at-msg', wait.el); if (m) m.textContent = j.log?.at(-1)?.msg || 'Working…'; });
  } catch (e) { wait?.close(); if (!quiet) toast(e.message); return; }
  wait?.close();
  const sug = (res.suggestions || []).map((s) => ({ ...s, add: (s.add || []).filter((t) => !store.get(s.id)?.tags.includes(t)) })).filter((s) => s.add.length && store.get(s.id));
  if (!sug.length) { if (!quiet) toast('No new tags found.'); return; }
  if (quiet) { toast(`Tags found for ${sug.length} new song${sug.length > 1 ? 's' : ''}`, { label: 'Review', run: () => review(sug) }); return; }
  review(sug);
}

// tick / untick each suggested tag, then save
function review(sug) {
  const on = new Map(sug.map((s) => [s.id, new Set(s.add)]));
  const s = modal(`<h2>Review tags</h2>
    <p class="muted small">Untick anything that's wrong. Nothing is saved until you press Save.</p>
    <div class="at-list">${sug.map((x) => { const it = store.get(x.id); return `<div class="at-row" data-id="${x.id}">
      <div class="at-title"><b>${esc(it.title)}</b>${x.why ? `<small class="muted">${esc(x.why)}</small>` : ''}</div>
      <div class="tag-pick">${x.add.map((t) => `<button type="button" class="chip on" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`; }).join('')}</div>
    <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`, { wide: true });
  s.el.querySelector('.at-list').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const set = on.get(b.closest('[data-id]').dataset.id), t = b.dataset.t;
    set.has(t) ? set.delete(t) : set.add(t);
    b.classList.toggle('on', set.has(t));
  };
  s.el.querySelector('[data-ok]').onclick = () => {
    let n = 0;
    for (const [id, set] of on) if (set.size) { store.setTags([id], [...set]); n += set.size; }
    store.logEvent('make-tags', `Auto-tag: ${n} tag${n === 1 ? '' : 's'}`, sug.map((x) => store.get(x.id)?.title).join(', '));
    s.close();
    toast(`Saved ${n} tag${n === 1 ? '' : 's'}`);
  };
}
