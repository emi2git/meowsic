// Simple piano (score toolbar → the Simple piano button; on iPhone a bottom sheet): one menu with live preview.
// The slider smooths rests + rhythm (0 = as is … 100 = smoothest: rests absorbed when nothing else sounds, odd
// values snapped to a simple grid, rests in a row merged, the left hand held); toggles: Main note only, Right hand,
// Left hand, Remove staccato, Remove grace notes & trills, Remove dynamics & pedal. Every change asks the Mac for a
// preview (server/meowsic/simplepiano.py, ~200 ms after the last move) and draws it in the score (play it too).
// Save into this score (the file before stays in .history, Activities can undo it) or as a new "Simple piano" version.
import { $, toast } from '../ui.js';
import { go } from '../app.js';

const api = (path, body) => fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); return j; });

const TOGGLES = [
  ['main', 'Main note only', 'Chords become the main note of each hand'],
  ['right', 'Right hand', 'Off: the right hand is hidden and silent'],
  ['left', 'Left hand', 'Off: the left hand is hidden and silent'],
  ['staccato', 'Remove staccato', 'Recordings mark many plain notes staccato'],
  ['grace', 'Remove grace notes & trills', 'Also the very short notes a recording puts before a note'],
  ['marks', 'Remove dynamics & pedal', 'p, f, hairpins and pedal marks'],
];
const LEVEL_HELP = (v) => v === 0 ? 'As is' : v < 25 ? 'Tiny gaps filled' : v < 50 ? 'Short rests filled, odd values snapped' : v < 75 ? 'Simple rhythm, fewer rests' : v < 90 ? 'Plain rhythm, held notes' : 'Smoothest';

export async function simplePiano(view, it, host) {
  if (!host) return;
  const old = host.querySelector('.sp-panel');
  if (old) { old.dispatchEvent(new Event('close')); return; }   // the button toggles the menu
  host.querySelector('.editbar')?.dispatchEvent(new Event('close'));
  let s;
  try { s = (await api(`/items/${encodeURIComponent(it.id)}/simplepiano`)).defaults; } catch (e) { toast(e.message); return; }
  const panel = document.createElement('div');
  panel.className = 'sp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Simple piano');
  host.append(panel);
  host.classList.add('simplifying');
  let prev = null, busy = false, shown = false, seq = 0, timer = 0;
  const stat = () => {
    if (!prev) return 'Working…';
    if (!prev.changed) return 'No change with these settings';
    const a = prev.before, b = prev.after, f = prev.found || {};
    const bits = [`Rests ${a.rests} → ${b.rests}`];
    if (a.tied !== b.tied) bits.push(`ties ${a.tied} → ${b.tied}`);
    if (f.staccato) bits.push(`${f.staccato} staccato`);
    const g = (f.grace || 0) + (f.ornaments || 0) + (f.short || 0);
    if (g) bits.push(`${g} grace/trill`);
    if (f.marks) bits.push(`${f.marks} marks`);
    return bits.join(' · ');
  };
  panel.innerHTML = `<div class="sp-row"><b class="sp-title">Simple piano</b><span class="sp-count" id="sp-count" aria-live="polite">Working…</span>
      <button class="sp-x" data-a="cancel" aria-label="Close">×</button></div>
    <label class="sp-slider"><span>Smooth rests &amp; rhythm</span>
      <input type="range" id="sp-level" min="0" max="100" step="5" value="${s.level}" aria-label="Smooth rests and rhythm">
      <b id="sp-lv">${s.level}</b></label>
    <p class="muted sp-help" id="sp-help">${LEVEL_HELP(s.level)}</p>
    <div class="sp-toggles">${TOGGLES.map(([k, label, help]) => `<label class="sp-tg" title="${help}"><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
    <div class="sp-acts"><button data-a="play" class="sp-play">Play</button><span class="grow"></span><button data-a="new" disabled>Save as new version</button><button class="primary" data-a="this" disabled>Save to this score</button></div>`;
  const count = $('#sp-count', panel), level = $('#sp-level', panel);
  const draw = () => {
    count.textContent = stat();
    for (const b of panel.querySelectorAll('[data-a="new"],[data-a="this"]')) b.disabled = busy || !prev?.changed;
    const pb = panel.querySelector('.sp-play'); if (pb) pb.textContent = view.player?.playing ? 'Pause' : 'Play';
  };
  const load = async () => {
    const my = ++seq;
    prev = null; draw();
    try {
      const p = await api(`/items/${encodeURIComponent(it.id)}/simplepiano/preview`, s);
      if (my !== seq || !panel.isConnected) return;   // a newer move is on its way
      prev = p;
      if (p.changed) { await view.showXml(p.xml); shown = true; }
      else if (shown) { await view.reload(); shown = false; }
    } catch (e) { if (my === seq) { toast(e.message); count.textContent = e.message; } return; }
    if (my === seq) draw();
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  const close = async (keep) => {
    clearTimeout(timer); seq++;
    view.player?.pause(); panel.remove(); host.classList.remove('simplifying');
    if (shown && !keep) await view.reload();
  };
  panel.addEventListener('close', () => close());
  level.addEventListener('input', () => {
    s.level = +level.value;
    $('#sp-lv', panel).textContent = s.level; $('#sp-help', panel).textContent = LEVEL_HELP(s.level);
    later();
  });
  panel.addEventListener('change', (e) => {
    const k = e.target.dataset?.k;
    if (!k) return;
    s[k] = e.target.checked;
    if (!s.left && !s.right) { // keep one hand
      const other = k === 'left' ? 'right' : 'left';
      s[other] = true; panel.querySelector(`[data-k="${other}"]`).checked = true;
    }
    later();
  });
  const save = async (mode) => {
    if (busy || !prev?.changed) return;
    busy = true; draw();
    try {
      const j = await api(`/items/${encodeURIComponent(it.id)}/simplepiano`, { ...s, mode, sha: prev.sha });
      await close(true);
      if (mode === 'new') {
        toast(`Saved as a new Simple piano version — this score is unchanged`, { label: 'Activities', run: () => go('#/activity') });
        go(`#/item/${encodeURIComponent(j.item.id)}`);
      } else {
        await view.reload();
        toast(`Simple piano saved (rests ${j.before.rests} → ${j.after.rests}) — Activities can undo it`, { label: 'Activities', run: () => go('#/activity') });
      }
    } catch (e) { busy = false; draw(); toast(e.message); }
  };
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'play') { const p = view.player; if (p.playing) p.pause(); else p.play().catch(() => {}); setTimeout(draw, 50); }
    else if (a === 'cancel') close();
    else if (a === 'new' || a === 'this') save(a);
  });
  await load();
}
