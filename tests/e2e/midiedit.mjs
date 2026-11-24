// Edit notes + a MIDI keyboard (web/js/midiedit.js), against a test server (BASE, a scratchpad data folder — never
// the real library). navigator.requestMIDIAccess is replaced by a fake MIDIAccess whose input the test drives with
// midimessage events. A made-up 64-bar piano score:
//   Mac: the 🎹 chip shows by itself → a right-hand note and a left-hand note take the key played → a rest becomes
//   a note → two keys at once make a chord → Undo → the low length keys → "Next note" walks on, across a bar line →
//   hold to set length → the options sheet (remembered per keyboard);
//   iPad (touch, paged, fake MIDI): "Next note" from the last note of page 1 turns the page;
//   no Web MIDI (iPad / iPhone Safari): no chip, nothing attached.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5391/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/midiedit';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const stamp = Date.now().toString(36);

// ---- the score: 24 bars; right hand quarters (bar 1: C5, a rest, E5 half), left hand half notes ----
const STEP = { 0: ['C', 0], 2: ['D', 0], 4: ['E', 0], 5: ['F', 0], 7: ['G', 0], 9: ['A', 0], 11: ['B', 0] };
const n = (m, q, staff) => m == null ? `<note><rest/><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${{ 1: 'quarter', 2: 'half' }[q]}</type><staff>${staff}</staff></note>`
  : `<note><pitch><step>${STEP[m % 12][0]}</step><octave>${Math.floor(m / 12) - 1}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${{ 1: 'quarter', 2: 'half' }[q]}</type><staff>${staff}</staff></note>`;
const MEL = [72, 74, 76, 77, 79, 77, 76, 74];
const RH = (k) => (k === 0 ? [[72, 1], [null, 1], [76, 2]] : [0, 1, 2, 3].map((i) => [MEL[(k + i) % 8], 1]));
const LH = (k) => [[k % 2 ? 43 : 48, 2], [55, 2]];
const BARS = 64;
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + Array.from({ length: BARS }, (_, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type><sound tempo="100"/></direction>'}`
    + RH(k).map(([m, q]) => n(m, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH(k).map(([m, q]) => n(m, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';

const FAKE_MIDI = () => {
  const mode = sessionStorage.getItem('__midiMode') || 'ok';
  if (mode === 'unsupported') { delete Navigator.prototype.requestMIDIAccess; delete navigator.requestMIDIAccess; return; }
  window.__midi = { input: null, asked: 0 };
  navigator.requestMIDIAccess = async () => {
    window.__midi.asked++;
    const access = new EventTarget(), input = new EventTarget();
    Object.assign(input, { id: 'in-1', name: 'Digital Keyboard', manufacturer: 'Yamaha', state: 'connected', type: 'input', connection: 'open', open: async () => input });
    access.inputs = new Map([['in-1', input]]); access.outputs = new Map(); access.sysexEnabled = false;
    window.__midi.input = input; window.__midi.access = access;
    return access;
  };
  const at = (e, t) => { Object.defineProperty(e, 'timeStamp', { value: t }); return e; };
  window.__noteAt = (m, v, t = performance.now()) => { const e = new Event('midimessage'); e.data = new Uint8Array([v ? 0x90 : 0x80, m, v]); window.__midi.input.dispatchEvent(at(e, t)); };
  window.__tap = (ms, len = 120) => { const t = performance.now(); for (const m of [].concat(ms)) window.__noteAt(m, 100, t); setTimeout(() => { for (const m of [].concat(ms)) window.__noteAt(m, 0, t + len); }, len); };
  window.__hold = (m, len) => { const t = performance.now(); window.__noteAt(m, 100, t); window.__noteAt(m, 0, t + len); };
};

async function open(vp, mode = 'ok') {
  const title = `Played in ${stamp} ${mode} ${vp.width}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title), tags: ['Kids'] });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(m.text()));
  await page.evaluateOnNewDocument((m) => { sessionStorage.setItem('__midiMode', m); try { localStorage.removeItem('meowsic-midiedit'); } catch {} }, mode);
  await page.evaluateOnNewDocument(FAKE_MIDI);
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(700);
  return { page, sc };
}
const helpers = (page) => {
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { await sleep(120); await EN(() => window.__midiEdit?.idle); for (let i = 0; i < 60; i++) { if (!(await EN(() => window.__editNotes.busy))) break; await sleep(100); } await sleep(250); };
  const find = (pred) => EN((src) => window.__editNotes.notes.filter(new Function('n', `return (${src})(n)`)).map((n) => n.ref), pred.toString());
  const note = (pred) => EN((src) => window.__editNotes.notes.find(new Function('n', `return (${src})(n)`)) || null, pred.toString());
  const selNotes = () => EN(() => { const s = new Set(window.__editNotes.sel); return window.__editNotes.notes.filter((n) => s.has(n.ref)); });
  const pick = async (pred) => { const r = await find(pred); await EN((refs) => window.__editNotes.select(refs), r); await sleep(100); return r; };
  const tap = async (ms, len) => { await EN((a, l) => window.__tap(a, l), ms, len); await sleep((len || 120) + 80); await idle(); };
  return { EN, idle, find, note, selNotes, pick, tap };
};
const full = (notes) => {
  const sum = {};
  for (const x of notes) { const k = `${x.bar}|${x.staff}|${x.voice}|${x.on}`; sum[k] = Math.max(sum[k] || 0, x.dur); }
  const per = {};
  for (const [k, d] of Object.entries(sum)) { const [bar, st, v] = k.split('|'); per[`${bar}|${st}|${v}`] = (per[`${bar}|${st}|${v}`] || 0) + d; }
  return Object.values(per).every((v) => Math.abs(v - 4) < 1e-6);
};

// ---------------- Mac ----------------
console.log('\nMac');
{
  const { page } = await open(MAC);
  const { EN, idle, note, selNotes, pick, tap } = helpers(page);
  await page.waitForSelector('.np-midi', { timeout: 5000 }).catch(() => {});
  const chip = await page.$eval('.np-midi', (e) => e.textContent.trim()).catch(() => '');
  check('connects by itself: 🎹 chip with the keyboard name', chip === '🎹 Digital Keyboard', chip);
  check('asked Chrome for MIDI once', (await EN(() => window.__midi.asked)) === 1);
  const o = await EN(() => window.__midiEdit.opts);
  check('defaults: next note on, length keys from C3, hold off, sound on', o.auto && o.fnOn && o.fnBase === 48 && !o.hold && o.sound, JSON.stringify(o));
  await EN(() => window.__midiEdit.setOpts({ auto: false }));
  await page.screenshot({ path: `${SHOTS}/mac-chip.png` });

  // right hand: bar 1's C5 → D5
  await pick((n) => n.bar === 0 && n.staff === 1 && n.on === 0);
  await tap(74);
  let x = await note((n) => n.bar === 0 && n.staff === 1 && n.on === 0);
  check('right hand: the note takes the key (D5)', x?.midi === 74 && x.dur === 1, JSON.stringify(x));
  check('one editor step (undoable)', (await EN(() => window.__editNotes.step)) === 1);
  check('the play cue moved to the edit', (await EN(() => window.__editNotes.cueBar)) === 1);
  // left hand: bar 2's G2 → A2
  await pick((n) => n.bar === 1 && n.staff === 2 && n.on === 0);
  await tap(45);
  x = await note((n) => n.bar === 1 && n.staff === 2 && n.on === 0);
  check('left hand: the note takes the key (A2)', x?.midi === 45 && x.dur === 2, JSON.stringify(x));
  // a black key in C major: B flat, spelled with a flat
  await pick((n) => n.bar === 2 && n.staff === 1 && n.on === 1);
  await tap(70);
  const xml = await EN(() => window.__editNotes.xml);
  check('B♭ spelled as a flat in C major', /<step>B<\/step>\s*<alter>-1<\/alter>/.test(xml));
  // a rest becomes a note of the same length
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  await tap(77);
  x = await note((n) => n.bar === 0 && n.staff === 1 && n.on === 1);
  check('a rest becomes a note of that pitch, same length', x && !x.rest && x.midi === 77 && x.dur === 1, JSON.stringify(x));
  check('bars stay full', full(await EN(() => window.__editNotes.notes)));
  // two keys at once: a chord
  await pick((n) => n.bar === 3 && n.staff === 1 && n.on === 0);
  await tap([72, 76]);
  let ch = (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === 3 && n.staff === 1 && n.on === 0).map((n) => n.midi).sort();
  check('two keys at once: the note becomes that chord', JSON.stringify(ch) === '[72,76]', JSON.stringify(ch));
  const steps = await EN(() => window.__editNotes.step);
  // undo
  await page.click('.notes-panel [data-a="undo"]'); await idle();
  ch = (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === 3 && n.staff === 1 && n.on === 0).map((n) => n.midi);
  check('Undo takes the chord back', (await EN(() => window.__editNotes.step)) === steps - 1 && JSON.stringify(ch) === `[${MEL[3]}]`, JSON.stringify(ch));
  await page.click('.notes-panel [data-a="redo"]'); await idle();
  check('Redo brings it again', (await EN(() => window.__editNotes.step)) === steps);

  // the low length keys: D3 = 1/2
  await pick((n) => n.bar === 4 && n.staff === 1 && n.on === 0);
  await tap(50);
  x = await note((n) => n.bar === 4 && n.staff === 1 && n.on === 0);
  check('length key D3: a half note', x?.dur === 2 && x.midi === MEL[4], JSON.stringify(x));
  check('length key: bar still full, the key made no note', full(await EN(() => window.__editNotes.notes)) && !(await EN(() => window.__editNotes.notes)).some((n) => n.midi === 50));
  await tap(53); // F3 = 1/8
  x = await note((n) => n.bar === 4 && n.staff === 1 && n.on === 0);
  check('length key F3: an eighth', x?.dur === 0.5, JSON.stringify(x));
  await tap(59); // B3 = 1/32
  x = await note((n) => n.bar === 4 && n.staff === 1 && n.on === 0);
  check('length key B3: a 32nd, the bar still full', x?.dur === 0.125 && full(await EN(() => window.__editNotes.notes)), JSON.stringify(x));
  await tap(53);

  // next note: three keys walk along bar 6, then across the bar line
  await EN(() => window.__midiEdit.setOpts({ auto: true }));
  await pick((n) => n.bar === 5 && n.staff === 1 && n.on === 0);
  for (const m of [79, 81, 83]) await tap(m);
  const b6 = (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === 5 && n.staff === 1).sort((a, c) => a.on - c.on).map((n) => n.midi);
  check('next note: each key went to the next note', JSON.stringify(b6.slice(0, 3)) === '[79,81,83]', JSON.stringify(b6));
  let s = await selNotes();
  check('…and the fourth note is picked now', s.length === 1 && s[0].bar === 5 && s[0].on === 3, JSON.stringify(s));
  await tap(84);
  s = await selNotes();
  check('across the bar line: bar 7 beat 1 is picked', s.length === 1 && s[0].bar === 6 && s[0].on === 0 && s[0].staff === 1, JSON.stringify(s));
  // left hand walks its own staff
  await pick((n) => n.bar === 6 && n.staff === 2 && n.on === 2);
  await tap(41);
  s = await selNotes();
  check('left hand: next note stays on the left hand (bar 8)', s.length === 1 && s[0].staff === 2 && s[0].bar === 7 && s[0].on === 0, JSON.stringify(s));
  // the next one far down is scrolled into view (Mac: one long page)
  await pick((n) => n.bar === 22 && n.staff === 1 && n.on === 3);
  await EN(() => window.scrollTo(0, 0));
  await tap(72);
  const vis = await EN(() => { const r = window.__editNotes.sel[0], g = document.querySelector(`#paper g[data-ref="${r}"]`)?.getBoundingClientRect(); return g && g.top >= 0 && g.bottom <= innerHeight; });
  check('the next note far down is in view', vis);

  // hold to set length: 2 s at 60 BPM = a half note
  await EN(() => window.__midiEdit.setOpts({ auto: false, hold: true, holdTempo: 60 }));
  await pick((n) => n.bar === 8 && n.staff === 1 && n.on === 0);
  await EN(() => window.__hold(67, 2000)); await sleep(300); await idle();
  x = await note((n) => n.bar === 8 && n.staff === 1 && n.on === 0);
  check('hold 2 s at 60 BPM: G4, a half note', x?.midi === 67 && x.dur === 2, JSON.stringify(x));
  await EN(() => window.__hold(69, 400)); await sleep(300); await idle();
  x = await note((n) => n.bar === 8 && n.staff === 1 && n.on === 0);
  check('hold 0.4 s: A4, an eighth', x?.midi === 69 && x.dur === 0.5, JSON.stringify(x));
  check('bars stay full after all of it', full(await EN(() => window.__editNotes.notes)));
  await EN(() => window.__midiEdit.setOpts({ hold: false }));

  // options sheet from the chip, remembered per keyboard
  await page.click('.np-midi'); await sleep(250);
  check('the chip opens the options', !!(await page.$('.me-sheet')));
  await page.screenshot({ path: `${SHOTS}/mac-options.png` });
  await page.evaluate(() => { const c = document.querySelector('.me-sheet [data-o="sound"]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  const saved = await EN(() => JSON.parse(localStorage.getItem('meowsic-midiedit'))['Digital Keyboard']);
  check('options remembered for this keyboard', saved && saved.sound === false && saved.auto === false, JSON.stringify(saved));
  await page.evaluate(() => document.querySelector('.me-sheet [data-close]').click()); await sleep(150);
  // closed: nothing left listening
  await EN(() => window.__editNotes.close(true)); await sleep(800);
  check('closing Edit notes lets go of the keyboard', await EN(() => !window.__midiEdit && !document.querySelector('.np-midi')));
  await page.close();
}

// ---------------- iPad (paged), with a fake keyboard: the page turns ----------------
console.log('\niPad (paged)');
{
  const { page } = await open(IPAD);
  const { EN, idle, selNotes, tap } = helpers(page);
  await page.waitForSelector('.np-midi', { timeout: 5000 }).catch(() => {});
  const pages = await EN(() => window.__score.pages);
  check('the score has more than one page', pages > 1, String(pages));
  // the last right-hand note on page 1
  const last = await EN(() => {
    const v = window.__score, rh = window.__editNotes.notes.filter((n) => n.staff === 1).sort((a, c) => a.bar * 1e4 + a.on - (c.bar * 1e4 + c.on));
    let prev = null;
    for (const n of rh) { v.goTo(1); v.showEl(document.querySelector(`#paper g[data-ref="${n.ref}"]`)); if (v.page > 1) break; prev = n; }
    v.goTo(1);
    return prev;
  });
  await EN((r) => window.__editNotes.select([r]), last.ref); await sleep(200);
  check('on page 1', (await EN(() => window.__score.page)) === 1);
  await tap(84);
  const s = await selNotes();
  check('next note on page 2 is picked, the page turned', (await EN(() => window.__score.page)) === 2 && s.length === 1 && s[0].bar * 1e4 + s[0].on > last.bar * 1e4 + last.on, JSON.stringify({ s, last }));
  await page.screenshot({ path: `${SHOTS}/ipad-page2.png` });
  await EN(() => window.__editNotes.close(true)); await sleep(500);
  await page.close();
}

// ---------------- no Web MIDI (iPad / iPhone Safari): nothing shows ----------------
console.log('\nNo Web MIDI');
{
  const { page } = await open(IPAD, 'unsupported');
  const { EN } = helpers(page);
  await sleep(800);
  check('no Web MIDI: no chip, nothing attached', await EN(() => !navigator.requestMIDIAccess && !document.querySelector('.np-midi') && !window.__midiEdit));
  check('the edit bar has no empty slot showing', await EN(() => { const s = document.querySelector('.np-midi-slot'); return !s || getComputedStyle(s).display === 'none'; }));
  await page.close();
}

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
