// Add music → From Photos against a TEST server started with a fake album (never the real library / Photos):
//   python3 tests/e2e/make_fake_album.py /tmp/x   then   MEOWSIC_FAKE_PHOTOS=/tmp/x MEOWSIC_DATA=<copy> python -m meowsic --port 5234
//   BASE=http://localhost:5234/ node photoimport.mjs      (SHOTS=<dir> for the screenshots)
// Covers: album listing, reading + proposed songs, break toggles, reorder (‹ ›, ⇧→), exclude, title edit,
// crop (box carry-over, whole page, later), add, undo (photos new again, same arrangement back), album name,
// and the layout on Mac, iPad Pro and iPhone Air sizes.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5234/';
const SHOTS = process.env.SHOTS || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const newPage = async (vp) => {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  return p;
};
// the colour square in each fake page's bottom-right corner says which photo it is (1..7)
const COLS = [[220, 40, 40], [40, 160, 40], [40, 60, 220], [200, 160, 20], [150, 40, 170], [20, 150, 160], [90, 90, 90]];
const pagesOf = (page, it) => page.evaluate(async (it, cols) => {
  const out = [];
  for (let n = 1; n <= it.pages; n++) {
    const img = new Image(); img.src = `/api/items/${encodeURIComponent(it.id)}/pages/${n}?x=${Math.random()}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
    const [r, g, bl] = c.getContext('2d').getImageData(Math.round(img.naturalWidth * 0.964), Math.round(img.naturalHeight - img.naturalWidth * 0.06), 1, 1).data;
    out.push(cols.findIndex((x) => Math.abs(x[0] - r) + Math.abs(x[1] - g) + Math.abs(x[2] - bl) < 40) + 1);
  }
  return out;
}, it, COLS);
const until = async (page, fn, arg, ms = 60000) => { try { await page.waitForFunction(fn, { timeout: ms, polling: 300 }, arg); return true; } catch { return false; } };

// ---- start clean: undo earlier imports of this album, album name back to SHEET ----
for (const imp of await api('/photos/imports')) if (!imp.undoneAt) await post(`/photos/imports/${imp.id}/undo`, {});
await fetch(BASE + 'api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photosAlbum: 'SHEET' }) });
const al0 = await api('/photos/album');
check('fake album: 7 photos, all new', al0.photos.length === 7 && al0.new === 7 && al0.fake, JSON.stringify({ n: al0.photos.length, new: al0.new, e: al0.error }));

const page = await newPage({ width: 1440, height: 900 });
await page.goto(BASE + '#/add-sheets', { waitUntil: 'networkidle0' });
check('Add sheet music offers From Photos', !!(await page.$('a.pi-from[href="#/add-photos"]')));
await page.click('a.pi-from'); await sleep(800);
check('album screen: 7 new', /7 new/.test(await page.$eval('.pi-count', (e) => e.textContent)));
// a wrong album name: clear message, then back
await page.$eval('#pi-album', (e) => { e.value = ''; });
await page.type('#pi-album', 'Holiday pics'); await page.click('#pi-look'); await sleep(900);
check('unknown album: “Album not found” + the albums there', /Album not found/.test(await page.$eval('.pi-err', (e) => e.textContent)) && /SHEET/.test(await page.$eval('.pi-err', (e) => e.textContent)));
await page.$eval('#pi-album', (e) => { e.value = ''; }); await page.type('#pi-album', 'sheet'); await page.keyboard.press('Enter'); await sleep(900);
check('album name matches without case', /7 new/.test(await page.$eval('.pi-count', (e) => e.textContent)));
check('album name saved in the settings', (await api('/settings')).photosAlbum === 'sheet');
await page.screenshot({ path: `${SHOTS}/photoimport-album.png` });

// ---- read the photos ----
await page.click('#pi-go');
check('reading shows progress', !!(await page.$('#pi-prog')));
check('preview appears', await until(page, () => document.querySelectorAll('#pi-grid figure').length === 7, null, 90000));
const starts = () => page.$$eval('#pi-grid figure', (fs) => fs.map((f, k) => (f.classList.contains('start') ? k + 1 : null)).filter(Boolean).join());
const order = () => page.$$eval('#pi-grid figure', (fs) => fs.map((f) => f.dataset.id.replace('fake-IMG_10', '')).join());
check('proposed songs start at photos 1, 3, 6, 7', (await starts()) === '1,3,6,7', await starts());
const titles = await page.$$eval('#pi-grid figure.start input', (e) => e.map((x) => x.value));
check('titles read off the pages', titles[0] === 'Moon River' && titles[1] === 'Yesterday', titles.join('|'));
check('“detected” hint under a read title', /detected/.test(await page.$eval('#pi-grid figure.start .bs-det', (e) => e.textContent)));
check('the holiday photo is marked not sure', !!(await page.$('#pi-grid figure:nth-child(7) .pi-unsure')));
await page.screenshot({ path: `${SHOTS}/photoimport-preview-mac.png` });

// exclude the holiday photo (✕), toggle a break off and on again
await page.click('#pi-grid figure:nth-child(7) [data-a="out"]'); await sleep(200);
check('✕ leaves photo 7 out', await page.$eval('#pi-grid figure:nth-child(7)', (e) => e.classList.contains('out')));
check('3 sheets now', /→ 3 sheets/.test(await page.$eval('#pi-sum', (e) => e.textContent)));
await page.click('#pi-grid figure:nth-child(6) .bs-pg'); await sleep(200);
check('tap photo 6: no new song there', (await starts()) === '1,3' && /→ 2 sheets/.test(await page.$eval('#pi-sum', (e) => e.textContent)));
await page.click('#pi-grid figure:nth-child(6) .bs-pg'); await sleep(200);
check('tap again: a song starts at 6', (await starts()) === '1,3,6');
check('its title box gets focus', await page.evaluate(() => document.activeElement?.matches('#pi-grid figure:nth-child(6) input')));
await page.keyboard.type('Edelweiss'); await page.keyboard.press('Enter');
await page.click('#pi-grid figure:nth-child(1) .bs-pg'); await sleep(100);
check('the first photo always starts a song', (await starts()) === '1,3,6');
// reorder: photo 5 one place earlier with ‹, then photo 2 later with ⇧→ and back with ⇧←
await page.click('#pi-grid figure:nth-child(5) [data-a="prev"]'); await sleep(200);
check('‹ moves photo 5 before photo 4', (await order()) === '1,2,3,5,4,6,7', await order());
await page.click('#pi-grid figure:nth-child(2) .bs-zoom'); await sleep(300); await page.keyboard.press(' '); await sleep(200);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift'); await sleep(200);
check('⇧→ moves the focused photo later', (await order()) === '1,3,2,5,4,6,7', await order());
await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift'); await sleep(200);
check('⇧← moves it back', (await order()) === '1,2,3,5,4,6,7', await order());
const segs = await page.$$eval('.pi-segs .bs-seg', (e) => e.map((x) => x.textContent));
check('song bands with titles', segs.join('|') === '1: Moon River · 2 pages|2: Yesterday · 3 pages|3: Edelweiss · 1 page', segs.join('|'));

// ---- crop: photo 1 trimmed at the top, photo 2 starts with the same box → whole page; the rest later ----
await page.click('#pi-crop'); await sleep(900);
check('crop stage shows photo 1', !!(await page.$('#pi-img')) && /Page 1 of 2/.test(await page.$eval('.pi-sum small', (e) => e.textContent)));
const from0 = await page.$eval('.cu-from', (e) => e.textContent);
check('box starts as the suggestion', /Suggested|Whole page/.test(from0), from0);
await page.keyboard.press('c'); for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
const box1 = await page.$eval('.cu-img', (e) => e.style.getPropertyValue('--t'));
check('↓ moves the top edge', parseFloat(box1) > 5, box1);
await page.keyboard.press('Enter'); await sleep(700);
check('Enter: on to photo 2 with the same box', (await page.$eval('.cu-from', (e) => e.textContent)) === 'Same as the last crop');
await page.click('#pi-whole'); await sleep(600);
check('Whole page: on to photo 3', /photo 3 of 6/.test(await page.$eval('.pi-sum small', (e) => e.textContent)));
await page.screenshot({ path: `${SHOTS}/photoimport-crop-mac.png` });
await page.click('#pi-done-crop'); await sleep(400);
check('back on the songs: 2 of 6 pages done', /2 of 6 done/.test(await page.$eval('#pi-crop', (e) => e.textContent)) && !!(await page.$('#pi-grid figure:nth-child(1) .pi-cropped')));

// ---- add ----
await page.click('#pi-add'); await sleep(400);
const conf = await page.$$eval('.bs-confirm li', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
check('confirm lists 3 sheets', conf.join('|') === 'Moon River 2 pages · 1 cropped|Yesterday 3 pages|Edelweiss 1 page', conf.join('|'));
await page.click('.modal [data-ok]');
check('added', await until(page, () => /3 sheets added/.test(document.querySelector('.pi-done h2')?.textContent || ''), null, 20000));
const items = await api('/items');
const made = ['Moon River', 'Yesterday', 'Edelweiss'].map((t) => items.find((x) => x.title === t && x.originAt >= 1_700_000_000_000 && x.originAt < 1_700_100_000_000));
check('3 new sheets in the library', made.every(Boolean), made.map((x) => x?.id).join());
if (made.every(Boolean)) {
  check('Moon River = photos 1, 2', (await pagesOf(page, made[0])).join() === '1,2', (await pagesOf(page, made[0])).join());
  check('Yesterday = photos 3, 5, 4 (your order)', (await pagesOf(page, made[1])).join() === '3,5,4', (await pagesOf(page, made[1])).join());
  check('Edelweiss = photo 6', (await pagesOf(page, made[2])).join() === '6');
  const size = (u) => page.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, u);
  const [w1, h1] = await size(`/api/items/${made[0].id}/pages/1?x=1`), [w0, h0] = await size(`/api/items/${made[0].id}/pages/1/original`);
  check('photo 1 cropped, its original kept', w1 === w0 && h1 < h0 * 0.97 && h0 === 1754, `${w1}x${h1} of ${w0}x${h0}`);
  const [w2, h2] = await size(`/api/items/${made[0].id}/pages/2?x=1`);
  check('photo 2 kept whole', w2 === 1240 && h2 === 1754, `${w2}x${h2}`);
}
const al1 = await api('/photos/album');
check('the album now: 1 new (the holiday photo)', al1.new === 1 && al1.photos.find((p) => !p.inLibrary)?.filename === 'IMG_107.jpg', al1.new);
check('activity logged', (await api('/activity')).some((a) => a.type === 'photo-import' && /Moon River/.test(a.detail)));
await page.screenshot({ path: `${SHOTS}/photoimport-done-mac.png` });

// ---- undo ----
check('Undo button offers it', /Undo add 3 sheets/.test(await page.$eval('#pi-undo', (e) => e.textContent)));
await page.click('#pi-undo');
check('undo: back to the preview', await until(page, () => document.querySelectorAll('#pi-grid figure').length === 7, null, 10000));
const gone = await Promise.all(made.filter(Boolean).map((s) => fetch(`${BASE}api/items/${s.id}`).then((r) => r.status)));
check('undo: the sheets are gone', gone.length === 3 && gone.every((x) => x === 404), gone.join());
check('undo: all 7 photos new again', (await api('/photos/album')).new === 7);
check('undo: your arrangement is still there', (await order()) === '1,2,3,5,4,6,7' && (await starts()) === '1,3,6' && await page.$eval('#pi-grid figure:nth-child(7)', (e) => e.classList.contains('out')));

// ---- iPad Pro and iPhone Air: everything fits, touch works ----
for (const [name, w, h] of [['iPad Pro', 1376, 1032], ['iPad Pro portrait', 1032, 1376], ['iPhone Air', 420, 912]]) {
  const p = await newPage({ width: w, height: h, hasTouch: true, isMobile: true });
  await p.goto(BASE + '#/add-photos', { waitUntil: 'networkidle0' }); await sleep(600);
  await p.tap('#pi-go');
  check(`${name}: preview`, await until(p, () => document.querySelectorAll('#pi-grid figure').length === 7, null, 60000));
  const fit = await p.evaluate(() => {
    const se = document.scrollingElement, add = document.querySelector('#pi-add').getBoundingClientRect(), g = document.querySelector('#pi-grid');
    const tb = document.querySelector('.tabbar'), tbt = tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().top : innerHeight;
    const fig = g.querySelector('figure').getBoundingClientRect(), mini = g.querySelector('[data-a="next"]').getBoundingClientRect();
    return { sw: se.scrollWidth, iw: innerWidth, sh: se.scrollHeight, ih: innerHeight, tbt, gb: g.getBoundingClientRect().bottom, addb: add.bottom, addw: add.width, fw: fig.width, mini: mini.width, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length };
  });
  check(`${name}: no sideways scroll, no page scroll`, fit.sw <= fit.iw + 1 && fit.sh <= fit.ih + 1, JSON.stringify(fit));
  check(`${name}: Add button on screen, photos end above the tab bar`, fit.addb <= fit.tbt && fit.addw > 80 && fit.gb <= fit.tbt + 1, JSON.stringify(fit));
  check(`${name}: photos big enough, buttons tappable`, fit.fw >= 150 && fit.mini >= 28, JSON.stringify(fit));
  await p.tap('#pi-grid figure:nth-child(2) .bs-pg'); await sleep(300);
  check(`${name}: tap marks a new song`, await p.$eval('#pi-grid figure:nth-child(2)', (e) => e.classList.contains('start')));
  await p.tap('#pi-grid figure:nth-child(2) [data-a="next"]'); await sleep(300);
  check(`${name}: › moves a photo`, (await p.$$eval('#pi-grid figure', (fs) => fs.map((f) => f.dataset.id.slice(-1)).join())).startsWith('1,3,2'));
  await p.screenshot({ path: `${SHOTS}/photoimport-${name.replace(/ /g, '-').toLowerCase()}.png` });
  await p.tap('#pi-crop'); await sleep(900);
  const cf = await p.evaluate(() => {
    const st = document.querySelector('#pi-stage').getBoundingClientRect(), act = document.querySelector('#pi-doit').getBoundingClientRect();
    const tb = document.querySelector('.tabbar'), tbt = tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().top : innerHeight;
    return { sth: st.height, actb: act.bottom, ih: tbt, sw: document.scrollingElement.scrollWidth, iw: innerWidth };
  });
  check(`${name}: crop stage fits with its buttons`, cf.sth > 200 && cf.actb <= cf.ih && cf.sw <= cf.iw + 1, JSON.stringify(cf));
  await p.screenshot({ path: `${SHOTS}/photoimport-crop-${name.replace(/ /g, '-').toLowerCase()}.png` });
  await p.close();
}

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
