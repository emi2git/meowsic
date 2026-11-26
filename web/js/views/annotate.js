// Ink layer over a page or score: blue / red pen, text boxes, eraser. Everything is stored in
// page-relative coordinates (0..1) so it lines up at any zoom, and never touches the page image.
import { store } from '../store.js';
import { iconOn, unsaved } from '../ui.js';

export const TOOLS = {
  blue: { color: '#1c7ed6', width: 0.0035, alpha: 1 },
  red: { color: '#d6336c', width: 0.0035, alpha: 1 },
  eraser: { eraser: true },
  text: { text: true },
  move: { move: true },
};
const TEXT_SIZE = 0.024; // of page width

export class InkLayer {
  constructor(wrap, itemId, page) {
    this.wrap = wrap; this.itemId = itemId; this.page = page;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ink';
    wrap.append(this.canvas);
    this.strokes = store.strokes(itemId, page).slice();
    this.tool = null;
    this.color = 'blue';
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
      if (s.tool === 'text') {
        c.fillStyle = (TOOLS[s.color] || TOOLS.blue).color;
        c.font = `600 ${Math.max(10, TEXT_SIZE * this.w)}px -apple-system, Helvetica, sans-serif`;
        c.textBaseline = 'top';
        s.text.split('\n').forEach((line, i) => c.fillText(line, s.pts[0][0] * this.w, s.pts[0][1] * this.h + i * TEXT_SIZE * this.w * 1.25));
        continue;
      }
      const t = TOOLS[s.tool];
      if (!t || s.pts.length < 1) continue;
      c.globalAlpha = t.alpha ?? 1;
      c.strokeStyle = t.color;
      c.lineWidth = Math.max(1.2, t.width * this.w);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      s.pts.forEach(([x, y], i) => (i ? c.lineTo(x * this.w, y * this.h) : c.moveTo(x * this.w, y * this.h)));
      if (s.pts.length === 1) c.lineTo(s.pts[0][0] * this.w + 0.1, s.pts[0][1] * this.h);
      c.stroke();
    }
    c.globalAlpha = 1;
    if (this.sel && this.strokes.includes(this.sel)) {
      const [x0, y0, x1, y1] = this.box(this.sel);
      c.setLineDash([5, 4]); c.strokeStyle = '#f06024'; c.lineWidth = 1.5;
      c.strokeRect(x0 * this.w - 6, y0 * this.h - 6, (x1 - x0) * this.w + 12, (y1 - y0) * this.h + 12);
      c.setLineDash([]);
    }
  }
  // bounding box of a stroke or text box, page-relative
  box(s) {
    if (s.tool === 'text') {
      const lines = s.text.split('\n');
      const [x, y] = s.pts[0];
      return [x, y, x + Math.max(...lines.map((l) => l.length)) * TEXT_SIZE * 0.6, y + lines.length * TEXT_SIZE * 1.25 * (this.w / this.h)];
    }
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  // the topmost stroke or text box under a point
  hit([x, y]) {
    const r = 0.012;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (s.tool === 'text') { const [x0, y0, x1, y1] = this.box(s); if (x >= x0 - r && x <= x1 + r && y >= y0 - r && y <= y1 + r) return s; }
      else if (s.pts.some(([a, b]) => Math.abs(a - x) < r && Math.abs(b - y) < r * (this.w / this.h))) return s;
    }
    return null;
  }
  setTool(tool) {
    if (tool === 'blue' || tool === 'red') this.color = tool;
    this.tool = tool;
    this.canvas.classList.toggle('active', !!tool);
    this.canvas.className = `ink${tool ? ' active t-' + (tool === 'blue' || tool === 'red' ? `pen c-${tool}` : tool) : ''}`;
    if (tool !== 'move') { this.sel = null; this.draw(); }
  }
  // the text box under a point, if any
  textAt([x, y]) {
    const fs = TEXT_SIZE * (this.w / this.h);
    return this.strokes.find((s) => s.tool === 'text' && x >= s.pts[0][0] - 0.01 && x <= s.pts[0][0] + Math.max(...s.text.split('\n').map((l) => l.length)) * TEXT_SIZE * 0.6 && y >= s.pts[0][1] - 0.01 && y <= s.pts[0][1] + fs * 1.3 * s.text.split('\n').length);
  }
  editText(at, existing) {
    const ta = document.createElement('textarea');
    ta.className = 'ink-text';
    ta.value = existing?.text || '';
    ta.style.left = at[0] * this.w + 'px';
    ta.style.top = at[1] * this.h + 'px';
    ta.style.fontSize = Math.max(10, TEXT_SIZE * this.w) + 'px';
    ta.style.color = (TOOLS[existing?.color || this.color] || TOOLS.blue).color;
    ta.rows = Math.max(1, ta.value.split('\n').length);
    ta.placeholder = 'Text';
    if (existing) { this.strokes = this.strokes.filter((s) => s !== existing); this.draw(); }
    this.wrap.append(ta);
    setTimeout(() => ta.focus());
    let finished = false;
    const done = () => {
      if (finished || !ta.isConnected) return; // Enter removes the box, which also fires blur
      finished = true;
      const text = ta.value.trim();
      ta.remove();
      if (text) this.strokes.push({ tool: 'text', pts: [at], text, color: existing?.color || this.color });
      this.draw(); this.save();
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // page keys (arrows, +/−) don't fire while typing
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); }
      if (e.key === 'Escape') { ta.value = existing?.text || ''; done(); }
    });
    ta.addEventListener('input', () => (ta.rows = Math.max(1, ta.value.split('\n').length)));
    ta.addEventListener('blur', done);
  }
  bind() {
    let cur = null;
    const pt = (e) => { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.tool) return;
      // finger draws only when no pencil has been seen (light palm rejection)
      if (e.pointerType === 'touch' && this.sawPen) return;
      if (e.pointerType === 'pen') this.sawPen = true;
      e.preventDefault();
      e.stopPropagation();
      if (this.tool === 'text') { const p = pt(e); this.editText(p, this.textAt(p)); return; }
      if (this.tool === 'move') {
        const p = pt(e), s = this.hit(p);
        this.sel = s; this.draw();
        if (s) { cur = { move: s, from: p, orig: s.pts.map((q) => q.slice()) }; this.canvas.setPointerCapture(e.pointerId); this.canvas.classList.add('dragging'); }
        return;
      }
      this.canvas.setPointerCapture(e.pointerId);
      if (this.tool === 'eraser') { cur = { erase: true }; this.erase(pt(e)); return; }
      cur = { tool: this.tool, pts: [pt(e)] };
      this.strokes.push(cur);
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.tool === 'move' && !cur) { this.canvas.classList.toggle('over', !!this.hit(pt(e))); return; }
      if (!cur) return;
      if (cur.erase) return this.erase(pt(e));
      if (cur.move) {
        const [x, y] = pt(e), dx = x - cur.from[0], dy = y - cur.from[1];
        cur.move.pts = cur.orig.map(([a, b]) => [Math.round((a + dx) * 10000) / 10000, Math.round((b + dy) * 10000) / 10000]);
        return this.draw();
      }
      cur.pts.push(pt(e).map((v) => Math.round(v * 10000) / 10000));
      this.draw();
    });
    const end = () => { if (cur) { cur = null; this.canvas.classList.remove('dragging'); this.save(); } };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }
  erase([x, y]) {
    const r = 0.015;
    const before = this.strokes.length;
    const hitText = this.textAt([x, y]);
    this.strokes = this.strokes.filter((s) => s !== hitText && (s.tool === 'text' || !s.pts.some(([a, b]) => Math.abs(a - x) < r && Math.abs(b - y) < r * (this.w / this.h))));
    if (this.strokes.length !== before) this.draw();
  }
  undo() { this.strokes.pop(); this.draw(); this.save(); }
  clear() { this.strokes = []; this.draw(); this.save(); }
  save() { store.setStrokes(this.itemId, this.page, this.strokes); }
  destroy() { this.ro.disconnect(); this.wrap.querySelectorAll('.ink-text').forEach((t) => t.blur()); this.canvas.remove(); }
}

// compact icon bar that sits in the top band: blue, red, eraser, text · undo, clear page, done
export function inkToolbar(onTool, onAction, initial = 'blue') {
  const bar = document.createElement('div');
  bar.className = 'inkbar';
  unsaved(bar); // a text box being typed is saved on blur (update.js waits while inking)
  const tool = (k, inner, title) => `<button data-tool="${k}" class="${k === initial ? 'on' : ''}" title="${title}" aria-label="${title}">${inner}</button>`;
  bar.innerHTML =
    tool('move', iconOn('pointer'), 'Move') +
    tool('blue', '<span class="swatch" style="background:#1c7ed6"></span>', 'Blue pen') +
    tool('red', '<span class="swatch" style="background:#d6336c"></span>', 'Red pen') +
    tool('eraser', iconOn('eraser'), 'Eraser') +
    tool('text', iconOn('text'), 'Text box') +
    `<span class="sep"></span>` +
    `<button data-act="undo" title="Undo" aria-label="Undo">${iconOn('undo')}</button>` +
    `<button data-act="clear" title="Clear page" aria-label="Clear page">${iconOn('clearpage')}</button>` +
    `<button data-act="done" class="done" title="Done" aria-label="Done">${iconOn('check')}</button>`;
  bar.onclick = (e) => {
    const t = e.target.closest('[data-tool]');
    if (t) { bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b === t)); onTool(t.dataset.tool); return; }
    const a = e.target.closest('[data-act]');
    if (a) onAction(a.dataset.act);
  };
  return bar;
}
