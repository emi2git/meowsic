// Books (server on a test port, temp data): sheet → book → sheet through the API (the app no longer offers it:
// books stay books), files move on disk; the Info popup's Actions never offer Make it a book / Not a book
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const DATA = process.env.MDATA;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const actions = async () => { await page.click('#it-more'); await sleep(250); await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((e) => e.textContent.trim() === 'Info')?.click()); await sleep(300);
  const l = await page.$$eval('.info-actions button', (e) => e.map((x) => x.textContent.trim())); await page.keyboard.press('Escape'); await sleep(200); return l; };
const setBook = (on) => fetch(BASE + 'api/items/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [sh.id], book: on }) });
const sh = (await api('/items')).find((x) => x.title === 'Cleanup test' && x.kind === 'sheet');
await page.goto(`${BASE}#/item/${sh.id}`, { waitUntil: 'networkidle0' }); await sleep(800);
{ const l = await actions(); check('sheet Info actions: no Make it a book', l.length > 3 && !l.some((x) => /book/i.test(x)), l.join(' | ')); }
await setBook(true); await sleep(300);
let it = await api('/items/' + sh.id);
check('now a book in Books/', it.book === 1 && it.folder === 'Books/Cleanup test', it.folder);
check('pages renamed after the book', it.pageFiles.every((f, k) => f === `Cleanup test ${k + 1}${f.slice(f.lastIndexOf('.'))}`), it.pageFiles.join());
if (DATA) check('files on disk under items/Books/', fs.readdirSync(`${DATA}/items/Books/Cleanup test`).filter((f) => !f.startsWith('.')).length === it.pages);
check('page image still loads', await page.evaluate(async (u) => (await fetch(u)).ok, `/api/items/${it.id}/file/${encodeURIComponent(it.pageFiles[0])}`));
await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(600);
const side = await page.$$eval('.side .nav.sub', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('left bar: Sheets, Scores, Chords, Books', side.length >= 4 && /^Sheets/.test(side[0]) && /^Scores/.test(side[1]) && /^Chords/.test(side[2]) && /^Books/.test(side[3]), side.join(' | '));
await page.goto(`${BASE}#/library?kind=book`, { waitUntil: 'networkidle0' }); await sleep(600);
const rows = await page.$$eval('.lib-table tbody tr', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('Books list has the book, with its cover', rows.some((r) => r.includes('Cleanup test')) && (await page.$$('.lib-table .cover img')).length === rows.length, rows.join(' | '));
check('heading says Books', (await page.$eval('#libhead h1', (e) => e.textContent)) === 'Books');
await page.goto(`${BASE}#/library?kind=sheet`, { waitUntil: 'networkidle0' }); await sleep(600);
check('Sheets list no longer has it', !(await page.$$eval('.lib-table tbody tr', (e) => e.some((x) => x.textContent.includes('Cleanup test')))));
await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await page.evaluate(() => (location.hash = '#/library')); await sleep(600);
check('All music shows a Book badge', await page.$$eval('.lib-table tbody tr', (e) => e.some((x) => x.textContent.includes('Cleanup test') && x.querySelector('.badge.k-book'))));
await page.goto(`${BASE}#/item/${sh.id}`, { waitUntil: 'networkidle0' }); await sleep(800);
{ const l = await actions(); check('book Info actions: no Not a book', l.length > 3 && !l.some((x) => /book/i.test(x)), l.join(' | ')); }
await setBook(false); await sleep(300);
it = await api('/items/' + sh.id);
check('back to a sheet, folder <id>', it.book === 0 && it.folder === sh.id, it.folder);
if (DATA) check('Books/ folder emptied', !fs.existsSync(`${DATA}/items/Books/Cleanup test`));
await page.screenshot({ path: 'books.png' });
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
