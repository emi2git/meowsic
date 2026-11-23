// Clean up → Books → sheets against a test server (BASE, default :5190). Never the real library.
// Makes (or reuses) the book "Booksplit test": 10 pages, each a colour + its big page number, so a
// page can be recognised wherever it ends up. Marks 3 starts, reloads, makes the sheets, undoes.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const TITLE = 'Booksplit test', N = 10;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const newPage = async (vp) => {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  return p;
};
const colour = (n) => [n * 22, 250 - n * 20, 60 + n * 9];

const page = await newPage({ width: 1440, height: 900 });
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });

// ---- the test book: reuse it (undo anything left over), or make it fresh ----
let book = (await api('/items')).find((x) => x.title === TITLE && x.book);
if (book) { for (let i = 0; i < 5; i++) if (!(await post(`/books/${book.id}/unmake`, {})).ok) break; book = await api('/items/' + book.id); }
if (!book || book.pages !== N || book.deleted) {
  const old = (await api('/items?deleted=true')).concat(await api('/items')).filter((x) => x.title.startsWith(TITLE));
  if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
  const made = await page.evaluate(async (N, TITLE, cols) => {
    const fd = new FormData(); fd.append('title', TITLE); fd.append('artist', 'E2E');
    for (let n = 1; n <= N; n++) {
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const g = c.getContext('2d'); g.fillStyle = `rgb(${cols[n - 1].join(',')})`; g.fillRect(0, 0, 600, 800);
      g.fillStyle = '#000'; g.font = 'bold 360px sans-serif'; g.textAlign = 'center'; g.fillText(String(n), 300, 520);
      fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `p${n}.png`);
    }
    const it = (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
    return (await (await fetch('/api/items/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [it.id], book: true }) })).json()).items[0];
  }, N, TITLE, Array.from({ length: N }, (_, k) => colour(k + 1)));
  book = made;
}
await post(`/books/${book.id}/split`, { starts: {} });
const before = await api('/items/' + book.id);
check('test book has 10 pages', before.pages === N, before.pages);

// which page (by colour) is page k of an item
const pagesOf = (it) => page.evaluate(async (it, cols) => {
  const out = [];
  for (const f of it.pageFiles) {
    const img = new Image(); img.src = `/api/items/${encodeURIComponent(it.id)}/file/${f.split('/').map(encodeURIComponent).join('/')}?x=${Math.random()}`;
    await img.decode();
    const c = document.createElement('canvas'); c.width = 4; c.height = 4; c.getContext('2d').drawImage(img, 0, 0);
    const [r, g, bl] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
    out.push(cols.findIndex((x) => Math.abs(x[0] - r) + Math.abs(x[1] - g) + Math.abs(x[2] - bl) < 12) + 1);
  }
  return out;
}, it, Array.from({ length: N }, (_, k) => colour(k + 1)));
check('pages recognisable by colour', (await pagesOf(before)).join() === '1,2,3,4,5,6,7,8,9,10', (await pagesOf(before)).join());

// ---- Mac: mark three starts ----
await page.evaluate(() => localStorage.setItem('meowsic-cu-tab', 'books'));
await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(600);
check('Books → sheets tab is on', await page.$eval('[data-tab="books"]', (e) => e.classList.contains('on')));
await page.evaluate((id) => document.querySelector(`#bs-list li[data-id="${id}"]`)?.click(), book.id); await sleep(800);
check('book pages shown', (await page.$$('#bs-grid figure')).length === N);
check('Make button off until a start is marked', await page.$eval('#bs-make', (e) => e.disabled));
await page.click('#bs-grid figure[data-p="3"] .bs-pg'); await sleep(300);
check('click marks page 3', await page.$eval('#bs-grid figure[data-p="3"]', (e) => e.classList.contains('start')));
check('title box gets focus (placeholder)', await page.evaluate(() => document.activeElement?.placeholder === 'Title of this sheet'));
await page.keyboard.type('Alpha'); await page.keyboard.press('Enter'); await sleep(200);
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
check('→ moves focus to page 6', await page.$eval('#bs-grid figure.focus', (e) => e.dataset.p) === '6');
await page.keyboard.press('s'); await sleep(300);
await page.keyboard.type('Beta'); await page.keyboard.press('Enter'); await sleep(200);
check('S marks page 6', await page.$eval('#bs-grid figure[data-p="6"]', (e) => e.classList.contains('start')));
// page 2 by mistake, then U undoes it
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
await page.keyboard.press('Enter'); await sleep(300);
await page.evaluate(() => document.activeElement?.blur());
check('Enter marks page 2', await page.$eval('#bs-grid figure[data-p="2"]', (e) => e.classList.contains('start')));
await page.keyboard.press('u'); await sleep(1500);
check('U undoes the mark', !(await page.$eval('#bs-grid figure[data-p="2"]', (e) => e.classList.contains('start'))));
// page 9 from the large view
await page.click('#bs-grid figure[data-p="9"] .bs-zoom'); await sleep(500);
check('⤢ opens the page large', !!(await page.$('.bs-modal #bs-big')) && (await page.$eval('#bs-lt', (e) => e.textContent)).startsWith('Page 9'));
await page.keyboard.press('s'); await sleep(300);
check('S in the large view marks it', (await page.$eval('#bs-lm', (e) => e.textContent)) === 'Not a new sheet');
await page.keyboard.press(' '); await sleep(300);
check('Space closes the large view', !(await page.$('.bs-modal')));
await page.evaluate(() => document.activeElement?.blur());
await sleep(900);
let saved = (await api(`/books/${book.id}/split`)).starts;
check('marks + titles saved on the Mac', JSON.stringify(saved) === JSON.stringify({ 3: 'Alpha', 6: 'Beta', 9: '' }), JSON.stringify(saved));
const segs = await page.$$eval('.bs-seg', (e) => e.map((x) => x.textContent));
check('segments shown', segs.join('|') === 'Stays in the book: pages 1–2|Sheet 1: pages 3–5 · Alpha|Sheet 2: pages 6–8 · Beta|Sheet 3: pages 9–10', segs.join('|'));
check('list shows 3 marked', (await page.$eval(`#bs-list li[data-id="${book.id}"] small`, (e) => e.textContent)).includes('3 sheets marked'));
await page.screenshot({ path: 'booksplit-mac.png' });

// ---- reload: marks kept ----
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
check('after reload: same book open', (await page.$$('#bs-grid figure')).length === N);
check('after reload: 3 starts', (await page.$$eval('#bs-grid figure.start', (e) => e.map((x) => x.dataset.p).join())) === '3,6,9');
check('after reload: titles in the boxes', (await page.$$eval('#bs-grid figure.start input', (e) => e.map((x) => x.value).join('|'))) === 'Alpha|Beta|');
check('Make button says 3', (await page.$eval('#bs-make', (e) => e.textContent)) === 'Make 3 sheets…');

// ---- make the sheets ----
await page.click('#bs-make'); await sleep(400);
const conf = await page.$$eval('.bs-confirm li', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('confirm lists the sheets', conf.join('|') === `Alpha pages 3–5 (3 p)|Beta pages 6–8 (3 p)|${TITLE} — p9 pages 9–10 (2 p)`, conf.join('|'));
await page.click('.modal [data-ok]'); await sleep(2000);
const all = await api('/items');
const nb = all.find((x) => x.id === book.id);
check('book keeps pages 1–2', nb.pages === 2 && (await pagesOf(nb)).join() === '1,2', `${nb.pages} ${(await pagesOf(nb)).join()}`);
const want = [['Alpha', '3,4,5'], ['Beta', '6,7,8'], [`${TITLE} — p9`, '9,10']];
const made = [];
for (const [t, pg] of want) {
  const s = all.find((x) => x.title === t && !x.deleted);
  made.push(s);
  check(`sheet “${t}” has pages ${pg}`, s && !s.book && s.artist === 'E2E' && (await pagesOf(s)).join() === pg, s ? (await pagesOf(s)).join() : 'missing');
}
check('book page grid shows 2 pages now', (await page.$$('#bs-grid figure')).length === 2);
check('Undo button offers it', (await page.$eval('#cu-undo', (e) => e.textContent)).includes('make sheets'));
await page.screenshot({ path: 'booksplit-made.png' });

// ---- undo ----
await page.keyboard.press('z'); await sleep(2500);
const back = await api('/items/' + book.id);
check('undo: book has all 10 pages in order', back.pages === N && (await pagesOf(back)).join() === '1,2,3,4,5,6,7,8,9,10', (await pagesOf(back)).join());
check('undo: same file names', back.pageFiles.join() === before.pageFiles.join());
const gone = await Promise.all(made.filter(Boolean).map((s) => fetch(`${BASE}api/items/${s.id}`).then((r) => r.status)));
check('undo: new sheets removed', gone.every((x) => x === 404), gone.join());
check('undo: marks back on screen', (await page.$$eval('#bs-grid figure.start', (e) => e.map((x) => x.dataset.p).join())) === '3,6,9');
await post(`/books/${book.id}/split`, { starts: {} });

// ---- touch: iPad landscape / portrait, iPhone ----
for (const [name, w, h, colsWant] of [['iPad landscape', 1366, 1024, [3, 5]], ['iPad portrait', 1024, 1366, [3, 5]], ['iPhone', 390, 844, [2, 2]]]) {
  const p = await newPage({ width: w, height: h, hasTouch: true, isMobile: true });
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await p.evaluate((id) => { localStorage.setItem('meowsic-cu-tab', 'books'); localStorage.setItem('meowsic-cu-book', id); }, book.id);
  await p.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(1000);
  if (!(await p.$('#bs-grid'))) { await p.tap(`#bs-list li[data-id="${book.id}"]`); await sleep(800); }
  const fit = await p.evaluate(() => {
    const se = document.scrollingElement, mk = document.querySelector('#bs-make').getBoundingClientRect();
    const g = document.querySelector('#bs-grid'), fig = g.querySelector('figure').getBoundingClientRect();
    return { sh: se.scrollHeight, sw: se.scrollWidth, ih: innerHeight, iw: innerWidth, mkb: mk.bottom, mkw: mk.width, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, fw: fig.width };
  });
  check(`${name}: no page scroll`, fit.sh <= fit.ih + 1 && fit.sw <= fit.iw + 1, JSON.stringify(fit));
  check(`${name}: Make button on screen`, fit.mkb <= fit.ih && fit.mkw > 80, JSON.stringify(fit));
  check(`${name}: ${colsWant.join('–')} pages a row`, fit.cols >= colsWant[0] && fit.cols <= colsWant[1], fit.cols);
  check(`${name}: thumbnails big enough to read`, fit.fw >= 150, fit.fw);
  await p.tap('#bs-grid figure[data-p="4"] .bs-pg'); await sleep(700);
  check(`${name}: tap marks page 4`, await p.$eval('#bs-grid figure[data-p="4"]', (e) => e.classList.contains('start')) && '4' in (await api(`/books/${book.id}/split`)).starts);
  await p.screenshot({ path: `booksplit-${name.replace(/ /g, '-').toLowerCase()}.png` });
  await p.tap('#bs-grid figure[data-p="4"] .bs-pg'); await sleep(700);
  check(`${name}: tap again unmarks`, !(await p.$eval('#bs-grid figure[data-p="4"]', (e) => e.classList.contains('start'))) && !('4' in (await api(`/books/${book.id}/split`)).starts));
  if (name === 'iPhone') {
    await p.tap('#bs-back'); await sleep(300);
    check('iPhone: ‹ Books shows the list', await p.$eval('#bs-list', (e) => e.getBoundingClientRect().height > 50));
  }
  await p.close();
}

check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
