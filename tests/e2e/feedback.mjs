// Feedback page (js/views/feedback.js) against a test server (BASE, default :5190) on a copy of the data —
// never the real library. Mac, iPad Pro 13 and iPhone Air: old #/feedback lands on Feedback, mic on the box,
// Submit → newest first, collapsed rows (time + status + first line), Edit (history kept), Remove (soft),
// Fixed / Won't fix (set by Claude) hide Edit / Remove and the Mac says 409, offline submit waits and is sent later.
// SHOTS = folder for screenshots.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/feedback';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const MAC = { width: 1280, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);
const rows = (page) => page.$$eval('#fb-list details.fb-item', (ds) => ds.map((d) => ({ id: d.dataset.id, open: d.open,
  when: d.querySelector('.fb-when')?.textContent, st: d.querySelector('.fb-st')?.textContent, first: d.querySelector('.fb-first')?.textContent,
  acts: [...d.querySelectorAll('.fb-acts button')].map((x) => x.textContent), wait: !!d.querySelector('.fb-wait') })));
const tap = async (page, sel) => { const el = await page.$(sel); if (!el) throw new Error('no ' + sel); await (page.viewport()?.hasTouch ? el.tap() : el.click()); };

for (const [name, vp, short] of [['Mac', MAC, 'mac'], ['iPad Pro 13', IPAD, 'ipad'], ['iPhone Air', PHONE, 'iphone']]) {
  console.log(name);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${short}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/409|503|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errs.push(`${short}: ${m.text()}`));
  await page.goto(BASE + '#/feedback', { waitUntil: 'networkidle0' }); await sleep(500);
  check('#/feedback lands on #/developer', (await page.evaluate(() => location.hash)) === '#/developer');
  check('page is Feedback, old-app card gone', (await page.$eval('h1', (e) => e.textContent)) === 'Feedback' && !(await page.$eval('#main', (e) => e.textContent)).includes('Bring in the old apps'));
  if (vp === PHONE) {
    await page.click('#tab-more'); await sleep(200);
    check('iPhone More menu has Feedback', (await page.$eval('.menu', (e) => e.textContent)).includes('Feedback'));
    await page.evaluate(() => document.querySelector('.menu')?.remove());
  } else check('left bar Developer section has Feedback, highlighted', await page.$eval('#side a[href="#/developer"]', (e) => e.classList.contains('on')));
  check('mic on the feedback box', await page.evaluate(() => { const m = document.querySelector('#fb-text + .ti-mic'); return !!m && !m.hidden; }));
  check('Submit off while empty', await page.$eval('#fb-send', (e) => e.disabled));

  // ---- submit two: newest first ----
  const t1 = `Older note ${stamp} ${short}\nsecond line of detail`, t2 = `Newer note ${stamp} ${short}\nmore`;
  for (const t of [t1, t2]) {
    await page.click('#fb-text'); await page.keyboard.type(t, { delay: 0 }); await sleep(50);
    await tap(page, '#fb-send'); await sleep(500);
  }
  let r = await rows(page);
  const mine = r.filter((x) => x.first?.includes(`${stamp} ${short}`));
  check('both listed, newest first', mine.length === 2 && mine[0].first === `Newer note ${stamp} ${short}` && mine[1].first === `Older note ${stamp} ${short}`, JSON.stringify(mine));
  check('row header: time + New + first line, collapsed', mine[0].when && mine[0].st === 'New' && !mine[0].open);
  check('box cleared after Submit', (await page.$eval('#fb-text', (e) => e.value)) === '');
  const srv = (await api('/feedback')).filter((x) => x.text.includes(`${stamp} ${short}`));
  check('saved on the Mac with device', srv.length === 2 && srv[0].text === t2 && srv[0].device === name.split(' ')[0], JSON.stringify(srv.map((x) => x.device)));
  const [newer, older] = mine;
  await page.screenshot({ path: `${SHOTS}/${short}-1-list.png` });

  // ---- expand → full text, Edit → Save ----
  await tap(page, `details[data-id="${older.id}"] > summary`); await sleep(200);
  check('expanded shows full text + Edit / Remove', (await page.$eval(`details[data-id="${older.id}"] .fb-text`, (e) => e.textContent)) === t1 && (await rows(page)).find((x) => x.id === older.id).acts.join() === 'Edit,Remove');
  await page.screenshot({ path: `${SHOTS}/${short}-2-open.png` });
  await tap(page, `details[data-id="${older.id}"] [data-a="edit"]`); await sleep(200);
  check('edit box has mic', await page.evaluate((id) => { const m = document.querySelector(`details[data-id="${id}"] .fb-edit + .ti-mic`); return !!m && !m.hidden; }, older.id));
  await page.$eval(`details[data-id="${older.id}"] .fb-edit`, (e) => { e.value = ''; });
  await page.type(`details[data-id="${older.id}"] .fb-edit`, `Edited note ${stamp} ${short}`);
  await page.screenshot({ path: `${SHOTS}/${short}-3-edit.png` });
  await tap(page, `details[data-id="${older.id}"] [data-a="save"]`); await sleep(500);
  const ed = await api('/feedback/' + older.id);
  check('edit saved, old text in history', ed.text === `Edited note ${stamp} ${short}` && ed.history.some((h) => h.change === 'edit' && h.text === t1));
  check('list shows the edit', (await rows(page)).find((x) => x.id === older.id)?.first === `Edited note ${stamp} ${short}`);

  // ---- Remove (soft) ----
  await tap(page, `details[data-id="${older.id}"] [data-a="remove"]`); await sleep(250);
  await page.click('.modal [data-ok]'); await sleep(500);
  check('removed from the list', !(await rows(page)).some((x) => x.id === older.id));
  check('kept on the Mac with removedAt', !!(await api('/feedback?removed=1')).find((x) => x.id === older.id)?.removedAt && !(await api('/feedback')).some((x) => x.id === older.id));

  // ---- Claude: In progress → Fixed ----
  await send('PATCH', `/feedback/${newer.id}`, { status: 'in_progress' });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  check('In progress badge, still editable', await page.$eval(`details[data-id="${newer.id}"] .fb-st`, (e) => e.textContent) === 'In progress');
  await send('PATCH', `/feedback/${newer.id}`, { status: 'fixed', fixNote: 'Done in e2e' });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  await tap(page, `details[data-id="${newer.id}"] > summary`); await sleep(200);
  r = (await rows(page)).find((x) => x.id === newer.id);
  check('Fixed: badge, no Edit / Remove', r.st === 'Fixed' && r.acts.length === 0, JSON.stringify(r));
  check('fix note shown', (await page.$eval(`details[data-id="${newer.id}"] .fb-fix`, (e) => e.textContent)).includes('Done in e2e'));
  check('Mac refuses edit / remove of Fixed (409)', (await send('PATCH', `/feedback/${newer.id}`, { text: 'x' })).status === 409 && (await send('DELETE', `/feedback/${newer.id}`)).status === 409);
  await page.screenshot({ path: `${SHOTS}/${short}-4-fixed.png` });

  // ---- layout ----
  const lay = await page.evaluate(() => {
    const big = [...document.querySelectorAll('#fb-send, .fb-acts button, .fb-item > summary')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height);
    return { sw: document.documentElement.scrollWidth, mw: document.querySelector('#main').scrollWidth - document.querySelector('#main').clientWidth, w: innerWidth, min: Math.min(...big), theme: getComputedStyle(document.body).backgroundColor };
  });
  check('no sideways scroll', lay.sw <= lay.w && lay.mw <= 0, JSON.stringify(lay));
  if (vp.hasTouch) check('touch targets ≥ 44px', lay.min >= 44, JSON.stringify(lay));
  check('light theme by default', lay.theme === 'rgb(255, 255, 255)', lay.theme);

  // ---- offline: submit waits, sent when the Mac is back (iPad + iPhone) ----
  if (vp.hasTouch) {
    await page.setOfflineMode(true);
    const t3 = `Offline note ${stamp} ${short}`;
    await page.click('#fb-text'); await page.keyboard.type(t3); await tap(page, '#fb-send'); await sleep(1500);
    r = (await rows(page)).find((x) => x.first === t3);
    check('offline: listed, "Waiting to send"', !!r?.wait, JSON.stringify(r));
    check('offline: not on the Mac yet', !(await api('/feedback')).some((x) => x.text === t3));
    await page.screenshot({ path: `${SHOTS}/${short}-5-offline.png` });
    await page.setOfflineMode(false);
    await page.evaluate(() => dispatchEvent(new Event('online'))); await sleep(2500);
    const got = (await api('/feedback')).filter((x) => x.text === t3);
    check('back online: sent once', got.length === 1, JSON.stringify(got));
    r = (await rows(page)).find((x) => x.first === t3);
    check('back online: no longer waiting', r && !r.wait, JSON.stringify(r));
  }
  await page.close();
}
check('no page errors', !errs.length, errs.join('\n'));
await b.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
