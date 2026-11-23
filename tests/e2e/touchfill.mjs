// iPad / iPhone sheet + book viewer uses the whole screen: the page picture fills the width or the
// height of the area under the top bar (fit, aspect kept), edge to edge. Turning, zoom, ink and the
// top bar still work; the Mac layout keeps its |‹| page |›| strips. Clean up: books get no trim.
// Needs a test server with a multi-page sheet and a book: FILL_BASE=http://localhost:5194/ (never :5180)
import puppeteer from 'puppeteer-core';
const BASE = process.env.FILL_BASE || 'http://localhost:5190/';
const out = process.env.OUT || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const p0 = await b.newPage(); await p0.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const all = await p0.evaluate(() => fetch('/api/items').then((r) => r.json()));
const sheet = all.find((x) => x.kind === 'sheet' && !x.book && x.pages > 1), book = all.find((x) => x.kind === 'sheet' && x.book);
check('test data: a sheet and a book', sheet && book);

// how much smaller the page picture is than the area under the top bar
const measure = (p) => p.evaluate(() => {
  const top = document.querySelector('.item-top').getBoundingClientRect();
  const host = document.querySelector('#it-body').getBoundingClientRect();
  const img = document.querySelector('.page img').getBoundingClientRect();
  const W = Math.round(host.width), H = Math.round(innerHeight - top.bottom);
  return { top: Math.round(top.height), W, H, w: Math.round(img.width), h: Math.round(img.height), dw: Math.round(W - img.width), dh: Math.round(H - img.height),
    x: Math.round(img.left - host.left), y: Math.round(img.top - top.bottom) };
});
const devices = [['ipad-1366', 1366, 1024], ['ipad-1180', 1180, 820], ['ipad-port', 820, 1180], ['iphone', 390, 844]];
for (const [name, w, h] of devices) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  for (const it of [sheet, book]) {
    await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
    await p.evaluate((id) => { location.hash = '#/item/' + id; }, it.id); await sleep(1200);
    await p.evaluate(async () => { const s = await import('/js/store.js'); }); // ensure loaded
    const m = await measure(p);
    const tag = `${name} ${it.book ? 'book' : 'sheet'}`;
    console.log(`  ${tag}: area ${m.W}×${m.H} (top bar ${m.top}), page ${m.w}×${m.h} → smaller by ${m.dw} × ${m.dh} px`);
    await p.screenshot({ path: `${out}/fill-${name}-${it.book ? 'book' : 'sheet'}.png` });
    check(`${tag}: page fills the width or the height`, Math.min(m.dw, m.dh) <= 2, JSON.stringify(m));
    check(`${tag}: page centred`, Math.abs(m.x * 2 - m.dw) <= 2 && Math.abs(m.y * 2 - m.dh) <= 2, JSON.stringify(m));
    const vis = await p.$$eval('.item-top .back, #it-title, #it-more', (e) => e.map((x) => x.getBoundingClientRect().width > 0));
    check(`${tag}: ‹ Back, title, ⋯ show`, vis.length === 3 && vis.every(Boolean));
    const strips = await p.$$eval('.turn-strip', (e) => e.map((x) => getComputedStyle(x).display));
    check(`${tag}: no ‹ › turn strips`, strips.length === 2 && strips.every((d) => d === 'none'), strips.join());
    if (!it.book) continue;
    // swipe left turns, tap on the right edge turns, tap on the left edge goes back
    const no = () => p.$eval('#pageno', (e) => e.textContent);
    const c = await p.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.left, r: r.right }; });
    await p.touchscreen.touchStart(c.x + 100, c.y); await p.touchscreen.touchMove(c.x, c.y); await p.touchscreen.touchMove(c.x - 100, c.y); await p.touchscreen.touchEnd(); await sleep(400);
    check(`${tag}: swipe left → page 2`, (await no()).startsWith('Page 2'), await no());
    await p.touchscreen.tap(c.r - 6, c.y); await sleep(400);
    check(`${tag}: tap at the right edge → page 3`, (await no()).startsWith('Page 3'), await no());
    await p.touchscreen.tap(c.l + 6, c.y); await sleep(400);
    check(`${tag}: tap at the left edge → page 2`, (await no()).startsWith('Page 2'), await no());
    // zoom in still scrolls, reset fits again (iPhone has no zoom buttons)
    if (await p.$eval('#sv-zin', (e) => e.getBoundingClientRect().width > 0)) {
      await p.click('#sv-zin'); await sleep(400);
      check(`${tag}: zoom in`, await p.$eval('.pages', (e) => e.classList.contains('zoomed') && e.scrollHeight > e.clientHeight));
      await p.click('#sv-zreset'); await sleep(400);
      const z = await measure(p);
      check(`${tag}: reset zoom fits again`, Math.min(z.dw, z.dh) <= 2, JSON.stringify(z));
    }
    // ink
    await p.click('#sv-ink'); await sleep(300);
    check(`${tag}: pen bar opens`, !!(await p.$('.inkbar')) && !!(await p.$('.ink.active')));
    await p.click('#sv-ink'); await sleep(200);
    check(`${tag}: pen bar closes`, !(await p.$('.inkbar')));
  }
  await p.close();
}
// Mac: |‹| page |›| strips and padding unchanged
const m = await b.newPage(); m.on('pageerror', (e) => errs.push(e.message)); await m.setViewport({ width: 1440, height: 900 });
await m.goto(BASE + '#/item/' + sheet.id, { waitUntil: 'networkidle0' }); await sleep(800);
const mac = await m.evaluate(() => ({ strip: document.querySelector('.turn-strip.prev').getBoundingClientRect().width, pad: getComputedStyle(document.querySelector('.pages')).padding, top: document.querySelector('.item-top').getBoundingClientRect().height }));
console.log('  mac:', JSON.stringify(mac), JSON.stringify(await measure(m)));
await m.screenshot({ path: `${out}/fill-mac-sheet.png` });
check('Mac: 40px turn strips', mac.strip === 40, JSON.stringify(mac));
check('Mac: page padding 4px 48px', mac.pad === '4px 48px', mac.pad);

// Clean up: a book gets no trim suggestions, is never waiting for the scan, still shows in Go through sheets
const cu = await m.evaluate(() => fetch('/api/cleanup').then((r) => r.json()));
const cb = cu.songs.find((s) => s.id === book.id);
check('Clean up: book has no trim issue', cb && !cb.issues.some((i) => i.kind === 'trim'), JSON.stringify(cb?.issues));
check('Clean up: book pages have no trim / box', cb && cb.pages.every((p) => !p.trim && !p.box && p.scanned));
await m.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(800);
await m.evaluate(() => document.querySelector('[data-tab="sort"]').click()); await sleep(600);
await m.evaluate(() => document.querySelector('[data-show="all"]')?.click()); await sleep(300);
let found = false;
for (let k = 0; k < cu.songs.length && !found; k++) {
  found = (await m.$eval('.sv-title b', (e) => e.textContent)) === book.title;
  if (!found) { await m.click('#sv-next'); await sleep(250); }
}
check('Clean up: book still in Go through sheets', found);
check('Clean up: book not counted in Fix pages', !(await m.$eval('#cu-nf', (e) => e.textContent)) || !cb.issues.length);
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
