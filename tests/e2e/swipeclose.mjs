// Swipe up / down closes a sheet or score only in plain viewing mode: with a tool open (Fit lyrics, Edit notes,
// Annotate, Info) it does nothing. The chords strip at the top of a score is a display aid, not a tool: with it on, swipes still close. iPad + iPhone touch emulation, against a test server (BASE, default :5378,
// a scratchpad copy of the data — never the real library). Makes its own sheet (two icon pages) and score.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5378/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const stamp = Date.now().toString(36);

// test data: a two-page sheet (the app icons as pages) and a small one-staff score
const web = new URL('../../web/', import.meta.url);
const fd = new FormData();
fd.append('files', new Blob([readFileSync(new URL('icon-512.png', web))], { type: 'image/png' }), `p1-${stamp}.png`);
fd.append('files', new Blob([readFileSync(new URL('icon-180.png', web))], { type: 'image/png' }), `p2-${stamp}.png`);
fd.append('title', `Swipe sheet ${stamp}`);
let sheet = await fetch(BASE + 'api/sheets', { method: 'POST', body: fd }).then((r) => r.json());
if (!sheet.id) sheet = (await fetch(BASE + 'api/items').then((r) => r.json())).find((x) => x.kind === 'sheet'); // pages already uploaded once
const bar = (n) => `<measure number="${n}">${n === 1 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}`
  + ['C', 'D', 'E', 'F'].map((s) => `<note><pitch><step>${s}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`).join('') + '</measure>';
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>Swipe score ${stamp}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${[1, 2, 3, 4].map(bar).join('')}</part></score-partwise>`;
const score = await fetch(BASE + 'api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: `Swipe score ${stamp}`, musicxmlText: xml }) }).then((r) => r.json());

async function run(name, vp) {
  console.log(`\n${name}`);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  const hash = () => page.evaluate(() => location.hash);
  const open = async (it) => {
    await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
    await page.evaluate((id) => { location.hash = '#/item/' + id; }, it.id);
    await page.waitForSelector(it.kind === 'score' ? '#osmd svg' : '.pages .page img', { timeout: 15000 }); await sleep(700);
  };
  // a quick vertical swipe through the middle of the music (above any bottom panel)
  const swipe = async (dir) => {
    const sel = (await page.$('#osmd')) ? '#osmd' : (await page.$('.pages')) ? '.pages' : null;
    if (!sel) return; // already closed
    const r = await page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: Math.max(b.y, 0) + Math.min(b.height, innerHeight) * 0.3 }; });
    const y0 = r.y + (dir === 'up' ? 200 : 0);
    await page.touchscreen.touchStart(r.x, y0);
    for (let i = 1; i <= 5; i++) await page.touchscreen.touchMove(r.x + 2, y0 + (dir === 'up' ? -40 : 40) * i);
    await page.touchscreen.touchEnd(); await sleep(700);
  };
  const info = async () => { await page.tap('#it-more'); await sleep(200); await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Info').click()); await sleep(300); };
  const action = async (label, sel) => {
    await info();
    await page.evaluate((l) => [...document.querySelectorAll('.info-actions button')].find((x) => x.textContent.trim() === l).click(), label);
    await page.waitForSelector(sel, { timeout: 10000 }); await sleep(600);
  };
  const annotate = async () => { await page.evaluate(() => [...document.querySelectorAll('.ink-toggle')].find((x) => x.offsetWidth)?.click()); await page.waitForSelector('.inkbar', { timeout: 5000 }); await sleep(200); };

  for (const it of [sheet, score]) {
    const k = it.kind;
    for (const dir of ['down', 'up']) {
      await open(it); await swipe(dir);
      check(`${k}: swipe ${dir} in view mode closes`, (await hash()).startsWith('#/library'), await hash());
    }
    await open(it); await annotate();
    for (const dir of ['down', 'up']) await swipe(dir);
    check(`${k}: swipe with Annotate open stays`, (await hash()).startsWith('#/item/'), await hash());
    await open(it); await info();
    await swipe('down');
    check(`${k}: swipe with Info open stays`, (await hash()).startsWith('#/item/'), await hash()); // (a touch on the backdrop may close the popup itself)
  }
  for (const [label, sel] of [['Fit lyrics…', '.fitly'], ['Edit notes…', '.notes-panel']]) {
    await open(score); await action(label, sel);
    for (const dir of ['down', 'up']) await swipe(dir);
    check(`score: swipe with ${label.replace('…', '')} open stays`, (await hash()).startsWith('#/item/') && !!(await page.$(sel)), await hash());
  }
  // the chords strip (piano / ukulele) is not a tool: swipe up / down still closes the score
  for (const [mode, dir] of [['uke', 'down'], ['piano', 'up']]) {
    await page.evaluate((m) => localStorage.setItem('meowsic-chords', m), mode);
    await open(score); await page.waitForSelector('.chord-strip', { timeout: 5000 }); await sleep(500);
    await swipe(dir);
    check(`score: swipe ${dir} with the ${mode} chords strip on closes`, (await hash()).startsWith('#/library'), await hash());
  }
  await page.evaluate(() => localStorage.removeItem('meowsic-chords'));
  // page turns sideways still work on the sheet
  await open(sheet);
  const box = await page.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.touchscreen.touchStart(box.x + 120, box.y); await page.touchscreen.touchMove(box.x - 120, box.y); await page.touchscreen.touchEnd(); await sleep(400);
  check('sheet: sideways swipe turns the page, stays open', (await hash()).startsWith('#/item/') && (await page.$eval('.pages .page', (e) => e.dataset.p)) === '2');
  await page.close();
}

await run('iPad', IPAD);
await run('iPhone', PHONE);
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
