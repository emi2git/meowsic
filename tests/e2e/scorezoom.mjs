// Score zoom: "100%" is each device's default. Mac / iPad draw it at OSMD zoom 0.75 (the old 75%),
// iPhone at 0.62 (the old iPhone default). +/- steps stay 15% of the label.
// Saved zooms keep their drawn size: entry number / device key meowsic-zoom-<id> (drawn) -> drawn / base,
// device key meowsic-scorezoom-<id> (label x 0.75) -> label x 0.75 / base; both move to meowsic-devzoom-<id>, once.
// Mac, iPad, iPhone; screenshots in OUT.
// PREVIEW=http://localhost:5371 OUT=<dir> node scorezoom.mjs   (static server: python3 -m http.server 5371 -d web)
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const BASE = ORIGIN + '/?preview=1';
const OUT = process.env.OUT || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const ID = 'm-02i';
// px per OSMD unit ÷ 10 (= the OSMD zoom) and the median notehead height in px
const size = (p) => p.evaluate(() => {
  const svg = document.querySelector('#osmd svg'); if (!svg) return null;
  const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  const hs = [...document.querySelectorAll('#osmd .vf-notehead')].map((e) => e.getBoundingClientRect().height).filter((h) => h > 0).sort((a, c) => a - c);
  return { z: svg.getBoundingClientRect().width / vb[2], head: hs[hs.length >> 1] || 0 };
});
const label = (p) => p.$eval('#sc-zreset', (e) => e.textContent.trim()).catch(() => '');
const mock = (p, f) => p.evaluate(async (f) => { const { store } = await import('/js/store.js'); store.update('m-02i', { zoom: f }); await new Promise((r) => setTimeout(r, 400)); }, f);
const open = async (p) => { await p.evaluate(() => (location.hash = '#/library')); await sleep(300); await p.evaluate((i) => (location.hash = '#/item/' + i), ID); await sleep(1800); };

const p = await b.newPage(); p.on('pageerror', (e) => errs.push('mac: ' + e.message));
await p.setViewport({ width: 1366, height: 1024 });
await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
await p.evaluate(() => localStorage.clear());
await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' });
console.log('Mac');
await mock(p, null); await open(p);
const s100 = await size(p);
check('default label 100%', (await label(p)) === '100%', await label(p));
check('100% draws at OSMD zoom 0.75 (the old 75%)', s100 && Math.abs(s100.z - 0.75) < 0.01, JSON.stringify(s100));
await p.screenshot({ path: `${OUT}/mac-100.png` });
await mock(p, 1); await open(p); // the old 100%, saved on the entry by the old scale
const sOld = await size(p);
check('old saved zoom 1 → 133%, same size as before', (await label(p)) === '133%' && Math.abs(sOld.z - 1) < 0.01, `${await label(p)} ${JSON.stringify(sOld)}`);
check('notehead at 100% = 0.75 × the old 100%', Math.abs(s100.head / sOld.head - 0.75) < 0.03, `${s100.head} / ${sOld.head}`);
await mock(p, null); await open(p);
await p.click('#sc-zin'); await sleep(600);
check('+ → 115%, drawn at 0.8625', (await label(p)) === '115%' && Math.abs((await size(p)).z - 0.8625) < 0.01, JSON.stringify(await size(p)));
const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('meowsic-mock-v6')).items.find((x) => x.id === 'm-02i').zoom);
check('new scale saved on the entry as a string', saved === '1.15', JSON.stringify(saved));
await open(p);
check('reopens at 115% (not converted twice)', (await label(p)) === '115%', await label(p));
await p.click('#sc-zreset'); await sleep(600);
check('reset → 100%', (await label(p)) === '100%' && Math.abs((await size(p)).z - 0.75) < 0.01);
await p.close();

for (const [name, w, h] of [['ipad', 1032, 1376], ['iphone', 420, 912]]) {
  console.log(name);
  const q = await b.newPage(); q.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await q.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  await q.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await q.evaluate(() => localStorage.clear());
  await q.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await q.reload({ waitUntil: 'networkidle0' });
  await mock(q, 1.5); // the entry's zoom is the Mac's: ignored on touch devices
  await open(q);
  const base = name === 'iphone' ? 0.62 : 0.75;
  const s = await size(q);
  check(`${name}: default label 100%`, (await label(q)) === '100%', await label(q));
  check(`${name}: default drawn at ${base}`, s && Math.abs(s.z - base) < 0.01, JSON.stringify(s));
  check(`${name}: paged, on page 1 of N`, await q.evaluate(() => window.__score.page === 1 && window.__score.pages >= 1));
  check(`${name}: no "Page n of N" text in the bar`, !/Page \d+ of/.test(await q.$eval('#it-bar', (e) => e.textContent)));
  check(`${name}: no scrolling`, await q.evaluate(() => [document.scrollingElement, document.querySelector('#main'), document.querySelector('#it-body')].every((e) => !e || e.scrollHeight <= e.clientHeight + 1)));
  await q.screenshot({ path: `${OUT}/${name}-100.png` });
  const keys = () => q.evaluate((i) => [localStorage.getItem('meowsic-devzoom-' + i), localStorage.getItem('meowsic-scorezoom-' + i), localStorage.getItem('meowsic-zoom-' + i)], ID);
  for (const [k, v, drawn] of [['meowsic-zoom-', '0.9', 0.9], ['meowsic-scorezoom-', '1.2', 0.9]]) {
    await q.evaluate((i, k, v) => { localStorage.removeItem('meowsic-devzoom-' + i); localStorage.setItem(k + i, v); }, ID, k, v);
    await open(q);
    const want = Math.round((drawn / base) * 100) / 100, so = await size(q), ks = await keys();
    check(`${name}: ${k}<id> ${v} -> ${Math.round(want * 100)}%, drawn ${drawn}, key moved`, Math.abs(so.z - drawn) < 0.01 && (await label(q)) === `${Math.round(want * 100)}%` && ks[0] === String(want) && ks[1] === null && ks[2] === null, `${await label(q)} ${JSON.stringify(so)} ${JSON.stringify(ks)}`);
    await open(q);
    check(`${name}: reopens the same (not converted twice)`, Math.abs((await size(q)).z - drawn) < 0.01 && (await label(q)) === `${Math.round(want * 100)}%`, await label(q));
  }
  await q.$eval('#sc-zreset', (e) => e.click()); await sleep(600); // iPhone: the stepper sits in the ⋯ panel
  check(`${name}: reset -> 100% at ${base}`, (await label(q)) === '100%' && Math.abs((await size(q)).z - base) < 0.01, `${await label(q)} ${JSON.stringify(await size(q))}`);
  // note names on
  await q.evaluate((i) => localStorage.removeItem('meowsic-devzoom-' + i), ID);
  await open(q);
  const nb = await q.$('#sc-names');
  if (nb) { await nb.click(); await sleep(1500); check(`${name}: note names drawn`, (await q.$$eval('#osmd text.nl', (e) => e.length)) > 0); await q.screenshot({ path: `${OUT}/${name}-names.png` }); await nb.click(); await sleep(800); }
  else console.log('  (no note-names button)');
  await q.close();
}
check('no page errors', errs.length === 0, errs.join('\n'));
await b.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
