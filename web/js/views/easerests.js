// Ease rests (score ⋯ → "Ease rests…", scores transcribed from a video / audio only): a score heard from a
// recording has far too many short rests. The Mac merges short rests into the note before (it gets longer),
// combines rests in a row and keeps every bar full (server/meowsic/easerests.py). Light = rests up to an eighth,
// Strong = up to a quarter (and across the bar line). The panel draws the preview in the score (play it too);
// Save into this score (the file before stays in .history, Activities can undo it) or as a new score.
import { $, toast } from '../ui.js';
import { go } from '../app.js';

const post = (path, body) => fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); return j; });

export async function canEaseRests(it) {
  try { const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/easerests`); return r.ok && (await r.json()).allowed === true; } catch { return false; }
}

export async function easeRests(view, it, host) {
  if (!host || host.querySelector('.ease-panel')) return;
  host.querySelector('.editbar')?.dispatchEvent(new Event('close'));
  const panel = document.createElement('div');
  panel.className = 'ease-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ease rests');
  host.append(panel);
  host.classList.add('easing');
  let strength = 'light', prev = null, busy = false, shown = false;
  const draw = () => {
    panel.innerHTML = `<div class="er-row"><b class="er-title">Ease rests</b>
      <div class="seg er-seg" role="radiogroup" aria-label="Strength">${['light', 'strong'].map((s) => `<button role="radio" data-s="${s}" aria-checked="${s === strength}" class="${s === strength ? 'on' : ''}">${s === 'light' ? 'Light' : 'Strong'}</button>`).join('')}</div>
      <span class="er-count" id="er-count">${prev ? `${prev.before} → ${prev.after} rests` : 'Working…'}</span></div>
      <p class="muted er-help">${strength === 'light' ? 'Rests up to an eighth note go into the note before; rests in a row become one.' : 'Rests up to a quarter note go into the note before, also over the bar line; rests in a row become one.'} Every bar stays full. The score shows the preview — play it.</p>
      <div class="er-acts"><button data-a="play" class="er-play">${view.player?.playing ? "Pause" : "Play"}</button><span class="grow"></span><button data-a="cancel">Cancel</button><button data-a="new" ${prev?.changed ? '' : 'disabled'}>Save as new score</button><button class="primary" data-a="this" ${prev?.changed ? '' : 'disabled'}>Save into this score</button></div>`;
  };
  const load = async () => {
    busy = true; prev = null; draw();
    try {
      prev = await post(`/items/${encodeURIComponent(it.id)}/easerests/preview`, { strength });
      if (prev.changed) { await view.showXml(prev.xml); shown = true; }
      else if (shown) { await view.reload(); shown = false; }
    } catch (e) { toast(e.message); close(); return; } finally { busy = false; }
    if (panel.isConnected) draw();
    if (prev && !prev.changed) $('#er-count', panel).textContent = 'No short rests to ease';
  };
  const close = async (keep) => {
    view.player?.pause(); panel.remove(); host.classList.remove("easing");
    if (shown && !keep) await view.reload();
  };
  const save = async (mode) => {
    if (busy) return;
    busy = true;
    try {
      const j = await post(`/items/${encodeURIComponent(it.id)}/easerests`, { strength, mode, sha: prev.sha });
      await close(true);
      if (mode === 'new') {
        toast(`Saved as a new score (${j.before} → ${j.after} rests) — this one is unchanged`, { label: 'Activities', run: () => go('#/activity') });
        go(`#/item/${encodeURIComponent(j.item.id)}`);
      } else {
        await view.reload();
        toast(`Rests eased (${j.before} → ${j.after}) — Activities can undo it`, { label: 'Activities', run: () => go('#/activity') });
      }
    } catch (e) { busy = false; toast(e.message); }
  };
  panel.addEventListener('click', (e) => {
    const s = e.target.closest('[data-s]');
    if (s && !busy && s.dataset.s !== strength) { strength = s.dataset.s; load(); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === "play") { const p = view.player; if (p.playing) p.pause(); else p.play().catch(() => {}); setTimeout(() => { const b = panel.querySelector(".er-play"); if (b) b.textContent = view.player.playing ? "Pause" : "Play"; }, 50); return; }
    if (a === "cancel") { view.player?.pause(); close(); }
    else if (a === 'new' || a === 'this') save(a);
  });
  await load();
}
