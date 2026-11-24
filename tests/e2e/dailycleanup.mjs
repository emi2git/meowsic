// Activities: 24 h Undo window and the daily clean-up, against a TEST server (BASE, a temp data folder; never the real
// library). DB = that server's meowsic.db (to make one row 25 h old). A fresh change shows "Can undo until … left";
// a row older than 24 h shows the small Final badge and no Undo; the server refuses it (409 final); "Clean up now…"
// shows a dry run (counts, MB) and deleting nothing until asked; iPad Pro 13 and iPhone Air.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:5317/';
const DB = process.env.DB;
if (!DB || /Documents\/Meowsic/.test(DB)) { console.error('DB must be the test server\'s temp meowsic.db'); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();
const errs = [];
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);
const rowOf = (page, title) => page.evaluate((t) => {
  const r = [...document.querySelectorAll('#ac tr.ac-row')].find((x) => x.querySelector('.ac-title')?.textContent === t);
  if (!r) return null;
  const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
  const finals = [...r.querySelectorAll('.st-final')].filter((e) => vis(e.parentElement) && vis(e));
  return { text: r.textContent.replace(/\s+/g, ' '), btn: r.querySelector('[data-act]')?.textContent || '', final: finals.length,
    badge: finals[0] && { h: finals[0].getBoundingClientRect().height, w: finals[0].getBoundingClientRect().width } };
}, title);

for (const [name, vp] of [['iPad Pro 13', IPAD], ['iPhone Air', PHONE]]) {
  console.log(name);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  const oldT = `Old ${stamp} ${name}`, newT = `New ${stamp} ${name}`;
  const a = await (await send('POST', '/items', { kind: 'chords', title: 'x1', text: 'A' })).json();
  await send('PATCH', `/items/${a.id}`, { title: oldT });
  const oldRow = (await (await fetch(BASE + 'api/activity')).json()).find((x) => x.type === 'edit' && x.title === oldT);
  sql(`UPDATE activity SET at = at - ${25 * 3600 * 1000} WHERE id = '${oldRow.id}'`);  // 25 h old (so the next edit is a row of its own)
  const c = await (await send('POST', '/items', { kind: 'chords', title: 'x2', text: 'A' })).json();
  await send('PATCH', `/items/${c.id}`, { title: newT });
  await page.goto(BASE + '#/activities', { waitUntil: 'networkidle0' }); await sleep(700);
  const o = await rowOf(page, oldT), n = await rowOf(page, newT);
  check('old row shows the Final badge', o?.final === 1, JSON.stringify(o));
  check('Final badge is small', o?.badge && o.badge.h < 24 && o.badge.w < 80, JSON.stringify(o?.badge));
  check('old row has no Undo button', o && !o.btn, o?.btn);
  check('fresh row: Can undo until … left', /Can undo until .*(h|min) left/.test(n?.text || ''), n?.text);
  check('fresh row keeps Undo', n?.btn === 'Undo', n?.btn);
  const r = await send('POST', `/activity/${oldRow.id}/undo`, {});
  const j = await r.json();
  check('server refuses undo after 24 h (409 final)', r.status === 409 && j.detail?.reason === 'final' && /24 hours/.test(j.detail.message), JSON.stringify(j));
  // Can undo filter hides the Final row
  await page.click('#ac-f [data-f="undo"]'); await sleep(200);
  check('Can undo filter: Final row hidden, fresh row shown', !(await rowOf(page, oldT)) && !!(await rowOf(page, newT)));
  await page.click('#ac-f [data-f="all"]'); await sleep(200);
  // Clean up now: dry run first, Cancel changes nothing
  const before = sql('SELECT COUNT(*) FROM activity WHERE final_at IS NOT NULL');
  await page.click('#ac-clean'); await sleep(600);
  const sheet = await page.$eval('.modal', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  check('Clean up now shows a dry run with counts and MB', /Dry run/.test(sheet) && /MB/.test(sheet) && /become Final/.test(sheet), sheet);
  check('dry run counts the 25 h old row', /^.*?\b[1-9]\d* activit/.test(sheet), sheet);
  await page.click('.modal [data-close]'); await sleep(200);
  check('Cancel: nothing changed', sql('SELECT COUNT(*) FROM activity WHERE final_at IS NOT NULL') === before);
  await page.click('#ac-clean'); await sleep(600);
  await page.click('.modal [data-ok]'); await sleep(900);
  const toast = await page.$eval('#toast', (e) => e.textContent).catch(() => '');
  check('run: toast says what was freed', /Cleaned up: \d+ files? deleted, [\d.]+ MB freed/.test(toast), toast);
  check('run: old row stored Final', sql(`SELECT final_at IS NOT NULL FROM activity WHERE id='${oldRow.id}'`) === '1');
  const cl = await rowOf(page, (await (await fetch(BASE + 'api/activity')).json()).find((x) => x.type === 'cleanup')?.title);
  check('clean-up row listed, no Undo', cl && /Daily clean-up/.test(cl.text) && !cl.btn, JSON.stringify(cl));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check('no sideways scroll', !overflow);
  await page.screenshot({ path: `${process.env.SHOTS || '/tmp'}/dailycleanup-${name.replace(/\W+/g, '-')}.png` });
  await page.close();
}
check('no page errors', !errs.length, errs.join('\n'));
await b.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
