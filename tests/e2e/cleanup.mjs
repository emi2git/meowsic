// Clean up page against the temp server :5190, or BASE=http://localhost:5202/ ("Cleanup test" = 8 real screenshot
// pages of different songs + odd title; at least one sheet must be a book — books never show in Clean up)
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text() + ' ' + (m.location()?.url || '')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const pngSize = async (url) => { const buf = Buffer.from(await (await fetch(url)).arrayBuffer()); return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; };
const origSize = (id, n) => pngSize(`${BASE}api/items/${id}/pages/${n}/original`);
const boxNow = (pg) => pg.$eval('.cu-img', (e) => Object.fromEntries(['t', 'b', 'l', 'r'].map((k) => [k, parseFloat(e.style.getPropertyValue('--' + k)) / 100])));
const near = (a, b, d = 0.002) => ['t', 'b', 'l', 'r'].every((k) => Math.abs(a[k] - b[k]) <= d);
const cropPx = ([W, H], x) => [Math.round(x.r * W) - Math.round(x.l * W), Math.round(x.b * H) - Math.round(x.t * H)];
const sizeOk = (a, b) => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;
const tabKey = async (pg, n) => { await pg.keyboard.down('Alt'); await pg.keyboard.press(String(n)); await pg.keyboard.up('Alt'); };  // ⌥1/2/3 = tabs
const hint = (pg) => pg.$eval('.cu-from', (e) => e.textContent);
const imgSize = async (id, n) => { const it = await api('/items/' + id); const r = await fetch(`${BASE}api/items/${id}/file/${encodeURIComponent(it.pageFiles[n - 1])}`); const buf = Buffer.from(await r.arrayBuffer()); return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; };

// reset
const items = await api('/items');
const sh = items.find((x) => x.title.startsWith('Cleanup test'));
for (let n = 1; n <= sh.pages; n++) await post(`/items/${sh.id}/pages/${n}/untrim`, { all: true });
await fetch(`${BASE}api/items/${sh.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Cleanup test"}' });
for (const x of items.filter((x) => x.title === 'Moon River')) await fetch(`${BASE}api/items/${x.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"IMG_4821"}' });
for (const k of [`song:${sh.id}`, ...Array.from({ length: 8 }, (_, i) => `${sh.id}:${i + 1}`)]) await post('/cleanup/ok', { key: k, undo: true });
for (let n = 1; n <= 8; n++) await post('/cleanup/later', { key: `${sh.id}:${n}`, undo: true });
for (const n of [1, 2]) await post('/cleanup/frames', { n, box: null });

await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' });
for (let i = 0; i < 40; i++) { await sleep(1000); if (!(await page.$eval('#cu-scan', (e) => e.textContent))) break; }
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await tabKey(page, 2); await sleep(600);
check('songs list with status', (await page.$$('#cu-list li')).length >= 1);
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(500);
const issues = await page.$$eval('.cu-issue', (e) => e.map((x) => x.textContent));
check('dots warning: different songs mixed', issues.some((t) => /different songs/.test(t)), issues.join(' | '));
check('trim issue shown', issues.some((t) => /junk to trim/.test(t)), issues.join(' | '));
const strip = await page.$$eval('.cu-strip button span', (e) => e.map((x) => x.textContent));
check('page strip shows dot numbers', strip.some((t) => /dot \d\/\d/.test(t)), strip.join(' | '));
await page.screenshot({ path: 'cleanup-1.png' });
const counts = await page.$$eval('[data-f] i', (e) => e.map((x) => +x.textContent));
check('filters: to do + later + done = all', counts[0] + counts[1] + counts[2] === counts[3], counts.join(','));
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
// U: undo a trim → back to that page with the box it had before (here: the suggested one)
await page.click('.cu-strip button[data-p="1"]'); await sleep(300);
const tSug = await page.$eval('.cu-img', (e) => e.style.getPropertyValue('--t'));
await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter'); await sleep(1500);
await page.keyboard.press('u'); await sleep(1500);
check('U goes back to that page', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 1);
check('U puts the previous box back (suggested)', (await page.$eval('.cu-img', (e) => e.style.getPropertyValue('--t'))) === tSug && (await hint(page)) === 'Suggested', tSug);
// ---------- crop workflow: always the original photo with the box on it ----------
{
  await page.click('.cu-strip button[data-p="4"]'); await sleep(500);
  const O = await origSize(sh.id, 5);
  const r5 = await page.$eval('#cu-img', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
  await page.mouse.move(r5.x + r5.w * 0.15, r5.y + r5.h * 0.1); await page.mouse.down();
  await page.mouse.move(r5.x + r5.w * 0.5, r5.y + r5.h * 0.4, { steps: 5 }); await page.mouse.move(r5.x + r5.w * 0.85, r5.y + r5.h * 0.7, { steps: 5 }); await page.mouse.up();
  const b1 = await boxNow(page);
  await page.keyboard.press('t'); await sleep(1800);
  check('trim crops the page to the box', sizeOk(await imgSize(sh.id, 5), cropPx(O, b1)), `${await imgSize(sh.id, 5)} vs ${cropPx(O, b1)}`);
  check('next page starts with the same box', near(await boxNow(page), b1) && (await hint(page)) === 'Same as page 5', `${JSON.stringify(await boxNow(page))} ${await hint(page)}`);
  {  // …and so does the first page of another song
    const other = (await api('/cleanup')).songs.find((x) => x.id !== sh.id && x.pages.length && !x.pages[0].crop);
    await page.click('[data-f="all"]'); await sleep(300);
    await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), other.id); await sleep(600);
    check('next song starts with the last crop too', near(await boxNow(page), b1) && (await hint(page)) === 'Same as last crop (Cleanup test p5)', `${other.title}: ${await hint(page)}`);
    await page.click('[data-f="look"]'); await sleep(300);
    await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(500);
  }
  await page.click('.cu-strip button[data-p="4"]'); await sleep(800);
  const nat =await page.$eval('#cu-img', (e) => [e.naturalWidth, e.naturalHeight]);
  check('after Trim the stage still shows the original photo', nat[0] === O[0] && nat[1] === O[1], `${nat} vs ${O}`);
  check('…with the box where it was cropped', near(await boxNow(page), b1) && (await hint(page)) === 'Cropped', JSON.stringify(await boxNow(page)));
  check('page reports its crop', near(Object.fromEntries(Object.entries((await api('/cleanup?id=' + sh.id)).songs[0].pages[4].crop).map(([k, v]) => [k[0], v])), b1, 0.001));
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');  // top edge up: more than the cropped file has
  const b2 = await boxNow(page);
  check('the box can grow past the old crop', b2.t < b1.t - 0.02, `${b1.t} → ${b2.t}`);
  await page.keyboard.press('t'); await sleep(1800);
  check('trim again cuts from the original', sizeOk(await imgSize(sh.id, 5), cropPx(O, b2)), `${await imgSize(sh.id, 5)} vs ${cropPx(O, b2)}`);
  await page.click('.cu-strip button[data-p="4"]'); await sleep(800);
  check('…and still shows the original with the new box', near(await boxNow(page), b2) && (await page.$eval('#cu-img', (e) => e.naturalHeight)) === O[1]);
  await page.keyboard.press('u'); await sleep(1800);
  check('Undo returns the previous box', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 4 && near(await boxNow(page), b1) && (await hint(page)) === 'Cropped', JSON.stringify(await boxNow(page)));
  check('…and the previous crop', sizeOk(await imgSize(sh.id, 5), cropPx(O, b1)));
  await page.click('#cu-orig'); await sleep(1800);
  check('Original photo restores the page', sizeOk(await imgSize(sh.id, 5), O) && !(await api('/cleanup?id=' + sh.id)).songs[0].pages[4].crop && !(await page.$('#cu-orig')));
  await page.keyboard.press('ArrowRight'); await sleep(400);
  check('…and the next page no longer copies its box', (await hint(page)) !== 'Same as page 5', await hint(page));
}
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
await tabKey(page, 3); await sleep(400);
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
check('? shows the shortcuts', (await page.$$('.modal .cu-keys tr')).length >= 4);
await page.keyboard.press('Escape'); await sleep(200);
// Suggested names: show, edit + Use this (renames, history), Undo, Keep mine (DATA = the server's data dir, for history)
{
  const mr = (await api('/items')).find((x) => x.title === 'Moon River');
  await post('/cleanup/suggest', { id: mr.id, title: 'Moon River (Mancini)', artist: 'Henry Mancini', why: 'test suggestion' });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800); await tabKey(page, 3); await sleep(400);
  const row = `.cu-srow[data-id="${mr.id}"]`;
  check('suggestion shows with count', !!(await page.$(row)) && /Suggested names \(\d+\)/.test(await page.$eval('.cu-sug h3', (e) => e.textContent))
    && +(await page.$eval('#cu-nt', (e) => e.textContent)) >= 1);
  for (const [w, h] of [[1376, 1032], [1032, 1376], [420, 912]]) {
    const q = await b.newPage(); await q.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
    await q.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(900); await tabKey(q, 3); await sleep(500);
    const fit = await q.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return !!r && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1
      && [...document.querySelectorAll(sel + ' input, ' + sel + ' button')].every((x) => x.getBoundingClientRect().right <= innerWidth + 1); }, row);
    check(`suggestion fits ${w}×${h} (no sideways scroll)`, fit);
    await q.screenshot({ path: `cleanup-suggest-${w}.png` }); await q.close();
  }
  const ti = `${row} input[data-k="title"]`;
  await page.click(ti); await page.$eval(ti, (e) => e.select()); await page.keyboard.type('Moon River Edited fzr'); await sleep(300);
  check('typing in a suggestion box triggers no shortcuts', (await page.$eval(ti, (e) => e.value)) === 'Moon River Edited fzr' && (await api('/items/' + mr.id)).title === 'Moon River');
  await page.click(`${row} [data-use]`); await sleep(1500);
  const it1 = await api('/items/' + mr.id);
  check('Use this renames with the edited title + artist', it1.title === 'Moon River Edited fzr' && it1.artist === 'Henry Mancini' && it1.folder.includes('Moon River Edited fzr'), JSON.stringify([it1.title, it1.artist, it1.folder]));
  check('accepted suggestion leaves the list', !(await page.$(row)));
  if (process.env.DATA) {
    const fs = await import('node:fs');
    const last = JSON.parse(fs.readFileSync(process.env.DATA + '/history/renames-cleanup.jsonl', 'utf8').trim().split('\n').at(-1));
    check('history line written', last.id === mr.id && last.old.title === 'Moon River' && last.new.title === 'Moon River Edited fzr' && last.at > 0, JSON.stringify(last));
  }
  await page.click('#cu-undo'); await sleep(1800);
  const it2 = await api('/items/' + mr.id);
  check('Undo restores the old title + artist', it2.title === 'Moon River' && it2.artist === mr.artist && !it2.folder.includes('Edited'), JSON.stringify([it2.title, it2.artist]));
  check('Undo brings the suggestion back', !!(await page.$(row)));
  await page.click(`${row} [data-keep]`); await sleep(1200);
  check('Keep mine hides it and keeps the name', !(await page.$(row)) && (await api('/items/' + mr.id)).title === 'Moon River' && !(await api('/cleanup/suggest')).some((x) => x.id === mr.id));
}
for (let i = 0; i < 40; i++) { await sleep(1000); if (!(await api('/cleanup')).scan.running) break; }
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await tabKey(page, 2); await sleep(500);
await page.click('#cu-more'); await sleep(250);
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => /Trim every page/.test(x.textContent)).click()); await sleep(300);
await page.click('.modal [data-ok]'); await sleep(12000);
const left = (await api('/cleanup')).songs.filter((s) => !s.reviewed).flatMap((s) => s.pages.filter((p) => p.trim)).length;
check('Trim all leaves nothing to trim', left === 0, left);
await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(800);
await page.screenshot({ path: 'cleanup-3.png' });
// ---------- Go through sheets ----------
{
  const png = (await import('fs')).readFileSync('/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/out/cover.png');
  const fd = new FormData(); fd.append('title', 'Throwaway ' + Date.now()); fd.append('files', new Blob([png, Buffer.from(String(Date.now()))], { type: 'image/png' }), 'x.png');
  const tw = (await (await fetch(BASE + 'api/sheets', { method: 'POST', body: fd })).json()).item;
  for (const x of await api('/items')) await post('/cleanup/sort', { id: x.id, decision: null });
  await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
  await tabKey(page, 1); await sleep(800);
  check('sheets: page 1 shows first', await page.$eval('#sv-pages img', (e) => e.complete && e.naturalWidth > 0));
  check('sheets: status chips shown', (await page.$$('.sv-title .cu-issue')).length > 0);
  check('sheets: undo is empty at first', await page.$eval('#cu-undo', (e) => e.disabled));
  const t1 = await page.$eval('.sv-title b', (e) => e.textContent);
  await page.keyboard.press('d'); await sleep(900);
  const t2 = await page.$eval('.sv-title b', (e) => e.textContent);
  check('D marks delete and goes to the next sheet', t1 !== t2 && Object.values((await api('/cleanup/sort')).decisions).includes('delete'), `${t1} → ${t2}`);
  check('Undo button says what it undoes', /Undo delete mark/.test(await page.$eval('#cu-undo', (e) => e.textContent)));
  await page.click('#cu-undo'); await sleep(900);
  check('Undo takes the mark back and returns to that sheet', (await page.$eval('.sv-title b', (e) => e.textContent)) === t1 && !Object.keys((await api('/cleanup/sort')).decisions).length);
  await page.keyboard.press('k'); await sleep(900);
  check('K keeps and moves on', Object.values((await api('/cleanup/sort')).decisions).includes('keep'));
  await page.keyboard.press('ArrowLeft'); await sleep(500);
  check('← goes back even to a decided sheet', (await page.$eval('.sv-title b', (e) => e.textContent)) === t1 && /kept/.test(await page.$eval('.sv-title small', (e) => e.textContent)));
  await page.click('[data-show="all"]'); await sleep(400);
  for (let i = 0; i < 60 && (await page.$eval('.sv-title b', (e) => e.textContent)) !== tw.title; i++) { await page.click('#sv-next'); await sleep(250); }
  check('Next/Previous buttons walk the sheets', (await page.$eval('.sv-title b', (e) => e.textContent)) === tw.title);
  if ((await page.$eval('.sv-title b', (e) => e.textContent)) !== tw.title) throw new Error('not on the throwaway sheet — stop before deleting anything else');
  await page.click('#sv-del'); await sleep(900);
  await page.click('#sv-finish'); await sleep(600);
  const sum = await page.$$eval('.sv-grid button', (e) => e.map((x) => x.dataset.id));
  check('summary lists the sheets to delete', sum.length === 1 && sum[0] === tw.id, sum.join());
  await page.screenshot({ path: 'cleanup-sort-sum.png' });
  await page.click('#sv-go'); await sleep(400); await page.click('.modal [data-ok]'); await sleep(1500);
  check('Delete really deletes (to the Trash)', (await api('/items/' + tw.id)).deleted === true);
  await page.click('#cu-undo'); await sleep(2500);
  check('Undo brings the deleted sheets back', (await api('/items/' + tw.id)).deleted === false);
  await page.click('#sv-go'); await sleep(400); await page.click('.modal [data-ok]'); await sleep(1500);
  await page.click('#sv-purge'); await sleep(400); await page.click('.modal [data-ok]'); await sleep(1500);
  const gone = await fetch(BASE + 'api/items/' + tw.id).then((r) => r.status);
  check('…and can then be deleted for good', gone === 404, gone);
  for (const x of await api('/items')) await post('/cleanup/sort', { id: x.id, decision: null });
}
// ---------- books are nowhere in Clean up ----------
{
  const its = await api('/items'), books = its.filter((x) => x.kind === 'sheet' && x.book), sheetsN = its.filter((x) => x.kind === 'sheet' && !x.book && !x.deleted).length;
  check('test data has a book', books.length > 0);
  const bookIds = books.map((x) => x.id);
  const d = await api('/cleanup');
  check('API: no books in songs or titles', !d.songs.some((x) => bookIds.includes(x.id)) && !d.titles.some((x) => bookIds.includes(x.id)));
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await tabKey(page, 1); await sleep(500);
  await page.click('[data-show="all"]'); await sleep(300);
  check('Go through sheets: All counts only sheets', +(await page.$eval('[data-show="all"] i', (e) => e.textContent)) === sheetsN, sheetsN);
  const seen = [];
  for (let i = 0; i < sheetsN + 2; i++) { seen.push(await page.$eval('.sv-title b', (e) => e.textContent)); await page.click('#sv-next'); await sleep(200); }
  check('Go through sheets: no book shown', !books.some((x) => seen.includes(x.title)) && !/Book ·/.test(await page.$eval('.sv-title small', (e) => e.textContent)), seen.join(' | '));
  await tabKey(page, 2); await sleep(500); await page.click('[data-f="all"]'); await sleep(300);
  const fixIds = await page.$$eval('#cu-list li', (e) => e.map((x) => x.dataset.id));
  check('Fix pages: no book listed', fixIds.length === sheetsN && !fixIds.some((x) => bookIds.includes(x)), fixIds.join());
  await tabKey(page, 3); await sleep(400);
  check('Titles: no book listed', !(await page.$$eval('.cu-trow', (e) => e.map((x) => x.dataset.id))).some((x) => bookIds.includes(x)));
}
// ---------- note for Claude ----------
{
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await tabKey(page, 1); await sleep(500);
  const nid = await page.$eval('#cu-note', (e) => e.dataset.id), t1 = await page.$eval('.sv-title b', (e) => e.textContent);
  await page.click('#cu-note'); await page.keyboard.type('dk split after page 3'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  await sleep(1000);
  const notes = await api('/cleanup/notes');
  check('typing a note saves it', notes.some((x) => x.id === nid && x.text === 'dk split after page 3' && x.title === t1), JSON.stringify(notes));
  check('…shows Saved', await page.$eval('#cu-note-st', (e) => e.classList.contains('on') && /Saved/.test(e.textContent)));
  check('typing d / k / arrows in the note marks nothing and stays on the sheet', !Object.keys((await api('/cleanup/sort')).decisions).length && (await page.$eval('.sv-title b', (e) => e.textContent)) === t1);
  await page.keyboard.press('Escape'); await sleep(100);
  check('Esc leaves the note box', await page.evaluate(() => document.activeElement?.id !== 'cu-note'));
  await page.keyboard.press('k'); await sleep(800);
  check('…then K works again', (await api('/cleanup/sort')).decisions[nid] === 'keep');
  await post('/cleanup/sort', { id: nid, decision: null });
  // typed then moved on at once: still saved
  await page.click('#sv-next'); await sleep(300);
  const nid2 = await page.$eval('#cu-note', (e) => e.dataset.id);
  await page.click('#cu-note'); await page.keyboard.type('rename to Moon River'); await page.click('#sv-next'); await sleep(800);
  check('moving on right away still saves', (await api('/cleanup/notes')).some((x) => x.id === nid2 && x.text === 'rename to Moon River'));
  await post('/cleanup/notes', { id: nid2, text: '' });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await tabKey(page, 1); await sleep(500);
  await page.click('[data-show="note"]'); await sleep(300);
  check('With a note filter: count and sheet', +(await page.$eval('[data-show="note"] i', (e) => e.textContent)) === 1 && (await page.$eval('#cu-note', (e) => e.dataset.id)) === nid);
  check('note comes back after reload', (await page.$eval('#cu-note', (e) => e.value)) === 'dk split after page 3');
  await tabKey(page, 2); await sleep(500); await page.click('[data-f="all"]'); await sleep(300);
  check('Fix pages marks the sheet with a note ✎', await page.$eval(`#cu-list li[data-id="${nid}"]`, (e) => !!e.querySelector('.cu-pen')) && !(await page.$$eval('#cu-list li .cu-pen', (e) => e.length > 1)));
  await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), nid); await sleep(400);
  check('Fix pages shows the note', (await page.$eval('.cu-bar #cu-note', (e) => e.value)) === 'dk split after page 3');
  const pi = await page.$eval('.cu-strip button.on', (e) => +e.dataset.p), up0 = (await api('/items/' + nid)).updatedAt;
  await page.click('#cu-note'); await page.keyboard.press('End'); await page.keyboard.type(' ft'); await sleep(1000);
  check('Fix pages: typing saves, t / f do nothing', (await api('/cleanup/notes')).find((x) => x.id === nid)?.text === 'dk split after page 3 ft'
    && (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === pi && (await api('/items/' + nid)).updatedAt === up0);
}
// iPad Pro + iPhone: everything fits the screen (no page scroll; the note box and action buttons are on screen)
for (const [w, h] of [[1366, 1024], [1024, 1366], [390, 844]]) {
  const q = await b.newPage(); await q.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  await q.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(1200);
  for (const t of ['1', '2']) {
    await tabKey(q, t); await sleep(900);
    const fit = await q.evaluate(() => {
      const m = document.querySelector('#main'), btns = [...document.querySelectorAll('#sv-del, #sv-keep, #cu-trim, #cu-fine, #cu-later, [data-fr], [data-frs], #cu-note')];
      return { scroll: m.scrollHeight <= m.clientHeight + 1, side: getComputedStyle(document.querySelector('.side')).display, note: !!document.querySelector('#cu-note'), onScreen: btns.length > 0 && btns.every((x) => { const r = x.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0 && r.width > 0 && r.right <= innerWidth + 1 && x.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }) };
    });
    check(`${w < 600 ? 'iPhone' : 'iPad'} ${w}×${h} tab ${t}: fits, note box + buttons on screen, no left bar`, fit.scroll && fit.onScreen && fit.note && fit.side === 'none', JSON.stringify(fit));
    await q.screenshot({ path: `cleanup-ipad-${w}-${t}.png` });
  }
  await q.close();
}
// iPad: drag the box edges with a finger
{
  const q = await b.newPage(); await q.setViewport({ width: 1366, height: 1024, hasTouch: true, isMobile: true });
  await q.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(1000);
  await tabKey(q, 2); await sleep(600); await q.click('[data-f="all"]'); await sleep(300);
  await q.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(500);
  await q.evaluate(() => document.querySelector('.cu-strip button[data-p="2"]').click()); await sleep(600);
  const ir = await q.$eval('#cu-img', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
  const swipe = async (sel, dx, dy) => {
    const r = await q.$eval(sel, (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; });
    await q.touchscreen.touchStart(r.x, r.y);
    for (let i = 1; i <= 6; i++) { await q.touchscreen.touchMove(r.x + dx * i / 6, r.y + dy * i / 6); await sleep(20); }
    await q.touchscreen.touchEnd(); await sleep(200);
  };
  const t0 = await boxNow(q);
  await swipe('.cu-box i[data-e="top"]', 0, ir.h * 0.08);
  const t1 = await boxNow(q);
  check('iPad: finger drags the top edge', Math.abs(t1.t - t0.t - 0.08) < 0.02 && Math.abs(t1.b - t0.b) < 0.001, `${t0.t} → ${t1.t}`);
  await swipe('.cu-box i[data-e="right"]', -ir.w * 0.1, 0);
  const t2 = await boxNow(q);
  check('iPad: finger drags the right edge', Math.abs(t2.r - t1.r + 0.1) < 0.02 && Math.abs(t2.l - t1.l) < 0.001, `${t1.r} → ${t2.r}`);
  await swipe('.cu-box i[data-e="bottom left"]', ir.w * 0.05, -ir.h * 0.05);
  const t3 = await boxNow(q);
  check('iPad: finger drags a corner', t3.l > t2.l + 0.03 && t3.b < t2.b - 0.03, JSON.stringify(t3));
  await q.screenshot({ path: 'cleanup-ipad-touch.png' });
  await q.close();
}
// ---------- Crop / Keep / Later, done songs leave To do, saved frames ----------
{
  const P = async () => (await api('/cleanup?id=' + sh.id)).songs[0];
  const openSh = async (f = 'all') => {
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(800); await tabKey(page, 2); await sleep(500);
    await page.click(`[data-f="${f}"]`); await sleep(300);
    await page.evaluate((id) => document.querySelector(`#cu-list li[data-id="${id}"]`)?.click(), sh.id); await sleep(500);
  };
  for (const p of (await P()).pages) {  // start clean: nothing cropped, kept or left for later
    await post(`/items/${sh.id}/pages/${p.page}/untrim`, { all: true });
    await post('/cleanup/ok', { key: `${sh.id}:${p.page}`, undo: true }); await post('/cleanup/later', { key: `${sh.id}:${p.page}`, undo: true });
  }
  await post('/cleanup/ok', { key: `song:${sh.id}`, undo: true });
  let s0 = await P();
  check('song has a mixed issue and is To do', s0.issues.some((i) => i.kind === 'mixed') && s0.state === 'todo', JSON.stringify([s0.state, s0.issues.map((i) => i.kind)]));
  await openSh();
  const order = await page.$$eval('.cu-act button.big', (e) => e.map((x) => x.textContent.trim()));
  check('bottom bar: Crop / Keep / Later', order.length === 3 && /^Crop/.test(order[0]) && order[1] === 'Keep' && order[2] === 'Later', order.join(' / '));
  const keys = await page.evaluate(() => { dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); return new Promise((r) => setTimeout(() => { const t = document.querySelector('.cu-keys')?.textContent || ''; document.querySelector('.modal [data-close]')?.click(); r(t); }, 300)); });
  check('shortcuts list has L = Later and the frames', /Leave this page for later/.test(keys) && /Frame 1/.test(keys), keys.slice(0, 80));
  // Later moves on; Undo takes it back
  await page.click('.cu-strip button[data-p="1"]'); await sleep(300);
  await page.click('#cu-later'); await sleep(1200);
  check('Later moves on to the next page', (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 2);
  check('…and marks the page later on the Mac', (await P()).pages[1].later === true);
  await page.keyboard.press('z'); await sleep(1200);
  check('Undo of Later', (await P()).pages[1].later === false && (await page.$eval('.cu-strip button.on', (e) => +e.dataset.p)) === 1);
  // crop every other page; L leaves page 2 → the song goes to Later (not To do), also after a reload
  for (const p of s0.pages) if (p.page !== 2) await post(`/items/${sh.id}/pages/${p.page}/trim`, { top: 0.04, bottom: 0.96, left: 0, right: 1 });
  await openSh();
  await page.click('.cu-strip button[data-p="1"]'); await sleep(300);
  await page.keyboard.press('l'); await sleep(1200);
  let s1 = await P();
  check('L = Later; the song is Later, with later/done counts', s1.state === 'later' && s1.later === 1 && s1.done === s1.pages.length - 1, JSON.stringify([s1.state, s1.later, s1.done]));
  await openSh('later');
  check('after reload the song shows under Later', !!(await page.$(`#cu-list li[data-id="${sh.id}"]`)) && /later/.test((await page.$$eval('.cu-strip button span', (e) => e.map((x) => x.textContent)))[1]));
  const cnt = await page.$$eval('[data-f] i', (e) => e.map((x) => +x.textContent));
  check('Later (n) count', cnt[1] >= 1, cnt.join(','));
  // frames: draw a box on page 2, Shift+1 saves it, 1 applies it on another page, it survives a reload
  await page.click('.cu-strip button[data-p="1"]'); await sleep(400);
  const fr = await page.$eval('#cu-img', (e) => { const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; });
  await page.mouse.move(fr.x + fr.w * 0.3, fr.y + fr.h * 0.3); await page.mouse.down();
  await page.mouse.move(fr.x + fr.w * 0.5, fr.y + fr.h * 0.5, { steps: 5 }); await page.mouse.move(fr.x + fr.w * 0.85, fr.y + fr.h * 0.88, { steps: 5 }); await page.mouse.up();
  const fb = await boxNow(page);
  check('drew a box for the frame', Math.abs(fb.t - 0.3) < 0.02 && Math.abs(fb.r - 0.85) < 0.02, JSON.stringify(fb));
  check('Frame 1 is disabled before it is saved', await page.$eval('[data-fr="1"]', (e) => e.disabled));
  await page.keyboard.down('Shift'); await page.keyboard.press('1'); await page.keyboard.up('Shift'); await sleep(1000);
  const saved = (await api('/cleanup/frames'))['1'];
  check('⇧1 saves the box as Frame 1 on the Mac', saved && Math.abs(saved.top - fb.t) < 0.002 && Math.abs(saved.right - fb.r) < 0.002, JSON.stringify(saved));
  await page.click('.cu-strip button[data-p="0"]'); await sleep(400);
  check('another page starts with a different box', !near(await boxNow(page), fb));
  await page.keyboard.press('1'); await sleep(200);
  check('1 applies Frame 1', near(await boxNow(page), fb) && (await hint(page)) === 'Frame 1', JSON.stringify(await boxNow(page)));
  await openSh('later');
  check('Frame 1 survives a reload (label shown)', await page.$eval('[data-fr="1"]', (e) => !e.disabled && /top \d+%/.test(e.textContent)));
  check('Frame 2 still not saved', await page.$eval('[data-fr="2"]', (e) => e.disabled));
  await page.click('.cu-strip button[data-p="1"]'); await sleep(400);
  await page.click('[data-fr="1"]'); await sleep(200);
  check('tapping Frame 1 applies it', near(await boxNow(page), fb));
  await page.click('#cu-trim'); await sleep(1800);
  const s2 = await P();
  check('crop clears the later mark; every page cropped → Done', s2.state === 'done' && s2.later === 0 && s2.done === s2.pages.length && s2.pages[1].trims > 0, JSON.stringify([s2.state, s2.later, s2.done, s2.pages[1]]));
  await openSh('look');
  check('a song with all pages cropped is not in To do (mixed is only a hint)', !(await page.$(`#cu-list li[data-id="${sh.id}"]`)));
  await page.click('[data-f="good"]'); await sleep(300);
  check('…it is under Done', !!(await page.$(`#cu-list li[data-id="${sh.id}"]`)));
  // look at every page again: cropped pages never come back to To do
  await post('/cleanup/scan', {});
  for (let i = 0; i < 40; i++) { await sleep(800); if (!(await api('/cleanup?id=' + sh.id)).scan.running) break; }
  const s3 = await P();
  check('a cropped song does not come back to To do', s3.state === 'done' && s3.pages.every((p) => !p.trim), s3.state);
  // put it back
  for (const p of s3.pages) await post(`/items/${sh.id}/pages/${p.page}/untrim`, { all: true });
  for (const n of [1, 2]) await post('/cleanup/frames', { n, box: null });
}
// shortcuts stop when you leave Clean up
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(300);
await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(800);
await page.evaluate(() => { location.hash = '#/library'; }); await sleep(500);
const t0 = (await api('/items/' + sh.id)).updatedAt;
await page.keyboard.press('Enter'); await page.keyboard.press('g'); await sleep(1000);
check('keys do nothing after leaving Clean up', (await api('/items/' + sh.id)).updatedAt === t0 && (await page.evaluate(() => location.hash)) === '#/library');
for (const x of await api('/cleanup/notes')) await post('/cleanup/notes', { id: x.id, text: '' });
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
