// Quick feedback (js/quickfeedback.js): the speech-bubble button in a score, sheet and chord view opens a popover
// with a text box whose mic starts at once, "About: <title> · page N / bar N", Send / Cancel. Send → toast
// "Feedback sent", the note is on the Mac with the item and its context (page, bar, zoom, version, device), and the
// Developer list shows the song (a link that opens it) and the details. While the popover is open a swipe up does
// not close the view (swipe.js toolOpen). iPad Pro 13 + iPhone Air + Mac, against a test server (BASE, default
// :5317, a temp data folder — never the real library). Speech recognition is a stand-in that "hears" a sentence.
// SHOTS = folder for screenshots.
import puppeteer from 'puppeteer-core';
import fs, { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5317/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/quickfb';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const MAC = { width: 1280, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const stamp = Date.now().toString(36);

// ---- test data: a two-page sheet, a 4-bar score, a chord chart ----
const web = new URL('../../web/', import.meta.url);
const fd = new FormData();
fd.append('files', new Blob([readFileSync(new URL('icon-512.png', web))], { type: 'image/png' }), `p1-${stamp}.png`);
fd.append('files', new Blob([readFileSync(new URL('icon-180.png', web))], { type: 'image/png' }), `p2-${stamp}.png`);
fd.append('title', `QF sheet ${stamp}`);
let sheet = await fetch(BASE + 'api/sheets', { method: 'POST', body: fd }).then((r) => r.json());
const dup = sheet.detail?.skipped?.[0]?.duplicateOf; // the same pages were uploaded by an earlier run
sheet = sheet.item || sheet;
if (!sheet.id) sheet = (await api('/items')).find((x) => x.id === dup || x.kind === 'sheet');
const bar = (n) => `<measure number="${n}">${n === 1 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}`
  + ['C', 'D', 'E', 'F'].map((s) => `<note><pitch><step>${s}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`).join('') + '</measure>';
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>QF score ${stamp}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${[1, 2, 3, 4].map(bar).join('')}</part></score-partwise>`;
const score = await post('/items', { kind: 'score', title: `QF score ${stamp}`, musicxmlText: xml });
const chords = await post('/items', { kind: 'chords', title: `QF chords ${stamp}`, text: 'A[G]mazing [C]grace how [G]sweet the sound', key: 'G', source: 'pasted' });
check('test items made', !!(sheet.id && score.id && chords.id), JSON.stringify({ sheet, score, chords }).slice(0, 300));

// stand-in speech recognition: start() is counted; __say(text) delivers a final result and ends
const FAKE_SR = () => {
  window.__recStarts = 0;
  class FakeSR { start() { window.__recStarts++; window.__rec = this; } stop() { setTimeout(() => this.onend?.(), 0); } abort() { this.stop(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  window.__say = (t) => { const r = window.__rec; const res = [{ transcript: t, confidence: 0.9 }]; res.isFinal = true; r.onresult({ resultIndex: 0, results: [res] }); r.stop(); };
};

async function run(name, vp, short) {
  console.log(`\n${name}`);
  const page = await b.newPage(); await page.setViewport(vp);
  await page.evaluateOnNewDocument(FAKE_SR);
  page.on('pageerror', (e) => errs.push(`${short}: ${e.message}`));
  const touch = !!vp.hasTouch;
  const tap = async (sel) => { const el = await page.$(sel); if (!el) throw new Error('no ' + sel); await (touch ? el.tap() : el.click()); };
  const open = async (it) => {
    await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
    await page.evaluate((id) => { location.hash = '#/item/' + id; }, it.id);
    await page.waitForSelector(it.kind === 'score' ? '#osmd svg' : it.kind === 'sheet' ? '.pages .page img' : '#lyrics .line, #lyrics *', { timeout: 15000 }); await sleep(800);
  };
  const toastText = () => page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));

  for (const it of [score, sheet, chords]) {
    const k = it.kind;
    await open(it);
    if (k === 'score') await page.evaluate(() => { window.__score.player.posQ = 9; }); // bar 3 of 4/4
    if (k === 'sheet') { await page.keyboard.press('ArrowRight'); await sleep(400); }
    const btn = await page.$('#it-feedback');
    const look = btn && await page.evaluate((e) => ({ cls: e.className, svg: !!e.querySelector('svg.ic'), text: e.textContent.trim(), w: e.offsetWidth, h: e.offsetHeight, inTop: !!e.closest('.item-top') }), btn);
    check(`${k}: icon-only feedback button in the header`, look && look.cls.includes('icon-btn') && look.svg && !look.text && look.inTop, JSON.stringify(look));
    if (touch) check(`${k}: button is touch-sized`, look && look.h >= 34 && look.w >= 30, JSON.stringify(look));
    const starts0 = await page.evaluate(() => window.__recStarts);
    await tap('#it-feedback'); await sleep(300);
    check(`${k}: popover opens`, !!(await page.$('.qfb')));
    check(`${k}: mic started on the tap`, (await page.evaluate(() => window.__recStarts)) === starts0 + 1 && await page.evaluate(() => !!document.querySelector('.qfb .ti-mic.on')));
    const about = await page.$eval('.qfb-about', (e) => e.textContent);
    const want = k === 'score' ? 'bar 3' : k === 'sheet' ? (touch ? 'page 2' : 'page 1') : ''; // a Mac shows pages 1–2 side by side
    check(`${k}: "About: title · where"`, about.startsWith('About: ') && about.includes(it.title) && about.includes(want), about);
    check(`${k}: Send and Cancel`, (await page.$$eval('.qfb-acts button', (bs) => bs.map((x) => x.textContent).join())) === 'Cancel,Send');
    // the popover is a tool: a swipe up does not close the view
    if (touch) {
      const r = await page.$eval('.viewer-body', (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height * 0.7 }; });
      await page.touchscreen.touchStart(r.x, r.y);
      for (let i = 1; i <= 5; i++) await page.touchscreen.touchMove(r.x + 2, r.y - 40 * i);
      await page.touchscreen.touchEnd(); await sleep(600);
      check(`${k}: swipe up with the popover open keeps the view`, (await page.evaluate(() => location.hash)).startsWith('#/item/'), await page.evaluate(() => location.hash));
    }
    const said = `Quick ${k} ${short} ${stamp}`;
    await page.evaluate((t) => window.__say(t), said); await sleep(200);
    check(`${k}: what was said is in the box`, (await page.$eval('#qfb-text', (e) => e.value)) === said);
    if (it === score) await page.screenshot({ path: `${SHOTS}/${short}-score-popover.png` });
    if (it === sheet) await page.screenshot({ path: `${SHOTS}/${short}-sheet-popover.png` });
    if (it === chords) await page.screenshot({ path: `${SHOTS}/${short}-chords-popover.png` });
    await tap('.qfb [data-a="send"]'); await sleep(600);
    check(`${k}: popover closed after Send`, !(await page.$('.qfb')));
    check(`${k}: toast "Feedback sent"`, (await toastText()).includes('Feedback sent'), await toastText());
    const row = (await api('/feedback')).find((f) => f.text === said);
    check(`${k}: on the Mac with the item`, row && row.item?.id === it.id && row.item.kind === k && row.item.title === it.title, JSON.stringify(row));
    const c = row?.context || {};
    check(`${k}: context has view, device and time`, c.view === k && c.device === name.split(' ')[0] && !!c.at && !!c.zoom, JSON.stringify(c));
    if (k === 'score') check('score: bar, time and version', c.bar === 3 && c.timeSec > 0 && c.version === 'Original', JSON.stringify(c));
    if (k === 'sheet') check(`sheet: page ${touch ? 2 : 1} of 2`, c.page === (touch ? 2 : 1) && c.pages === 2, JSON.stringify(c));
    // Cancel sends nothing
    await tap('#it-feedback'); await sleep(250);
    await page.evaluate(() => window.__say('Should not be sent ' + Date.now())); await sleep(150);
    await tap('.qfb [data-a="cancel"]'); await sleep(300);
    check(`${k}: Cancel closes, nothing sent`, !(await page.$('.qfb')) && !(await api('/feedback')).some((f) => f.text.startsWith('Should not be sent')));
  }

  // ---- Developer → Feedback list ----
  await page.evaluate(() => { location.hash = '#/developer'; }); await sleep(900);
  for (const it of [score, sheet, chords]) {
    const said = `Quick ${it.kind} ${short} ${stamp}`;
    const id = (await api('/feedback')).find((f) => f.text === said)?.id;
    const sum = `details[data-id="${id}"] > summary`;
    check(`list: ${it.kind} row names the song`, (await page.$eval(`${sum} .fb-first`, (e) => e.textContent).catch(() => '')).includes(it.title));
    await tap(sum); await sleep(250);
    const info = await page.$eval(`details[data-id="${id}"] .fb-body`, (e) => ({ about: e.querySelector('.fb-about')?.textContent || '', href: e.querySelector('.fb-about a')?.getAttribute('href') || '', ctx: e.querySelector('.fb-ctx')?.textContent || '' }));
    const where = it.kind === 'score' ? 'bar 3' : it.kind === 'sheet' ? `page ${touch ? 2 : 1} of 2` : '';
    check(`list: ${it.kind} details (link, where, zoom, device)`, info.about.includes(it.title) && info.href === `#/item/${encodeURIComponent(it.id)}` && info.about.includes(where) && info.ctx.includes('zoom'), JSON.stringify(info));
  }
  await page.screenshot({ path: `${SHOTS}/${short}-developer-list.png` });
  // the link opens the song
  const sid = (await api('/feedback')).find((f) => f.text === `Quick sheet ${short} ${stamp}`).id;
  await tap(`details[data-id="${sid}"] .fb-about a`); await sleep(900);
  check('list: the song link opens the sheet', (await page.evaluate(() => location.hash)) === `#/item/${sheet.id}`);
  await page.close();
}

await run('Mac', MAC, 'mac');
await run('iPad Pro 13', IPAD, 'ipad');
await run('iPhone Air', PHONE, 'iphone');
check('no page errors', !errs.length, errs.join('\n'));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
