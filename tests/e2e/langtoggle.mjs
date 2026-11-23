// Library: round All → Vietnamese → World toggle (icon only), remembered on the device
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
  const count = () => p.evaluate(() => { const t = document.querySelector('.pager-row .muted, .lib-count, .pager-row')?.textContent || ''; const m = t.match(/(\d+)\s+item/); return m ? +m[1] : null; });
  const st = () => p.$eval('#lib-lang', (e) => ({ lang: e.dataset.lang, on: e.classList.contains('on'), round: getComputedStyle(e).borderRadius, text: e.textContent.trim(), w: e.getBoundingClientRect().width }));
  let s = await st();
  check(`${name}: starts on All, icon only, round`, s.lang === 'all' && !s.on && s.text === '' && s.round === '50%', JSON.stringify(s));
  const c0 = await count();
  await p.click('#lib-lang'); await sleep(400); s = await st();
  const c1 = await count();
  check(`${name}: tap → Vietnamese (star, lit)`, s.lang === 'vi' && s.on, JSON.stringify(s));
  if (c0 != null) check(`${name}: Vietnamese shows only Vietnamese songs`, c1 === nVi, `${c1} vs ${nVi}`);
  await p.screenshot({ path: `${OUT}/lang-${name}-vi.png` });
  await p.click('#lib-lang'); await sleep(400); s = await st();
  const c2 = await count();
  check(`${name}: tap → World (earth, lit)`, s.lang === 'world' && s.on, JSON.stringify(s));
  if (c0 != null) check(`${name}: World = everything else`, c2 === nAll - nVi, `${c2} vs ${nAll - nVi}`);
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  check(`${name}: remembered after reload`, (await st()).lang === 'world');
  await p.click('#lib-lang'); await sleep(300);
  check(`${name}: tap → back to All`, (await st()).lang === 'all' && (await count()) === c0);
  await p.close();
}
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
