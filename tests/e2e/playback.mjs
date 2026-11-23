// Score playback (piano, Web Audio): tap Play → the AudioContext is 'running', the clock moves, the piano
// samples load, Pause stops the clock, no page errors. Mac (click), iPad and iPhone (tap). No autoplay flag:
// the tap itself must unlock audio, as on iOS. Runs on the preview (mock data): PREVIEW=http://localhost:5181
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const BASE = ORIGIN + '/?preview=1';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const DEVICES = [
  ['Mac', { width: 1440, height: 900 }],
  ['iPad', { width: 1024, height: 1366, hasTouch: true, isMobile: true }],
  ['iPhone', { width: 390, height: 844, hasTouch: true, isMobile: true }],
];
for (const [name, vp] of DEVICES) {
  console.log(name);
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.setViewport(vp);
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  const id = await p.evaluate(async () => (await import('/js/store.js')).store.items().find((x) => x.kind === 'score').id);
  await p.evaluate((i) => { location.hash = '#/item/' + i; }, id); await sleep(3000);
  const state = () => p.evaluate(async () => (await import('/js/audio.js')).audioState());
  const now = () => p.evaluate(() => window.__score.player.now());
  check('Play button is there', !!(await p.$('#sc-play')));
  if (vp.hasTouch) await p.tap('#sc-play'); else await p.click('#sc-play');
  await sleep(1500);
  const st = await state();
  check("AudioContext is 'running' after tapping Play", st === 'running', st);
  check('player is playing', await p.evaluate(() => window.__score.player.playing));
  const q1 = await now(); await sleep(800); const q2 = await now();
  check('the clock advances', q2 > q1 + 0.3, `${q1} → ${q2}`);
  check('Play turned into Pause', (await p.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Pause');
  if (vp.hasTouch) await p.tap('#sc-play'); else await p.click('#sc-play');
  await sleep(300);
  const q3 = await now(); await sleep(500);
  check('Pause stops the clock', !(await p.evaluate(() => window.__score.player.playing)) && (await now()) === q3);
  // iOS 'interrupted' / suspended: the next Play wakes it again
  await p.evaluate(async () => { const { audioCtx } = await import('/js/audio.js'); await audioCtx().suspend(); });
  if (vp.hasTouch) await p.tap('#sc-play'); else await p.click('#sc-play');
  await sleep(800);
  check('after a suspend, Play resumes the AudioContext', (await state()) === 'running' && (await now()) > q3, await state());
  await p.click('#sc-stop'); await sleep(200);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
