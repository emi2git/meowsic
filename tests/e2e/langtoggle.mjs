// Library: round World ⇄ Vietnamese toggle (two states, icon only), remembered on the device; old 'all' / 'world' values = World
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const OUT = process.env.OUT || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VI = /[ăâđêôơưĂÂĐÊÔƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/;
const items = (await (await fetch(BASE + 'api/items')).json()).filter((x) => !x.deleted);
const isVi = (x) => x.tags.includes('Vietnamese') || VI.test(x.title);
const nVi = items.filter(isVi).length, nAll = items.length;
const errs = [];
for (const [name, vp] of [['mac', { width: 1440, height: 900 }], ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  const p = await b.newPage(); await p.setViewport(vp); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await p.evaluate(() => localStorage.removeItem('meowsic-lang')); await p.reload({ waitUntil: 'networkidle0' }); await sleep(600);
  const toAll = async () => { await p.evaluate(() => (location.hash = '#/library')); await sleep(400); }; // a fresh load opens Sheets
  await toAll();
  const count = () => p.evaluate(() => { if (document.querySelector('#lib-rows .empty')) return 0; const t = document.querySelector('.pager-row .muted, .lib-count, .pager-row')?.textContent || ''; const m = t.match(/(\d+)\s+item/); return m ? +m[1] : null; });
  const st = () => p.$eval('#lib-lang', (e) => ({ lang: e.dataset.lang, on: e.classList.contains('on'), round: getComputedStyle(e).borderRadius, text: e.textContent.trim(), w: e.getBoundingClientRect().width,
    bg: getComputedStyle(e).backgroundColor, star: !!e.querySelector('svg.star'), earth: !!e.querySelector('svg circle') }));
  let s = await st();
  check(`${name}: starts on World (earth, quiet), icon only, round`, s.lang === 'world' && !s.on && s.text === '' && s.round === '50%' && s.earth, JSON.stringify(s));
  const c0 = await count();
  if (c0 != null) check(`${name}: World shows every song`, c0 === nAll, `${c0} vs ${nAll}`);
  await p.click('#lib-lang'); await sleep(400); s = await st();
  const c1 = await count();
  check(`${name}: tap → Vietnamese (star, lit, no disc)`, s.lang === 'vi' && s.on && s.star && s.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(s));
  if (c0 != null) check(`${name}: Vietnamese shows only Vietnamese songs`, c1 === nVi, `${c1} vs ${nVi}`);
  await p.screenshot({ path: `${OUT}/lang-${name}-vi.png` });
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(500); await toAll();
  check(`${name}: Vietnamese remembered after reload`, (await st()).lang === 'vi' && (await count()) === nVi);
  await p.click('#lib-lang'); await sleep(400); s = await st();
  check(`${name}: tap → back to World (2 states only)`, s.lang === 'world' && !s.on && (await count()) === c0, JSON.stringify(s));
  await p.click('#lib-lang'); await sleep(300);
  check(`${name}: tap again → Vietnamese`, (await st()).lang === 'vi');
  await p.click('#lib-lang'); await sleep(300);
  for (const old of ['all', 'world', 'bogus']) {
    await p.evaluate((v) => localStorage.setItem('meowsic-lang', v), old); await p.reload({ waitUntil: 'networkidle0' }); await sleep(500); await toAll();
    s = await st();
    check(`${name}: stored '${old}' → World`, s.lang === 'world' && !s.on && (await count()) === c0, JSON.stringify(s));
  }
  await p.close();
}
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
