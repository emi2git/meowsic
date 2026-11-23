// Voice input + double-tap select-all on every text box (js/textinput.js), with a fake SpeechRecognition.
// PREVIEW=http://localhost:5236 node textinput.mjs   (or BASE=… for a real server)
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || process.env.BASE?.replace(/\/$/, '') || 'http://localhost:5181';
const BASE = ORIGIN + (process.env.BASE ? '/' : '/?preview=1');
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };

// a fake recognizer: window.__say = { alts: [[transcript, confidence], …], interim, error } decides what it "hears"
const FAKE = () => {
  class FakeSR {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; window.__rec = this; }
    start() {
      window.__started = (window.__started || 0) + 1; window.__lastLang = this.lang; window.__lastMax = this.maxAlternatives;
      const say = window.__say || { alts: [['hello', 0.9]] };
      const res = (alts, isFinal) => { const r = alts.map(([transcript, confidence]) => ({ transcript, confidence })); r.isFinal = isFinal; return r; };
      setTimeout(() => {
        if (say.error) { this.onerror?.({ error: say.error }); this.onend?.(); return; }
        if (say.interim) { this.onresult?.({ resultIndex: 0, results: [res([[say.interim, 0]], false)] }); window.__interimSeen = document.activeElement?.value ?? null; }
        setTimeout(() => {
          if (this.stopped) return;
          this.onresult?.({ resultIndex: 0, results: [res(say.alts, true)] });
          if (!say.hang) setTimeout(() => { if (!this.stopped) { this.stopped = true; this.onend?.(); } }, 30);
        }, 80);
      }, 50);
    }
    stop() { if (this.stopped) return; this.stopped = true; setTimeout(() => this.onend?.(), 10); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
};
const page = await b.newPage(); await page.setViewport({ width: 1366, height: 900 });
page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.evaluateOnNewDocument(FAKE);
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.removeItem('meowsic-voice-lang'); });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
const say = (s) => page.evaluate((s) => (window.__say = s), s);
const micOf = (sel) => page.$eval(sel, (el) => { const m = el.nextElementSibling; if (!m?.classList.contains('ti-mic') || m.hidden) return null; const a = m.getBoundingClientRect(), r = el.getBoundingClientRect(); return { w: a.width, h: a.height, inside: a.left >= r.left - 1 && a.right <= r.right + 1 && a.top >= r.top - 1 && a.bottom <= r.bottom + 1, lang: m.dataset.lang }; });
const tapMic = (sel) => page.$eval(sel, (el) => { const q = el.nextElementSibling.getBoundingClientRect(); return { x: q.x, y: q.y, width: q.width, height: q.height }; }).then((r) => page.mouse.click(r.x + r.width / 2, r.y + r.height / 2));

if (process.env.BASE) { // real server: speaking into the Clean up note saves it (autosave), and title rename works
  console.log('Clean up (real server)');
  await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('1'); await page.keyboard.up('Alt'); await sleep(600);
  const nid = await page.$eval('#cu-note', (e) => e.dataset.id);
  check('note box has a mic', !!(await micOf('#cu-note')));
  await page.click('#cu-note'); await page.keyboard.type('old note text'); await sleep(900);
  await say({ alts: [['split after page two', 0.9]] });
  await tapMic('#cu-note'); await sleep(1200);
  const notes = await fetch(ORIGIN + '/api/cleanup/notes').then((r) => r.json());
  check('spoken note replaced the old text and was saved', notes.some((x) => x.id === nid && x.text === 'split after page two'), JSON.stringify(notes.filter((x) => x.id === nid)));
  check('note box kept focus', await page.evaluate(() => document.activeElement?.id === 'cu-note'));
  await page.keyboard.press('Escape'); await sleep(200);
  await fetch(ORIGIN + '/api/cleanup/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: nid, text: '' }) });
  await page.keyboard.down('Alt'); await page.keyboard.press('2'); await page.keyboard.up('Alt'); await sleep(600);
  check('read-only title box: no mic until renaming', !(await micOf('#cu-title')));
  await page.click('#cu-title'); await sleep(300);
  check('renaming: title box gets a mic', !!(await micOf('#cu-title')));
  await page.keyboard.press('Escape'); await sleep(300);
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
await tapMic('#lib-q'); await sleep(250);
check('still listening (no silence yet)', await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on')));
await tapMic('#lib-q'); await sleep(150);
check('tap again stops and keeps the words', !(await page.$eval('#lib-q + .ti-mic', (e) => e.classList.contains('on'))) && (await page.$eval('#lib-q', (e) => e.value)) === 'moon river');
// errors
await say({ error: 'not-allowed' });
await tapMic('#lib-q'); await sleep(250);
check('error shown: not allowed', /Microphone not allowed/.test(await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent))));
check('error leaves the text alone', (await page.$eval('#lib-q', (e) => e.value)) === 'moon river');
await say({ error: 'no-speech' });
await tapMic('#lib-q'); await sleep(250);
check('error shown: no speech', /No speech/.test(await page.$eval('#toast', (e) => e.textContent)));

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
