// Chord chart viewer: easiest-key default, key list with original marked, ukulele diagrams
// pinned at the top, text size, auto-scroll (used in performance mode).
import { store } from '../store.js';
import { $, esc, icon } from '../ui.js';
import { keyInfo, keyAt, STEPS, linesHtml, diagramsHtml } from '../chordchart.js';

let size = 18;
try { size = +localStorage.getItem('meowsic-chord-size') || 18; } catch {}

export function chordsBody(root, it, { perform = false } = {}) {
  root.innerHTML = `<div class="chart ${perform ? 'perform' : ''}" id="chart" style="--chart-size:${perform ? size + 6 : size}px">
      <div class="diagrams" id="diagrams" aria-label="Ukulele chords"></div>
      <div class="lyrics" id="lyrics"></div>
      <div class="chart-end">${icon('paw')}</div>
    </div>`;
  const draw = () => {
    $('#diagrams', root).innerHTML = diagramsHtml(it);
    $('#lyrics', root).innerHTML = linesHtml(it);
  };
  draw();

  let speed = 0, raf = 0, last = 0, acc = 0;
  const scroller = () => root.closest('.scroll-host') || root;
  const tick = (t) => {
    if (!speed) return;
    if (last) {
      acc += ((t - last) / 1000) * speed * 12; // px per second
      const whole = Math.floor(acc);
      if (whole) { scroller().scrollTop += whole; acc -= whole; }
    }
    last = t;
    raf = requestAnimationFrame(tick);
  };
  const off = store.on(draw);
  return {
    draw,
    setSize(px) { size = Math.max(12, Math.min(40, px)); try { localStorage.setItem('meowsic-chord-size', size); } catch {} $('#chart', root).style.setProperty('--chart-size', (perform ? size + 6 : size) + 'px'); },
    get size() { return size; },
    setSpeed(s) { speed = s; cancelAnimationFrame(raf); last = 0; if (s) raf = requestAnimationFrame(tick); },
    get speed() { return speed; },
    destroy() { off(); cancelAnimationFrame(raf); },
  };
}

export function keySelect(it) {
  const info = keyInfo(it);
  const origStep = 0;
  return `<label class="ctl">Key <select id="cv-key">${STEPS.map((n) => {
    const k = keyAt(info.base, n);
    const marks = [n === origStep ? 'original' : '', n === info.easy ? 'easiest' : ''].filter(Boolean).join(', ');
    return `<option value="${n}" ${n === info.steps ? 'selected' : ''}>${esc(k)}${marks ? ` (${marks})` : ''}</option>`;
  }).join('')}</select></label>`;
}

export function chordsToolbar(bar, it, view) {
  const drawBar = () => {
    bar.innerHTML = `${keySelect(it)}
      <div class="stepper" aria-label="Text size"><button id="cv-sm" aria-label="Smaller text">A−</button><button id="cv-lg" aria-label="Larger text">A+</button></div>`;
    $('#cv-key', bar).onchange = (e) => store.update(it.id, { transpose: +e.target.value });
    $('#cv-sm', bar).onclick = () => view.setSize(view.size - 2);
    $('#cv-lg', bar).onclick = () => view.setSize(view.size + 2);
  };
  drawBar();
  return store.on(() => { if (document.activeElement?.id !== 'cv-key') drawBar(); });
}
