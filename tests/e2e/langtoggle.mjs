// Library: round World ⇄ Vietnamese toggle (two states: globe off ⇄ "VI" on, tinted; off never faded; aria-pressed), remembered on the device; old 'all' / 'world' values = World
import './live-guard.mjs'; // refuses the live app / library
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
  const st = async () => { await p.mouse.move(1, 1); return p.$eval('#lib-lang', (e) => { const cs = getComputedStyle(e), t = getComputedStyle(document.querySelector('#lib-tag'));
    return { lang: e.dataset.lang, on: e.classList.contains('on'), pressed: e.getAttribute('aria-pressed'), round: cs.borderRadius, text: e.textContent.trim(), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height,
      bg: cs.backgroundColor, color: cs.color, op: cs.opacity, star: !!e.querySelector('svg.star'), earth: !!e.querySelector('svg circle'), tagColor: t.color, tagOp: t.opacity, tagBg: t.backgroundColor }; }); }; // mouse off the button: no :hover fill
  let s = await st();
  check(`${name}: starts on World (earth, icon only, round, aria-pressed=false)`, s.lang === 'world' && !s.on && s.pressed === 'false' && s.text === '' && s.round === '50%' && s.earth, JSON.stringify(s));
  check(`${name}: World off-style = tag button off-style (same colour, full opacity, no fill)`, s.color === s.tagColor && s.op === '1' && s.op === s.tagOp && s.bg === s.tagBg, JSON.stringify(s));
  const off = s;
  const c0 = await count();
  if (c0 != null) check(`${name}: World shows every song`, c0 === nAll, `${c0} vs ${nAll}`);
  await p.click('#lib-lang'); await sleep(400); s = await st();
  const c1 = await count();
  const tint = await p.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--acc-soft)'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
  check(`${name}: tap → Vietnamese ("VI" text, no star, aria-pressed=true)`, s.lang === 'vi' && s.on && s.pressed === 'true' && s.text === 'VI' && !s.star && !s.earth, JSON.stringify(s));
  check(`${name}: VI on-style = tinted (acc-soft), same colour / size as off`, s.bg === tint && s.bg !== off.bg && s.color === off.color && s.op === '1' && s.w === off.w && s.h === off.h, JSON.stringify(s));
  // dark theme: same rules
  const theme = (t) => p.evaluate((t) => { document.documentElement.dataset.theme = t; }, t);
  const theme0 = await p.evaluate(() => document.documentElement.dataset.theme || '');
  await theme('dark'); await sleep(100);
  { const d = await st(); const dt = await p.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--acc-soft)'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
    check(`${name}: dark: VI tinted, colour = tag button`, d.bg === dt && d.color === d.tagColor && d.op === '1', JSON.stringify(d)); }
  await p.click('#lib-lang'); await sleep(300);
  { const d = await st(); check(`${name}: dark: World off-style = tag button`, d.color === d.tagColor && d.op === '1' && d.bg === d.tagBg && d.pressed === 'false', JSON.stringify(d)); }
  await p.click('#lib-lang'); await sleep(300); await p.evaluate((t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }, theme0);
  if (c0 != null) check(`${name}: Vietnamese shows only Vietnamese songs`, c1 === nVi, `${c1} vs ${nVi}`);
  await p.screenshot({ path: `${OUT}/lang-${name}-vi.png` });
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(500); await toAll();
  check(`${name}: Vietnamese remembered after reload`, (await st()).lang === 'vi' && (await count()) === nVi);
  await p.click('#lib-lang'); await sleep(400); s = await st();
  check(`${name}: tap → back to World (2 states only)`, s.lang === 'world' && !s.on && s.pressed === 'false' && s.earth && (await count()) === c0, JSON.stringify(s));
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
