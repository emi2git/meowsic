// iPad / iPhone library: no scrolling, as many rows as fit, swipe left / right = next / previous page;
// rotation measures again; back from an item keeps the page; sort / search go back to page 1;
// the keyboard does not change the count. Sheets: swipe up or down = back to the library.
// Mac: no swipes, no scrolling either: rows fit the window, the ‹ n / N › pager (macnoswipe.mjs has the rest).
// BASE=http://localhost:5211/ (a test server with 100+ items; never :5180) or BASE='http://localhost:5210/?preview=1'
// OUT=dir for screenshots (default: no screenshots)
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5211/';
const OUT = process.env.OUT || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const DEVICES = [['ipad13-port', 1032, 1376], ['ipad13-land', 1376, 1032], ['iphone-air', 420, 912]];
const KINDS = ['', 'sheet', 'book', 'score', 'chords'];
const hash = (p) => p.evaluate(() => location.hash);
// a fresh load of #/library opens Sheets; All music is then a tap (here: a hash change) away
const lib = (p, k) => p.goto(BASE + '#/library' + (k ? '?kind=' + k : ''), { waitUntil: 'networkidle0' }).then(() => (k ? 0 : p.evaluate(() => (location.hash = '#/library')))).then(() => sleep(500));
const swipe = async (p, x0, y0, x1, y1, steps = 6) => {
  await p.touchscreen.touchStart(x0, y0);
  for (let i = 1; i <= steps; i++) await p.touchscreen.touchMove(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await p.touchscreen.touchEnd(); await sleep(500);
};
// the state of the list on screen
const look = (p) => p.evaluate(() => {
  const main = document.querySelector('#main'), box = document.querySelector('#lib-rows');
  const rows = [...document.querySelectorAll('#lib-rows tr.row')];
  const pr = document.querySelector('.pager-row')?.getBoundingClientRect();
  const tab = document.querySelector('.tabbar'), tabTop = tab && getComputedStyle(tab).display !== 'none' ? tab.getBoundingClientRect().top : innerHeight;
  const last = rows.at(-1)?.getBoundingClientRect();
  const rowH = Math.max(0, ...rows.map((r) => r.getBoundingClientRect().height));
  const head = document.querySelector('.lib-table thead')?.getBoundingClientRect();
  return {
    n: rows.length, ids: rows.map((r) => r.dataset.id), rowH,
    mainScroll: main.scrollHeight - main.clientHeight, docScroll: document.scrollingElement.scrollHeight - innerHeight,
    lastBottom: last?.bottom ?? 0, pagerTop: pr?.top ?? 0, mainBottom: main.getBoundingClientRect().bottom, tabTop,
    // room left under the last row (less the table's bottom margin)
    spare: pr && head ? pr.top - head.bottom - rows.length * rowH - parseFloat(getComputedStyle(document.querySelector('.lib-table')).marginBottom) : 0,
    ind: document.querySelector('.pg-now')?.textContent || '', count: document.querySelector('.pager-row .muted')?.textContent || '',
    box: box?.getBoundingClientRect().toJSON(),
  };
});
const fits = (name, s) => {
  check(`${name}: #main does not scroll`, s.mainScroll <= 0, s.mainScroll);
  check(`${name}: the page does not scroll`, s.docScroll <= 0, s.docScroll);
  check(`${name}: last row fully visible (above the pager, ${s.tabTop < 2000 ? 'tab bar' : 'screen edge'})`, s.n > 0 && s.lastBottom <= s.pagerTop + 0.5 && s.lastBottom <= s.tabTop && s.lastBottom <= s.mainBottom, JSON.stringify(s));
  const [cur, tot] = s.ind.split(' / ').map(Number);
  if (s.ind && cur < tot) check(`${name}: no room left for one more row`, s.spare < s.rowH, `spare ${s.spare}, row ${s.rowH}`);
};
const rowsPer = {};

for (const [name, w, h] of DEVICES) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  for (const k of KINDS) {
    const tag = `${name} ${k || 'all'}`;
    await lib(p, k);
    let s = await look(p);
    if (!s.n) { console.log(`  (${tag}: nothing here)`); continue; }
    rowsPer[`${name} ${k || 'all'}`] = s.n;
    fits(tag, s);
    if (OUT) await p.screenshot({ path: `${OUT}/lib-${name}-${k || 'all'}.png` });
    const pages = +(s.ind.split(' / ')[1] || 1);
    if (pages < 2) { console.log(`  (${tag}: one page of ${s.n})`); continue; }
    check(`${tag}: indicator says page 1`, s.ind.startsWith('1 / '), s.ind);
    const bx = s.box, cy = bx.y + bx.height / 2, first = s.ids[0];
    // vertical swipe does nothing
    await swipe(p, bx.x + bx.width / 2, cy + 150, bx.x + bx.width / 2, cy - 150);
    check(`${tag}: swipe up does not change the page`, (await look(p)).ind.startsWith('1 / ') && (await hash(p)).startsWith('#/library'));
    await swipe(p, bx.x + bx.width * 0.8, cy, bx.x + bx.width * 0.2, cy);
    s = await look(p);
    check(`${tag}: swipe left → page 2`, s.ind.startsWith('2 / ') && s.ids[0] !== first, s.ind);
    check(`${tag}: …still the library`, (await hash(p)).startsWith('#/library'), await hash(p));
    fits(`${tag} p2`, s);
    if (k !== 'book' && k !== 'chords') {
      await swipe(p, bx.x + bx.width * 0.2, cy, bx.x + bx.width * 0.8, cy);
      s = await look(p);
      check(`${tag}: swipe right → page 1`, s.ind.startsWith('1 / ') && s.ids[0] === first, s.ind);
      continue;
    }
    // tap a row on page 2 → the item; back → page 2 again
    const id2 = s.ids[1];
    const r = await p.$eval(`tr.row[data-id="${id2}"] td.c-title`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; });
    await p.touchscreen.tap(r.x, r.y); await sleep(1500);
    check(`${tag}: a tap opens the item`, (await hash(p)) === '#/item/' + id2, await hash(p));
    await p.goBack(); await sleep(900);
    s = await look(p);
    check(`${tag}: back from the item keeps page 2`, s.ind.startsWith('2 / ') && s.ids.includes(id2), s.ind);
    // the ‹ › buttons
    await p.click('.pager [data-pg="next"]'); await sleep(300);
    check(`${tag}: › button → page 3`, (await look(p)).ind.startsWith('3 / ') || pages < 3, (await look(p)).ind);
    await p.click('.pager [data-pg="prev"]'); await sleep(300);
    // press and hold still selects
    const r2 = await p.$eval('tr.row td.c-title', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; });
    await p.touchscreen.touchStart(r2.x, r2.y); await sleep(700); await p.touchscreen.touchEnd(); await sleep(400);
    check(`${tag}: press and hold → select mode`, await p.$eval('#selband', (e) => !e.hidden));
    await p.click('#sb-done'); await sleep(300);
    // sort → page 1
    await p.click('.th-sort[data-sort="title"]'); await sleep(400);
    check(`${tag}: sorting goes back to page 1`, (await look(p)).ind.startsWith('1 / '), (await look(p)).ind);
    // search → page 1; the keyboard (a shorter viewport while the box has focus) keeps the count
    await swipe(p, bx.x + bx.width * 0.8, cy, bx.x + bx.width * 0.2, cy);
    const n0 = rowsPer[tag]; // a full page
    const want = (x) => Math.min(n0, parseInt(x.count) || 0);
    await p.focus('#lib-q');
    await p.setViewport({ width: w, height: Math.round(h * 0.55), hasTouch: true, isMobile: true }); await sleep(400);
    await p.keyboard.type('d'); await sleep(400);
    s = await look(p);
    check(`${tag}: search goes back to page 1`, s.ind.startsWith('1 / ') || !s.ind, s.ind);
    check(`${tag}: keyboard up: row count kept`, s.n === want(s), `${n0} → ${s.n}`);
    await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
    await p.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); e.blur(); }); await sleep(700);
    s = await look(p);
    check(`${tag}: keyboard down: same rows per page`, s.n === n0, `${n0} → ${s.n}`);
    fits(`${tag} after the keyboard`, s);
    // rotation (iPad): measures again, still fits; the first row stays on screen
    if (name.startsWith('ipad')) {
      await p.click('.pager [data-pg="next"]'); await sleep(300);
      const before = await look(p);
      await p.setViewport({ width: h, height: w, hasTouch: true, isMobile: true }); await sleep(700);
      s = await look(p);
      check(`${tag}: rotated: row count measured again`, s.n !== before.n, `${before.n} → ${s.n}`);
      check(`${tag}: rotated: the first row is still on screen`, s.ids.includes(before.ids[0]), before.ids[0]);
      fits(`${tag} rotated`, s);
      if (OUT && k === 'score') await p.screenshot({ path: `${OUT}/lib-${name}-rotated.png` });
      await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true }); await sleep(700);
      fits(`${tag} rotated back`, await look(p));
    }
  }
  // a sheet / book: swipe up or down → back to the library, sideways turns the page
  const ids = await p.evaluate(async () => (await import('/js/store.js')).store.items().filter((x) => x.kind === 'sheet' && x.pages > 1).map((x) => ({ id: x.id, book: !!x.book })));
  for (const it of [ids.find((x) => !x.book), ids.find((x) => x.book)].filter(Boolean)) {
    const what = it.book ? 'book' : 'sheet';
    for (const dir of ['up', 'down']) {
      await lib(p, it.book ? 'book' : 'sheet');
      await p.evaluate((i) => { location.hash = '#/item/' + i; }, it.id); await sleep(1300);
      const pg = await p.$eval('.pages', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      if (dir === 'up') {
        await swipe(p, pg.x + 120, pg.y, pg.x - 120, pg.y);
        check(`${name} ${what}: sideways swipe turns the page`, (await hash(p)).startsWith('#/item/') && (await p.$$eval('#sv-dots i.on', (e) => e.map((x) => x.dataset.p).join())) === '2', await p.$$eval('#sv-dots i.on', (e) => e.map((x) => x.dataset.p).join()));
      }
      await swipe(p, pg.x, pg.y + (dir === 'up' ? 150 : -150), pg.x, pg.y + (dir === 'up' ? -150 : 150));
      check(`${name} ${what}: swipe ${dir} → library`, (await hash(p)).startsWith('#/library'), await hash(p));
    }
  }
  await p.close();
}

// Mac: rows fit the window (no scrolling), the same ‹ n / N › pager, always shown
const m = await b.newPage(); m.on('pageerror', (e) => errs.push('mac: ' + e.message)); await m.setViewport({ width: 1440, height: 900 });
await lib(m, '');
const ms = await m.evaluate(() => ({ n: document.querySelectorAll('tr.row').length, total: parseInt(document.querySelector('.pager-row .muted').textContent), scroll: document.querySelector('#main').scrollHeight - document.querySelector('#main').clientHeight, mini: !!document.querySelector('.pager.mini') }));
check('Mac: rows fit, nothing scrolls', ms.n >= 1 && ms.n < 50 && ms.scroll <= 1, JSON.stringify(ms));
check('Mac: the ‹ n / N › pager', ms.mini);

console.log('\nrows per page:', JSON.stringify(rowsPer));
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
