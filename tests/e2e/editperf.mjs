// Edit notes speed, against a test server (BASE; never the real library): a made-up long piano score (96 bars, two
// staves, chords, ties, one verse of "la" words — 864 notes, as long as the longest songs in the library) →
// open Edit notes on a Mac-size window → 12 edits (pitch, length, delete) each timed from the key press / api.run to
// the new score drawn. Asserts:
//   - the median edit-to-drawn time is under BUDGET ms (default 700: headless Chrome while other suites run; the
//     same edits take ~140 ms on a 44-bar score and ~400 ms on a 70-bar lyrics score on a quiet Mac);
//   - the Mac's preview time stays flat (the 12th edit's request is not much slower than the first: steps are kept,
//     not replayed);
//   - three ↑ pressed fast while an edit is on its way all count (the queue), the score is drawn once at the end;
//   - Undo walks back every step and the notes are the ones before; ties and words stay.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5371/';
const BUDGET = +(process.env.BUDGET || 700);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];

// 96 bars of 4/4: right hand quarter notes (a tie over every 4th bar line, a two-note chord on beat 1, a "la" word on
// each note), left hand half-note chords
const NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const pitch = (k, oct) => `<pitch><step>${NAMES[k % 7]}</step><octave>${oct + Math.floor(k / 7)}</octave></pitch>`;
const BARS = 96;
const bar = (i) => {
  let x = `<measure number="${i + 1}">` + (i ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>');
  for (let q = 0; q < 4; q++) {
    const k = (i * 3 + q * 2) % 9;
    const tieOut = i % 4 === 3 && q === 3, tieIn = i % 4 === 0 && i && q === 0;
    const kk = tieIn ? ((i - 1) * 3 + 6) % 9 : k;
    const ties = (tieIn ? '<tie type="stop"/>' : '') + (tieOut ? '<tie type="start"/>' : '');
    const nots = (tieIn ? '<tied type="stop"/>' : '') + (tieOut ? '<tied type="start"/>' : '');
    x += `<note>${pitch(kk, 4)}<duration>2</duration>${ties}<voice>1</voice><type>quarter</type><staff>1</staff>${nots ? `<notations>${nots}</notations>` : ''}<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric></note>`;
    if (q === 0) x += `<note><chord/>${pitch(kk + 2, 4)}<duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>`;
  }
  x += '<backup><duration>8</duration></backup>';
  for (let h = 0; h < 2; h++) {
    const k = (i + h * 4) % 7;
    x += `<note>${pitch(k, 2)}<duration>4</duration><voice>5</voice><type>half</type><staff>2</staff></note><note><chord/>${pitch(k + 4, 2)}<duration>4</duration><voice>5</voice><type>half</type><staff>2</staff></note>`;
  }
  return x + '</measure>';
};
const title = `Long piano ${Date.now().toString(36)}`;
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + Array.from({ length: BARS }, (_, i) => bar(i)).join('') + '</part></score-partwise>';
const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: xml });
check('a long score made', !!sc.id, JSON.stringify(sc).slice(0, 200));

const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(m.text()));
await page.evaluateOnNewDocument(() => {
  window.__req = [];
  const f0 = window.fetch;
  window.fetch = async (...a) => { const t = performance.now(); const r = await f0(...a); if (/editnotes\/preview/.test(String(a[0]))) window.__req.push(performance.now() - t); return r; };
});
const EN = (f, ...a) => page.evaluate(f, ...a);
const idle = async () => { for (let i = 0; i < 200; i++) { if (!(await EN(() => window.__editNotes?.busy))) return; await sleep(25); } };
await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#osmd svg', { timeout: 30000 }); await sleep(500);
await page.click('#it-more'); await sleep(200);
await EN(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Edit notes…').click());
await page.waitForSelector('.notes-panel', { timeout: 20000 }); await idle(); await sleep(300);
const n0 = await EN(() => window.__editNotes.notes.filter((n) => !n.rest).length);
check('every note is there (864)', n0 === 864, String(n0));
const before = await EN(() => window.__editNotes.xml);
const count = (x, re) => (x.match(re) || []).length;

// ---- 12 timed edits: from api.run to the new score drawn (the next frame painted) ----
const times = [];
for (let i = 0; i < 12; i++) {
  const kind = ['pitch', 'len', 'delete'][i % 3];
  const r = await EN(async (kind, i) => {
    const E = window.__editNotes;
    const ns = E.notes.filter((n) => !n.rest && n.staff === 1 && n.dur === 1);
    const n = ns[30 + i * 7];
    const op = kind === 'pitch' ? { op: 'pitch', refs: [n.ref], by: 1 } : kind === 'len' ? { op: 'len', refs: [n.ref], q: 0.5 } : { op: 'delete', refs: [n.ref] };
    const steps = E.step, t = performance.now();
    await E.run(op);
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    return { ms: performance.now() - t, ok: E.step === steps + 1 };
  }, kind, i);
  times.push(r.ms);
  if (!r.ok) check(`edit ${i + 1} (${kind}) made a step`, false);
}
const sorted = [...times].sort((a, b) => a - b), median = sorted[6];
console.log(`  edit-to-drawn ms: ${times.map((t) => Math.round(t)).join(' ')} (median ${Math.round(median)})`);
check(`median edit-to-drawn under ${BUDGET} ms`, median < BUDGET, String(Math.round(median)));
const req = await EN(() => window.__req.slice(-12));
const first3 = (req[0] + req[1] + req[2]) / 3, last3 = (req[9] + req[10] + req[11]) / 3;
console.log(`  preview request ms: ${req.map((t) => Math.round(t)).join(' ')}`);
check('the 12th edit asks the Mac no longer than the first ones (steps kept, not replayed)', last3 < first3 * 2 + 60, `${Math.round(first3)} → ${Math.round(last3)}`);
check('12 steps', (await EN(() => window.__editNotes.step)) === 12);

// ---- three ↑ pressed fast: all three count, drawn once at the end ----
const pick = await EN(() => { const n = window.__editNotes.notes.filter((x) => !x.rest && x.staff === 1)[200]; window.__editNotes.select([n.ref]); return { ref: n.ref, midi: n.midi, bar: n.bar, on: n.on }; });
await sleep(100);
await EN(() => { window.__renders = 0; const s = window.__score; const o = s.showXml.bind(s); s.showXml = async (x) => { window.__renders++; return o(x); }; });
for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowUp');
await idle(); await sleep(200);
const after3 = await EN((p) => ({ step: window.__editNotes.step, n: window.__editNotes.notes.find((x) => !x.rest && x.bar === p.bar && x.on === p.on && x.staff === 1 && x.midi >= p.midi), renders: window.__renders }), pick);
check('three fast ↑: three steps, the note 3 semitones up', after3.step === 15 && after3.n?.midi === pick.midi + 3, JSON.stringify(after3));
check('drawn at most twice for three edits (the waiting ones are not drawn)', after3.renders <= 2, String(after3.renders));
const drawnRefs = await page.$$eval('#paper g[data-ref]', (e) => e.length);
check('the score drawn last is the last step (every note can be picked)', drawnRefs >= (await EN(() => window.__editNotes.notes.length)) * 0.9, String(drawnRefs));

// ---- undo all the way: back to the score as it was ----
for (let k = 0; k < 15; k++) { await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta'); }
await idle(); await sleep(200);
const back = await EN(() => ({ step: window.__editNotes.step, xml: window.__editNotes.xml }));
check('Undo ×15: step 0, the notes as before', back.step === 0 && back.xml === before, String(back.step));
check('ties and words kept', count(back.xml, /<tie type="start"/g) === count(xml, /<tie type="start"/g) && count(back.xml, /<lyric/g) === count(xml, /<lyric/g));

await EN(() => window.__editNotes.close(true));
await send("POST", "/items/trash", { ids: [sc.id] }).catch(() => {});
check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
