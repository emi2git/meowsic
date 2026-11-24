// Score ⋯ → "Add lyrics from a sheet…" through the UI, against a temp server ($BASE, default :5242) that has a
// score and a sheet of the same song with words: pick the sheet, the 'lyrics' job runs (real OMR), a new score
// entry tagged "Lyrics added" shows the words under the tune; the score itself is untouched.
// Prints counts only (the words can be copyrighted); screenshots go to $SHOTS (default: this folder).
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5242/';
const SHOTS = process.env.SHOTS || '.';
const TITLE = process.env.TITLE || 'One Day More';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const items = await api('/items');
const sc = items.find((x) => x.kind === 'score' && x.title === TITLE && !x.tags.includes('Lyrics added') && !x.deleted);
const sh = items.find((x) => x.kind === 'sheet' && x.title.startsWith(TITLE) && !x.deleted);
check('server has the score and the sheet', sc && sh);
const before = await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text());
const nScores = items.filter((x) => x.kind === 'score').length;

await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' }); await sleep(1500);
await page.click('#it-more'); await sleep(200);
const entries = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
check('score ⋯ has Add lyrics from a sheet…', entries.some((t) => /Add lyrics from a sheet/.test(t)), entries.join('|'));
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => /Add lyrics from a sheet/.test(x.textContent)).click()); await sleep(400);
const listed = await page.$$eval('#al-list [data-id]', (e) => e.map((x) => ({ id: x.dataset.id, same: !!x.querySelector('.have') })));
check('the sheet picker lists the same song first', listed[0]?.same && listed.some((x) => x.id === sh.id), JSON.stringify(listed.slice(0, 3)));
await page.type('#al-q', 'zzzz-nothing'); await sleep(100);
check('search with no match says so', /No sheet/.test(await page.$eval('#al-list', (e) => e.textContent)));
await page.$eval('#al-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await sleep(100);
await page.click(`#al-list [data-id="${sh.id}"]`); await sleep(400);
check('a confirm sheet asks first', !!(await page.$('.modal [data-ok]')));
await page.click('.modal [data-ok]'); await sleep(1000);
await page.goto(`${BASE}#/jobs`, { waitUntil: 'networkidle0' }); await sleep(1500);
const stages = await page.$$eval('.job .stages li span', (e) => e.map((x) => x.textContent));
check('the job shows its own stages', stages.includes('Read the words on the sheet') && stages.includes('Fit the words to the tune'), stages.join('|'));
let job;
for (let i = 0; i < 240; i++) { await sleep(2000); job = (await api('/jobs')).find((j) => j.kind === 'lyrics' && j.title === TITLE); if (job && ['done', 'failed'].includes(job.status)) break; }
check('job finishes', job?.status === 'done', JSON.stringify(job?.log?.slice(-2).map((l) => l.msg)));
console.log('   ', job?.log?.map((l) => l.msg).filter((m) => /placed|Done/.test(m)).join(' | '));
const after = await api('/items');
check('one new score entry', after.filter((x) => x.kind === 'score').length === nScores + 1);
const ns = after.find((x) => x.id === job?.result?.[0]);
check('tagged Lyrics added, same version, source says so', ns?.tags.includes('Lyrics added') && ns.version === sc.version && /lyrics from the sheet/.test(ns.source), JSON.stringify([ns?.tags, ns?.version]));
const xml = await fetch(`${BASE}api/items/${ns.id}/musicxml`).then((r) => r.text());
const nLy = (xml.match(/<lyric/g) || []).length;
check('words in the new score', nLy >= 100, nLy);
check('the score itself is untouched', (await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text())) === before);
await page.goto(`${BASE}#/item/${ns.id}`, { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' }); await sleep(5000);
check('score shows in the app', (await page.$$('#osmd svg')).length > 0);
const drawn = await page.$$eval('#osmd svg .vf-lyric, #osmd svg text', (e) => e.length);
check('words are drawn', drawn > nLy / 2, drawn);
const nUnsure = (xml.match(/<lyric[^>]*color=/g) || []).length;
const redDrawn = await page.$$eval('#osmd .lyric-unsure', (e) => e.filter((x) => getComputedStyle(x.querySelector('text') || x).fill.replace(/\s/g, '') === 'rgb(221,34,34)').length);
check('unsure words are red', nUnsure === 0 ? redDrawn === 0 : redDrawn >= nUnsure * 0.8 && redDrawn <= nUnsure * 1.5, `${redDrawn} red, ${nUnsure} unsure`);
console.log(`    ${redDrawn} red of ${nUnsure} unsure`);
await page.setViewport({ width: 1440, height: 7000 }); await sleep(4000);  // the whole score at once, to look bar by bar
await page.screenshot({ path: `${SHOTS}/lyrics-score.png` });
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
