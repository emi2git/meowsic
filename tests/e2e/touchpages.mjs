// iPad / iPhone: scores and chord charts never scroll; they are pages like a sheet (swipe / edge tap
// turns, "Page n of N", swipe up / down = back), recomputed on rotation; playback turns the page.
// Note-names toggle (A B C) is off by default and remembered; default zoom 100%. Mac still scrolls.
// Needs a server with a long score ("One Day More"), a Meowsic AI score and a chord chart long
// enough for several pages: BASE=http://localhost:5224/ OUT=<dir for screenshots>
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5224/';
const OUT = process.env.OUT || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const p0 = await b.newPage(); await p0.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const all = await p0.evaluate(() => fetch('/api/items').then((r) => r.json()).then((d) => (Array.isArray(d) ? d : d.items)));
await p0.close();
const long = all.find((x) => x.kind === 'score' && /^One Day More/.test(x.title));
const ai = all.find((x) => x.kind === 'score' && (x.ai || x.source === 'Meowsic AI'));
const chords = all.filter((x) => x.kind === 'chords').sort((a, c) => (c.text || '').length - (a.text || '').length)[0];
if (!long || !ai || !chords) { console.log('missing test items', !!long, !!ai, !!chords); process.exit(1); }

const open = async (p, id, wait) => { await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await p.evaluate((i) => { location.hash = '#/item/' + i; }, id); await sleep(wait); };
const label = (p) => p.$eval('#pageno', (e) => e.textContent).catch(() => '');
const pg = async (p) => { const m = /Page (\d+) of (\d+)/.exec(await label(p)) || []; return { n: +m[1] || 0, of: +m[2] || 0 }; };
const noScroll = (p) => p.evaluate(() => {
  const els = [document.scrollingElement, document.querySelector('#main'), document.querySelector('#it-body')];
  return els.every((e) => !e || e.scrollHeight <= e.clientHeight + 1);
});
// the page (window) fits the area under the top bar
const fits = (p, sel) => p.evaluate((sel) => { const a = document.querySelector('#it-body').getBoundingClientRect(), c = document.querySelector(sel).getBoundingClientRect(); return c.bottom <= a.bottom + 1 && c.top >= a.top - 1; }, sel);
const swipe = async (p, x0, y0, x1, y1) => {
  await p.touchscreen.touchStart(x0, y0);
  for (let i = 1; i <= 6; i++) await p.touchscreen.touchMove(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6);
  await p.touchscreen.touchEnd(); await sleep(500);
};
const hash = (p) => p.evaluate(() => location.hash);

for (const [name, w, h] of [['ipad-port', 1032, 1376], ['ipad-land', 1376, 1032], ['iphone', 420, 912]]) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await p.evaluate(() => { localStorage.clear(); });
  // ---- score ----
  await open(p, long.id, 4000);
  let s = await pg(p);
  check(`${name} score: "Page 1 of N" in the top bar, N > 1`, s.n === 1 && s.of > 1, await label(p));
  check(`${name} score: nothing scrolls`, await noScroll(p));
  check(`${name} score: the page fits under the top bar`, await fits(p, '#clip'));
  await p.screenshot({ path: `${OUT}/pages-${name}-score-p1.png` });
  const r = await p.$eval('#paper', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
  const cy = r.y + r.h / 2;
  await swipe(p, r.x + r.w * 0.75, cy, r.x + r.w * 0.2, cy + 5);
  check(`${name} score: swipe left = next page`, (await pg(p)).n === 2, await label(p));
  check(`${name} score: still nothing scrolls on page 2`, await noScroll(p));
  await p.screenshot({ path: `${OUT}/pages-${name}-score-p2.png` });
  await swipe(p, r.x + r.w * 0.2, cy, r.x + r.w * 0.75, cy + 5);
  check(`${name} score: swipe right = previous page`, (await pg(p)).n === 1, await label(p));
  await p.touchscreen.tap(r.x + r.w - 8, cy); await sleep(300);
  check(`${name} score: tap the right edge = next page`, (await pg(p)).n === 2, await label(p));
  await p.touchscreen.tap(r.x + 8, cy); await sleep(300);
  check(`${name} score: tap the left edge = previous page`, (await pg(p)).n === 1, await label(p));
  check(`${name} score: zoom is 100%`, name === 'iphone' || (await p.$eval('#sc-zreset', (e) => e.textContent)) === '100%', await p.$eval('#sc-zreset', (e) => e.textContent).catch(() => '-'));
  await swipe(p, r.x + r.w / 2, cy + 150, r.x + r.w / 2, cy - 150);
  check(`${name} score: swipe up = back to the library`, (await hash(p)) === '#/library', await hash(p));
  await open(p, long.id, 4000);
  await swipe(p, r.x + r.w / 2, cy - 150, r.x + r.w / 2, cy + 150);
  check(`${name} score: swipe down = back to the library`, (await hash(p)).startsWith('#/library'), await hash(p));
  // ---- chord chart ----
  await open(p, chords.id, 1500);
  if (name === 'ipad-land') { await p.evaluate(() => localStorage.setItem('meowsic-chord-size', '30')); await open(p, chords.id, 1500); }
  s = await pg(p);
  check(`${name} chords: "Page 1 of N", N > 1`, s.n === 1 && s.of > 1, await label(p));
  check(`${name} chords: nothing scrolls`, await noScroll(p));
  check(`${name} chords: the page fits under the diagrams`, await fits(p, '#lclip'));
  await p.screenshot({ path: `${OUT}/pages-${name}-chords-p1.png` });
  const c = await p.$eval('#lbox', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
  const ccy = c.y + c.h / 2;
  await swipe(p, w * 0.8, ccy, w * 0.2, ccy);
  check(`${name} chords: swipe left = next page`, (await pg(p)).n === 2, await label(p));
  const t2 = await p.$eval('#lyrics', (e) => e.style.transform);
  check(`${name} chords: page 2 shows later lines`, /translateY\(-\d/.test(t2), t2);
  await p.screenshot({ path: `${OUT}/pages-${name}-chords-p2.png` });
  await p.touchscreen.tap(w * 0.2, ccy); await sleep(300);
  check(`${name} chords: tap the left half = previous page`, (await pg(p)).n === 1, await label(p));
  const of0 = (await pg(p)).of;
  await p.click('#cv-lg'); await p.click('#cv-lg'); await sleep(400);
  check(`${name} chords: bigger text = more pages, still no scroll`, (await pg(p)).of > of0 && await noScroll(p), `${of0} → ${(await pg(p)).of}`);
  await p.click('#cv-reset'); await sleep(200);
  await p.close();
}

// ---- rotation recomputes ----
{
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(`rotate: ${e.message}`));
  await p.setViewport({ width: 1032, height: 1376, hasTouch: true, isMobile: true });
  await open(p, long.id, 4000);
  const a = await pg(p);
  const geo = () => p.evaluate(() => ({ w: Math.round(document.querySelector('#osmd svg').getBoundingClientRect().width), clip: Math.round(document.querySelector('#clip').getBoundingClientRect().height) }));
  const ga = await geo();
  await p.setViewport({ width: 1376, height: 1032, hasTouch: true, isMobile: true }); await sleep(2000);
  const l = await pg(p), gl = await geo();
  check('rotate to landscape: laid out again to the new width and re-paged', l.of > 0 && gl.w > ga.w + 200 && gl.clip !== ga.clip && await noScroll(p) && await fits(p, '#clip'), JSON.stringify([a, ga, l, gl]));
  await p.screenshot({ path: `${OUT}/pages-rotated-landscape.png` });
  await p.setViewport({ width: 1032, height: 1376, hasTouch: true, isMobile: true }); await sleep(2000);
  check('rotate back: same pages as before', (await pg(p)).of === a.of, `${a.of} vs ${(await pg(p)).of}`);
  await open(p, chords.id, 1500);
  const ca = await pg(p);
  await p.setViewport({ width: 1376, height: 1032, hasTouch: true, isMobile: true }); await sleep(1200);
  check('chords: rotate recomputes pages', (await pg(p)).of > ca.of && await noScroll(p), `${ca.of} → ${(await pg(p)).of}`);

  // ---- playback follows into the next page ----
  await p.setViewport({ width: 1032, height: 1376, hasTouch: true, isMobile: true });
  await open(p, long.id, 4000);
  const seek = (q) => p.$eval('#sc-pos', (e, q) => { e.value = q; e.dispatchEvent(new Event('input', { bubbles: true })); }, q);
  let q2 = 0;
  for (let q = 1; q < 400; q++) { await seek(q); if ((await pg(p)).n === 2) { q2 = q; break; } }
  check('seeking past page 1 shows page 2', q2 > 0, q2);
  await seek(q2 - 2); await sleep(200);
  check('seek back: page 1 again', (await pg(p)).n === 1, await label(p));
  await p.click('#sc-play'); await sleep(4500);
  const played = await p.$eval('#sc-pos', (e) => +e.value);
  check('playing past the last line turns the page', played >= q2 && (await pg(p)).n === 2, `${played} / ${q2} ${await label(p)}`);
  const vis = await p.evaluate(() => { const b = document.querySelector('.playbar').getBoundingClientRect(), c = document.querySelector('#clip').getBoundingClientRect(); return b.top >= c.top - 2 && b.bottom <= c.bottom + 2 && getComputedStyle(document.querySelector('.playbar')).display === 'block'; });
  check('the orange line is on the page shown', vis);
  await p.screenshot({ path: `${OUT}/pages-playing-p2.png` });
  await p.click('#sc-play'); await sleep(200);
  // tap the music on page 2 moves the line there (a beat on page 2)
  const st = await p.$$eval('#osmd svg g.staffline, #osmd svg .vf-stave', (e) => e.map((g) => { const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const clipR = await p.$eval('#clip', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const onPage = st.filter((r) => r.w > 100 && r.y > clipR.top + 10 && r.y + r.h < clipR.bottom - 10);
  const tgt = onPage[Math.floor(onPage.length / 2)];
  await p.touchscreen.tap(tgt.x + tgt.w / 2, tgt.y + tgt.h / 2); await sleep(400);
  const tq = await p.$eval('#sc-pos', (e) => +e.value);
  check('tap on page 2 music moves the line to a beat on page 2', tq >= q2 - 1 && (await pg(p)).n === 2, `${tq} (page 2 from ${q2}) ${await label(p)}`);
  await p.close();
}

// ---- note-names toggle + default zoom ----
{
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(`names: ${e.message}`));
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await p.evaluate(() => localStorage.clear());
  await open(p, ai.id, 3500);
  const st = () => p.evaluate(() => ({ on: document.querySelector('#sc-names')?.classList.contains('on'), pressed: document.querySelector('#sc-names')?.getAttribute('aria-pressed'), letters: document.querySelectorAll('#osmd text.nl').length, kbds: document.querySelectorAll('#osmd g.kbd').length, zoom: document.querySelector('#sc-zreset')?.textContent, title: [...document.querySelectorAll('#osmd svg text')].map((t) => t.textContent) }));
  let s = await st();
  check('AI score: default zoom 100%', s.zoom === '100%', s.zoom);
  check('AI score: note names off by default (classic look)', s.on === false && s.letters === 0 && s.kbds === 0, JSON.stringify(s));
  check('AI score: OSMD draws the title and "Meowsic AI" as composer', s.title.includes(ai.title) && s.title.includes('Meowsic AI'), s.title.slice(0, 5).join(' | '));
  await p.screenshot({ path: `${OUT}/pages-mac-ai-classic.png` });
  await p.click('#sc-names'); await sleep(1500);
  s = await st();
  check('A B C button: on lights up, letters in the noteheads', s.on && s.pressed === 'true' && s.letters > 10, JSON.stringify({ ...s, title: 0 }));
  check('A B C on: keyboard diagrams under the title', s.kbds > 0, s.kbds);
  await p.screenshot({ path: `${OUT}/pages-mac-ai-names.png` });
  await open(p, ai.id, 3500);
  s = await st();
  check('A B C stays on when reopened', s.on && s.letters > 10, JSON.stringify({ ...s, title: 0 }));
  await p.click('#sc-names'); await sleep(1500);
  await open(p, ai.id, 3500);
  s = await st();
  check('A B C off stays off when reopened', !s.on && s.letters === 0 && s.kbds === 0, JSON.stringify({ ...s, title: 0 }));
  // every score has it
  await open(p, long.id, 4000);
  check('A B C button on a non-AI score too', !!(await p.$('#sc-names')));
  // Mac: still scrolls, no page number
  check('Mac: the score scrolls (no pages)', await p.$eval('#it-body', (e) => e.scrollHeight > e.clientHeight + 100) && !(await p.$('#pageno')));
  await p.close();
}
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
