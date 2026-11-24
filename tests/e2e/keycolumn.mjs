// Library Key column: the song's key as a chord name ("A major" → A, "D minor" → Dm, "Bb major" → Bb, unknown → empty),
// right after Title on every list (Sheets, Scores, Chords, All music), sortable, shown on Mac, iPad and iPhone;
// on an iPhone Pages gives way before Key. Runs on the UI preview: PREVIEW=http://127.0.0.1:5301 node keycolumn.mjs
// (SHOTS=<dir> also saves iPad / iPhone screenshots)
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const BASE = ORIGIN + '/?preview=1';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const DEV = {
  mac: { viewport: { width: 1440, height: 900 } },
  ipad: { viewport: { width: 1024, height: 1366, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  iphone: { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
};
const KEYS = ['A major', 'D minor', 'Bb major', 'F# minor', 'E♭ major'];
const WANT = ['A', 'Dm', 'Bb', 'F#m', 'Eb'];
const heads = (p) => p.$$eval('.lib-table th', (e) => e.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean));
// Key comes right after the title block (Title; on the Mac also Artist, Album), before Version
const afterTitle = (h) => h.indexOf('Key') > 0 && h.indexOf('Key') === h.indexOf('Version') - 1 && h.slice(1, h.indexOf('Key')).every((x) => ['Artist', 'Album'].includes(x));
const keyOf = (p, id) => p.$eval(`#lib-rows tr[data-id="${id}"] td.c-key`, (e) => e.textContent.trim()).catch(() => null);

for (const [name, d] of Object.entries(DEV)) {
  console.log(name);
  const p = await b.newPage();
  if (d.ua) await p.setUserAgent(d.ua);
  await p.setViewport(d.viewport);
  p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(400);
  // give the five newest sheets known keys, the sixth none
  // (through the store: the preview saves its sample library only after a change)
  const ids = await p.evaluate(async (KEYS) => {
    const { store } = await import('/js/store.js');
    const sheets = store.items().filter((x) => x.kind === 'sheet' && !x.book).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    const ids = sheets.map((s) => s.id);
    ids.forEach((id, i) => store.update(id, { key: KEYS[i] || '' }));
    return ids;
  }, KEYS);
  await sleep(500); // the store saves 200 ms after a change
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  await p.evaluate(() => (location.hash = '#/library?kind=sheet')); await sleep(700);
  // newest first (the default order), so all six are on page 1
  const h = await heads(p);
  check(`${name} sheets: Key right after Title`, afterTitle(h), h.join('|'));
  check(`${name} sheets: Version still shown`, h.includes('Version'), h.join('|'));
  if (name !== 'iphone') check(`${name} sheets: Pages still shown`, h.includes('Pages'), h.join('|'));
  else check('iphone sheets: Pages gives way before Key', !h.includes('Pages'), h.join('|'));
  const got = []; for (const id of ids) got.push(await keyOf(p, id));
  check(`${name}: keys as chord names`, JSON.stringify(got) === JSON.stringify([...WANT, '']), JSON.stringify(got));
  // the Key cell is not squashed or clipped
  const fit = await p.$$eval('#lib-rows td.c-key', (e) => e.length > 0 && e.every((x) => { const r = document.createRange(); r.selectNodeContents(x); const cs = getComputedStyle(x);
    return r.getBoundingClientRect().width <= x.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.5; }));
  check(`${name}: Key cells fit`, fit);
  if (SHOTS && name !== 'mac') await p.screenshot({ path: `${SHOTS}/keycolumn-${name}.png` });
  // sort by Key: A, Bb, Dm, Eb, F#m, then the ones with no key
  await p.evaluate(() => document.querySelector('th.c-key .th-sort').click()); await sleep(400);
  const order = await p.$$eval('#lib-rows td.c-key', (e) => e.map((x) => x.textContent.trim()));
  check(`${name}: sorting by Key`, order.slice(0, 5).join() === 'A,Bb,Dm,Eb,F#m' && order.slice(5).every((x) => x === ''), order.slice(0, 8).join());
  await p.evaluate(() => document.querySelector('th.c-key .th-sort').click()); await sleep(400);
  const rev = await p.$$eval('#lib-rows td.c-key', (e) => e.map((x) => x.textContent.trim()));
  check(`${name}: Key sort reverses`, rev[0] !== 'A', rev.slice(0, 5).join());
  // the same column on Scores, Chords and All music; Books have no key
  for (const kind of ['score', 'chords', '', 'book']) {
    await p.evaluate((k) => (location.hash = '#/library' + (k ? '?kind=' + k : '')), kind); await sleep(600);
    const hh = await heads(p);
    if (kind === 'book') { check(`${name} books: no Key column`, !hh.includes('Key'), hh.join('|')); continue; }
    check(`${name} ${kind || 'all'}: Key right after Title`, afterTitle(hh), hh.join('|'));
    if (!kind) await p.evaluate(() => document.querySelector('th.c-key .th-sort').click()), await sleep(400); // keyed songs first
    const ks = await p.$$eval('#lib-rows td.c-key', (e) => e.map((x) => x.textContent.trim()).filter(Boolean));
    check(`${name} ${kind || 'all'}: keys shown short`, ks.length > 0 && ks.every((x) => /^[A-G][b#]?m?$/.test(x)), ks.slice(0, 6).join());
    if (SHOTS && name !== 'mac' && kind === 'score') await p.screenshot({ path: `${SHOTS}/keycolumn-${name}-scores.png` });
  }
  check(`${name}: Light theme by default`, await p.evaluate(() => (document.documentElement.dataset.theme || 'light') === 'light'));
  await p.evaluate(() => localStorage.clear());
  await p.close();
}
check('no page errors', errs.length === 0, errs.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
