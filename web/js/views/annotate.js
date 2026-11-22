// Ink layer over a page or score: pen, highlighter, eraser. Strokes are stored in page-relative
// coordinates (0..1) so they line up at any zoom, and never touch the page image itself.
import { store } from '../store.js';
import { icon } from '../ui.js';

export const TOOLS = {
  red: { color: '#d6336c', width: 0.0035, alpha: 1 },
  blue: { color: '#1c7ed6', width: 0.0035, alpha: 1 },
  black: { color: '#222', width: 0.003, alpha: 1 },
  yellow: { color: '#fcc419', width: 0.02, alpha: 0.38 },
  green: { color: '#40c057', width: 0.02, alpha: 0.32 },
  eraser: { eraser: true },
};

export class InkLayer {
  constructor(wrap, itemId, page) {
    this.wrap = wrap; this.itemId = itemId; this.page = page;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ink';
    wrap.append(this.canvas);
    this.strokes = store.strokes(itemId, page).slice();
    this.tool = null;
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(wrap);
    this.bind();
  }
  fit() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.draw();
  }
  draw() {
    const c = this.canvas.getContext('2d');
    const dpr = devicePixelRatio || 1;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) {
      const t = TOOLS[s.tool];
      if (!t || s.pts.length < 1) continue;
      c.globalAlpha = t.alpha;
      c.strokeStyle = t.color;
      c.lineWidth = Math.max(1.2, t.width * this.w);
      c.lineCap = s.tool === 'yellow' || s.tool === 'green' ? 'butt' : 'round';
      c.lineJoin = 'round';
      c.beginPath();
      s.pts.forEach(([x, y], i) => (i ? c.lineTo(x * this.w, y * this.h) : c.moveTo(x * this.w, y * this.h)));
      if (s.pts.length === 1) c.lineTo(s.pts[0][0] * this.w + 0.1, s.pts[0][1] * this.h);
      c.stroke();
    }
    c.globalAlpha = 1;
  }
  setTool(tool) {
    this.tool = tool;
    this.canvas.classList.toggle('active', !!tool);
  }
  bind() {
    let cur = null;
    const pt = (e) => { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.tool) return;
      // finger draws only when no pencil has been seen (palm rejection light)
      if (e.pointerType === 'touch' && this.sawPen) return;
      if (e.pointerType === 'pen') this.sawPen = true;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      if (TOOLS[this.tool].eraser) { cur = { erase: true }; this.erase(pt(e)); return; }
      cur = { tool: this.tool, pts: [pt(e)] };
      this.strokes.push(cur);
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!cur) return;
      if (cur.erase) return this.erase(pt(e));
      cur.pts.push(pt(e).map((v) => Math.round(v * 10000) / 10000));
      this.draw();
    });
    const end = () => { if (cur) { cur = null; this.save(); } };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }
  erase([x, y]) {
    const r = 0.015;
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => !s.pts.some(([a, b]) => Math.abs(a - x) < r && Math.abs(b - y) < r * (this.w / this.h)));
    if (this.strokes.length !== before) this.draw();
  }
  undo() { this.strokes.pop(); this.draw(); this.save(); }
  clear() { this.strokes = []; this.draw(); this.save(); }
  save() { store.setStrokes(this.itemId, this.page, this.strokes); }
  destroy() { this.ro.disconnect(); this.canvas.remove(); }
}

// toolbar shown while annotating; calls back with the chosen tool or an action
export function inkToolbar(onTool, onAction, initial = 'red') {
  const bar = document.createElement('div');
  bar.className = 'inkbar';
  bar.innerHTML = Object.entries(TOOLS).map(([k, t]) =>
    `<button data-tool="${k}" class="${k === initial ? 'on' : ''}" title="${k === 'eraser' ? 'Eraser' : k === 'yellow' || k === 'green' ? 'Highlighter' : 'Pen'}">${
      k === 'eraser' ? 'Eraser' : `<span class="swatch ${k === 'yellow' || k === 'green' ? 'hl' : ''}" style="background:${t.color}"></span>`}</button>`).join('') +
    `<span class="sep"></span><button data-act="undo" title="Undo">Undo</button><button data-act="clear">Clear page</button><button data-act="done" class="primary">Done</button>`;
  bar.onclick = (e) => {
    const t = e.target.closest('[data-tool]');
    if (t) { bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b === t)); onTool(t.dataset.tool); return; }
    const a = e.target.closest('[data-act]');
    if (a) onAction(a.dataset.act);
  };
  return bar;
}
