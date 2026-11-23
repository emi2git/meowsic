// End-to-end against the real server (temp data on :5190)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle0' });
check('UI runs in server mode', await page.evaluate(async () => (await import('/js/store.js')).store.mode) === 'server');
check('empty library', (await page.$eval('#main', (e) => e.textContent)).includes('Nothing here yet'));
// add sheets: two pages of one song + one single page, real upload
fs.mkdirSync('/tmp/mtest', { recursive: true });
const png = (s) => fs.readFileSync(new URL('./shots/mac-light-item_s_001.png', import.meta.url));
await page.goto(BASE + '#/add-sheets', { waitUntil: 'networkidle0' });
const files = ['Moon River 1.png', 'Moon River 2.png', 'Edelweiss.png'].map((n, i) => { const p = '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/e2e/up-' + i + '.png'; fs.writeFileSync(p, Buffer.concat([png(), Buffer.from('x' + i)])); const q = p.replace(/up-\d\.png$/, n.replace(/ /g, '_')); fs.copyFileSync(p, q); return q; });
const input = await page.$('#files'); await input.uploadFile(...files); await sleep(2500);
check('review groups 2 sheets', (await page.$$('.rv-card')).length === 2, (await page.$$('.rv-card')).length);
await page.click('#rv-add'); await sleep(2500);
let items = await api('/items');
check('2 sheets on the server', items.filter((x) => x.kind === 'sheet').length === 2);
const mr = items.find((x) => x.title.startsWith('Moon River'));
check('folder named "<id> <title>" with page files "<id> <title> 1.png"', mr.folder === `${mr.id} ${mr.title}` && mr.pageFiles[0] === `${mr.folder} 1.png`, JSON.stringify([mr.folder, mr.pageFiles]));
await page.goto(BASE + '#/item/' + mr.id, { waitUntil: 'networkidle0' }); await sleep(800);
check('sheet pages load from the Mac', await page.$$eval('.page img', (e) => e.every((i) => i.naturalWidth > 0 && i.src.includes('/api/items/'))));
// rename → folder + files renamed
await page.evaluate(async (id) => (await import('/js/store.js')).store.update(id, { title: 'Moon River (Mancini)' }), mr.id); await sleep(800);
const mr2 = await api('/items/' + mr.id);
check('rename renames folder and files', mr2.folder.endsWith('Moon River (Mancini)') && mr2.pageFiles[0].startsWith(mr2.folder), mr2.folder);
// tags + annotation + play
await page.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.setTags([id], ['Movie']); store.setStrokes(id, 1, [{ tool: 'red', pts: [[0.1, 0.1], [0.2, 0.2]] }]); store.logPlay(id, Date.now() - 60000, Date.now()); store.markPrinted([id]); }, mr.id); await sleep(800);
const back = await api('/backup');
check('tag saved on the Mac', back.items.find((x) => x.id === mr.id).tags.includes('Movie'));
check('annotation saved on the Mac', (back.annotations[mr.id + ':1'] || []).length === 1);
check('play saved', back.plays.length === 1);
check('printed saved', !!back.printed[mr.id]);
// chords: real search + save
await page.goto(BASE + '#/add-chords', { waitUntil: 'networkidle0' });
await page.type('#cs-q', 'amazing grace'); await sleep(6000);
const n = (await page.$$('#cs-results .row')).length;
check('real chord search returns results', n > 0, n);
if (n) { await page.click('#cs-results .row'); await sleep(6000); const has = await page.$('#pv-save'); check('preview fetched', !!has); if (has) { await page.click('#pv-save'); await sleep(1000); } }
items = await api('/items');
const ch = items.find((x) => x.kind === 'chords');
check('chord chart saved with real URL and fetch date', ch && ch.url.startsWith('http') && !ch.url.includes('/mock/') && ch.originAt > 0, JSON.stringify(ch && [ch.url, ch.originAt]));
// score: create one from MusicXML and play it
const xml = fs.readFileSync('/Users/emi2mac/Documents/Emi Music Note/memory-from-cats-andrew-lloyd-webber/memory-from-cats-andrew-lloyd-webber.musicxml', 'utf8');
const sc = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: 'Memory test', version: 'original', musicxmlText: xml }) });
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' });
await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await sleep(4000);
check('real score draws', (await page.$$('#osmd svg')).length > 0);
await page.click('#sc-play'); await sleep(2500);
check('real score plays', (await page.evaluate(() => window.__score.player.now())) > 0.5);
await page.click('#sc-play');
// trash + purge removes folder
await page.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.bin([id]); }, mr.id); await sleep(500);
check('trash on the Mac', (await api('/items/' + mr.id)).deleted === true);
await page.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.purge([id]); }, mr.id); await sleep(800);
check('purge deletes the folder', !fs.existsSync('/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/mdata/items/' + mr2.folder));
// offline: server unreachable → cached library
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no console errors');
await b.close();
