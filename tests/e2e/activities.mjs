// Activities page against a test server (BASE, default :5190). Never the real library.
// rename → Undo restores the title; a tag batch → one Undo takes it all back; Stop on a running transcription;
// rolled-back rows stay, struck through ("Rolled back …"); filter chips; iPad Pro 13 and iPhone Air.
// CLIP = a short audio file for the running job (default: the scratchpad's clip.wav).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const CLIP = process.env.CLIP || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/clip.wav';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const newPage = async (vp) => {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  return p;
};
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }; // iPad Pro 13"
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }; // iPhone Air
const stamp = Date.now().toString(36);

const rowOf = (page, title) => page.evaluate((t) => {
  const r = [...document.querySelectorAll('#ac tr.ac-row')].find((x) => x.querySelector('.ac-title')?.textContent === t);
  return r && { id: r.dataset.id, undone: r.classList.contains('undone'), text: r.textContent.replace(/\s+/g, ' '), btn: r.querySelector('[data-act]')?.textContent || '',
    strike: getComputedStyle(r.querySelector('.ac-title')).textDecorationLine };
}, title);
const waitRow = async (page, title, cond = () => true, ms = 8000) => {
  const end = Date.now() + ms; let r;
  while (Date.now() < end) { r = await rowOf(page, title); if (r && cond(r)) return r; await sleep(150); }
  return r;
};
const tapUndo = async (page, id, okLabel) => {
  await page.click(`#ac [data-act][data-id="${id}"]`); await sleep(250);
  const sheet = await page.$eval('.modal', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  await page.click('.modal [data-ok]'); await sleep(200);
  return sheet;
};
const toastText = (page) => page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent)).catch(() => '');

for (const [name, vp] of [['iPad Pro 13', IPAD], ['iPhone Air', PHONE]]) {
  console.log(name);
  const page = await newPage(vp);
  // ---- rename → Undo restores the title ----
  const old = `Act test ${stamp} ${name}`, nu = `${old} renamed`;
  const it = await send('POST', '/items', { kind: 'chords', title: old, text: 'A[G]mazing', tags: ['Folk'] });
  await send('PATCH', `/items/${it.id}`, { title: nu }); // the same request the Rename action sends
  await page.goto(BASE + '#/activities', { waitUntil: 'networkidle0' }); await sleep(600);
  check('page is called Activities', (await page.$eval('h1', (e) => e.textContent)) === 'Activities');
  if (vp === PHONE) {
    await page.click('#tab-more'); await sleep(200);
    check('iPhone Utilities menu says Activities, not Logs', await page.evaluate(() => { const t = document.querySelector('.menu')?.textContent || ''; return t.includes('Activities') && !t.includes('Logs'); }));
    await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelector('.menu')?.remove());
  } else check('left bar says Activities, not Logs', await page.$eval('#side', (e) => e.textContent.includes('Activities') && !/\bLogs\b/.test(e.textContent)));
  let r = await waitRow(page, nu);
  check('rename row has Undo', r?.btn === 'Undo', JSON.stringify(r));
  const sh = await tapUndo(page, r.id);
  check('confirm sheet says what is rolled back', sh.includes(`title back to “${old}”`), sh);
  r = await waitRow(page, nu, (x) => x.undone);
  check('rename undone: title restored', (await api('/items/' + it.id)).title === old);
  check('row kept, struck through, "Rolled back"', r?.undone && r.strike.includes('line-through') && /Rolled back/.test(r.text) && !r.btn, JSON.stringify(r));
  check('a "Rolled back: …" row was added', (await page.$eval('#ac', (e) => e.textContent)).includes(`Rolled back: ${nu}`));
  check('toast says rolled back', /Rolled back 1 change/.test(await toastText(page)), await toastText(page));

  // ---- tag batch (Make tags sends one act id for every tag) → Undo ----
  const a2 = await send('POST', '/items', { kind: 'chords', title: `${old} B`, text: 'x' });
  const actId = 'act-e2e' + stamp + (vp === PHONE ? 'p' : 'i');
  const batch = `Tag batch ${stamp} ${name}`;
  await send('POST', '/tags/set', { ids: [it.id, a2.id], add: ['E2E easy'], act: { id: actId, type: 'make-tags', title: batch } });
  await send('POST', '/tags/set', { ids: [a2.id], add: ['E2E kids'], act: { id: actId, type: 'make-tags', title: batch } });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
  await page.click('#ac-f [data-f="undo"]'); await sleep(200);
  r = await waitRow(page, batch);
  check('"Can undo" shows the tag batch, one row', r?.btn === 'Undo' && (await page.$$eval('#ac .ac-title', (ts, b) => ts.filter((x) => x.textContent === b).length, batch)) === 1);
  check('"Can undo" hides rows that cannot be undone', !(await page.$$eval('#ac tr.ac-row', (rs) => rs.some((x) => x.classList.contains('undone')))));
  await tapUndo(page, r.id);
  await waitRow(page, batch, (x) => x.undone);
  const t1 = (await api('/items/' + it.id)).tags, t2 = (await api('/items/' + a2.id)).tags;
  check('tag batch undone on both items', t1.join() === 'Folk' && t2.length === 0, JSON.stringify([t1, t2]));
  await page.click('#ac-f [data-f="all"]'); await sleep(200);
  r = await rowOf(page, batch);
  check('undone tag batch shown struck through under All', r?.undone && r.strike.includes('line-through'));
  // already rolled back: the Mac refuses
  const again = await fetch(`${BASE}api/activity/${actId}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('second undo refused (409)', again.status === 409 && /Already rolled back/.test((await again.json()).detail.message));

  // ---- a change made later: conflict → "Undo anyway" ----
  const c3 = await send('POST', '/items', { kind: 'chords', title: `${old} C`, text: 'x' });
  await send('PATCH', `/items/${c3.id}`, { key: 'G' });
  await sleep(3200); // (quick edits share a row)
  await send('PATCH', `/items/${c3.id}`, { key: 'A' });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
  const rows = await page.$$eval('#ac tr.ac-row', (rs) => rs.map((x) => ({ id: x.dataset.id, t: x.textContent })));
  const first = rows.filter((x) => x.t.includes(`${old} C`) && x.t.includes('key —'))[0] || rows.filter((x) => x.t.includes(`${old} C`)).pop();
  await page.click(`#ac [data-act][data-id="${first.id}"]`); await sleep(250); await page.click('.modal [data-ok]'); await sleep(500);
  const conflict = await page.$eval('.modal', (e) => e.textContent).catch(() => '');
  check('later change → "Changed since" sheet with Undo anyway', /Changed since/.test(conflict) && /Undo anyway/.test(conflict), conflict);
  await page.click('.modal [data-ok]'); await sleep(800);
  check('Undo anyway put the old key back', (await api('/items/' + c3.id)).key === '');

  // ---- Stop on a running job ----
  if (fs.existsSync(CLIP)) {
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(CLIP)]), 'clip.wav'); fd.append('title', `Stop me ${stamp} ${name}`); fd.append('outputs', 'original');
    const job = await (await fetch(BASE + 'api/jobs/upload', { method: 'POST', body: fd })).json();
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
    await page.click('#ac-f [data-f="jobs"]'); await sleep(200);
    r = await waitRow(page, job.title, (x) => x.btn === 'Stop');
    check('running job shows Stop', r?.btn === 'Stop', JSON.stringify(r));
    const s2 = await tapUndo(page, job.id);
    check('Stop sheet explains', /cancelled/.test(s2), s2);
    r = await waitRow(page, job.title, (x) => x.undone);
    const j = (await api('/jobs')).find((x) => x.id === job.id);
    check('job stopped (cancelled) and row marked rolled back', j.status === 'cancelled' && r?.undone && /Rolled back/.test(r.text), JSON.stringify([j.status, r]));
    check('no Stop / Undo on it any more', !r?.btn);
  } else console.log('  (skip Stop: no clip at', CLIP + ')');

  // ---- layout: nothing wider than the screen, buttons big enough ----
  await page.click('#ac-f [data-f="all"]'); await sleep(200);
  const lay = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth,
    btn: Math.min(...[...document.querySelectorAll('#ac [data-act]')].map((x) => x.getBoundingClientRect().height)) }));
  check('no sideways scroll', lay.sw <= lay.w + 1, JSON.stringify(lay));
  check('Undo buttons ≥ 36 px tall', !isFinite(lay.btn) || lay.btn >= 36, JSON.stringify(lay));
  await page.screenshot({ path: `/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/ac0c/activities-${vp === PHONE ? 'phone' : 'ipad'}.png` });
  await page.close();
}

console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
