// End-to-end: Keyboard (beta) — the MIDI keyboard tutorial (web/js/views/beta-keyboard.js).
// Serve web/ first:  python3 -m http.server 5317 -d web   (then: PORT=5317 node betakeyboard.mjs)
// navigator.requestMIDIAccess is replaced by a fake MIDIAccess whose input the test drives with midimessage
// events; the song (GET /api/items/m-b6xs990/musicxml) is a small fixture served by request interception;
// the page is opened through a tiny harness page (also intercepted), so the live DB is never touched.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const PORT = process.env.PORT || 5317;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/beta';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };

// ---- the fixture: 8 bars, two staves, C major, a pickup, a tie across the bar line, left-hand chords ----
const STEP = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const n = (m, d, { staff = 1, voice = 1, chord = false, tie = '', lyric = false } = {}) => m == null
  ? `<note><rest/><duration>${d}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`
  : `<note>${chord ? '<chord/>' : ''}<pitch><step>${STEP[m % 12]}</step><octave>${Math.floor(m / 12) - 1}</octave></pitch><duration>${d}</duration>${tie.split(',').filter(Boolean).map((t) => `<tie type="${t}"/>`).join('')}<voice>${voice}</voice><staff>${staff}</staff>${lyric ? '<lyric><text>FIXTURELYRIC</text></lyric>' : ''}</note>`;
const back = (d) => `<backup><duration>${d}</duration></backup>`;
const lhChord = (ms, d) => ms.map((m, i) => n(m, d, { staff: 2, voice: 2, chord: i > 0 })).join('');
// divisions 2: quarter = 2, eighth = 1
const bars = [
  n(null, 4) + n(null, 1) + n(76, 1, { lyric: true }) + n(74, 1) + n(72, 1) + back(8) + n(null, 8, { staff: 2, voice: 2 }),
  n(74, 2) + n(72, 2) + n(72, 2) + n(74, 1) + n(76, 1, { tie: 'start' }) + back(8) + lhChord([60, 64], 4) + n(null, 4, { staff: 2, voice: 2 }),
  n(76, 4, { tie: 'stop' }) + n(79, 2) + n(76, 2) + back(8) + lhChord([57, 60], 8),
  n(72, 2) + n(74, 2) + n(76, 2) + n(77, 2) + back(8) + lhChord([48], 8),
  n(79, 2) + n(81, 2) + n(79, 2) + n(77, 2) + back(8) + lhChord([53, 57], 8),
  n(76, 2) + n(74, 2) + n(72, 2) + n(74, 2) + back(8) + lhChord([48], 8),
  n(76, 2) + n(76, 2) + n(74, 2) + n(74, 2) + back(8) + lhChord([55, 59], 8),
  n(72, 8) + back(8) + lhChord([48, 52], 8),
  n(79, 8) + back(8) + lhChord([48], 8), // bar 9: outside the excerpt
];
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><work><work-title>Home NDP</work-title></work>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${bars.map((b, i) => `<measure number="${i + 1}">${i ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>114</per-minute></metronome></direction-type><sound tempo="114"/></direction>'}${b}</measure>`).join('')}</part></score-partwise>`;
const MELODY = [76, 74, 72, 74, 72, 72, 74, 76, 79, 76, 72, 74, 76, 77, 79, 81, 79, 77, 76, 74, 72, 74, 76, 76, 74, 74, 72];

const HARNESS = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Keyboard (beta)</title><link rel="stylesheet" href="css/app.css"></head><body style="overflow:auto">
<main id="main" tabindex="-1" style="height:auto;min-height:100vh;overflow:visible"></main><div id="toast" class="toast" hidden></div>
<script type="module">import './js/device.js'; import { render } from './js/views/beta-keyboard.js';
window.__cleanup = render(document.getElementById('main'), { parts: ['beta-keyboard'], q: new URLSearchParams() }); window.__ready = true;</script></body></html>`;

// the fake Web MIDI (before any page script); __midiMode: 'ok' | 'deny' | 'none' | 'unsupported'
const FAKE_MIDI = () => {
  const mode = sessionStorage.getItem('__midiMode') || 'ok';
  if (mode === 'unsupported') { delete Navigator.prototype.requestMIDIAccess; delete navigator.requestMIDIAccess; return; }
  window.__midi = { input: null, asked: 0 };
  navigator.requestMIDIAccess = async () => {
    window.__midi.asked++;
    if (mode === 'deny') throw new DOMException('Permission denied', 'SecurityError');
    const access = new EventTarget(), input = new EventTarget();
    Object.assign(input, { id: 'in-1', name: 'Digital Keyboard', manufacturer: 'Yamaha', state: 'connected', type: 'input', connection: 'open', open: async () => input });
    access.inputs = new Map(mode === 'none' ? [] : [['in-1', input]]); access.outputs = new Map(); access.sysexEnabled = false;
    window.__midi.input = input; window.__midi.access = access;
    return access;
  };
  window.__note = (m, v = 100) => { const e = new Event('midimessage'); e.data = new Uint8Array([v ? 0x90 : 0x80, m, v]); window.__midi.input.dispatchEvent(e); };
  window.__tap = (m, ms = 120) => { window.__note(m, 100); setTimeout(() => window.__note(m, 0), ms); };
};

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const writes = [];
async function open({ mode = 'ok', viewport = { width: 1366, height: 900 }, clear = true, ua } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (ua) await page.setUserAgent(ua);
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url || '')) errors.push(m.text() + ' ' + (m.location()?.url || '')); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && r.method() !== 'GET') writes.push(r.method() + ' ' + u.pathname);
    if (u.pathname === '/__beta.html') return r.respond({ status: 200, contentType: 'text/html', body: HARNESS });
    if (u.pathname === '/api/items/m-b6xs990/musicxml') return r.respond({ status: 200, contentType: 'application/vnd.recordare.musicxml+xml', body: FIXTURE });
    if (u.pathname.startsWith('/api/')) return r.respond({ status: 404, contentType: 'application/json', body: '{}' });
    r.continue();
  });
  await page.evaluateOnNewDocument((m) => sessionStorage.setItem('__midiMode', m), mode);
  await page.evaluateOnNewDocument(FAKE_MIDI);
  await page.goto(ORIGIN + '/__beta.html', { waitUntil: 'networkidle0' });
  if (clear) { await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle0' }); }
  await page.waitForFunction(() => window.__ready);
  return { page, errors };
}
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s*\n\s*/g, '').trim()).catch(() => '');
const has = (page, sel) => page.$(sel).then(Boolean);
const PCS = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const midiOfName = (s) => 72 + PCS[s];
const tap = async (page, m) => { await page.evaluate((m) => window.__tap(m), m); await sleep(160); };
const next = async (page) => { await page.$eval('#bk-next', (b) => b.click()); await sleep(250); };

// =============== Mac, Chrome, a keyboard plugged in ===============
const { page, errors } = await open();
console.log('Page');
check('title is Keyboard (beta)', (await txt(page, '.top h1')) === 'Keyboard (beta)');
check('7 progress dots, step 1 is Connect', (await page.$$eval('.bk-dot', (d) => d.length)) === 7 && (await txt(page, '#bk-title')) === '1 · Connect');
check('every step has a Try it area and a tip', (await has(page, '.bk-try #bk-live')) && (await txt(page, '#bk-tip')).startsWith('Tip'));

console.log('0 Connect');
if (await has(page, '#bk-connect')) await page.click('#bk-connect');
await page.waitForSelector('#bk-dev', { timeout: 3000 }).catch(() => {});
check('shows "Connected: Digital Keyboard"', (await txt(page, '#bk-dev')) === 'Connected: Digital Keyboard', await txt(page, '#bk-conn'));
await page.evaluate(() => window.__note(64, 90)); await sleep(80);
check('a key press lights the on-screen key', await has(page, '.bk-key.down[data-m="64"]'));
check('…and shows the note name', (await txt(page, '#bk-last b')) === 'E4' && (await txt(page, '#bk-last')).includes('velocity 90'));
await page.evaluate(() => window.__note(64, 0)); await sleep(80);
check('note off clears the key', !(await has(page, '.bk-key.down')));
await page.evaluate(() => { window.__note(60); window.__note(64); window.__note(67); }); await sleep(80);
check('a held chord is named', (await txt(page, '#bk-chord')).includes('C chord'), await txt(page, '#bk-chord'));
await page.evaluate(() => { window.__note(60, 0); window.__note(64, 0); window.__note(67, 0); });
check('the Connect dot is done', await has(page, '.bk-dot.done[data-i="0"]'));
check('App sound toggle is there (on)', await page.$eval('#bk-sound', (e) => e.checked));
await page.screenshot({ path: `${SHOTS}/mac-0-connect.png` });

console.log('1 Find the notes');
await next(page);
await page.waitForSelector('#bk-want');
check('teaches the key: C major', (await txt(page, '#bk-live')).includes('C major'));
check('asks "Play C" first', (await txt(page, '#bk-ask')) === 'Play C');
await tap(page, 65);
check('a wrong key goes red and says where C is', (await txt(page, '#bk-msg')).includes('C is the white key just left of the two black keys'));
const asked = [];
for (let i = 0; i < 8 && (await has(page, '#bk-want')); i++) {
  const w = await txt(page, '#bk-want'); asked.push(w);
  await page.evaluate((m) => window.__note(m), midiOfName(w)); await sleep(60);
  if (i === 0) check('the right key goes green', await has(page, `.bk-key.ok[data-m="${midiOfName(w)}"]`));
  await page.evaluate((m) => window.__note(m, 0), midiOfName(w)); await sleep(420);
}
check('asks C, E, G then the song’s other notes', asked.join(' ') === 'C E G D F A', asked.join(' '));
check('all found; the song’s notes are marked on the keys', (await txt(page, '#bk-ask')).includes('All 6 found') && (await page.$$eval('.bk-key.map', (k) => k.length)) > 0);

console.log('2 Play along (wait mode)');
await next(page);
await page.waitForSelector('#bk-stripbox .bk-note');
check('strip shows bars 1–8 only', (await page.$$eval('.bk-bar', (b) => b.length)) === 8 && (await page.$$eval('.bk-note', (b) => b.length)) === MELODY.length, await page.$$eval('.bk-note', (b) => b.length));
check('the tie across bars 2–3 is one note', (await page.$$eval('.bk-bar[data-bar="2"] .bk-note', (b) => b.length)) === 2);
check('waits on the first note (E)', (await txt(page, '#bk-want')) === 'E' && (await has(page, '.bk-note.cur[data-i="0"]')));
await tap(page, 76);
check('right note: it turns green and moves on', (await has(page, '.bk-note.ok[data-i="0"]')) && (await has(page, '.bk-note.cur[data-i="1"]')) && (await txt(page, '#bk-want')) === 'D');
await tap(page, 65);
check('wrong note flashes red and names the expected note', (await txt(page, '#bk-msg')).includes('That was F') && (await txt(page, '#bk-msg')).includes('Expected D') && (await has(page, '.bk-note.cur[data-i="1"]')));
await page.click('#bk-hint'); await sleep(60);
check('Hint lights the target key', await has(page, '.bk-key.hint[data-m="74"]'));
await tap(page, 62); // D in another octave: any octave counts (on by default)
check('any octave counts', await has(page, '.bk-note.cur[data-i="2"]') && await has(page, '.bk-note.fixed[data-i="1"]'));
for (const m of MELODY.slice(2)) { await page.evaluate((m) => window.__tap(m, 40), m); await sleep(70); }
await page.waitForSelector('#bk-score', { timeout: 3000 }).catch(() => {});
const score = await txt(page, '#bk-score');
check('score at the end: notes, mistakes, time', score.includes(`${MELODY.length}notes`) && score.includes('1mistakes') && /\d:\d\dtime/.test(score), score);
await page.click('#bk-lh'); await sleep(150);
check('Left hand chords: off by default, adds chord chips', (await page.$$eval('.bk-lh', (c) => c.length)) === 7);
for (const m of [76, 74, 72]) await tap(page, m);
check('with the left hand the step asks melody + chord', (await txt(page, '#bk-want')) === 'D + C + E', await txt(page, '#bk-want'));
await tap(page, 74);
check('…and waits until the chord is played too', await has(page, '.bk-note.cur[data-i="3"]'));
await page.evaluate(() => { window.__tap(60); window.__tap(64); }); await sleep(200);
check('…then moves on', await has(page, '.bk-note.cur[data-i="4"]'));
await page.click('#bk-lh'); await sleep(100);
await page.screenshot({ path: `${SHOTS}/mac-2-wait.png` });

console.log('3 Play in time');
await next(page);
await page.waitForSelector('#bk-go');
await page.$eval('#bk-tempo', (e) => { e.value = 100; e.dispatchEvent(new Event('input')); });
check('tempo slider shows the BPM', (await txt(page, '#bk-bpm')) === '100 BPM');
await page.click('#bk-go'); await sleep(100);
check('count-in shows', /^[1-4]$/.test(await txt(page, '#bk-countin')), await txt(page, '#bk-countin'));
// first three notes at beats 2.5, 3, 3.5: on time, late by 0.35 beat, early by 0.3 beat
await page.evaluate(() => new Promise((ok) => {
  const s = document.querySelector('.bk-strip'), t0 = +s.dataset.t0, spb = +s.dataset.spb * 1000;
  const at = (beat, m) => setTimeout(() => window.__tap(m, 60), t0 + beat * spb - performance.now());
  at(2.5, 76); at(3.35, 74); at(3.25, 30); // 30: a stray wrong note
  at(3.5 - 0.3, 72);
  setTimeout(ok, t0 + 4 * spb - performance.now());
}));
await page.click('#bk-go'); await sleep(150);
const ts = await txt(page, '#bk-score');
check('scores timing: on time / late / early', ts.startsWith('1on time1early1late') && ts.includes('1wrong notes'), ts);
check('the notes are marked', (await has(page, '.bk-note.ok[data-i="0"]')) && (await has(page, '.bk-note.late[data-i="1"]')) && (await has(page, '.bk-note.early[data-i="2"]')));

console.log('4 Echo');
await next(page);
await page.waitForSelector('#bk-listen');
check('one bar, notes hidden', (await txt(page, '#bk-barname')) === 'Bar 1' && (await page.$$eval('.bk-note.hidden', (c) => c.length)) === 3);
await page.click('#bk-listen');
await page.waitForFunction(() => /Your turn/.test(document.querySelector('#bk-msg')?.textContent || ''), { timeout: 8000 }).catch(() => {});
check('Listen plays the bar, then "Your turn"', (await txt(page, '#bk-msg')).includes('Your turn'), await txt(page, '#bk-msg'));
for (const m of [76, 77, 72]) await tap(page, m);
await page.waitForSelector('#bk-cmp', { timeout: 3000 }).catch(() => {});
check('compares note by note (✓ ✗ ✓)', (await page.$$eval('#bk-cmp tr:last-child td', (t) => t.map((x) => x.className).join(' '))) === 'ok mark wrong mark ok mark');
check('says 2 of 3 matched and reveals the notes', (await txt(page, '#bk-matched')) === '2 of 3 notes matched.' && !(await has(page, '.bk-note.hidden')));
await page.screenshot({ path: `${SHOTS}/mac-4-echo.png` });
await page.click('#bk-retry'); await sleep(100);
for (const m of [76, 74]) await tap(page, m);
await page.click('#bk-check'); await sleep(100);
check('Check with a missed note', (await page.$$eval('#bk-cmp tr:last-child td', (t) => t.map((x) => x.className).join(' '))) === 'ok mark ok mark missed mark');

console.log('5 Record');
await next(page);
await page.waitForSelector('#bk-rec');
check('quantize 1/8 by default; save is "coming later"', (await page.$eval('#bk-quant', (s) => s.value)) === '0.5' && (await page.$eval('#bk-save', (b) => b.disabled)) && (await txt(page, '#bk-live')).includes('Coming later'));
await page.$eval('#bk-rtempo', (e) => { e.value = 120; e.dispatchEvent(new Event('input')); });
await page.click('#bk-rec'); await sleep(50);
await page.evaluate(() => new Promise((ok) => {
  const s = (ms, f) => setTimeout(f, ms);
  s(0, () => window.__note(60)); s(200, () => window.__note(60, 0));
  s(300, () => window.__note(62)); s(500, () => window.__note(62, 0));
  s(1000, () => window.__note(64)); s(1500, () => window.__note(64, 0));
  s(1600, ok);
}));
await page.click('#bk-rec');
await page.waitForSelector('#bk-osmd svg', { timeout: 8000 }).catch(() => {});
const evs = () => page.$$eval('#bk-notes .bk-chip', (c) => c.map((x) => `${x.dataset.n}@${x.dataset.q}:${x.dataset.d}`).join(' '));
check('captured notes on a 1/8 grid', (await evs()) === '60@0:0.5 62@0.5:0.5 64@2:1', await evs());
check('shown as a little score (OSMD)', await has(page, '#bk-osmd svg'));
check('Play back is ready', !(await page.$eval('#bk-play', (b) => b.disabled)));
await page.screenshot({ path: `${SHOTS}/mac-5-record.png` });
await page.select('#bk-quant', '1'); await sleep(400);
check('quantize 1/4 re-snaps', (await evs()) === '60@0:1 62@1:1 64@2:1', await evs());
await page.select('#bk-quant', '0.5'); await sleep(300);
await page.click('#bk-play'); await sleep(300);
check('playback runs', (await txt(page, '#bk-play')).includes('Stop'));
await page.click('#bk-play');

console.log('6 Fix a note by playing');
await next(page);
await page.waitForSelector('#bk-stripbox .bk-note');
check('a copy of bar 1; note 1 picked', (await page.$$eval('.bk-note', (c) => c.length)) === 3 && (await has(page, '.bk-note.sel[data-i="0"]')) && (await txt(page, '#bk-live')).includes('Edit notes'));
await tap(page, 79);
check('a key changes the note’s pitch', (await txt(page, '#bk-changed')) === 'G5' && (await txt(page, '.bk-note[data-i="0"]')) === 'G' && (await has(page, '.bk-note.changed[data-i="0"]')));
await page.click('.bk-note[data-i="2"]'); await sleep(80);
await tap(page, 71);
check('tap another note, play: it changes too', (await txt(page, '.bk-note[data-i="2"]')) === 'B');
await page.click('#bk-undo'); await sleep(80);
check('Undo all goes back', (await txt(page, '.bk-note[data-i="0"]')) === 'E' && !(await has(page, '.bk-note.changed')));
await page.waitForSelector('#bk-osmd svg', { timeout: 5000 }).catch(() => {});
check('bar drawn as a score', await has(page, '#bk-osmd svg'));

console.log('Progress');
const doneDots = await page.$$eval('.bk-dot.done', (d) => d.length);
check('every step done', doneDots === 7, doneDots);
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction(() => window.__ready); await sleep(200);
check('progress is remembered on this device', (await txt(page, '#bk-title')) === '7 · Fix a note by playing' && (await page.$$eval('.bk-dot.done', (d) => d.length)) === 7);
check('no lyric text on the page', !(await page.evaluate(() => document.body.innerText)).includes('FIXTURELYRIC'));
check('no writes to the server', writes.length === 0, writes.join(', '));
check('no page errors', errors.length === 0, errors.join('\n'));
await page.close();

// =============== no device / blocked ===============
console.log('No keyboard / blocked');
{
  const { page } = await open({ mode: 'none' });
  await page.click('#bk-connect'); await sleep(150);
  check('no device: friendly note', (await txt(page, '#bk-conn')).includes('No keyboard found'));
  await page.close();
}
{
  const { page } = await open({ mode: 'deny' });
  await page.click('#bk-connect'); await sleep(150);
  check('permission denied: how to allow it', (await txt(page, '.bk-state.bad')).includes('MIDI is blocked') && (await has(page, '#bk-connect')));
  await page.close();
}

// =============== no Web MIDI (iPad Safari): computer keys + on-screen keys ===============
console.log('Fallback (no Web MIDI)');
{
  const { page, errors } = await open({ mode: 'unsupported' });
  check('says this browser has no USB keyboard support', (await txt(page, '#bk-conn')).includes('can’t use a USB keyboard'));
  await page.keyboard.down('a'); await sleep(60);
  check('computer key A = C4', (await has(page, '.bk-key.down[data-m="60"]')) && (await txt(page, '#bk-last b')) === 'C4');
  await page.keyboard.up('a'); await page.keyboard.down('w'); await sleep(60);
  check('W = C#4 (black key)', (await has(page, '.bk-key.down[data-m="61"]')) && (await txt(page, '#bk-last b')) === 'C#4');
  await page.keyboard.up('w');
  await page.keyboard.press('x'); await page.keyboard.press('k'); await sleep(60);
  check('X = octave up (K = C6)', (await txt(page, '#bk-last b')) === 'C6' && (await txt(page, '#bk-oct')).includes('A = C5'));
  const box = await page.$eval('.bk-key[data-m="62"]', (k) => { const r = k.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height - 20 }; });
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await sleep(60);
  check('on-screen key: press lights it', (await has(page, '.bk-key.down[data-m="62"]')) && (await txt(page, '#bk-last b')) === 'D4');
  await page.mouse.up(); await sleep(60);
  check('on-screen key: release clears it', !(await has(page, '.bk-key.down')));
  await page.click('#bk-next'); await page.waitForSelector('#bk-want');
  await page.keyboard.press('x'); // A = C6 now
  await page.keyboard.press('z');
  await page.keyboard.press('k'); await sleep(600); // C6 → C (any octave)
  check('the tutorial works with computer keys', (await txt(page, '#bk-ask')) === 'Play E', await txt(page, '#bk-ask'));
  check('no page errors', errors.length === 0, errors.join('\n'));
  await page.close();
}

// =============== screenshots: iPad (touch, Safari: no Web MIDI) ===============
{
  const { page } = await open({ mode: 'unsupported', viewport: { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  check('iPad: device is tablet, bigger keys', (await page.evaluate(() => document.documentElement.dataset.device)) === 'tablet' && (await page.$eval('.bk-keys', (k) => k.offsetHeight)) >= 170);
  await page.screenshot({ path: `${SHOTS}/ipad-0-connect.png` });
  await page.click('#bk-next'); await sleep(200); await page.click('#bk-next'); await page.waitForSelector('.bk-note');
  await page.touchscreen.tap(...(await page.$eval('.bk-key[data-m="76"]', (k) => { const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height - 20]; })));
  await sleep(150);
  check('iPad: tapping the on-screen key plays along', await has(page, '.bk-note.ok[data-i="0"]'));
  await page.screenshot({ path: `${SHOTS}/ipad-2-wait.png` });
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
