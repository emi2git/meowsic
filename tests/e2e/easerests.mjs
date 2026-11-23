// Ease rests (score ⋯ → "Ease rests…") against a test server (BASE, default :5190, a scratchpad copy of the data —
// never the real library). ID = a score transcribed from YouTube (default "Home NDP" m-b6xs990), AI = an AI lead sheet.
// Per device: the action is offered for the transcription only; the panel previews Light / Strong in the score
// (fewer rests, every bar full), Play works on the preview; Mac saves into this score (history + Activities undo
// puts it back), iPad saves as a new score (tagged "Rests eased"; then trashed), iPhone cancels (score unchanged).
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/scorekids';
const ID = process.env.ID || 'm-b6xs990', AI = process.env.AI || 'm-h7rud59';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const rests = (x) => (x.match(/<rest\b/g) || []).length;
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

// every voice of every bar = the time signature
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

const menuItems = async (page) => {
  await page.click('#it-more'); await sleep(400);
  const t = await page.$$eval('.menu button, .sheet button', (bs) => bs.map((x) => x.textContent.trim()));
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5); await sleep(300);
  return t;
};
const openEase = async (page) => {
  await page.click('#it-more'); await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.menu button, .sheet button')].find((x) => x.textContent.trim().startsWith('Ease rests'))?.click());
  await sleep(2500);
};
const count = (page) => page.$eval('#er-count', (e) => e.textContent).catch(() => '');

async function run(name, vp, how) {
  console.log(`\n${name}`);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|409|favicon/.test(m.text())) errs.push(`${name}: ${m.text()}`); });
  const x0 = await xmlOf(ID), r0 = rests(x0);
  await page.goto(`${BASE}#/item/${AI}`, { waitUntil: 'networkidle0' }); await sleep(2500);
  check('AI lead sheet: no "Ease rests…"', !(await menuItems(page)).some((t) => t.startsWith('Ease rests')));
  await page.goto(`${BASE}#/item/${ID}`, { waitUntil: 'networkidle0' }); await sleep(3000);
  check('transcription: "Ease rests…" in ⋯', (await menuItems(page)).some((t) => t.startsWith('Ease rests')));
  await openEase(page);
  let c = await count(page);
  const light = await api(`/items/${ID}/easerests/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strength: 'light' }) });
  check('panel: Light preview counts', c === `${r0} → ${light.after} rests` && light.after < r0, c);
  check('preview: every bar full', barsFull(light.xml));
  const drawnRests = await page.evaluate(() => document.querySelectorAll('#osmd .vf-stavenote').length);
  check('preview is drawn in the score', drawnRests > 0 && !!(await page.$('.ease-panel')));
  await page.evaluate(() => document.querySelector('.ease-panel [data-s="strong"]').click()); await sleep(2500);
  c = await count(page);
  const strong = await api(`/items/${ID}/easerests/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strength: 'strong' }) });
  check('Strong: fewer rests still', c === `${r0} → ${strong.after} rests` && strong.after < light.after, c);
  check('Strong preview: every bar full', barsFull(strong.xml));
  await page.click('.ease-panel .er-play'); await sleep(1800);
  check('Play (in the panel) works on the preview', +(await page.$eval('#sc-pos', (e) => e.value)) > 0.2);
  await page.click('.ease-panel .er-play'); await sleep(200);
  await page.screenshot({ path: `${SHOTS}/easerests-${name}.png` });
  if (how === 'this') {
    await page.evaluate(() => document.querySelector('.ease-panel [data-a="this"]').click()); await sleep(3000);
    const x1 = await xmlOf(ID);
    check('saved into this score: the file has the Strong result', rests(x1) === strong.after && barsFull(x1) && !(await page.$('.ease-panel')));
    const acts = await api('/activity');
    const row = acts.find((a) => a.type === 'ease-rests' && !a.undoneAt);
    check('Activities row, undoable', row && row.action === 'undo', JSON.stringify(row));
    const u = await fetch(`${BASE}api/activity/${row.id}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('Undo puts the score back', u.ok && (await xmlOf(ID)) === x0);
  } else if (how === 'new') {
    await page.evaluate(() => document.querySelector('.ease-panel [data-a="new"]').click()); await sleep(3500);
    const id = decodeURIComponent((page.url().match(/#\/item\/([^?]+)/) || [])[1] || '');
    const it = id && await api(`/items/${id}`);
    check('saved as a new score: opens it, tagged "Rests eased"', id && id !== ID && it.tags?.includes('Rests eased'), page.url());
    check('the new score has the Strong result; this one is unchanged', rests(await xmlOf(id)) === strong.after && (await xmlOf(ID)) === x0);
    await fetch(`${BASE}api/items/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
  } else {
    await page.evaluate(() => document.querySelector('.ease-panel [data-a="cancel"]').click()); await sleep(2500);
    check('Cancel: panel closes, the score is unchanged', !(await page.$('.ease-panel')) && (await xmlOf(ID)) === x0);
  }
  await page.close();
}

await run('mac', MAC, 'this');
await run('ipad', IPAD, 'new');
await run('iphone', PHONE, 'cancel');
check('no page errors', !errs.length, errs.slice(0, 5).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
