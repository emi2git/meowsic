// Edit notes → Even out (the "=" button, key Q; server/meowsic/evenops.py), against a test server (BASE). Per device
// (Mac, iPad Pro 13", iPhone Air) on a made-up piano score: one note picked → no Even out button; a dotted 8th + 16th
// picked (Mac: click + ⌘-click; iPad / iPhone: Several + taps) → the button shows (an SVG glyph, aria-label) → Q /
// the button: two 8ths, the bar still full, the lyrics and the tie out kept, one undo step (Undo brings the dotted
// rhythm back, Redo evens it again); a 16th + dotted 8th (Scotch snap) → two 8ths; three notes over two beats → refused
// with a toast, nothing changed. Then the edit bar does not wrap on 11" / 13" iPads with the button showing, and Help
// lists Q. Screenshots go to $SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '/tmp';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

// bar 1 right hand: E4 dotted 8th + F4 16th (both sung), G4 quarter, D4 16th + E4 dotted 8th, C4 quarter tied into bar 2
const STEPS = { 48: 'C3', 55: 'G3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4' };
const TY = { 0.25: ['16th', 0], 0.75: ['eighth', 1], 1: ['quarter', 0], 4: ['whole', 0] };
const note = (m, q, staff, ex = '') => {
  const [ty, dots] = TY[q];
  const tie = (ex.includes('<') ? '<tie type="stop"/>' : '') + (ex.includes('>') ? '<tie type="start"/>' : '');
  const tied = (ex.includes('<') ? '<tied type="stop"/>' : '') + (ex.includes('>') ? '<tied type="start"/>' : '');
  return `<note><pitch><step>${STEPS[m][0]}</step><octave>${STEPS[m][1]}</octave></pitch><duration>${q * 4}</duration>${tie}<voice>${staff === 2 ? 5 : 1}</voice><type>${ty}</type>${'<dot/>'.repeat(dots)}<staff>${staff}</staff>`
    + (tied ? `<notations>${tied}</notations>` : '') + (ex.includes('L') ? '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>' : '') + '</note>';
};
const RH = [[[64, 0.75, 'L'], [65, 0.25, 'L'], [67, 1], [62, 0.25], [64, 0.75], [60, 1, '>']], [[60, 4, '<']]];
const LH = [[[48, 4]], [[55, 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.map(([m, q, ex]) => note(m, q, 1, ex)).join('') + '<backup><duration>16</duration></backup>' + LH[k].map(([m, q]) => note(m, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';

async function open(vp, sc, name) {
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|400|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);
  return page;
}

async function run(name, vp) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Even out ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title) });
  const page = await open(vp, sc, name);
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const tapXY = async (x, y, meta) => {
    if (touch) await page.touchscreen.tap(x, y);
    else { if (meta) await page.keyboard.down('Meta'); await page.mouse.click(x, y); if (meta) await page.keyboard.up('Meta'); }
    await sleep(200);
  };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(600); };
  const head = (bar, on) => EN((bar, on) => {
    const n = window.__editNotes.notes.find((x) => x.bar === bar && x.staff === 1 && Math.abs(x.on - on) < 1e-6);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    g.scrollIntoView({ block: 'center' });
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, bar, on);
  const pick = async (on, more) => { const h = await head(0, on); if (h) await tapXY(h.x, h.y, more); return !!h; };
  const voice = async (bar = 0) => (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === bar && n.staff === 1).sort((a, z) => a.on - z.on).map((n) => `${n.rest ? 'R' : n.midi}@${n.on}:${n.dur}`).join(' ');
  const xml = () => EN(() => window.__editNotes.xml);
  const btn = () => EN(() => { const x = document.querySelector('.notes-panel [data-a="even"]'); return x && { label: x.getAttribute('aria-label'), svg: !!x.querySelector('svg.nv-even'), disabled: x.disabled, w: x.getBoundingClientRect().width }; });
  const before = await voice();

  await pick(0);
  check('one note picked: no Even out button', !(await btn()));
  if (touch) await tap('.notes-panel [data-a="several"]');
  await pick(0.75, true);
  check('dotted 8th + 16th picked', (await EN(() => window.__editNotes.sel.length)) === 2);
  const bt = await btn();
  check('the Even out button shows: a glyph, named, enabled', bt && bt.label === 'Even out' && bt.svg && !bt.disabled && bt.w > 20, JSON.stringify(bt));
  await page.screenshot({ path: `${SHOTS}/Evenout-${name}-picked.png` });
  const step0 = await EN(() => window.__editNotes.step);
  if (touch) await tap('.notes-panel [data-a="even"]'); else { await page.keyboard.press('q'); await sleep(150); }
  await idle();
  check('E4 + F4 → two 8ths; the rest of the bar unchanged', (await voice()) === '64@0:0.5 65@0.5:0.5 67@1:1 62@2:0.25 64@2.25:0.75 60@3:1', await voice());
  const x1 = await xml();
  check('lyrics (2) and the tie into bar 2 kept', (x1.match(/<lyric/g) || []).length === 2 && /<tie type="start"\s*\/>/.test(x1) && (await voice(1)) === '60@0:4', `${(x1.match(/<lyric/g) || []).length}`);
  check('one undo step', (await EN(() => window.__editNotes.step)) === step0 + 1);
  await page.screenshot({ path: `${SHOTS}/Evenout-${name}-even.png` });
  await tap('.notes-panel [data-a="undo"]'); await idle();
  check('Undo: the dotted rhythm is back', (await voice()) === before, await voice());
  await tap('.notes-panel [data-a="redo"]'); await idle();
  check('Redo: even again', (await voice()).startsWith('64@0:0.5 65@0.5:0.5 '), await voice());

  // the Scotch snap (16th + dotted 8th) → two 8ths
  await EN(() => window.__editNotes.select(window.__editNotes.notes.filter((n) => n.bar === 0 && n.staff === 1 && (n.on === 2 || n.on === 2.25)).map((n) => n.ref)));
  await sleep(300);
  if (touch) await tap('.notes-panel [data-a="even"]'); else { await page.keyboard.press('Q'); await sleep(150); }
  await idle();
  check('16th + dotted 8th → two 8ths', (await voice()) === '64@0:0.5 65@0.5:0.5 67@1:1 62@2:0.5 64@2.5:0.5 60@3:1', await voice());

  // three notes over two beats (2/3 each): no plain note → refused, nothing changed
  await EN(() => window.__editNotes.select(window.__editNotes.notes.filter((n) => n.bar === 0 && n.staff === 1 && n.on >= 2).map((n) => n.ref)));
  await sleep(300);
  const st = await EN(() => window.__editNotes.step), v0 = await voice();
  if (touch) await tap('.notes-panel [data-a="even"]'); else { await page.keyboard.press('q'); await sleep(150); }
  await idle();
  const t = await EN(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' '));
  check('three notes over 2 beats: refused with a toast (a triplet), nothing changed', /triplet/i.test(t) && (await voice()) === v0 && (await EN(() => window.__editNotes.step)) === st, t);
  await page.close();

  // Help lists Q
  if (name === 'Mac') {
    const hp = await b.newPage(); await hp.setViewport(vp);
    await hp.goto(`${BASE}#/help`, { waitUntil: 'networkidle0' }); await sleep(500);
    const h = await hp.evaluate(() => { const s = document.querySelector('#help-editnotes'); return s ? { even: !!s.querySelector('svg.nv-even'), text: s.textContent } : null; });
    check('Help: Even out (Q) with its glyph, and Q in the keys', h && h.even && /Even out/.test(h.text) && /Q even out/.test(h.text));
    await hp.close();
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
}

// the edit bar with the Even out button showing does not wrap on iPads (11" is the tight one)
async function fits() {
  console.log('\nEdit bar with Even out on iPads');
  const sc = await send('POST', '/items', { kind: 'score', title: `Even out fits ${stamp}`, musicxmlText: scoreXml('Even out fits') });
  for (const [w, h] of [[1032, 1376], [1376, 1032], [834, 1194], [1194, 834], [820, 1180], [1180, 820]]) {
    const page = await open({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, sc, `fits ${w}`);
    await page.evaluate(() => window.__editNotes.select(window.__editNotes.notes.filter((n) => n.bar === 0 && n.staff === 1 && n.on < 1).map((n) => n.ref)));
    await sleep(300);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.notes-panel .np-row, .notes-panel .np-acts')].filter((row) => {
      const kids = [...row.children].filter((k) => k.offsetParent && !k.classList.contains('grow'));
      const bot = Math.min(...kids.map((k) => k.getBoundingClientRect().bottom));
      return kids.some((k) => k.getBoundingClientRect().top >= bot - 1);
    }).map((row) => row.className));
    const shown = await page.evaluate(() => !!document.querySelector('.notes-panel [data-a="even"]'));
    check(`${w}×${h}: Even out shows and the edit bar does not wrap`, shown && !bad.length, `${shown} ${bad.join(', ')}`);
    if (w === 834) await page.screenshot({ path: `${SHOTS}/Evenout-ipad11-${w}.png` });
    await page.close();
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
}

await run('Mac', MAC);
await run('iPad', IPAD);
await run('iPhone', PHONE);
await fits();
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
