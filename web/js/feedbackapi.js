// Feedback, shared by the Developer page (views/feedback.js) and the quick feedback popover in the item
// views (quickfeedback.js): one pool on the Mac (server/meowsic/feedback.py), one copy on this device.
// Offline: a note waits in the store's outbox (the app's own id, so a resend is not stored twice).
import { store, uid } from './store.js';
import { device } from './device.js';

const CACHE = 'meowsic-feedback-v1';
export const DEVICE = { desktop: 'Mac', tablet: 'iPad', phone: 'iPhone' };
export const deviceName = () => DEVICE[device()] || '';
export const fbCache = { get() { try { return JSON.parse(localStorage.getItem(CACHE)) || []; } catch { return []; } }, set(v) { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch {} } };

// one request to the Mac: {ok, data} | {queued} (no network: waits in the outbox) | {error, status}
export async function fbCall(method, path, body) {
  if (store.mode === 'mock') return { ok: true, data: null };
  if (store.mode === 'offline') { store.api(method, path, body); return { queued: true }; }
  try {
    const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.headers.get('X-Meowsic-Offline')) throw new Error('offline');
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: j } : { error: j.detail || `Failed (${r.status})`, status: r.status };
  } catch {
    store.api(method, path, body); // tries once more, then queues (and the app goes offline)
    return { queued: true };
  }
}

// a new note (with what it is about, from an item view): {row, queued} | {error}; the row is kept on this device
export async function sendFeedback(text, { item = null, context = {} } = {}) {
  const now = Date.now();
  const f = { id: uid('fb'), text, createdAt: now, updatedAt: now, status: 'new', fixedAt: null, fixNote: '', device: deviceName(), removedAt: null, item, context };
  const r = await fbCall('POST', '/feedback', { id: f.id, text, device: f.device, createdAt: now, ...(item ? { item, context } : {}) });
  if (r.error) return { error: r.error };
  const row = r.data?.id ? r.data : { ...f, pending: !!r.queued };
  const rows = fbCache.get().filter((x) => x.id !== row.id);
  rows.unshift(row); fbCache.set(rows);
  return { row, queued: !!r.queued };
}
