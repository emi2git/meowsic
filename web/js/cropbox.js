// The one crop box (Manage library → Fix pages → Crop, and Add music → From Photos before the pages become sheets).
// Boxes are fractions of the ORIGINAL photo {top, bottom, left, right}; drag a red edge or corner, or draw a
// new box anywhere on the photo; arrow keys nudge (nudge()). Frame 1 / Frame 2 are two saved boxes kept on
// the Mac (/api/cleanup/frames), so every device has them.
import { $, toast } from './ui.js';

export const full = () => ({ top: 0, bottom: 1, left: 0, right: 1 });
export const isFull = (b) => !b || (b.top <= 0.001 && b.bottom >= 0.999 && b.left <= 0.001 && b.right >= 0.999);
export const boxOf = (c) => ({ top: +c.top.toFixed(4), bottom: +c.bottom.toFixed(4), left: +c.left.toFixed(4), right: +c.right.toFixed(4) });
export const frameText = (b) => b ? `top ${Math.round(b.top * 100)}% · bottom ${Math.round(b.bottom * 100)}%` + (b.left > 0.001 || b.right < 0.999 ? ` · left ${Math.round(b.left * 100)}% · right ${Math.round(b.right * 100)}%` : '') : 'not saved';

const HANDLES = ['top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'].map((e) => `<i data-e="${e}"></i>`).join('');

// host gets the photo with the box on it. onChange(box, from) after every change.
export function cropStage(host, { src, box, from = '', imgId = '', onChange = () => {} }) {
  host.innerHTML = `<div class="cu-img"><img ${imgId ? `id="${imgId}"` : ''} src="${src}" alt="" draggable="false"><div class="cu-shade"></div><div class="cu-box">${HANDLES}</div></div>`;
  const wrap = $('.cu-img', host), img = $('img', wrap);
  const c = { ...full(), ...(box || {}) };
  let label = from;
  const place = () => { for (const k of ['top', 'bottom', 'left', 'right']) wrap.style.setProperty('--' + k[0], c[k] * 100 + '%'); onChange({ ...c }, label); };
  wrap.onpointerdown = (e) => {
    const r = img.getBoundingClientRect();
    const at = (ev) => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
    const edges = e.target.dataset?.e?.split(' ');
    const [x0, y0] = at(e);
    e.preventDefault();
    const mv = (ev) => {
      const [x, y] = at(ev);
      if (edges) {
        for (const ed of edges) {
          if (ed === 'top') c.top = Math.min(y, c.bottom - 0.1);
          if (ed === 'bottom') c.bottom = Math.max(y, c.top + 0.1);
          if (ed === 'left') c.left = Math.min(x, c.right - 0.1);
          if (ed === 'right') c.right = Math.max(x, c.left + 0.1);
        }
      } else if (Math.abs(x - x0) > 0.02 || Math.abs(y - y0) > 0.02) {
        Object.assign(c, { top: Math.min(y, y0), bottom: Math.max(y, y0), left: Math.min(x, x0), right: Math.max(x, x0) });
      } else return;
      label = 'Your box'; place();
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (c.bottom - c.top < 0.2 || c.right - c.left < 0.2) { Object.assign(c, full()); label = 'Whole page'; place(); toast('Box too small — whole page'); }
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  place();
  return {
    get box() { return { ...c }; },
    get from() { return label; },
    set(b, f) { Object.assign(c, full(), b || {}); label = f ?? label; place(); },
    nudge(edge, d) {
      if (edge === 'top') c.top = Math.min(c.bottom - 0.2, Math.max(0, c.top + d));
      if (edge === 'bottom') c.bottom = Math.max(c.top + 0.2, Math.min(1, c.bottom + d));
      if (edge === 'left') c.left = Math.min(c.right - 0.2, Math.max(0, c.left + d));
      if (edge === 'right') c.right = Math.max(c.left + 0.2, Math.min(1, c.right + d));
      label = 'Your box'; place();
    },
  };
}

// Frame 1 / Frame 2: tap to use, ⤓ (or long-press / right-click) to save the current box there.
let FRAMES = null;
const framesApi = async (method, body) => {
  const r = await fetch('/api/cleanup/frames', { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('Frames not saved — the Mac said no');
  return r.json();
};
// Saved boxes without a bar (Manage library → Crop: behind a "Saved boxes" menu; keys 1 / 2 / ⇧1 / ⇧2)
export async function savedBoxes(stage) {
  if (!FRAMES) FRAMES = await framesApi('GET').catch(() => ({ 1: null, 2: null }));
  return {
    get(n) { return FRAMES[n]; },
    use(n) { if (!FRAMES[n]) return toast(`Box ${n} is not saved yet`); stage().set(FRAMES[n], `Saved box ${n}`); },
    async save(n) { try { FRAMES = await framesApi('POST', { n, box: boxOf(stage().box) }); toast(`Saved as box ${n}: ${frameText(FRAMES[n])}`); } catch (e) { toast(e.message); } },
  };
}
export async function framesBar(host, stage) {
  if (!FRAMES) FRAMES = await framesApi('GET').catch(() => ({ 1: null, 2: null }));
  const draw = () => {
    host.className = 'cu-frames';
    host.innerHTML = [1, 2].map((n) => `<span class="cu-fr"><button data-fr="${n}" class="ghost" ${FRAMES[n] ? '' : 'disabled'} title="${FRAMES[n] ? `Use Frame ${n} (${n})` : `Frame ${n} not saved yet — ⤓ saves the box`}">Frame ${n}<small>${frameText(FRAMES[n])}</small></button><button data-frs="${n}" class="ghost cu-frsave" title="Save box as Frame ${n} (⇧${n})" aria-label="Save box as Frame ${n}">⤓</button></span>`).join('');
  };
  const use = (n) => { if (!FRAMES[n]) return toast(`Frame ${n} is not saved yet — ⤓ (or ⇧${n}) saves the box`); stage().set(FRAMES[n], `Frame ${n}`); };
  const save = async (n) => {
    try { FRAMES = await framesApi('POST', { n, box: boxOf(stage().box) }); draw(); toast(`Saved as Frame ${n}: ${frameText(FRAMES[n])}`); } catch (e) { toast(e.message); }
  };
  host.onclick = (e) => { const a = e.target.closest('[data-fr]'), sv = e.target.closest('[data-frs]'); if (a) use(+a.dataset.fr); else if (sv) save(+sv.dataset.frs); };
  host.oncontextmenu = (e) => { const a = e.target.closest('[data-fr]'); if (a) { e.preventDefault(); save(+a.dataset.fr); } };
  draw();
  return { use, save };
}
