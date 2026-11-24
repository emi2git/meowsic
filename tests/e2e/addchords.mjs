// Add music → Chords on iPad Pro 13, iPad 11 and iPhone: search, results, preview and the save sheet fit the
// screen (no sideways scroll, key buttons fully on screen, also above the on-screen keyboard); the save sheet
// starts with tags picked for you (chips only, never the whole tag list) and "+ Tag" adds an existing or a new
// tag; an empty chart (or a UG "Official" tab) is never saved: an error with "Try again" instead.
// Needs a temp server with the chord sites mocked (never the live data), seeded with:
//   sheet "One Day More (Les Misérables)" tags Les Miserables, Musical, Super Easy; chords tagged Vietnamese, Folk;
//   and English, Movie, … (see the commit's test notes). Search "one day more" must give, in order:
//   0 One Day More (fixture tab), 1 a long-title tab, 2 an Official tab (no chord text), 3 a hopamchuan song.
//   BASE=http://127.0.0.1:5341/  SHOTS=<dir>
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:5341/';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [], saved = [];
const DEVICES = [
  ['ipadpro13-portrait', 1032, 1376], ['ipadpro13-landscape', 1376, 1032],
  ['ipad11-portrait', 834, 1194], ['ipad11-landscape', 1194, 834],
  ['iphone-402', 402, 874], ['iphone-420', 420, 912],
];

for (const [dev, w, h] of DEVICES) {
  console.log(dev);
  const p = await b.newPage(); await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  p.on('pageerror', (e) => errs.push(dev + ' ' + e.message));
  const posts = [];
  await p.setBypassServiceWorker(true); // so the test sees (and can stub) every /api request
  await p.setRequestInterception(true);
  let emptyFetch = false;
  p.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/items')) posts.push(JSON.parse(r.postData() || '{}'));
    if (emptyFetch && r.url().includes('/api/chords/fetch')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'X', source: 'ultimate-guitar', text: '', key: '' }) });
    r.continue();
  });
  const shot = (n) => SHOTS && p.screenshot({ path: `${SHOTS}/${dev}-${n}.png` });
  // nothing scrolls sideways; every key control is inside the screen and not covered
  const fits = () => p.evaluate(() => {
    const bad = [];
    for (const e of [document.documentElement, ...document.querySelectorAll('#main, .ac-body, .ac-list, .ac-preview, .modal')]) if (e.offsetParent !== null || e === document.documentElement) if (e.scrollWidth > e.clientWidth + 1) bad.push(`${e.className || e.id || e.tagName} ${e.scrollWidth}>${e.clientWidth}`);
    return bad;
  });
  const visible = (sel, bottomInset = 0) => p.evaluate((sel, inset) => {
    const e = document.querySelector(sel); if (!e) return `${sel}: missing`;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight - inset + 0.5) return `${sel}: ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}×${innerHeight - inset}`;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === e || e.contains(hit)) ? '' : `${sel}: covered by ${hit?.className || hit?.tagName}`;
  }, sel, bottomInset);
  let narrow;

  await p.goto(BASE + '#/add-chords', { waitUntil: 'networkidle0' }); await sleep(400);
  narrow = (await p.$eval('.addch', (e) => e.clientWidth)) < 760;
  check(`${dev}: search screen fits`, !(await fits()).length, (await fits()).join(' | '));
  for (const s of ['#cs-q', '#cs-src [data-s="vi"]', '#cs-paste']) { const v = await visible(s); check(`${dev}: ${s} on screen`, !v, v); }
  await p.type('#cs-q', 'one day more'); await sleep(1300);
  check(`${dev}: results listed`, (await p.$$('#cs-results .row')).length === 4);
  check(`${dev}: results fit (long titles too)`, !(await fits()).length, (await fits()).join(' | '));
  const fs = await p.$$eval('#cs-results .row-title, #cs-results .row-sub, .ac-form .seg button', (e) => e.map((x) => parseFloat(getComputedStyle(x).fontSize)));
  check(`${dev}: standard text sizes (≤ 16px)`, fs.every((f) => f >= 12 && f <= 16), fs.join());
  await shot('1-results');

  // the long-title, long-line chart
  await p.evaluate(() => document.querySelectorAll('#cs-results .row')[1].click()); await sleep(1200);
  check(`${dev}: preview fits (long title, long lyric and tab lines)`, !(await fits()).length, (await fits()).join(' | '));
  for (const s of ['#pv-save', '#cv-key']) { const v = await visible(s); check(`${dev}: ${s} fully visible`, !v, v); }
  if (narrow) {
    check(`${dev}: one pane at a time; "‹ Results" goes back`, !(await visible('#pv-back')) && (await p.$eval('.ac-list', (e) => getComputedStyle(e).display)) === 'none');
    await p.click('#pv-back'); await sleep(200);
    check(`${dev}: back on the results`, (await p.$eval('.ac-list', (e) => getComputedStyle(e).display)) !== 'none' && (await p.$eval('.ac-preview', (e) => getComputedStyle(e).display)) === 'none');
  } else check(`${dev}: results and preview side by side`, (await p.$eval('.ac-list', (e) => getComputedStyle(e).display)) !== 'none' && !(await visible('#cs-q')));
  const h2 = await p.$eval('.pv-head h2', (e) => parseFloat(getComputedStyle(e).fontSize));
  check(`${dev}: preview title = app heading size`, h2 === 18, h2);
  await shot('2-preview');

  // the Official tab: says so, Try again, nothing to save
  await p.evaluate(() => document.querySelectorAll('#cs-results .row')[2].click()); await sleep(1000);
  const off = await p.$eval('#cs-preview', (e) => e.innerText);
  check(`${dev}: Official tab → clear message + Try again, no Save`, /Official/.test(off) && !!(await p.$('#pv-retry')) && !(await p.$('#pv-save')), off.slice(0, 160));
  { const v = await visible('#pv-retry'); check(`${dev}: Try again fully visible`, !v, v); }
  // an empty chart from the Mac: refused, Try again refetches
  emptyFetch = true;
  if (narrow) { await p.click('#pv-back'); await sleep(150); }
  await p.evaluate(() => document.querySelectorAll('#cs-results .row')[0].click()); await sleep(800);
  check(`${dev}: empty chords → error + Try again, nothing to save`, !!(await p.$('#pv-retry')) && !(await p.$('#pv-save')) && /No chords/.test(await p.$eval('#cs-preview', (e) => e.innerText)));
  emptyFetch = false;
  await p.click('#pv-retry'); await sleep(1200);
  check(`${dev}: Try again fetches the chords`, !!(await p.$('#pv-save')));

  // save sheet: tags picked for you, chips only
  await p.click('#pv-save'); await sleep(400);
  const chips = await p.$$eval('.tc-chip', (e) => e.map((x) => x.dataset.t));
  check(`${dev}: auto tags = same song's + show + language`, chips.join('|') === 'Les Miserables|Musical|English', chips.join('|'));
  check(`${dev}: per-copy tags of the other copy not carried over`, !chips.includes('Super Easy'));
  check(`${dev}: no full tag list (only the chosen chips + "+ Tag")`, (await p.$$('.tc-opt, .chip')).length === 0 && !!(await p.$('.tc-add')));
  check(`${dev}: save sheet fits`, !(await fits()).length, (await fits()).join(' | '));
  for (const s of ['#sv-save', '.sv-sheet [data-close]', '.tc-add', '.tc-chip .tc-x']) { const v = await visible(s); check(`${dev}: ${s} fully visible`, !v, v); }
  check(`${dev}: no keyboard popping up on open`, await p.evaluate(() => !document.activeElement || !document.activeElement.matches('input')));
  await shot('3-save');
  // remove one, add an existing one, make a new one
  await p.evaluate(() => document.querySelector('.tc-chip[data-t="English"] .tc-x').click()); await sleep(100);
  await p.click('.tc-add'); await sleep(150);
  check(`${dev}: "+ Tag" opens a search`, !!(await p.$('.tc-q')));
  await p.type('.tc-q', 'fol'); await sleep(150);
  const opts = await p.$$eval('.tc-opt', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: search lists the existing tag first`, opts[0] === 'Folk' && !opts.includes('Musical'), opts.join('|'));
  await p.evaluate(() => document.querySelector('.tc-opt').click()); await sleep(150);
  await p.type('.tc-q', 'folk'); await sleep(150);
  const again = await p.$$eval('.tc-opt', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: a tag already chosen is not offered again, nor Create for it`, !again.length, again.join('|'));
  await p.$eval('.tc-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const fresh = `New ${dev}`;
  await p.type('.tc-q', fresh); await sleep(150);
  const mk = await p.$$eval('.tc-opt', (e) => e.map((x) => x.textContent.trim()));
  check(`${dev}: a new name offers Create “…”`, mk.includes(`Create “${fresh}”`), mk.join('|'));
  { const v = await visible('.tc-new'); check(`${dev}: Create fully visible`, !v, v); }
  // the on-screen keyboard (e.g. 330 px): the sheet sits above it, Save still on screen
  await p.evaluate(() => document.querySelector('.sv-wrap').style.setProperty('--kb', '330px')); await sleep(100);
  { const v = await visible('#sv-save', 330); check(`${dev}: with the keyboard up, Save is above it`, !v, v); }
  { const v = await visible('.tc-q', 330); check(`${dev}: with the keyboard up, the tag search is above it`, !v, v); }
  check(`${dev}: save sheet fits with the keyboard up`, !(await fits()).length, (await fits()).join(' | '));
  await shot('4-keyboard');
  await p.keyboard.press('Enter'); await sleep(150);
  const now = await p.$$eval('.tc-chip', (e) => e.map((x) => x.dataset.t));
  check(`${dev}: chips = picked − English + Folk + new`, now.join('|') === `Les Miserables|Musical|Folk|${fresh}`, now.join('|'));
  await p.click('#sv-save'); await sleep(700);
  const post = posts.at(-1) || {};
  check(`${dev}: saved with the text and the chosen tags`, post.kind === 'chords' && post.text?.trim().length > 50 && post.tags?.join('|') === now.join('|') && post.source === 'ultimate-guitar', JSON.stringify({ ...post, text: post.text?.length }));
  check(`${dev}: sheet closed after Save`, !(await p.$('.sv-sheet')));
  const got = await (await fetch(BASE + `api/items/${post.id}`)).json();
  check(`${dev}: the Mac kept the chart with its text`, got.text?.trim().length > 50 && got.tags?.length === now.length, JSON.stringify({ id: post.id, text: got.text?.length, detail: got.detail }));
  saved.push(post.id);
  // next device starts clean: this copy goes to the Trash (so it is not "the same song" with its new tags)
  await fetch(BASE + 'api/items/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [post.id] }) });
  await p.close();
}
// what the Mac kept: every chart saved here has its text
const items = [...await (await fetch(BASE + 'api/items?kind=chords')).json(), ...await (await fetch(BASE + 'api/items?kind=chords&deleted=true')).json()];
const empty = items.filter((x) => x.source !== 'pasted' && !String(x.text || '').trim());
check('server: no chord chart saved without text', saved.length === DEVICES.length && !empty.length, empty.map((x) => x.id).join());
check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
