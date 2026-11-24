// End-to-end: Keyboard (beta) — Connect + Fix notes by playing (web/js/views/beta-keyboard.js).
// Serve web/ first:  python3 -m http.server 5317 -d web   (then: PORT=5317 node betakeyboard.mjs)
// navigator.requestMIDIAccess is replaced by a fake MIDIAccess whose input the test drives with midimessage
// events; the song (GET /api/items/m-b6xs990/musicxml) is a small fixture served by request interception;
// the page is opened through a tiny harness page (also intercepted), so the live DB is never touched.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const PORT = process.env.PORT || 5317;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/beta2';
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
  // events with an exact timeStamp (the page measures holds from the event's own timeStamp)
  const at = (e, t) => { Object.defineProperty(e, 'timeStamp', { value: t }); return e; };
  window.__noteAt = (m, v, t) => { const e = new Event('midimessage'); e.data = new Uint8Array([v ? 0x90 : 0x80, m, v]); window.__midi.input.dispatchEvent(at(e, t)); };
  window.__holdMidi = (m, ms, t0 = performance.now()) => { window.__noteAt(m, 100, t0); window.__noteAt(m, 0, t0 + ms); };
  window.__holdScreen = (m, ms, t0 = performance.now()) => {
    const k = document.querySelector(`.bk-key[data-m="${m}"]`), o = { bubbles: true, cancelable: true, pointerId: 41, pointerType: 'touch', isPrimary: true };
    k.dispatchEvent(at(new PointerEvent('pointerdown', o), t0)); k.dispatchEvent(at(new PointerEvent('pointerup', o), t0 + ms));
  };
  window.__keyAt = (type, code, t, repeat = false) => document.body.dispatchEvent(at(new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), repeat, bubbles: true, cancelable: true }), t));
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
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s*\n\s*/g, ' ').trim()).catch(() => '');
const has = (page, sel) => page.$(sel).then(Boolean);
const tap = async (page, m, ms = 120) => { await page.evaluate((m, ms) => window.__tap(m, ms), m, ms); await sleep(ms + 80); };
// a bar of the strip as "m/t" items, e.g. "74/24 R/12"
const bar = (page, b) => page.$$eval(`.bk-bar2[data-bar="${b}"] .bk-it`, (xs) => xs.map((x) => `${x.dataset.m || 'R'}/${x.dataset.t}`).join(' '));
const selK = (page) => page.$eval('.bk-it.sel', (x) => x.dataset.k).catch(() => '');
// click below the sticky on-screen piano: bring the element to the middle first
const clk = async (page, sel) => { await page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' })); await page.click(sel); };
const pick = async (page, k) => { await clk(page, `.bk-it[data-k="${k}"]`); await sleep(60); };
const msg = (page) => txt(page, '#bk-msg');
const sums = (page) => page.$$eval('.bk-bar2', (bs) => bs.map((b) => [...b.querySelectorAll('.bk-it')].reduce((a, x) => a + +x.dataset.t, 0)));
const scoreDrawn = (page) => page.waitForFunction(() => document.querySelector('#bk-osmd svg') && document.querySelector('#bk-osmd .bk-on'), { timeout: 8000 }).then(() => true).catch(() => false);

// =============== Mac, Chrome, a keyboard plugged in ===============
const { page, errors } = await open();
console.log('Page');
check('title is Keyboard (beta)', (await txt(page, '.top h1')) === 'Keyboard (beta)');
check('two steps: Connect, Fix notes by playing', (await page.$$eval('.bk-dot', (d) => d.map((x) => x.textContent.trim()).join('|'))) === '1 Connect|2 Fix notes by playing');
const body0 = await page.evaluate(() => document.body.innerText);
check('the removed steps are gone', !/Find the notes|Play along|Play in time|Echo|Record/.test(body0));

console.log('1 Connect');
if (await has(page, '#bk-connect')) await page.click('#bk-connect');
await page.waitForSelector('#bk-dev', { timeout: 3000 }).catch(() => {});
check('shows "Connected: Digital Keyboard"', (await txt(page, '#bk-dev')) === 'Connected: Digital Keyboard', await txt(page, '#bk-conn'));
await page.evaluate(() => window.__note(64, 90)); await sleep(80);
check('a key press lights the on-screen key and names it', (await has(page, '.bk-key.down[data-m="64"]')) && (await txt(page, '#bk-last b')) === 'E4');
await page.evaluate(() => window.__note(64, 0)); await sleep(80);
check('note off clears the key', !(await has(page, '.bk-key.down')));
await page.screenshot({ path: `${SHOTS}/mac-1-connect.png` });

console.log('2 Fix notes by playing');
await page.click('#bk-go');
await page.waitForSelector('.bk-it');
check('8 bars of the melody in the strip', (await page.$$eval('.bk-bar2', (b) => b.length)) === 8);
check('bar 1: pickup rests drawn naturally (1/2 + 1/8), then E D C', (await bar(page, 0)) === 'R/48 R/12 76/12 74/12 72/12', await bar(page, 0));
check('a tie across bars 2–3 kept', (await bar(page, 1)) === '74/24 72/24 72/24 74/12 76/12' && (await has(page, '.bk-it.tie[data-k="1:4"]')) && (await bar(page, 2)) === '76/48 79/24 76/24');
check('first note picked', (await selK(page)) === '0:2');
check('the score is drawn with the picked note lit', await scoreDrawn(page));
check('4 tip cards', (await page.$$eval('.bk-tipc', (c) => c.length)) === 4 && (await has(page, '.bk-tipc.cur[data-k="select"]')));
check('length legend: C3 = 1 … G3 = 1/16, A3 = rest', /C3.*1.*D3.*1\/2.*E3.*1\/4.*F3.*1\/8.*G3.*1\/16.*A3.*Rest/.test(await txt(page, '#bk-legend')), await txt(page, '#bk-legend'));
check('length keys marked on the on-screen piano', (await page.$eval('.bk-key[data-m="50"] .bk-fn', (e) => e.textContent)) === '1/2');

console.log('Pitch');
await tap(page, 79);
check('a key changes the picked note (E5 → G5)', (await txt(page, '#bk-changed')) === 'G5' && (await page.$eval('.bk-it[data-k="0:2"]', (x) => x.dataset.m)) === '79');
check('…the next note is marked as next', await has(page, '.bk-it.next[data-k="0:3"]'));
await tap(page, 77);
check('the next key goes to the next note', (await page.$eval('.bk-it[data-k="0:3"]', (x) => x.dataset.m)) === '77' && (await selK(page)) === '0:3');
await page.keyboard.press('ArrowRight'); await sleep(60);
check('→ moves the selection', (await selK(page)) === '0:4');
await page.keyboard.press('ArrowLeft'); await sleep(60);
check('← moves it back', (await selK(page)) === '0:3');
await clk(page, '#bk-auto'); await sleep(40);
await tap(page, 76); await tap(page, 74);
check('auto-advance off: both keys go to the same note', (await page.$eval('.bk-it[data-k="0:3"]', (x) => x.dataset.m)) === '74' && (await selK(page)) === '0:3');
await clk(page, '#bk-auto'); await sleep(40);

console.log('Length: buttons, number keys');
await pick(page, '1:0');
await clk(page, '.bk-len[data-t="12"]'); await sleep(80);
check('1/8 button shortens; a rest fills the gap', (await bar(page, 1)) === '74/12 R/12 72/24 72/24 74/12 76/12' && /rest fills the gap/.test(await msg(page)), await bar(page, 1));
check('…the 1/8 button shows as on', await has(page, '.bk-len.on[data-t="12"]'));
await page.keyboard.press('2'); await sleep(80);
check('key 2 = half: lengthening borrows from the rest and the next note', (await bar(page, 1)) === '74/48 72/24 74/12 76/12' && /took the time from/.test(await msg(page)), (await bar(page, 1)) + ' · ' + (await msg(page)));
await pick(page, '1:3');
await page.keyboard.press('4'); await sleep(80);
check('overflow refused with a clear message', (await bar(page, 1)) === '74/48 72/24 74/12 76/12' && /doesn’t fit/.test(await msg(page)), await msg(page));
await page.screenshot({ path: `${SHOTS}/mac-2-refused.png` });
await pick(page, '1:1');
await page.keyboard.press('.'); await sleep(80);
check('. = dot: 1/4 → dotted 1/4 (borrows the 1/8 after it)', (await bar(page, 1)) === '74/48 72/36 76/12' && (await has(page, '#bk-dot.on')), await bar(page, 1));
await page.keyboard.press('.'); await sleep(80);
check('. again takes the dot off; a 1/8 rest fills', (await bar(page, 1)) === '74/48 72/24 R/12 76/12', await bar(page, 1));
await pick(page, '4:0');
await page.keyboard.press('1'); await sleep(80);
check('key 1 = whole: takes the whole bar', (await bar(page, 4)) === '79/96');
await page.keyboard.press('6'); await sleep(80);
check('key 6 = 1/16, rest split naturally (1/16 1/8 1/4 1/2)', (await bar(page, 4)) === '79/6 R/6 R/12 R/24 R/48', await bar(page, 4));
await pick(page, '3:0');
await page.keyboard.press('8'); await sleep(80);
check('shorten 1/4 → 1/8: rest after it', (await bar(page, 3)) === '72/12 R/12 74/24 76/24 77/24');
await clk(page, '#bk-pullnow'); await sleep(80);
check('"pull the next notes earlier" moves them; rests at the end of the bar', (await bar(page, 3)) === '72/12 74/24 76/24 77/24 R/12', await bar(page, 3));
await clk(page, '#bk-pull'); await sleep(40);
await pick(page, '3:2');
await clk(page, '.bk-len[data-t="12"]'); await sleep(80);
check('pull mode setting: shorter pulls the rest of the bar in', (await bar(page, 3)) === '72/12 74/24 76/12 77/24 R/24', await bar(page, 3));
await clk(page, '#bk-pull'); await sleep(40);

console.log('Rest');
await pick(page, '3:1');
await clk(page, '#bk-rest'); await sleep(80);
check('Rest button: the note becomes a rest (split on the beat)', (await bar(page, 3)) === '72/12 R/12 R/12 76/12 77/24 R/24', await bar(page, 3));
await pick(page, '3:3');
await page.keyboard.press('r'); await sleep(80);
check('R key: rest; neighbouring rests joined and re-split', (await bar(page, 3)) === '72/12 R/12 R/24 77/24 R/24', await bar(page, 3));

console.log('MIDI length keys');
await pick(page, '5:0');
await tap(page, 50);
check('D3 key = 1/2: length changes, pitch stays', (await bar(page, 5)) === '76/48 72/24 74/24' && (await selK(page)) === '5:0', await bar(page, 5));
await tap(page, 55);
check('G3 key = 1/16', (await bar(page, 5)).startsWith('76/6 R/6 R/12 R/24'), await bar(page, 5));
await tap(page, 49);
check('C#3 key = dot (1/16 → dotted 1/16)', (await bar(page, 5)).startsWith('76/9 '), await bar(page, 5));
await tap(page, 57);
check('A3 key = rest', (await page.$eval('.bk-it[data-k="5:0"]', (x) => x.dataset.m)) === '');
await page.select('#bk-fnbase', '36'); await sleep(60);
check('length keys can start elsewhere (C2)', /C2.*1/.test(await txt(page, '#bk-legend')) && (await page.$eval('.bk-key[data-m="50"] .bk-fn', (e) => e.textContent)) === '');
await page.select('#bk-fnbase', '48'); await sleep(60);
await clk(page, '#bk-fnon'); await sleep(40);
await pick(page, '6:0');
await tap(page, 50);
check('length keys off: low keys set the pitch', (await page.$eval('.bk-it[data-k="6:0"]', (x) => x.dataset.m)) === '50');
await clk(page, '#bk-fnon'); await sleep(40);

console.log('Hold to set length');
await clk(page, '#bk-hold'); await sleep(40);
await page.$eval('#bk-tempo', (r) => { r.value = '120'; r.dispatchEvent(new Event('input')); });
await pick(page, '7:0'); // C5 whole
await page.evaluate(() => window.__holdMidi(74, 1000)); await sleep(80); // 1 s at 120 BPM = 2 beats
check('held 1 s at 120 BPM → half note D5', (await bar(page, 7)) === '74/48 R/48', await bar(page, 7));
await page.evaluate(() => window.__holdMidi(76, 260)); await sleep(80); // next note (the rest) ≈ 1/8
check('next key held ≈ 0.25 s → eighth on the next note', (await bar(page, 7)) === '74/48 76/12 R/12 R/24', await bar(page, 7));
await clk(page, '#bk-hold'); await sleep(40);

console.log('Every bar still adds up');
const s = await sums(page);
check('all 8 bars = 4/4', s.every((x) => x === 96), s.join(','));

console.log('Undo / redo / reset');
const before = await bar(page, 7);
await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta'); await sleep(80);
check('⌘Z undoes the last change', (await bar(page, 7)) === '74/48 76/48', await bar(page, 7));
await clk(page, '#bk-undo'); await sleep(80);
check('Undo button undoes again', (await bar(page, 7)) === '74/48 R/48', await bar(page, 7));
await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta'); await sleep(80);
await clk(page, '#bk-redo'); await sleep(80);
check('⇧⌘Z and Redo bring both back', (await bar(page, 7)) === before, await bar(page, 7));
await page.screenshot({ path: `${SHOTS}/mac-2-edited.png` });
await clk(page, '#bk-reset'); await sleep(120);
check('Reset restores the original', (await bar(page, 0)) === 'R/48 R/12 76/12 74/12 72/12' && (await bar(page, 1)) === '74/24 72/24 72/24 74/12 76/12' && !(await has(page, '.bk-it.changed')) && (await page.$eval('#bk-reset', (b) => b.disabled)));
await clk(page, '#bk-undo'); await sleep(80);
check('…and Undo after Reset brings the changes back', (await bar(page, 7)) === before);

console.log('Play back');
await clk(page, '#bk-play'); await sleep(400);
check('Play these bars plays the in-memory copy', (await txt(page, '#bk-play')).includes('Stop') && +(await page.$eval('#bk-live', (e) => e.dataset.played)) > 10);
await clk(page, '#bk-play'); await sleep(60);
check('…and stops', (await txt(page, '#bk-play')).includes('Play these bars'));
check('all 4 tips done', (await page.$$eval('.bk-tipc.done', (c) => c.length)) === 4 && (await has(page, '.bk-dot.done[data-i="1"]')));

console.log('Score');
await pick(page, '2:1');
check('picking a note re-lights it in the score', await scoreDrawn(page));
const scoreK = await page.$$eval('#bk-osmd .bk-hit', (g) => g.map((x) => x.dataset.k));
const hitBox = await page.$eval('#bk-osmd .bk-hit[data-k="2:2"]', (g) => { const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).catch(() => null);
if (hitBox) { await page.mouse.click(hitBox.x, hitBox.y); await sleep(80); }
check('clicking a note in the score selects it', hitBox && (await selK(page)) === '2:2', scoreK.slice(0, 12).join(' '));
await page.$eval(".bk-toolbar", (e) => e.scrollIntoView()); await page.screenshot({ path: `${SHOTS}/mac-2-fix.png` });

await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction(() => window.__ready); await page.waitForSelector('.bk-it');
check('reload: step remembered, the copy starts from the original (nothing saved)', (await txt(page, '#bk-title')) === '2 · Fix notes by playing' && (await bar(page, 0)) === 'R/48 R/12 76/12 74/12 72/12');
check('no lyric text on the page', !(await page.evaluate(() => document.body.innerText)).includes('FIXTURELYRIC'));
check('no writes to the server', writes.length === 0, writes.join(', '));
check('no page errors', errors.length === 0, errors.join('\n'));
await page.close();

// =============== hold to set length: exact timing ===============
console.log('Hold to set length: timing');
{
  const { page, errors } = await open();
  if (await has(page, '#bk-connect')) await page.click('#bk-connect');
  await page.waitForSelector('#bk-dev', { timeout: 3000 }).catch(() => {});
  await page.click('#bk-go'); await page.waitForSelector('.bk-it');
  await clk(page, '#bk-hold'); await sleep(40);
  check('hold mode: tempo defaults to 60 BPM, the bar and options show', (await txt(page, '#bk-bpm')) === '60 BPM' && !(await page.$eval('#bk-holdbox', (b) => b.hidden)));
  check('ticks at 1/16 1/8 1/4 1/2 1', (await page.$$eval('#bk-hticks i', (t) => t.map((x) => x.textContent).join(' '))) === '1/16 1/8 1/4 1/2 1');
  await clk(page, '#bk-auto'); await sleep(40); // every key goes to the same note: bar 8's whole C5
  await pick(page, '7:0');
  const len = () => page.$eval('.bk-it[data-k="7:0"]', (x) => +x.dataset.t);
  const holdLen = async (how, ms) => { await page.evaluate((how, ms) => (how === 'screen' ? window.__holdScreen(72, ms) : window.__holdMidi(72, ms)), how, ms); await sleep(60); return len(); };
  const LAT = 25; // default release latency (ms)
  const TH = [[6, 12], [12, 24], [24, 48], [48, 96]].map(([a, b]) => [a, b, Math.sqrt((a / 24) * (b / 24))]);
  for (const bpmv of [60, 120]) {
    await page.$eval('#bk-tempo', (r, v) => { r.value = String(v); r.dispatchEvent(new Event('input')); }, bpmv);
    const beat = 60000 / bpmv;
    for (const [a, b, th] of TH) {
      const ms = th * beat + LAT;
      for (const how of ['midi', 'screen']) {
        const lo = await holdLen(how, ms - 8), hi = await holdLen(how, ms + 8);
        check(`${bpmv} BPM, ${how}: ${(ms / 1000).toFixed(3)} s is the ${a}→${b} switch point (geometric midpoint)`, lo === a && hi === b, `${lo} ${hi}`);
      }
    }
    check(`${bpmv} BPM: a very short hold is 1/16, a very long one a whole`, (await holdLen('midi', 40)) === 6 && (await holdLen('midi', beat * 9)) === 96);
  }
  await page.$eval('#bk-tempo', (r) => { r.value = '60'; r.dispatchEvent(new Event('input')); });
  check('judged by ratio: 0.37 beat → 1/8 (switch √(1/4·1/2) = 0.354, not the arithmetic 0.375); 0.34 → 1/16', (await holdLen('midi', 370 + LAT)) === 12 && (await holdLen('midi', 340 + LAT)) === 6);
  check('dotted off: 1.3 beats → plain 1/4', (await holdLen('midi', 1300 + LAT)) === 24);
  check('the read-out shows the beats and the length', (await txt(page, '#bk-hbeats')) === '1.30 beats' && /= quarter/.test(await txt(page, '#bk-hlen')), await txt(page, '#bk-hnow'));
  await clk(page, '#bk-holddot'); await sleep(40);
  check('dotted on: 1.3 beats → dotted 1/4; 1.15 beats → 1/4', (await holdLen('midi', 1300 + LAT)) === 36 && (await holdLen('midi', 1150 + LAT)) === 24);
  check('dotted on: 0.4 beat → dotted 1/16 (switch √(1/4·3/8) = 0.306)', (await holdLen('midi', 400 + LAT)) === 9);
  await clk(page, '#bk-holddot'); await sleep(40);

  console.log('Live bar while holding');
  await clk(page, '#bk-holdclick'); await sleep(40);
  await page.evaluate(() => window.__note(72, 100)); await sleep(650);
  const live = await page.evaluate(() => ({ on: document.querySelector('#bk-hbar').classList.contains('on'), w: parseFloat(document.querySelector('#bk-hfill').style.width), beats: parseFloat(document.querySelector('#bk-hbeats').textContent), t: +document.querySelector('#bk-hnow').dataset.t, ic: !!document.querySelector('#bk-hic svg') }));
  check('while holding: the bar grows, beats count up, the note icon shows the pick so far', live.on && live.w > 40 && live.beats > 0.5 && live.beats < 1.3 && [12, 24].includes(live.t) && live.ic, JSON.stringify(live));
  await page.$eval('#bk-holdbox', (e) => e.scrollIntoView({ block: 'center' })); await page.screenshot({ path: `${SHOTS}/mac-hold-live.png` });
  await page.evaluate(() => window.__note(72, 0)); await sleep(60);
  check('…released: the bar stops', !(await page.$eval('#bk-hbar', (b) => b.classList.contains('on'))));
  await clk(page, '#bk-holdclick'); await sleep(40);

  console.log('On-screen keys: pointer capture');
  await page.$eval('#bk-hbar', (e) => e.scrollIntoView({ block: 'center' }));
  const keyPt = (m) => page.$eval(`.bk-key[data-m="${m}"]`, (k) => { const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height - 14]; });
  const [x72, y72] = await keyPt(72), [x76, y76] = await keyPt(76);
  await page.mouse.move(x72, y72); await page.mouse.down();
  await page.mouse.move(x76, y76, { steps: 6 }); await sleep(40);
  const downs = await page.$$eval('.bk-key.down', (k) => k.map((x) => x.dataset.m).join(','));
  await page.mouse.move(x76, 40, { steps: 6 }); // off the piano, up over the page
  await sleep(500);
  await page.mouse.up(); await sleep(80);
  const heldMs = +(await page.$eval('#bk-live', (e) => e.dataset.holdMs));
  check('slide onto another key: still only the pressed key sounds', downs === '72', downs);
  check('slide off and release: the hold ends at the release (no stuck key), measured ≈ the real time', !(await has(page, '.bk-key.down')) && heldMs > 480 && heldMs < 900, String(heldMs));
  check('…and it set the length from that time (1/8 below 0.73 s, else 1/4)', (await len()) === ((heldMs - LAT) / 1000 < Math.SQRT1_2 ? 12 : 24) && (await page.$eval('.bk-it[data-k="7:0"]', (x) => x.dataset.m)) === '72', String(await len()));

  console.log('Computer keys: auto-repeat ignored');
  await page.evaluate(() => { const t0 = performance.now(); window.__keyAt('keydown', 'KeyD', t0); for (let k = 1; k <= 12; k++) window.__keyAt('keydown', 'KeyD', t0 + 300 + k * 33, true); window.__keyAt('keyup', 'KeyD', t0 + 1525); });
  await sleep(80);
  check('held D 1.5 s with auto-repeat → one note E4, a half (1.5 beats)', (await page.$eval('.bk-it[data-k="7:0"]', (x) => x.dataset.m)) === '64' && (await len()) === 48 && /held 1\.5\d s = 1\.50 beats/.test(await msg(page)), (await len()) + ' ' + (await msg(page)));
  check('…repeats did not restart the hold or move on', (await selK(page)) === '7:0' && !(await has(page, '.bk-key.down')));

  console.log('Calibration');
  const sw = () => page.$eval('#bk-holdhelp [data-th="2"]', (e) => e.textContent);
  check('before: 0.6 s → 1/8; 1/4→1/2 switch at 1.44 s', (await holdLen('midi', 600)) === 12 && (await sw()) === '1.44 s', await sw());
  await clk(page, '#bk-cal'); await sleep(40);
  check('Calibrate asks for 4 quarter notes', /4 quarter notes/.test(await txt(page, '#bk-calbox')) && (await txt(page, '#bk-cal')) === 'Cancel');
  const before7 = await bar(page, 7);
  await page.evaluate(() => { const t0 = performance.now(); for (let k = 0; k < 4; k++) window.__holdMidi(67, 800, t0 + k * 1000); }); // released 0.2 s early each time
  await sleep(80);
  const c1 = await page.evaluate(() => JSON.parse(localStorage.getItem('meowsic-beta-keyboard-cal')));
  check('4 holds of 0.8 s on a 1 s beat → latency −200 ms, stretch 1, saved on the device', c1 && c1.latency === -200 && c1.stretch === 1 && /Calibrated/.test(await txt(page, '#bk-calbox')), JSON.stringify(c1));
  check('calibrating did not edit the notes', (await bar(page, 7)) === before7);
  check('after: the switch points move (1/4→1/2 now at 1.21 s), 0.6 s now reads as 1/4', (await sw()) === '1.21 s' && (await holdLen('midi', 600)) === 24, await sw());
  await clk(page, '#bk-cal'); await sleep(40);
  await page.evaluate(() => { const t0 = performance.now(); for (let k = 0; k < 4; k++) window.__holdMidi(67, 1100, t0 + k * 1100); }); // a slower beat, legato
  await sleep(80);
  const c2 = await page.evaluate(() => JSON.parse(localStorage.getItem('meowsic-beta-keyboard-cal')));
  check('a slow, legato player → latency 0, stretch 0.91; 1/4→1/2 at 1.56 s', c2.latency === 0 && Math.abs(c2.stretch - 0.909) < 0.002 && (await sw()) === '1.56 s', JSON.stringify(c2) + ' ' + (await sw()));
  await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction(() => window.__ready); await page.waitForSelector('.bk-it');
  check('calibration kept after reload', (await sw()) === '1.56 s', await sw());
  await clk(page, '#bk-calreset'); await sleep(40);
  check('Reset calibration → default', (await sw()) === '1.44 s' && !(await page.evaluate(() => localStorage.getItem('meowsic-beta-keyboard-cal'))));
  await page.evaluate(() => { localStorage.setItem('meowsic-beta-keyboard-cal', '{bad json'); });
  await page.reload({ waitUntil: 'networkidle0' }); await page.waitForFunction(() => window.__ready); await page.waitForSelector('.bk-it');
  check('a broken saved calibration falls back to the default', (await sw()) === '1.44 s');
  check('no page errors', errors.length === 0, errors.join('\n'));
  await page.close();
}

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

// =============== no Web MIDI: computer keys ===============
console.log('Fallback (no Web MIDI)');
{
  const { page, errors } = await open({ mode: 'unsupported' });
  check('says this browser has no USB keyboard support', (await txt(page, '#bk-conn')).includes('can’t use a USB keyboard'));
  await page.keyboard.down('a'); await sleep(60);
  check('computer key A = C4', (await has(page, '.bk-key.down[data-m="60"]')) && (await txt(page, '#bk-last b')) === 'C4');
  await page.keyboard.up('a');
  await page.click('#bk-go'); await page.waitForSelector('.bk-it');
  await page.keyboard.press('x'); await page.keyboard.press('h'); await sleep(100); // A5
  check('computer keys set the pitch', (await page.$eval('.bk-it[data-k="0:2"]', (x) => x.dataset.m)) === '81');
  check('no page errors', errors.length === 0, errors.join('\n'));
  await page.close();
}

// =============== iPad (touch, Safari: no Web MIDI): on-screen keys ===============
console.log('iPad');
{
  const { page, errors } = await open({ mode: 'unsupported', viewport: { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  check('iPad: says use the on-screen keys', (await txt(page, '#bk-conn')).includes('use the on-screen keys'));
  await page.touchscreen.tap(...(await page.$eval('.bk-dot[data-i="1"]', (k) => { const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
  await page.waitForSelector('.bk-it');
  const keyAt = (m) => page.$eval(`.bk-key[data-m="${m}"]`, (k) => { const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height - 20]; });
  await page.touchscreen.tap(...(await keyAt(77))); await sleep(150);
  check('iPad: tapping an on-screen key sets the pitch', (await page.$eval('.bk-it[data-k="0:2"]', (x) => x.dataset.m)) === '77');
  await page.touchscreen.tap(...(await keyAt(50))); await sleep(150);
  check('iPad: on-screen length key (D3 = 1/2) works', (await page.$eval('.bk-it[data-k="0:2"]', (x) => x.dataset.t)) === '12' && /doesn’t fit/.test(await msg(page)), await msg(page));
  await page.touchscreen.tap(...(await page.$eval('.bk-len[data-t="6"]', (k) => { k.scrollIntoView({ block: 'center' }); const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }))); await sleep(150);
  check('iPad: length buttons by touch', (await bar(page, 0)) === 'R/48 R/12 77/6 R/6 74/12 72/12', await bar(page, 0));
  check('iPad: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await scoreDrawn(page);
  await page.$eval(".bk-tips", (e) => e.scrollIntoView()); await page.screenshot({ path: `${SHOTS}/ipad-fix.png` });
  check('no page errors', errors.length === 0, errors.join('\n'));
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
