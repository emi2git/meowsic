// iPad / iPhone sheet + book viewer uses the whole screen: the page picture fills the width or the
// height of the area under the top bar (fit, aspect kept), edge to edge. Turning, zoom, ink and the
// top bar still work; the Mac layout keeps its |‹| page |›| strips. Clean up: books are not in it.
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
// FILL_SHEET=<id> picks the sheet (e.g. s-9aaebd3, With One Look: once opened overflowing at "100%")
const sheet = all.find((x) => x.id === process.env.FILL_SHEET) || all.find((x) => x.kind === 'sheet' && !x.book && x.pages > 1), book = all.find((x) => x.kind === 'sheet' && x.book);
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
const devices = [['ipad-1032', 1032, 1376], ['ipad-1366', 1366, 1024], ['ipad-1180', 1180, 820], ['ipad-port', 820, 1180], ['iphone', 390, 844]];
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
    check(`${tag}: opens at 100% (fit)`, name === 'iphone' || (await p.$eval('#sv-zreset', (e) => e.textContent)) === '100%');
    check(`${tag}: no "Page n of N" text`, !(await p.$('#pageno')));
    const dots = await p.evaluate(() => { const d = document.querySelector('#sv-dots'), f = d.closest('.sheet-frame').getBoundingClientRect(), r = [...d.children].map((i) => i.getBoundingClientRect());
      return { n: r.length, on: d.querySelectorAll('i.on').length, mid: Math.round((r[0].left + r.at(-1).right) / 2 - (f.left + f.width / 2)), bottom: Math.round(f.bottom - r[0].bottom), size: r[0].width }; });
    check(`${tag}: thin page dots centered at the bottom, current one filled`, dots.n === it.pages && dots.on === 1 && Math.abs(dots.mid) <= 2 && dots.bottom >= 0 && dots.bottom <= 8 && dots.size <= 6, JSON.stringify(dots));
    if (!it.book) continue;
    // swipe left turns, tap on the right edge turns, tap on the left edge goes back
    // the shown page = the filled page dot (no "Page n of N" text in the top bar)
    const no = () => p.$$eval('#sv-dots i.on', (e) => 'Page ' + e.map((x) => x.dataset.p).join('–'));
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
      check(`${tag}: zoom in → 125%, scrolls`, (await p.$eval('#sv-zreset', (e) => e.textContent)) === '125%' && await p.$eval('.pages', (e) => e.classList.contains('zoomed') && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)));
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
// a page turn on a sheet of big photos (2000×2800 JPEGs, other shapes than the 850×1100 default):
// the new page shows straight at its final size — no frame where the page box is bigger first
{
  const up = await b.newPage(); await up.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  const big = await up.evaluate(async () => {
    const fd = new FormData();
    for (let i = 1; i <= 4; i++) {
      const c = document.createElement('canvas'); c.width = i === 3 ? 2100 : 2000; c.height = i === 3 ? 2700 : 2800;
      const x = c.getContext('2d'), d = x.createImageData(c.width, c.height);
      for (let k = 0; k < d.data.length; k++) d.data[k] = (k & 3) === 3 ? 255 : (Math.random() * 255) | 0;
      x.putImageData(d, 0, 0);
      fd.append('files', await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)), `big ${i}.jpg`);
    }
    fd.append('title', 'Touchfill big photos');
    const r = await fetch('/api/sheets', { method: 'POST', body: fd });
    return r.ok ? (await r.json()).item : null;
  });
  check('big photo sheet uploaded', big && big.pages === 4, JSON.stringify(big)?.slice(0, 200));
  for (const [w, h] of big ? [[1032, 1376], [1376, 1032]] : []) {
    const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
    await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
    await p.evaluate((id) => { location.hash = '#/item/' + id; }, big.id); await sleep(2500);
    await p.evaluate(() => {
      window.__f = [];
      const tick = () => { const pg = document.querySelector('.page'); if (pg) { const r = pg.getBoundingClientRect(); window.__f.push([pg.dataset.p, r.width, r.height]); } requestAnimationFrame(tick); };
      tick();
    });
    const c = await p.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.right }; });
    await p.touchscreen.touchStart(c.x + 100, c.y); await p.touchscreen.touchMove(c.x, c.y); await p.touchscreen.touchMove(c.x - 100, c.y); await p.touchscreen.touchEnd();
    for (let i = 0; i < 6; i++) { await p.screenshot({ path: `${out}/fill-turn-${w}-${i}.png` }); await sleep(30); }
    await sleep(1500);
    await p.touchscreen.tap(c.r - 6, c.y); await sleep(2500);
    const f = await p.evaluate(() => window.__f);
    for (const n of ['2', '3']) {
      const fr = f.filter((x) => x[0] === n), [, fw, fh] = fr.at(-1) || [];
      const over = fr.filter((x) => x[1] > fw + 1 || x[2] > fh + 1);
      check(`${w}×${h}: turn to page ${n} — page box never bigger than its final ${Math.round(fw)}×${Math.round(fh)}`, fr.length && !over.length, JSON.stringify(over.slice(0, 3)));
    }
    check(`${w}×${h}: next page (4) preloaded while on page 3`, await p.evaluate((n) => performance.getEntriesByType('resource').some((r) => decodeURIComponent(r.name).includes(n)), big.id + '/pages/4?'));
    await p.close();
  }
  if (big) await up.evaluate((id) => fetch('/api/items/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }), big.id);
  await up.close();
}

// Mac: |‹| page |›| strips and padding unchanged
const m = await b.newPage(); m.on('pageerror', (e) => errs.push(e.message)); await m.setViewport({ width: 1440, height: 900 });
await m.goto(BASE + '#/item/' + sheet.id, { waitUntil: 'networkidle0' }); await sleep(800);
const mac = await m.evaluate(() => ({ strip: document.querySelector('.turn-strip.prev').getBoundingClientRect().width, pad: getComputedStyle(document.querySelector('.pages')).padding, top: document.querySelector('.item-top').getBoundingClientRect().height }));
console.log('  mac:', JSON.stringify(mac), JSON.stringify(await measure(m)));
await m.screenshot({ path: `${out}/fill-mac-sheet.png` });
check('Mac: 40px turn strips', mac.strip === 40, JSON.stringify(mac));
check('Mac: page padding 4px 48px', mac.pad === '4px 48px', mac.pad);
// Mac: 100% = the two-page spread fits the frame; both shown pages' dots filled; + zooms relative to that
const macFit = () => m.$eval('#pages', (e) => { const r = e.getBoundingClientRect(); return [...e.querySelectorAll('.page')].every((p) => { const b = p.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1 && b.left >= r.left - 1 && b.right <= r.right + 1; }); });
check('Mac: opens at 100%, two pages, whole spread visible', (await m.$eval('#sv-zreset', (e) => e.textContent)) === '100%' && (await m.$$eval('.page', (e) => e.length)) === 2 && (await macFit()));
check('Mac: both shown pages have filled dots', (await m.$$eval('#sv-dots i.on', (e) => e.map((x) => x.dataset.p).join())) === '1,2');
check('Mac: dots below the pages, not over them', await m.evaluate(() => { const d = document.querySelector('#sv-dots i').getBoundingClientRect(); return [...document.querySelectorAll('.page')].every((p) => p.getBoundingClientRect().bottom <= d.top + 1); }));
await m.click('#sv-zin'); await sleep(300);
check('Mac: + → 125%', (await m.$eval('#sv-zreset', (e) => e.textContent)) === '125%');
await m.click('#sv-zreset'); await sleep(300);
check('Mac: reset → 100%, fits', (await m.$eval('#sv-zreset', (e) => e.textContent)) === '100%' && (await macFit()));

// Clean up shows sheets only: a book is not in it at all (so it gets no trim suggestions either)
const cu = await m.evaluate(() => fetch('/api/cleanup').then((r) => r.json()));
check('Manage library: book not listed', !cu.songs.some((s) => s.id === book.id));
check('Manage library: book not among odd titles', !cu.titles.some((t) => t.id === book.id));
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
