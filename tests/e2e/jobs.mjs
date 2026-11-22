// real job runners through the UI (server on :5190, temp data)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const xml = fs.readFileSync('/Users/emi2mac/Documents/Emi Music Note/memory-from-cats-andrew-lloyd-webber/memory-from-cats-andrew-lloyd-webber.musicxml', 'utf8');
const sc = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: 'Memory', version: 'original', tags: ['Original'], musicxmlText: xml }) });
await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await sleep(4000);
await page.click('#it-more'); await sleep(200);
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.includes('Make another version')).click()); await sleep(300);
await page.click('#gv [data-o="lead"]'); await page.click('#gv [data-o="easy"]'); await page.click('.modal [data-ok]');
let done = null; const t0 = Date.now();
for (let i = 0; i < 120 && !done; i++) { await sleep(1000); const js = await api('/jobs'); done = js.find((j) => j.kind === 'version' && ['done', 'failed'].includes(j.status)); }
check('version job finishes', done?.status === 'done', JSON.stringify(done?.log?.slice(-2)));
console.log('   version job took', Math.round((Date.now() - t0) / 1000), 's');
const items = await api('/items?kind=score');
check('lead + easy became two new score items', items.filter((x) => ['lead', 'easy'].includes(x.version)).length === 2, items.map((x) => x.version).join());
await page.goto(BASE + '#/add-score', { waitUntil: 'networkidle0' }); await sleep(1500);
check('UI lists the new versions', (await page.$eval('#sf-jobs', (e) => e.textContent)).includes('Open Lead sheet'));
await page.goto(BASE + '#/library?kind=score', { waitUntil: 'networkidle0' }); await sleep(800);
check('library shows them', (await page.$$eval('#lib-rows tr.row', (e) => e.length)) === 3);
const lead = items.find((x) => x.version === 'lead');
await page.goto(BASE + '#/item/' + lead.id, { waitUntil: 'networkidle0' }); await sleep(4000);
check('lead sheet draws', (await page.$$('#osmd svg')).length > 0);
// transcription of a 20 s clip via upload
await page.goto(BASE + '#/add-score', { waitUntil: 'networkidle0' }); await sleep(800);
await page.click('#sf-src [data-s="file"]');
const fi = await page.$('#sf-audio'); await fi.uploadFile('/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/clip.wav'); await sleep(300);
await page.click('#sf-go');
let tj = null; const t1 = Date.now();
for (let i = 0; i < 300 && !(tj && ['done', 'failed'].includes(tj.status)); i++) { await sleep(2000); tj = (await api('/jobs')).find((j) => j.kind === 'transcribe'); }
check('transcription job finishes', tj?.status === 'done', JSON.stringify(tj?.log?.slice(-3)));
console.log('   transcription took', Math.round((Date.now() - t1) / 1000), 's');
await sleep(3000);
check('UI shows Open for the transcription', (await page.$eval('#sf-jobs', (e) => e.textContent)).includes('Open Original'));
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
