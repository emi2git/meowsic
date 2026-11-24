// Edit notes: 32nd notes and rests, and the length buttons drawn as note / rest glyphs (notevalue.js), against a
// test server (BASE). Per device (Mac, iPad Pro 13", iPhone Air) on a made-up piano score counted in 2 divisions
// per quarter: six length buttons (32nd … whole), each an SVG glyph with an aria-label and no fraction text; a
// rest picked shows rest glyphs ("32nd rest"); Mac: key 1 = 32nd (keys 2–6 still 16th … whole), . = dotted 32nd,
// a length key then A–G writes a 32nd note into a rest; iPad / iPhone: the buttons. Each time the bar stays full,
// the score's <divisions> are raised (8 / 16 per quarter) and the player's notes (musicxml.js xmlInfo) land on
// the right 32nd. Help lists keys 1–6 with glyphs. Screenshots of the panel go to $SHOTS.
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

const STEPS = { 48: 'C3', 55: 'G3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4' };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (m, q, staff) => `<note><pitch><step>${STEPS[m][0]}</step><octave>${STEPS[m][1]}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`;
const RH = [[[64, 1], [65, 1], [67, 1], [62, 1]], [[60, 4]]];
const LH = [[[48, 4]], [[55, 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.map(([m, q]) => note(m, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH[k].map(([m, q]) => note(m, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';

async function run(name, vp) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Thirty-seconds ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(600); };
  const head = (pred) => page.evaluate((src) => {
    const f = new Function('n', `return (${src})(n)`);
    const n = window.__editNotes.notes.find(f);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    g.scrollIntoView({ block: 'center' });
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, pred.toString());
  const pick = async (pred) => { const h = await head(pred); if (!h) return null; await tapXY(h.x, h.y); return h.ref; };
  const voice = async (bar, staff) => (await EN(() => window.__editNotes.notes)).filter((n) => n.bar === bar && n.staff === staff).sort((a, z) => a.on - z.on).map((n) => `${n.rest ? 'R' : n.midi}@${n.on}:${n.dur}`).join(' ');
  const xml = () => EN(() => window.__editNotes.xml);
  const div = async () => +((await xml()).match(/<divisions>(\d+)/)?.[1] || 0);
  const lenBtns = () => EN(() => [...document.querySelectorAll('.notes-panel .np-len [data-len]')].map((x) => ({ q: +x.dataset.len, svg: !!x.querySelector('svg.nv'), txt: x.textContent.trim(), label: x.getAttribute('aria-label'), title: x.title, on: x.classList.contains('on') })));
  const played = async () => EN(async (x) => { const { xmlInfo } = await import('/js/musicxml.js'); return xmlInfo(x).notes.filter((n) => n.q < 4).map((n) => `${n.n}@${n.q}:${n.d}`).sort().join(' '); }, await xml());

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);

  // the buttons: six glyphs, 32nd … whole, with words for screen readers and no fractions
  await pick((n) => n.bar === 0 && n.staff === 1 && n.midi === 64);
  let bs = await lenBtns();
  check('six length buttons: 32nd, 16th, 8th, quarter, half, whole', bs.map((x) => x.q).join() === '0.125,0.25,0.5,1,2,4', JSON.stringify(bs.map((x) => x.q)));
  check('each is a glyph (SVG), no fraction text, named for screen readers', bs.every((x) => x.svg && x.txt === '') && bs[0].label === '32nd note' && /\(1\)$/.test(bs[0].title) && bs[1].label === '16th note' && /\(2\)$/.test(bs[1].title) && bs[5].label === 'Whole note', JSON.stringify(bs));
  check('the dot button is a glyph too', await EN(() => !!document.querySelector('.notes-panel [data-a="dot"] svg.nv') && document.querySelector('.notes-panel [data-a="dot"]').textContent.trim() === ''));
  check('the quarter E4 shows the quarter button on', bs.find((x) => x.on)?.q === 1);
  check('the glyphs are drawn (not empty)', await EN(() => [...document.querySelectorAll('.np-len svg.nv')].every((s) => s.getBoundingClientRect().width >= 12 && s.childElementCount >= 1)));
  await page.screenshot({ path: `${SHOTS}/Note32-${name}-buttons.png` });

  // 1 (Mac) / the 32nd button: E4 a 32nd, rests 32nd 16th 8th fill the beat; divisions raised; plays at the right time
  if (touch) await tap('.notes-panel [data-len="0.125"]'); else { await page.keyboard.press('1'); await sleep(150); }
  await idle();
  check('E4 → a 32nd; 32nd + 16th + 8th rests fill the beat; F4 G4 D4 stay', (await voice(0, 1)) === '64@0:0.125 R@0.125:0.125 R@0.25:0.25 R@0.5:0.5 65@1:1 67@2:1 62@3:1', await voice(0, 1));
  check('divisions raised (2 → 8 per quarter), the left hand unchanged', (await div()) >= 8 && (await voice(0, 2)) === '48@0:4', `${await div()} ${await voice(0, 2)}`);
  check('the player: E4 for an 8th of a beat, the rest on their beats', (await played()) === ['48@0:4', '64@0:0.125', '65@1:1', '67@2:1', '62@3:1'].sort().join(' '), await played());
  bs = await lenBtns();
  check('…the 32nd button is on', bs.find((x) => x.on)?.q === 0.125);
  await page.screenshot({ path: `${SHOTS}/Note32-${name}-32nd.png` });

  // . (Mac) / the dot: a dotted 32nd
  if (touch) await act('dot'); else { await page.keyboard.press('.'); await sleep(150); }
  await idle();
  check('dotted 32nd: E4 3/16 of a beat, the bar still full', (await voice(0, 1)).startsWith('64@0:0.1875 ') && (await voice(0, 1)).endsWith('65@1:1 67@2:1 62@3:1') && (await div()) % 16 === 0, `${await voice(0, 1)} div ${await div()}`);
  await act('undo'); await idle();

  // a rest picked: rest glyphs; then (Mac) a length key and a letter: a 32nd A4 written into it
  const r = await pick((n) => n.bar === 0 && n.staff === 1 && n.rest && n.on === 0.125);
  check('the 32nd rest after E4 picked', r != null && (await EN(() => window.__editNotes.sel.length)) === 1);
  bs = await lenBtns();
  check('rest picked: the buttons are rest glyphs ("32nd rest" … "Whole rest")', bs[0].label === '32nd rest' && bs[5].label === 'Whole rest' && bs.every((x) => x.svg), JSON.stringify(bs.map((x) => x.label)));
  check('…the 32nd-rest button is on', bs.find((x) => x.on)?.q === 0.125);
  await page.screenshot({ path: `${SHOTS}/Note32-${name}-rests.png` });
  if (!touch) {
    await page.keyboard.press('2'); await idle(); // the rest a 16th (key 2 still = 16th)
    check('key 2 still = 16th: the rest takes the next 32nd', (await voice(0, 1)).startsWith('64@0:0.125 R@0.125:0.25 '), await voice(0, 1));
    await page.keyboard.press('1'); await idle();
    await page.keyboard.press('a'); await idle();
    check('1 then A: a 32nd A4 right after the E4', (await voice(0, 1)).startsWith('64@0:0.125 69@0.125:0.125 R@0.25:0.25 R@0.5:0.5 65@1:1'), await voice(0, 1));
    check('the player has the A4 a 32nd in', (await played()).includes('69@0.125:0.125'), await played());
  }

  // Help: keys 1–6 with glyphs, no "1/16" left
  await page.goto(`${BASE}#/help`, { waitUntil: 'networkidle0' }); await sleep(500);
  const h = await EN(() => { const s = document.querySelector('#help-editnotes'); return s ? { svgs: s.querySelectorAll('svg.nv').length, text: s.textContent } : null; });
  check('Help: lengths 1–6 drawn as glyphs (notes, rests, MIDI keys), no 1/16 text', h && h.svgs >= 18 && /1–6/.test(h.text) && !/1\/16/.test(h.text), JSON.stringify(h && { svgs: h.svgs }));
  if (name === 'iPhone') await page.screenshot({ path: `${SHOTS}/Note32-${name}-help.png`, fullPage: true });
  await page.close();
}

await run('Mac', MAC);
await run('iPad', IPAD);
await run('iPhone', PHONE);
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
