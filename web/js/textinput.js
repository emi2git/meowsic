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
// One recognizer for the whole app (search, Feedback, quick feedback), because iOS / WebKit trips over a
// second one: start() before the last session's onend throws InvalidStateError or quietly does nothing, and
// the mic then "pulses" with nothing listening. So:
//  - start() runs synchronously inside the tap; a tap while the last session is still winding down waits for its
//    onend (or a watchdog: iOS sometimes never sends one, and that recognizer is then thrown away)
//  - the button pulses only once the recognizer says it started (onstart / onaudiostart), and stops on onend
//  - a fast failure (InvalidStateError, no onstart, an early 'aborted' / 'audio-capture') retries once, on a fresh
//    recognizer; errors say what to do (no speech, no internet, mic blocked)
//  - our own audio session ('playback', audio.js) blocks the mic on iOS: 'play-and-record' while listening, then back
//  - the app going to the background ends the session (the words heard so far are kept)
const START_MS = 1800, FAST_FAIL_MS = 1200, END_MS = 1500, DOUBLE_TAP_MS = 400;
const MSG = {
  'no-speech': 'Mic didn’t hear anything — tap to try again',
  network: 'Speech needs internet on this device',
  'not-allowed': 'Microphone blocked — allow it in Settings',
  'service-not-allowed': 'Speech recognition is off — turn on Siri & Dictation in Settings',
  'audio-capture': 'Mic is busy or missing — tap to try again',
  'no-start': 'Mic didn’t start — tap to try again',
};
const HARD = new Set(['not-allowed', 'service-not-allowed', 'network', 'language-not-supported']);
let rec = null;    // the one recognizer (made again only when the old one is stuck)
let live = null;   // the session: { el, btn, lang, before, finals, interim, heard, started, err, cancel, retried, t0, timers }
let ending = null; // a session told to stop that has not ended yet
let nextUp = null; // { el, btn } to start once `ending` is over
let lastMicTap = 0;
let savedSession;  // the audio session type before the mic took it
function takeSession() {
  try { const s = navigator.audioSession; if (s && s.type !== 'play-and-record') { if (savedSession === undefined) savedSession = s.type; s.type = 'play-and-record'; } } catch {}
}
function giveSession() {
  if (savedSession === undefined) return;
  try { if (navigator.audioSession) navigator.audioSession.type = savedSession; } catch {}
  savedSession = undefined;
}
function show(L, on) {
  L.btn.classList.toggle('on', on); L.el.classList.toggle('ti-listening', on); L.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
const setup = (r, lang) => { r.lang = lang; r.interimResults = true; r.continuous = true; r.maxAlternatives = 5; };
function recognizer(fresh) {
  if (rec && !fresh) return rec;
  if (rec) { const old = rec; old.onstart = old.onaudiostart = old.onresult = old.onerror = old.onend = null; try { old.abort(); } catch {} }
  const r = rec = new SR();
  r.onstart = r.onaudiostart = () => { const L = live; if (rec !== r || !L || L.started) return; L.started = true; clearTimeout(L.startTimer); show(L, true); arm(L, FIRST_WORD_MS); };
  r.onresult = (e) => { if (rec === r && live) heard(live, e); };
  r.onerror = (e) => { const L = live || ending; if (rec === r && L) L.err = e.error || 'error'; };
  r.onend = () => { if (rec === r) ended(); };
  return r;
}
function arm(L, ms) {
  clearTimeout(L.timer);
  L.timer = setTimeout(() => { if (live === L) { if (!L.heard) L.err = 'no-speech'; stopListening(false, 'quiet'); } }, ms);
}
const textOf = (L) => tidy([...L.finals.filter(Boolean), L.interim].join(' '));
function heard(L, e) {
  L.heard = true;
  if (!L.started) { L.started = true; clearTimeout(L.startTimer); show(L, true); }
  let interim = '';
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i], t = bestAlt(r, L.lang);
    if (r.isFinal) L.finals[i] = t; else interim += ' ' + t;
  }
  L.interim = tidy(interim);
  const now = textOf(L); // the finals so far, then the words still being heard
  if (now && L.el.isConnected && !L.el.readOnly) putText(L.el, now, false); // live feedback only; the app hears the final text
  arm(L, SILENCE_MS);
}
// why: 'user' (a tap, Cancel, leaving), 'quiet' (silence timer) or 'no-start' (no onstart: may retry once)
function stopListening(cancel = false, why = 'user') {
  nextUp = null;
  const L = live;
  if (!L) return;
  L.cancel = cancel; L.why = why;
  live = null; ending = L;
  clearTimeout(L.timer); clearTimeout(L.startTimer);
  show(L, false);
  try { cancel ? rec.abort() : rec.stop(); } catch {}
  // iOS sometimes never ends: finish anyway and throw that recognizer away
  L.endTimer = setTimeout(() => { if (ending === L) { recognizer(true); ended(); } }, END_MS);
}
function ended() {
  const L = ending || live;
  if (!L) return;
  live = null; ending = null;
  clearTimeout(L.timer); clearTimeout(L.startTimer); clearTimeout(L.endTimer);
  show(L, false);
  // a fast failure (never started, or dropped at once, nothing heard): try once more, on a fresh recognizer
  const fast = !L.cancel && !L.heard && !L.retried && !HARD.has(L.err) && (!L.why || L.why === 'no-start')
    && (!L.started || (Date.now() - L.t0 < FAST_FAIL_MS && ['aborted', 'audio-capture', 'no-speech'].includes(L.err)));
  if (fast && L.el.isConnected && !nextUp) { recognizer(true); begin(L.el, L.btn, L.before); return; }
  giveSession();
  finish(L);
  if (nextUp) { const q = nextUp; nextUp = null; if (q.el.isConnected) begin(q.el, q.btn); }
}
function finish(L) {
  const { el } = L;
  if (!el.isConnected || el.readOnly || el.disabled) return;
  const text = textOf(L);
  if (text && !L.cancel) { putText(el, el.maxLength > 0 ? text.slice(0, el.maxLength) : text, true); return; }
  if (el.value !== L.before) putText(el, L.before, false);
  if (L.cancel || (L.why === 'user' && !L.err)) return; // stopped on purpose before any words: nothing to say
  const err = !L.started && (!L.err || L.err === 'aborted' || L.err === 'no-start') ? 'no-start' : L.err === 'aborted' ? null : L.err || 'no-speech';
  if (!err) return;
  toast(MSG[err] || (err === 'language-not-supported' ? `${LANGS[L.lang]} isn’t supported here` : 'Voice input stopped: ' + err));
}
// retryOf: the text before the first try (a retry keeps it)
function begin(el, btn, retryOf) {
  const lang = voiceLang(), retry = retryOf !== undefined;
  const L = live = { el, btn, lang, before: retry ? retryOf : el.value, finals: [], interim: '', heard: false, started: false, err: null, cancel: false, retried: retry, t0: Date.now() };
  takeSession();
  try { const r = recognizer(false); setup(r, lang); r.start(); }
  catch { // InvalidStateError: still busy (or broken) — a fresh recognizer, right now, still inside the tap
    try { const r = recognizer(true); setup(r, lang); r.start(); }
    catch { L.err = 'no-start'; L.retried = true; ended(); return; }
  }
  // no onstart in time: the mic never came on (and the pulse was never shown)
  L.startTimer = setTimeout(() => { if (live === L && !L.started) { L.err = 'no-start'; stopListening(false, 'no-start'); } }, START_MS);
}
function listen(el, btn) {
  const now = Date.now();
  if (now - lastMicTap < DOUBLE_TAP_MS) return; // a double tap counts once (not start-then-stop)
  lastMicTap = now;
  if (live) { const same = live.el === el; stopListening(); if (same) return; }
  else if (nextUp?.el === el) { nextUp = null; return; }
  if (ending) { nextUp = { el, btn }; return; } // the last session is still winding down: start on its onend
  begin(el, btn);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopListening(false); });
addEventListener('pagehide', () => stopListening(false));
export const micState = () => ({ live: !!live, started: !!live?.started, ending: !!ending, queued: !!nextUp }); // for tests

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
  if (live?.el !== el && nextUp?.el !== el) { lastMicTap = 0; listen(el, btn); }
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
