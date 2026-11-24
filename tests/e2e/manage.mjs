// Manage library (#/manage…) against a test server only (BASE: a temp data dir; refuses ~/Documents/Meowsic):
//   · old links redirect: #/cleanup, #/organize, #/bin, #/trash, #/manage?id=X(&crop=P)(&back=item), #/manage/<old tab>
//   · the hub: 4 cards with live counts (suspects, Complete info, Trash), "Last change · Undo" rolls back the newest change
//   · Check suspect songs (iPad touch, real taps): the reason in plain words, the flagged page marked, the fix that fits
//     ("Split at page 3", "Merge with “…”"), It's fine (+ Undo), Skip, Up next, Fix pages… (the new song pre-marked),
//     books never listed, check again (a job with progress)
//   · Fix pages picker: Recently opened / All sheets, search, no books
//   · Complete info: the page strip shows another page whole
//   · Trash: Restore, Delete (asks first), Empty Trash (asks first)
//   · every screen on iPad (1032×1376 touch), iPhone (390×844 touch) and Mac (1440×900): no sideways scroll; screenshots in SHOTS
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/manage-built';
fs.mkdirSync(SHOTS, { recursive: true });
const health = await fetch(BASE + 'api/health').then((r) => r.json());
if (!health.ok || /Documents\/Meowsic/.test(health.data)) { console.log('refusing: not a test server', health); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const VPS = { ipad: [{ width: 1032, height: 1376, hasTouch: true, isMobile: true }, IPAD_UA], iphone: [{ width: 390, height: 844, hasTouch: true, isMobile: true }, PHONE_UA], mac: [{ width: 1440, height: 900 }] };
const newPage = async (name) => {
  const [vp, ua] = VPS[name];
  const p = await b.newPage(); if (ua) await p.setUserAgent(ua); await p.setViewport(vp); await p.setBypassServiceWorker(true);
  p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`)); p.on('console', (m) => m.type() === 'error' && !/404|409|Failed to load resource/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  p.touch = !!vp.hasTouch;
  return p;
};
const tapOn = async (p, sel) => {
  const h = await p.$(sel); if (!h) throw new Error('no ' + sel);
  await h.evaluate((e) => { const r = e.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 80) e.scrollIntoView({ block: 'center' }); });
  await sleep(120);
  const r = await h.boundingBox();
  if (p.touch) await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); else await p.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await sleep(300);
};
const hash = (p) => p.evaluate(() => location.hash);
const noSideways = (p) => p.evaluate(() => { const m = document.querySelector('#main'); return document.scrollingElement.scrollWidth <= innerWidth + 1 && m.scrollWidth <= m.clientWidth + 1; });

// ---- test data: two songs in one sheet (a title on page 3), one song in two parts, a plain 3-page sheet, a book, a trashed sheet ----
const ipad = await newPage('ipad');
await ipad.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const upload = (title, heads) => ipad.evaluate(async (title, heads) => {
  const fd = new FormData(); fd.append('title', title); fd.append('artist', 'E2E');
  const seed = [...title].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 37;  // every sheet's pages differ (the Mac skips a photo it has seen)
  for (let k = 0; k < heads.length; k++) {
    const c = document.createElement('canvas'); c.width = 850; c.height = 1100;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 850, 1100); g.fillStyle = '#000'; g.strokeStyle = '#000';
    if (heads[k]) { g.font = 'bold 54px serif'; g.textAlign = 'center'; g.fillText(heads[k], 425, 110); }
    for (let y = 200 + k * 7; y < 980; y += 120) { g.lineWidth = 2; for (let l = 0; l < 5; l++) { g.beginPath(); g.moveTo(60, y + l * 12); g.lineTo(790, y + l * 12); g.stroke(); }
      for (let x = 120 + k * 9 + seed; x < 770; x += 55) { g.beginPath(); g.ellipse(x, y + ((x * 7 + k * 13 + seed) % 48), 8, 6, 0, 0, 7); g.fill(); } }
    g.font = '30px sans-serif'; g.textAlign = 'center'; g.fillText(String(k + 1), 425, 1060);
    fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `p${k + 1}.png`);
  }
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, heads);
const two = await upload('River Lullaby', ['River Lullaby', '', 'Evening Bells', '']);
const part1 = await upload('Little Prelude', ['Little Prelude', '']);
const part2 = await upload('Little Prelude (part 2)', ['', '']);
const plain = await upload('Autumn Song', ['Autumn Song', '', '']);
let book = await upload('Piano Favourites', ['Piano Favourites', 'Moon River', '', '']);
book = (await post('/items/book', { ids: [book.id], book: true })).items[0];
const gone = await upload('Old Song', ['Old Song']);
await post('/items/trash', { ids: [gone.id] });
await post('/organize/scan', { wait: true });
const org = await api('/organize');
const cands = org.scan.candidates;
check('the scan flags River Lullaby as two songs at page 3', cands.some((c) => c.id === two.id && c.kind === 'several' && c.pages.includes(3)), JSON.stringify(cands));
check('…and the Prelude parts (merge, pages [])', cands.some((c) => c.id === part1.id && c.kind === 'merge' && Array.isArray(c.pages)), JSON.stringify(cands));
check('books are never flagged nor listed', !cands.some((c) => c.id === book.id) && !org.items.some((x) => x.id === book.id));

await ipad.reload({ waitUntil: 'networkidle0' });  // the store takes the new items and the trashed one
// ---- old links ----
const redirects = [['#/cleanup', '#/manage'], ['#/organize', '#/manage'], ['#/bin', '#/manage/trash'], ['#/trash', '#/manage/trash'], ['#/manage/sort', '#/manage'],
  [`#/manage?id=${plain.id}`, `#/manage/pages/${plain.id}`], [`#/organize?id=${plain.id}`, `#/manage/pages/${plain.id}`],
  [`#/manage?id=${plain.id}&back=item&crop=2`, `#/manage/pages/${plain.id}/crop/2?back=item`], [`#/manage?id=${plain.id}&back=item`, `#/manage/pages/${plain.id}?back=item`]];
for (const [from, to] of redirects) {
  await ipad.goto(BASE + from, { waitUntil: 'networkidle2' }); await sleep(300);
  check(`${from} → ${to}`, (await hash(ipad)) === to, await hash(ipad));
}

// ---- the hub ----
const shot = (p, n, name) => p.screenshot({ path: `${SHOTS}/${n}-${name}.png` });
await ipad.goto(BASE + '#/manage', { waitUntil: 'networkidle2' }); await sleep(1200);
const cards = await ipad.$$eval('.mg-card', (e) => e.map((x) => [x.id, x.querySelector('h2').textContent, x.querySelector('.mg-count')?.textContent || '']));
const nIds = new Set(cands.map((c) => c.id)).size, nInfo = (await api('/completeinfo/count')).count;
check('hub: 4 cards in order', JSON.stringify(cards.map((c) => c[1])) === JSON.stringify(['Check suspect songs', 'Complete info', 'Fix pages', 'Trash']), JSON.stringify(cards));
check('hub: live counts', cards[0][2] === `${nIds}to check` && cards[1][2] === `${nInfo}left` && cards[3][2] === '1item', JSON.stringify(cards));
check('hub: no optional cards', !(await ipad.$('.mg-card.opt')) && !/duplicates|composer/i.test(await ipad.$eval('#main', (e) => e.textContent)));
check('hub: Last change row', /Moved to Trash · “Old Song”/.test(await ipad.$eval('#mg-last', (e) => e.textContent)), await ipad.$eval('#mg-last', (e) => e.textContent));
check('hub: iPad has no left bar', await ipad.$eval('#side', (e) => getComputedStyle(e).display === 'none'));
await tapOn(ipad, '#mg-c-review'); await sleep(1500);
check('tap the card → Check suspect songs', (await hash(ipad)) === '#/manage/review');

// ---- Check suspect songs ----
const rv = () => ipad.evaluate(() => ({ h: document.querySelector('#rv-h')?.textContent || '', sub: document.querySelector('#mg-sub')?.textContent || '', primary: document.querySelector('#rv-primary')?.textContent || '',
  flags: [...document.querySelectorAll('.rv-pg.flag')].map((e) => [e.dataset.p, e.querySelector('.rv-lbl')?.textContent]), next: [...document.querySelectorAll('.rv-next .mg-row b')].map((e) => e.textContent) }));
let r = await rv();
check('review: the reason in plain words', r.h === '“River Lullaby” might be two songs' && /^1 of 2 · checked/.test(r.sub), JSON.stringify(r));
check('review: page 3 marked "New song?"', JSON.stringify(r.flags) === '[["3","New song?"]]', JSON.stringify(r.flags));
check('review: the fix that fits = Split at page 3; Up next = the Prelude', r.primary === 'Split at page 3' && JSON.stringify(r.next) === '["Little Prelude"]', JSON.stringify(r));
await shot(ipad, 'ipad', 'review');
await tapOn(ipad, '#rv-skip');
r = await rv();
check('Skip → the next one: might be half a song, Merge with its part 2', r.h === '“Little Prelude” might be half a song' && r.primary === 'Merge with “Little Prelude (part 2)”', JSON.stringify(r));
await tapOn(ipad, '#rv-fine'); await sleep(800);
check('It’s fine: saved on the Mac', (await api('/organize')).items.find((x) => x.id === part1.id)?.reviewed === true);
r = await rv();
check('…on to the next (River Lullaby again)', r.h.includes('River Lullaby'), JSON.stringify(r));
await tapOn(ipad, '#toast button'); await sleep(1500);
check('Undo (toast): it can come up again', !(await api('/organize')).items.find((x) => x.id === part1.id)?.reviewed && (await rv()).sub.startsWith('1 of 2'));
// the split, from the review
await tapOn(ipad, '#rv-primary'); await sleep(400);
check('Split at page 3 asks first', /Split “River Lullaby” into 2 sheets/.test(await ipad.$eval('.modal h2', (e) => e.textContent).catch(() => '')));
await tapOn(ipad, '.modal [data-ok]'); await sleep(3000);
check('split: River Lullaby keeps pages 1–2, a new sheet has 3–4', (await api('/items/' + two.id)).pages === 2 && (await api('/items')).some((x) => x.pages === 2 && x.id !== two.id && /Evening Bells|River Lullaby — p3/.test(x.title)), JSON.stringify((await api('/items')).map((x) => [x.title, x.pages])));
await tapOn(ipad, '#toast button'); await sleep(2000);
check('Undo puts River Lullaby back together', (await api('/items/' + two.id)).pages === 4);
// merge, from the review
await ipad.goto(BASE + '#/manage', { waitUntil: 'networkidle2' }); await ipad.goto(BASE + '#/manage/review', { waitUntil: 'networkidle2' }); await sleep(1200);
await tapOn(ipad, '[data-act="goto"]'); await sleep(300);
await tapOn(ipad, '#rv-primary'); await sleep(400);
await tapOn(ipad, '.modal [data-ok]'); await sleep(2500);
check('Merge with “Little Prelude (part 2)”: 4 pages, part 2 in the Trash', (await api('/items/' + part1.id)).pages === 4 && (await api('/items/' + part2.id)).deleted, JSON.stringify([await rv(), (await api('/items/' + part1.id)).pages, await ipad.$eval('#toast', (e) => e.textContent).catch(() => '')]));
await tapOn(ipad, '#toast button'); await sleep(2000);
check('Undo the merge', (await api('/items/' + part1.id)).pages === 2 && !(await api('/items/' + part2.id)).deleted);
// Fix pages… opens the editor with the suggested start marked
await ipad.goto(BASE + '#/manage/review', { waitUntil: 'networkidle2' }); await sleep(1200);
await tapOn(ipad, '#rv-fix'); await sleep(2000);
check('Fix pages… → the editor, page 3 marked as a new song', (await hash(ipad)) === `#/manage/pages/${two.id}` && !!(await ipad.$('#pe-grid .pe-break[data-start="3"]')) && '3' in (await api(`/sheets/${two.id}/split`)).starts, JSON.stringify([await hash(ipad), (await api(`/sheets/${two.id}/split`)).starts, await ipad.$eval('#pe-grid', (e) => e.textContent.slice(0, 200)).catch(() => '')]));
await tapOn(ipad, '.pe-break [data-act="unmark"]'); await sleep(800);
// check again: a job with progress
await ipad.goto(BASE + '#/manage/review', { waitUntil: 'networkidle2' }); await sleep(1000);
const at0 = (await api('/organize')).scan.at;
await tapOn(ipad, '#mg-sub [data-act="scan"]'); await sleep(200);
for (let i = 0; i < 120 && (await api('/organize')).scan.at === at0; i++) await sleep(500);
await sleep(1500);
check('check again runs a new scan', (await api('/organize')).scan.at > at0 && (await api('/jobs')).some((j) => j.kind === 'organize' && j.status === 'done'));

// ---- the Fix pages picker ----
await ipad.goto(BASE + '#/manage/pages', { waitUntil: 'networkidle2' }); await sleep(1200);
const rows = () => ipad.$$eval('#pk-list .mg-row', (e) => e.map((x) => x.dataset.id));
check('picker: Recently opened lists River Lullaby', (await rows())[0] === two.id && (await ipad.$eval('[data-seg="recent"]', (e) => e.classList.contains('on'))));
await tapOn(ipad, '[data-seg="all"]');
const all = await rows();
check('picker: All sheets, no book, no Books segment', all.includes(plain.id) && !all.includes(book.id) && !(await ipad.$('[data-seg="books"]')), JSON.stringify(all));
await ipad.type('#pk-find', 'autumn'); await sleep(300);
check('picker: search', JSON.stringify(await rows()) === JSON.stringify([plain.id]), JSON.stringify(await rows()));
await tapOn(ipad, `#pk-list [data-id="${plain.id}"]`); await sleep(1500);
check('picker: a row opens the editor', (await hash(ipad)) === `#/manage/pages/${plain.id}`);

// ---- hub: Last change · Undo rolls back the newest change ----
await ipad.$eval('#pe-grid .pe-tile[data-p="2"]', (e) => e.scrollIntoView()); await tapOn(ipad, '#pe-grid .pe-tile[data-p="2"]');
await tapOn(ipad, '#pe-dock [data-act="delete"]'); await sleep(1800);
check('a page deleted', (await api('/items/' + plain.id)).pages === 2);
await ipad.goto(BASE + '#/manage', { waitUntil: 'networkidle2' }); await sleep(1200);
check('Last change names it', /deleted page 2/.test(await ipad.$eval('#mg-last', (e) => e.textContent)), await ipad.$eval('#mg-last', (e) => e.textContent));
await tapOn(ipad, '#mg-last [data-act="undo-last"]'); await sleep(2000);
check('Last change → Undo brings the page back', (await api('/items/' + plain.id)).pages === 3);

// ---- Complete info: the page strip ----
await post('/completeinfo/reset', { all: true });
await ipad.goto(BASE + '#/manage/info', { waitUntil: 'networkidle2' }); await sleep(1500);
for (let i = 0; i < 8 && !(await ipad.$('.ci-thumb[data-p="3"]')); i++) { await tapOn(ipad, '#ci-skip'); await sleep(400); }
await tapOn(ipad, '.ci-thumb[data-p="2"]'); await sleep(1500);
check('Complete info: a tap on page 2 in the strip shows it whole', /\/pages\/2/.test(await ipad.$eval('#ci-pic img', (e) => e.src).catch(() => '')) && (await ipad.$eval('.ci-thumb[data-p="2"]', (e) => e.classList.contains('on'))));

// ---- Trash ----
await ipad.goto(BASE + '#/manage/trash', { waitUntil: 'networkidle2' }); await sleep(1000);
const row = `#bn .row[data-id="${gone.id}"]`;
check('Trash lists the trashed sheet', !!(await ipad.$(row)) && /Sheet · deleted/.test(await ipad.$eval(row, (e) => e.textContent)));
await tapOn(ipad, `${row} [data-act="restore"]`); await sleep(900);
check('Restore', !(await ipad.$(row)) && !(await api('/items/' + gone.id)).deleted);
await post('/items/trash', { ids: [gone.id] }); await ipad.reload({ waitUntil: 'networkidle2' }); await sleep(1000);
await tapOn(ipad, `${row} [data-act="purge"]`);
check('Delete asks first', /for good/.test(await ipad.$eval('.modal h2', (e) => e.textContent)));
await tapOn(ipad, '.modal [data-close]');
check('Cancel keeps it', !!(await ipad.$(row)));
await tapOn(ipad, '#bn-empty');
check('Empty Trash asks first', /for good/.test(await ipad.$eval('.modal h2', (e) => e.textContent)));
await tapOn(ipad, '.modal [data-close]');

// ---- every screen on every device: fits, screenshots ----
await post(`/sheets/${two.id}/split`, { page: 3, on: true, title: 'Evening Bells' });
const SCREENS = [['hub', '#/manage'], ['review', '#/manage/review'], ['pick', '#/manage/pages'], ['editor', `#/manage/pages/${two.id}`], ['crop', `#/manage/pages/${two.id}/crop/2`], ['info', '#/manage/info'], ['trash', '#/manage/trash']];
for (const name of ['ipad', 'iphone', 'mac']) {
  const p = name === 'ipad' ? ipad : await newPage(name);
  for (const [s, h] of SCREENS) {
    await p.goto(BASE + h, { waitUntil: 'networkidle2' }); await sleep(1300);
    if (s === 'editor') { await tapOn(p, '#pe-grid .pe-tile[data-p="2"]'); }
    check(`${name} ${s}: renders, no sideways scroll`, (await hash(p)).startsWith(h) && (await noSideways(p)) && !(await p.$('.cu-tabs')), await hash(p));
    await shot(p, name, s);
  }
  if (name !== 'ipad') await p.close();
}
await post(`/sheets/${two.id}/split`, { page: 3, on: false });

check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
