// Song info: Album column (Mac only; iPad / iPhone stay compact), no tags in any library list (the tag filter and search
// still use them), the viewer's ⋯ holds only Info, the Info popup shows + edits everything (voice-mic fields, Save /
// Cancel, one PATCH, undoable) and carries the item's actions (no Make it a book). iPhone: Info is full screen.
// Mac + iPad Pro 13 + iPhone. BASE=http://127.0.0.1:5290/ (a test server on a data copy; never :5180)
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:5290/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const api = async (path, opt) => (await fetch(BASE + 'api' + path, opt)).json();
const patch = (id, body) => api(`/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const all = (await api('/items')).filter((x) => !x.deleted);
const sheet = all.find((x) => x.kind === 'sheet' && !x.book && x.tags.length);
const score = all.find((x) => x.kind === 'score' && x.musicxml);
const chord = all.find((x) => x.kind === 'chords');
const keep = Object.fromEntries([sheet, score, chord].map((x) => [x.id, { title: x.title, artist: x.artist, album: x.album, key: x.key }]));
await patch(sheet.id, { album: 'Zz Test Album' });

const DEV = {
  mac: { viewport: { width: 1440, height: 900 } },
  ipad: { viewport: { width: 1024, height: 1366, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  iphone: { viewport: { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
};
const shown = (p, sel) => p.$$eval(sel, (e) => e.filter((x) => x.getBoundingClientRect().width > 0).length);
const heads = (p) => p.$$eval('.lib-table th', (e) => e.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean));
const tap = (p, sel) => (p.viewport()?.hasTouch ? p.tap(sel) : p.click(sel));
const openInfo = async (p) => {
  await tap(p, '#it-more'); await sleep(250);
  const menu = await p.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  await p.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Info')?.click()); await sleep(400);
  return menu;
};

for (const [name, d] of Object.entries(DEV)) {
  console.log(name);
  await patch(sheet.id, { album: 'Zz Test Album' });
  const p = await b.newPage();
  if (d.ua) await p.setUserAgent(d.ua);
  await p.setViewport(d.viewport);
  p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  for (const kind of ['', 'sheet', 'score', 'chords', 'book']) {
    await p.goto(`${BASE}#/library${kind ? '?kind=' + kind : ''}`, { waitUntil: 'networkidle0' }); await sleep(600);
    const h = await heads(p);
    check(`${name} ${kind || 'all'}: no tags in the list`, !h.includes('Tag') && (await shown(p, '#lib-rows .tagchip, #lib-rows .c-tag')) === 0, h.join('|'));
    if (name === 'mac') check(`mac ${kind || 'all'}: Album column`, h.includes('Album') && h.indexOf('Album') === h.indexOf('Artist') + 1, h.join('|'));
    else check(`${name} ${kind || 'all'}: no Album / Artist column (compact)`, !h.includes('Album') && !h.includes('Artist'), h.join('|'));
    if (kind === 'chords' && name === 'mac') check('mac chords: Version column', h.includes('Version'), h.join('|'));
  }
  await p.goto(`${BASE}#/library?kind=sheet`, { waitUntil: 'networkidle0' }); await sleep(600);
  await p.$eval('#lib-q', (e) => { e.value = 'zz test album'; e.dispatchEvent(new Event('input')); }); await sleep(300);
  { const ids = await p.$$eval('#lib-rows tr.row', (e) => e.map((x) => x.dataset.id)); check(`${name}: search finds the album`, ids.join() === sheet.id, ids.join()); }
  if (name === 'mac') check('mac: the album shows in its column', (await p.$eval(`#lib-rows tr[data-id="${sheet.id}"] td.c-album`, (e) => e.textContent)) === 'Zz Test Album');
  await p.$eval('#lib-q', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await sleep(200);
  await p.goto(`${BASE}#/library?tags=${encodeURIComponent(sheet.tags[0])}`, { waitUntil: 'networkidle0' }); await sleep(600);
  const n = all.filter((x) => x.tags.includes(sheet.tags[0])).length;
  check(`${name}: the tag filter still works`, await p.evaluate(() => +(document.querySelector('.pager-row .muted')?.textContent.match(/\d+/)?.[0] ?? -1)) === n);

  // the viewer: ⋯ = Info only; the popup
  await p.goto(`${BASE}#/item/${sheet.id}`, { waitUntil: 'networkidle0' }); await sleep(900);
  const menu = await openInfo(p);
  check(`${name}: sheet ⋯ holds only Info`, menu.join('|') === 'Info', menu.join('|'));
  check(`${name}: Info popup with every field`, (await p.$$('#if-title, #if-artist, #if-album, #if-key, #if-ver, #if-tags, #if-save')).length === 7);
  const facts = await p.$eval('.if-facts', (e) => e.textContent);
  check(`${name}: Info shows type, pages, file, practice, dates`, ['Type', 'Pages', 'File', 'Practice', 'Added'].every((w) => facts.includes(w)), facts.slice(0, 200));
  const acts = await p.$$eval('.info-actions button', (e) => e.map((x) => x.textContent.trim()));
  check(`${name}: sheet actions in Info (Rename, Edit tags, Edit pages, Print, Trash), no book toggle`, ['Rename…', 'Edit tags…', 'Edit pages…', 'Print…', 'Move to Trash'].every((a) => acts.includes(a)) && !acts.some((a) => /book/i.test(a)), acts.join('|'));
  if (name === 'iphone') {
    const r = await p.$eval('.info-modal', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; });
    check('iphone: Info is full screen', Math.abs(r[0] - r[2]) < 2 && Math.abs(r[1] - r[3]) < 2, r.join());
  }
  await sleep(200);
  check(`${name}: voice mic on the Album field`, await p.$eval('#if-album', (e) => !!e.parentElement.querySelector('.ti-mic')));
  // Cancel keeps it, Save writes it (one PATCH; undoable from Activities)
  await p.$eval('#if-album', (e) => { e.value = 'Not saved'; });
  await p.evaluate(() => [...document.querySelectorAll('.info-head button')].find((x) => x.textContent === 'Cancel').click()); await sleep(400);
  check(`${name}: Cancel saves nothing`, (await api('/items/' + sheet.id)).album === 'Zz Test Album');
  await openInfo(p);
  await p.$eval('#if-album', (e) => { e.value = `Album ${e.ownerDocument.defaultView.innerWidth}`; });
  await p.$eval('#if-artist', (e) => { e.value = 'Tester Person'; });
  await p.$eval('#if-key', (e) => { e.value = 'F#m'; });
  const want = (await api('/items/' + sheet.id)).version === 'duet' ? 'lead' : 'duet';
  await tap(p, `#if-ver [data-ver="${want}"]`);
  await tap(p, '#if-save'); await sleep(700);
  let it = await api('/items/' + sheet.id);
  check(`${name}: Save writes artist, album, key, version`, it.album === `Album ${d.viewport.width}` && it.artist === 'Tester Person' && it.key === 'F#m' && it.version === want, JSON.stringify([it.album, it.artist, it.key, it.version]));
  const act = (await api('/activity')).find((a) => a.type === 'edit');
  check(`${name}: one undoable Activities row`, act && /album/.test(act.detail) && act.undo !== false, JSON.stringify(act).slice(0, 200));
  // an action from the popup runs (Rename… opens its sheet)
  await openInfo(p);
  await p.evaluate(() => [...document.querySelectorAll('.info-actions button')].find((x) => x.textContent.trim() === 'Rename…').click()); await sleep(400);
  check(`${name}: an action from Info runs (Rename…)`, (await p.$eval('.modal h2', (e) => e.textContent)) === 'Rename' && !(await p.$('#it-info')));
  await p.keyboard.press('Escape'); await sleep(200);
  // score + chord chart
  await p.goto(`${BASE}#/item/${score.id}`, { waitUntil: 'networkidle0' }); await sleep(2000);
  check(`${name}: score ⋯ holds only Info`, (await openInfo(p)).join('|') === 'Info');
  const sa = await p.$$eval('.info-actions button', (e) => e.map((x) => x.textContent.trim()));
  check(`${name}: score actions from score.js show in Info`, sa.some((a) => a.startsWith('Make another version')) && sa.includes('Export as MusicXML'), sa.join('|'));
  check(`${name}: score Info shows its source`, !!(await p.$('#dt-source')));
  await p.keyboard.press('Escape'); await sleep(200);
  await p.goto(`${BASE}#/item/${chord.id}`, { waitUntil: 'networkidle0' }); await sleep(900);
  check(`${name}: chord ⋯ holds only Info`, (await openInfo(p)).join('|') === 'Info');
  check(`${name}: chord Info has a Version choice`, (await p.$$('#if-ver [data-ver]')).length === 3);
  await p.keyboard.press('Escape');
  if (name === 'mac') {  // the drawn score credits: the real artist + "… by Meowsic"
    await patch(score.id, { artist: 'Real Composer' });
    await p.goto(`${BASE}#/item/${score.id}`, { waitUntil: 'networkidle0' }); await p.reload({ waitUntil: 'networkidle0' }); await sleep(3000);
    const t = await p.$$eval('#osmd svg text', (e) => e.map((x) => x.textContent));
    check('mac: score draws the real artist and what Meowsic did', t.includes('Real Composer') && t.some((x) => /^(Made|Transcribed|Arranged|Read) by Meowsic$/.test(x)), t.filter((x) => /Meowsic|Composer|Real/.test(x)).join(' | ') + ' / ' + t.length);
  }
  await p.close();
}
for (const [id, v] of Object.entries(keep)) await patch(id, v);
await patch(sheet.id, { version: '' });
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
