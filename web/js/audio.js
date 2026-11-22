// Web Audio: sampled piano playback (from Meowsic 1's score reader).
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

// ---------- score player: notes in quarter-note time; tempo, loop, transpose ----------
export class ScorePlayer {
  constructor({ notes, bpm, beats, onTick, onEnd }) {
    Object.assign(this, { notes, bpm, beats, onTick, onEnd });
    this.rate = 1; this.shift = 0;
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

