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
let ctx, unlocked = false, session = 'playback';
const setSession = () => { try { if (navigator.audioSession && navigator.audioSession.type !== session) navigator.audioSession.type = session; } catch {} };
export function audioCtx({ fresh = false } = {}) {
  if (ctx && (ctx.state === 'closed' || (fresh && ctx.state !== 'running'))) { const old = ctx; ctx = null; try { old.onstatechange = null; old.close()?.catch?.(() => {}); } catch {} }
  if (!ctx) {
    setSession();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    unlocked = false;
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
const gaveUp = () => { session = 'auto'; };
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
    const t = this.ctx.currentTime;
    const a = this.anchors.filter((x) => x.t0 <= t).pop() || this.anchors[0];
    return a.q0 + (t - a.t0) * this.qps;
  }
  async play() {
    if (this.playing) return;
    const c = audioCtx({ fresh: true }); // synchronous, inside the tap; a stuck context is replaced
    await loadPiano();
    if (c.state !== 'running') { try { await Promise.race([c.resume(), new Promise((ok) => setTimeout(ok, 2000))]); } catch {} }
    if (c.state !== 'running' || c !== ctx) { gaveUp(); throw new Error('audio did not start'); }
    this.ctx = c;
    if (this.posQ >= (this.loop ? this.loop[1] : this.endQ)) this.posQ = this.loop ? this.loop[0] : 0;
    // from the very start: no waiting through rests before the first note (a score read from a sheet can open with them)
    const first = this.notes.reduce((m, n) => Math.min(m, n.q), Infinity);
    if (this.posQ <= 1e-3 && !this.loop && first > 0.01 && first < Infinity) this.posQ = first;
    this.out = c.createGain(); this.out.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    this.out.connect(comp); comp.connect(c.destination);
    this.q0 = this.posQ; this.t0 = c.currentTime + 0.12;
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
        pianoVoice(this.out, n.n + this.shift, n.v, Math.max(this.ctx.currentTime, when), Math.max(0.08, n.d / this.qps));
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
  constructor({ url, bpm, beats, endQ, onTick, onEnd }) {
    Object.assign(this, { bpm, beats, endQ, onTick, onEnd });
    this.rate = 1; this.shift = 0; this.loop = null; this.posQ = 0; this.playing = false; this.want = null;
    const el = (this.el = new Audio());
    el.preload = 'auto'; el.setAttribute('playsinline', ''); el.src = url;
    el.addEventListener('loadedmetadata', () => { if (this.want != null) { const q = this.want; this.want = null; this.setTime(q); } });
    el.addEventListener('ended', () => { if (!this.playing) return; this.stopClock(); this.posQ = 0; this.onEnd?.(); });
    el.addEventListener('error', () => { this.failed = true; if (this.playing) { this.stopClock(); this.onEnd?.(); } });
  }
  get qps() { return this.bpm / 60; }
  setTime(q) {
    if (this.el.readyState >= 1) { try { this.el.currentTime = q / this.qps; return; } catch {} }
    this.want = q; // before the metadata is in (iOS): applied on loadedmetadata
  }
  now() { return this.playing ? (this.want != null ? this.want : this.el.currentTime * this.qps) : this.posQ; }
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

