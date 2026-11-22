// Small UI helpers shared by every view: escaping, icons, toasts, sheets (modals), menus.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const P = {
  library: '<path d="M4 5h4v14H4zM10 5h4v14h-4zM16.5 5.5l3.8 1-3.3 13-3.8-1z"/>',
  sheet: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11h7M9 14h7M9 17h7"/>',
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
  pen: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  perform: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  print: '<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
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
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  wifi: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  moon: '<path d="M20 14A8 8 0 1110 4a7 7 0 0010 10z"/>',
  restore: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 3v4h4"/>',
  paw: '<ellipse cx="12" cy="16" rx="4.5" ry="3.8" fill="currentColor"/><circle cx="6" cy="10" r="2" fill="currentColor"/><circle cx="10" cy="6.5" r="2" fill="currentColor"/><circle cx="14" cy="6.5" r="2" fill="currentColor"/><circle cx="18" cy="10" r="2" fill="currentColor"/>',
};
export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;

export const CAT = `<svg class="cat" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M10 26 L12 6 L26 18 Q32 16 38 18 L52 6 L54 26 Q58 34 54 44 Q46 58 32 58 Q18 58 10 44 Q6 34 10 26Z" class="cat-face"/>
  <path d="M15 12 L16 22 L22 18Z M49 12 L48 22 L42 18Z" class="cat-ear"/>
  <ellipse cx="23" cy="34" rx="3.2" ry="4.2" class="cat-eye"/><ellipse cx="41" cy="34" rx="3.2" ry="4.2" class="cat-eye"/>
  <path d="M29 42 L35 42 L32 45Z" class="cat-nose"/>
  <path d="M32 45 Q29 49 25 47 M32 45 Q35 49 39 47" class="cat-line"/>
  <path d="M6 38 L20 40 M6 44 L20 43 M58 38 L44 40 M58 44 L44 43" class="cat-line"/>
  <path d="M40 6 q3 -4 6 0 M43 3 v6" class="cat-note"/></svg>`;

export const KIND = {
  sheet: { label: 'Sheet', plural: 'Sheets', icon: 'sheet' },
  chords: { label: 'Chords', plural: 'Chords', icon: 'chords' },
  score: { label: 'Score', plural: 'Scores', icon: 'score' },
};
export const badge = (kind) => `<span class="badge k-${kind}">${icon(KIND[kind].icon)}${KIND[kind].label}</span>`;

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

export function promptSheet({ title, value = '', placeholder = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet(`<h2>${esc(title)}</h2><form><input value="${esc(value)}" placeholder="${esc(placeholder)}" required>
      <div class="modal-actions"><button type="button" data-close>Cancel</button><button class="primary">${esc(ok)}</button></div></form>`,
      { onClose: () => { if (!answered) resolve(null); } });
    const input = s.el.querySelector('input');
    setTimeout(() => input.select(), 40);
    s.el.querySelector('form').onsubmit = (e) => { e.preventDefault(); answered = true; s.close(); resolve(input.value.trim() || null); };
  });
}

// ---------- pop-up menu ----------
export function menu(anchor, entries) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = entries.map((e, i) => (e === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${e.danger ? 'danger' : ''}">${e.icon ? icon(e.icon) : ''}<span>${esc(e.label)}</span></button>`)).join('');
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
