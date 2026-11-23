// Small UI helpers shared by every view: escaping, icons, toasts, sheets (modals), menus.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const P = {
  library: '<path d="M4 5h4v14H4zM10 5h4v14h-4zM16.5 5.5l3.8 1-3.3 13-3.8-1z"/>',
  sheet: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11h7M9 14h7M9 17h7"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 10h6"/>',
  chords: '<circle cx="8" cy="17" r="3"/><circle cx="17" cy="15" r="3"/><path d="M11 17V5l9-2v12"/>',
  score: '<path d="M3 6h18M3 10h18M3 14h18M3 18h18"/><circle cx="9" cy="16" r="2.2" fill="currentColor"/><path d="M11.2 16V6"/>',
  collection: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M6 4h12M8 1.8h8"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  bin: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tools: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4M12 2v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  pen: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  write: '<path d="M3 17c3-8 5-10 6-8s-3 9-1 9 3-6 5-6-1 5 1 5 2-2 3-2"/><path d="M3 21h18"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8M10.5 7.5v6M7.5 10.5h6"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8M7.5 10.5h6"/>',
  perform: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  print: '<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  pointer: '<path d="M5 3l13 8-6 1.5L9 19z"/>',
  clearpage: '<path d="M6 3h9l4 4v14H6z"/><path d="M9.5 11.5l6 6M15.5 11.5l-6 6"/>',
  text: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M12 9v7"/>',
  select: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  eraser: '<path d="M8 20l-5-5L14 4l7 7-9 9zM17 20H8"/>',
  highlighter: '<path d="M9 15l-3 5h7M9 15l8-11 4 3-8 11z"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 01-3 3H3"/>',
  metronome: '<path d="M8 3h8l4 18H4zM12 17l5-11"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  photo: '<rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-6-6-9 9"/>',
  link: '<path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
  wave: '<path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h-2"/>',
  drag: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  up: '<path d="M5 15l7-7 7 7"/>',
  down: '<path d="M5 9l7 7 7-7"/>',
  split: '<path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/>',
  merge: '<path d="M4 4l8 8 8-8M12 12v9"/>',
  sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  wifi: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  moon: '<path d="M20 14A8 8 0 1110 4a7 7 0 0010 10z"/>',
  restore: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 3v4h4"/>',
  // score toolbar toggles: kids note names (a baby's face), chords (piano keys / ukulele / an empty chord box = off), voice (a singing head)
  baby: '<circle cx="12" cy="13" r="8"/><path d="M12 5c-.6-1.6.4-2.8 1.8-2.4"/><circle cx="9.2" cy="12.4" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="12.4" r="1" fill="currentColor" stroke="none"/><path d="M9.6 16.2c1.4 1.2 3.4 1.2 4.8 0M3.6 12.6H2.4M21.6 12.6h-1.2"/>',
  piano: '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M7.25 13v6M12 13v6M16.75 13v6"/><path d="M6 5h2.5v8H6zM10.75 5h2.5v8h-2.5zM15.5 5H18v8h-2.5z" fill="currentColor"/>',
  // Simple piano (score toolbar): a keyboard under a slider
  simplepiano: '<rect x="2.5" y="10" width="19" height="10.5" rx="1.5"/><path d="M8.5 15.5v5M15.5 15.5v5"/><path d="M7 10h3v5.5H7zM14 10h3v5.5h-3z" fill="currentColor"/><path d="M3 5h18"/><circle cx="14" cy="5" r="2" fill="currentColor"/>',
  chordgrid: '<rect x="6" y="3" width="12" height="18" rx="1.2"/><path d="M6 7.5h12M6 12h12M6 16.5h12M10 3v18M14 3v18"/>',
  voice: '<path d="M5 21v-3.2a2 2 0 0 0-.7-1.5A7 7 0 0 1 9.6 4a6.3 6.3 0 0 1 6.3 6.2l1.6 3.3h-1.6v2.2a2 2 0 0 1-2 2h-1.7V21"/><path d="M19 8.2a4.6 4.6 0 0 1 0 5.6M21.4 5.8a8.4 8.4 0 0 1 0 10.4"/>',
  // ukulele chords: a small guitar body with a sound hole and a neck with tuning pegs
  ukulele: '<path d="M13.6 10.4l6-6M18.2 2.6l3.2 3.2M17 3.8l1 1M20.2 7l-1-1"/><path d="M13 11a3.2 3.2 0 0 0-4.7.2 3.1 3.1 0 0 1-2.3 1.2 3.9 3.9 0 0 0-2.6 6.6l1.6 1.6a3.9 3.9 0 0 0 6.6-2.6 3.1 3.1 0 0 1 1.2-2.3A3.2 3.2 0 0 0 13 11z"/><circle cx="9.2" cy="14.8" r="1.3"/><path d="M6.2 16.4l1.4 1.4"/>',
  paw: '<ellipse cx="12" cy="16" rx="4.5" ry="3.8" fill="currentColor"/><circle cx="6" cy="10" r="2" fill="currentColor"/><circle cx="10" cy="6.5" r="2" fill="currentColor"/><circle cx="14" cy="6.5" r="2" fill="currentColor"/><circle cx="18" cy="10" r="2" fill="currentColor"/>',
};
// Icons are switched off for now (user request); every control carries a text label instead.
export const ICONS_ON = false;
// the few icons the user asked to keep (Annotate, More) use iconOn
export const iconOn = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
export const icon = (name, cls = '') => (ICONS_ON ? `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>` : '');

export const CAT = ''; // mascot removed for now

export const KIND = {
  sheet: { label: 'Sheet', plural: 'Sheets', icon: 'sheet' },
  book: { label: 'Book', plural: 'Books', icon: 'book' },
  chords: { label: 'Chords', plural: 'Chords', icon: 'chords' },
  score: { label: 'Score', plural: 'Scores', icon: 'score' },
};
// a book is a sheet with book = 1 (many pages, many songs); everywhere else it reads as its own kind
// where a link comes from: 'YouTube' | 'Facebook' | its host name (same rule as the server's platform_of)
export function platformOf(url) {
  let host = '';
  try { host = new URL(/^\w+:\/\//.test(url) ? url : 'https://' + url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  if (['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return 'YouTube';
  if (['facebook.com', 'fb.watch', 'm.facebook.com', 'fb.com', 'web.facebook.com'].includes(host)) return 'Facebook';
  return host;
}
// a score's source: { name, url } ('YouTube' + the original link); old 'YouTube · youtu.be/x' sources still read right
export function scoreSource(it) {
  const m = /^(YouTube|Facebook) · (\S+)$/.exec(it.source || '');
  const url = it.sourceUrl || (m ? (/^https?:/.test(m[2]) ? '' : 'https://') + m[2] : '');
  return { name: m ? platformOf(url) || m[1] : (it.source === 'Meowsic AI' ? 'Meowsic' : it.source) || (it.ai ? 'Meowsic' : ''), url };
}
// AI pieces (score.ai = 1, source 'Meowsic') are plain scores
export const kindOf = (it) => (it.kind === 'sheet' && it.book ? 'book' : it.kind);
export const badge = (x) => { const kind = typeof x === 'string' ? x : kindOf(x); return `<span class="badge k-${kind}">${icon(KIND[kind].icon)}${KIND[kind].label}</span>`; };

export function ago(ts) {
  if (!ts) return 'Never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 2) return 'Yesterday';
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export const mins = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// ---------- toast ----------
let toastTimer;
export function toast(msg, action) {
  let el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="link">${esc(action.label)}</button>` : '');
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2600);
}

// ---------- sheet (modal) ----------
export function sheet(html, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key); onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  const first = wrap.querySelector('input,select,textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { el: wrap.firstElementChild, close };
}

// in-app confirm (never the browser's)
export function confirmSheet({ title, body = '', ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet(`<h2>${esc(title)}</h2>${body ? `<p class="muted">${esc(body)}</p>` : ''}
      <div class="modal-actions"><button data-close>Cancel</button><button class="${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
      { onClose: () => { if (!answered) resolve(false); } });
    s.el.querySelector('[data-ok]').onclick = () => { answered = true; s.close(); resolve(true); };
  });
}

export function promptSheet({ title, value = '', placeholder = '', ok = 'Save', required = true }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet(`<h2>${esc(title)}</h2><form><input value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}>
      <div class="modal-actions"><button type="button" data-close>Cancel</button><button class="primary">${esc(ok)}</button></div></form>`,
      { onClose: () => { if (!answered) resolve(null); } });
    const input = s.el.querySelector('input');
    setTimeout(() => input.select(), 40);
    s.el.querySelector('form').onsubmit = (e) => { e.preventDefault(); answered = true; s.close(); resolve(input.value.trim() || (required ? null : '')); };
  });
}

// ---------- pop-up menu ----------
export function menu(anchor, entries) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = entries.map((e, i) => (e === '-' ? '<hr>' : `<button role="${'checked' in e ? 'menuitemcheckbox' : 'menuitem'}" data-i="${i}" class="${e.danger ? 'danger' : ''}"${'checked' in e ? ` aria-checked="${!!e.checked}"` : ''}>${e.icon ? icon(e.icon) : ''}<span>${esc(e.label)}</span>${'checked' in e ? `<b class="mcheck">${e.checked ? '✓' : ''}</b>` : ''}</button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  const off = (e) => { if (!m.contains(e.target)) close(); };
  const close = () => { m.remove(); document.removeEventListener('pointerdown', off, true); };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; close(); entries[+b.dataset.i].run(); };
  m.querySelector('button')?.focus();
}

// tag picker used by item rows, bulk edit and imports
export function tagPicker(all, selected, onChange) {
  const sel = new Set(selected);
  const box = document.createElement('div');
  box.className = 'tag-pick';
  const draw = () => {
    box.innerHTML = all.map((t) => `<button type="button" class="chip ${sel.has(t) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('') +
      `<form class="chip-new"><input placeholder="New tag" aria-label="New tag"></form>`;
  };
  draw();
  box.onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    sel.has(t) ? sel.delete(t) : sel.add(t);
    b.classList.toggle('on');
    onChange([...sel]);
  };
  box.onsubmit = (e) => {
    e.preventDefault();
    const v = box.querySelector('input').value.trim();
    if (!v) return;
    if (!all.includes(v)) all.push(v);
    sel.add(v); draw(); onChange([...sel]);
    box.querySelector('input').focus();
  };
  return box;
}
