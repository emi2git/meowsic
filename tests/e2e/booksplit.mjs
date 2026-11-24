// Manage library → Fix pages: books are not offered (read-only); split a sheet into songs, against a test server (BASE, default :5190). Never the real library.
// Makes (or reuses) the book "Booksplit test": 10 pages, each a colour + its big page number, so a
// page can be recognised wherever it ends up. Marks 3 starts, reloads, makes the sheets, undoes.
import './live-guard.mjs'; // refuses the live app / library
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

// ---- books are read-only PDFs now: Fix pages never offers them (no splitting, merging, rearranging) ----
for (const [name, vp] of [['mac', { width: 1440, height: 900 }], ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  const p = name === 'mac' ? page : await newPage(vp);
  await p.goto(BASE + `#/manage?id=${book.id}`, { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' }); await sleep(900);
  check(`${name}: the book does not open in Fix pages`, (await p.evaluate(() => location.hash)) === `#/manage/pages/${book.id}` && !(await p.$('#pe-grid .pe-tile')));
  await p.goto(BASE + '#/manage/pages', { waitUntil: 'networkidle0' }); await sleep(900);
  await p.type('#pk-find', TITLE); await sleep(300);
  check(`${name}: the book is not in the Fix pages list`, !(await p.$(`#pk-list [data-id="${book.id}"]`)) && !(await api('/organize')).items.some((x) => x.id === book.id));
  await p.goto(BASE + `#/item/${book.id}`, { waitUntil: 'networkidle0' }); await sleep(700);
  await p.$eval('#it-more', (e) => e.click()); await sleep(300);
  const m = await p.$$eval('.menu button', (e) => e.map((x) => x.querySelector('span').textContent.trim()));
  check(`${name}: book ⋯ has no Edit pages / Crop page / Make a score`, m.join('|') === 'Info|Export|Move to Trash', m.join('|'));
  if (p !== page) await p.close();
}
const org = await api('/organize');
check('/api/organize leaves the book out', !org.items.some((x) => x.id === book.id));
check('the book keeps its pages', (await api('/items/' + book.id)).pages === N);

// ---- title detection: marking a start fills its title from the page (Apple Vision on the Mac) ----
{
  const T2 = 'Booksplit titles test';
  const old = (await api('/items?deleted=true')).concat(await api('/items')).filter((x) => x.title === T2);
  if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
  const tb = await page.evaluate(async (T2) => {
    const fd = new FormData(); fd.append('title', T2); fd.append('artist', 'E2E');
    const songs = ['', 'Moon River', 'Yesterday'];
    for (let n = 1; n <= 3; n++) {
      const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
      g.font = '24px Arial'; g.fillText(String(10 + n), 60, 70);
      if (songs[n - 1]) {
        g.font = 'bold 64px Arial'; g.textAlign = 'center'; g.fillText(songs[n - 1], 620, 180);
        g.font = '24px Arial'; g.textAlign = 'right'; g.fillText('Words and Music by John Smith', 1160, 260); g.textAlign = 'left';
      }
      const top0 = songs[n - 1] ? 360 : 120;
      for (let s = 0; s < 5; s++) for (let k = 0; k < 5; k++) g.fillRect(80, top0 + s * 260 + k * 16, 1080, 2);
      fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `t${n}.png`);
    }
    const it = (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
    return (await (await fetch('/api/items/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [it.id], book: true }) })).json()).items[0];
  }, T2);
  const probe = await api(`/items/${tb.id}/pages/2/title`);
  if (probe.error && !probe.title) console.log('  skip title detection (Vision not available):', probe.error);
  else check('API reads the title of page 2 (books: read by the API only; Fix pages does not offer books)', probe.title === 'Moon River' && probe.confidence >= 0.5, JSON.stringify(probe));
  await post(`/books/${tb.id}/split`, { starts: {} });
  await post('/items/purge', { ids: [tb.id] });
}

// ---- Fix pages on a sheet (not a book): page 1 stays the first song ----
{
  const T3 = 'Split songs test';
  const old = (await api('/items?deleted=true')).concat(await api('/items')).filter((x) => x.title.startsWith(T3) || ['Second', 'Third'].includes(x.title) && x.artist === 'E2E');
  if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
  const sh = await page.evaluate(async (T3, cols) => {
    const fd = new FormData(); fd.append('title', T3); fd.append('artist', 'E2E');
    for (let n = 1; n <= 6; n++) {
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const g = c.getContext('2d'); g.fillStyle = `rgb(${cols[n - 1].join(',')})`; g.fillRect(0, 0, 600, 800);
      g.fillStyle = '#000'; g.font = 'bold 300px sans-serif'; g.textAlign = 'center'; g.fillText(String(n), 300, 500);
      fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `s${n}.png`);
    }
    return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
  }, T3, Array.from({ length: 6 }, (_, k) => colour(k + 1).map((v) => (v + 7) % 256)));
  const cols6 = Array.from({ length: 6 }, (_, k) => colour(k + 1).map((v) => (v + 7) % 256));
  const pagesOf6 = (it) => page.evaluate(async (it, cols) => {
    const out = [];
    for (const f of it.pageFiles) {
      const img = new Image(); img.src = `/api/items/${encodeURIComponent(it.id)}/file/${encodeURIComponent(f)}?x=${Math.random()}`; await img.decode();
      const c = document.createElement('canvas'); c.width = 4; c.height = 4; c.getContext('2d').drawImage(img, 0, 0);
      const [r, g, bl] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
      out.push(cols.findIndex((x) => Math.abs(x[0] - r) + Math.abs(x[1] - g) + Math.abs(x[2] - bl) < 12) + 1);
    }
    return out;
  }, it, cols6);
  await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(500);
  check('old #/cleanup goes to Manage library', (await page.evaluate(() => location.hash)) === '#/manage');
  await page.goto(BASE + '#/manage/pages', { waitUntil: 'networkidle0' }); await sleep(800);
  await page.click('#pk-find'); await page.keyboard.type(T3); await sleep(300);
  check('the sheet is listed', !!(await page.$(`#pk-list [data-id="${sh.id}"]`)));
  await page.click(`#pk-list [data-id="${sh.id}"]`); await sleep(1500);
  check('its 6 pages shown', (await page.$$('#pe-grid .pe-tile')).length === 6);
  check('one song: no song lines, no banner, Done just goes back', !(await page.$('#pe-grid .pe-break')) && !(await page.$('#pe-banner')) && (await page.$eval('#pe-done', (e) => e.textContent)) === 'Done');
  check('page 1 cannot start a new song', await (async () => { await page.click('#pe-grid .pe-tile[data-p="1"]'); await sleep(200); return page.$eval('#pe-dock [data-act="mark"]', (e) => e.disabled); })());
  const mark = async (n, title) => {
    await page.click(`#pe-grid .pe-tile[data-p="${n}"]`); await sleep(200);
    await page.keyboard.press('s'); await sleep(500);
    await page.click(`#pe-grid [data-title="${n}"]`, { clickCount: 3 }); await page.keyboard.type(title); await page.keyboard.press('Enter'); await sleep(700);
  };
  await mark(3, 'Second'); await mark(5, 'Third'); await sleep(600);
  check('marks saved', JSON.stringify((await api(`/sheets/${sh.id}/split`)).starts) === JSON.stringify({ 3: 'Second', 5: 'Third' }), JSON.stringify((await api(`/sheets/${sh.id}/split`)).starts));
  check('two song lines, Done says Make sheets', (await page.$$('#pe-grid .pe-break')).length === 2 && (await page.$eval('#pe-done', (e) => e.textContent)) === 'Make sheets');
  await page.click('#pe-done'); await sleep(400);
  check('Done says Split into 3 sheets', (await page.$eval('.modal [data-ok]', (e) => e.textContent)) === 'Split into 3 sheets');
  const c3 = await page.$$eval('.pe-confirm li', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  check('confirm: first song stays, two new', c3.join('|') === `${T3} pages 1–2 · stays in this sheet|Second pages 3–4 · new sheet|Third pages 5–6 · new sheet`, c3.join('|'));
  await page.click('.modal [data-ok]'); await sleep(2000);
  const all3 = await api('/items');
  const kept = all3.find((x) => x.id === sh.id), s2 = all3.find((x) => x.title === 'Second' && x.artist === 'E2E'), s3 = all3.find((x) => x.title === 'Third' && x.artist === 'E2E');
  check('sheet keeps pages 1–2', kept.pages === 2 && (await pagesOf6(kept)).join() === '1,2', `${kept.pages}`);
  check('Second = pages 3–4, Third = 5–6', s2 && s3 && (await pagesOf6(s2)).join() === '3,4' && (await pagesOf6(s3)).join() === '5,6');
  await page.goto(BASE + `#/manage/pages/${sh.id}`, { waitUntil: 'networkidle0' }); await sleep(1200);
  check('Undo offers it', /split songs/.test(await page.$eval('#pe-undo', (e) => e.title)));
  await page.keyboard.press('z'); await sleep(2500);
  const back3 = await api('/items/' + sh.id);
  check('undo: all 6 pages back in order', back3.pages === 6 && (await pagesOf6(back3)).join() === '1,2,3,4,5,6');
  check('undo: new sheets removed', (await fetch(`${BASE}api/items/${s2?.id}`)).status === 404 && (await fetch(`${BASE}api/items/${s3?.id}`)).status === 404);
  await page.screenshot({ path: 'songsplit-mac.png' });
  await post(`/sheets/${sh.id}/split`, { starts: {} });
  await post('/items/purge', { ids: [sh.id] });
}

check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
