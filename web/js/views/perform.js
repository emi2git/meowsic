// Performance mode: full screen, controls fade away, page turns by tap / swipe / pedal,
// chord charts auto-scroll, screen kept awake. Opened from a tag it plays everything with that tag as a set list.
import { store } from '../store.js';
import { $, esc, icon, toast } from '../ui.js';
import { go } from '../app.js';
import { sheetBody, startInk } from './sheet.js';
import { chordsBody } from './chordsview.js';
import { scoreBody } from './score.js';

export function performView(main, { parts, q }) {
  const tag = q.get('tag');
  const set = tag ? { name: tag } : null;
  const ids = tag ? store.tagItems(tag).map((x) => x.id) : [parts[1]];
  let idx = Math.max(0, ids.indexOf(parts[1]));
  const it = store.get(ids[idx]);
  if (!it) { go('#/library'); return; }

  main.innerHTML = `
    <div class="perform-wrap k-${it.kind}" id="pf">
      <div class="pf-bar" id="pf-bar">
        <button class="icon-btn" id="pf-exit" aria-label="Exit performance mode">${icon('close')}<span>Exit</span></button>
        <div class="pf-title"><b>${esc(it.title)}</b>${set ? `<small>${esc(set.name)} · ${idx + 1} of ${ids.length}</small>` : ''}<small id="pf-page"></small></div>
        <div class="pf-ctl" id="pf-ctl"></div>
        ${set ? `<button class="icon-btn" id="pf-prev" ${idx ? '' : 'disabled'} aria-label="Previous song">‹ Previous</button><button class="icon-btn" id="pf-next" ${idx < ids.length - 1 ? '' : 'disabled'} aria-label="Next song">Next ›</button>` : ''}
      </div>
      <button class="pf-handle" id="pf-handle" aria-label="Show controls">Controls</button>
      <div class="scroll-host pf-body" id="pf-body"></div>
    </div>`;

  const body = $('#pf-body', main), ctl = $('#pf-ctl', main), bar = $('#pf-bar', main);
  const nextItem = () => { if (set && idx < ids.length - 1) go(`#/perform/${ids[idx + 1]}?tag=${encodeURIComponent(tag)}`); else if (set) toast('End of the set list'); };
  const prevItem = () => { if (set && idx > 0) go(`#/perform/${ids[idx - 1]}?tag=${encodeURIComponent(tag)}`); };
  let view;
  if (it.kind === 'sheet') {
    view = sheetBody(body, it, { perform: true, onEnd: nextItem });
    $('#pf', main).addEventListener('pagechange', (e) => ($('#pf-page', main).textContent = `Page ${e.detail.show.join('–')} of ${e.detail.pages}`));
    ctl.innerHTML = `<button class="icon-btn" id="pf-spread">${icon('library')}<span>${view.spread ? '2 pages' : '1 page'}</span></button><button class="icon-btn" id="pf-ink">Annotate</button>`;
    $('#pf-spread', ctl).onclick = (e) => { view.setSpread(!view.spread); e.currentTarget.querySelector('span').textContent = view.spread ? '2 pages' : '1 page'; };
    $('#pf-ink', ctl).onclick = () => startInk(view, $('#pf', main));
    view.goTo(1);
  } else if (it.kind === 'chords') {
    view = chordsBody(body, it, { perform: true });
    const speeds = [0, 1, 1.5, 2, 3, 4, 6];
    let si = 0;
    ctl.innerHTML = `<button class="icon-btn" id="pf-scroll">${icon('play')}<span>Auto-scroll</span></button>
      <div class="stepper"><button id="pf-slow" aria-label="Slower">−</button><span id="pf-speed">off</span><button id="pf-fast" aria-label="Faster">+</button></div>
      <div class="stepper"><button id="pf-sm">A−</button><button id="pf-lg">A+</button></div>`;
    const setS = (i) => { si = Math.max(0, Math.min(speeds.length - 1, i)); view.setSpeed(speeds[si]); $('#pf-speed', ctl).textContent = si ? `${speeds[si]}×` : 'off'; $('#pf-scroll', ctl).innerHTML = `<span>${si ? 'Stop scrolling' : 'Auto-scroll'}</span>`; };
    $('#pf-scroll', ctl).onclick = () => setS(si ? 0 : 2);
    $('#pf-slow', ctl).onclick = () => setS(si - 1);
    $('#pf-fast', ctl).onclick = () => setS(si + 1);
    $('#pf-sm', ctl).onclick = () => view.setSize(view.size - 2);
    $('#pf-lg', ctl).onclick = () => view.setSize(view.size + 2);
    // pedal: page down scrolls one screen
    var onKey = (e) => {
      if (['PageDown', 'ArrowDown', ' ', 'ArrowRight'].includes(e.key)) { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.85, behavior: 'smooth' }); }
      if (['PageUp', 'ArrowUp', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.85, behavior: 'smooth' }); }
    };
    document.addEventListener('keydown', onKey);
  } else {
    view = scoreBody(body, it, { perform: true });
    ctl.innerHTML = `<button class="icon-btn" id="pf-play">${icon('play')}<span>Play</span></button>`;
    const pb = $('#pf-play', ctl);
    const setP = () => (pb.innerHTML = `<span>${view.player.playing ? 'Pause' : 'Play'}</span>`);
    pb.onclick = async () => { view.player.playing ? view.player.pause() : await view.player.play(); setP(); };
    $('#pf', main).addEventListener('ended', setP);
  }

  $('#pf-exit', main).onclick = () => go(`#/item/${it.id}`);
  $('#pf-prev', main)?.addEventListener('click', prevItem);
  $('#pf-next', main)?.addEventListener('click', nextItem);
  const onEsc = (e) => { if (e.key === 'Escape') go(`#/item/${it.id}`); };
  document.addEventListener('keydown', onEsc);

  // controls fade after 3 s without movement
  let hideT;
  const show = () => { bar.classList.remove('gone'); clearTimeout(hideT); hideT = setTimeout(() => { if (!bar.matches(':hover') && !main.querySelector('.inkbar')) bar.classList.add('gone'); }, 3000); };
  $('#pf-handle', main).onclick = show;
  bar.addEventListener('pointermove', show);
  main.addEventListener('mousemove', show);
  show();

  // full screen + keep the screen awake (where the browser allows it)
  document.documentElement.requestFullscreen?.().catch(() => {});
  let lock = null;
  const wake = () => navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
  wake();
  const onVis = () => { if (document.visibilityState === 'visible') wake(); };
  document.addEventListener('visibilitychange', onVis);

  const opened = Date.now();
  return () => {
    view.destroy();
    clearTimeout(hideT);
    document.removeEventListener('keydown', onEsc);
    if (typeof onKey === 'function') document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    main.removeEventListener('mousemove', show);
    lock?.release().catch(() => {});
    if (document.fullscreenElement && !location.hash.startsWith('#/perform')) document.exitFullscreen().catch(() => {});
    store.logPlay(it.id, opened, Date.now());
  };
}
