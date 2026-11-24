// Web MIDI for Meowsic: a USB keyboard plugged into the Mac (Chrome). Shared by Keyboard (beta)
// (views/beta-keyboard.js) and Edit notes (midiedit.js). iPad / iPhone Safari has no Web MIDI: hasMidi() is false.
//   askMidi() / midi.status / inputsOf()   ask Chrome for MIDI access once (kept for the page's life)
//   readMidi(e)                            a midimessage → { type: 'on' | 'off', midi, vel, t } (or null)
//   listenMidi(fn)                         every connected input → fn(event); plugged in later too; → stop()
//   FN_KEYS / FN_BASES                     the low "length keys": C D E F G = 1 … 1/16, A = rest, C# = dot, D# = tie
//   holdBeats / pickLen / calibrate        "hold to set length", with the calibration in localStorage
// Timing: every press / release time is the event's own timeStamp (performance.now() clock).
export const PC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const pcName = (m) => PC[((m % 12) + 12) % 12];
export const noteName = (m) => pcName(m) + (Math.floor(m / 12) - 1);
export const now = () => performance.now();
export const evT = (e) => (Number.isFinite(e?.timeStamp) && e.timeStamp > 0 ? e.timeStamp : now());
export const hasMidi = () => typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;

// ---------- access (once per page) ----------
export const midi = { access: null, status: hasMidi() ? 'idle' : 'unsupported', error: '' };
let asking = null;
export async function askMidi() {
  if (!hasMidi()) { midi.status = 'unsupported'; return; }
  if (midi.access) { midi.status = 'ok'; return; }
  if (asking) return asking;
  midi.status = 'asking';
  asking = (async () => {
    try { midi.access = await navigator.requestMIDIAccess({ sysex: false }); midi.status = 'ok'; }
    catch (e) { midi.status = e && (e.name === 'SecurityError' || e.name === 'NotAllowedError') ? 'denied' : 'error'; midi.error = e?.message || String(e); }
    finally { asking = null; }
  })();
  return asking;
}
export const inputsOf = () => (midi.access ? [...midi.access.inputs.values()].filter((i) => !i.state || i.state === 'connected') : []);

export function readMidi(e) {
  const d = e?.data; if (!d || d.length < 2) return null;
  const cmd = d[0] & 0xf0, t = evT(e);
  if (cmd === 0x90 && d[2] > 0) return { type: 'on', midi: d[1], vel: d[2], t, src: 'midi' };
  if (cmd === 0x80 || cmd === 0x90) return { type: 'off', midi: d[1], vel: 0, t, src: 'midi' };
  return null;
}

// every input (and ones plugged in later) → fn(event); onChange() after inputs come or go. → stop()
export function listenMidi(fn, onChange = () => {}) {
  const attached = new Set();
  const onMsg = (e) => { const x = readMidi(e); if (x) fn(x); };
  const attach = () => {
    for (const inp of inputsOf()) if (!attached.has(inp)) {
      inp.addEventListener('midimessage', onMsg);
      try { inp.open?.()?.catch?.(() => {}); } catch {}
      attached.add(inp);
    }
    onChange();
  };
  midi.access?.addEventListener?.('statechange', attach);
  attach();
  return () => {
    for (const inp of attached) inp.removeEventListener('midimessage', onMsg);
    attached.clear();
    midi.access?.removeEventListener?.('statechange', attach);
  };
}

// ---------- the low length keys ----------
// offsets from a C: [offset, kind, ticks, label] (ticks: TPQ per quarter, 96 = whole)
export const TPQ = 24;
export const FN_KEYS = [[0, 'len', 96, '1'], [2, 'len', 48, '1/2'], [4, 'len', 24, '1/4'], [5, 'len', 12, '1/8'], [7, 'len', 6, '1/16'], [9, 'rest', 0, 'Rest'], [1, 'dot', 0, 'Dot'], [3, 'tie', 0, 'Tie']];
export const FN_BASES = [36, 48, 60];
export const fnKeys = (base) => new Map(FN_KEYS.map(([off, kind, t, label]) => [base + off, { kind, t, label }]));

// ---------- hold to set length ----------
// Lengths (ticks) a hold can pick, short → long; dotted ones only with "Dotted" on.
export const HOLD_PLAIN = [6, 12, 24, 48, 96], HOLD_DOTS = [6, 9, 12, 18, 24, 36, 48, 72, 96];
// the switch points (in beats) between neighbours: the geometric midpoint √(a·b), so a hold is judged by ratio
// (0.36 beat is nearer 1/16 than 1/8), never by the arithmetic middle (which would round short holds up)
export const holdThresholds = (dots = false) => { const L = dots ? HOLD_DOTS : HOLD_PLAIN; return L.slice(1).map((t, i) => Math.sqrt((L[i] / TPQ) * (t / TPQ))); };
export function pickLen(beats, dots = false) {
  const L = dots ? HOLD_DOTS : HOLD_PLAIN, th = holdThresholds(dots);
  const k = th.findIndex((x) => beats < x);
  return L[k < 0 ? L.length - 1 : k];
}
// the player's own timing, measured by Calibrate (Keyboard beta): ms subtracted from every hold and a stretch
export const CAL_DEFAULT = { latency: 25, stretch: 1 };
export const LS_CAL = 'meowsic-beta-keyboard-cal';
export function loadCal() { try { const c = JSON.parse(localStorage.getItem(LS_CAL)); if (c && Number.isFinite(c.latency) && Number.isFinite(c.stretch) && c.stretch > 0) return { latency: c.latency, stretch: c.stretch, at: c.at }; } catch {} return { ...CAL_DEFAULT }; }
export function saveCal(c) { try { if (c) localStorage.setItem(LS_CAL, JSON.stringify(c)); else localStorage.removeItem(LS_CAL); } catch {} }
// held ms → beats at the tempo, with the calibration applied
export const holdBeats = (ms, bpm, cal = CAL_DEFAULT) => Math.max(0, (ms - cal.latency) * cal.stretch) / 1000 * (bpm / 60);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y), h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// 4 quarter notes held with the clicks (press on a click, let go on the next): holds = [{ on, off }] in ms.
// The player's beat = the median time between presses; stretch maps it onto the tempo's beat, and latency is how
// much longer (or, released early, shorter) each hold is than that beat. After it, these holds read as exactly 1/4.
export function calibrate(holds, beatMs) {
  const d = median(holds.map((h) => h.off - h.on));
  const gaps = holds.slice(1).map((h, i) => h.on - holds[i].on);
  let ioi = gaps.length ? median(gaps) : beatMs;
  if (!(ioi > beatMs * 0.6 && ioi < beatMs * 1.6)) ioi = beatMs;
  return { latency: Math.round(clamp(d - ioi, -300, 300)), stretch: +clamp(beatMs / ioi, 0.7, 1.4).toFixed(3) };
}
