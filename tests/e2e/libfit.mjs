// iPad / iPhone library: a page of the list = as many whole rows as fit between the header and the
// pager — no empty gap of a row or more, nothing under the pager or the tab bar, rows not shrunk.
// Every library tab (All / Sheets / Scores / Chords / Books), several screen sizes (iPhone Air with
// and without Safari's toolbar, iPhone 15/16, iPad both ways), a resize in place keeps the first
// row on screen, and the Mac keeps its scrolling 50-row pages.
// Preview suite: PREVIEW=http://127.0.0.1:<port> (scripts/dev-server --preview). SHOTS=<dir> for screenshots.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };
const errs = [];

// a big sample library (every kind several pages long; books = copies of sheets marked as books),
// kept in this browser like the preview's own; loaded fresh (a hash change alone keeps the old one)
async function bigLibrary(p) {
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' }); await sleep(500); // its own save is done
  await p.evaluate(async () => {
    const db = (await import('/js/mock.js')).buildMock();
    const base = db.items.slice();
    let n = 0;
    for (const k of ['sheet', 'score', 'chords', 'book']) {
      const src = base.filter((it) => it.kind === (k === 'book' ? 'sheet' : k));
      for (let i = 0; src.length && i < 60; i++) { const it = src[i % src.length]; db.items.push({ ...it, id: `${it.id}-x${n++}`, title: `${it.title} ${i + 2}`, ...(k === 'book' ? { book: true } : {}) }); }
    }
    localStorage.setItem('meowsic-mock-v6', JSON.stringify(db));
  });
  await p.reload({ waitUntil: 'networkidle0' });
}
// open a library tab with a fresh load (the store reads the sample library on start)
const openTab = async (p, k) => { await p.goto(ORIGIN + `/?preview=1#/library${k ? '?kind=' + k : ''}`, { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' }); await sleep(400); };

const measure = (p) => p.evaluate(() => {
  const box = document.querySelector('#lib-rows'), table = box.querySelector('.lib-table'), pr = box.querySelector('.pager-row');
  const rows = [...box.querySelectorAll('tr.row')].map((r) => r.getBoundingClientRect());
  const tab = document.querySelector('.tabbar'), tb = tab && getComputedStyle(tab).display !== 'none' ? tab.getBoundingClientRect() : null;
  const main = document.querySelector('#main').getBoundingClientRect(), prr = pr.getBoundingClientRect();
  const cs = getComputedStyle(table), rowH = Math.max(...rows.map((r) => r.height));
  const lastBottom = rows.at(-1).bottom;
  return {
    n: rows.length, rowH: +rowH.toFixed(1), td: +parseFloat(getComputedStyle(box.querySelector('tr.row td')).height).toFixed(1),
    // the empty space you see between the last row and the pager row (margins included)
    gap: +(prr.top - lastBottom).toFixed(1), margin: parseFloat(cs.marginBottom),
    overlap: +(lastBottom - prr.top).toFixed(1),
    pagerBottom: +prr.bottom.toFixed(1), limit: +(tb ? tb.top : Math.min(main.bottom, innerHeight)).toFixed(1),
    page: document.querySelector('.pg-now')?.textContent || '', first: box.querySelector('tr.row')?.dataset.id,
  };
});

const KINDS = [['', 'All'], ['sheet', 'Sheets'], ['score', 'Scores'], ['chords', 'Chords'], ['book', 'Books']];
const devices = [
  ['iphone-air', 420, 912], ['iphone-air-safari', 420, 780], ['iphone-15', 393, 852], ['iphone-15-safari', 393, 659],
  ['iphone-16-plus', 430, 932], ['ipad-portrait', 820, 1180], ['ipad-landscape', 1180, 820], ['ipad-13-landscape', 1366, 1024],
];
const results = [];
for (const [name, w, h] of devices) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await bigLibrary(p);
  for (const [k, label] of KINDS) {
    await openTab(p, k);
    const m = await measure(p);
    results.push(`${name} ${label}: ${m.n} rows (row ${m.rowH}px, gap ${m.gap}px)`);
    check(`${name} ${label}: gap under the rows < one row (${m.n} rows, gap ${m.gap} < ${m.rowH})`, m.gap >= -0.5 && m.gap < m.rowH, JSON.stringify(m));
    check(`${name} ${label}: rows don't run under the pager`, m.overlap <= 0.5, JSON.stringify(m));
    check(`${name} ${label}: pager above the tab bar / screen bottom`, m.pagerBottom <= m.limit + 0.5, JSON.stringify(m));
    check(`${name} ${label}: rows keep their height`, m.td >= (w <= 760 ? 48 : 44) - 0.5, JSON.stringify(m));
    if (SHOTS && name.startsWith('iphone-air') && (k === 'sheet' || k === 'book')) await p.screenshot({ path: `${SHOTS}/libfit-${name}-${label}.png` });
  }
  await p.close();
}

// resize in place (Safari's toolbar shows / hides, rotation): recount, keep the first row on screen
{
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 420, height: 912, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await bigLibrary(p);
  await openTab(p, 'sheet');
  for (let i = 0; i < 3; i++) { await p.click('.pager [data-pg="next"]'); await sleep(150); }
  const a = await measure(p);
  for (const [w, h] of [[420, 780], [912, 420], [420, 912]]) {
    await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }); await sleep(500);
    const m = await measure(p);
    const ids = await p.$$eval('#lib-rows tr.row', (r) => r.map((x) => x.dataset.id));
    check(`resize to ${w}×${h}: gap < one row (${m.n} rows, gap ${m.gap})`, m.gap >= -0.5 && m.gap < m.rowH && m.overlap <= 0.5 && m.pagerBottom <= m.limit + 0.5, JSON.stringify(m));
    check(`resize to ${w}×${h}: the first row before stays on screen`, ids.includes(a.first), `${a.first} not in page ${m.page}`);
  }
  // every height an iPhone Air / iPhone 15 window can have (Safari's toolbar in any state, the
  // installed app): never a gap of a row or more, never a row under the pager
  const bad = [];
  for (const w of [420, 393]) for (let h = 560; h <= 940; h += 3) {
    await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }); await sleep(60);
    const m = await measure(p);
    if (!(m.gap >= -0.5 && m.gap < m.rowH && m.overlap <= 0.5 && m.pagerBottom <= m.limit + 0.5)) bad.push(`${w}×${h}: ${JSON.stringify(m)}`);
  }
  check('every phone height 560–940: gap < one row, nothing under the pager', !bad.length, bad.slice(0, 5).join('\n'));
  await p.setViewport({ width: 420, height: 912, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }); await sleep(300);
  // Safari's toolbar: only the visual viewport changes → measured again too
  const before = (await measure(p)).n;
  await p.evaluate(() => visualViewport.dispatchEvent(new Event('resize'))); await sleep(300);
  check('visualViewport resize: count stays right', (await measure(p)).n === before);
  await p.close();
}

// Mac: 50 rows per page, the list scrolls
{
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await bigLibrary(p);
  await openTab(p, 'sheet');
  const n = await p.$$eval('#lib-rows tr.row', (r) => r.length);
  results.push(`mac Sheets: ${n} rows (scrolls)`);
  check(`mac: 50 rows per page, scrolling (${n})`, n === 50);
  await p.close();
}
check('no page errors', !errs.length, errs.join('\n'));
console.log(results.map((r) => '  · ' + r).join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
