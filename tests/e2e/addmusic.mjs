// Add music = three short choices (Sheet, Chords, Score); each opens its flow with compact source
// buttons (one or two words); the long "from where" text lives in Help (App section; iPhone: More).
// Mac, iPad (1032x1376 touch) and iPhone (420x912 touch).
//   BASE=http://localhost:5190/ (server) or BASE='http://localhost:5181/?preview=1' (preview)   SHOTS=<dir>
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const DEVICES = [
  ['mac', { width: 1440, height: 900 }],
  ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }],
  ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }],
];
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

for (const [dev, vp] of DEVICES) {
  console.log(dev);
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(dev + ' ' + e.message));
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(500);
  const phone = dev === 'iphone';
  const openAdd = async () => { await p.click(phone ? '#tab-add' : '#side-add'); await sleep(250); };
  const pick = async (label) => { await openAdd(); await p.evaluate((l) => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === l).click(), label); await sleep(500); };
  const hash = () => p.evaluate(() => location.hash);
  const noHScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth + 1);
  check(`${dev}: device`, (await p.evaluate(() => document.documentElement.dataset.device)) === { mac: 'desktop', ipad: 'tablet', iphone: 'phone' }[dev]);

  await openAdd();
  const labels = await p.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: Add music = Sheet | Chords | Score`, labels.join('|') === 'Sheet|Chords|Score', labels.join('|'));
  const h = await p.$eval('.menu.add-menu button', (e) => e.getBoundingClientRect().height);
  check(`${dev}: choices easy to tap (≥ 44px)`, h >= 44, h);
  // text size matches the other menus and buttons (no oversized Add music text)
  const fs = (sel) => p.$eval(sel, (e) => parseFloat(getComputedStyle(e).fontSize));
  check(`${dev}: Add menu text = standard menu text`, (await fs('.menu.add-menu button')) <= 15, await fs('.menu.add-menu button'));
  await p.screenshot({ path: `${SHOTS}/${dev}-1-menu.png` });
  await p.keyboard.press('Escape'); await p.mouse.click(vp.width - 5, vp.height / 2); await sleep(200);

  await pick('Sheet');
  check(`${dev}: Sheet opens #/add-sheets`, (await hash()) === '#/add-sheets');
  check(`${dev}: Sheet has the file chooser`, !!(await p.$('#files')));
  const src = await p.$$eval('.src-btn', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: sheet sources are one or two words`, src.length >= 2 && src.every((t) => words(t) <= 2), src.join('|'));
  const sb = await p.$$eval('.src-btn', (e) => e.map((x) => [Math.round(x.getBoundingClientRect().height), parseFloat(getComputedStyle(x.querySelector('b') || x).fontSize)]));
  check(`${dev}: source buttons: standard text, 44px, same height`, sb.every(([h, f]) => h >= 44 && h <= 46 && f <= 15), JSON.stringify(sb));
  check(`${dev}: Camera only on touch`, src.includes('Camera') === (dev !== 'mac'), src.join('|'));
  check(`${dev}: no long explanations on Add sheet`, !(await p.$('.how')) && (await p.$eval('#main', (e) => e.innerText.length)) < 160, await p.$eval('#main', (e) => e.innerText));
  check(`${dev}: Add sheet fits (no sideways scroll)`, await noHScroll());
  await p.screenshot({ path: `${SHOTS}/${dev}-2-sheet.png` });

  await pick('Chords');
  check(`${dev}: Chords opens search`, (await hash()) === '#/add-chords' && !!(await p.$('#cs-q')) && (await p.$eval('#cs-paste', (e) => e.textContent.trim())) === 'Paste');
  check(`${dev}: Add chords fits`, await noHScroll());
  await p.screenshot({ path: `${SHOTS}/${dev}-3-chords.png` });

  await pick('Score');
  const seg = await p.$$eval('#sf-src button', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: Score opens with YouTube | Audio file`, (await hash()) === '#/add-score' && !!(await p.$('#sf-url')) && seg.join('|') === 'YouTube|Audio file', seg.join('|'));
  await p.click('#sf-src [data-s="file"]'); await sleep(150);
  check(`${dev}: Audio file shows the chooser`, await p.$eval('#sf-file', (e) => !e.hidden));
  check(`${dev}: Add score fits`, await noHScroll());
  await p.screenshot({ path: `${SHOTS}/${dev}-4-score.png` });

  // Help: not in the menu, a link on the App page (was Settings; iPhone: More → App)
  if (phone) {
    await p.click('#tab-more'); await sleep(250);
    const util = await p.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
    check(`${dev}: More menu has App and Keyboard, no Help`, util.includes('App') && util.includes('Keyboard') && !util.includes('Help'), util.join('|'));
    await p.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'App').click()); await sleep(400);
  } else {
    check(`${dev}: no Help in the left bar`, !(await p.$('#side a[href="#/help"]')));
    await p.click('#side a[href="#/settings"]'); await sleep(400);
  }
  await p.click('#main .top a[href="#/help"]'); await sleep(400);
  const help = await p.$eval('#main', (e) => e.innerText);
  check(`${dev}: Help page explains every source`, (await hash()) === '#/help' && ['Sheet', 'Chords', 'Score', 'Photos', 'Camera', 'YouTube', 'Audio file', 'Paste', 'SHEET'].every((w) => help.includes(w)), help.slice(0, 200));
  check(`${dev}: Help is plain bullets`, (await p.$$eval('.help-sec li', (e) => e.length)) >= 12);
  check(`${dev}: Help fits`, await noHScroll());
  check(`${dev}: Light theme by default`, (await p.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await p.screenshot({ path: `${SHOTS}/${dev}-5-help.png`, fullPage: true });
  await p.close();
}
check('no page errors', !errs.length, errs.join(' | '));
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
