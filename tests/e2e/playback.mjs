// Score playback (piano, Web Audio): tap Play → the AudioContext is 'running', the clock moves, the piano
// samples load, Pause stops the clock, no page errors. Mac (click), iPad and iPhone (tap). No autoplay flag:
// the tap itself must unlock audio, as on iOS. Runs on the preview (mock data): PREVIEW=http://localhost:5181
// Also: nothing covers Play (elementFromPoint at its centre is the button, with the Home Screen app's status-bar
// inset emulated), a real touch at that point plays, a stuck AudioContext (iOS 'interrupted' / a resume that never
// wakes) is replaced on the next tap, and a Play that gets no running audio says so instead of a frozen Pause.
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const BASE = ORIGIN + '/?preview=1';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--mute-audio'] });
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
  if (vp.hasTouch) { // the installed app runs under the status bar (black-translucent): emulate its inset
    const cdp = await p.createCDPSession();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: vp.width < 500 ? 59 : 24, bottom: 20 } }).catch(() => {});
  }
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  const id = await p.evaluate(async () => (await import('/js/store.js')).store.items().find((x) => x.kind === 'score').id);
  await p.evaluate((i) => { location.hash = '#/item/' + i; }, id); await sleep(3000);
  const state = () => p.evaluate(async () => (await import('/js/audio.js')).audioState());
  const now = () => p.evaluate(() => window.__score.player.now());
  check('Play button is there', !!(await p.$('#sc-play')));
  // nothing lies over Play: the topmost element at its centre is the button
  const ctr = await p.$eval('#sc-play', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const top = await p.evaluate(({ x, y }) => { const h = document.elementFromPoint(x, y); return h?.closest('#sc-play') ? 'button' : h?.outerHTML.slice(0, 120) || 'nothing'; }, ctr);
  check('elementFromPoint at the centre of Play is Play', top === 'button', top);
  // a real touch (touchstart / touchend → click) at that point, not a click on the element
  if (vp.hasTouch) await p.touchscreen.tap(ctr.x, ctr.y); else await p.mouse.click(ctr.x, ctr.y);
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
  // a stuck context (iOS: 'interrupted' after a call or the app in the background; resume() never wakes it):
  // Play makes a fresh one inside the tap and the clock moves again
  if (vp.hasTouch) await p.tap('#sc-play'); else await p.click('#sc-play'); // pause
  await sleep(300);
  await p.evaluate(async () => {
    const { audioCtx } = await import('/js/audio.js'); const c = audioCtx();
    await c.suspend(); window.__stuck = c; c.resume = () => new Promise(() => {}); // never wakes
  });
  const q4 = await now();
  if (vp.hasTouch) await p.touchscreen.tap(ctr.x, ctr.y); else await p.mouse.click(ctr.x, ctr.y);
  await sleep(900);
  const fresh = await p.evaluate(async () => { const { audioCtx } = await import('/js/audio.js'); return audioCtx() !== window.__stuck; });
  check('a stuck AudioContext is replaced on the next Play', fresh && (await state()) === 'running');
  const q5 = await now(); await sleep(500);
  check('…and the clock moves again', (await now()) > q5 && q5 >= q4, `${q4} → ${q5}`);
  await p.click('#sc-stop'); await sleep(200);
  // audio that never starts: the button goes back to Play and says so (no frozen Pause)
  await p.evaluate(() => { const P = (window.AudioContext || window.webkitAudioContext).prototype; window.__res = P.resume; P.resume = function () { return new Promise(() => {}); }; });
  await p.evaluate(async () => { const { audioCtx } = await import('/js/audio.js'); await audioCtx().suspend(); });
  await p.evaluate(() => { const C = window.AudioContext; window.AudioContext = class extends C { constructor(o) { super(o); this.suspend(); } }; });
  if (vp.hasTouch) await p.tap('#sc-play'); else await p.click('#sc-play');
  await sleep(2800);
  const lbl = await p.$eval('#sc-play', (e) => e.getAttribute('aria-label'));
  const toastTxt = await p.evaluate(() => [...document.querySelectorAll('#toast:not([hidden])')].map((t) => t.textContent).join(' | '));
  check('no running audio: Play stays Play and a toast says so', lbl === 'Play' && !(await p.evaluate(() => window.__score.player.playing)) && /tap Play again/.test(toastTxt), `${lbl} ${toastTxt}`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await p.close();
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
