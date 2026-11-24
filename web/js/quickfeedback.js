// Quick feedback in a score, sheet or chord view: the speech-bubble button opens a small popover with a text
// box whose mic starts listening at once (textinput.js), Send / Cancel. The note goes to the same pool as the
// Feedback page (feedbackapi.js) with what it is about: the song, and where in it (page, bar / time), zoom,
// version and device. A tap outside does not close it (the words stay); Cancel, Esc or the button again do. While it is open it counts as a tool (swipe.js: swipes don't close the view).
import { $, esc, iconOn, toast } from './ui.js';
import { startVoice, stopVoice, voiceSupported } from './textinput.js';
import { sendFeedback, deviceName } from './feedbackapi.js';
import { VERSIONS } from './musicxml.js';

// where the user is in the item right now
export function itemContext(it, view) {
  const c = { view: it.kind, device: deviceName() };
  if (!view) return c;
  try {
    if (it.kind === 'sheet') {
      c.page = view.page; c.pages = it.pages || undefined; c.zoom = view.zoomLabel;
    } else if (it.kind === 'chords') {
      if (view.pages) { c.page = view.page; c.pages = view.pages; }
      c.zoom = `${Math.round((view.size / 18) * 100)}%`;
      if (it.transpose) c.transpose = it.transpose;
    } else {
      const v = view; // the score view (also window.__score): page, zoom, version and the player's position
      if (v.pages > 1) { c.page = v.page; c.pages = v.pages; }
      if (v.zoom) c.zoom = `${Math.round(v.zoom * 100)}%`;
      if (v.version) c.version = VERSIONS[v.version] || v.version;
      const p = v.player;
      if (p) {
        const q = Math.max(0, p.playing && p.now ? p.now() : p.posQ || 0);
        const beats = v.tune?.beats || 4, bpm = (p.bpm || v.tune?.bpm || 100) * (p.rate || 1);
        c.bar = Math.floor(q / beats + 1e-6) + 1;
        c.timeSec = Math.round((q * 60 / bpm) * 10) / 10;
        if (p.playing) c.playing = true;
      }
      if (it.transpose) c.transpose = it.transpose;
    }
  } catch {}
  for (const k of Object.keys(c)) if (c[k] === undefined || c[k] === '') delete c[k];
  return c;
}

const whereLabel = (c) => [c.page ? `page ${c.page}` : '', c.bar ? `bar ${c.bar}` : ''].filter(Boolean).join(' / ');

let openPop = null; // { el, close }

export function openQuickFeedback(it, view, anchor) {
  if (openPop) { openPop.close(); return; }
  const ctx = itemContext(it, view);
  const where = whereLabel(ctx);
  const el = document.createElement('div');
  el.className = 'qfb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Quick feedback');
  el.innerHTML = `<div class="qfb-about">About: <b>${esc(it.title || 'Untitled')}</b>${where ? ` · ${esc(where)}` : ''}</div>
    <textarea id="qfb-text" rows="3" placeholder="${voiceSupported() ? 'Listening… or type' : 'What should change or what went wrong?'}" aria-label="Feedback"></textarea>
    <div class="qfb-acts"><button type="button" data-a="cancel">Cancel</button><button type="button" class="primary" data-a="send">Send</button></div>`;
  document.body.append(el);
  const r = anchor?.getBoundingClientRect();
  if (r && innerWidth > 560) {
    el.style.top = Math.round(r.bottom + 8) + 'px';
    el.style.right = Math.max(12, Math.round(innerWidth - r.right)) + 'px';
  } else if (r) el.style.top = Math.round(r.bottom + 6) + 'px';
  anchor?.classList.add('on');
  const ta = $('#qfb-text', el);
  let sending = false;
  const close = () => {
    if (!openPop || openPop.el !== el) return;
    openPop = null;
    el.remove(); anchor?.classList.remove('on');
    stopVoice(true);
    document.removeEventListener('keydown', key, true);
    removeEventListener('hashchange', close);
  };
  const send = async () => {
    if (sending) return;
    const text = ta.value.trim();
    if (!text) { toast('Say or type something first'); return; }
    sending = true;
    close();
    const res = await sendFeedback(text, { item: { id: it.id, kind: it.kind, title: it.title || '' }, context: { ...ctx, ...itemContext(it, view), at: new Date().toISOString() } });
    if (res.error) toast(res.error);
    else toast(res.queued ? 'Feedback saved — sent when the Mac is back' : 'Feedback sent');
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };
  document.addEventListener('keydown', key, true);
  addEventListener('hashchange', close);
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (!b) return; b.dataset.a === 'send' ? send() : close(); });
  openPop = { el, close };
  // the mic starts on the tap that opened this (a user gesture); no mic here: the keyboard instead
  if (!startVoice(ta)) ta.focus();
  return openPop;
}

// the toolbar button (same look as the other one-icon buttons in the item header)
export function quickFeedbackButton(it, getView) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn qfb-btn';
  b.id = 'it-feedback';
  b.title = 'Feedback about this';
  b.setAttribute('aria-label', 'Feedback about this');
  b.innerHTML = iconOn('feedback');
  b.onclick = (e) => { e.stopPropagation(); openQuickFeedback(it, getView(), b); };
  return b;
}

export const closeQuickFeedback = () => openPop?.close();
