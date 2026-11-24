// The item ⋯ menus, exactly, for every kind — against a test server only (BASE, default :5190; DB = its
// meowsic.db, written to make a sing job "run" and to give a score a voice). SHOTS = folder for screenshots.
//   library row ⋯  Info · Move to Trash
//   sheet          Info · Edit pages… · Crop page… · Make a score… · Export ▸ (Print / PDF…, Page 1 as an image) · Move to Trash
//   book           Info · Export ▸ · Move to Trash   (read-only: no page editing, not in Fix pages)
//   score          Info · Edit notes… · (Revert note edits) · Request / Redo singing voice
//                  · Export ▸ (MusicXML, MIDI, Print / PDF…) · Move to Trash — no Kids note names / Chords (toolbar toggles)
//   singing voice  only with lyrics; "Singing voice in progress…" (disabled) while its job runs; "Redo singing voice" once
//                  it has one; the toolbar Voice toggle is hidden until the score has a voice
//   chords         Info · Export ▸ (Print / PDF…, Text file) · Move to Trash
//   Info popup     fields + Save, no Actions section; no "(beta)" anywhere; Crop page… opens the crop in Fix pages
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const DB = process.env.DB || '';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sql = (q) => { if (!DB) throw new Error('DB= the test server’s meowsic.db is needed'); return execFileSync('sqlite3', [DB, q]).toString(); };
const errs = [];

// ---- the test items ----
const T = 'Menus test';
const old = (await api('/items?deleted=true')).concat(await api('/items')).filter((x) => x.title.startsWith(T));
if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
const XML = (lyrics) => `<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${['C', 'D', 'E', 'F'].map((s, k) => `<note><pitch><step>${s}</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type>${lyrics ? `<lyric number="1"><syllabic>single</syllabic><text>la${k}</text></lyric>` : ''}</note>`).join('')}</measure></part></score-partwise>`;
const score = await post('/items', { kind: 'score', title: `${T} score`, version: 'original', bpm: 90, musicxmlText: XML(true) });
const plain = await post('/items', { kind: 'score', title: `${T} no words`, version: 'original', bpm: 90, musicxmlText: XML(false) });
const chords = await post('/items', { kind: 'chords', title: `${T} chords`, source: 'pasted', key: 'C', text: '[C]Twinkle twinkle [G]little star\n[F]How I [C]wonder' });
const mac = await b.newPage(); await mac.setViewport({ width: 1440, height: 900 });
await mac.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const upload = (title, n) => mac.evaluate(async (title, n) => {
  const fd = new FormData(); fd.append('title', title);
  for (let k = 1; k <= n; k++) {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 800); g.fillStyle = '#000'; g.font = 'bold 200px sans-serif'; g.fillText(String(k), 220, 450);
    fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `p${k}.png`);
  }
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, n);
const sheet = await upload(`${T} sheet`, 2);
let book = await upload(`${T} book`, 3);
book = (await post('/items/book', { ids: [book.id], book: true })).items[0];
check('test items made', [score, plain, chords, sheet, book].every((x) => x?.id) && book.book, JSON.stringify([score.id, chords.id, sheet?.id, book?.book]));

// ---- reading a menu: labels in order, '-' for a line, '▸' after a submenu, '(off)' for a disabled entry ----
const readMenu = (p) => p.$$eval('.menu > *', (xs) => xs.map((e) => (e.tagName === 'HR' ? '-' : e.querySelector('span').textContent.trim() + (e.getAttribute('aria-haspopup') ? ' ▸' : '') + (e.disabled ? ' (off)' : ''))).join(' | '));
const openMore = async (p) => { await p.$eval('#it-more', (e) => e.click()); await sleep(300); return readMenu(p); };
const tapMenu = async (p, label) => { await p.evaluate((l) => [...document.querySelectorAll('.menu button')].find((x) => x.querySelector('span').textContent.trim() === l).click(), label); await sleep(350); };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const closeMenu = async (p) => { await p.mouse.click(5, 300); await sleep(150); await p.evaluate(() => document.querySelector('.menu')?.remove()); };
const openItem = async (p, it) => { await p.goto(`${BASE}#/item/${it.id}`, { waitUntil: 'networkidle0' }); await sleep(it.kind === 'score' ? 1800 : 900); };

const SHEET = 'Info | - | Edit pages… | Crop page… | Make a score… | - | Export ▸ | - | Move to Trash';
const BOOK = 'Info | - | Export ▸ | - | Move to Trash';
const SCORE = (sing) => `Info | - | Edit notes… | - | ${sing} | - | Export ▸ | - | Move to Trash`;
const SCORE_PLAIN = 'Info | - | Edit notes… | - | Export ▸ | - | Move to Trash';
const CHORDS = 'Info | - | Export ▸ | - | Move to Trash';

for (const [dev, vp] of [['mac', { width: 1440, height: 900 }], ['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  console.log(dev);
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(`${dev}: ${e.message}`));
  // library row ⋯
  await p.goto(`${BASE}#/library?kind=sheet`, { waitUntil: 'networkidle0' }); await sleep(600);
  await p.type('#lib-q', `${T} sheet`); await sleep(500);
  await p.$eval(`.row[data-id="${sheet.id}"] .row-more`, (e) => e.click()); await sleep(300);
  check(`${dev}: library row ⋯ = Info · Move to Trash`, (await readMenu(p)) === 'Info | - | Move to Trash', await readMenu(p));
  await shot(p, `${dev}-library-row`);
  await tapMenu(p, 'Info');
  check(`${dev}: row ⋯ → Info opens the Info popup`, !!(await p.$('#it-info')));
  await p.keyboard.press('Escape'); await sleep(250); await p.evaluate(() => document.querySelector('.modal-wrap [data-close]')?.click()); await sleep(200);

  // sheet
  await openItem(p, sheet);
  check(`${dev}: sheet ⋯`, (await openMore(p)) === SHEET, await readMenu(p));
  await shot(p, `${dev}-sheet`);
  await tapMenu(p, 'Export');
  check(`${dev}: sheet Export ▸`, (await readMenu(p)) === 'Export | - | Print / PDF… | Page 1 as an image', await readMenu(p));
  await shot(p, `${dev}-sheet-export`);
  await tapMenu(p, 'Export');  // ‹ Export: back
  check(`${dev}: ‹ Export goes back`, (await readMenu(p)) === SHEET, await readMenu(p));
  await tapMenu(p, 'Info');
  const info = await p.evaluate(() => ({ fields: [...document.querySelectorAll('#it-info .if-fields [data-k]')].map((e) => e.dataset.k).join(','), save: !!document.querySelector('#if-save'),
    actions: !!document.querySelector('#it-info .info-actions, #it-info .if-act-head'), tags: !!document.querySelector('#if-tags .tag-pick'), ver: !!document.querySelector('#if-ver') }));
  check(`${dev}: Info = title, artist, album, key, version, tags + Save; no Actions section`, info.fields === 'title,artist,album,key' && info.save && info.tags && info.ver && !info.actions, JSON.stringify(info));
  await shot(p, `${dev}-info`);
  await p.evaluate(() => document.querySelector('#it-info [data-close]')?.click()); await sleep(250);
  // the title opens Info too (it used to rename)
  await p.$eval('#it-title', (e) => e.click()); await sleep(300);
  check(`${dev}: tapping the title opens Info`, !!(await p.$('#it-info')));
  await p.evaluate(() => document.querySelector('#it-info [data-close]')?.click()); await sleep(250);

  // book
  await openItem(p, book);
  check(`${dev}: book ⋯ (read-only)`, (await openMore(p)) === BOOK, await readMenu(p));
  await tapMenu(p, 'Export');
  check(`${dev}: book Export ▸`, (await readMenu(p)) === 'Export | - | Print / PDF… | Page 1 as an image', await readMenu(p));
  await shot(p, `${dev}-book`);
  await closeMenu(p);

  // score: with lyrics, no voice yet
  await openItem(p, score);
  check(`${dev}: score ⋯`, (await openMore(p)) === SCORE('Request singing voice'), await readMenu(p));
  await shot(p, `${dev}-score`);
  await tapMenu(p, 'Export');
  check(`${dev}: score Export ▸`, (await readMenu(p)) === 'Export | - | MusicXML | MIDI | Print / PDF…', await readMenu(p));
  await shot(p, `${dev}-score-export`);
  await closeMenu(p);
  check(`${dev}: no Voice toggle without a voice`, await p.$eval('#sc-voice', (e) => e.hidden));
  check(`${dev}: Kids note names + Chords are toolbar toggles`, !!(await p.$('#sc-names')) && !!(await p.$('#sc-chords')));
  // score without lyrics: no singing voice
  await openItem(p, plain);
  check(`${dev}: score without lyrics: no singing voice`, (await openMore(p)) === SCORE_PLAIN, await readMenu(p));
  await closeMenu(p);

  // chords
  await openItem(p, chords);
  check(`${dev}: chords ⋯`, (await openMore(p)) === CHORDS, await readMenu(p));
  await tapMenu(p, 'Export');
  check(`${dev}: chords Export ▸`, (await readMenu(p)) === 'Export | - | Print / PDF… | Text file', await readMenu(p));
  await shot(p, `${dev}-chords`);
  await closeMenu(p);
  await p.close();
}

// ---- the singing voice: in progress while its job runs, Redo once it has one; the Voice toggle shows then ----
console.log('singing voice');
const jid = `job-menus${Date.now() % 1e6}`;
sql(`INSERT INTO job(id, kind, title, source, outputs, status, log, started_at, params) VALUES ('${jid}','sing','${T} score','Singing voice','["voice"]','running','[]',${Date.now()},'{"fromItemId": "${score.id}"}')`);
for (const [dev, vp] of [['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  const p = await b.newPage(); await p.setViewport(vp);
  await openItem(p, score); await sleep(800);
  check(`${dev}: while the sing job runs: "Singing voice in progress…", disabled`, (await openMore(p)) === SCORE('Singing voice in progress… (off)'), await readMenu(p));
  await shot(p, `${dev}-score-singing`);
  await closeMenu(p); await p.close();
}
check('the job says which score it sings', (await api('/jobs')).find((j) => j.id === jid)?.fromItemId === score.id);
sql(`UPDATE job SET status='failed' WHERE id='${jid}'`);
sql(`UPDATE score SET vocal_audio='voice.wav', vocal_bpm=90 WHERE item_id='${score.id}'`);
sql(`UPDATE item SET updated_at=${Date.now()} WHERE id='${score.id}'`);
for (const [dev, vp] of [['ipad', { width: 1032, height: 1376, hasTouch: true, isMobile: true }], ['iphone', { width: 420, height: 912, hasTouch: true, isMobile: true }]]) {
  const p = await b.newPage(); await p.setViewport(vp);
  await openItem(p, score);
  check(`${dev}: with a voice: "Redo singing voice"`, (await openMore(p)) === SCORE('Redo singing voice'), await readMenu(p));
  await shot(p, `${dev}-score-redo`);
  await closeMenu(p);
  check(`${dev}: with a voice: the Voice toggle shows`, !(await p.$eval('#sc-voice', (e) => e.hidden)));
  await p.close();
}

// ---- what the entries do ----
console.log('actions');
await openItem(mac, score);
const midi = await mac.evaluate(async () => {
  const m = await import('/js/views/score.js');
  const bl = m.midiFile(window.__score.pianoNotes, 90, 0), u = new Uint8Array(await bl.arrayBuffer());
  return { head: String.fromCharCode(...u.slice(0, 4)), trk: String.fromCharCode(...u.slice(14, 18)), notes: window.__score.pianoNotes.length, ons: u.filter((x, i) => x === 0x90 && i > 22).length };
});
check('Export ▸ MIDI: a MIDI file with every note', midi.head === 'MThd' && midi.trk === 'MTrk' && midi.notes === 4 && midi.ons >= 4, JSON.stringify(midi));
await openMore(mac); await tapMenu(mac, 'Export'); await tapMenu(mac, 'Print / PDF…'); await sleep(600);
check('Export ▸ Print / PDF… opens the print view', (await mac.evaluate(() => location.hash)).startsWith(`#/print?item=${score.id}`), await mac.evaluate(() => location.hash));
await openItem(mac, sheet);
await openMore(mac); await tapMenu(mac, 'Crop page…'); await sleep(2500);
check('Crop page… opens the full-screen crop of page 1 in Fix pages', (await mac.evaluate(() => location.hash)) === `#/manage/pages/${sheet.id}/crop/1?back=item` && !!(await mac.$('#cr-stage img')), await mac.evaluate(() => location.hash));
await shot(mac, 'mac-crop');
await mac.click('.mg-back'); await sleep(800);
check('…Cancel returns to the sheet', (await mac.evaluate(() => location.hash)) === `#/item/${sheet.id}`);
await openItem(mac, sheet);
await openMore(mac); await tapMenu(mac, 'Edit pages…'); await sleep(2000);
check('Edit pages… opens this sheet in Fix pages', (await mac.evaluate(() => location.hash)) === `#/manage/pages/${sheet.id}?back=item` && (await mac.$$eval('#pe-grid .pe-tile', (e) => e.length)) === 2);
// old deep links still land there
await mac.goto(`${BASE}#/manage?id=${sheet.id}&back=item&crop=2`, { waitUntil: 'networkidle2' }); await sleep(1200);
check('old #/manage?id=…&crop=2 → the new crop route', (await mac.evaluate(() => location.hash)) === `#/manage/pages/${sheet.id}/crop/2?back=item`);
// books are read-only: not in Fix pages, even asked for by id
await mac.goto(`${BASE}#/manage/pages/${book.id}`, { waitUntil: 'networkidle2' }); await sleep(1500);
check('a book is not editable in Fix pages', !(await mac.$('#pe-grid .pe-tile')));
await mac.goto(`${BASE}#/manage/pages`, { waitUntil: 'networkidle2' }); await sleep(800);
await mac.evaluate(() => document.querySelector('[data-seg="all"]').click()); await sleep(300);
const og = await mac.$$eval('#pk-list [data-id]', (e) => e.map((x) => x.dataset.id));
check('the Fix pages list has the sheet, not the book', !og.includes(book.id) && og.includes(sheet.id), JSON.stringify(og));
await openItem(mac, sheet);
const sm = await openMore(mac); await closeMenu(mac);
check('Make a score is not beta', sm.includes('Make a score…') && !/beta/i.test(sm), sm);
// Move to Trash from the row ⋯ (then put back)
await mac.goto(`${BASE}#/library?kind=chords`, { waitUntil: 'networkidle0' }); await sleep(500);
await mac.$eval(`.row[data-id="${chords.id}"] .row-more`, (e) => e.click()); await sleep(250); await tapMenu(mac, 'Move to Trash'); await sleep(500);
check('row ⋯ → Move to Trash', (await api('/items/' + chords.id)).deleted === true);

await post('/items/purge', { ids: [score.id, plain.id, chords.id, sheet.id, book.id] });
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
