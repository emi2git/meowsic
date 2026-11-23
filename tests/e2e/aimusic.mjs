// AI pieces through the UI (server on $BASE, default :5195, temp data with one AI piece added by
// ~/git/scripts/meowsic-add-ai-score.py): plain scores (no AI Studio section), listed + counted under Scores,
// Info says "Source: Meowsic"; a YouTube score's Info shows "YouTube" + the original link (clickable, Copy link)
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
check('server has one AI piece, a plain score with source Meowsic and no AI Studio tag', items.filter((x) => x.ai).length === 1 && ai.kind === 'score' && ai.source === 'Meowsic' && !ai.tags.includes('AI Studio'), JSON.stringify(items.filter((x) => x.ai)));
check('no AI Studio tag left', !(await api('/tags')).some((t) => t.name === 'AI Studio'));

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(600);
const side = await page.$$eval('#side .nav.sub', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('left bar: Sheets, Scores, Chords, Books (no AI Studio)', side.map((s) => s.replace(/ ?\d+$/, '')).join(',') === 'Sheets,Scores,Chords,Books', side.join(' | '));
check('Scores count includes the AI piece', side[1].replace(' ', '') === `Scores${items.filter((x) => x.kind === 'score' && !x.deleted).length}`, side.join(' | '));
check('All music shows it with a Score badge', await page.$$eval('.lib-table tbody tr', (e, t) => e.some((x) => x.textContent.includes(t) && x.querySelector('.badge.k-score')?.textContent === 'Score'), ai.title));
check('no AI badge anywhere', !(await page.$('.badge.k-ai')));

await page.goto(`${BASE}#/library?kind=score`, { waitUntil: 'networkidle0' }); await sleep(600);
check('Scores view lists it', (await rows()).some((x) => x.includes(ai.title)));

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(400);
await page.type('#lib-q', ai.title.slice(0, 6)); await sleep(500);
check('search finds it', (await rows()).some((x) => x.includes(ai.title)));

await page.goto(`${BASE}#/library?kind=score`, { waitUntil: 'networkidle0' }); await sleep(500);
await page.$$eval('.lib-table tbody tr', (e, t) => e.find((x) => x.textContent.includes(t)).querySelector('.row-title').click(), ai.title); await sleep(2500);
check('opens the item', (await page.evaluate(() => location.hash)) === `#/item/${ai.id}`, await page.evaluate(() => location.hash));
check('score renders (#osmd svg)', (await page.$$('#osmd svg')).length >= 1);
await page.click('#sc-play'); await sleep(2500);
const pos = +(await page.$eval('#sc-pos', (e) => e.value));
check('Play moves the playhead', pos > 0.3, String(pos));
check('button says Pause while playing', (await page.$eval('#sc-play', (e) => e.textContent)) === 'Pause');
await page.click('#sc-play');
await page.screenshot({ path: 'aimusic.png' });

// Info: source
const info = async () => { await page.click('#it-more'); await sleep(150); await page.$$eval('.menu button', (e) => e.find((x) => x.textContent.trim() === 'Info').click()); await sleep(300);
  return page.$eval('#it-info', (d) => { const dt = [...d.querySelectorAll('dt')].find((x) => x.textContent === 'Source'); return dt ? dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim() : null; }); };
const aiSrc = await info();
check('AI piece Info: Source is Meowsic', /^Meowsic(?! AI)/.test(aiSrc || '') && !(await page.$('#dt-copy')), aiSrc);
const yt = items.find((x) => x.kind === 'score' && !x.deleted && x.sourceUrl && x.source === 'YouTube');
if (!yt) check('a YouTube score to look at (migrated from the old source)', false);
else {
  await page.goto(`${BASE}#/item/${yt.id}`, { waitUntil: 'networkidle0' }); await sleep(1500);
  const s = await info();
  check('YouTube score Info: Source is YouTube + the original link', s?.startsWith('YouTube') && s.includes(yt.sourceUrl), s);
  const a = await page.$eval('#dt-source a.src-link', (x) => ({ href: x.href, target: x.target, text: x.textContent }));
  check('link is clickable, opens in a new tab', a.href === yt.sourceUrl && a.target === '_blank' && a.text === yt.sourceUrl, JSON.stringify(a));
  page.on('dialog', (d) => d.dismiss());
  await page.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } }); });
  await page.click('#dt-copy'); await sleep(300);
  const clip = await page.evaluate(() => window.__clip);
  check('Copy link says so', /Link copied/.test(await page.evaluate(() => document.body.textContent)));
  check('Copy link copies the original link', clip === yt.sourceUrl, clip);
  const ver = items.find((x) => x.kind === 'score' && !x.deleted && x.groupId === yt.groupId && x.source.startsWith('From the score'));
  if (ver) {
    await page.goto(`${BASE}#/item/${ver.id}`, { waitUntil: 'networkidle0' }); await sleep(1500);
    const v = await info();
    check('a version made from it keeps the original link', v?.startsWith('From the score') && v.includes(yt.sourceUrl), v);
  }
}

// iPhone: segmented tabs in the same order, no AI Studio tab
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' }); await sleep(600);
const tabs = await page.$$eval('#libhead .seg button', (e) => e.map((x) => x.textContent.trim()));
check('phone tabs: All, Sheets, Scores, Chords, Books', tabs.join(',') === 'All,Sheets,Scores,Chords,Books', tabs.join(','));
const segH = await page.$eval('#libhead .seg', (e) => e.getBoundingClientRect().height);
check('phone tabs fit on one row', segH < 60, String(segH));
check('no horizontal scroll on phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.screenshot({ path: 'aimusic-phone.png' });

console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail || errs.length ? 1 : 0);
