// Manage library → Complete info against a test server (BASE, default :5381, a temp data folder). Never the real library.
// Per device (Mac, iPad Pro 13 upright + across, iPhone Air; touch devices use real page.touchscreen.tap):
//   · the tab shows the count; page 1 is the WHOLE page fitted in its frame (aspect kept, inside, no scroll, as big
//     as the frame allows) on 3 cards in a row (tall and wide pages), never the last song's picture
//   · a slow page shows "Loading page 1…" first; a failed one shows Retry, and Retry loads it
//   · the AI guess is a dashed hint only; a tap on a version picks it and does NOT move on
//   · Save & next is off until Key and Version are both picked; rapid taps keep the last pick
//   · Save & next = ONE PATCH with both fields; a failing PATCH shows the error bar, its Retry saves
//   · a value the item already has counts as picked (only the missing one needs a tap)
//   · typed key ("f# minor" → F#m, a wrong one refused), Accompaniment, Back, Skip, Don't know, Show again
//   · Mac: 1 = Lead, "eb" + Enter = E♭, Enter = Save & next (only when on); Activities row + its Undo
// Screenshots in SHOTS.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5381/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/completeinfo2';
fs.mkdirSync(SHOTS, { recursive: true });
const health = await fetch(BASE + 'api/health').then((r) => r.json());
if (!health.ok || /Documents\/Meowsic/.test(health.data)) { console.log('refusing: not a test server', health); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = []; const RUN = Date.now().toString(36).slice(-4);
const DEVICES = [
  ['Mac', 'mac', { width: 1440, height: 900 }],
  ['iPad Pro 13 upright', 'ipad-portrait', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['iPad Pro 13 across', 'ipad-landscape', { width: 1376, height: 1032, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['iPhone Air', 'iphone', { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
];
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const item = (id) => api('/items/' + id);
const waitItem = async (id, cond, ms = 4000) => { const end = Date.now() + ms; let it; while (Date.now() < end) { it = await item(id); if (cond(it)) return it; await sleep(150); } return it; };

// a sheet page (w × h): title, staves (grand staff or single lines) with a key signature of sharps (#) or flats (b)
const upload = (page, title, { grand = false, sig = '', w = 1240, h = 1754 } = {}) => page.evaluate(async (title, grand, sig, W, H) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#000'; g.strokeStyle = '#000';
  g.font = 'bold 56px serif'; g.textAlign = 'center'; g.fillText(title, W / 2, 130);
  g.font = 'italic 28px serif'; g.textAlign = 'right'; g.fillText('Music by Somebody', W - 90, 190);
  g.lineWidth = 10; g.strokeStyle = '#c00'; g.strokeRect(5, 5, W - 10, H - 10); g.strokeStyle = '#000';  // the page edge: must be seen whole
  let y = 270;
  const staff = (y0) => { g.lineWidth = 2; for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(90, y0 + k * 16); g.lineTo(W - 90, y0 + k * 16); g.stroke(); }
    g.font = '64px serif'; g.textAlign = 'left'; [...sig].forEach((s, i) => g.fillText(s === '#' ? '♯' : '♭', 150 + i * 26, y0 + 40 - i * 8));
    for (let n = 0; n < 14; n++) { const x = 260 + n * 64, yy = y0 + ((n * 7) % 9) * 8; g.beginPath(); g.ellipse(x, yy, 11, 8, -0.4, 0, 7); g.fill(); g.beginPath(); g.moveTo(x + 10, yy); g.lineTo(x + 10, yy - 50); g.stroke(); } };
  while (y < H - (grand ? 300 : 120)) {
    staff(y);
    if (grand) { staff(y + 120); g.lineWidth = 4; g.beginPath(); g.moveTo(90, y); g.lineTo(90, y + 184); g.stroke(); y += 290; } else y += 180;
  }
  const fd = new FormData(); fd.append('title', title); fd.append('artist', 'E2E');
  fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), 'p1.png');
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, grand, sig, w, h);

const state = (page) => page.evaluate(() => ({
  title: document.querySelector('#ci-title')?.textContent.trim() || null,
  keyOn: [...document.querySelectorAll('.ci-key.on')].map((e) => e.dataset.key),
  verOn: [...document.querySelectorAll('.ci-ver.on')].map((e) => e.dataset.ver),
  keyHint: [...document.querySelectorAll('.ci-key.hint')].map((e) => e.dataset.key),
  verHint: [...document.querySelectorAll('.ci-ver.hint')].map((e) => e.dataset.ver),
  okKey: document.querySelector('#ci-okkey')?.textContent || '',
  badge: document.querySelector('#cu-ninfo')?.textContent || '',
  tabOn: document.querySelector('.cu-tabs a.on')?.dataset.tab,
  next: document.querySelector('#ci-next')?.disabled,
  empty: !!document.querySelector('.ci-empty'),
  sug: document.querySelector('.ci-sug')?.textContent || '',
  fail: [...document.querySelectorAll('.ci-savefail')].map((e) => e.textContent),
  other: document.querySelector('#ci-other')?.value,
  overflowX: document.documentElement.scrollWidth > innerWidth + 1,
  actsVisible: (() => { const a = document.querySelector('.ci-acts'); if (!a) return null; const r = a.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })(),
}));
// page 1: the whole page inside its frame, aspect kept, no scroll, as big as the frame allows, on screen, this song's
const pic = (page, id) => page.evaluate((id) => {
  const f = document.querySelector('#ci-pic'), i = f?.querySelector('img');
  if (!i || !i.complete || !i.naturalWidth) return { ok: false, why: 'no picture', state: f?.dataset.state, n: f?.querySelectorAll('img').length };
  const fr = f.getBoundingClientRect(), ir = i.getBoundingClientRect();
  const ar = i.naturalWidth / i.naturalHeight, rr = ir.width / ir.height;
  const inside = ir.left >= fr.left - 0.5 && ir.top >= fr.top - 0.5 && ir.right <= fr.right + 0.5 && ir.bottom <= fr.bottom + 0.5;
  const noScroll = f.scrollHeight <= f.clientHeight + 1 && f.scrollWidth <= f.clientWidth + 1;
  const fill = Math.max(ir.width / (f.clientWidth - 12), ir.height / (f.clientHeight - 12));
  const mine = (i.getAttribute('src') || '').includes(`/items/${encodeURIComponent(id)}/pages/1`);
  const onScreen = fr.top >= -1 && fr.bottom <= innerHeight + 1 && fr.left >= -1 && fr.right <= innerWidth + 1;
  const one = f.querySelectorAll('img').length === 1;
  return { ok: inside && noScroll && Math.abs(ar - rr) / ar < 0.02 && fill > 0.97 && mine && onScreen && one, inside, noScroll, ar: +ar.toFixed(3), rr: +rr.toFixed(3), fill: +fill.toFixed(3), mine, onScreen, one, w: Math.round(ir.width), h: Math.round(ir.height), fw: Math.round(fr.width), fh: Math.round(fr.height) };
}, id);
const waitPic = async (page, id, ms = 6000) => { const end = Date.now() + ms; let p; while (Date.now() < end) { p = await pic(page, id); if (p.ok) return p; await sleep(100); } return p; };

for (const [name, dev, vp] of DEVICES) {
  console.log(name);
  const touch = !!vp.hasTouch;
  const page = await b.newPage();
  if (touch) await page.setUserAgent(dev === 'iphone' ? PHONE_UA : IPAD_UA);
  await page.setViewport(vp);
  await page.setBypassServiceWorker(true);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|500|Failed to load resource|ERR_FAILED/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  // network rules: delay or fail a page picture, fail a PATCH; count the PATCHes
  const rules = { slow: null, failImg: null, failPatch: null };
  const patches = [];
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    if (req.method() === 'PATCH' && /\/api\/items\//.test(u)) { patches.push({ url: u, body: JSON.parse(req.postData() || '{}') }); if (rules.failPatch && u.includes(rules.failPatch)) return req.respond({ status: 500, contentType: 'application/json', body: '{"detail":"Test: the Mac said no"}' }); }
    if (rules.failImg && u.includes(`/items/${rules.failImg}/pages/1`) && !/retry=/.test(u)) return req.abort();
    if (rules.slow && u.includes(`/items/${rules.slow}/pages/1`)) await sleep(1800);
    req.continue();
  });
  const tapEl = async (sel) => {
    const h = await page.$(sel); if (!h) throw new Error('no ' + sel);
    if (!touch) { await h.click(); return; }
    await h.evaluate((e) => { const r = e.getBoundingClientRect(), a = document.querySelector('.ci-acts')?.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || (a && !e.closest('.ci-acts') && r.bottom > a.top)) e.scrollIntoView({ block: 'center' }); });
    const r = await h.boundingBox();
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  };
  const tap = async (sel) => { await tapEl(sel); await sleep(200); };
  await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(600);
  await send('POST', '/completeinfo/reset', { all: true });
  { const left = (await api('/completeinfo')).items.filter((x) => /^CI-/.test(x.title)).map((x) => x.id); if (left.length) await send('POST', '/items/trash', { ids: left }); }  // the last device's / run's leftovers
  const T = (n, s) => `CI-${dev}-${RUN} ${n} ${s}`;
  const done = await upload(page, T(0, 'Complete'));
  await send('PATCH', '/items/' + done.id, { key: 'C', version: 'lead' });
  const s1 = await upload(page, T(1, 'Canon In D'), { sig: '##' });
  const s2 = await upload(page, T(2, 'Song'), { grand: true, sig: '#', w: 1754, h: 1240 });  // a wide page
  const s3 = await upload(page, T(3, 'Other'), { grand: true, sig: '###', w: 1000, h: 2200 });  // a very tall one
  const s4 = await upload(page, T(4, 'Half'));
  await send('PATCH', '/items/' + s4.id, { key: 'G' });  // only the version is missing
  const s5 = dev === 'mac' ? await upload(page, T(5, 'Keys'), { sig: 'bbb' }) : null;
  const s6 = await upload(page, T(6, 'Hard'));
  const q0 = await api('/completeinfo');
  check('queue: only the ones without key / version, title order', JSON.stringify(q0.items.map((x) => x.id)) === JSON.stringify([s1, s2, s3, s4, s5, s6].filter(Boolean).map((x) => x.id)), JSON.stringify(q0.items.map((x) => x.title)));
  check('suggestion from the title: D', q0.items[0]?.suggest?.key?.value === 'D', JSON.stringify(q0.items[0]?.suggest));

  // card 1 comes slowly: a placeholder first, never a wrong-size picture; card 4's picture fails (until Retry)
  rules.slow = s1.id; rules.failImg = s4.id;
  await page.goto(BASE + '#/manage/info', { waitUntil: 'domcontentloaded' }); await sleep(900);
  let p0 = await page.evaluate(() => ({ state: document.querySelector('#ci-pic')?.dataset.state, img: !!document.querySelector('#ci-pic img'), ph: document.querySelector('.ci-ph')?.textContent || '' }));
  check('slow page: "Loading page 1…" placeholder, no picture yet', p0.state === 'loading' && !p0.img && /Loading page 1/.test(p0.ph), JSON.stringify(p0));
  let p = await waitPic(page, s1.id);
  rules.slow = null;
  check('card 1: the whole page fitted in its frame', p.ok, JSON.stringify(p));
  let s = await state(page);
  check('Complete info tab is on, badge = count', s.tabOn === 'info' && s.badge === String(q0.count), JSON.stringify(s));
  check('the AI guess D is a dashed hint, not picked; Save & next off', JSON.stringify(s.keyHint) === '["D"]' && !s.keyOn.length && /Suggested: D/.test(s.sug) && s.next === true, JSON.stringify(s));
  check('no sideways scroll; actions on screen', !s.overflowX && s.actsVisible, JSON.stringify(s));
  await page.screenshot({ path: `${SHOTS}/${dev}-card.png` });

  // zoom: tap the page, tap again
  await tap('#ci-pic'); await sleep(200);
  check('tap the page → zoomed', await page.$eval('#ci-card', (e) => e.classList.contains('zoomed')));
  await tap('#ci-pic'); await sleep(200);
  check('tap again → back, still fitted', !(await page.$eval('#ci-card', (e) => e.classList.contains('zoomed'))) && (await pic(page, s1.id)).ok);

  // a version tap picks it and stays
  await tap('[data-ver="lead"]'); await sleep(900);
  s = await state(page);
  check('tap Lead: picked at once, does NOT move on, Save & next still off (no key)', s.title === T(1, 'Canon In D') && JSON.stringify(s.verOn) === '["lead"]' && s.next === true, JSON.stringify(s));
  check('…and nothing saved yet', patches.length === 0, JSON.stringify(patches));
  // rapid taps: the last one wins, none lost
  for (const sel of ['[data-key="G"]', '[data-ver="piano"]', '[data-key="D"]', '[data-ver="duet"]', '[data-ver="lead"]', '[data-key="A"]', '[data-key="D"]']) await tapEl(sel);
  await sleep(150);
  s = await state(page);
  check('rapid taps: D and Lead picked (the last taps), still on this card', s.title === T(1, 'Canon In D') && JSON.stringify(s.keyOn) === '["D"]' && JSON.stringify(s.verOn) === '["lead"]' && s.next === false, JSON.stringify(s));
  await sleep(800);
  check('…no PATCH from picking', patches.length === 0, JSON.stringify(patches));
  await page.screenshot({ path: `${SHOTS}/${dev}-picked.png` });
  await tap('#ci-next');
  s = await state(page);
  check('Save & next: card 2 at once, badge one less', s.title === T(2, 'Song') && s.badge === String(q0.count - 1), JSON.stringify(s));
  let it = await waitItem(s1.id, (x) => x.version === 'lead' && x.key === 'D');
  check('card 1 saved: key D + Lead', it.version === 'lead' && it.key === 'D', JSON.stringify([it.key, it.version]));
  check('…in ONE PATCH with both fields', patches.length === 1 && patches[0].body.key === 'D' && patches[0].body.version === 'lead', JSON.stringify(patches));
  p = await waitPic(page, s2.id);
  check('card 2 (a wide page): fitted whole, its own picture', p.ok, JSON.stringify(p));

  // a failing PATCH: error bar + Retry
  rules.failPatch = s2.id;
  await tap('[data-key="G"]'); await tap('[data-ver="piano"]');
  await tap('#ci-next'); await sleep(500);
  s = await state(page);
  check('PATCH fails: next card shown, the error bar names the song', s.title === T(3, 'Other') && s.fail.length === 1 && s.fail[0].includes(T(2, 'Song')) && /Test: the Mac said no/.test(s.fail[0]), JSON.stringify(s));
  check('…not saved on the Mac', !(await item(s2.id)).key);
  await page.screenshot({ path: `${SHOTS}/${dev}-savefail.png` });
  rules.failPatch = null;
  await tap('.ci-savefail button'); await sleep(500);
  it = await waitItem(s2.id, (x) => x.key === 'G' && x.version === 'piano');
  check('Retry saves it; the bar goes', it.key === 'G' && it.version === 'piano' && !(await state(page)).fail.length, JSON.stringify([it.key, it.version]));

  // card 3 (a very tall page): its picture fails first → Retry; typed key; Accompaniment
  check('card 3 (a tall page): fitted whole', (await waitPic(page, s3.id)).ok, JSON.stringify(await pic(page, s3.id)));
  await tap('#ci-other'); await page.type('#ci-other', 'H7'); await tap('#ci-set');
  check('a wrong key is refused with a message', /not a key/.test(await page.$eval('#ci-err', (e) => (e.hidden ? '' : e.textContent))), '');
  await page.$eval('#ci-other', (e) => (e.value = '')); await tap('#ci-other'); await page.type('#ci-other', 'f# minor'); await tap('#ci-set');
  s = await state(page);
  check('typed "f# minor" is picked as F♯m (not saved yet)', s.other === 'F♯m' && s.okKey.includes('F♯m') && s.next === true, JSON.stringify(s));
  await tap('[data-ver="accomp"]');
  check('Accompaniment picked → Save & next on', (await state(page)).next === false);
  await tap('#ci-next'); await sleep(300);
  it = await waitItem(s3.id, (x) => x.key === 'F#m' && x.version === 'accomp');
  check('saved as F#m + accomp', it.key === 'F#m' && it.version === 'accomp', JSON.stringify([it.key, it.version]));

  // Back: the last one again with its choices; Save & next with nothing changed sends nothing
  await tap('#ci-prev');
  s = await state(page);
  check('Back shows the last card with its choices', s.title === T(3, 'Other') && JSON.stringify(s.verOn) === '["accomp"]' && s.other === 'F♯m' && s.next === false, JSON.stringify(s));
  const np = patches.length;
  await tap('#ci-next'); await sleep(300);
  check('…Save & next again: no new PATCH', patches.length === np, JSON.stringify(patches.slice(np)));

  // card 4 has its key already: G shown picked and confirmed; only the version needs a tap. Its picture failed.
  s = await state(page);
  check('card 4: key G already set = picked, Save & next off until a version', s.title === T(4, 'Half') && JSON.stringify(s.keyOn) === '["G"]' && /already set/.test(s.okKey) && s.next === true, JSON.stringify(s));
  await sleep(300);
  p0 = await page.evaluate(() => ({ state: document.querySelector('#ci-pic')?.dataset.state, retry: !!document.querySelector('.ci-ph .ci-retry'), img: !!document.querySelector('#ci-pic img') }));
  check('a page that fails: "Couldn’t load" + Retry, no picture (not the last song’s)', p0.state === 'error' && p0.retry && !p0.img, JSON.stringify(p0));
  await page.screenshot({ path: `${SHOTS}/${dev}-imgfail.png` });
  rules.failImg = null;
  await tap('.ci-ph .ci-retry');
  check('Retry loads it, fitted whole', (await waitPic(page, s4.id)).ok, JSON.stringify(await pic(page, s4.id)));
  await tap('[data-ver="duet"]');
  check('Duet tapped → Save & next on', (await state(page)).next === false);
  const np4 = patches.length;
  await tap('#ci-next'); await sleep(300);
  it = await waitItem(s4.id, (x) => x.version === 'duet');
  check('saved: version duet, key G untouched, PATCH has only the version', it.version === 'duet' && it.key === 'G' && JSON.stringify(patches.slice(np4).map((x) => x.body)) === '[{"version":"duet"}]', JSON.stringify(patches.slice(np4)));

  if (dev === 'mac') {  // keys: Enter off until both; 1 = Lead, "eb" + Enter = E♭, Enter = Save & next
    for (let k = 0; k < 3 && (await state(page)).title !== T(5, 'Keys'); k++) { await tap('#ci-skip'); await sleep(200); }
    check('Mac: the Keys card', (await state(page)).title === T(5, 'Keys'));
    await page.keyboard.press('1'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(300);
    check('Enter does nothing while Save & next is off', (await state(page)).title === T(5, 'Keys'));
    await page.keyboard.press('e'); await page.keyboard.type('b'); await page.keyboard.press('Enter'); await sleep(200);
    s = await state(page);
    check('1 → Lead, eb + Enter → E♭ picked, still here', s.title === T(5, 'Keys') && JSON.stringify(s.keyOn) === '["Eb"]' && JSON.stringify(s.verOn) === '["lead"]' && s.next === false, JSON.stringify(s));
    await page.keyboard.press('Enter'); await sleep(300);
    it = await waitItem(s5.id, (x) => x.key === 'Eb' && x.version === 'lead');
    check('Enter = Save & next: Eb + lead', it.key === 'Eb' && it.version === 'lead', JSON.stringify([it.key, it.version]));
    const rows = (await api('/activity')).filter((r) => r.action === 'undo' && (r.title || '').includes(T(5, 'Keys')));
    check('one Activities row for the edit', rows.length === 1, JSON.stringify((await api('/activity')).slice(0, 3)));
    if (rows[0]) {
      await send('POST', `/activity/${rows[0].id}/undo`, {});
      it = await item(s5.id);
      check('its Undo clears key and version again', !it.key && !it.version, JSON.stringify([it.key, it.version]));
      await send('PUT', `/completeinfo/${s5.id}/mark`, { how: 'unknown' });  // out of the way
    }
  }

  // Hard: Skip, Don't know → done screen, Show again
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
  check('Hard card', (await state(page)).title === T(6, 'Hard'), (await state(page)).title);
  await tap('#ci-skip'); await sleep(400);
  check('Skip is kept on the Mac', (await api('/completeinfo')).items.find((x) => x.id === s6.id)?.skipped > 0);
  await tap('#ci-dunno'); await sleep(500);
  s = await state(page);
  check("Don't know → All done screen", s.empty, JSON.stringify(s));
  const q2 = await api('/completeinfo');
  check("Don't know hides it on the Mac", !q2.items.some((x) => x.id === s6.id) && q2.hidden >= 1 && q2.count === 0, JSON.stringify(q2));
  await page.screenshot({ path: `${SHOTS}/${dev}-done.png` });
  await tap('#ci-again'); await sleep(900);
  check('Show again brings the hidden ones back', /Hard|Keys/.test((await state(page)).title || ''), (await state(page)).title);
  for (let k = 0; k < 12 && (await state(page)).title; k++) { await tap('#ci-dunno'); await sleep(400); }
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
