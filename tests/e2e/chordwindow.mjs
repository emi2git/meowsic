// The chords strip while playing: against a test server (BASE, a temp data folder — never the real library). Per device
// (Mac, iPad Pro 13", iPhone), ukulele and piano chords: a made-up score of 8 bars, one chord name a bar
// (C G Am F Dm Em G7 C) and a repeat over bars 1–4. Stopped: all 7 chords in the strip. Playing: exactly 4 boxes, the
// chord sounding now first (marked .uk-now, aria-current) and the next 3 in the play order; the set moves on with the
// playhead; a seek to bar 4 (first time through) shows F then the repeat (C G Am), the second time through F Dm Em G7;
// an A–B loop on bars 3–4 goes round (Am F Am F); a tempo change and Play chords on keep the 4; Pause and Stop: all 7.
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
  ['Mac', { width: 1440, height: 900 }, 'uke'],
  ['iPad', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'piano'],
  ['iPhone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, 'uke'],
];
const stamp = Date.now().toString(36);

// 8 bars of quarter notes (divisions 1), one chord a bar, a repeat sign at the end of bar 4
const CH = [['C', 'major'], ['G', 'major'], ['A', 'minor'], ['F', 'major'], ['D', 'minor'], ['E', 'minor'], ['G', 'dominant'], ['C', 'major']];
const NAMES = { 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4', 71: 'B4', 72: 'C5' };
const MEL = [60, 64, 67, 72, 71, 69, 65, 62];
const note = (m) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
const harm = ([step, kind]) => `<harmony><root><root-step>${step}</root-step></root><kind>${kind}</kind></harmony>`;
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>Window tune</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + CH.map((c, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>'}`
    + harm(c) + [0, 1, 2, 3].map((i) => note(MEL[(k + i) % 8])).join('')
    + (k === 3 ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : '') + '</measure>').join('') + '</part></score-partwise>';
const item = await send('POST', '/items', { kind: 'score', title: `Window tune ${stamp}`, artist: 'Test', musicxmlText: xml });

for (const [name, vp, mode] of DEVICES) {
  console.log(`\n${name} (${mode})`);
  const touch = !!vp.hasTouch;
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const E = (f, ...a) => page.evaluate(f, ...a);
  const open = async () => { await page.goto(`${BASE}#/item/${item.id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
  // the chord boxes on show: [name, now]
  const seen = () => E(() => [...document.querySelectorAll('.chord-strip .uk-chord')].filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => (e.classList.contains('uk-now') ? '*' : '') + e.dataset.chord));
  const waitFor = async (f, ms = 3000) => { for (let t = 0; t < ms; t += 50) { if (await f()) return true; await sleep(50); } return false; };

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await E((m) => { localStorage.setItem('meowsic-chords', m); localStorage.setItem('meowsic-chordplay', '0'); }, mode);
  await open();
  await waitFor(async () => (await seen()).length > 0);
  const all = await seen();
  check('stopped: every chord in the strip (7)', all.join() === 'C,G,Am,F,Dm,Em,G7', all.join());

  await tap('#sc-play');
  await waitFor(() => E(() => window.__score.player.playing));
  await sleep(300);
  let s = await seen();
  check('playing: exactly 4 chords', s.length === 4, s.join());
  check('the first is the one sounding now, marked current', s.join() === '*C,G,Am,F', s.join());
  check('the current one is aria-current, the others not', await E(() => { const xs = [...document.querySelectorAll('.uk-next .uk-chord')]; return xs[0]?.getAttribute('aria-current') === 'true' && xs.slice(1).every((x) => !x.hasAttribute('aria-current')); }));
  check('the full list is hidden', await E(() => document.querySelector('.chord-strip .uk-row:not(.uk-next)').hidden));
  check('the current box stands out (border in the chord colour)', await E(() => { const x = document.querySelector('.uk-now'), o = document.querySelector('.uk-next .uk-chord:not(.uk-now)'); return getComputedStyle(x).borderTopWidth === '2px' && +getComputedStyle(o).opacity < 1; }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-chordwindow.png` });

  // the set moves on with the playhead (a bar = 2 s at 120)
  const moved = await waitFor(async () => (await seen())[0] === '*G', 3500);
  s = await seen();
  check('it moves on: G now, then Am F and the repeat (C)', moved && s.join() === '*G,Am,F,C', s.join());

  // seek while playing: bar 4 the first time through → the repeat comes next
  await E(() => window.__score.seek(13));
  await waitFor(async () => (await seen())[0] === '*F');
  s = await seen();
  check('seek to bar 4 (first time): F, then the repeat C G Am', s.join() === '*F,C,G,Am', s.join());
  // a tempo change: still the 4
  await E(() => window.__score.setTempo(240));
  await sleep(300);
  s = await seen();
  check('tempo change: still 4, the first current', s.length === 4 && s[0].startsWith('*'), s.join());
  // through the repeat and to bar 4 the second time: on to bar 5
  const rep = await waitFor(async () => (await seen())[0] === '*C', 3000);
  check('the repeat: C again (first chord current)', rep, (await seen()).join());
  await waitFor(async () => (await seen())[0] === '*F', 6000);
  s = await seen();
  check('bar 4 the second time: F Dm Em G7', s.join() === '*F,Dm,Em,G7', s.join());
  await tap('#sc-hands [data-part="chords"]');
  await sleep(300);
  s = await seen();
  check('Play chords on: still 4, the first current', (await E(() => window.__score.player.chordsOn)) && s.length === 4 && s[0].startsWith('*'), s.join());

  // Pause: every chord again
  await tap('#sc-play');
  const back = await waitFor(async () => (await seen()).length === 7, 1500);
  check('paused: every chord again', back && (await seen()).join() === 'C,G,Am,F,Dm,Em,G7', (await seen()).join());

  // an A–B loop on bars 3–4: round and round
  await E(() => { window.__score.player.loop = [8, 16]; window.__score.seek(9); });
  await tap('#sc-play');
  await waitFor(async () => (await seen())[0] === '*Am');
  s = await seen();
  check('A–B loop on bars 3–4: Am F Am F', s.join() === '*Am,F,Am,F', s.join());
  await E(() => { window.__score.player.loop = null; });

  // Stop: every chord again
  await tap('#sc-stop');
  await waitFor(async () => (await seen()).length === 7, 1500);
  s = await seen();
  check('stopped: every chord again, none marked', s.join() === 'C,G,Am,F,Dm,Em,G7', s.join());
  const sw = await E(() => document.documentElement.scrollWidth);
  check('no sideways scroll', sw <= vp.width, String(sw));
  await tap('#sc-hands [data-part="chords"]'); // Play chords off again (this device)
  await page.close();
}

await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
