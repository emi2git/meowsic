// Play chords (score toolbar): against a test server (BASE, a temp data folder — never the real library). Per device
// (Mac, iPad Pro 13", iPhone): a made-up score with chord names (C, G on beat 3 of bar 2, F in bar 4) and a repeat
// over bars 1–2, and the same score without chord names → the toggle shows for the first, not the second; it fits on
// the toolbar; tapping it turns it on (remembered on this device, after a reload too); Play schedules the chords as
// piano notes (C = C2 + C3 E3 G3) with the melody, in the play order (the repeat), struck again on beat 1 of each bar;
// from bar 3 the G held over from bar 2 is struck there; Stop stops them; turned off: no chord notes.
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

for (const [name, vp] of DEVICES) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const E = (f, ...a) => page.evaluate(f, ...a);
  const open = async (id) => { await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
  const shown = () => page.$eval('#sc-chordplay', (e) => !e.hidden && e.getBoundingClientRect().width > 0).catch(() => false);

  // no chord names: no toggle
  await open(noC.id);
  check('no chord names: the Chords toggle is hidden', !(await shown()));
  check('no chord names: the player has no chord notes', (await E(() => window.__score.player.chords.length)) === 0);

  // chord names: the toggle, off at first, fits
  await open(withC.id);
  await E(() => { try { localStorage.removeItem('meowsic-chordplay'); } catch {} });
  await open(withC.id);
  check('chord names: the Chords toggle shows', await shown());
  check('it is a single icon with an aria-label, off at first', await page.$eval('#sc-chordplay', (e) => !!e.querySelector('svg') && !e.textContent.trim() && e.getAttribute('aria-label') === 'Play chords' && e.getAttribute('aria-pressed') === 'false'));
  const r = await page.$eval('#sc-chordplay', (e) => { const x = e.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; });
  check('it fits on the screen', r.l >= 0 && r.r <= vp.width && r.t >= 0 && r.b <= vp.height, JSON.stringify(r));
  const sw = await E(() => document.documentElement.scrollWidth);
  check('no sideways scroll', sw <= vp.width, String(sw));
  check('the player has the chord notes (C = C2 + C3 E3 G3 at 0)', (await E(() => window.__score.player.chords.filter((n) => n.q === 0).map((n) => n.n).sort((a, b) => a - b).join())) === '36,48,52,55');

  // off: Play has no chord notes
  await E(() => { window.__score.player.rate = 2; });
  await tap('#sc-play'); await sleep(1200);
  check('off: playing, no chord notes scheduled', (await E(() => window.__score.player.playing && window.__score.player.heardChords.length === 0 && window.__score.player.heard.length > 2)));
  await tap('#sc-chordplay'); await sleep(500); // on while playing: from the chord sounding now
  check('on while playing: chords come in', (await E(() => window.__score.player.heardChords.length)) >= 4);
  await tap('#sc-chordplay'); await sleep(100);
  const k = await E(() => window.__score.player.heardChords.length); await sleep(500);
  check('off while playing: no more chords', (await E(() => window.__score.player.heardChords.length)) === k && (await E(() => !window.__score.player.chordsOn)));
  await tap('#sc-stop'); await sleep(200); await tap('#sc-stop'); await sleep(200);

  // on: remembered; Play schedules them in the play order
  await tap('#sc-chordplay');
  check('tap: on (pressed, remembered on this device)', (await page.$eval('#sc-chordplay', (e) => e.getAttribute('aria-pressed') === 'true' && e.classList.contains('on'))) && (await E(() => localStorage.getItem('meowsic-chordplay'))) === '1');
  await E(() => { window.__score.player.rate = 2; });
  await tap('#sc-play');
  for (let i = 0; i < 60 && (await E(() => window.__score.player.playing)); i++) await sleep(150);
  const h = await E(() => ({ c: window.__score.player.heardChords, played: window.__score.player.played, n: window.__score.player.heard.length }));
  const strikes = h.c.map(([q]) => q).filter((q, i, a) => !i || q !== a[i - 1]); // one per strike (the repeat plays some again)
  check('the melody played too', h.n >= 24, String(h.n));
  check('chords in the play order: C 0, C 4 (beat 1 of bar 2), G 6, the repeat (C 0, C 4, G 6), G 8 (bar 3), F 12', strikes.join() === '0,4,6,0,4,6,8,12', strikes.join());
  check('each strike is bass + three notes', h.c.length === strikes.length * 4, String(h.c.length));
  check('the repeat was played', h.played.length === 2, JSON.stringify(h.played));
  check('G = G2 + G3 B3 D4', h.c.filter(([q]) => q === 8).map(([, n]) => n).sort((a, b) => a - b).join() === '43,55,59,62');

  // from bar 3 (▶ From here / the cue): the G held over from bar 2 is struck at bar 3; Stop stops the chords
  await E(() => window.__score.cueBar(3)); await sleep(200);
  await E(() => { window.__score.player.rate = 1; });
  await tap('#sc-play'); await sleep(500);
  const h3 = await E(() => window.__score.player.heardChords.map(([q]) => q));
  check('from bar 3: the chord in force (G) is struck at bar 3 first', h3[0] === 8 && !h3.some((q) => q < 8), h3.join());
  await tap('#sc-stop'); await sleep(300);
  const n1 = await E(() => window.__score.player.heardChords.length); await sleep(700);
  check('Stop: no more chords', !(await E(() => window.__score.player.playing)) && (await E(() => window.__score.player.heardChords.length)) === n1);

  // remembered after a reload; the plain score still has none
  await open(withC.id);
  check('after a reload: still on', await page.$eval('#sc-chordplay', (e) => e.getAttribute('aria-pressed') === 'true'));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-chordplay.png` });
  await open(noC.id);
  check('the plain score: still hidden', !(await shown()));
  await open(withC.id);
  await tap('#sc-chordplay');
  check('tap again: off', (await E(() => localStorage.getItem('meowsic-chordplay'))) === '0' && !(await E(() => window.__score.player.chordsOn)));
  await page.close();
}

await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
