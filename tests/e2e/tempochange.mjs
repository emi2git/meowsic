// Tempo changes while playing: against a test server (BASE, a temp data folder — never the real library), Mac.
// A made-up score of 6 bars of quarter notes, one chord a bar, with four tempo marks: ♩ = 120 at bar 1, ♩ = 60 on
// beat 3 of bar 2 (mid-bar), 𝅗𝅥 = 45 (a <metronome> only, no <sound>: ♩ = 90) at bar 3, ♩ = 150 on beat 2 of bar 5
// (a <sound> with an <offset>), and a repeat over bars 1–2. Every note is scheduled at the time the tempo map gives,
// in the play order (1 2 1 2 3 4 5 6: bar 1 is at 120 again after the repeat, whatever came before), the speed control
// scales every mark (240 = twice as fast all through, also changed while playing), a seek lands at that bar's tempo,
// the A–B loop goes round at each bar's own tempo, a D.C. al Fine score plays bar 1 at its own tempo after the jump;
// the playhead (the orange line's q) and the chord pad (and the chords strip's current chord) stay with the notes.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const stamp = Date.now().toString(36);

const NAMES = { 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4', 71: 'B4', 72: 'C5' };
const note = (m) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>`;
const harm = ([step, kind]) => `<harmony><root><root-step>${step}</root-step></root><kind>${kind}</kind></harmony>`;
const snd = (bpm, off = 0) => `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type>${off ? `<offset>${off}</offset>` : ''}<sound tempo="${bpm}"/></direction>`;
const ATTR = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
const head = (t) => `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>${t}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">`;

// fixture 1: tempo changes + a repeat
const CH = [['C', 'major'], ['F', 'major'], ['G', 'major'], ['A', 'minor'], ['D', 'minor'], ['G', 'major']];
const MEL = [[60, 64, 67, 64], [65, 69, 72, 69], [67, 71, 62, 67], [69, 72, 64, 69], [62, 65, 69, 65], [67, 71, 62, 60]];
const bar = (k) => {
  const ns = MEL[k].map(note);
  let body = '';
  if (k === 0) body = ATTR + snd(120) + harm(CH[k]) + ns.join('');
  else if (k === 1) body = harm(CH[k]) + ns[0] + ns[1] + snd(60) + ns[2] + ns[3] + '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>';
  else if (k === 2) body = '<direction placement="above"><direction-type><metronome><beat-unit>half</beat-unit><per-minute>45</per-minute></metronome></direction-type></direction>' + harm(CH[k]) + ns.join('');
  else if (k === 4) body = snd(150, 2) + harm(CH[k]) + ns.join('');
  else body = harm(CH[k]) + ns.join('');
  return `<measure number="${k + 1}">${body}</measure>`;
};
const xml1 = head('Tempo change tune') + MEL.map((_, k) => bar(k)).join('') + '</part></score-partwise>';
const MAP1 = [[0, 120], [6, 60], [8, 90], [17, 150]];
const ORDER1 = [0, 1, 0, 1, 2, 3, 4, 5];

// fixture 2: D.C. al Fine. Bar 1 ♩ = 120 (Fine at its end), bar 2 ♩ = 60, bar 3 ♩ = 240 + D.C. → 1 2 3 1
const xml2 = head('Tempo DC tune')
  + `<measure number="1">${ATTR}${snd(120)}${[60, 62, 64, 65].map(note).join('')}<direction><direction-type><words>Fine</words></direction-type><sound fine="yes"/></direction></measure>`
  + `<measure number="2">${snd(60)}${[67, 65, 64, 62].map(note).join('')}</measure>`
  + `<measure number="3">${snd(240)}${[72, 71, 69, 67].map(note).join('')}<direction><direction-type><words>D.C. al Fine</words></direction-type><sound dacapo="yes"/></direction></measure>`
  + '</part></score-partwise>';
const MAP2 = [[0, 120], [4, 60], [8, 240]];
const ORDER2 = [0, 1, 2, 0];

const bpmAt = (map, q) => map.filter(([a]) => a <= q + 1e-9).at(-1)[1];
// the expected [q, seconds from the first] of every note, in the play order, from bar fromQ / beat on, at rate r
const expect = (map, order, r = 1, fromQ = -1) => {
  const out = []; let t = 0;
  for (const bi of order) for (let k = 0; k < 4; k++) {
    const q = bi * 4 + k;
    if (!out.length && q < fromQ) continue;
    out.push([q, t]); t += 60 / (bpmAt(map, q) * r);
  }
  return out;
};
const sameTimes = (got, want, tol = 0.004) => {
  if (got.length < want.length) return `only ${got.length} of ${want.length} notes`;
  for (let i = 0; i < want.length; i++) {
    const g = got[i], w = want[i];
    if (g[0] !== w[0]) return `note ${i}: q ${g[0]}, wanted ${w[0]}`;
    if (Math.abs(g[1] - got[0][1] - w[1]) > tol) return `note ${i} (q ${w[0]}): ${(g[1] - got[0][1]).toFixed(3)} s, wanted ${w[1].toFixed(3)} s`;
  }
  return '';
};

const it1 = await send('POST', '/items', { kind: 'score', title: `Tempo change tune ${stamp}`, artist: 'Test', musicxmlText: xml1 });
const it2 = await send('POST', '/items', { kind: 'score', title: `Tempo DC tune ${stamp}`, artist: 'Test', musicxmlText: xml2 });

const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(m.text()));
const E = (f, ...a) => page.evaluate(f, ...a);
const open = async (id) => { await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
const waitFor = async (f, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (await f()) return true; await sleep(50); } return false; };
const playing = () => E(() => window.__score.player.playing);
// one in-page sampler: every animation frame while playing, [audio time, playhead q (the 'tick' the orange line
// follows), the chords strip's current chord, the play order's segment]
const startSampling = () => E(() => {
  const s = (window.__samples = []), p = window.__score.player;
  const on = (e) => { if (p.playing && p.ctx) s.push([p.ctx.currentTime, e.detail.q, document.querySelector('.chord-strip .uk-now')?.dataset.chord || '']); };
  document.addEventListener('tick', on); window.__stopSampling = () => document.removeEventListener('tick', on);
});
const samples = () => E(() => { window.__stopSampling?.(); return window.__samples || []; });
// the playhead at audio time t: from the notes as scheduled ([q, at] in order) — between the last note started and the next
const syncErr = (smp, at, chordAt, tc = -1) => {
  let worst = 0, bad = '', n = 0;
  for (const [t, q, ch] of smp) {
    let k = -1; for (let i = 0; i < at.length; i++) if (at[i][1] <= t + 1e-6) k = i;
    if (k < 0 || k + 1 >= at.length) continue;
    const [qa, ta] = at[k], [qb, tb] = at[k + 1];
    if (qb !== qa + 1) continue; // a jump next: skip
    if (ta <= tc && tc < tb) continue; // the speed changed in this beat: not straight
    const want = qa + (t - ta) / (tb - ta); // straight between two notes a quarter apart
    const e = Math.abs(q - want); n++;
    if (e > worst) worst = e;
    if (chordAt && ch && ch !== chordAt(Math.floor(want - 1e-3)) && (want % 4) > 0.15 && (want % 4) < 3.85) bad ||= `at q ${want.toFixed(2)}: strip ${ch}, wanted ${chordAt(Math.floor(want))}`;
  }
  return { worst, bad, n };
};

await page.goto(BASE, { waitUntil: 'networkidle0' });
await E(() => { localStorage.setItem('meowsic-chords', 'uke'); localStorage.setItem('meowsic-chordplay', '1'); });
await open(it1.id);
const NAMES1 = ['C', 'F', 'G', 'Am', 'Dm', 'G'];
const chordOf = (q) => NAMES1[Math.floor(q / 4)];

// 1. the tempo map read from the file
const map = await E(() => window.__score.tempos);
check('every tempo mark read (120, 60 mid-bar, metronome-only 90, 150 with an offset)', JSON.stringify(map) === JSON.stringify(MAP1.map(([q, bpm]) => ({ q, bpm }))), JSON.stringify(map));
check('the toolbar shows the first tempo (120)', (await page.$eval('#sc-rate', (e) => +e.textContent)) === 120);
check('the chord pad is on', await E(() => window.__score.player.chordsOn));

// 2. the whole piece at 240 (twice as fast): every note at the tempo map's time / 2, in the play order
await E(() => window.__score.setTempo(240));
check('speed 240 = rate 2', await E(() => window.__score.player.rate === 2));
await startSampling();
await page.click('#sc-play');
await waitFor(playing);
await waitFor(async () => !(await playing()), 15000);
let at = await E(() => window.__score.player.heardAt);
let err = sameTimes(at, expect(MAP1, ORDER1, 2));
check('at 240: all 32 notes in the play order (1 2 1 2 3 4 5 6), each at the tempo map ÷ 2', !err && at.length === 32, err || String(at.length));
check('…bar 1 after the repeat is at 120 × 2 again (0.25 s a beat), bar 2 beat 3 at 60 × 2 (0.5 s)', !err && Math.abs(at[9][1] - at[8][1] - 0.25) < 0.004 && Math.abs(at[7][1] - at[6][1] - 0.5) < 0.004, JSON.stringify(at.slice(5, 10)));
let smp = await samples();
let se = syncErr(smp, at, chordOf);
check('the playhead stays with the notes (≤ 0.05 beat)', se.n > 50 && se.worst < 0.05, JSON.stringify(se));
check('the chords strip shows the chord of the bar playing', !se.bad, se.bad);
let hc = await E(() => window.__score.player.heardChords);
// the pad: one strike a bar at the time the first note of that bar plays; held to the bar's end in seconds
const padCheck = (hc, at, order, r) => {
  const strikes = []; for (const c of hc) { const l = strikes.at(-1); if (!l || Math.abs(l[3] - c[3]) > 1e-6) strikes.push(c); }
  const firsts = at.filter(([q]) => q % 4 === 0);
  if (strikes.length !== order.length) return `${strikes.length} pad strikes, wanted ${order.length}`;
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i][0] !== firsts[i][0]) return `strike ${i} at q ${strikes[i][0]}, wanted ${firsts[i][0]}`;
    if (Math.abs(strikes[i][3] - firsts[i][1]) > 0.004) return `strike ${i} (q ${strikes[i][0]}) ${(strikes[i][3] - firsts[i][1]).toFixed(3)} s off the notes`;
    const bi = strikes[i][0] / 4; let len = 0; for (let k = 0; k < 4; k++) len += 60 / (bpmAt(MAP1, bi * 4 + k) * r);
    if (Math.abs(strikes[i][4] + 0.02 - len) > 0.01) return `strike ${i} held ${strikes[i][4].toFixed(3)} s, wanted ${len.toFixed(3)} s`;
  }
  return '';
};
err = padCheck(hc, at, ORDER1, 2);
check('the chord pad strikes with the first note of each bar and is held to the bar end at the tempo map', !err, err);

// 3. a seek: bar 2 beat 2 at 120 (the speed control back to the score's own); the change on beat 3, then the repeat
await E(() => window.__score.setTempo(120));
await E(() => window.__score.seek(5));
await startSampling();
await page.click('#sc-play');
await waitFor(playing);
await waitFor(() => E(() => window.__score.player.heardAt.length >= 8), 8000);
// 4. …and the speed changed while playing (back in bar 1, after the repeat): the rest twice as fast
await waitFor(() => E(() => window.__score.player.now() >= 1.2 && window.__score.player.seg >= 1), 6000);
const [n0, tc] = await E(() => { const p = window.__score.player; window.__score.setTempo(240); return [p.heardAt.length, p.ctx.currentTime + 0.03]; });
await waitFor(() => E(() => window.__score.player.heardAt.length >= 12), 6000);
await page.click('#sc-play'); // pause
at = await E(() => window.__score.player.heardAt);
const seekWant = expect(MAP1, [1, 0], 1, 5).slice(0, 4); // q 5 6 7 then 0
err = sameTimes(at.slice(0, 4), seekWant);
check('seek to bar 2 beat 2: 0.5 s, then 1 s a beat after the change on beat 3, then the repeat to bar 1', !err, err || JSON.stringify(at.slice(0, 5)));
const tail = at.slice(n0 + 1);
let terr = '';
for (let i = 1; i < tail.length; i++) if (tail[i][0] === tail[i - 1][0] + 1) { const w = 60 / (bpmAt(MAP1, tail[i - 1][0]) * 2); if (Math.abs(tail[i][1] - tail[i - 1][1] - w) > 0.004) terr ||= `q ${tail[i - 1][0]}→${tail[i][0]}: ${(tail[i][1] - tail[i - 1][1]).toFixed(3)} s, wanted ${w}`; }
check('speed → 240 while playing: from then on each beat at its mark ÷ 2', tail.length >= 2 && !terr, terr || JSON.stringify(tail));
smp = await samples();
se = syncErr(smp, at, chordOf, tc);
check('…the playhead stays with the notes through the change', se.n > 20 && se.worst < 0.05, JSON.stringify(se));
check('…the chords strip too', !se.bad, se.bad);

// 5. the A–B loop on bars 2–3: 120 / 60 / 90 each time round
await E(() => { const s = window.__score; s.stop(); s.player.loop = [4, 12]; s.setTempo(240); s.seek(4); });
await startSampling();
await page.click('#sc-play');
await waitFor(playing);
await waitFor(() => E(() => window.__score.player.heardAt.length >= 14), 9000);
await page.click('#sc-play');
at = await E(() => window.__score.player.heardAt);
err = sameTimes(at.slice(0, 14), expect(MAP1, [1, 2, 1, 2], 2, 4).slice(0, 14));
check('A–B loop on bars 2–3 at 240: each time round at each bar\'s own tempo ÷ 2', !err, err || JSON.stringify(at.slice(0, 14)));
smp = await samples();
se = syncErr(smp, at, chordOf);
check('…the playhead and the chords strip stay with the notes', se.n > 20 && se.worst < 0.05 && !se.bad, JSON.stringify(se));
await E(() => { const s = window.__score; s.stop(); s.player.loop = null; });

// 6. D.C. al Fine: bar 1 at its own 120 after bar 3's 240
await open(it2.id);
check('D.C. score: its tempo map', JSON.stringify(await E(() => window.__score.tempos)) === JSON.stringify(MAP2.map(([q, bpm]) => ({ q, bpm }))), JSON.stringify(await E(() => window.__score.tempos)));
await E(() => window.__score.setTempo(240));
await startSampling();
await page.click('#sc-play');
await waitFor(playing);
await waitFor(async () => !(await playing()), 10000);
at = await E(() => window.__score.player.heardAt);
err = sameTimes(at, expect(MAP2, ORDER2, 2));
check('D.C. al Fine at 240: 1 2 3 1, bar 1 again at 120 × 2 after the jump', !err && at.length === 16, err || String(at.length));
smp = await samples();
se = syncErr(smp, at, null);
check('…the playhead stays with the notes', se.n > 20 && se.worst < 0.05, JSON.stringify(se));

// 7. Export ▸ MIDI: one tempo event per mark
const midiTempos = await E(async (id) => {
  const { midiFile } = await import('/js/views/score.js');
  const s = window.__score, buf = new Uint8Array(await midiFile(s.pianoNotes, s.tune?.bpm || 120, 0, s.tempos).arrayBuffer());
  const out = []; for (let i = 0; i + 5 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0x51 && buf[i + 2] === 3) out.push(Math.round(60e6 / ((buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5])));
  return out;
}, it2.id);
check('Export ▸ MIDI carries every tempo change', midiTempos.join() === '120,60,240', midiTempos.join());
if (SHOTS) await page.screenshot({ path: `${SHOTS}/tempochange.png` });
await E(() => window.__score.setTempo(120));
await page.close();

await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
