// Clean up page against the temp server :5190 ("Cleanup test" = 8 real screenshot pages of different songs + odd title)
import puppeteer from 'puppeteer-core';
const BASE = 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text() + ' ' + (m.location()?.url || '')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const imgSize = async (id, n) => { const it = await api('/items/' + id); const r = await fetch(`${BASE}api/items/${id}/file/${encodeURIComponent(it.pageFiles[n - 1])}`); const buf = Buffer.from(await r.arrayBuffer()); return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; };

// reset
const items = await api('/items');
const sh = items.find((x) => x.title.startsWith('Cleanup test'));
for (let n = 1; n <= sh.pages; n++) await post(`/items/${sh.id}/pages/${n}/untrim`, { all: true });
await fetch(`${BASE}api/items/${sh.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Cleanup test"}' });
for (const x of items.filter((x) => x.title === 'Moon River')) await fetch(`${BASE}api/items/${x.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"IMG_4821"}' });
for (const k of [`song:${sh.id}`, ...Array.from({ length: 8 }, (_, i) => `${sh.id}:${i + 1}`)]) await post('/cleanup/ok', { key: k, undo: true });

await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' });
for (let i = 0; i < 40; i++) { await sleep(1000); if (!(await page.$eval('#cu-scan', (e) => e.textContent))) break; }
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
check('songs list with status', (await page.$$('#cu-list li')).length >= 1);
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(500);
const issues = await page.$$eval('.cu-issue', (e) => e.map((x) => x.textContent));
check('dots warning: different songs mixed', issues.some((t) => /disagree|mixed/.test(t)), issues.join(' | '));
check('trim issue shown', issues.some((t) => /to trim/.test(t)), issues.join(' | '));
const strip = await page.$$eval('.cu-strip button span', (e) => e.map((x) => x.textContent));
check('page strip shows dot numbers', strip.some((t) => /dot \d\/\d/.test(t)), strip.join(' | '));
await page.screenshot({ path: 'cleanup-1.png' });
const counts = await page.$$eval('[data-f] i', (e) => e.map((x) => +x.textContent));
check('filters: needs a look + good = all', counts[0] + counts[1] === counts[2], counts.join(','));
// page 2: suggested crop, Enter trims, left/right unchanged
await page.click('.cu-strip button[data-p="1"]'); await sleep(300);
const [w0, h0] = await imgSize(sh.id, 2);
await page.keyboard.press('Enter'); await sleep(1500);
const [w1, h1] = await imgSize(sh.id, 2);
check('Enter trims top/bottom only', h1 < h0 && w1 === w0, `${w0}x${h0} → ${w1}x${h1}`);
check('moves on to the next page', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 2);
await page.keyboard.press('z'); await sleep(1500);
check('Z undoes the trim', (await imgSize(sh.id, 2))[1] === h0);
// free crop: draw a box
await page.click('.cu-strip button[data-p="3"]'); await sleep(400);
const r = await page.$eval('#cu-img', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
await page.mouse.move(r.x + r.w * 0.1, r.y + r.h * 0.2); await page.mouse.down();
await page.mouse.move(r.x + r.w * 0.5, r.y + r.h * 0.5, { steps: 5 }); await page.mouse.move(r.x + r.w * 0.9, r.y + r.h * 0.8, { steps: 5 }); await page.mouse.up();
const box = await page.$eval('.cu-img', (e) => ['--t', '--b', '--l', '--r'].map((k) => parseFloat(e.style.getPropertyValue(k))));
check('drawing a box sets all four edges', Math.abs(box[0] - 20) < 2 && Math.abs(box[2] - 10) < 2 && Math.abs(box[3] - 90) < 2, box.join(','));
await page.keyboard.down('Alt'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Alt');
const l2 = await page.$eval('.cu-img', (e) => parseFloat(e.style.getPropertyValue('--l')));
check('⌥→ moves the left edge', l2 > box[2], l2);
const [w3, h3] = await imgSize(sh.id, 4);
await page.keyboard.press('t'); await sleep(1500);
const [w4, h4] = await imgSize(sh.id, 4);
check('free crop trims all sides', w4 < w3 * 0.85 && h4 < h3 * 0.7, `${w3}x${h3} → ${w4}x${h4}`);
await page.click('.cu-strip button[data-p="3"]'); await sleep(400);
await page.keyboard.press('o'); await sleep(1500);
check('O restores the original', (await imgSize(sh.id, 4))[0] === w3);
await page.keyboard.press('c'); await sleep(100);
check('C clears the box (whole page)', await page.$eval('.cu-img', (e) => parseFloat(e.style.getPropertyValue('--t')) === 0 && parseFloat(e.style.getPropertyValue('--b')) === 100));
await page.keyboard.press('x'); await sleep(200);
check('X brings back the suggested box', await page.$eval('.cu-img', (e) => parseFloat(e.style.getPropertyValue('--t')) > 0));
await page.keyboard.press('f'); await sleep(1200);
const strip2 = await page.$$eval('.cu-strip button span', (e) => e.map((x) => x.textContent));
check('F: that page no longer suggests a trim', !/✂/.test(strip2[3]), strip2[3]);
await page.keyboard.press('r'); await sleep(200);
await page.keyboard.type('Cleanup test renamed'); await page.keyboard.press('Enter'); await sleep(1200);
check('R renames the song', (await api('/items/' + sh.id)).title === 'Cleanup test renamed');
check('page image still loads after rename', await page.$eval('#cu-img', (e) => e.complete && e.naturalWidth > 0));
await page.keyboard.press('z'); await sleep(1500);
check('Z undoes the rename', (await api('/items/' + sh.id)).title === 'Cleanup test');
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(400);
await page.keyboard.press('g'); await sleep(1200);
check('G marks the song good (leaves Needs a look)', !(await page.$(`#cu-list li[data-id="${sh.id}"]`)));
await page.click('[data-f="good"]'); await sleep(300);
check('…and it is under Good', !!(await page.$(`#cu-list li[data-id="${sh.id}"]`)));
await page.keyboard.press('z'); await sleep(1500);
await page.click('[data-f="look"]'); await sleep(300);
check('Z puts it back to Needs a look', !!(await page.$(`#cu-list li[data-id="${sh.id}"]`)));
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(300);
await page.keyboard.press('ArrowRight'); await sleep(200);
check('→ next page', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 1);
// preset box on every page
const all = (await api('/cleanup?id=' + sh.id)).songs[0].pages;
check('every page has a preset box', all.filter((x) => x.box || x.trim).length >= all.length - 1, all.map((x) => !!x.box).join(','));
// U: undo a trim and get its box back to adjust
await page.click('.cu-strip button[data-p="1"]'); await sleep(300);
await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
const tSet = await page.$eval('.cu-img', (e) => e.style.getPropertyValue('--t'));
await page.keyboard.press('Enter'); await sleep(1500);
await page.keyboard.press('u'); await sleep(1500);
check('U goes back to that page', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 1);
check('U puts the same box back', (await page.$eval('.cu-img', (e) => e.style.getPropertyValue('--t'))) === tSet, tSet);
// Enter on the last page goes to the next song
await page.click('.cu-strip button[data-p="7"]'); await sleep(300);
const before = await page.$eval('#cu-list li.on', (e) => e.dataset.id);
await page.keyboard.press('Enter'); await sleep(1500);
check('Enter on the last page → next song', (await page.$eval('#cu-list li.on', (e) => e.dataset.id)) !== before);
await page.keyboard.press('u'); await sleep(1500);
check('U from the next song comes back', (await page.$eval('#cu-list li.on', (e) => e.dataset.id)) === before);
// Split: pages 7-8 to a new song
await page.click('.cu-strip button[data-p="6"]'); await sleep(300);
await page.keyboard.press('s'); await sleep(500);
const ticked = await page.$$eval('.cu-pick button.on', (e) => e.map((x) => +x.dataset.p));
check('Split ticks from this page on', ticked.join() === '7,8', ticked.join());
await page.$eval('#cu-st', (e) => (e.value = 'Split part'));
await page.click('.modal [data-ok]'); await sleep(2500);
const sp = (await api('/items')).find((x) => x.title === 'Split part');
check('Split makes a new song with those pages', sp?.pages === 2 && (await api('/items/' + sh.id)).pages === 6, JSON.stringify([sp?.pages]));
// Delete the new song, U brings it back
await page.click('[data-f="all"]'); await sleep(300);
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sp.id); await sleep(400);
await page.keyboard.press('Delete'); await sleep(400);
await page.click('.modal [data-ok]'); await sleep(1500);
check('Delete moves the song to the Trash', (await api('/items/' + sp.id)).deleted === true);
await page.keyboard.press('u'); await sleep(2000);
check('U restores it', (await api('/items/' + sp.id)).deleted === false);
// put the test song back together for the next run
await post(`/items/${sh.id}/join`, { other: sp.id });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await page.keyboard.press('2'); await sleep(400);
const odd = await page.$$eval('.cu-trow input', (e) => e.map((x) => x.value));
check('odd titles listed (IMG_4821)', odd.includes('IMG_4821'), odd.join(' | '));
await page.screenshot({ path: 'cleanup-2.png' });
const k = odd.indexOf('IMG_4821');
for (let i = 0; i < k; i++) await page.keyboard.press('ArrowDown');
await page.keyboard.press('r'); await sleep(200);
await page.keyboard.type('Moon River'); await page.keyboard.press('Enter'); await sleep(1200);
check('rename an odd title', (await api('/items')).some((x) => x.title === 'Moon River'));
check('renamed title leaves the list', !(await page.$$eval('.cu-trow input', (e) => e.map((x) => x.value))).includes('Moon River'));
await page.keyboard.press('?'); await sleep(300);
check('? shows the shortcuts', (await page.$$('.modal .cu-keys tr')).length >= 10);
await page.keyboard.press('Escape'); await sleep(200);
for (let i = 0; i < 40; i++) { await sleep(1000); if (!(await api('/cleanup')).scan.running) break; }
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await page.click('#cu-all'); await sleep(300);
await page.click('.modal [data-ok]'); await sleep(12000);
const left = (await api('/cleanup')).songs.filter((s) => !s.reviewed).flatMap((s) => s.pages.filter((p) => p.trim)).length;
check('Trim all leaves nothing to trim', left === 0, left);
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(800);
await page.screenshot({ path: 'cleanup-3.png' });
// shortcuts stop when you leave Clean up
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(300);
await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(800);
await page.evaluate(() => { location.hash = '#/library'; }); await sleep(500);
const t0 = (await api('/items/' + sh.id)).updatedAt;
await page.keyboard.press('Enter'); await page.keyboard.press('g'); await sleep(1000);
check('keys do nothing after leaving Clean up', (await api('/items/' + sh.id)).updatedAt === t0 && (await page.evaluate(() => location.hash)) === '#/library');
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
