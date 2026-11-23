// AI Studio through the UI (server on $BASE, default :5195, temp data with one AI piece added by
// ~/git/scripts/meowsic-add-ai-score.py): left bar, list, badge, viewer, playback, Scores view, search, phone tabs
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5195/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const rows = () => page.$$eval('.lib-table tbody tr', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));

const items = await api('/items');
const ai = items.find((x) => x.ai);
check('server has one AI piece', items.filter((x) => x.ai).length === 1 && ai.kind === 'score' && ai.tags.includes('AI Studio'), JSON.stringify(items.map((x) => [x.title, x.ai])));

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(600);
const side = await page.$$eval('#side .nav.sub', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('left bar: Sheets, Scores, Chords, Books, AI Studio', side.map((s) => s.replace(/ ?\d+$/, '')).join(',') === 'Sheets,Scores,Chords,Books,AI Studio', side.join(' | '));
check('AI Studio count 1, Scores count without it', /^AI Studio ?1$/.test(side[4]) && side[1].replace(" ", "") === `Scores${items.filter((x) => x.kind === 'score' && !x.ai).length}`, side.join(' | '));
check('All music shows an AI Studio badge', await page.$$eval('.lib-table tbody tr', (e, t) => e.some((x) => x.textContent.includes(t) && x.querySelector('.badge.k-ai')?.textContent === 'AI Studio'), ai.title));

await page.goto(`${BASE}#/library?kind=ai`, { waitUntil: 'networkidle0' }); await sleep(600);
check('heading says AI Studio', (await page.$eval('#libhead h1', (e) => e.textContent)) === 'AI Studio');
const r = await rows();
check('AI Studio list has just the piece', r.length === 1 && r[0].includes(ai.title), r.join(' | '));
const heads = await page.$$eval('.lib-table thead th', (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean));
check('columns Title, Version, Tag, Key, Added', heads.join(',') === 'Title,Version,Tag,Key,Added', heads.join(','));
check('left bar AI Studio is on', await page.$eval('#side .nav.sub.on', (e) => e.textContent.includes('AI Studio')));

await page.goto(`${BASE}#/library?kind=score`, { waitUntil: 'networkidle0' }); await sleep(600);
check('Scores view does not list it', !(await rows()).some((x) => x.includes(ai.title)));

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(400);
await page.type('#lib-q', 'AI'); await sleep(500);
check('search "AI" finds it', (await rows()).some((x) => x.includes(ai.title)));

await page.goto(`${BASE}#/library?kind=ai`, { waitUntil: 'networkidle0' }); await sleep(500);
await page.click('.lib-table tbody tr .row-title'); await sleep(2500);
check('opens the item', (await page.evaluate(() => location.hash)) === `#/item/${ai.id}`, await page.evaluate(() => location.hash));
check('score renders (#osmd svg)', (await page.$$('#osmd svg')).length >= 1);
await page.click('#sc-play'); await sleep(2500);
const pos = +(await page.$eval('#sc-pos', (e) => e.value));
check('Play moves the playhead', pos > 0.3, String(pos));
check('button says Pause while playing', (await page.$eval('#sc-play', (e) => e.textContent)) === 'Pause');
await page.click('#sc-play');
await page.screenshot({ path: 'aimusic.png' });

// iPhone: segmented tabs in the same order, AI Studio tab filters
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(600);
const tabs = await page.$$eval('#libhead .seg button', (e) => e.map((x) => x.textContent.trim()));
check('phone tabs: All, Sheets, Scores, Chords, Books, AI Studio', tabs.join(',') === 'All,Sheets,Scores,Chords,Books,AI Studio', tabs.join(','));
await page.click('#libhead .seg button[data-kind="ai"]'); await sleep(600);
check('phone AI Studio tab lists it', (await page.evaluate(() => location.hash)).includes('kind=ai') && (await page.$$eval('.lib-table tbody tr', (e) => e.length)) === 1);
const segH = await page.$eval('#libhead .seg', (e) => e.getBoundingClientRect().height);
check('phone tabs fit on one row', segH < 60, String(segH));
check('no horizontal scroll on phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.screenshot({ path: 'aimusic-phone.png' });

console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail || errs.length ? 1 : 0);
