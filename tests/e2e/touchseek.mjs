// Score: drag / tap the orange line, Play starts there. iPad / iPhone: swipe left / right flips a
// screen on chords and scores, swipe up at the end goes back, swipe up mid-scroll does not; sheets:
// swipe up or down = back. Runs on the preview (mock data): PREVIEW=http://localhost:5181
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const BASE = ORIGIN + '/?preview=1';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const items = async (p) => p.evaluate(async () => (await import('/js/store.js')).store.items().map((x) => ({ id: x.id, kind: x.kind, title: x.title, pages: x.pages, len: (x.text || '').length })));
const open = async (p, id, wait = 1200) => { await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await p.evaluate((i) => { location.hash = '#/item/' + i; }, id); await sleep(wait); };
const hash = (p) => p.evaluate(() => location.hash);
const pos = (p) => p.$eval('#sc-pos', (e) => +e.value);
const swipe = async (p, x0, y0, x1, y1, steps = 6) => {
  await p.touchscreen.touchStart(x0, y0);
  for (let i = 1; i <= steps; i++) await p.touchscreen.touchMove(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await p.touchscreen.touchEnd(); await sleep(900);
};

// ---------- Mac: click and drag the orange line ----------
const m = await b.newPage(); m.on('pageerror', (e) => errs.push(e.message)); await m.setViewport({ width: 1440, height: 900 });
await m.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const all = await items(m);
const score = all.find((x) => x.kind === 'score'), chords = all.filter((x) => x.kind === 'chords').sort((a, c) => c.len - a.len)[0], sheet = all.find((x) => x.kind === 'sheet' && x.pages > 1);
await open(m, score.id, 3500);
check('score drawn', (await m.$$('#osmd svg')).length > 0);
const sys = await m.$$eval('#osmd svg g.staffline, #osmd svg .vf-stave', (e) => e.map((g) => { const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }).filter((r) => r.w > 200));
check('found the staff lines', sys.length > 1, sys.length);
const line2 = sys.find((r) => r.y > sys[0].y + 20) || sys[0];
await m.mouse.click(line2.x + line2.w * 0.5, line2.y + line2.h / 2); await sleep(400);
const q1 = await pos(m);
check('click on the music moves the line there', q1 > 2, q1);
check('the orange line shows', await m.$eval('.playbar', (e) => getComputedStyle(e).display === 'block'));
const bx = await m.$eval('.playbar', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await m.mouse.move(bx.x, bx.y); await m.mouse.down(); await m.mouse.move(bx.x + 120, bx.y, { steps: 6 }); await m.mouse.up(); await sleep(300);
const q2 = await pos(m);
check('dragging the line moves it later', q2 > q1, `${q1} → ${q2}`);
await m.click('#sc-play'); await sleep(700);
const q3 = await pos(m);
check('Play starts from the line, not from the top', q3 >= q2 && q3 < q2 + 4, `${q2} → ${q3}`);
await m.click('#sc-play'); await sleep(200);
await m.mouse.click(line2.x + 20, sys[0].y + sys[0].h / 2); await sleep(300);
check('click near the start of a line goes back', (await pos(m)) < q2, await pos(m));

// ---------- iPhone: swipes ----------
const t = await b.newPage(); t.on('pageerror', (e) => errs.push(e.message)); await t.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
await t.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
await t.evaluate(() => localStorage.setItem('meowsic-chord-size', '40'));
await open(t, chords.id);
// the sample charts are short: make this one long enough to scroll on a phone (preview data only)
await t.evaluate(async (id) => { const { store } = await import('/js/store.js'); const it = store.get(id); store.update(id, { text: Array(8).fill(it.text).join('\n') }); }, chords.id); await sleep(500);
const host = () => t.$eval('#it-body', (e) => ({ top: e.scrollTop, h: e.clientHeight, max: e.scrollHeight - e.clientHeight }));
let h0 = await host();
check('chords scroll on a phone', h0.max > 300, JSON.stringify(h0));
await swipe(t, 300, 500, 80, 510);
let h1 = await host();
check('chords: swipe left = one screen down', Math.abs(h1.top - (h0.h - 60)) < 30, JSON.stringify(h1));
await swipe(t, 300, 500, 80, 510);
await swipe(t, 80, 500, 300, 505);
const h2 = await host();
check('chords: swipe right = one screen up', Math.abs(h2.top - h1.top) < 30, `${h1.top} vs ${h2.top}`);
await t.evaluate(() => { document.querySelector('#it-body').scrollTop = 40; }); await sleep(200);
await swipe(t, 200, 700, 200, 450);
check('chords: swipe up mid-way just scrolls (stays)', (await hash(t)).startsWith('#/item/'), await hash(t));
await t.evaluate(() => { const e = document.querySelector('#it-body'); e.scrollTop = e.scrollHeight; }); await sleep(300);
await swipe(t, 200, 700, 200, 450);
check('chords: swipe up at the end = back to the library', (await hash(t)) === '#/library', await hash(t));

await open(t, score.id, 3500);
h0 = await host();
await swipe(t, 330, 600, 90, 610);
h1 = await host();
check('score: swipe left = one screen down', h0.max < 50 || Math.abs(h1.top - Math.min(h0.max, h0.h - 60)) < 30, JSON.stringify([h0, h1]));
await t.evaluate(() => { document.querySelector('#it-body').scrollTop = 0; }); await sleep(300);
// put the line somewhere, then drag it sideways with a finger: moves the line, no page flip
const sys2 = await t.$$eval('#osmd svg g.staffline, #osmd svg .vf-stave', (e) => e.map((g) => { const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }).filter((r) => r.w > 100 && r.y > 120));
await t.touchscreen.tap(sys2[0].x + 40, sys2[0].y + sys2[0].h / 2); await sleep(400);
const tq = await pos(t);
const tb = await t.$eval('.playbar', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const before = (await host()).top;
await swipe(t, tb.x, tb.y, Math.min(370, tb.x + 160), tb.y);
check('score: finger drag of the line moves it', (await pos(t)) > tq, `${tq} → ${await pos(t)}`);
check('score: …and does not flip the page', Math.abs((await host()).top - before) < 5, `${before} → ${(await host()).top}`);
check('score: still on the score', (await hash(t)).startsWith('#/item/'));

await open(t, sheet.id);
const pg = await t.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await swipe(t, pg.x, pg.y - 150, pg.x, pg.y + 150);
check('sheet: swipe down = back to the library', (await hash(t)).startsWith('#/library'), await hash(t));
await open(t, sheet.id);
await swipe(t, pg.x, pg.y + 150, pg.x, pg.y - 150);
check('sheet: swipe up = back to the library', (await hash(t)) === '#/library', await hash(t));

console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
