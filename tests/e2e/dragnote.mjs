// Edit notes with a mouse and the computer keyboard (web/js/views/editnotes.js), against a test server (BASE, a temp
// data folder — never the real library). A made-up 4-bar piano score with a slur and a tie:
//   Mac: no help text under the tools · a plain click still picks a note · drag a note up two steps (in the key, a
//   ghost + its name while dragging) → one undoable edit · ⌥-drag a semitone a step · Esc cancels a drag · drag a note
//   sideways onto a rest (it moves there, bars stay full) · onto a longer note: refused with a toast · onto a note of
//   the same length: they swap · click the tie → picked, ⌫ takes it away · click the slur → its ✕ takes it away ·
//   A–G typed: a rest becomes that note (octave nearest the note before), the next one is picked, a run of letters ·
//   Shift+letter an octave up · nothing picked: the next rest is written · # / - a semitone · Help lists the keys;
//   iPad: no help text, a tap picks a note (no drag on touch).
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5391/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/dragnote';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const stamp = Date.now().toString(36);

// right hand: | C5 D5 ½rest | E5( F5) G5½~ | ~G5½ ½rest | C5 whole |; left hand a whole C3 each bar
const STEP = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const TY = { 1: 'quarter', 2: 'half', 4: 'whole' };
const n = (m, q, staff, extra = '', nt = '') => (m == null ? `<note><rest/><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TY[q]}</type><staff>${staff}</staff></note>`
  : `<note><pitch><step>${STEP[m % 12]}</step><octave>${Math.floor(m / 12) - 1}</octave></pitch><duration>${q * 2}</duration>${extra}<voice>${staff === 2 ? 5 : 1}</voice><type>${TY[q]}</type><staff>${staff}</staff>${nt ? `<notations>${nt}</notations>` : ''}</note>`);
const RH = [
  [n(72, 1, 1), n(74, 1, 1), n(null, 2, 1)],
  [n(76, 1, 1, '', '<slur type="start" number="1"/>'), n(77, 1, 1, '', '<slur type="stop" number="1"/>'), n(79, 2, 1, '<tie type="start"/>', '<tied type="start"/>')],
  [n(79, 2, 1, '<tie type="stop"/>', '<tied type="stop"/>'), n(null, 2, 1)],
  [n(72, 4, 1)],
];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.join('') + '<backup><duration>8</duration></backup>' + n(48, 4, 2) + '</measure>').join('') + '</part></score-partwise>';

const full = (ns) => { const s = {}; for (const x of ns) { if (x.dur) { const k = `${x.bar}|${x.staff}|${x.voice}|${x.on}`; s[k] = x.dur; } } const t = {}; for (const [k, d] of Object.entries(s)) { const [bar, st, v] = k.split('|'); t[`${bar}|${st}|${v}`] = (t[`${bar}|${st}|${v}`] || 0) + d; } return Object.values(t).every((v) => Math.abs(v - 4) < 1e-6); };

async function open(vp, name) {
  const title = `Dragged ${stamp} ${name}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title), tags: ['Kids'] });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/400|404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(900);
  return { page, sc };
}
const helpers = (page) => {
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { await sleep(150); for (let i = 0; i < 80; i++) { if (!(await EN(() => window.__editNotes.busy))) break; await sleep(100); } await sleep(600); };
  const notes = () => EN(() => window.__editNotes.notes);
  const find = async (pred) => (await notes()).find(pred);
  const at = (ref) => EN((r) => { const g = document.querySelector(`#paper g[data-ref="${r}"]`); if (!g) return null; const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, step: g.ownerSVGElement.getScreenCTM().d * 5 }; }, ref);
  const step = () => EN(() => window.__editNotes.step);
  const toastText = () => EN(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  return { EN, idle, notes, find, at, step, toastText };
};

// ---------------- Mac ----------------
console.log('\nMac');
{
  const { page } = await open(MAC, 'Mac');
  const { EN, idle, notes, find, at, step, toastText } = helpers(page);
  const mouse = page.mouse;
  check('no help text under the tools', await EN(() => !document.querySelector('.notes-panel .np-help') && !/Click a note or rest to pick it/.test(document.querySelector('.notes-panel').textContent)));

  // a plain click still picks
  let c5 = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1);
  let p = await at(c5.ref);
  await mouse.click(p.x, p.y); await sleep(250);
  check('a plain click picks the note (no edit)', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${c5.ref}]` && (await step()) === 0);

  // drag up two steps: C5 → E5 (in C major); the ghost + its name while dragging
  await mouse.move(p.x, p.y); await mouse.down();
  await mouse.move(p.x, p.y - 3, { steps: 2 }); await mouse.move(p.x, p.y - p.step * 2, { steps: 6 }); await sleep(150);
  const mid = await EN(() => ({ dragging: window.__editNotes.dragging, ghost: !!document.querySelector('#paper .np-ghost'), label: document.querySelector('.np-draglabel')?.textContent }));
  check('while dragging: a ghost note and its name (E5)', mid.dragging && mid.ghost && mid.label === 'E5', JSON.stringify(mid));
  await page.screenshot({ path: `${SHOTS}/mac-drag-pitch.png` });
  await mouse.up(); await idle();
  check('drag up two steps: C5 → E5, one edit', (await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1))?.midi === 76 && (await step()) === 1, JSON.stringify(await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1)));
  check('ghost and label gone after', await EN(() => !document.querySelector('.np-ghost, .np-draglabel')));
  await EN(() => document.querySelector('.notes-panel [data-a="undo"]').click()); await idle();
  check('Undo: C5 again', (await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1))?.midi === 72);

  // ⌥-drag: a semitone a step
  c5 = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1); p = await at(c5.ref);
  await page.keyboard.down('Alt');
  await mouse.move(p.x, p.y); await mouse.down(); await mouse.move(p.x, p.y - p.step * 2, { steps: 6 }); await mouse.up();
  await page.keyboard.up('Alt'); await idle();
  check('⌥-drag two steps: two semitones (C5 → D5, not E5)', (await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1))?.midi === 74, JSON.stringify(await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1)));
  await EN(() => document.querySelector('.notes-panel [data-a="undo"]').click()); await idle();

  // Esc cancels
  const s0 = await step();
  c5 = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1); p = await at(c5.ref);
  await mouse.move(p.x, p.y); await mouse.down(); await mouse.move(p.x, p.y - p.step * 3, { steps: 6 });
  await page.keyboard.press('Escape'); await sleep(100); await mouse.up(); await idle();
  check('Esc cancels a drag: nothing changes', (await step()) === s0 && (await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1))?.midi === 72 && !(await EN(() => window.__editNotes.dragging)));

  // sideways onto the half rest: D5 to beat 3
  const d5 = await find((x) => x.bar === 0 && x.midi === 74), rest = await find((x) => x.bar === 0 && x.staff === 1 && x.rest);
  p = await at(d5.ref); const pr = await at(rest.ref);
  await mouse.move(p.x, p.y); await mouse.down(); await mouse.move(p.x + 5, p.y, { steps: 2 }); await mouse.move(pr.x, p.y, { steps: 8 }); await sleep(120);
  const lab = await EN(() => document.querySelector('.np-draglabel')?.textContent);
  check('the label says where: D5 · bar 1, beat 3', lab === 'D5 · bar 1, beat 3', lab);
  await mouse.up(); await idle();
  let ns = await notes();
  check('D5 moved to beat 3 (a rest where it was), bars full', ns.some((x) => x.bar === 0 && x.on === 2 && x.midi === 74) && ns.some((x) => x.bar === 0 && x.on === 1 && x.rest && x.staff === 1) && full(ns), JSON.stringify(ns.filter((x) => x.bar === 0 && x.staff === 1)));
  check('the moved note stays picked', (await EN(() => window.__editNotes.sel)).length === 1);

  // onto the G5 half note (bar 2): refused
  const s1 = await step();
  const c = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1), g5 = await find((x) => x.bar === 1 && x.midi === 79);
  p = await at(c.ref); const pg = await at(g5.ref);
  await mouse.move(p.x, p.y); await mouse.down(); await mouse.move(p.x + 5, p.y, { steps: 2 }); await mouse.move(pg.x, p.y, { steps: 10 }); await mouse.up(); await idle();
  check('onto a longer note: refused with a toast', (await step()) === s1 && /note is there/.test(await toastText()), await toastText());

  // onto E5 (same length, bar 2 beat 1): they swap
  const e5 = await find((x) => x.bar === 1 && x.midi === 76);
  p = await at(c.ref); const pe = await at(e5.ref);
  await mouse.move(p.x, p.y); await mouse.down(); await mouse.move(p.x + 5, p.y, { steps: 2 }); await mouse.move(pe.x, p.y, { steps: 10 }); await mouse.up(); await idle();
  ns = await notes();
  check('onto a note of the same length: they swap', ns.some((x) => x.bar === 1 && x.on === 0 && x.midi === 72) && ns.some((x) => x.bar === 0 && x.on === 0 && x.midi === 76) && full(ns), JSON.stringify(ns.filter((x) => x.staff === 1 && x.bar < 2)));
  check('the slur stays (it went with E5)', ns.some((x) => x.slur));

  // the tie: click → picked; ⌫ takes it away
  const tie = await EN(() => { const t = document.querySelector('#paper .np-arc-hit[data-arc="tie"]'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  check('the tie is clickable', !!tie);
  if (tie) {
    await mouse.click(tie.x, tie.y); await sleep(250);
    const a = await EN(() => ({ arc: window.__editNotes.arc, x: !!document.querySelector('.np-arc-x'), on: !!document.querySelector('#paper .np-arc-on'), count: document.querySelector('#np-count').textContent }));
    check('click the tie: picked (highlighted, ✕ shown)', a.arc?.kind === 'tie' && a.x && a.on && /Tie picked/.test(a.count), JSON.stringify(a));
    await page.screenshot({ path: `${SHOTS}/mac-tie-picked.png` });
    const s2 = await step();
    await page.keyboard.press('Backspace'); await idle();
    check('⌫: the tie is gone (one edit), the notes stay', (await step()) === s2 + 1 && !(await notes()).some((x) => x.tie) && (await notes()).filter((x) => x.midi === 79).length === 2);
  }
  // the slur: click → its ✕
  const slur = await EN(() => { const t = document.querySelector('#paper .np-arc-hit[data-arc="slur"]'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.15 }; });
  check('the slur is clickable', !!slur);
  if (slur) {
    let hit = await EN(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.np-arc-hit'), slur);
    if (!hit) { // the arc's middle: walk down its box to the drawn line
      for (let f = 0.05; f < 1 && !hit; f += 0.05) { const y = await EN(() => { const r = document.querySelector('#paper .np-arc-hit[data-arc="slur"]').getBoundingClientRect(); return r; }); slur.y = y.top + y.height * f; hit = await EN(({ x, y: yy }) => !!document.elementFromPoint(x, yy)?.closest('.np-arc-hit'), slur); }
    }
    await mouse.click(slur.x, slur.y); await sleep(250);
    check('click the slur: picked', (await EN(() => window.__editNotes.arc?.kind)) === 'slur');
    const s3 = await step();
    await page.click('.np-arc-x'); await idle();
    check('its ✕: the slur is gone (one edit)', (await step()) === s3 + 1 && !(await notes()).some((x) => x.slur) && !(await EN(() => document.querySelector('.np-arc-x'))));
  }

  // A–G typed: the rest at bar 1 beat 2 → G (nearest the E5 before it: G5), then the next note is picked
  const r1 = await find((x) => x.bar === 0 && x.on === 1 && x.rest && x.staff === 1);
  await EN((r) => window.__editNotes.select([r]), r1.ref); await sleep(150);
  const s4 = await step();
  await page.keyboard.press('g'); await idle();
  ns = await notes();
  check('G on a rest: G5 there (nearest the note before), one edit', ns.some((x) => x.bar === 0 && x.on === 1 && x.midi === 79 && x.dur === 1) && (await step()) === s4 + 1, JSON.stringify(ns.filter((x) => x.bar === 0 && x.staff === 1)));
  const pickedNow = await EN(() => window.__editNotes.notes.filter((x) => window.__editNotes.sel.includes(x.ref)));
  check('then the next note is picked (D5 on beat 3)', pickedNow.length === 1 && pickedNow[0].bar === 0 && pickedNow[0].on === 2, JSON.stringify(pickedNow));
  await page.keyboard.press('f'); await idle(); await page.keyboard.press('e'); await idle();
  ns = await notes();
  check('a run "F E": D5 → F5, then the rest after it → E5 (nearest F5)', ns.some((x) => x.bar === 0 && x.on === 2 && x.midi === 77) && ns.some((x) => x.bar === 0 && x.on === 3 && x.midi === 76) && (await step()) === s4 + 3, JSON.stringify(ns.filter((x) => x.staff === 1 && x.bar < 2)));
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyC'); await page.keyboard.up('Shift'); await idle();
  const f5 = await find((x) => x.bar === 1 && x.on === 0 && x.staff === 1);
  check('Shift+C on the next note (C5, bar 2): an octave above the nearest C (C6)', f5?.midi === 84, JSON.stringify(f5));
  // # / - a semitone
  await EN((r) => window.__editNotes.select([r]), f5.ref); await sleep(150);
  await page.keyboard.press('-'); await idle();
  check('- a semitone down', (await find((x) => x.bar === 1 && x.on === 0 && x.staff === 1))?.midi === 83);
  // nothing picked: the next rest is written (bar 3's half rest)
  await EN(() => window.__editNotes.select([])); await sleep(150);
  await page.keyboard.press('a'); await idle();
  ns = await notes();
  check('nothing picked: A goes into the next rest', ns.filter((x) => x.staff === 1 && x.rest).length === 0 && ns.some((x) => x.bar === 2 && x.on === 2 && x.midi % 12 === 9) && full(ns), JSON.stringify(ns.filter((x) => x.staff === 1 && x.bar === 2)));
  // typed fast (each key waits its turn): a run lands on three notes in a row
  const first = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1);
  await EN((r) => window.__editNotes.select([r]), first.ref); await sleep(150);
  await page.keyboard.type('gab'); await idle(); await idle();
  ns = await notes();
  const row = [0, 1, 2].map((o) => ns.find((x) => x.bar === 0 && x.on === o && x.staff === 1)?.midi % 12);
  check('"gab" typed fast: G A B on three notes in a row', JSON.stringify(row) === '[7,9,11]', JSON.stringify(row));
  check('bars full after all of it', full(await notes()));
  await EN(() => window.__editNotes.close(true)); await sleep(400);
  await page.goto(`${BASE}#/help`, { waitUntil: 'networkidle0' }); await sleep(400);
  check('Help lists the editor keys (drag, A–G, ⌫)', await EN(() => { const t = document.querySelector('#help-editnotes')?.textContent || ''; return /Drag a note/.test(t) && /A–G/.test(t) && /tie or slur/.test(t); }));
  await page.close();
}

// ---------------- iPad: touch keeps tap to pick ----------------
console.log('\niPad');
{
  const { page } = await open(IPAD, 'iPad');
  const { EN, find, at, step } = helpers(page);
  check('no help text under the tools', await EN(() => !document.querySelector('.notes-panel .np-help')));
  const c5 = await find((x) => x.bar === 0 && x.on === 0 && x.staff === 1), p = await at(c5.ref);
  await page.touchscreen.tap(p.x, p.y); await sleep(300);
  check('a tap picks the note, no edit', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${c5.ref}]` && (await step()) === 0);
  await EN(() => window.__editNotes.close(true)); await sleep(300);
  await page.close();
}

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
