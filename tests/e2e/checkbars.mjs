// Check bars (score toolbar "N to check" → review panel) against a test server (BASE, default :5371, a scratchpad
// copy of the data — never the real library). A made-up piano score (Ode to Joy, public domain) with bars 2 and 3
// marked to check (<miscellaneous-field name="meowsic-check-bars">, "⚠ check" over them, as photo → score writes it).
// Mac and iPhone: the test writes the score's "<folder> check.json" + page image into the test data (DATA), as the
// photo → score job does (barcheck.py): why, the other reading of bar 2, the page and the bars' boxes on it.
// iPad: no check.json (GET /check 404) → the bars alone, saved through Edit notes.
//   Mac: badge "2 to check" → bar 2 boxed, its reason and the printed bar cropped; Use other reading → preview →
//        Use this reading (saved, 1 left) → bar 3: Play bar plays only that bar → Edit notes (bar 3 picked) → ♯ →
//        Save to this score → "All bars checked", badge gone; Activities can undo both.
//   iPad: Looks right ×2 → none left; the whole page is not shown (no sheet linked).
//   iPhone: the crop, tap → whole page; Edit notes → close without saving → back in the review at the same bar.
// Screenshots go to $SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/editnotes';
const SHEET = process.env.SHEET || 's-7ruo66q';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const marked = (x) => (/name="meowsic-check-bars">([^<]*)</.exec(x)?.[1] || '').trim();
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

const STEPS = { 48: 'C3', 53: 'F3', 55: 'G3', 57: 'A3', 59: 'B3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4' };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (ms, q, staff) => ms.map((m, k) => `<note>${k ? '<chord/>' : ''}<pitch><step>${STEPS[m][0]}</step><octave>${STEPS[m][1]}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`).join('');
const RH = [[[[64, 60], 1], [[64], 1], [[65], 1], [[67], 1]], [[[67], 1], [[65], 1], [[64], 1], [[62], 1]], [[[60], 1], [[60], 1], [[62], 1], [[64], 1]], [[[64, 60], 4]]];
const LH = [[[[48], 2], [[55], 2]], [[[59], 2], [[55], 2]], [[[53], 2], [[55], 2]], [[[48, 55], 4]]];
const CHECK = '<direction placement="above"><direction-type><words color="#D00000">⚠ check</words></direction-type></direction>';
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><identification><miscellaneous><miscellaneous-field name="meowsic-check-bars">2 3</miscellaneous-field></miscellaneous></identification><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>'}`
    + (k === 1 || k === 2 ? CHECK : '') + bar.map(([ms, q]) => note(ms, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH[k].map(([ms, q]) => note(ms, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';
// the other reader's bar 2: A4 G4 F4 E4 over the same left hand
const ALT2 = '<measure number="2">' + [69, 67, 65, 64].map((m) => note([m], 1, 1)).join('') + '<backup><duration>8</duration></backup>' + note([59], 2, 2) + note([55], 2, 2) + '</measure>';
// check.json as omr.py writes it; the page is a sheet photo from the test data (1477 × 1934)
const DATA = process.env.DATA || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/editnotes-data';
const PAGE = `${DATA}/items/${SHEET}/${SHEET} 1.jpg`;
const SIDECAR = { version: 1, sheetId: SHEET, pages: [{ page: 1, file: 'page1.jpg', width: 1477, height: 1934 }], decisions: [], bars: [
  { bar: 2, page: 1, box: [148, 580, 738, 735], reasons: ['the two readers disagree'], alternatives: [{ id: 'audiveris', label: 'Second reader', musicxml: ALT2 }] },
  { bar: 3, page: 1, box: [738, 580, 1330, 735], reasons: ['the bar was changed so it adds up'], alternatives: [] }] };
const writeCheck = (folder) => {
  const d = `${DATA}/items/${folder}`;
  fs.writeFileSync(`${d}/${folder} check.json`, JSON.stringify(SIDECAR));
  fs.copyFileSync(PAGE, `${d}/${folder} check p1.jpg`);
};

async function run(name, vp, how) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Ode check ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Beethoven', musicxmlText: scoreXml(title), source: 'From the sheet “Ode” (photo → score, beta)' });
  const x0 = await xmlOf(sc.id);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  if (how !== 'plain') writeCheck(sc.folder);
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(200); };
  const act = (a) => tap(`.cb-panel [data-a="${a}"]`);
  const CB = (f) => page.evaluate(f);
  const idle = async (ms = 900) => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await CB(() => window.__checkBars?.busy || window.__editNotes?.busy))) break; } await sleep(ms); };
  const badge = () => page.$eval('#sc-check', (e) => (e.hidden ? '' : e.textContent.trim()));
  const boxIn = () => page.evaluate(() => { const b = document.querySelector('.cb-box'); if (!b) return false; const r = b.getBoundingClientRect(), p = document.querySelector('.cb-panel').getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.top >= 0 && r.bottom <= p.top + 4; });

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(1200);
  check('toolbar badge: 2 to check', (await badge()) === '2 to check', await badge());
  await tap('#sc-check'); await page.waitForSelector('.cb-panel', { timeout: 5000 }); await sleep(800);
  check('review opens on bar 2 (1 of 2)', (await page.$eval('#cb-count', (e) => e.textContent)) === 'Bar 2 · 1 of 2');
  check('bar 2 is boxed in the score, in view', await boxIn());
  const why = await page.$eval('.cb-why', (e) => e.textContent);
  check('says why in plain words', how === 'plain' ? /did not agree/.test(why) : /disagree/.test(why), why);
  const fits = await page.evaluate(() => { const r = document.querySelector('.cb-panel').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1; });
  check('panel fits the screen', fits);

  if (how === 'mac') {
    await sleep(600);
    const crop = await page.$eval('.cb-sheet', (e) => ({ cropped: e.classList.contains('cropped'), w: e.clientWidth, h: e.clientHeight, img: e.querySelector('img').naturalWidth }));
    check('the printed bar from the sheet, cropped', crop.cropped && crop.img > 0 && crop.h <= 152 && crop.w > 50, JSON.stringify(crop));
    await page.screenshot({ path: `${SHOTS}/check-${name}-bar2.png` });
    await act('alt'); await idle();
    check('Use other reading: the score shows it (A4 first)', /<step>A<\/step>\s*<octave>4<\/octave>/.test(await CB(() => window.__score.xml())) && !!(await CB(() => window.__checkBars.alt)));
    check('nothing saved yet', (await xmlOf(sc.id)) === x0);
    await page.screenshot({ path: `${SHOTS}/check-${name}-other-reading.png` });
    await act('alt-keep'); await idle(1200);
    let x = await xmlOf(sc.id);
    check('Use this reading: saved, bar 2 no longer to check', marked(x) === '3' && /<step>A<\/step>\s*<octave>4<\/octave>/.test(x), marked(x));
    check('review moves to bar 3, badge says 1', (await page.$eval('#cb-count', (e) => e.textContent)) === 'Bar 3 · 1 of 1' && (await badge()) === '1 to check');
    check('bar 3 boxed', await boxIn());
    await act('play'); await sleep(2600);
    const q = await CB(() => ({ q: window.__score.player.now(), playing: window.__score.player.playing }));
    check('Play bar: plays bar 3 and stops at its end', !q.playing && q.q >= 3.9 && q.q <= 8.1, JSON.stringify(q));
    await act('edit'); await page.waitForSelector('.notes-panel', { timeout: 6000 }); await sleep(700);
    const sel = await CB(() => window.__editNotes.sel.map((r) => window.__editNotes.notes.find((n) => n.ref === r)));
    check('Edit notes opens on bar 3, its notes picked', sel.length === 6 && sel.every((n) => n.bar === 2), JSON.stringify(sel.map((n) => n.bar)));
    check('the review waits while editing', !(await page.$('.cb-panel')));
    await page.evaluate(async () => { const n = window.__editNotes.notes.find((x) => x.bar === 2 && x.staff === 1 && x.on === 0); window.__editNotes.select([n.ref]); });
    await tap('.notes-panel [data-a="semi+"]'); await idle();
    await tap('.notes-panel [data-a="save"]'); await sleep(300);
    await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await idle(1500);
    x = await xmlOf(sc.id);
    check('saved: C♯ in bar 3, nothing left to check', !/meowsic-check-bars/.test(x) && !/⚠ check/.test(x) && /<step>C<\/step>\s*<alter>1<\/alter>/.test(x));
    check('badge gone, review closed', (await badge()) === '' && !(await page.$('.cb-panel')) && !(await page.$('.notes-panel')));
    await page.screenshot({ path: `${SHOTS}/check-${name}-done.png` });
    const rows = (await api('/activity')).filter((r) => ['edit-notes', 'bar-check'].includes(r.type) && r.title.includes(title));
    check('two Activities rows, undoable', rows.length === 2 && rows.every((r) => r.action === 'undo'), JSON.stringify(rows.map((r) => r.detail)));
    for (const r of rows) await send('POST', `/activity/${r.id}/undo`, {});
    check('Activities undo puts the score back', (await xmlOf(sc.id)) === x0);
  } else if (how === 'plain') {
    check('no sheet linked: says so', !!(await page.$('.cb-nosheet')) && !(await page.$('[data-a="alt"]')));
    await page.screenshot({ path: `${SHOTS}/check-${name}-bar2.png` });
    await act('next'); await sleep(500);
    check('Next: bar 3', (await page.$eval('#cb-count', (e) => e.textContent)) === 'Bar 3 · 2 of 2' && (await boxIn()));
    await act('ok'); await idle(1200);
    check('Looks right: bar 3 off the list, back to bar 2', (await page.$eval('#cb-count', (e) => e.textContent)) === 'Bar 2 · 1 of 1' && marked(await xmlOf(sc.id)) === '2' && (await badge()) === '1 to check');
    await act('ok'); await idle(1200);
    check('Looks right again: none left, review closes, badge gone', !(await page.$('.cb-panel')) && (await badge()) === '' && !/meowsic-check-bars/.test(await xmlOf(sc.id)));
    const rows = (await api('/activity')).filter((r) => r.type === 'edit-notes' && r.title.includes(title));
    for (const r of rows) await send('POST', `/activity/${r.id}/undo`, {});
    check('Activities undo marks them again', marked(await xmlOf(sc.id)) === '2 3');
  } else {
    await sleep(600);
    check('the printed bar shows on the phone', await page.$eval('.cb-sheet', (e) => e.classList.contains('cropped') && e.querySelector('img').naturalWidth > 0));
    await page.screenshot({ path: `${SHOTS}/check-${name}-bar2.png` });
    await act('zoom'); await sleep(500);
    check('tap the bar: the whole page', !!(await page.$('.modal .cb-page img')));
    await page.keyboard.press('Escape'); await sleep(300);
    check('page view closes', !(await page.$('.modal .cb-page')));
    await act('next'); await sleep(400);
    await act('edit'); await page.waitForSelector('.notes-panel', { timeout: 6000 }); await sleep(500);
    await page.evaluate(() => { const n = window.__editNotes.notes.find((x) => x.bar === 2 && x.staff === 1 && x.on === 0); window.__editNotes.select([n.ref]); });
    await tap('.notes-panel [data-len="2"]'); await idle();
    check('a change in the editor', (await CB(() => window.__editNotes.step)) === 1);
    await tap('.notes-panel [data-a="close"]'); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close').click()); await idle(1200);
    check('closed the editor without saving: back in the review at bar 3', (await page.$eval('#cb-count', (e) => e.textContent).catch(() => '')) === 'Bar 3 · 2 of 2' && (await xmlOf(sc.id)) === x0);
    await act('close'); await sleep(400);
    check('review closed, still 2 to check', !(await page.$('.cb-panel')) && (await badge()) === '2 to check');
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

// Words read too poorly to write: bars 2 + 3 "lyrics unsure" (verse 1, that line), bar 4 a note reason.
// Mac: Fix lyrics opens Edit notes in Lyrics mode on verse 1 at bar 2 → words pasted, saved into this score → bars 2 + 3 checked,
// bar 4 left → Mark all as looks right asks first (Cancel keeps it), then marks it → none left; Activities can undo.
async function lyricsRun() {
  console.log('\nMac: lyrics unsure + Mark all');
  const title = `Ode lyrics ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Beethoven', musicxmlText: scoreXml(title).replace('>2 3<', '>2 3 4<'), source: 'From the sheet “Ode” (photo → score, beta)' });
  const LY = 'lyrics unsure — fix in the score editor (Lyrics)', OLD = 'lyrics unsure — use Fit lyrics'; // bar 2: an older check.json
  const d = `${DATA}/items/${sc.folder}`;
  fs.writeFileSync(`${d}/${sc.folder} check.json`, JSON.stringify({ ...SIDECAR, bars: [
    { bar: 2, page: 1, box: [148, 580, 738, 735], reasons: [OLD], alternatives: [], lyrics: { verse: 1, bars: [2, 3] } },
    { bar: 3, page: 1, box: [738, 580, 1330, 735], reasons: [LY], alternatives: [], lyrics: { verse: 1, bars: [2, 3] } },
    { bar: 4, page: 1, box: [148, 735, 738, 900], reasons: ['rest added to fill the bar'], alternatives: [] }] }));
  fs.copyFileSync(PAGE, `${d}/${sc.folder} check p1.jpg`);
  const page = await b.newPage(); await page.setViewport(MAC);
  page.on('pageerror', (e) => errs.push(`lyrics: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`lyrics: ${m.text()}`));
  const badge = () => page.$eval('#sc-check', (e) => (e.hidden ? '' : e.textContent.trim()));
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(1200);
  await page.click('#sc-check'); await page.waitForSelector('.cb-panel', { timeout: 5000 }); await sleep(600);
  const btns = await page.$$eval('.cb-panel .cb-acts button', (e) => e.map((x) => x.textContent.trim()));
  const why = await page.$eval('.cb-panel .cb-why', (e) => e.textContent.trim());
  check('an old "use Fit lyrics" hint reads as the score editor one', why.includes('fix in the score editor (Lyrics)') && !why.includes('Fit lyrics'), why);
  check('a "lyrics unsure" bar offers Fix lyrics and Mark all', btns.includes('Fix lyrics') && btns.includes('Mark all as looks right'), btns.join('|'));
  await page.click('.cb-panel [data-a="lyrics"]');
  await page.waitForSelector('.notes-panel.lyrics .ly-bar', { timeout: 8000 }); await sleep(800);
  const lm = await page.evaluate(() => ({ v: window.__editNotes?.lyrics?.verse, at: window.__editNotes?.lyrics?.at, bar: window.__editNotes?.notes.find((n) => n.ref === window.__editNotes.sel[0])?.bar }));
  check('Fix lyrics: the check panel gives way to Edit notes in Lyrics mode, verse 1, bar 2', !(await page.$('.cb-panel')) && lm.v === '1' && lm.bar === 1, JSON.stringify(lm));
  // made-up words from bar 2 on, through Paste text…
  await page.click('.ly-bar [data-ly="paste"]'); await page.waitForSelector('#ly-paste');
  await page.$eval('#ly-paste', (e) => { e.value = 'Sun-ny sun-ny we a-dore the lit-tle cloud of blue'; });
  await page.click('.modal [data-ok]'); await sleep(2500);
  await page.click('.ly-bar [data-ly="save"]'); await page.waitForSelector('.modal [data-mode="this"]');
  await page.click('.modal [data-mode="this"]'); await sleep(3000);
  const x = await xmlOf(sc.id);
  check('saved: words in the score (one per note from bar 2 on: 9)', (x.match(/<lyric/g) || []).length === 9, (x.match(/<lyric/g) || []).length);
  check('bars 2 + 3 checked with the save, bar 4 still to check', marked(x) === '4', marked(x));
  check('the review is back on bar 4', !!(await page.$('.cb-panel')) && (await page.$eval('#cb-count', (e) => e.textContent)) === 'Bar 4 · 1 of 1', await page.$eval('#cb-count', (e) => e.textContent).catch(() => 'none'));
  // one bar left: no Mark all; open a second look with two bars to try it
  await send('POST', `/items/${sc.id}/check`, { bar: 4, action: 'ok' });
  await page.close();
  const sc2 = await send('POST', '/items', { kind: 'score', title: `${title} 2`, musicxmlText: scoreXml(`${title} 2`) });
  writeCheck(sc2.folder);
  const p2 = await b.newPage(); await p2.setViewport(MAC);
  p2.on('pageerror', (e) => errs.push(`markall: ${e.message}`));
  await p2.goto(`${BASE}#/item/${sc2.id}`, { waitUntil: 'networkidle0' });
  await p2.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(1200);
  await p2.click('#sc-check'); await p2.waitForSelector('.cb-panel'); await sleep(500);
  await p2.click('.cb-panel [data-a="all"]'); await p2.waitForSelector('.modal'); await sleep(300);
  check('Mark all asks first', /Mark all 2 bars/.test(await p2.$eval('.modal', (e) => e.textContent)));
  await p2.click('.modal [data-close], .modal button:not(.primary)'); await sleep(400);
  check('Cancel: still 2 to check', marked(await xmlOf(sc2.id)) === '2 3');
  await p2.click('.cb-panel [data-a="all"]'); await p2.waitForSelector('.modal .primary'); await sleep(300);
  await p2.click('.modal .primary'); await sleep(2000);
  check('Mark all: none left, review closed, badge gone', marked(await xmlOf(sc2.id)) === '' && !(await p2.$('.cb-panel')) && (await p2.$eval('#sc-check', (e) => e.hidden)));
  const rows = (await api('/activity')).filter((r) => r.type === 'bar-check' && r.title.includes(`${title} 2`));
  const row = rows[0];
  check('one Activities row for both bars', rows.length === 1, rows.length);
  if (row) { await send('POST', `/activity/${row.id}/undo`, {}); check('its Undo puts both back', marked(await xmlOf(sc2.id)) === '2 3'); }
  await p2.close();
}

await run('Mac', MAC, 'mac');
await lyricsRun();
await run('iPad', IPAD, 'plain');
await run('iPhone', PHONE, 'phone');
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
