// Score playback (piano, Web Audio): tap Play → the AudioContext is 'running', the clock moves, the piano
// samples load, Pause stops the clock, no page errors. Mac (click), iPad and iPhone (tap). No autoplay flag:
// the tap itself must unlock audio, as on iOS. Runs on the preview (mock data): PREVIEW=http://localhost:5181
// Also: nothing covers Play (elementFromPoint at its centre is the button, with the Home Screen app's status-bar
// inset emulated), a real touch at that point plays, a 'running' but frozen context (iOS 26 Home Screen app back from
// the background) is replaced, a frozen clock says so, no tempo mark is drawn and the toolbar shows no bpm, a stuck AudioContext (iOS 'interrupted' / a resume that never
// wakes) is replaced on the next tap, and a Play that gets no running audio says so instead of a frozen Pause.
import './live-guard.mjs'; // refuses the live app / library
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
  // iOS 26 Home Screen app: back from the background the context says 'running' but is silent / its clock is frozen
  // (WebKit 291892). The first Play after the app was hidden must make a fresh context, not trust 'running'.
  const zombie = () => p.evaluate(async () => {
    const { audioCtx } = await import('/js/audio.js'); const c = audioCtx();
    await c.suspend(); Object.defineProperty(c, 'state', { configurable: true, get: () => 'running' }); c.resume = () => Promise.resolve();
    window.__zombie = c;
  });
  await zombie();
  await p.evaluate(() => { // the app goes to the background and comes back
    for (const v of ['hidden', 'visible']) { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }
    delete document.visibilityState;
  });
  if (vp.hasTouch) await p.touchscreen.tap(ctr.x, ctr.y); else await p.mouse.click(ctr.x, ctr.y);
  await sleep(1200);
  const z1 = await p.evaluate(async () => { const { audioCtx } = await import('/js/audio.js'); return audioCtx() !== window.__zombie; });
  const q6 = await now(); await sleep(500);
  check("back from the background: a 'running' but frozen context is replaced on Play", z1 && (await now()) > q6 + 0.2, `fresh=${z1} ${q6} → ${await now()}`);
  await p.click('#sc-stop'); await sleep(200);
  // the same frozen 'running' context without a trip to the background (another app took the audio): Play says so,
  // stays Play, and the next tap makes a fresh context that plays
  await zombie();
  if (vp.hasTouch) await p.touchscreen.tap(ctr.x, ctr.y); else await p.mouse.click(ctr.x, ctr.y);
  await sleep(1500);
  const zl = await p.$eval('#sc-play', (e) => e.getAttribute('aria-label'));
  const zt = await p.evaluate(() => [...document.querySelectorAll('#toast:not([hidden])')].map((t) => t.textContent).join(' | '));
  check('frozen clock: Play stays Play and a toast says so', zl === 'Play' && /tap Play again/.test(zt), `${zl} ${zt}`);
  if (vp.hasTouch) await p.touchscreen.tap(ctr.x, ctr.y); else await p.mouse.click(ctr.x, ctr.y);
  await sleep(1200);
  const q7 = await now(); await sleep(500);
  check('…and the next Play makes a fresh context that plays', (await now()) > q7 + 0.2 && (await p.evaluate(async () => (await import('/js/audio.js')).audioCtx() !== window.__zombie)), `${q7} → ${await now()}`);
  await p.click('#sc-stop'); await sleep(200);
  // no tempo on the score: the file has one (the player uses it), the drawn score and the toolbar do not
  const tempo = await p.evaluate(async () => {
    const v = window.__score;
    if (v.real && !/<metronome\b/.test(v.xml())) { // give it one: ♩ = 72, "Moderato" and a <sound tempo>
      await v.showXml(v.xml().replace(/(<measure\b[^>]*>)/, '$1<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction><direction placement="above"><direction-type><words>Moderato</words></direction-type></direction>'));
      await new Promise((ok) => setTimeout(ok, 500));
    }
    const svg = document.querySelector('#osmd svg'), txt = [...(svg?.querySelectorAll('text') || [])].map((t) => t.textContent).join(' ');
    const { noTempoXml } = await import('/js/easyscore.js');
    const shown = noTempoXml('<measure number="1"><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction><direction><direction-type><words>Moderato</words></direction-type></direction><direction><direction-type><words>Chorus</words></direction-type></direction><sound tempo="80" dynamics="70"/></measure>');
    return { strip: !/metronome|Moderato|tempo=/.test(shown) && /Chorus/.test(shown) && /dynamics="70"/.test(shown), file: !v.real || /<metronome\b/.test(v.xml()), svg: !!svg, mark: /=\s*\d{2,3}|\bbpm\b|\b(moderato|allegro|andante|adagio|largo|presto)\b/i.test(txt), bar: /bpm/i.test(document.querySelector('#sc-play').parentElement.parentElement.textContent), rate: document.querySelector('#sc-rate')?.textContent };
  });
  check('the score file keeps its tempo (the player reads it)', tempo.file, JSON.stringify(tempo));
  check('the drawn XML drops ♩ = N, tempo words and <sound tempo>, keeps other words and dynamics', tempo.strip, JSON.stringify(tempo));
  check('no tempo mark drawn on the score (no ♩ = N, no tempo words)', tempo.svg && !tempo.mark, JSON.stringify(tempo));
  check('the toolbar tempo is a plain number (the score\'s own bpm), nothing drawn on the score', /^\d{2,3}$/.test(tempo.rate || ''), JSON.stringify(tempo));
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
// jumps (musicxml.js barMarks + playOrder): D.S. / D.S.S. al Coda with two segni and two codas, D.C. al Fine (no
// repeat taken again after the jump, only the last ending), and plain repeats as before
{
  console.log('Jumps');
  const p = await b.newPage();
  await p.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  // bars: { n: 1-based bar → { pre: sound attrs at the start, post: at the end, bar: barline xml } }
  const order = (n, bars) => p.evaluate(async (n, bars) => {
    const { xmlInfo } = await import('/js/musicxml.js');
    const dir = (attrs) => `<direction><direction-type><words>x</words></direction-type><sound ${attrs}/></direction>`;
    let x = '<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">';
    for (let k = 1; k <= n; k++) {
      const o = bars[k] || {};
      x += `<measure number="${k}">${k === 1 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' : ''}`
        + (o.pre ? dir(o.pre) : '') + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>' + (o.post ? dir(o.post) : '') + (o.bar || '') + '</measure>';
    }
    const info = xmlInfo(x + '</part></score-partwise>');
    const seg = info.segments ? info.segments.map(([a, z]) => `${a / 4 + 1}-${z / 4}`).join(',') : 'none';
    return { order: info.order.map(([i]) => i + 1).join(','), seg };
  }, n, bars);
  const runs = (s) => s.split(',').flatMap((r) => { const [a, z = a] = r.split('-').map(Number); return Array.from({ length: z - a + 1 }, (_, k) => a + k); }).join(',');
  const ds = await order(49, { 13: { pre: 'segno="1"' }, 29: { pre: 'segno="2"' }, 37: { pre: 'tocoda="1"' }, 38: { pre: 'tocoda="2"' },
    47: { post: 'dalsegno="1"' }, 48: { pre: 'coda="1"', post: 'dalsegno="2"' }, 49: { pre: 'coda="2"' } });
  check('D.S. + D.S.S. al Coda: 1–47, 13–36, 48, 29–37, 49', ds.order === runs('1-47,13-36,48,29-37,49'), ds.order);
  check('…and the player gets those segments', ds.seg === '1-47,13-36,48-48,29-37,49-49', ds.seg);
  const rep = (dirn) => `<barline location="${dirn === 'forward' ? 'left' : 'right'}"><repeat direction="${dirn}"/></barline>`;
  const end = (num, type) => `<barline location="${type === 'start' ? 'left' : 'right'}"><ending number="${num}" type="${type}"/></barline>`;
  const dc = await order(8, { 2: { bar: rep('forward') }, 3: { bar: rep('backward') }, 4: { post: 'fine="yes"' }, 8: { post: 'dacapo="yes"' } });
  check('D.C. al Fine: no repeat after the jump, stops at Fine', dc.order === '1,2,3,2,3,4,5,6,7,8,1,2,3,4', dc.order);
  const vol = await order(6, { 3: { bar: end('1', 'start') + end('1', 'stop') + rep('backward') }, 4: { bar: end('2', 'start') + end('2', 'stop') }, 5: { pre: 'tocoda="1"' }, 6: { pre: 'coda="1"' } });
  const vol2 = await order(7, { 3: { bar: end('1', 'start') + end('1', 'stop') + rep('backward') }, 4: { bar: end('2', 'start') + end('2', 'stop') }, 5: { post: 'dacapo="yes"' }, 6: { pre: 'tocoda="x"' } });
  check('D.C. after a 1st / 2nd ending: only the 2nd ending the second time', vol2.order === '1,2,3,1,2,4,5,1,2,4,5,6,7', vol2.order);
  check('a To Coda before any jump is ignored', vol.order === '1,2,3,1,2,4,5,6', vol.order);
  const plain = await order(4, { 2: { bar: rep('backward') } });
  check('plain repeat unchanged', plain.order === '1,2,1,2,3,4' && plain.seg === '1-2,1-4', `${plain.order} ${plain.seg}`);
  const none = await order(3, {});
  check('no marks: no segments', none.seg === 'none' && none.order === '1,2,3', `${none.order} ${none.seg}`);
  await p.close();
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
