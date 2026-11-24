// Web Audio: sampled piano playback (from Meowsic 1's score reader).
// iPad / iPhone: call audioCtx() straight from the tap, before any await.
// - audioSession 'playback' (Safari 16.4+): Web Audio is heard with the Silent switch on (the default
//   'ambient' session mutes it, while <audio> elements still play). Set once, before the first context:
//   changing it while a context exists can interrupt that context on iOS. If a context still will not run
//   under it, the next Play goes back to the default session.
// - a 1-sample silent buffer on each new context unlocks output on older iOS
// - Play never trusts a context that is not running: an 'interrupted' or 'suspended' one (iOS: a call, Siri,
//   another app, the Home Screen app sent to the background) often never wakes, so Play makes a fresh one,
//   inside the tap. A Play that still gets no running audio says so (the button goes back to Play).
// - a context that has been in the background is never trusted either, even when it says 'running': on iOS 26 the
//   Home Screen app's context comes back 'running' but silent, with a clock that may not move (WebKit 291892 /
//   283419). The first Play after the app was hidden makes a fresh one inside the tap, and a Play whose clock does
//   not move is treated as no audio (the next tap makes a fresh one).
// - each Play also starts a silent <audio> element inside the tap (fresh src each time, WebKit 295518): iOS then
//   gives the page a media playback session, so the Web Audio piano is heard (Silent switch too)
let ctx, unlocked = false, session = 'playback', stale = false;
const markStale = () => { if (ctx) stale = true; };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') markStale(); });
addEventListener('pagehide', markStale);
document.addEventListener('freeze', markStale);
// 0.05 s of silence (8 kHz mono WAV)
const SILENT = (() => { const n = 400, b = new Uint8Array(44 + n), v = new DataView(b.buffer), w = (o, t) => [...t].forEach((ch, i) => (b[o + i] = ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
  let s = ''; b.forEach((x) => (s += String.fromCharCode(x))); return 'data:audio/wav;base64,' + btoa(s); })();
let silentEl = null;
export function mediaUnlock() { // synchronous, inside the tap
  try {
    if (!silentEl) { silentEl = new Audio(); silentEl.setAttribute('playsinline', ''); silentEl.preload = 'auto'; silentEl.volume = 0; }
    silentEl.src = SILENT; silentEl.play()?.catch?.(() => {});
  } catch {}
}
const setSession = () => { try { if (navigator.audioSession && navigator.audioSession.type !== session) navigator.audioSession.type = session; } catch {} };
export function audioCtx({ fresh = false } = {}) {
  if (ctx && (ctx.state === 'closed' || (fresh && (stale || ctx.state !== 'running')))) { const old = ctx; ctx = null; try { old.onstatechange = null; old.close()?.catch?.(() => {}); } catch {} }
  if (!ctx) {
    setSession();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    unlocked = false; stale = false;
    const c = ctx;
    c.onstatechange = () => { if (c === ctx && c.state === 'interrupted') unlocked = false; };
  }
  if (ctx.state !== 'running') { try { const p = ctx.resume(); p?.catch?.(() => {}); } catch {} }
  if (!unlocked) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination); src.start(0);
      unlocked = true;
    } catch {}
  }
  return ctx;
}
// a context that would not run: the next one starts under the default audio session (still heard, Silent off)
const gaveUp = () => { session = 'auto'; stale = true; };
// the context's clock really moves (a 'running' context on iOS can be frozen)
const clockMoves = (c) => new Promise((ok) => { const t0 = c.currentTime, s = performance.now();
  const look = () => (c.currentTime > t0 ? ok(true) : performance.now() - s > 700 ? ok(false) : setTimeout(look, 40)); look(); });
export const audioState = () => (ctx ? ctx.state : 'none'); // for tests
// the next tap anywhere wakes a suspended context (iOS), so the orange line and sound carry on
for (const ev of ['touchend', 'pointerup', 'keydown']) {
  addEventListener(ev, () => { if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') audioCtx(); }, { capture: true, passive: true });
}

// ---------- piano samples (one every three semitones, nearest one pitch-shifted) ----------
let piano = [], pianoLoading = null;
export function loadPiano() {
  if (piano.length || pianoLoading) return pianoLoading;
  const c = audioCtx();
  const notes = [];
  for (let n = 21; n <= 108; n += 3) notes.push(n);
  pianoLoading = Promise.all(notes.map((n) =>
    fetch(`vendor/piano/piano-${String(n).padStart(3, '0')}.mp3`).then((r) => r.arrayBuffer())
      .then((b) => new Promise((ok) => c.decodeAudioData(b, (buf) => ok({ note: n, buf }), () => ok(null)))).catch(() => null)
  )).then((list) => { piano = list.filter(Boolean); pianoLoading = null; return piano.length; });
  return pianoLoading;
}

function pianoVoice(out, pitch, vel, when, held) {
  const c = out.context, env = c.createGain();
  let src, tail;
  if (piano.length) {
    const s = piano.reduce((b, x) => (Math.abs(x.note - pitch) < Math.abs(b.note - pitch) ? x : b));
    src = c.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = Math.pow(2, (pitch - s.note) / 12);
    env.gain.setValueAtTime(Math.pow(vel / 127, 1.2), when);
    env.gain.setTargetAtTime(0, when + held, 0.12);
    tail = 0.8;
  } else {
    src = c.createOscillator();
    src.type = 'triangle';
    src.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime((vel / 127) * 0.25, when + 0.006);
    env.gain.setTargetAtTime(0, when + 0.01, 0.6);
    env.gain.setTargetAtTime(0, when + held, 0.07);
    tail = 0.5;
  }
  src.connect(env); env.connect(out);
  src.start(when); src.stop(when + held + tail);
  return { src, env, end: when + held + tail };
}

// ---------- score player: notes in quarter-note time; tempo, loop, transpose ----------
// segments: [[fromQ, toQ], …] in the order they are played (repeats and endings, musicxml.js playOrder), or null:
// at the end of each the clock jumps to the next (the playhead with it); A–B loop mode ignores them.
// chords: the chord symbols as piano chords ([{q, d, n, v}], chordplay.js chordEvents), heard while chordsOn; a chord
// already sounding where Play starts (or a loop jumps back to) is struck there for the rest of its length.
export class ScorePlayer {
  constructor({ notes, bpm, beats, onTick, onEnd, segments = null, chords = [] }) {
    Object.assign(this, { notes, bpm, beats, onTick, onEnd, segments, chords });
    this.chordsOn = false; this.chordVoices = []; this.heardChords = []; // heardChords: [q, midi] as scheduled (for tests)
    this.seg = 0; this.played = []; this.heard = []; // played: [segment index, …] as they start (for tests)
    this.rate = 1; this.shift = 0;
    this.loop = null; // [startQ, endQ]
    this.posQ = 0; this.playing = false;
    this.endQ = notes.reduce((m, n) => Math.max(m, n.q + n.d), 0);
    this.endQ = Math.ceil(this.endQ / beats) * beats;
  }
  get qps() { return (this.bpm * this.rate) / 60; } // quarters per second
  now() {
    if (!this.playing) return this.posQ;
    const t = this.ctx.currentTime;
    const a = this.anchors.filter((x) => x.t0 <= t).pop() || this.anchors[0];
    return a.q0 + Math.max(0, t - a.t0) * this.qps; // not before the start while the first notes are on their way
  }
  async play() {
    if (this.playing || this.starting) return;
    this.starting = true;
    try { await this.start(); } finally { this.starting = false; }
  }
  async start() {
    mediaUnlock();
    const c = audioCtx({ fresh: true }); // synchronous, inside the tap; a stuck or backgrounded context is replaced
    await loadPiano();
    if (c.state !== 'running') { try { await Promise.race([c.resume(), new Promise((ok) => setTimeout(ok, 2000))]); } catch {} }
    if (c.state !== 'running' || c !== ctx || !(await clockMoves(c)) || c !== ctx) { gaveUp(); throw new Error('audio did not start'); }
    this.ctx = c;
    if (this.posQ >= (this.loop ? this.loop[1] : this.endQ)) this.posQ = this.loop ? this.loop[0] : 0;
    // from the very start: no waiting through rests before the first note (a score read from a sheet can open with them)
    const first = this.notes.reduce((m, n) => Math.min(m, n.q), Infinity);
    if (this.posQ <= 1e-3 && !this.loop && first > 0.01 && first < Infinity) this.posQ = first;
    this.out = c.createGain(); this.out.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    this.out.connect(comp); comp.connect(c.destination);
    if (this.segments) { // the first time through the bar where it starts
      const k = this.segments.findIndex(([a, z]) => this.posQ >= a - 1e-6 && this.posQ < z - 1e-6);
      this.seg = k < 0 ? this.segments.length - 1 : k;
      this.played = [this.seg];
    }
    this.heard = []; this.heardChords = []; this.chordVoices = [];
    this.q0 = this.posQ; this.t0 = c.currentTime + 0.12;
    this.anchors = [{ q0: this.q0, t0: this.t0 }];
    this.scheduledTo = this.posQ;
    this.carryChords(this.posQ);
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 50);
    this.pump();
    const tick = () => { if (!this.playing) return; this.onTick?.(this.now()); this.raf = requestAnimationFrame(tick); };
    tick();
  }
  pump() {
    // up to 0.4 s ahead, in the clock of the latest jump (a loop / a repeat moves it)
    const horizonT = this.ctx.currentTime + 0.4;
    const segs = !this.loop && this.segments;
    for (let guard = 0; guard < 1000; guard++) {
      const horizonQ = this.q0 + (horizonT - this.t0) * this.qps;
      if (this.scheduledTo >= horizonQ) break;
      const stopQ = this.loop ? this.loop[1] : segs ? segs[this.seg][1] : this.endQ;
      const a = this.scheduledTo, b = Math.min(horizonQ, stopQ);
      for (const n of this.notes) if (n.q >= a && n.q < b) {
        const when = this.t0 + (n.q - this.q0) / this.qps;
        pianoVoice(this.out, n.n + this.shift, n.v, Math.max(this.ctx.currentTime, when), Math.max(0.08, n.d / this.qps));
        if (this.heard.length < 4000) this.heard.push([n.q, n.n]); // what was played, in order (for tests)
      }
      if (this.chordsOn) for (const n of this.chords) if (n.q >= a && n.q < b) this.chordVoice(n, n.q, n.d);
      this.scheduledTo = b;
      if (b < stopQ) break;
      const tEnd = this.t0 + (stopQ - this.q0) / this.qps;
      if (this.loop) this.q0 = this.loop[0]; // jump back: re-anchor the clock at the loop start
      else if (segs && this.seg + 1 < segs.length) { this.seg++; this.played.push(this.seg); this.q0 = segs[this.seg][0]; } // a repeat / an ending
      else break;
      this.t0 = tEnd; this.scheduledTo = this.q0;
      this.anchors = [...this.anchors.slice(-1), { q0: this.q0, t0: this.t0 }];
      this.carryChords(this.q0);
    }
    const last = !segs || this.seg === segs.length - 1;
    if (!this.loop && last && this.now() >= (segs ? segs.at(-1)[1] : this.endQ) + 0.5) { this.pause(); this.posQ = 0; this.onEnd?.(); }
  }
  chordVoice(n, q, d) {
    const when = this.t0 + (q - this.q0) / this.qps;
    const v = pianoVoice(this.out, n.n + this.shift, n.v, Math.max(this.ctx.currentTime, when), Math.max(0.08, d / this.qps - 0.02));
    const t = this.ctx.currentTime;
    this.chordVoices = this.chordVoices.filter((x) => x.end > t); this.chordVoices.push(v);
    if (this.heardChords.length < 4000) this.heardChords.push([q, n.n]);
  }
  // a chord that started before q and still sounds there (Play from the middle of it, a jump back): struck at q
  carryChords(q) {
    if (!this.chordsOn) return;
    for (const n of this.chords) if (n.q < q - 1e-6 && n.q + n.d > q + 1e-3) this.chordVoice(n, q, n.q + n.d - q);
  }
  // the Chords toggle while playing: on = from the chord sounding now; off = the chords already on their way fade out
  setChords(on) {
    on = !!on;
    if (on === this.chordsOn) return;
    this.chordsOn = on;
    if (!this.playing) return;
    if (on) { const q = this.now(); for (const n of this.chords) if (n.q < q && n.q + n.d > q + 0.05) this.chordVoice(n, q, n.q + n.d - q); for (const n of this.chords) if (n.q >= q && n.q < this.scheduledTo) this.chordVoice(n, n.q, n.d); }
    else { const t = this.ctx.currentTime; for (const v of this.chordVoices) { try { v.env.gain.cancelScheduledValues(t); v.env.gain.setTargetAtTime(0, t, 0.05); v.src.stop(t + 0.4); } catch {} } this.chordVoices = []; }
  }
  pause() {
    if (!this.playing) return;
    this.posQ = this.now();
    this.playing = false;
    clearInterval(this.timer); cancelAnimationFrame(this.raf);
    const o = this.out; o.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03); setTimeout(() => o.disconnect(), 300);
  }
  seek(q) { const was = this.playing; if (was) this.pause(); this.posQ = Math.max(0, Math.min(q, this.endQ)); this.onTick?.(this.posQ); if (was) this.play().catch(() => {}); }
  setRate(r) { const was = this.playing; if (was) this.pause(); this.rate = r; if (was) this.play().catch(() => {}); }
  stop() { this.pause(); this.posQ = 0; }
}

// ---------- voice player: a rendered (sung) audio file in place of the piano, same interface as ScorePlayer ----------
// The audio was rendered at `bpm` from beat 0, so the playhead is currentTime × bpm / 60. It has its own tempo:
// rate stays 1 (the toolbar switches back to the piano for tempo / transpose changes).
// iPad / iPhone: el.play() runs straight from the Play tap (nothing awaited before it), which Safari needs.
export class VoicePlayer {
  // segments (repeats, as ScorePlayer): the sung audio runs through them in order (singscore.py unrolls the repeats),
  // so its clock is mapped to the score's bars for the playhead and back for a seek
  constructor({ url, bpm, beats, endQ, onTick, onEnd, segments = null }) {
    Object.assign(this, { bpm, beats, endQ, onTick, onEnd, segments });
    this.rate = 1; this.shift = 0; this.loop = null; this.posQ = 0; this.playing = false; this.want = null;
    const el = (this.el = new Audio());
    el.preload = 'auto'; el.setAttribute('playsinline', ''); el.src = url;
    el.addEventListener('loadedmetadata', () => { if (this.want != null) { const q = this.want; this.want = null; this.setTime(q); } });
    el.addEventListener('ended', () => { if (!this.playing) return; this.stopClock(); this.posQ = 0; this.onEnd?.(); });
    el.addEventListener('error', () => { this.failed = true; if (this.playing) { this.stopClock(); this.onEnd?.(); } });
  }
  get qps() { return this.bpm / 60; }
  toScore(pq) { if (!this.segments) return pq; let acc = 0; for (const [a, z] of this.segments) { if (pq < acc + z - a) return a + pq - acc; acc += z - a; } return this.segments.at(-1)[1]; }
  toPlay(sq) { if (!this.segments) return sq; let acc = 0; for (const [a, z] of this.segments) { if (sq >= a && sq < z) return acc + sq - a; acc += z - a; } return acc; }
  setTime(q) {
    if (this.el.readyState >= 1) { try { this.el.currentTime = this.toPlay(q) / this.qps; return; } catch {} }
    this.want = q; // before the metadata is in (iOS): applied on loadedmetadata
  }
  now() { return this.playing ? (this.want != null ? this.want : this.toScore(this.el.currentTime * this.qps)) : this.posQ; }
  play() {
    if (this.playing) return Promise.resolve();
    if (this.posQ >= (this.loop ? this.loop[1] : this.endQ)) this.posQ = this.loop ? this.loop[0] : 0;
    this.setTime(this.posQ);
    this.playing = true;
    const p = this.el.play(); // first thing, inside the tap
    const tick = () => {
      if (!this.playing) return;
      const q = this.now();
      if (this.loop && q >= this.loop[1]) this.setTime(this.loop[0]);
      this.onTick?.(Math.min(q, this.endQ));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
    return Promise.resolve(p).catch((e) => { this.stopClock(); throw e; });
  }
  stopClock() { this.playing = false; cancelAnimationFrame(this.raf); try { this.el.pause(); } catch {} }
  pause() { if (!this.playing) return; this.posQ = this.now(); this.stopClock(); }
  seek(q) { this.posQ = Math.max(0, Math.min(q, this.endQ)); this.setTime(this.posQ); this.onTick?.(this.posQ); }
  setRate() {} // its own tempo; see the toolbar
  stop() { this.pause(); this.posQ = 0; this.setTime(0); }
  destroy() { this.stopClock(); this.el.removeAttribute('src'); try { this.el.load(); } catch {} }
}

// ---------- one live key (Keyboard beta): sounds from the press until release() ----------
let liveOut = null;
export function pianoKey(pitch, vel = 90) {
  const c = audioCtx();
  if (!piano.length) loadPiano();
  if (!liveOut || liveOut.context !== c) {
    liveOut = c.createGain(); liveOut.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    liveOut.connect(comp); comp.connect(c.destination);
  }
  const now = c.currentTime, env = c.createGain();
  let src;
  if (piano.length) {
    const s = piano.reduce((b, x) => (Math.abs(x.note - pitch) < Math.abs(b.note - pitch) ? x : b));
    src = c.createBufferSource(); src.buffer = s.buf;
    src.playbackRate.value = Math.pow(2, (pitch - s.note) / 12);
    env.gain.setValueAtTime(Math.pow(vel / 127, 1.2), now);
  } else {
    src = c.createOscillator(); src.type = 'triangle';
    src.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime((vel / 127) * 0.25, now + 0.006);
    env.gain.setTargetAtTime(0, now + 0.01, 0.6);
  }
  src.connect(env); env.connect(liveOut);
  src.start(now); src.stop(now + 8);
  let done = false;
  return () => {
    if (done) return; done = true;
    const t = c.currentTime;
    try { env.gain.cancelScheduledValues(t); env.gain.setTargetAtTime(0, t, 0.12); src.stop(t + 0.8); } catch {}
  };
}


