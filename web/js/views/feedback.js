// Feedback, on the Feedback page (left bar Developer → Feedback; iPhone More → Feedback, #/developer; #/feedback lands there): write or speak a note about the app (the text box gets the
// mic from textinput.js), Submit saves it on the Mac (server/meowsic/feedback.py). Below: every note, newest
// first, each one a collapsible row (time, status, first line); open: the full text, Edit / Remove.
// Claude sets the status (New → In progress → Fixed / Won't fix); Fixed and Won't fix can't be edited or removed.
// Offline: notes and edits wait in the store's outbox and are sent when the Mac is back (the app's own ids,
// so a resend is not stored twice). A copy of the list is kept on this device to show offline.
import { store } from '../store.js';
import { $, esc, toast, confirmSheet } from '../ui.js';
import { fbCache as ls, fbCall as call, sendFeedback } from '../feedbackapi.js';

const STATUS = { new: 'New', in_progress: 'In progress', fixed: 'Fixed', wontfix: 'Won’t fix' };
const LOCKED = new Set(['fixed', 'wontfix']);
const fmt = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });
const firstLine = (s) => (s || '').split('\n').find((l) => l.trim())?.trim() || '';
const KIND = { score: 'Score', sheet: 'Sheet', chords: 'Chord chart' };
// quick feedback from a score / sheet / chord view: the song it is about (a link) and where in it
export function aboutHtml(f) {
  if (!f.item?.id) return '';
  const c = f.context || {};
  const where = [c.page ? `page ${c.page}${c.pages ? ' of ' + c.pages : ''}` : '', c.bar ? `bar ${c.bar}` : '', c.timeSec != null ? `${c.timeSec} s` : ''].filter(Boolean).join(' · ');
  const more = [c.version ? `version ${c.version}` : '', c.zoom ? `zoom ${c.zoom}` : '', c.device && c.device !== f.device ? c.device : ''].filter(Boolean).join(' · ');
  return `<p class="fb-about">${KIND[f.item.kind] || 'Item'}: <a href="#/item/${encodeURIComponent(f.item.id)}">${esc(f.item.title || 'Untitled')}</a>${where ? ` <span class="muted">· ${esc(where)}</span>` : ''}</p>${more ? `<p class="muted small fb-ctx">${esc(more)}</p>` : ''}`;
}

export function feedbackView(main) {
  let rows = ls.get(), editing = null, gone = false;
  const open = new Set();
  main.innerHTML = `<header class="top"><h1>Feedback</h1></header>
    <div class="pad narrow fb">
      <section class="card fb-new">
        <h2>Feedback</h2>
        <textarea id="fb-text" rows="4" placeholder="What should change or what went wrong? Tap the mic to speak." aria-label="Feedback"></textarea>
        <div class="fb-bar"><span class="muted small" id="fb-note"></span><span class="grow"></span><button class="primary" id="fb-send" disabled>Submit</button></div>
      </section>
      <h2 class="fb-h">Your feedback <small class="muted" id="fb-count"></small></h2>
      <div id="fb-list" class="fb-list"></div>
    </div>`;
  const ta = $('#fb-text', main), send = $('#fb-send', main);
  ta.oninput = () => { send.disabled = !ta.value.trim(); };
  const keep = () => ls.set(rows);
  const sorted = () => rows.filter((r) => !r.removedAt).sort((a, b) => b.createdAt - a.createdAt);

  const draw = () => {
    if (gone) return;
    const shown = sorted();
    $('#fb-count', main).textContent = shown.length ? `· ${shown.length}` : '';
    $('#fb-note', main).textContent = store.mode === 'offline' ? 'Offline — sent when the Mac is back' : '';
    $('#fb-list', main).innerHTML = shown.map((f) => {
      const locked = LOCKED.has(f.status), ed = editing === f.id;
      return `<details class="fb-item fb-${f.status}" data-id="${esc(f.id)}"${open.has(f.id) || ed ? ' open' : ''}>
        <summary><span class="fb-when">${esc(fmt(f.createdAt))}</span><span class="fb-st fb-s-${f.status}">${STATUS[f.status] || esc(f.status)}</span>${f.pending ? '<span class="fb-wait">Waiting to send</span>' : ''}
          <span class="fb-first">${f.item?.title ? `<span class="fb-on">${esc(f.item.title)}</span> ` : ''}${esc(firstLine(f.text))}</span></summary>
        <div class="fb-body">
          ${aboutHtml(f)}
          ${ed ? `<textarea class="fb-edit" rows="5" aria-label="Edit feedback">${esc(f.text)}</textarea>`
            : `<div class="fb-text">${esc(f.text)}</div>`}
          ${f.fixNote ? `<p class="fb-fix"><b>${f.status === 'wontfix' ? 'Note' : 'Fix'}:</b> ${esc(f.fixNote)}</p>` : ''}
          <p class="muted small fb-meta">${f.device ? `From ${esc(f.device)}` : ''}${f.fixedAt ? ` · ${STATUS[f.status]} ${esc(fmt(f.fixedAt))}` : ''}</p>
          ${locked ? '' : `<div class="fb-acts">${ed
            ? '<button data-a="cancel">Cancel</button><button class="primary" data-a="save">Save</button>'
            : '<button data-a="edit">Edit</button><button class="danger-btn" data-a="remove">Remove</button>'}</div>`}
        </div></details>`;
    }).join('') || '<p class="muted fb-empty">No feedback yet.</p>';
    if (editing) { const e = $('.fb-edit', main); if (e && document.activeElement !== e) { e.focus({ preventScroll: true }); e.setSelectionRange(e.value.length, e.value.length); } }
  };

  // the Mac's list wins; notes still waiting in the outbox stay as they are here
  const load = async () => {
    if (store.mode !== 'server') return draw();
    try {
      const r = await fetch('/api/feedback', { cache: 'no-store' });
      if (!r.ok || r.headers.get('X-Meowsic-Offline')) return draw();
      const fresh = await r.json();
      const waiting = store.waiting ? rows.filter((x) => x.pending) : [];
      const ids = new Set(fresh.map((x) => x.id));
      rows = [...fresh, ...waiting.filter((x) => !ids.has(x.id))].map((x) => (waiting.some((w) => w.id === x.id) ? waiting.find((w) => w.id === x.id) : x));
      keep();
    } catch {}
    draw();
  };

  send.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    send.disabled = true;
    const r = await sendFeedback(text);
    if (r.error) { toast(r.error); send.disabled = false; return; }
    rows = [r.row, ...rows.filter((x) => x.id !== r.row.id)];
    keep();
    ta.value = ''; ta.dispatchEvent(new Event('input'));
    toast(r.queued ? 'Saved here — sent when the Mac is back' : 'Thanks — feedback saved');
    draw();
  };

  const list = $('#fb-list', main);
  list.addEventListener('toggle', (e) => { const d = e.target; if (d.matches?.('details.fb-item')) d.open ? open.add(d.dataset.id) : open.delete(d.dataset.id); }, true);
  list.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id, f = rows.find((x) => x.id === id);
    if (!f) return;
    const a = b.dataset.a;
    if (a === 'edit') { editing = id; open.add(id); return draw(); }
    if (a === 'cancel') { editing = null; return draw(); }
    if (LOCKED.has(f.status)) return;
    if (a === 'save') {
      const text = $('.fb-edit', list).value.trim();
      if (!text) return toast('Feedback text is empty');
      if (text === f.text) { editing = null; return draw(); }
      b.disabled = true;
      const r = await call('PATCH', `/feedback/${encodeURIComponent(id)}`, { text });
      if (r.error) { toast(r.error); b.disabled = false; if (r.status === 409) { editing = null; load(); } return; }
      Object.assign(f, r.data?.id ? r.data : { text, updatedAt: Date.now(), pending: f.pending || !!r.queued });
      editing = null; keep(); draw();
      toast(r.queued ? 'Saved here — sent when the Mac is back' : 'Feedback updated');
    }
    if (a === 'remove') {
      if (!(await confirmSheet({ title: 'Remove this feedback?', body: firstLine(f.text), ok: 'Remove', danger: true }))) return;
      const r = await call('DELETE', `/feedback/${encodeURIComponent(id)}`);
      if (r.error) { toast(r.error); if (r.status === 409) load(); return; }
      f.removedAt = Date.now(); open.delete(id); keep(); draw();
      toast('Feedback removed');
    }
  };

  const back = () => load();
  addEventListener('meowsic-reconnected', back);
  const offConn = store.onConn(() => draw());
  load();
  return () => { gone = true; removeEventListener('meowsic-reconnected', back); offConn(); };
}
