// Simple piano (score toolbar → the Simple piano button; on iPhone a bottom sheet): one menu with live preview.
// The slider smooths rests + rhythm (0 = as is … 100 = smoothest: rests absorbed when nothing else sounds, odd
// values snapped to a simple grid, rests in a row merged, the left hand held); toggles: Main note only,
// Remove staccato, Remove grace notes & trills, Remove dynamics & pedal. Every change asks the Mac for a
// preview (server/meowsic/simplepiano.py, ~200 ms after the last move) and draws it in the score (play it too),
// with what changed highlighted (soft yellow behind the notes; only in the preview, gone once saved or closed).
// Save into this score (the file before stays in .history, Activities can undo it) or as a new "Simple piano" version.
import { $, toast, unsaved } from '../ui.js';
import { go } from '../app.js';

const api = (path, body) => fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `Failed (${r.status})`); return j; });

const TOGGLES = [
  ['main', 'Main note only', 'Chords become the main note of each hand'],
  ['staccato', 'Remove staccato', 'Recordings mark many plain notes staccato'],
  ['grace', 'Remove grace notes & trills', 'Also the very short notes a recording puts before a note'],
  ['marks', 'Remove dynamics & pedal', 'p, f, hairpins and pedal marks'],
];
// what the settings changed (the preview's spans: {m bar, s staff, a..b quarters into the bar}): a soft highlighter
// rectangle behind those notes, drawn into OSMD's SVG as its first children (so behind everything)
const SVGNS = 'http://www.w3.org/2000/svg';
export function highlight(osmd, host, spans) {
  host.querySelectorAll('.sp-hl').forEach((r) => r.remove());
  if (!osmd || !spans?.length) return 0;
  const pages = osmd.GraphicSheet.MusicPages, svgs = [...host.querySelectorAll('#osmd svg')];
  let k = 0;
  for (const { m, s, a, b } of spans) {
    const gm = osmd.GraphicSheet.MeasureList[m]?.[s];
    if (!gm?.PositionAndShape) continue;
    const svg = svgs[Math.max(0, pages.indexOf(gm.ParentMusicSystem?.Parent))];
    if (!svg) continue;
    const ps = gm.PositionAndShape, x0 = ps.AbsolutePosition.x, y0 = (gm.ParentStaffLine?.PositionAndShape || ps).AbsolutePosition.y; // the top staff line
    const len = (gm.parentSourceMeasure?.Duration?.RealValue || 1) * 4;
    // time → x: the notes' left edges, the bar's end at its right edge
    const pts = (gm.staffEntries || []).map((se) => [se.relInMeasureTimestamp.RealValue * 4, se.PositionAndShape.AbsolutePosition.x + se.PositionAndShape.BorderLeft - 0.6])
      .sort((p, q) => p[0] - q[0]);
    pts.push([len, x0 + ps.BorderRight]);
    if (pts[0][0] > 0) pts.unshift([0, Math.min(pts[0][1], x0 + ps.BorderLeft + 1)]);
    const at = (t) => {
      const i = pts.findIndex((p) => p[0] >= t);
      if (i < 0) return pts[pts.length - 1][1];
      if (i === 0 || pts[i][0] === t) return pts[i][1];
      const [ta, xa] = pts[i - 1], [tb, xb] = pts[i];
      return xa + ((xb - xa) * (t - ta)) / (tb - ta);
    };
    const xa = at(a), xb = Math.max(at(b), xa + 1.2);
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('class', 'sp-hl');
    r.setAttribute('x', xa * 10); r.setAttribute('y', (y0 - 1.5) * 10);
    r.setAttribute('width', (xb - xa) * 10); r.setAttribute('height', 7 * 10);
    r.setAttribute('rx', 6);
    r.dataset.bar = m; r.dataset.staff = s;
    svg.insertBefore(r, svg.firstChild);
    k++;
  }
  return k;
}

const LEVEL_HELP =(v) => v === 0 ? 'As is' : v < 25 ? 'Tiny gaps filled' : v < 50 ? 'Short rests filled, odd values snapped' : v < 75 ? 'Simple rhythm, fewer rests' : v < 90 ? 'Plain rhythm, held notes' : 'Smoothest';

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
  unsaved(panel); // settings + a preview not saved yet: no auto-reload while open (update.js)
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
      if (p.changed) { await view.showXml(p.xml); shown = true; marks(); }
      else if (shown) { await view.reload(); shown = false; }
    } catch (e) { if (my === seq) { toast(e.message); count.textContent = e.message; } return; }
    if (my === seq) draw();
  };
  const marks = () => { if (panel.isConnected) highlight(view.osmd, host, shown && prev?.changed ? prev.spans : null); };
  host.addEventListener('scoredrawn', marks);   // a zoom / resize lays the score out again
  const later = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  const close = async (keep) => {
    clearTimeout(timer); seq++;
    host.removeEventListener('scoredrawn', marks); highlight(null, host);
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
