// Voice input + double-tap select-all on every text box (js/textinput.js), with a fake SpeechRecognition.
// PREVIEW=http://localhost:5236 node textinput.mjs   (or BASE=… for a real server)
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || process.env.BASE?.replace(/\/$/, '') || 'http://localhost:5181';
const BASE = ORIGIN + (process.env.BASE ? '/' : '/?preview=1');
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };

// a fake recognizer that behaves like WebKit's: window.__say = { alts: [[transcript, confidence], …], interim, error,
// hang, noStart: n (the next n starts never come on: no onstart, no onend), throwStart: n (the next n start() calls
// throw InvalidStateError) } decides what it "hears". start() on a running one throws, like the real thing.
// navigator.audioSession is faked too ('playback', as audio.js sets it), and its type is noted at each start.
const FAKE = () => {
  try { Object.defineProperty(navigator, 'audioSession', { value: { type: 'playback' }, configurable: true }); } catch {}
  window.__instances = 0;
  class FakeSR {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this.running = false; window.__rec = this; window.__instances++; }
    start() {
      const say = window.__say || { alts: [['hello', 0.9]] };
      if (say.throwStart > 0) { say.throwStart--; throw new DOMException('already started', 'InvalidStateError'); }
      if (this.running) throw new DOMException('already started', 'InvalidStateError');
      this.running = true; this.stopped = false;
      window.__started = (window.__started || 0) + 1; window.__lastLang = this.lang; window.__lastMax = this.maxAlternatives;
      window.__sessAtStart = navigator.audioSession?.type;
      if (say.noStart > 0) { say.noStart--; this.dead = true; return; } // a dead recognizer: ignores stop(), never ends
      this.dead = false;
      const end = () => { if (!this.running) return; this.running = false; this.stopped = true; this.onend?.(); };
      this.end = end;
      const res = (alts, isFinal) => { const r = alts.map(([transcript, confidence]) => ({ transcript, confidence })); r.isFinal = isFinal; return r; };
      setTimeout(() => {
        if (this.stopped) return;
        this.onstart?.(); this.onaudiostart?.();
        if (say.error) { setTimeout(() => { this.onerror?.({ error: say.error }); end(); }, 20); return; }
        setTimeout(() => {
          if (this.stopped) return;
          if (say.interim) { this.onresult?.({ resultIndex: 0, results: [res([[say.interim, 0]], false)] }); window.__interimSeen = document.activeElement?.value ?? null; }
          setTimeout(() => {
            if (this.stopped) return;
            this.onresult?.({ resultIndex: 0, results: [res(say.alts, true)] });
            if (!say.hang) setTimeout(end, 30);
          }, 80);
        }, 30);
      }, 30);
    }
    stop() { if (this.dead || !this.running || this.stopped) return; this.stopped = true; setTimeout(() => this.end?.(), 10); }
    abort() { if (this.dead) { this.running = false; return; } if (!this.running) return; this.stopped = true; setTimeout(() => { this.onerror?.({ error: 'aborted' }); this.end?.(); }, 5); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
};
const page = await b.newPage(); await page.setViewport({ width: 1366, height: 900 });
page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errs.push(m.text())); // a static preview has no /api/health
await page.evaluateOnNewDocument(FAKE);
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.removeItem('meowsic-voice-lang'); });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
const say = (s) => page.evaluate((s) => (window.__say = s), s);
const micOf = (sel) => page.$eval(sel, (el) => { const m = el.nextElementSibling; if (!m?.classList.contains('ti-mic') || m.hidden) return null; const a = m.getBoundingClientRect(), r = el.getBoundingClientRect(); return { w: a.width, h: a.height, inside: a.left >= r.left - 1 && a.right <= r.right + 1 && a.top >= r.top - 1 && a.bottom <= r.bottom + 1, lang: m.dataset.lang }; });
const tapMic = (sel) => page.$eval(sel, (el) => { const q = el.nextElementSibling.getBoundingClientRect(); return { x: q.x, y: q.y, width: q.width, height: q.height }; }).then((r) => page.mouse.click(r.x + r.width / 2, r.y + r.height / 2));

if (process.env.BASE) { // real server: Manage library → Organize pages: the find box has a mic, and speaking fills it
  console.log('Organize pages (real server)');
  await page.goto(BASE + '#/manage', { waitUntil: 'networkidle0' }); await sleep(1500);
  check('find box has a mic', !!(await micOf('#og-find')));
  await page.click('#og-find');
  await say({ alts: [['moon river', 0.9]] });
  await tapMic('#og-find'); await sleep(1200);
  check('spoken words fill the find box', /moon river/i.test(await page.$eval('#og-find', (e) => e.value)), await page.$eval('#og-find', (e) => e.value));
  await page.keyboard.press('Escape'); await sleep(200);
  check('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
}

console.log('Mic in every text box');
let m = await micOf('#lib-q');
check('library search has a mic inside the box', m && m.inside, JSON.stringify(m));
check('no mic on checkboxes', !(await page.$$eval('input[type=checkbox] + .ti-mic', (e) => e.length)));

console.log('Speech replaces the whole text and filters');
await page.click('#lib-q'); await page.type('#lib-q', 'zzz nothing'); await sleep(250);
await say({ alts: [['memories', 0.4], ['memory', 0.93]], interim: 'mem' });
await tapMic('#lib-q');
await sleep(60);
check('mic pulses while listening', await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on')));
await sleep(400);
check('interim words show live', (await page.evaluate(() => window.__interimSeen)) === 'mem', await page.evaluate(() => window.__interimSeen));
check('final text replaced the whole value (highest confidence)', (await page.$eval('#lib-q', (e) => e.value)) === 'memory', await page.$eval('#lib-q', (e) => e.value));
check('search filtered to Memory', (await page.$$eval('#lib-rows .row-title', (e) => e.map((x) => x.textContent))).includes('Memory') && (await page.$$('#lib-rows .row')).length < 20);
check('field kept focus (mic never steals it)', await page.evaluate(() => document.activeElement?.id === 'lib-q'));
check('asked for several alternatives, English', (await page.evaluate(() => window.__lastMax)) > 1 && (await page.evaluate(() => window.__lastLang)) === 'en-US');
check('mic stops pulsing', !(await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on'))));
// tap again stops: hang after the first result, tap → stops and keeps what was heard
await say({ alts: [['moon river', 0.9]], hang: true });
await tapMic('#lib-q'); await sleep(450);
check('still listening (no silence yet)', await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on')));
await tapMic('#lib-q'); await sleep(150);
check('tap again stops and keeps the words', !(await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on'))) && (await page.$eval('#lib-q', (e) => e.value)) === 'moon river');
// errors
const toastNow = () => page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));
const pulsing = () => page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on'));
const clearToast = () => page.$eval('#toast', (e) => { e.hidden = true; e.textContent = ''; });
const starts = () => page.evaluate(() => window.__started || 0);
const mic = (fn) => page.evaluate(async (fn) => { const m = await import('/js/textinput.js'); return new Function('m', fn)(m); }, fn);
await sleep(450); await clearToast();
await say({ error: 'not-allowed' });
await tapMic('#lib-q'); await sleep(250);
check('error shown: mic blocked → Settings', /Microphone blocked — allow it in Settings/.test(await toastNow()), await toastNow());
check('error leaves the text alone', (await page.$eval('#lib-q', (e) => e.value)) === 'moon river');
check('not pulsing after the error', !(await pulsing()));
await sleep(450); await clearToast();
await say({ error: 'no-speech' });
await tapMic('#lib-q'); await sleep(400);
check('error shown: no speech → tap to try again', /didn’t hear anything — tap to try again/.test(await toastNow()), await toastNow());
check('not pulsing after no-speech', !(await pulsing()));
await sleep(450); await clearToast();
let s0 = await starts();
await say({ error: 'network' });
await tapMic('#lib-q'); await sleep(300);
check('error shown: network → needs internet', /Speech needs internet on this device/.test(await toastNow()), await toastNow());
check('network error is not retried', (await starts()) === s0 + 1, `${await starts()} vs ${s0}`);
check('not pulsing after network', !(await pulsing()));

console.log('Robust start (iOS pitfalls)');
// a recognizer that never comes on: no pulse, retried once on a fresh recognizer, then it works
await sleep(450); await clearToast();
await page.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
s0 = await starts(); const i0 = await page.evaluate(() => window.__instances);
await say({ alts: [['clair de lune', 0.9]], noStart: 1 });
await tapMic('#lib-q'); await sleep(300);
check('no onstart yet → no pulse', !(await pulsing()));
check('audio session is play-and-record while the mic starts', (await page.evaluate(() => window.__sessAtStart)) === 'play-and-record', await page.evaluate(() => window.__sessAtStart));
await sleep(3800);
check('dead recognizer retried once on a fresh one', (await starts()) === s0 + 2 && (await page.evaluate(() => window.__instances)) > i0, `${(await starts()) - s0} starts`);
check('the retry heard the words', (await page.$eval('#lib-q', (e) => e.value)) === 'clair de lune', await page.$eval('#lib-q', (e) => e.value));
check('audio session given back (playback)', (await page.evaluate(() => navigator.audioSession.type)) === 'playback');
check('not pulsing after', !(await pulsing()));
// never comes on at all: one clear toast, the button is honest
await sleep(450); await clearToast();
await say({ alts: [['x', 0.9]], noStart: 2 });
await tapMic('#lib-q'); await sleep(7200);
check('never started → "Mic didn’t start — tap to try again"', /Mic didn’t start — tap to try again/.test(await toastNow()), await toastNow());
check('never started → not pulsing, recognizer idle', !(await pulsing()) && !(await mic('return m.micState().live || m.micState().ending')));
// InvalidStateError on start: a fresh recognizer right away, still in the tap
await sleep(300); await clearToast();
await page.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
await say({ alts: [['gymnopedie', 0.9]], throwStart: 1 });
await tapMic('#lib-q'); await sleep(80);
check('InvalidStateError → pulses on a fresh recognizer', await pulsing());
await sleep(400);
check('InvalidStateError → words still arrive, no toast', (await page.$eval('#lib-q', (e) => e.value)) === 'gymnopedie' && !(await toastNow()), `${await page.$eval('#lib-q', (e) => e.value)} / ${await toastNow()}`);
// rapid double tap: one session, not start-then-stop
await sleep(450); await clearToast();
await page.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
s0 = await starts();
await say({ alts: [['for elise', 0.9]], hang: true });
await tapMic('#lib-q'); await sleep(60); await tapMic('#lib-q'); await sleep(250);
check('double tap → one start, still listening', (await starts()) === s0 + 1 && (await pulsing()), `${(await starts()) - s0} starts`);
await sleep(300); await tapMic('#lib-q'); await sleep(150);
check('a later tap stops it and keeps the words', !(await pulsing()) && (await page.$eval('#lib-q', (e) => e.value)) === 'for elise');
// a start while the last session is still winding down waits for its onend (no InvalidStateError), then starts
await sleep(450);
await say({ alts: [['nocturne', 0.9]], hang: true });
await tapMic('#lib-q'); await sleep(450);
s0 = await starts();
await mic("m.stopVoice(false); m.startVoice(document.querySelector('#lib-q'));");
await sleep(300);
check('start during wind-down → queued, then started', (await starts()) === s0 + 1 && (await pulsing()), `${(await starts()) - s0} starts`);
await mic('m.stopVoice(true);'); await sleep(200);
// the app goes to the background: the session ends, the button stops, the words are kept
await say({ alts: [['moonlight', 0.9]], hang: true });
await sleep(450); await tapMic('#lib-q'); await sleep(450);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(150);
check('backgrounded → stops, keeps the words', !(await pulsing()) && (await page.$eval('#lib-q', (e) => e.value)) === 'moonlight');
await page.evaluate(() => { delete document.hidden; });
await clearToast();

console.log('Double-click selects all; typing replaces');
await page.$eval('#lib-q', (e) => { e.value = 'some old words'; e.dispatchEvent(new Event('input')); });
await page.click('#lib-q', { clickCount: 1 }); await sleep(50);
check('single click keeps a caret (no selection)', await page.$eval('#lib-q', (e) => e.selectionStart === e.selectionEnd));
await page.click('#lib-q', { count: 2 }); await sleep(80);
check('double-click selects the whole text', await page.$eval('#lib-q', (e) => e.selectionStart === 0 && e.selectionEnd === e.value.length && e.value.length === 14));
await page.keyboard.type('Ave'); await sleep(250);
check('typing replaces it', (await page.$eval('#lib-q', (e) => e.value)) === 'Ave');
await page.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });

console.log('Rename box (Create tag) and a textarea (Paste a chord chart)');
await page.evaluate(() => (location.hash = '#/tags')); await sleep(400);
await page.click('#tg-add'); await sleep(300);
const sheetIn = '.modal form input';
m = await micOf(sheetIn);
check('rename box has a mic', m && m.inside, JSON.stringify(m));
await page.type(sheetIn, 'Old'); await say({ alts: [['Recital pieces', 0.8]] });
await tapMic(sheetIn); await sleep(350);
check('speech replaced the rename text', (await page.$eval(sheetIn, (e) => e.value)) === 'Recital pieces');
check('sheet still open (no blur/close)', !!(await page.$('.modal')));
await page.keyboard.press('Escape'); await sleep(200);
await page.evaluate(() => (location.hash = '#/add-chords')); await sleep(500);
await page.click('#cs-paste'); await sleep(300);
const ta = '#pc textarea';
m = await micOf(ta);
check('textarea has a mic', m && m.inside, JSON.stringify(m));
check('chord search box has a mic', !!(await micOf('#cs-q')));
await page.$eval(ta, (e) => { e.value = 'line one\nline two'; });
await page.$eval(ta, (e) => e.addEventListener('input', () => (window.__taInput = e.value)));
await say({ alts: [['twinkle twinkle little star', 0.9]] });
await tapMic(ta); await sleep(350);
check('speech replaced the whole textarea and fired input', (await page.$eval(ta, (e) => e.value)) === 'twinkle twinkle little star' && (await page.evaluate(() => window.__taInput)) === 'twinkle twinkle little star');
await page.keyboard.press('Escape'); await sleep(200);

console.log('Vietnamese');
await page.evaluate(() => (location.hash = '#/library')); await sleep(400);
const r = await page.$eval('#lib-q', (el) => { const q = el.nextElementSibling.getBoundingClientRect(); return { x: q.x, y: q.y, width: q.width, height: q.height }; });
await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down(); await sleep(750); await page.mouse.up(); await sleep(200);
check('long-press switches to Vietnamese', (await page.evaluate(() => localStorage.getItem('meowsic-voice-lang'))) === 'vi-VN' && (await micOf('#lib-q')).lang === 'vi');
check('long-press did not start listening', !(await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on'))));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
check('Vietnamese remembered after reload', (await micOf('#lib-q'))?.lang === 'vi');
await say({ alts: [['cam on ban', 0.9], ['cảm ơn bạn', 0.6]] });
await tapMic('#lib-q'); await sleep(350);
check('vi-VN recognizer', (await page.evaluate(() => window.__lastLang)) === 'vi-VN');
check('prefers the alternative with diacritics', (await page.$eval('#lib-q', (e) => e.value)) === 'cảm ơn bạn', await page.$eval('#lib-q', (e) => e.value));
await page.evaluate(() => (location.hash = '#/settings')); await sleep(500);
check('Settings: Voice input language shows Tiếng Việt', (await page.$eval('#st-voice-lang .on', (e) => e.textContent).catch(() => '')) === 'Tiếng Việt');
await page.click('#st-voice-lang [data-l="en-US"]'); await sleep(100);
check('Settings: English picked and saved', (await page.evaluate(() => localStorage.getItem('meowsic-voice-lang'))) === 'en-US' && (await page.$eval('#st-voice-lang .on', (e) => e.textContent)) === 'English');
await page.evaluate(() => (location.hash = '#/settings')); await sleep(300);
check('Settings card added once', (await page.$$('#st-voice')).length === 1);

console.log('iPhone Air (420 wide, touch)');
const ph = await b.newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
await ph.evaluateOnNewDocument(FAKE);
await ph.setViewport({ width: 420, height: 912, hasTouch: true, isMobile: true });
await ph.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(600);
const pm = await ph.$eval('#lib-q', (el) => { const m = el.nextElementSibling, a = m.getBoundingClientRect(), s = el.closest('.search').getBoundingClientRect(); const others = [...document.querySelectorAll('.lib-top button:not(.ti-mic), .lib-top a')].filter((x) => x.offsetWidth).map((x) => x.getBoundingClientRect()); return { w: a.width, h: a.height, inside: a.left >= s.left && a.right <= s.right && a.top >= s.top && a.bottom <= s.bottom, overlap: others.some((o) => !(o.right <= a.left || o.left >= a.right || o.bottom <= a.top || o.top >= a.bottom)), inputW: el.getBoundingClientRect().width }; });
check('phone: mic ≥ 36 px, inside the search bar, not crowding', pm.w >= 36 && pm.h >= 36 && pm.inside && !pm.overlap && pm.inputW > 200, JSON.stringify(pm));
await ph.$eval('#lib-q', (e) => { e.value = 'hello world'; });
const ir = await ph.$eval('#lib-q', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; });
await ph.touchscreen.tap(ir.x, ir.y); await sleep(120); await ph.touchscreen.tap(ir.x, ir.y); await sleep(150);
check('phone: double-tap selects all', await ph.$eval('#lib-q', (e) => document.activeElement === e && e.selectionStart === 0 && e.selectionEnd === 11), JSON.stringify(await ph.$eval('#lib-q', (e) => [e.selectionStart, e.selectionEnd])));
await ph.close();

console.log('No speech API → no mic');
const np = await b.newPage();
await np.evaluateOnNewDocument(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined }); });
await np.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(500);
check('no mic anywhere', (await np.$$('.ti-mic')).length === 0);
await np.$eval('#lib-q', (e) => { e.value = 'abc def'; });
await np.click('#lib-q', { count: 2 }); await sleep(80);
check('double-click select-all still works', await np.$eval('#lib-q', (e) => e.selectionStart === 0 && e.selectionEnd === 7));
await np.close();

check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
