// Manage library: what the hub, Check suspect songs, Fix pages and Crop share — the Mac's API, one Undo stack
// (it outlives the views: open a sheet, come back, Undo still works; the Mac keeps the real history in Activities),
// the header of every flow, and taps that act on pointerup (iPad: no lost taps, no 300 ms wait; as completeinfo.js).
import { store } from '../store.js';
import { esc, toast } from '../ui.js';

export const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.detail && (data.detail.message || (typeof data.detail === 'string' ? data.detail : ''))) || 'The Mac said no.');
  return data;
};
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const range = (a, b) => (a === b ? `page ${a}` : `pages ${a}–${b}`);
export const thumb = (id, p, v, w = 400) => `/api/items/${encodeURIComponent(id)}/thumb/${p}?w=${w}&v=${v || 0}`;
export const listPages = (ps) => (ps.length === 1 ? `page ${ps[0]}` : `pages ${ps.slice(0, -1).join(', ')} and ${ps.at(-1)}`);

// ---------- Undo: each entry rolls back an Activities row (or puts marks back) ----------
export const UNDO = [];
const subs = new Set();
export const onUndo = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const changed = () => subs.forEach((f) => f());
export function pushUndo(label, run) { UNDO.push({ label, run }); changed(); }
export function pushAct(label, aid, ids = []) {
  if (!aid) return;
  pushUndo(label, async () => {
    await api('POST', `/activity/${encodeURIComponent(aid)}/undo`, {});
    for (const i of ids) { try { store.putItem(await api('GET', `/items/${encodeURIComponent(i)}`)); } catch {} }
  });
}
let undoing = false;
export async function undoLast() {
  if (undoing) return false;
  const u = UNDO.pop();
  if (!u) { toast('Nothing to undo'); return false; }
  undoing = true; changed();
  try { await u.run(); toast(`Undone: ${u.label}`); return true; } catch (e) { toast(e.message); return false; } finally { undoing = false; changed(); }
}
export const canUndo = () => !!UNDO.length && !undoing;
export const undoLabel = () => UNDO.at(-1)?.label || '';

// the Help icon (a ? in a circle), for the Help buttons
export const HELP_IC = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17v.2"/></svg>';

// ---------- the header of a flow: ‹ Back, title (+ a small line), right side ----------
export const head = ({ back = '#/manage', backLabel = 'Manage', title, sub = '', right = '', h = 'h2' }) => `<header class="top mg-top">
    <a class="mg-back" href="${back}">‹ ${esc(backLabel)}</a>
    <div class="mg-t"><${h}>${esc(title)}</${h}>${sub !== null ? `<small id="mg-sub">${sub}</small>` : ''}</div>
    <span class="grow"></span>${right}</header>`;

// a tap = down and up on the same element, hardly moved (a scroll is a pointercancel); acts on the up. The click
// that follows is dropped; a click with no tap before it (Mac, keyboard, VoiceOver) acts.
export function taps(root, sel, act) {
  let down = null, tapped = 0;
  const target = (e) => { const el = e.target.closest?.(sel); return el && root.contains(el) ? el : null; };
  const pd = (e) => {
    if (e.pointerType === 'mouse' || e.button > 0 || !e.isPrimary) { down = null; return; }
    const el = target(e); down = el ? { el, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
  };
  const pc = () => { down = null; };
  const pu = (e) => {
    const d = down; down = null;
    if (!d || d.id !== e.pointerId || !d.el.isConnected || d.el.disabled) return;
    if (d.el.tagName === 'A' && d.el.getAttribute('href')) return;  // links: the browser's own click navigates
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 16) return;
    const b = d.el.getBoundingClientRect(), m = 10;
    if (e.clientX < b.left - m || e.clientX > b.right + m || e.clientY < b.top - m || e.clientY > b.bottom + m) return;
    tapped = Date.now();
    act(d.el, e);
  };
  const cl = (e) => {
    const el = target(e); if (!el) return;
    if (Date.now() - tapped < 700) { e.preventDefault(); return; }
    if (el.disabled) return;
    if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('#')) return;  // plain links navigate themselves
    e.preventDefault();
    act(el, e);
  };
  root.addEventListener('pointerdown', pd); root.addEventListener('pointercancel', pc); root.addEventListener('pointerup', pu); root.addEventListener('click', cl);
  return () => { root.removeEventListener('pointerdown', pd); root.removeEventListener('pointercancel', pc); root.removeEventListener('pointerup', pu); root.removeEventListener('click', cl); };
}
