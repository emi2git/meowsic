// Manage library → Complete info against a test server (BASE, default :5361, a temp data folder). Never the real library.
// Per device (Mac, iPad Pro 13, iPhone Air), sheets with no Key / Version:
//   · the tab shows the count; one card at a time with page 1 big (tap: zoom, tap: back)
//   · "Canon In D": D is pre-selected from the title (dashed); one tap on Lead saves both and the next card comes
//   · tap G, then Piano → saved, next card; a typed key ("f# minor") is stored as F#m, a wrong one is refused
//   · Accompaniment is a version; Skip keeps it for later, Don't know hides it (kept on the Mac), Show again
//   · every save is the normal PATCH: an Activities row whose Undo takes it back (Mac)
//   · Mac keys: 1 = Lead, type "eb" + Enter = E♭
// Screenshots in SHOTS.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5361/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/completeinfo';
fs.mkdirSync(SHOTS, { recursive: true });
const health = await fetch(BASE + 'api/health').then((r) => r.json());
if (!health.ok || /Documents\/Meowsic/.test(health.data)) { console.log('refusing: not a test server', health); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const item = (id) => api('/items/' + id);
const waitItem = async (id, cond, ms = 4000) => { const end = Date.now() + ms; let it; while (Date.now() < end) { it = await item(id); if (cond(it)) return it; await sleep(150); } return it; };

// a sheet page: title, staves (grand staff or single lines) with a key signature of `sharps` (#) or flats (b)
const upload = (page, title, { grand = false, sig = '' } = {}) => page.evaluate(async (title, grand, sig) => {
  const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000'; g.strokeStyle = '#000';
  g.font = 'bold 56px serif'; g.textAlign = 'center'; g.fillText(title, 620, 130);
  g.font = 'italic 28px serif'; g.textAlign = 'right'; g.fillText('Music by Somebody', 1150, 190);
  let y = 270;
  const staff = (y0) => { g.lineWidth = 2; for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(90, y0 + k * 16); g.lineTo(1150, y0 + k * 16); g.stroke(); }
    g.font = '64px serif'; g.textAlign = 'left'; [...sig].forEach((s, i) => g.fillText(s === '#' ? '♯' : '♭', 150 + i * 26, y0 + 40 - i * 8));
    for (let n = 0; n < 14; n++) { const x = 260 + n * 64, yy = y0 + ((n * 7) % 9) * 8; g.beginPath(); g.ellipse(x, yy, 11, 8, -0.4, 0, 7); g.fill(); g.beginPath(); g.moveTo(x + 10, yy); g.lineTo(x + 10, yy - 50); g.stroke(); } };
  for (let s = 0; s < (grand ? 5 : 8); s++) {
    staff(y);
    if (grand) { staff(y + 120); g.lineWidth = 4; g.beginPath(); g.moveTo(90, y); g.lineTo(90, y + 184); g.stroke(); y += 290; } else y += 180;
  }
  const fd = new FormData(); fd.append('title', title); fd.append('artist', 'E2E');
  fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), 'p1.png');
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, grand, sig);

const cardTitle = (page) => page.$eval('#ci-title', (e) => e.textContent.trim()).catch(() => null);
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('#ci-title')?.textContent.trim() || null,
  keyOn: [...document.querySelectorAll('.ci-key.on')].map((e) => e.dataset.key + (e.classList.contains('ai') ? '*' : '')),
  verOn: [...document.querySelectorAll('.ci-ver.on')].map((e) => e.dataset.ver + (e.classList.contains('ai') ? '*' : '')),
  badge: document.querySelector('#cu-ninfo')?.textContent || '',
  tabOn: document.querySelector('.cu-tabs a.on')?.dataset.tab,
  img: (() => { const i = document.querySelector('#ci-pic img'); return i ? { ok: i.complete && i.naturalWidth > 0, w: i.getBoundingClientRect().width, h: document.querySelector('#ci-pic').getBoundingClientRect().height } : null; })(),
  next: document.querySelector('#ci-next')?.disabled,
  empty: !!document.querySelector('.ci-empty'),
  sug: document.querySelector('.ci-sug')?.textContent || '',
  overflowX: document.documentElement.scrollWidth > innerWidth + 1,
  actsVisible: (() => { const a = document.querySelector('.ci-acts'); if (!a) return null; const r = a.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })(),
}));

for (const [name, vp, dev] of [['Mac', MAC, 'mac'], ['iPad Pro 13', IPAD, 'ipad'], ['iPhone Air', PHONE, 'iphone']]) {
  console.log(name);
  const page = await b.newPage(); await page.setViewport(vp);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (vp.hasTouch) await page.tap(sel); else await page.click(sel); await sleep(250); };
  await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(600);
  const T = (n, s) => `CI-${dev} ${n} ${s}`;
  const done = await upload(page, T(0, 'Complete'));
  await send('PATCH', '/items/' + done.id, { key: 'C', version: 'lead' });
  const s1 = await upload(page, T(1, 'Canon In D'), { sig: '##' });
  const s2 = await upload(page, T(2, 'Song'), { grand: true, sig: '#' });
  const s3 = await upload(page, T(3, 'Other'), { grand: true, sig: '###' });
  const s4 = dev === 'mac' ? await upload(page, T(4, 'Keys'), { sig: 'bbb' }) : null;
  const s5 = await upload(page, T(5, 'Hard'));
  const q0 = await api('/completeinfo');
  check('queue: only the ones without key / version, title order', JSON.stringify(q0.items.map((x) => x.id)) === JSON.stringify([s1, s2, s3, s4, s5].filter(Boolean).map((x) => x.id)), JSON.stringify(q0.items.map((x) => x.title)));
  check('suggestion from the title: D', q0.items[0]?.suggest?.key?.value === 'D', JSON.stringify(q0.items[0]?.suggest));

  await page.goto(BASE + '#/manage/info', { waitUntil: 'networkidle0' }); await sleep(900);
  let s = await state(page);
  check('Complete info tab is on, badge = count', s.tabOn === 'info' && s.badge === String(q0.count), JSON.stringify(s));
  check('first card: Canon In D, page 1 shown big', s.title === T(1, 'Canon In D') && s.img?.ok && s.img.w > (dev === 'iphone' ? 350 : 500), JSON.stringify(s.img));
  check('the AI guess D is pre-selected (dashed), Suggested shown', JSON.stringify(s.keyOn) === '["D*"]' && /Suggested: D/.test(s.sug), JSON.stringify(s));
  check('no sideways scroll; actions on screen', !s.overflowX && s.actsVisible, JSON.stringify(s));
  await page.screenshot({ path: `${SHOTS}/${dev}-card.png` });

  // zoom: tap the page, tap again
  await tap('#ci-pic'); await sleep(200);
  check('tap the page → zoomed', await page.$eval('#ci-card', (e) => e.classList.contains('zoomed')));
  await page.screenshot({ path: `${SHOTS}/${dev}-zoom.png` });
  await tap('#ci-pic'); await sleep(200);
  check('tap again → back', !(await page.$eval('#ci-card', (e) => e.classList.contains('zoomed'))));

  // one tap on Lead: the suggested D is saved too, next card
  await tap('[data-ver="lead"]'); await sleep(700);
  let it = await waitItem(s1.id, (x) => x.version === 'lead' && x.key === 'D');
  check('Lead tap saves version lead + key D', it.version === 'lead' && it.key === 'D', JSON.stringify([it.key, it.version]));
  s = await state(page);
  check('next card comes by itself, badge one less', s.title === T(2, 'Song') && s.badge === String(q0.count - 1), JSON.stringify(s));

  // G then Piano
  await tap('[data-key="G"]');
  s = await state(page);
  check('G picked (saved), card stays until the version', s.title === T(2, 'Song') && JSON.stringify(s.keyOn) === '["G"]' && s.next === true, JSON.stringify(s));
  it = await waitItem(s2.id, (x) => x.key === 'G');
  check('key G saved at once', it.key === 'G');
  await page.screenshot({ path: `${SHOTS}/${dev}-picked.png` });
  await tap('[data-ver="piano"]'); await sleep(700);
  it = await waitItem(s2.id, (x) => x.version === 'piano');
  check('Piano saved', it.version === 'piano' && it.key === 'G');
  check('third card', (await cardTitle(page)) === T(3, 'Other'));

  // a typed key: wrong, then "f# minor" → F#m; Accompaniment
  await tap('#ci-other'); await page.type('#ci-other', 'H7'); await tap('#ci-set');
  check('a wrong key is refused with a message', /not a key/.test(await page.$eval('.ci-err', (e) => e.textContent).catch(() => '')));
  await page.$eval('#ci-other', (e) => (e.value = '')); await tap('#ci-other'); await page.type('#ci-other', 'f# minor'); await tap('#ci-set');
  it = await waitItem(s3.id, (x) => x.key === 'F#m');
  check('typed "f# minor" is stored as F#m', it.key === 'F#m', it.key);
  check('the box shows F♯m', (await page.$eval('#ci-other', (e) => e.value)) === 'F♯m');
  await tap('[data-ver="accomp"]'); await sleep(700);
  it = await waitItem(s3.id, (x) => x.version === 'accomp');
  check('Accompaniment saved as accomp', it.version === 'accomp');

  // Back: the last one again, its choices shown
  await tap('#ci-prev'); await sleep(200);
  s = await state(page);
  check('Back shows the last card with its choices', s.title === T(3, 'Other') && JSON.stringify(s.verOn) === '["accomp"]', JSON.stringify(s));
  await tap('#ci-next'); await sleep(300);

  if (dev === 'mac') {  // keys: 1 = Lead, "eb" + Enter = E♭
    check('Mac: the Keys card', (await cardTitle(page)) === T(4, 'Keys'));
    await page.keyboard.press('1'); await sleep(200);
    await page.keyboard.press('e'); await page.keyboard.type('b'); await page.keyboard.press('Enter'); await sleep(800);
    it = await waitItem(s4.id, (x) => x.key === 'Eb' && x.version === 'lead');
    check('Mac keys: 1 → Lead, eb + Enter → Eb', it.key === 'Eb' && it.version === 'lead', JSON.stringify([it.key, it.version]));
    // Activities: the edit has an Undo that takes it back
    const row = (await api('/activity')).find((r) => r.action === 'undo' && /Keys/.test(r.title || ''));
    check('Activities row for the edit', !!row, JSON.stringify((await api('/activity')).slice(0, 3)));
    if (row) {
      await send('POST', `/activity/${row.id}/undo`, {});
      it = await item(s4.id);
      check('its Undo clears key and version again', !it.key && !it.version, JSON.stringify([it.key, it.version]));
      check('…and it is back in the queue', (await api('/completeinfo')).items.some((x) => x.id === s4.id));
      await send('PUT', `/completeinfo/${s4.id}/mark`, { how: 'unknown' });  // out of the way
    }
  }

  // Hard: Skip (one left: it stays), Don't know → done screen, Show again
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
  check('Hard card', (await cardTitle(page)) === T(5, 'Hard'), await cardTitle(page));
  await tap('#ci-skip'); await sleep(400);
  const q1 = await api('/completeinfo');
  check('Skip is kept on the Mac', q1.items.find((x) => x.id === s5.id)?.skipped > 0);
  await tap('#ci-dunno'); await sleep(500);
  s = await state(page);
  check("Don't know → All done screen", s.empty, JSON.stringify(s));
  const q2 = await api('/completeinfo');
  check("Don't know hides it on the Mac", !q2.items.some((x) => x.id === s5.id) && q2.hidden >= 1 && q2.count === 0, JSON.stringify(q2));
  await page.screenshot({ path: `${SHOTS}/${dev}-done.png` });
  await tap('#ci-again'); await sleep(900);
  check('Show again brings the hidden ones back', /Hard|Keys/.test((await cardTitle(page)) || ''), await cardTitle(page));
  // leave this device's queue empty: Don't know for whatever is left
  for (let k = 0; k < 3 && (await cardTitle(page)); k++) { await tap('#ci-dunno'); await sleep(400); }
  check('the library list shows Accomp. for the accompaniment sheet', await (async () => {
    await page.goto(BASE + `#/library?kind=sheet`, { waitUntil: 'networkidle0' }); await sleep(700);
    return page.evaluate((t) => [...document.querySelectorAll('#lib-rows .row, #lib-rows tr')].some((r) => r.textContent.includes(t) && r.textContent.includes('Accomp.')), T(3, 'Other'));
  })());
  await page.close();
}
await send('POST', '/completeinfo/reset', { all: true });
check('no page errors', !errs.length, errs.join('\n'));
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
