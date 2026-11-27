// real job runners through the UI (server on :5190, temp data)
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const xml = fs.readFileSync(new URL('../../server/tests/fixtures/lead-sheet.musicxml', import.meta.url), 'utf8');
const sc = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: 'Memory', version: 'original', tags: ['Original'], musicxmlText: xml }) });
await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await sleep(4000);
// the score ⋯ has no "Make another version…" any more: the version job is started as it made it
const oldJobs = new Set((await api('/jobs')).map((j) => j.id)); const scoresBefore = (await api('/items?kind=score')).length;
await page.evaluate(async (id) => {
  const { store } = await import('./js/store.js');
  const it = store.get(id);
  store.addJob({ gen: true, fromItemId: it.id, title: it.title, artist: it.artist, tags: it.tags.filter((t) => !['Lead sheet', 'Simple Piano', 'Original'].includes(t)), tune: it.tune, key: it.key,
    source: `From the score “${it.title}”`, sourceUrl: it.sourceUrl || '', outputs: ['lead', 'clear'], output: 'Lead sheet + Simple Piano' });
}, sc.id);
let done = null; const t0 = Date.now();
for (let i = 0; i < 120 && !done; i++) { await sleep(1000); const js = await api('/jobs'); done = js.find((j) => !oldJobs.has(j.id) && j.kind === 'version' && ['done', 'failed'].includes(j.status)); }
check('version job finishes', done?.status === 'done', JSON.stringify(done?.log?.slice(-2)));
console.log('   version job took', Math.round((Date.now() - t0) / 1000), 's');
const all = await api('/items?kind=score'); const items = (done?.result || []).map((id) => all.find((x) => x.id === id));
check('lead + clear became two new score items', items.map((x) => x?.version).sort().join() === 'clear,lead', items.map((x) => x?.version).join());
await page.goto(BASE + '#/add-score', { waitUntil: 'networkidle0' }); await sleep(1500);
check('finished jobs are not listed on Add score (they live in Activities)', !(await page.$eval('#sf-jobs', (e) => e.textContent)).includes('Memory'));
await page.goto(BASE + '#/library?kind=score', { waitUntil: 'networkidle0' }); await sleep(800);
check('library shows them', (await page.$$eval('#lib-rows tr.row', (e) => e.length)) === Math.min(50, scoresBefore + 2));
const lead = items.find((x) => x.version === 'lead');
await page.goto(BASE + '#/item/' + lead.id, { waitUntil: 'networkidle0' }); await sleep(4000);
check('lead sheet draws', (await page.$$('#osmd svg')).length > 0);
// transcription of a 20 s clip via upload
await page.goto(BASE + '#/add-score', { waitUntil: 'networkidle0' }); await sleep(800);
await page.click('#sf-src [data-s="file"]');
const fi = await page.$('#sf-audio'); await fi.uploadFile('/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/clip.wav'); await sleep(300);
await page.click('#sf-go');
let tj = null; const t1 = Date.now();
for (let i = 0; i < 300 && !(tj && ['done', 'failed'].includes(tj.status)); i++) { await sleep(2000); tj = (await api('/jobs')).find((j) => !oldJobs.has(j.id) && j.kind === 'transcribe'); }
check('transcription job finishes', tj?.status === 'done', JSON.stringify(tj?.log?.slice(-3)));
console.log('   transcription took', Math.round((Date.now() - t1) / 1000), 's');
let gone = false; for (let i = 0; i < 20 && !gone; i++) { await sleep(500); gone = await page.$eval('#sf-jobs', (e) => e.hidden && !e.textContent.trim()); }
check('finished transcription leaves Add score', gone, await page.$eval('#sf-jobs', (e) => e.textContent));
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
