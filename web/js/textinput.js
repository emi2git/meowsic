// Every text box in the app, enhanced from one place (no view markup changes):
//  - a mic button: speak, and what you said REPLACES the whole text (English, or Vietnamese — long-press the mic or Settings)
//  - double-click / double-tap selects the whole text, so the next typing replaces it
import { toast } from './ui.js';

const KEY = 'meowsic-voice-lang';
const LANGS = { 'en-US': 'English', 'vi-VN': 'Tiếng Việt' };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'tel']);
const SILENCE_MS = 2000, FIRST_WORD_MS = 8000, LONG_PRESS_MS = 550;

export const voiceSupported = () => !!SR;
export function voiceLang() { try { return LANGS[localStorage.getItem(KEY)] ? localStorage.getItem(KEY) : 'en-US'; } catch { return 'en-US'; } }
export function setVoiceLang(l) {
  if (!LANGS[l]) return;
  try { localStorage.setItem(KEY, l); } catch {}
  document.querySelectorAll('.ti-mic').forEach((b) => (b.dataset.lang = l.slice(0, 2)));
  document.querySelectorAll('#st-voice-lang button').forEach((b) => b.classList.toggle('on', b.dataset.l === l));
}

const isField = (el) => el && ((el.tagName === 'TEXTAREA') || (el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase())));
const editable = (el) => isField(el) && !el.readOnly && !el.disabled && !el.closest('[data-novoice]');

// ---------- picking the best words ----------
const hasMarks = (s) => /[đĐ]/.test(s) || /[̀-ͯ]/.test(s.normalize('NFD'));
export function bestAlt(result, lang) {
  const alts = Array.from({ length: result.length }, (_, i) => result[i]).filter((a) => a && a.transcript?.trim());
  if (!alts.length) return '';
  let pick = alts.reduce((a, b) => ((b.confidence || 0) > (a.confidence || 0) ? b : a), alts[0]);
  if (lang === 'vi-VN' && !hasMarks(pick.transcript)) {
    const marked = alts.filter((a) => hasMarks(a.transcript)).sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (marked) pick = marked;
  }
  return pick.transcript;
}
const tidy = (s) => s.replace(/\s+/g, ' ').trim();

// ---------- setting the text so the app reacts as if typed ----------
function putText(el, text, final) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  if (!final) return;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (el.type === 'search') el.dispatchEvent(new Event('search', { bubbles: true })); // "finished typing"
  if (document.activeElement === el) try { el.setSelectionRange(text.length, text.length); } catch {}
}

// ---------- listening ----------
let live = null; // { rec, el, btn, before, finals, interim, timer, heard }
function stopListening(cancel = false) {
  if (!live) return;
  live.cancel = cancel;
  try { live.rec.stop(); } catch {}
}
function listen(el, btn) {
  if (live) { const same = live.el === el; stopListening(); if (same) return; }
  const lang = voiceLang();
  const rec = new SR();
  rec.lang = lang; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 5;
  const L = live = { rec, el, btn, before: el.value, finals: [], interim: '', heard: false, err: null };
  const arm = (ms) => { clearTimeout(L.timer); L.timer = setTimeout(() => { if (live === L) { if (!L.heard) L.err = 'no-speech'; try { rec.stop(); } catch {} } }, ms); };
  btn.classList.add('on'); el.classList.add('ti-listening'); btn.setAttribute('aria-pressed', 'true');
  rec.onresult = (e) => {
    L.heard = true;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i], t = bestAlt(r, lang);
      if (r.isFinal) L.finals[i] = t; else interim += ' ' + t;
    }
    L.interim = tidy(interim);
    const now = tidy([...L.finals.filter(Boolean), L.interim].join(' '));
    if (now && el.isConnected && !el.readOnly) putText(el, now, false); // live feedback only; the app hears the final text
    arm(SILENCE_MS);
  };
  rec.onerror = (e) => { L.err = e.error || 'error'; };
  rec.onend = () => {
    clearTimeout(L.timer);
    if (live === L) live = null;
    btn.classList.remove('on'); el.classList.remove('ti-listening'); btn.setAttribute('aria-pressed', 'false');
    const text = tidy([...L.finals.filter(Boolean), L.interim].join(' '));
    if (!el.isConnected || el.readOnly || el.disabled) return;
    if (text && !L.cancel) putText(el, el.maxLength > 0 ? text.slice(0, el.maxLength) : text, true);
    else {
      if (el.value !== L.before) putText(el, L.before, false);
      const msg = { 'not-allowed': 'Microphone not allowed — allow it in the browser settings', 'service-not-allowed': 'Speech recognition not allowed — turn on Siri & Dictation / allow speech recognition', 'no-speech': 'No speech heard', 'audio-capture': 'No microphone found', network: 'Speech recognition needs the internet', 'language-not-supported': `${LANGS[lang]} isn’t supported here` }[L.err];
      if (!L.cancel && L.err !== 'aborted') toast(msg || (L.err ? 'Voice input stopped: ' + L.err : 'No speech heard'));
    }
  };
  try { rec.start(); arm(FIRST_WORD_MS); } catch (err) { L.err = 'error'; rec.onend(); }
}

// ---------- the mic buttons ----------
const mics = new Map(); // field → button
function place(el, btn) {
  const show = editable(el) && el.isConnected && el.getClientRects().length > 0 && el.offsetWidth >= 90;
  btn.hidden = !show;
  el.classList.toggle('ti-has-mic', show);
  if (!show) return;
  btn.style.left = '0px'; btn.style.top = '0px';
  const o = btn.getBoundingClientRect(), r = el.getBoundingClientRect(), s = btn.offsetWidth || 36;
  const inset = el.matches('.search input') ? 0 : 3;
  const top = r.height > 64 ? r.bottom - s - 3 : r.top + (r.height - s) / 2;
  btn.style.left = Math.round(r.right - s - inset - o.left) + 'px';
  btn.style.top = Math.round(top - o.top) + 'px';
}
function attach(el) {
  if (mics.has(el) || !el.parentElement) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ti-mic'; btn.tabIndex = -1;
  btn.dataset.lang = voiceLang().slice(0, 2);
  btn.setAttribute('aria-label', 'Speak to fill in (hold to switch English / Tiếng Việt)');
  btn.title = 'Speak — replaces the text (hold: English / Tiếng Việt)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
  let hold = null, held = false;
  // never take focus from the field (blur would save or close it)
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); held = false; clearTimeout(hold);
    hold = setTimeout(() => { held = true; const l = voiceLang() === 'en-US' ? 'vi-VN' : 'en-US'; setVoiceLang(l); toast(`Voice input: ${LANGS[l]}`); }, LONG_PRESS_MS);
  });
  const cancelHold = () => clearTimeout(hold);
  btn.addEventListener('pointerup', cancelHold); btn.addEventListener('pointerleave', cancelHold); btn.addEventListener('pointercancel', cancelHold);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (held) { held = false; return; } listen(el, btn); });
  const p = el.parentElement;
  if (getComputedStyle(p).position === 'static') p.style.position = 'relative';
  el.after(btn);
  mics.set(el, btn);
  ro?.observe(el);
  place(el, btn);
}
// start listening into a text box right away (quick feedback: the mic is on when the popover opens)
export function startVoice(el) {
  if (!SR || !el?.isConnected) return false;
  attach(el);
  const btn = mics.get(el);
  if (!btn) return false;
  if (live?.el !== el) listen(el, btn);
  return true;
}
export const stopVoice = (cancel = true) => stopListening(cancel);

const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
let queued = false;
function schedule() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const [el, btn] of mics) {
      if (!el.isConnected) { btn.remove(); ro?.unobserve(el); mics.delete(el); if (live?.el === el) stopListening(true); continue; }
      if (btn.previousElementSibling !== el) el.after(btn);
      place(el, btn);
    }
    if (SR) document.querySelectorAll('input, textarea').forEach((el) => isField(el) && !el.closest('[data-novoice]') && !el.hidden && attach(el));
    settingsCard();
  });
}

// ---------- Settings: Voice input language ----------
function settingsCard() {
  if (document.body.dataset.view !== 'settings') return;
  const pad = document.querySelector('#main .settings');
  if (!pad || pad.querySelector('#st-voice')) return;
  const sec = document.createElement('section');
  sec.className = 'card'; sec.id = 'st-voice';
  const l = voiceLang();
  sec.innerHTML = `<h2><svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg> Voice input language</h2>
    <div class="seg" id="st-voice-lang">${Object.entries(LANGS).map(([k, n]) => `<button data-l="${k}" class="${k === l ? 'on' : ''}">${n}</button>`).join('')}</div>
    <p class="muted small">${SR ? 'Tap the mic in any text box and speak — it replaces the whole text. Hold the mic to switch language.' : 'Voice input isn’t available in this browser (use Safari or Chrome).'}</p>`;
  sec.querySelector('#st-voice-lang').onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) setVoiceLang(b.dataset.l); };
  const cards = [...pad.querySelectorAll(':scope > section.card')];
  const after = cards.find((c) => /Appearance/.test(c.querySelector('h2')?.textContent || '')) || cards.at(-1);
  if (after) after.after(sec); else pad.prepend(sec);
}

// ---------- double-click / double-tap: select the whole text ----------
function selectAll(el) {
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  try { el.setSelectionRange(0, el.value.length); } catch { el.select(); }
}
document.addEventListener('mousedown', (e) => {
  if (e.detail === 2 && e.button === 0 && editable(e.target) && !e.target.ti_touch) { e.preventDefault(); selectAll(e.target); }
}, true);
document.addEventListener('dblclick', (e) => { if (editable(e.target)) { e.preventDefault(); selectAll(e.target); } }, true);
let lastTap = null;
document.addEventListener('touchend', (e) => {
  const el = e.target;
  if (!editable(el) || e.changedTouches.length !== 1) { lastTap = null; return; }
  const t = e.changedTouches[0], now = Date.now();
  if (lastTap && lastTap.el === el && now - lastTap.at < 350 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
    e.preventDefault(); // stop the native word selection / zoom
    lastTap = null;
    selectAll(el);
    setTimeout(() => selectAll(el), 0); setTimeout(() => selectAll(el), 60); // win over iOS's own selection
    el.ti_touch = true; setTimeout(() => (el.ti_touch = false), 500);
  } else lastTap = { el, at: now, x: t.clientX, y: t.clientY };
}, { capture: true, passive: false });

// ---------- watch for text boxes, now and later ----------
const ours = (n) => n.nodeType === 1 && n.classList.contains('ti-mic');
const relevant = (r) => r.type === 'childList'
  ? [...r.addedNodes, ...r.removedNodes].some((n) => !ours(n))
  : !ours(r.target) && !(r.attributeName === 'class' && mics.has(r.target)) && !(r.attributeName === 'style' && [...mics.keys()].some((el) => el.parentElement === r.target));
new MutationObserver((recs) => { if (recs.some(relevant)) schedule(); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['readonly', 'disabled', 'hidden', 'class', 'style'] });
addEventListener('resize', schedule);
document.addEventListener('focusin', schedule);
document.addEventListener('transitionend', schedule, true);
addEventListener('hashchange', () => stopListening(true));
schedule();
