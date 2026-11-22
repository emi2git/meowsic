// Web Audio: sampled piano playback (from Meowsic 1's score reader), metronome and tuner.
let ctx;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
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
  const c = ctx, env = c.createGain();
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
}

function click(out, when, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  o.connect(g); g.connect(out);
  o.start(when); o.stop(when + 0.08);
}

export function playTone(midi, seconds = 1.5) {
  audioCtx();
  loadPiano()?.then(() => {});
  const out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
  pianoVoice(out, midi, 100, ctx.currentTime + 0.02, seconds);
}

// ---------- score player: notes in quarter-note time; tempo, loop, click, transpose ----------
export class ScorePlayer {
  constructor({ notes, bpm, beats, onTick, onEnd }) {
    Object.assign(this, { notes, bpm, beats, onTick, onEnd });
    this.rate = 1; this.shift = 0; this.click = false;
    this.loop = null; // [startQ, endQ]
    this.posQ = 0; this.playing = false;
    this.endQ = notes.reduce((m, n) => Math.max(m, n.q + n.d), 0);
    this.endQ = Math.ceil(this.endQ / beats) * beats;
  }
  get qps() { return (this.bpm * this.rate) / 60; } // quarters per second
  now() {
    if (!this.playing) return this.posQ;
    const t = ctx.currentTime;
    const a = this.anchors.filter((x) => x.t0 <= t).pop() || this.anchors[0];
    return a.q0 + (t - a.t0) * this.qps;
  }
  async play() {
    if (this.playing) return;
    audioCtx();
    await loadPiano();
    if (this.posQ >= (this.loop ? this.loop[1] : this.endQ)) this.posQ = this.loop ? this.loop[0] : 0;
    this.out = ctx.createGain(); this.out.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    this.out.connect(comp); comp.connect(ctx.destination);
    this.q0 = this.posQ; this.t0 = ctx.currentTime + 0.12;
    this.anchors = [{ q0: this.q0, t0: this.t0 }];
    this.scheduledTo = this.posQ;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 50);
    this.pump();
    const tick = () => { if (!this.playing) return; this.onTick?.(this.now()); this.raf = requestAnimationFrame(tick); };
    tick();
  }
  pump() {
    const horizonQ = this.now() + 0.4 * this.qps;
    const stopQ = this.loop ? this.loop[1] : this.endQ;
    while (this.scheduledTo < horizonQ) {
      const a = this.scheduledTo, b = Math.min(horizonQ, stopQ);
      for (const n of this.notes) if (n.q >= a && n.q < b) {
        const when = this.t0 + (n.q - this.q0) / this.qps;
        pianoVoice(this.out, n.n + this.shift, n.v, Math.max(ctx.currentTime, when), Math.max(0.08, n.d / this.qps));
      }
      if (this.click) for (let q = Math.ceil(a); q < b; q++) click(this.out, this.t0 + (q - this.q0) / this.qps, q % this.beats === 0);
      this.scheduledTo = b;
      if (b >= stopQ) {
        if (this.loop) { // jump back: re-anchor the clock at the loop start
          const tEnd = this.t0 + (stopQ - this.q0) / this.qps;
          this.q0 = this.loop[0]; this.t0 = tEnd; this.scheduledTo = this.loop[0];
          this.anchors = [...this.anchors.slice(-1), { q0: this.q0, t0: this.t0 }];
        } else break;
      }
    }
    if (!this.loop && this.now() >= this.endQ + 0.5) { this.pause(); this.posQ = 0; this.onEnd?.(); }
  }
  pause() {
    if (!this.playing) return;
    this.posQ = this.now();
    this.playing = false;
    clearInterval(this.timer); cancelAnimationFrame(this.raf);
    const o = this.out; o.gain.setTargetAtTime(0, ctx.currentTime, 0.03); setTimeout(() => o.disconnect(), 300);
  }
  seek(q) { const was = this.playing; if (was) this.pause(); this.posQ = Math.max(0, Math.min(q, this.endQ)); this.onTick?.(this.posQ); if (was) this.play(); }
  setRate(r) { const was = this.playing; if (was) this.pause(); this.rate = r; if (was) this.play(); }
  stop() { this.pause(); this.posQ = 0; }
}

// ---------- metronome ----------
export class Metronome {
  constructor(onBeat) { this.onBeat = onBeat; this.bpm = 90; this.beats = 4; this.running = false; }
  start() {
    audioCtx();
    this.out = ctx.createGain(); this.out.gain.value = 0.8; this.out.connect(ctx.destination);
    this.next = ctx.currentTime + 0.08; this.beat = 0; this.running = true;
    this.timer = setInterval(() => this.pump(), 25);
  }
  pump() {
    while (this.next < ctx.currentTime + 0.12) {
      const b = this.beat, when = this.next;
      click(this.out, when, b === 0 && this.beats > 1);
      setTimeout(() => this.running && this.onBeat?.(b), Math.max(0, (when - ctx.currentTime) * 1000));
      this.beat = (this.beat + 1) % this.beats;
      this.next += 60 / this.bpm;
    }
  }
  stop() { this.running = false; clearInterval(this.timer); this.out?.disconnect(); }
}

// ---------- tuner (autocorrelation pitch detection) ----------
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function noteOfFreq(f) {
  const m = 69 + 12 * Math.log2(f / 440);
  const n = Math.round(m);
  return { name: NAMES[((n % 12) + 12) % 12], octave: Math.floor(n / 12) - 1, cents: Math.round((m - n) * 100), midi: n };
}

function detect(buf, rate) {
  let rms = 0;
  for (const v of buf) rms += v * v;
  if (Math.sqrt(rms / buf.length) < 0.012) return null;
  const n = buf.length, c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) { let s = 0; for (let i = 0; i < n - lag; i++) s += buf[i] * buf[i + lag]; c[lag] = s; }
  let d = 0; while (d < n - 1 && c[d] > c[d + 1]) d++;
  let best = -1, bi = -1;
  for (let i = d; i < n; i++) if (c[i] > best) { best = c[i]; bi = i; }
  if (bi <= 0 || bi >= n - 1) return null;
  const x1 = c[bi - 1], x2 = c[bi], x3 = c[bi + 1];
  const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
  const t = a ? bi - b / (2 * a) : bi;
  const f = rate / t;
  return f > 40 && f < 2000 ? f : null;
}

export class Tuner {
  constructor(onPitch) { this.onPitch = onPitch; }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('The microphone needs a secure (https) connection. It will work once the Mac server has its certificate (phase 2).');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    audioCtx();
    const src = ctx.createMediaStreamSource(this.stream);
    this.an = ctx.createAnalyser(); this.an.fftSize = 2048;
    src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    const loop = () => {
      this.an.getFloatTimeDomainData(this.buf);
      const f = detect(this.buf, ctx.sampleRate);
      this.onPitch(f ? { f, ...noteOfFreq(f) } : null);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  stop() { cancelAnimationFrame(this.raf); this.stream?.getTracks().forEach((t) => t.stop()); }
}
