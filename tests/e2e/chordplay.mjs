// Chords part (score toolbar's C toggle, among the part toggles): against a test server (BASE, a temp data folder —
// never the real library). Per device (Mac, iPad Pro 13", iPhone): a made-up one-staff score with chord names (C, G on
// beat 3 of bar 2, F in bar 4) and a repeat over bars 1–2, and the same score without chord names → no toggles for the
// second; M (Melody) + C for the first, C off at first, it fits; tapping C turns it on (remembered for this score, after
// a reload too); Play schedules each chord once at its change as a close-position block chord in C3–C5 with the root
// at the bottom (C = C3 E3 G3 C4), held to the next change (never past the repeat's end), in the play order (the
// repeat); transposed with the score (+2: D = D3 F♯3 A3 D4); from bar 3 the G in force is struck there; an A–B loop
// strikes the chords again each time round; a seek strikes the chord in force; Stop stops them; C off: no chord
// notes; the chords use the pad (not the piano samples).
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
const DEVICES = [
  ['Mac', { width: 1440, height: 900 }],
  ['iPad', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['iPhone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
];
const stamp = Date.now().toString(36);

// four bars of quarter notes (divisions 1); chords: bar 1 C, bar 2 beat 3 G, bar 4 F; repeat sign at the end of bar 2
const MEL = [[60, 64, 67, 64], [62, 65, 67, 71], [72, 71, 69, 67], [65, 64, 62, 60]];
const NAMES = { 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4', 71: 'B4', 72: 'C5' };
const note = (m) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
const harm = (step) => `<harmony><root><root-step>${step}</root-step></root><kind>major</kind></harmony>`;
const scoreXml = (title, chords) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + MEL.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>200</per-minute></metronome></direction-type><sound tempo="200"/></direction>'}`
    + (chords && k === 0 ? harm('C') : '') + (chords && k === 3 ? harm('F') : '')
    + bar.map((m, i) => (chords && k === 1 && i === 2 ? harm('G') : '') + note(m)).join('')
    + (k === 1 ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : '') + '</measure>').join('') + '</part></score-partwise>';

const withC = await send('POST', '/items', { kind: 'score', title: `Chord tune ${stamp}`, artist: 'Test', musicxmlText: scoreXml('Chord tune', true) });
const noC = await send('POST', '/items', { kind: 'score', title: `Plain tune ${stamp}`, artist: 'Test', musicxmlText: scoreXml('Plain tune', false) });
const C_BTN = '#sc-hands [data-part="chords"]';

for (const [name, vp] of DEVICES) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const E = (f, ...a) => page.evaluate(f, ...a);
  const open = async (id) => { await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
  const shown = () => page.$eval(C_BTN, (e) => e.getBoundingClientRect().width > 0).catch(() => false);
  const playAll = async () => {
    await E(() => { window.__score.player.rate = 2; });
    await tap('#sc-play');
    for (let i = 0; i < 60 && !(await E(() => window.__score.player.playing)); i++) await sleep(100);
    for (let i = 0; i < 80 && (await E(() => window.__score.player.playing)); i++) await sleep(150);
  };
  const stop = async () => { await tap('#sc-stop'); await sleep(200); await tap('#sc-stop'); await sleep(200); };
  // one entry per strike (its notes come one after another): [q, sorted midi, length in quarters]
  const strikes = () => E(() => { const out = []; for (const [q, n, d] of window.__score.player.heardChords) { const l = out.at(-1); if (l && l[0] === q && l[2] === d) l[1].push(n); else out.push([q, [n], d]); } return out.map(([q, ns, d]) => [q, ns.sort((a, b) => a - b).join(' '), +d.toFixed(3)]); });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await E((ids) => { try { localStorage.removeItem('meowsic-chordplay'); for (const id of ids) localStorage.removeItem(`meowsic-parts-${id}`); } catch {} }, [withC.id, noC.id]);

  // no chord names (one staff): no toggles at all
  await open(noC.id);
  check('no chord names: no C toggle (and no toggles for one staff)', !(await shown()) && !(await page.$('#sc-hands .hands')));
  check('no chord names: the player has no chord notes', (await E(() => window.__score.player.chords.length)) === 0);
  check('no separate Play chords button on the toolbar', !(await page.$('#sc-chordplay')));

  // chord names: M + C, C off at first
  await open(withC.id);
  check('chord names: the toggles M (Melody) and C (Chords), M on, C off', (await E(() => [...document.querySelectorAll('#sc-hands button')].map((x) => `${x.textContent}:${x.getAttribute('aria-label')}:${x.getAttribute('aria-pressed')}`).join())) === 'M:Melody:true,C:Chords:false');
  const r = await page.$eval(C_BTN, (e) => { const x = e.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; });
  check('it fits on the screen', r.l >= 0 && r.r <= vp.width && r.t >= 0 && r.b <= vp.height, JSON.stringify(r));
  const sw = await E(() => document.documentElement.scrollWidth);
  check('no sideways scroll', sw <= vp.width, String(sw));
  check('the voicing: C = C3 E3 G3 C4 at 0, held to the G at 6', (await E(() => window.__score.player.chords.filter((n) => n.q === 0).map((n) => `${n.n}/${n.d}`).sort().join())) === '48/6,52/6,55/6,60/6');

  // off: Play has no chord notes; on / off while playing
  await E(() => { window.__score.player.rate = 2; });
  await tap('#sc-play'); await sleep(1200);
  check('off: playing, no chord notes scheduled', (await E(() => window.__score.player.playing && window.__score.player.heardChords.length === 0 && window.__score.player.heard.length > 2)));
  await tap(C_BTN); await sleep(500);
  check('on while playing: the chord in force comes in', (await E(() => window.__score.player.heardChords.length)) >= 4);
  await tap(C_BTN); await sleep(100);
  const k = await E(() => window.__score.player.heardChords.length); await sleep(500);
  check('off while playing: no more chords', (await E(() => window.__score.player.heardChords.length)) === k && (await E(() => !window.__score.player.chordsOn)));
  await stop();

  // on: remembered for this score; Play schedules them at the changes, in the play order
  await tap(C_BTN);
  check('tap: C on (pressed, remembered for this score)', (await page.$eval(C_BTN, (e) => e.getAttribute('aria-pressed') === 'true' && e.classList.contains('on'))) && JSON.parse(await E((id) => localStorage.getItem(`meowsic-parts-${id}`), withC.id)).chords === true);
  await playAll();
  const s1 = await strikes();
  check('the melody played too', (await E(() => window.__score.player.heard.length)) >= 24);
  check('one strike per chord change, in the play order: C 0, G 6, (repeat) C 0, G 6, F 12; none on the bar lines', s1.map(([q]) => q).join() === '0,6,0,6,12', JSON.stringify(s1));
  check('held to the next change, cut at the repeat: C 6, G 2 (to the repeat), C 6, G 6, F 4 quarters', s1.map(([, , d]) => d).join() === '6,2,6,6,4', JSON.stringify(s1));
  check('voicings: C = 48 52 55 60, G = 55 59 62 67, F = 53 57 60 65', s1[0][1] === '48 52 55 60' && s1[1][1] === '55 59 62 67' && s1[4][1] === '53 57 60 65', JSON.stringify(s1));
  check('the repeat was played', (await E(() => window.__score.player.played.length)) === 2);
  check('the chords play on the pad, not the piano samples', await E(() => window.__score.player.chordVoices.length === 0 || window.__score.player.chordVoices.every((v) => !(v.src instanceof AudioBufferSourceNode))));
  await stop();
  if (name === 'Mac') { // the level: a C chord on the pad vs a melody note (C5, v 90) on the piano, both held 1.5 s
    const lv = await E(async () => {
      const m = await import('./js/audio.js');
      await m.loadPiano();
      const sr = m.audioCtx().sampleRate;
      const rms = async (fn) => { const oc = new OfflineAudioContext(1, sr * 2, sr), g = oc.createGain(); g.connect(oc.destination); fn(g); const d = (await oc.startRendering()).getChannelData(0); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); };
      const { pianoVoice, padVoice } = m.voicesForTests;
      const mel = await rms((g) => pianoVoice(g, 72, 90, 0, 1.5));
      const pad = await rms((g) => { for (const n of [48, 52, 55, 60]) padVoice(g, n, 64, 0, 1.5); });
      const attack = await (async () => { const oc = new OfflineAudioContext(1, sr, sr), g = oc.createGain(); g.connect(oc.destination); padVoice(g, 60, 64, 0, 0.8); const d = (await oc.startRendering()).getChannelData(0); const pk = (a, z) => { let p = 0; for (let i = Math.floor(a * sr); i < z * sr; i++) p = Math.max(p, Math.abs(d[i])); return p; }; return pk(0, 0.02) / pk(0.15, 0.3); })();
      return { db: 20 * Math.log10(pad / mel), attack, mel, pad };
    });
    check(`the pad chord sits 8–10 dB under the melody (${lv.db.toFixed(1)} dB)`, lv.db <= -8 && lv.db >= -10, JSON.stringify(lv));
    check('gentle attack: the first 20 ms well under the held level', lv.attack < 0.4, JSON.stringify(lv));
  }

  // transposed with the score: +2
  await E(() => window.__score.setTranspose(2)); await sleep(300);
  await playAll();
  const s2 = await strikes();
  check('transposed +2: C → D = 50 54 57 62, at the same changes', s2.map(([q]) => q).join() === '0,6,0,6,12' && s2[0][1] === '50 54 57 62' && s2[4][1] === '55 59 62 67', JSON.stringify(s2));
  check('…and the melody with it', (await E(() => window.__score.player.shift)) === 2);
  await stop();
  await E(() => window.__score.setTranspose(0)); await sleep(300);

  // from bar 3 (the cue): the G held over from bar 2 is struck at bar 3, to F
  await E(() => window.__score.cueBar(3)); await sleep(200);
  await E(() => { window.__score.player.rate = 1; });
  await tap('#sc-play'); await sleep(500);
  const h3 = await strikes();
  check('from bar 3: the chord in force (G) struck at bar 3 first, held to F', h3[0]?.[0] === 8 && h3[0][1] === '55 59 62 67' && h3[0][2] === 4 && !h3.some(([q]) => q < 8), JSON.stringify(h3));
  // seek while playing: the chord in force at the new spot
  await E(() => window.__score.seek(13)); await sleep(500);
  const hs = await strikes();
  check('seek to 13 while playing: F struck at 13 for 3 quarters', hs[0]?.[0] === 13 && hs[0][1] === '53 57 60 65' && hs[0][2] === 3, JSON.stringify(hs));
  await tap('#sc-stop'); await sleep(300);
  const n1 = await E(() => window.__score.player.heardChords.length); await sleep(700);
  check('Stop: no more chords', !(await E(() => window.__score.player.playing)) && (await E(() => window.__score.player.heardChords.length)) === n1);
  await stop();

  // an A–B loop on bars 3–4: G struck at 8 each time round, then F at 12
  await E(() => { window.__score.player.loop = [8, 16]; window.__score.player.rate = 4; window.__score.seek(8); });
  await tap('#sc-play');
  for (let i = 0; i < 40 && (await E(() => window.__score.player.heardChords.length)) < 16; i++) await sleep(100);
  const hl = (await strikes()).map(([q, , d]) => `${q}/${d}`).slice(0, 4).join();
  check('A–B loop on bars 3–4: G 8 (to 12), F 12 (to 16), round again', hl === '8/4,12/4,8/4,12/4', hl);
  await E(() => { window.__score.player.loop = null; window.__score.player.rate = 1; });
  await stop();

  // remembered after a reload; the plain score still has none
  await open(withC.id);
  check('after a reload: C still on', await page.$eval(C_BTN, (e) => e.getAttribute('aria-pressed') === 'true'));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-chordplay.png` });
  await open(noC.id);
  check('the plain score: still no C toggle', !(await shown()));
  await open(withC.id);
  await tap(C_BTN);
  check('tap again: off', JSON.parse(await E((id) => localStorage.getItem(`meowsic-parts-${id}`), withC.id)).chords === false && !(await E(() => window.__score.player.chordsOn)));
  // M off with C on: chords only; then C off is refused (the last one on)
  await tap(C_BTN); await tap('#sc-hands [data-staff]');
  check('M off, C on: only C on', (await E(() => [...document.querySelectorAll('#sc-hands button')].map((x) => x.getAttribute('aria-pressed')).join())) === 'false,true');
  await tap(C_BTN);
  check('C (the last one on) stays on', (await page.$eval(C_BTN, (e) => e.getAttribute('aria-pressed') === 'true' && e.getAttribute('aria-disabled') === 'true')));
  await tap('#sc-hands [data-staff]'); await tap(C_BTN);
  await page.close();
}

await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
