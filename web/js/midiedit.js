// Edit notes + a USB MIDI keyboard (Mac Chrome; iPad / iPhone Safari have no Web MIDI: nothing shows there).
// When Edit notes opens it connects by itself; a "🎹 <keyboard>" chip in the edit bar opens the options,
// remembered per keyboard (localStorage meowsic-midiedit): next note after each key, low length keys (from C2 / C3 /
// C4), hold to set length (the Keyboard beta's calibration), the app sound.
//   a key     the picked note (or rest) takes that pitch, exactly (spelled for the key: the Mac's op 'set');
//             keys pressed together (within 60 ms) = a chord: the picked note / chord becomes that chord
//   next      with "Next note" on, the next note / rest of the same staff and voice is picked after it (across
//             bars and pages: the page turns); a whole chord picked → the next whole chord, one note of a chord
//             → the note at the same place from the top of the next one
//   length    the low length keys (C D E F G B = whole … 32nd, A = rest, C# = dot, D# = tie) set the picked note's
//             length — pick the length first, then play the note; "Hold to set length": how long the key is
//             held (at the hold tempo, with the calibration) sets it before moving on
// Every change is one of the editor's own edits (undo / redo, the play cue, bars kept full, ties, slurs, lyrics).
// attachMidi(ed) → { paint(slot), destroy() } | null. ed (from editnotes.js): notes, sel (picked notes), busy, step,
// select(refs), setPitch(refs, midis), setLength(q), dot(), tie(), rest(), toast(msg).
import { hasMidi, midi, askMidi, inputsOf, listenMidi, fnKeys, fnLabel, FN_BASES, noteName, pickLen, holdBeats, loadCal, TPQ } from './midi.js';
import { pianoKey, audioCtx, loadPiano } from './audio.js';
import { esc, sheet } from './ui.js';

const LS = 'meowsic-midiedit';
const DEF = { auto: true, fnOn: true, fnBase: 48, hold: false, holdTempo: 60, holdDot: false, sound: true };
const CHORD_MS = 60; // keys pressed this close together are one chord
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (n) => n.bar * 1e4 + n.on;

const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
const saveAll = (a) => { try { localStorage.setItem(LS, JSON.stringify(a)); } catch {} };

function ensureCss() {
  if (document.querySelector('link[data-midiedit-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = new URL('../css/midiedit.css', import.meta.url).href; l.dataset.midieditCss = '';
  document.head.append(l);
}

export function attachMidi(ed) {
  if (!hasMidi()) return null;
  ensureCss();
  let dead = false, slot = null, opts = { ...DEF }, device = '', optSheet = null, chain = Promise.resolve();
  let gather = null; // keys being gathered into one press (a chord)
  const waiting = []; // presses played in, waiting for their key to come up (hold to set length)
  const sounding = new Map(); // midi → release()
  const cal = loadCal();

  const pickDevice = () => {
    const name = inputsOf()[0]?.name || '';
    if (name === device) return;
    device = name;
    opts = { ...DEF, ...(loadAll()[device] || {}) };
  };
  const persist = () => { const a = loadAll(); a[device] = opts; saveAll(a); };
  const fns = () => (opts.fnOn ? fnKeys(opts.fnBase) : new Map());

  // ---- the chip in the edit bar (drawn again with the panel) ----
  const paint = (el) => {
    if (el) slot = el;
    if (!slot || dead) return;
    pickDevice();
    slot.innerHTML = device ? `<button type="button" class="np-midi" title="Keyboard: ${esc(device)} — options" aria-label="Keyboard ${esc(device)}, options">🎹 <span>${esc(device)}</span></button>` : '';
    slot.querySelector('.np-midi')?.addEventListener('click', (e) => { e.stopPropagation(); openOptions(); });
  };
  const openOptions = () => {
    if (optSheet) return;
    const s = sheet(`<h2>🎹 ${esc(device)}</h2>
      <div class="me-opts">
        <label class="me-tg"><input type="checkbox" data-o="auto"${opts.auto ? ' checked' : ''}><span>Next note after each key</span></label>
        <label class="me-tg"><input type="checkbox" data-o="fnOn"${opts.fnOn ? ' checked' : ''}><span>Low keys set the length, from</span>
          <select data-o="fnBase">${FN_BASES.map((m) => `<option value="${m}"${m === opts.fnBase ? ' selected' : ''}>${noteName(m)}</option>`).join('')}</select></label>
        <p class="muted small me-legend">${[...fnKeys(opts.fnBase)].sort((a, b) => a[0] - b[0]).map(([m, f]) => `<b>${noteName(m)}</b> ${fnLabel(f)}`).join(' · ')}. Pick the length first, then play the note.</p>
        <label class="me-tg"><input type="checkbox" data-o="hold"${opts.hold ? ' checked' : ''}><span>Hold to set length, at</span>
          <select data-o="holdTempo">${[40, 50, 60, 72, 80, 100, 120].map((b) => `<option value="${b}"${b === opts.holdTempo ? ' selected' : ''}>${b} BPM</option>`).join('')}</select></label>
        <label class="me-tg me-sub"><input type="checkbox" data-o="holdDot"${opts.holdDot ? ' checked' : ''}><span>Dotted lengths too</span></label>
        <p class="muted small">Hold timing uses the calibration from Keyboard (beta)${cal.at ? '' : ' (not calibrated yet: the default)'}.</p>
        <label class="me-tg"><input type="checkbox" data-o="sound"${opts.sound ? ' checked' : ''}><span>Play the keys softly (app sound)</span></label>
      </div>
      <div class="modal-actions"><button class="primary" data-close>Done</button></div>`, { onClose: () => { optSheet = null; } });
    s.el.classList.add('me-sheet');
    s.el.addEventListener('change', (e) => {
      const o = e.target.dataset.o;
      if (!o) return;
      opts[o] = e.target.type === 'checkbox' ? e.target.checked : +e.target.value;
      persist();
      if (o === 'fnBase') s.el.querySelector('.me-legend').innerHTML = `${[...fnKeys(opts.fnBase)].sort((a, b) => a[0] - b[0]).map(([m, f]) => `<b>${noteName(m)}</b> ${fnLabel(f)}`).join(' · ')}. Pick the length first, then play the note.`;
      if (o === 'sound' && opts.sound) { try { audioCtx(); loadPiano(); } catch {} }
    });
    optSheet = s;
  };

  // ---- the edits, one after another (each waits for the one before) ----
  const idle = async () => { for (let i = 0; i < 400 && ed.busy; i++) await sleep(25); };
  const enqueue = (f) => (chain = chain.then(() => (dead ? null : f())).catch((e) => console.warn('midiedit', e)));
  // the picked notes, narrowed to one onset of one voice (the first one on the score)
  const target = () => {
    const p = ed.sel;
    if (!p.length) return null;
    const a = [...p].sort((x, y) => key(x) - key(y) || x.staff - y.staff)[0];
    const refs = p.filter((n) => n.bar === a.bar && Math.abs(n.on - a.on) < 1e-6 && n.staff === a.staff && n.voice === a.voice);
    const group = ed.notes.filter((n) => n.bar === a.bar && Math.abs(n.on - a.on) < 1e-6 && n.staff === a.staff && n.voice === a.voice);
    const top = [...group].sort((x, y) => (y.midi ?? 0) - (x.midi ?? 0));
    return { a, refs: refs.map((n) => n.ref), whole: refs.length === group.length, rank: Math.max(0, top.findIndex((n) => refs.some((r) => r.ref === n.ref))) };
  };
  // the next onset of the same staff and voice (another voice of the staff when that voice ends)
  const advance = (shape) => {
    const p = ed.sel;
    if (!p.length) return;
    const a = [...p].sort((x, y) => key(x) - key(y))[0];
    const later = (same) => ed.notes.filter((n) => n.staff === a.staff && (!same || n.voice === a.voice) && key(n) > key(a) + 1e-6);
    let row = later(true);
    if (!row.length) row = later(false);
    if (!row.length) { ed.toast('That was the last note on this staff'); return; }
    const k = Math.min(...row.map(key));
    const at = row.filter((n) => Math.abs(key(n) - k) < 1e-6);
    const v = at.find((n) => n.voice === a.voice)?.voice ?? at[0].voice;
    const g = at.filter((n) => n.voice === v).sort((x, y) => (y.midi ?? 0) - (x.midi ?? 0));
    const pick = shape?.whole || g.some((n) => n.rest) ? g : [g[Math.min(shape?.rank || 0, g.length - 1)]];
    ed.select(pick.map((n) => n.ref));
  };
  const playInto = async (press) => {
    await idle();
    const t = target();
    if (!t) { ed.toast('Pick a note or rest first, then play'); press.done?.(); return; }
    const midis = [...new Set(press.keys)].sort((x, y) => x - y);
    const was = ed.step;
    await ed.setPitch(t.refs, midis);
    await idle();
    if (ed.step === was) return; // refused (the editor said why)
    if (opts.hold) {
      if (press.off == null) await new Promise((r) => { press.up = r; setTimeout(r, 8000); });
      const ms = (press.off ?? performance.now()) - press.t;
      const q = pickLen(holdBeats(ms, opts.holdTempo, cal), opts.holdDot) / TPQ;
      const ns = ed.sel.filter((n) => !n.rest);
      if (ns.length && ns.some((n) => Math.abs(n.dur - q) > 1e-6)) { await ed.setLength(q); await idle(); }
    }
    if (opts.auto) advance(t);
  };
  const fnKey = async (f) => {
    await idle();
    if (!ed.sel.length) { ed.toast('Pick a note or rest first'); return; }
    if (f.kind === 'len') await ed.setLength(f.t / TPQ);
    else if (f.kind === 'dot') await ed.dot();
    else if (f.kind === 'tie') await ed.tie();
    else await ed.rest();
    await idle();
  };

  // ---- the keyboard ----
  const flush = () => {
    const press = gather;
    gather = null;
    if (!press) return;
    if (opts.hold) waiting.push(press);
    enqueue(() => playInto(press).finally(() => { const i = waiting.indexOf(press); if (i >= 0) waiting.splice(i, 1); }));
  };
  const onEvent = (e) => {
    if (dead) return;
    const other = [...document.querySelectorAll('.modal-wrap')].some((w) => w !== optSheet?.el.parentElement);
    const f = fns().get(e.midi);
    if (e.type === 'on') {
      if (other) return; // Save… / Close? asked: the keys wait
      sounding.get(e.midi)?.();
      sounding.delete(e.midi);
      if (opts.sound && !f) { try { sounding.set(e.midi, pianoKey(e.midi, Math.max(20, Math.round(e.vel * 0.45)))); } catch {} }
      if (f) { enqueue(() => fnKey(f)); return; }
      if (!gather) gather = { keys: [], t: e.t, first: e.midi, off: null, timer: setTimeout(flush, CHORD_MS) };
      gather.keys.push(e.midi);
    } else {
      sounding.get(e.midi)?.();
      sounding.delete(e.midi);
      for (const p of [gather, ...waiting]) if (p && p.first === e.midi && p.off == null) { p.off = e.t; p.up?.(); }
    }
  };

  let stop = () => {};
  (async () => {
    await askMidi();
    if (dead || midi.status !== 'ok') return;
    stop = listenMidi(onEvent, () => paint());
  })();

  const api = {
    paint,
    get device() { return device; }, get opts() { return { ...opts }; },
    setOpts(o) { Object.assign(opts, o); persist(); }, // tests
    get idle() { return chain.then(() => idle()); },
    destroy() {
      dead = true;
      stop();
      clearTimeout(gather?.timer); gather = null;
      for (const p of waiting) p.up?.();
      for (const r of sounding.values()) { try { r(); } catch {} }
      sounding.clear();
      optSheet?.close();
      if (window.__midiEdit === api) delete window.__midiEdit;
    },
  };
  window.__midiEdit = api; // for automated tests
  return api;
}
