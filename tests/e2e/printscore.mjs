// print a real score: notation laid out on A4 pages (temp server :5190)
import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const items = await (await fetch(BASE + 'api/items?kind=score')).json();
const sc = items.find((x) => x.title.startsWith('Memory'));
await page.goto(`${BASE}#/print?item=${sc.id}`, { waitUntil: 'networkidle0' }); await sleep(6000);
const n = await page.$$eval('#print-root .pp.scorepage svg', (e) => e.length);
console.log(n > 1 ? '  ok  ' : '  FAIL', 'real score lays out on', n, 'A4 pages');
console.log((await page.$eval('#pr-sum', (e) => e.textContent)));
await page.screenshot({ path: 'printscore.png' });
await page.pdf({ path: 'printscore.pdf', preferCSSPageSize: true, printBackground: true });
console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
