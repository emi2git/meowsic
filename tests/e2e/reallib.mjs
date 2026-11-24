// read-only look at the LIVE library (no clicks that change data; viewers closed within 10 s so no plays are logged). On purpose only: MEOWSIC_LIVE_READONLY=1 node reallib.mjs (live-guard allows GETs only)
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = 'https://localhost:5180/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const errs = [];
const sizes = { mac: { width: 1440, height: 900 }, ipad: { width: 1024, height: 1366, isMobile: true, hasTouch: true }, iphone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const items = await (await fetch(BASE + 'api/items')).json().catch(() => null);
const pick = (k, f = () => true) => items.find((x) => x.kind === k && f(x));
const sheetPdf = pick('sheet', (x) => x.source === 'pdf' && x.pages > 1), sheetPhoto = pick('sheet', (x) => x.source === 'photos' && x.pages > 1), chord = pick('chords'), score = pick('score');
console.log('samples', sheetPdf?.title, '|', sheetPhoto?.title, '|', chord?.title, '|', score?.title);
for (const [name, vp] of Object.entries(sizes)) {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(name + ' ' + e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(name + ' ' + m.text()));
  for (const [r, wait] of [['library', 1500], ['library?kind=sheet', 1200], ['library?kind=chords', 800], ['library?kind=score', 800], ['item/' + sheetPhoto.id, 2500], ['item/' + sheetPdf.id, 2500], ['item/' + chord.id, 1200], ['item/' + score.id, 5000], ['tags', 800], ['stats', 800], ['activity', 800], ['settings', 800]]) {
    await p.goto(BASE + '#/' + r, { waitUntil: 'networkidle2' }); await sleep(wait);
    await p.screenshot({ path: `real/${name}-${r.replace(/[^a-z0-9]+/gi, '_')}.png` });
    if (name === 'mac' && r.startsWith('item/s')) console.log(r, 'pages loaded:', await p.$$eval('.page img', (e) => e.map((i) => i.naturalWidth).join(',')));
  }
  await p.goto('about:blank'); await p.close();
}
console.log(errs.length ? 'errors:\n' + [...new Set(errs)].join('\n') : 'no console errors');
await b.close();
