// Edit notes → Bar ▾ → 8va / 8vb (octaveops.py), against a test server (BASE). A made-up piano score with a high
// intro (bars 1–2, C6 …) and a very low last bass note (C1). Per device (Mac, iPad): the two bars picked → Bar ▾
// "8va over bars 1–2 (right hand)" → the preview draws the octave line ("8va" text) and the intro notes an octave
// lower on the staff (below the A5 of bar 3 now); the player's notes (musicxml.js xmlInfo) are exactly the same; the
// menu item is ticked; Undo takes the line away, Redo brings it back. The last bar's bass: "8vb …(left hand)".
// Mac: under 8va a typed letter lands where it is seen (D on the drawn C5 → D6 sounding; a rest: B → B5).
// Save: the file has the <octave-shift> start / stop, the same pitches, an Activities row; Undo puts the file back.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '/tmp';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const stamp = Date.now().toString(36);

const NAME = { 24: ['C', 1], 43: ['G', 2], 48: ['C', 3], 53: ['F', 3], 60: ['C', 4], 67: ['G', 4], 69: ['A', 4], 79: ['G', 5], 81: ['A', 5], 84: ['C', 6], 86: ['D', 6], 88: ['E', 6], 91: ['G', 6] };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (m, q, staff) => `<note><pitch><step>${NAME[m][0]}</step><octave>${NAME[m][1]}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`;
const RH = [[[84, 1], [86, 1], [88, 2]], [[91, 2], [88, 2]], [[81, 4]], [[79, 4]], [[67, 4]]];
const LH = [[[48, 4]], [[43, 4]], [[53, 4]], [[43, 4]], [[24, 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.map(([m, q]) => note(m, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH[k].map(([m, q]) => note(m, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';

async function run(name, vp) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Octave lines ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const xml = () => EN(() => window.__editNotes.xml);
  const played = (x) => EN(async (t) => { const { xmlInfo } = await import('/js/musicxml.js'); return xmlInfo(t).notes.map((n) => `${n.n}@${n.q}:${n.d}/${n.s}`).sort().join(' '); }, x);
  const shifts = (x) => (x.match(/<octave-shift[^>]*>/g) || []).map((s) => s.match(/type="(\w+)"/)[1] + s.match(/size="(\d+)"/)[1]).join(' ');
  // the y of a drawn notehead (page px), by its sounding pitch and bar
  const yOf = (bar, midi) => EN((bar, midi) => {
    const n = window.__editNotes.notes.find((x) => x.bar === bar && x.midi === midi && !x.rest);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    return g ? g.getBoundingClientRect().top + g.getBoundingClientRect().height / 2 : null;
  }, bar, midi);
  const svgText = () => EN(() => [...document.querySelectorAll('#osmd svg text')].map((t) => t.textContent).join('|'));
  const menuPick = async (re) => {
    await act('barmenu'); await sleep(250);
    const items = await page.$$eval('.menu button', (e) => e.map((x) => ({ t: x.textContent.trim(), on: x.getAttribute('aria-checked') === 'true' || x.classList.contains('on') || /✓/.test(x.textContent) })));
    const i = items.findIndex((x) => re.test(x.t));
    if (i < 0) { await page.keyboard.press('Escape'); return { items }; }
    await tap(`.menu button:nth-of-type(${i + 1})`); await idle();
    return { items, item: items[i] };
  };

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);
  const known = () => EN(() => window.__editNotes.notes.map((n) => [n.bar, n.staff, n.on, n.midi]));
  const x0 = await xml(), p0 = await played(x0), n0 = JSON.stringify(await known());
  const yC = await yOf(0, 84), yA = await yOf(2, 81);
  check('before: C6 of bar 1 is drawn above the A5 of bar 3 (ledger lines)', yC != null && yA != null && yC < yA, `${yC} ${yA}`);

  // bars 1–2 of the right hand picked → Bar ▾ → 8va
  await EN(() => { const e = window.__editNotes; e.select(e.notes.filter((n) => n.staff === 1 && n.bar <= 1 && !n.rest).map((n) => n.ref)); }); await sleep(300);
  let r = await menuPick(/^8va over bars 1–2 \(right hand\)$/);
  check('Bar ▾ offers 8va and 8vb over bars 1–2 of the right hand', r.item && r.items.some((x) => x.t === '8vb over bars 1–2 (right hand)'), JSON.stringify(r.items.map((x) => x.t)));
  let x1 = await xml();
  check('the preview has an <octave-shift> start (down 8) and stop', shifts(x1) === 'down8 stop8', shifts(x1));
  check('the player plays exactly the same notes (pitch, time, staff)', (await played(x1)) === p0, `${await played(x1)}\n${p0}`);
  check('the notes the editor knows keep their pitch', JSON.stringify(await known()) === n0, JSON.stringify(await known()));
  await page.waitForSelector('#osmd svg', { timeout: 8000 }); await sleep(500);
  const yC1 = await yOf(0, 84), yA1 = await yOf(2, 81);
  check('OSMD draws the intro an octave lower: C6 (drawn C5) now below the A5', yC1 != null && yC1 > yA1, `${yC1} ${yA1}`);
  const tx = await svgText();
  check('OSMD draws the "8va" line text', /8va|8\|va|\b8\b/.test(tx) && /va/.test(tx), tx.slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/Ottava-${name}-8va.png` });
  await EN(() => { const e = window.__editNotes; e.select(e.notes.filter((n) => n.staff === 1 && n.bar <= 1 && !n.rest).map((n) => n.ref)); }); await sleep(300);
  await act('barmenu'); await sleep(250);
  const ticked = await page.$$eval('.menu button', (e) => { const x = e.find((b) => b.textContent.trim().startsWith('8va over bars 1–2')); return x ? x.outerHTML : ''; });
  await page.keyboard.press('Escape'); await sleep(200);
  check('the 8va item is ticked now', /aria-checked="true"|class="[^"]*\bon\b|✓/.test(ticked), ticked);

  // Undo / Redo
  await act('undo'); await idle();
  check('Undo: the line is gone', shifts(await xml()) === '', shifts(await xml()));
  await act('redo'); await idle();
  check('Redo: the line is back', shifts(await xml()) === 'down8 stop8', shifts(await xml()));

  // the last bass note: 8vb
  await EN(() => window.__editNotes.pickBar(4, 2)); await sleep(300);
  r = await menuPick(/^8vb over bar 5 \(left hand\)$/);
  const x2 = await xml();
  check('8vb on bar 5 of the left hand', !!r.item && shifts(x2) === 'down8 stop8 up8 stop8' && /placement="below"[\s\S]*?type="up"/.test(x2), `${shifts(x2)} ${JSON.stringify(r.items?.map((x) => x.t))}`);
  check('…and the player still has the same notes (the low C1 too)', (await played(x2)) === p0 && p0.includes('24@16:4'), await played(x2));

  // Mac: a letter typed under 8va lands where it is seen
  if (!touch) {
    await EN(() => { const e = window.__editNotes; e.select([e.notes.find((n) => n.bar === 0 && n.midi === 84).ref]); }); await sleep(200);
    await page.keyboard.press('d'); await idle();
    let mel = (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === 0 && n.staff === 1).map((n) => n.rest ? 'R' : n.midi);
    check('D typed on the drawn C5 (sounding C6): D6, drawn as D5 under the line', mel[0] === 86, JSON.stringify(mel));
    await EN(() => { const e = window.__editNotes; e.select([e.notes.find((n) => n.bar === 0 && n.on === 0 && n.staff === 1).ref]); }); await sleep(200);
    await page.keyboard.press('Backspace'); await idle();
    await EN(() => { const e = window.__editNotes; e.select([e.notes.find((n) => n.bar === 0 && n.on === 0 && n.staff === 1).ref]); }); await sleep(200);
    await page.keyboard.press('b'); await idle();
    mel = (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === 0 && n.staff === 1).map((n) => n.rest ? 'R' : n.midi);
    check('B typed on a rest under 8va (nothing before it): B5, drawn as B4 in the middle of the staff', mel[0] === 83, JSON.stringify(mel));
    for (let i = 0; i < 3; i++) { await act('undo'); await idle(); }
  }
  const want = await xml();
  check('back to the two lines before Save', shifts(want) === 'down8 stop8 up8 stop8', shifts(want));

  // Save: the file, the Activities row and its Undo
  const before = await xmlOf(sc.id);
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  const saved = await xmlOf(sc.id);
  check('saved: the file is what the editor showed, the same notes play', saved === want && (await played(saved)) === p0, shifts(saved));
  const row = (await send('GET', '/activity')).find((a) => a.type === 'edit-notes' && a.itemId === sc.id || (a.detail || '').includes('octave line') && (a.title || '').includes(title));
  check('Activities: one row, "2 octave lines (8va / 8vb) changed"', !!row && /2 octave lines \(8va \/ 8vb\) changed/.test(row.detail), JSON.stringify(row));
  if (row) {
    await send('POST', `/activity/${row.id}/undo`, {});
    check('Activities Undo puts the file back', (await xmlOf(sc.id)) === before);
  }
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(500);
  await page.screenshot({ path: `${SHOTS}/Ottava-${name}-saved.png` });
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

await run('Mac', MAC);
await run('iPad', IPAD);
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
