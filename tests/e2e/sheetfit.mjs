// Mac sheet viewer: one or two pages, chosen from the zoom and the window (the user's ask, 2026-11-26).
// - Two pages side by side while both fit at the current zoom; zoomed in (or a narrow window) → one page.
// - ‹ › / page-half clicks / keys step by what is shown: 1 page in one-page mode, a spread (2) in two-page mode.
// - Switching keeps the page being read in view. The "3 / 7" / "3–4 / 7" count matches. Odd count: last page alone.
// - iPad keeps one page and its ±1 turns.
// Preview suite: PREVIEW=http://127.0.0.1:<port> (scripts/dev-server --preview).
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const ORIGIN = (process.env.PREVIEW || process.env.BASE || 'http://localhost:5181').replace(/\/+$/, '');
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };
const errs = [];
const N = 7;

async function open(p) {
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' });
  await p.evaluate(async (N) => { localStorage.clear(); const d = (await import('/js/mock.js')).buildMock(); const it = d.items.find((x) => x.id === 's-001'); it.pages = N; delete it.pageFiles; localStorage.setItem('meowsic-mock-v6', JSON.stringify(d)); }, N);
  await p.reload({ waitUntil: 'networkidle0' });
  await p.evaluate(() => (location.hash = '#/item/s-001')); await sleep(1200);
}
const shown = (p) => p.$$eval('#pages .page', (e) => e.map((x) => x.dataset.p).join('–'));
const dots = (p) => p.$$eval('#sv-dots i.on', (e) => e.map((x) => x.dataset.p).join('–'));
const cnt = (p) => p.$eval('#sv-count', (e) => e.textContent).catch(() => '');
const zl = (p) => p.$eval('#sv-zreset', (e) => e.textContent);
const state = async (p) => `${await shown(p)} [${await cnt(p)}] ${await zl(p)}`;
const go = async (p, sel) => { await p.click(sel); await sleep(300); };
// the shown pages sit side by side inside the page window's width
const sideBySide = (p) => p.$eval('#pages', (e) => { const r = e.getBoundingClientRect(), ps = [...e.querySelectorAll('.page')].map((x) => x.getBoundingClientRect()); return ps.length === 2 && ps[0].right <= ps[1].left + 1 && ps[0].left >= r.left - 1 && ps[1].right <= r.right + 1; });

{
  console.log('Mac: wide window');
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1680, height: 900, deviceScaleFactor: 1 });
  await open(p);
  check('device = desktop', (await p.evaluate(() => document.documentElement.dataset.device)) === 'desktop');
  check('100%: two pages, count "1–2 / 7"', (await shown(p)) === '1–2' && (await cnt(p)) === `1–2 / ${N}` && (await dots(p)) === '1–2' && (await sideBySide(p)), await state(p));
  await go(p, '.turn-strip.next');
  check('› moves a spread: 3–4', (await shown(p)) === '3–4' && (await cnt(p)) === `3–4 / ${N}`, await state(p));
  await p.keyboard.press('ArrowRight'); await sleep(300);
  check('→ key: 5–6', (await shown(p)) === '5–6', await state(p));
  await p.keyboard.press('PageDown'); await sleep(300);
  check('odd count: last page alone "7 / 7", › off', (await shown(p)) === '7' && (await cnt(p)) === `7 / ${N}` && (await p.$eval('.turn-strip.next', (e) => e.disabled)), await state(p));
  await p.keyboard.press('PageUp'); await sleep(300);
  check('Page Up back a spread: 5–6', (await shown(p)) === '5–6', await state(p));
  await go(p, '.turn-strip.prev');
  check('‹ back: 3–4', (await shown(p)) === '3–4', await state(p));

  // zoom in until two pages no longer fit
  let z = 0;
  while ((await shown(p)).includes('–') && z++ < 6) await go(p, '#sv-zin');
  const zoomed = await zl(p);
  check('zoomed in until two do not fit → one page, the left page of the spread stays: "3 / 7"', (await shown(p)) === '3' && (await cnt(p)) === `3 / ${N}` && (await dots(p)) === '3' && zoomed !== '100%', await state(p));
  check('one page is bigger than at 100% (really zoomed)', await p.$eval('#pages', (e) => e.classList.contains('zoomed')));
  await go(p, '.turn-strip.next');
  check('one page: › moves 1 → "4 / 7"', (await shown(p)) === '4' && (await cnt(p)) === `4 / ${N}`, await state(p));
  await p.keyboard.press('ArrowRight'); await sleep(300);
  check('one page: → moves 1 → 5', (await shown(p)) === '5', await state(p));
  await p.keyboard.press('ArrowLeft'); await sleep(300);
  check('one page: ← moves 1 → 4', (await shown(p)) === '4', await state(p));
  await go(p, '.turn-strip.prev');
  check('one page: ‹ moves 1 → 3', (await shown(p)) === '3', await state(p));
  await go(p, '.turn-strip.next');
  // page-half click: right half → next (one page), left half → previous
  { const r = await p.$eval('#pages', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    // a click (no drag): zoomed pages pan on a drag, a still click turns
    const a = await p.$eval('.page', (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const y = Math.min(a.y + 60, r.y + r.h - 40);
    await p.mouse.click(Math.min(a.x + a.w * 0.85, r.x + r.w - 10), y); await sleep(300);
    check('one page: click right half → 5', (await shown(p)) === '5', await state(p));
    await p.mouse.click(Math.max(a.x + a.w * 0.15, r.x + 10), y); await sleep(300);
    check('one page: click left half → 4', (await shown(p)) === '4', await state(p)); }

  // zoom back out: two pages, still on page 4 (its spread 3–4)
  while ((await zl(p)) !== '100%') await go(p, '#sv-zout');
  check('zoom back to 100% → two pages, page 4 still shown: "3–4 / 7"', (await shown(p)) === '3–4' && (await cnt(p)) === `3–4 / ${N}`, await state(p));
  // and in again: back on page 4 (the page being read), not 3
  await p.evaluate(() => (location.hash = '#/library')); await sleep(300);
  await p.evaluate(() => (location.hash = '#/item/s-001')); await sleep(1000);
  check('reopen: 1–2 at 100%', (await shown(p)) === '1–2', await state(p));
  await go(p, '#sv-dots i[data-p="4"]');
  check('dot 4 at 100% → spread 3–4', (await shown(p)) === '3–4', await state(p));
  for (let i = 0; i < z; i++) await go(p, '#sv-zin');
  check('zoom in again → one page, page 4 (the one picked) stays', (await shown(p)) === '4' && (await cnt(p)) === `4 / ${N}`, await state(p));
  // last page in one-page mode
  for (let i = 0; i < 5; i++) await go(p, '.turn-strip.next');
  check('one page: ends on 7, › off', (await shown(p)) === '7' && (await p.$eval('.turn-strip.next', (e) => e.disabled)), await state(p));
  while ((await zl(p)) !== '100%') await go(p, '#sv-zout');
  check('zoom out on 7 → two-page mode shows 7 alone', (await shown(p)) === '7' && (await cnt(p)) === `7 / ${N}`, await state(p));
  await go(p, '.turn-strip.prev');
  check('‹ from 7 → 5–6', (await shown(p)) === '5–6', await state(p));

  // window resize decides too: at one zoom step in, a wide window holds two, a narrower one only one
  await go(p, '#sv-zin');
  await p.setViewport({ width: 2400, height: 900, deviceScaleFactor: 1 }); await sleep(600);
  check(`very wide window at ${await zl(p)}: two pages`, (await shown(p)) === '5–6' && (await sideBySide(p)), await state(p));
  await p.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 }); await sleep(600);
  check('narrow the window → one page, page 5 stays', (await shown(p)) === '5' && (await cnt(p)) === `5 / ${N}`, await state(p));
  await go(p, '.turn-strip.next');
  check('narrow: › moves 1 → 6', (await shown(p)) === '6', await state(p));
  await p.setViewport({ width: 2400, height: 900, deviceScaleFactor: 1 }); await sleep(600);
  check('widen again → two pages 5–6 (page 6 in view)', (await shown(p)) === '5–6' && (await cnt(p)) === `5–6 / ${N}`, await state(p));
  await p.close();
}

{
  console.log('iPad: one page, ±1 (unchanged)');
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1366, height: 1024, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await open(p);
  check('device = tablet', (await p.evaluate(() => document.documentElement.dataset.device)) === 'tablet');
  check('iPad: one page, no count text', (await shown(p)) === '1' && (await cnt(p)) === '', await state(p));
  await p.keyboard.press('ArrowRight'); await sleep(300);
  check('iPad: → moves 1', (await shown(p)) === '2', await state(p));
  await p.close();
}

check('no page errors', !errs.length, errs.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
