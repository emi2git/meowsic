// Simple piano (score toolbar → Simple piano button) against a test server (BASE, default :5361, a scratchpad data
// folder — never the real library). ID = a score transcribed from YouTube (Home NDP), SHEET = a score read from a sheet.
// Per device: the button opens the menu (iPad / iPhone: a bottom sheet) with the source's defaults; the slider and
// the toggles redraw the preview live (fewer rests as the slider goes up, every bar full, a hand off = its notes gone);
// Play works on the preview; Mac saves into this score (history + Activities undo puts it back), iPad saves as a new
// "Simple piano" version (then trashed), iPhone closes with × (score unchanged).
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5361/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/smooth';
const ID = process.env.ID, SHEET = process.env.SHEET;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, body) => fetch(BASE + 'api' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const barsFull = (x) => {
  let div = 1, need = 4, ok = true;
  for (const m of x.split('<measure').slice(1)) {
    const dv = m.match(/<divisions>(\d+)<\/divisions>/); if (dv) div = +dv[1];
    const ts = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/); if (ts) need = (4 * ts[1]) / ts[2];
    const sum = {};
    for (const n of m.split('<note').slice(1)) {
      if (/<chord\s*\/>/.test(n) || /<grace\b/.test(n)) continue;
      const k = (n.match(/<staff>(\d+)/)?.[1] || '1') + '/' + (n.match(/<voice>(\d+)/)?.[1] || '1');
      sum[k] = (sum[k] || 0) + +(n.match(/<duration>(\d+)/)?.[1] || 0) / div;
    }
    if (Object.values(sum).some((v) => Math.abs(v - need) > 1e-6)) ok = false;
  }
  return ok;
};
const pitched = (x, staff) => x.split('<note').slice(1).filter((n) => /<pitch>/.test(n) && (n.match(/<staff>(\d+)/)?.[1] || '1') === staff).length;
const count = (page) => page.$eval('#sp-count', (e) => e.textContent).catch(() => '');
const settle = async (page, t = 15000) => { const end = Date.now() + t; await sleep(400); while (Date.now() < end && (await count(page)) === 'Working…') await sleep(150); await sleep(600); };
const settings = (page) => page.evaluate(() => Object.fromEntries([['level', +document.querySelector('#sp-level').value],
  ...[...document.querySelectorAll('.sp-panel [data-k]')].map((i) => [i.dataset.k, i.checked])]));
const setLevel = (page, v) => page.evaluate((v) => { const r = document.querySelector('#sp-level'); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const toggle = (page, k) => page.evaluate((k) => document.querySelector(`.sp-panel [data-k="${k}"]`).click(), k);

async function run(name, vp, how) {
  console.log(`\n${name}`);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|409|favicon/.test(m.text())) errs.push(`${name}: ${m.text()}`); });
  const x0 = await xmlOf(ID);
  if (name === 'mac') {  // a sheet's score starts as is
    await page.goto(`${BASE}#/item/${SHEET}`, { waitUntil: 'networkidle0' }); await sleep(2500);
    await page.click('#sc-simple'); await sleep(600); await settle(page);
    const s = await settings(page);
    check('sheet score: level 0, staccato / grace off, main note on', s.level === 0 && !s.staccato && !s.grace && s.main, JSON.stringify(s));
    await page.click('#sc-simple'); await sleep(800);
    check('the button closes the menu again', !(await page.$('.sp-panel')));
  }
  await page.goto(`${BASE}#/item/${ID}`, { waitUntil: 'networkidle0' }); await sleep(3000);
  check('Simple piano button on the score toolbar', !!(await page.$('#sc-simple')));
  const t0 = Date.now();
  await page.click('#sc-simple'); await sleep(300); await settle(page, 30000);
  const first = Date.now() - t0;
  const s = await settings(page);
  check('transcription defaults: level 60, remove staccato + grace on', s.level === 60 && s.staccato && s.grace && s.main && s.left && s.right, JSON.stringify(s));
  let p = await api(`/items/${ID}/simplepiano/preview`, s);
  let c = await count(page);
  check('menu shows the preview counts', c.startsWith(`Rests ${p.before.rests} → ${p.after.rests}`) && p.after.rests < p.before.rests, c);
  check('preview: every bar full', barsFull(p.xml));
  check('preview is drawn in the score', (await page.evaluate(() => document.querySelectorAll('#osmd .vf-stavenote').length)) > 0);
  await setLevel(page, 100); await settle(page);
  const p100 = await api(`/items/${ID}/simplepiano/preview`, await settings(page));
  c = await count(page);
  check('slider 100: fewer rests still, live', c.startsWith(`Rests ${p.before.rests} → ${p100.after.rests}`) && p100.after.rests < p.after.rests, c);
  check('slider 100: every bar full', barsFull(p100.xml));
  await setLevel(page, 0); await settle(page);
  const p0 = await api(`/items/${ID}/simplepiano/preview`, await settings(page));
  check('slider 0: rests as they were (only main note / staccato / grace)', p0.after.rests >= p.after.rests, `${p0.after.rests}`);
  await setLevel(page, 80); await settle(page);
  await toggle(page, 'left'); await settle(page);
  const pl = await api(`/items/${ID}/simplepiano/preview`, await settings(page));
  check('Left hand off: its notes go, the right hand stays', pitched(pl.xml, '2') === 0 && pitched(pl.xml, '1') > 0 && barsFull(pl.xml));
  await toggle(page, 'right'); await sleep(200);
  const both = await settings(page);
  check('turning off both hands is refused (the other comes back)', both.left && !both.right, JSON.stringify(both));
  await toggle(page, 'right'); await settle(page);
  await page.click('.sp-panel .sp-play'); await sleep(1800);
  check('Play (in the menu) works on the preview', +(await page.$eval('#sc-pos', (e) => e.value)) > 0.2);
  await page.click('.sp-panel .sp-play'); await sleep(300);
  await page.screenshot({ path: `${SHOTS}/simplepiano-${name}.png` });
  const fin = await settings(page);
  const want = await api(`/items/${ID}/simplepiano/preview`, fin);
  if (how === 'this') {
    await page.evaluate(() => document.querySelector('.sp-panel [data-a="this"]').click()); await sleep(3500);
    const x1 = await xmlOf(ID);
    check('saved into this score: the file is the preview', x1 === want.xml && barsFull(x1) && !(await page.$('.sp-panel')));
    const row = (await api('/activity')).find((a) => a.type === 'simple-piano' && !a.undoneAt);
    check('Activities row, undoable', row && row.action === 'undo', JSON.stringify(row));
    const u = await fetch(`${BASE}api/activity/${row.id}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('Undo puts the score back', u.ok && (await xmlOf(ID)) === x0);
  } else if (how === 'new') {
    await page.evaluate(() => document.querySelector('.sp-panel [data-a="new"]').click()); await sleep(4000);
    const id = decodeURIComponent((page.url().match(/#\/item\/([^?]+)/) || [])[1] || '');
    const it = id && await api(`/items/${id}`);
    check('saved as a new "Simple piano" version: opens it', id && id !== ID && it.version === 'clear' && it.tags?.includes('Simple piano'), page.url());
    check('the new version has the preview; this one is unchanged', (await xmlOf(id)) === want.xml && (await xmlOf(ID)) === x0);
    await fetch(`${BASE}api/items/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
  } else {
    await page.evaluate(() => document.querySelector('.sp-panel [data-a="cancel"]').click()); await sleep(2500);
    check('× closes, the score is unchanged', !(await page.$('.sp-panel')) && (await xmlOf(ID)) === x0);
  }
  console.log(`  (first preview with main note: ${first} ms)`);
  await page.close();
}

await run('mac', MAC, 'this');
await run('ipad', IPAD, 'new');
await run('iphone', PHONE, 'cancel');
check('no page errors', !errs.length, errs.slice(0, 5).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
