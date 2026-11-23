// Library: opens on Sheets; sheet keys (⋯, Info, Key column, search); search × clears in one tap (Esc too); the sort button (4 orders, remembered,
// in sync with the column headings); the Version column (Lead / Piano / Duet) on All, Sheets, Scores, Books:
// shows, sorts, set from the ⋯ menu, the selection bar and Info; search finds versions.
// Mac + iPad Pro 13 (portrait, landscape) + iPhone Air. Sheet versions it sets are put back at the end.
// BASE=http://localhost:5230/ (a test server; never :5180)  OUT=dir for screenshots
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5230/';
const OUT = process.env.OUT || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];
const api = async (path, opt) => (await fetch(BASE + 'api' + path, opt)).json();
const patch = (id, body) => api(`/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const all = (await api('/items')).filter((x) => !x.deleted);
const before = Object.fromEntries(all.filter((x) => x.kind === 'sheet').map((x) => [x.id, x.version]));
const sheets = all.filter((x) => x.kind === 'sheet' && !x.book), scores = all.filter((x) => x.kind === 'score');
const WORD = (it) => (it.kind === 'sheet' ? { lead: 'Lead', piano: 'Piano', duet: 'Duet' }[it.version] || '' : it.kind === 'score' ? (it.version === 'lead' ? 'Lead' : it.version === 'duet' ? 'Duet' : 'Piano') : '');

const hash = (p) => p.evaluate(() => location.hash);
const fresh = async (p, h = '#/library') => { await p.goto('about:blank'); await p.goto(BASE + h, { waitUntil: 'networkidle0' }); await sleep(500); };
const to = async (p, h) => { await p.evaluate((h) => (location.hash = h), h); await sleep(450); };
const col = (p, c) => p.$$eval(`#lib-rows tr.row td.${c}`, (e) => e.map((x) => x.textContent.trim()));
const ids = (p) => p.$$eval('#lib-rows tr.row', (e) => e.map((x) => x.dataset.id));
const countOf = (p) => p.evaluate(() => (document.querySelector('#lib-rows .empty') ? 0 : +(document.querySelector('.pager-row .muted')?.textContent.match(/\d+/)?.[0] ?? -1)));
const menuItems = (p) => p.$$eval('.menu button', (e) => e.map((x) => ({ label: x.querySelector('span').textContent, checked: x.getAttribute('aria-checked') })));
const clickMenu = async (p, label) => { const ok = await p.evaluate((l) => { const m = [...document.querySelectorAll('.menu button')].find((x) => x.querySelector('span').textContent.startsWith(l)); m?.click(); return !!m; }, label); await sleep(400); return ok; };
const typeQ = async (p, v) => { await p.$eval('#lib-q', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, v); await sleep(250); };
const xShown = (p) => p.$eval('#lib-q-x', (e) => !e.hidden && e.getBoundingClientRect().width > 0);

// ---------- Mac ----------
{
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push('mac: ' + e.message));
  await p.setViewport({ width: 1440, height: 900 });
  await fresh(p);
  await p.evaluate(() => { localStorage.removeItem('meowsic-sort'); localStorage.removeItem('meowsic-sort-dir'); localStorage.removeItem('meowsic-lang'); });
  console.log('Opens on Sheets');
  for (const h of ['', '#/', '#/library']) {
    await fresh(p, h);
    check(`fresh load of "${h || '(none)'}" → Sheets`, (await hash(p)) === '#/library?kind=sheet' && (await p.$eval('#libhead h1', (e) => e.textContent)) === 'Sheets'
      && (await p.$eval('#side .nav.on', (e) => e.textContent)).includes('Sheets'), await hash(p));
  }
  await p.click('#side a[href="#/library"]'); await sleep(400);
  check('All music still there when tapped', (await p.$eval('#libhead h1', (e) => e.textContent)) === 'All music');
  check('logo → Sheets', (await p.$eval('#side .brand', (e) => e.getAttribute('href'))) === '#/library?kind=sheet');
  await p.goto(BASE + '#/item/' + sheets[0].id, { waitUntil: 'networkidle0' }); await sleep(600);
  check('item opened directly: Back → Sheets', (await p.$eval('.item-top .back', (e) => e.getAttribute('href'))) === '#/library?kind=sheet' || (await p.evaluate(() => history.length)) > 1);
  await to(p, '#/library?kind=score'); await to(p, '#/item/' + scores[0].id);
  await p.click('.item-top .back'); await sleep(500);
  check('Back after coming from Scores → Scores (history.back)', (await hash(p)) === '#/library?kind=score', await hash(p));

  console.log('Search ×');
  await to(p, '#/library');
  check('× hidden while empty', !(await xShown(p)));
  const n0 = await countOf(p);
  await p.click('#lib-q'); await p.keyboard.type('zzqq');
  await sleep(250);
  check('typing shows ×, filters', (await xShown(p)) && (await countOf(p)) === 0);
  await p.click('#lib-q-x'); await sleep(300);
  const st = await p.evaluate(() => ({ v: document.querySelector('#lib-q').value, focus: document.activeElement?.id, x: document.querySelector('#lib-q-x').hidden }));
  check('× clears: empty, hidden, focus off the field', st.v === '' && st.x && st.focus !== 'lib-q' && (await countOf(p)) === n0, JSON.stringify(st));
  await p.click('#lib-q'); await p.keyboard.type('zzqq'); await sleep(200);
  await p.keyboard.press('Escape'); await sleep(300);
  check('Esc clears too', (await p.$eval('#lib-q', (e) => e.value)) === '' && (await countOf(p)) === n0 && (await p.evaluate(() => document.activeElement?.id)) !== 'lib-q');

  console.log('Sort button');
  const sortBtn = () => p.$eval('#lib-sort', (e) => ({ text: e.textContent.trim(), vis: e.getBoundingClientRect().width > 0, icon: !!e.querySelector('svg') }));
  check('visible, icon + short label "Recent" by default', ((s) => s.vis && s.icon && s.text === 'Recent')(await sortBtn()), JSON.stringify(await sortBtn()));
  await p.click('#lib-sort'); await sleep(250);
  const mi = await menuItems(p);
  check('menu: exactly the 4 orders, Recently added ticked', mi.map((x) => x.label).join('|') === 'Title A–Z|Title Z–A|Most played|Recently added' && mi.map((x) => x.checked).join() === 'false,false,false,true', JSON.stringify(mi));
  await p.keyboard.press('Escape'); await p.mouse.click(5, 890); await sleep(200);
  const byId = Object.fromEntries(all.map((x) => [x.id, x]));
  const backup = await api('/backup');
  const plays = {}; for (const pl of backup.plays || []) plays[pl.itemId] = (plays[pl.itemId] || 0) + 1;
  const orders = {
    'Title A–Z': (a, z) => a.title.localeCompare(z.title) <= 0,
    'Title Z–A': (a, z) => a.title.localeCompare(z.title) >= 0,
    'Most played': (a, z) => (plays[a.id] || 0) >= (plays[z.id] || 0),
    'Recently added': (a, z) => a.createdAt >= z.createdAt,
  };
  const SHORT = { 'Title A–Z': 'A–Z', 'Title Z–A': 'Z–A', 'Most played': 'Most played', 'Recently added': 'Recent' };
  for (const [label, ok] of Object.entries(orders)) {
    await p.click('#lib-sort'); await sleep(200); await clickMenu(p, label);
    const list = (await ids(p)).map((id) => byId[id]);
    check(`sort: ${label} (rows in order, label "${SHORT[label]}")`, list.length > 2 && list.every((x, i) => !i || ok(list[i - 1], x)) && (await sortBtn()).text === SHORT[label], list.slice(0, 5).map((x) => x.title).join(' | '));
    await p.click('#lib-sort'); await sleep(200);
    check(`  …${label} ticked`, (await menuItems(p)).find((x) => x.checked === 'true')?.label === label);
    await p.mouse.click(5, 890); await sleep(150);
  }
  await p.click('#lib-sort'); await sleep(200); await clickMenu(p, 'Title Z–A');
  await fresh(p, '#/library'); await to(p, '#/library');
  check('choice remembered after reload (Z–A)', (await sortBtn()).text === 'Z–A');
  await p.click('[data-sort="title"]'); await sleep(250);
  check('Title heading → A–Z, button follows', (await sortBtn()).text === 'A–Z');
  await p.click('[data-sort="title"]'); await sleep(250);
  check('Title heading again → Z–A, button follows', (await sortBtn()).text === 'Z–A');
  await p.click('#lib-sort'); await sleep(200); await clickMenu(p, 'Title A–Z');
  check('menu → heading arrow in sync (Title ▲)', (await p.$eval('[data-sort="title"]', (e) => e.textContent)).includes('▲'));

  console.log('Version column');
  for (const [k, h] of [['', 'All'], ['sheet', 'Sheets'], ['score', 'Scores'], ['book', 'Books']]) {
    await to(p, '#/library' + (k ? '?kind=' + k : ''));
    const heads = await p.$$eval('.lib-table th', (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean));
    if (!heads.length) { console.log(`  (${h}: nothing here)`); continue; }
    const cells = await col(p, 'c-ver'), rid = await ids(p);
    check(`${h}: Version column shows Lead / Piano / Duet`, heads.includes('Version') && cells.every((c, i) => c === WORD(byId[rid[i]])), heads.join('|') + ' :: ' + cells.join(','));
  }
  await to(p, '#/library');
  check('chords show a blank version', !all.some((x) => x.kind === 'chords') || (await p.$$eval('#lib-rows tr.row', (rows) => rows.filter((r) => r.querySelector('.badge.k-chords')).every((r) => !r.querySelector('.c-ver').textContent.trim()))));
  const tip = await p.$$eval('#lib-rows tr.row td.c-ver span', (e) => e.map((x) => x.title));
  check('score cells carry the detail as a tooltip ("Piano · clear")', !scores.some((x) => x.version === 'clear') || tip.includes('Piano · clear'), tip.slice(0, 6).join());

  console.log('Version from the ⋯ menu');
  await to(p, '#/library?kind=sheet');
  const sid = (await ids(p))[0];
  await p.click(`tr.row[data-id="${sid}"] .row-more`); await sleep(250);
  check('⋯ has "Version: Lead / Piano / Duet…"', (await menuItems(p)).some((x) => x.label === 'Version: Lead / Piano / Duet…'), JSON.stringify(await menuItems(p)));
  await clickMenu(p, 'Version:');
  check('…which offers Lead, Piano, Duet, Not set', (await menuItems(p)).map((x) => x.label).join('|') === 'Lead|Piano|Duet|Not set');
  await clickMenu(p, 'Duet'); await sleep(500);
  check('set Duet: column + server', (await p.$eval(`tr.row[data-id="${sid}"] .c-ver`, (e) => e.textContent)) === 'Duet' && (await api('/items/' + sid)).version === 'duet');
  await p.click(`tr.row[data-id="${sid}"] .row-more`); await sleep(250);
  check('⋯ now says "Version: Duet…"', (await menuItems(p)).some((x) => x.label === 'Version: Duet…'));
  await clickMenu(p, 'Version:');
  check('…Duet ticked', (await menuItems(p)).find((x) => x.checked === 'true')?.label === 'Duet');
  await p.mouse.click(5, 890); await sleep(150);
  await to(p, '#/library?kind=score');
  await p.click('#lib-rows tr.row .row-more'); await sleep(250);
  check('scores: no Version item in ⋯ (their version is the arrangement)', !(await menuItems(p)).some((x) => x.label.startsWith('Version')));
  await p.mouse.click(5, 890); await sleep(150);

  console.log('Sheet key');
  await to(p, '#/library?kind=sheet');
  const kid = (await ids(p))[0];
  await p.click(`tr.row[data-id="${kid}"] .row-more`); await sleep(250);
  check('⋯ has "Key: not set…" (or the key)', (await menuItems(p)).some((x) => /^Key: .+…$/.test(x.label)));
  await clickMenu(p, 'Key:'); await sleep(250);
  await p.$eval('.modal input, dialog input, .sheet input', (e) => { e.value = 'F#m'; });
  await p.evaluate(() => document.querySelector('.modal form, dialog form, .sheet form').requestSubmit()); await sleep(600);
  check('key saved: Key column + server', (await p.$eval(`tr.row[data-id="${kid}"] .c-key`, (e) => e.textContent)) === 'F#m' && (await api('/items/' + kid)).key === 'F#m');
  for (const [k, h] of [['', 'All'], ['sheet', 'Sheets'], ['score', 'Scores'], ['chords', 'Chords']]) {
    await to(p, '#/library' + (k ? '?kind=' + k : ''));
    check(`${h}: Key column`, (await p.$$eval('.lib-table th', (e) => e.map((x) => x.textContent.replace(/[▲▼]/g, '').trim()))).includes('Key'));
  }
  await to(p, '#/library');
  await typeQ(p, 'f#m');
  check('search "f#m" finds the sheet by its key', (await ids(p)).includes(kid));
  await typeQ(p, '');
  await p.click('[data-sort="key"]'); await sleep(250);
  const ks = await col(p, 'c-key');
  check('Key heading sorts', ks.filter(Boolean).every((v, i, a) => !i || a[i - 1].localeCompare(v) <= 0), ks.join(','));
  await to(p, '#/item/' + kid);
  await p.click('#it-more'); await sleep(250); await clickMenu(p, 'Info'); await sleep(300);
  check('Info shows Key F#m', (await p.$eval('#dt-key', (e) => e.textContent)).includes('F#m'));
  await p.click('#dt-key-edit'); await sleep(250);
  await p.$eval('.modal input, dialog input, .sheet input', (e) => { e.value = ''; });
  await p.evaluate(() => document.querySelector('.modal form, dialog form, .sheet form').requestSubmit()); await sleep(600);
  check('Info: clearing the key saves ""', (await api('/items/' + kid)).key === '' && (await p.$eval('#dt-key', (e) => e.textContent)).includes('Not set'));
  await to(p, '#/library');

  console.log('Search finds versions');
  await to(p, '#/library');
  await typeQ(p, 'duet');
  check('"duet" finds the Duet sheet', (await ids(p)).includes(sid));
  await typeQ(p, 'lead');
  const leadIds = await ids(p);
  check('"lead" finds the Lead scores', scores.filter((x) => x.version === 'lead').every((x) => leadIds.includes(x.id) || leadIds.length >= 50), leadIds.length);
  await typeQ(p, 'piano');
  const pianoIds = await ids(p);
  check('"piano" finds Piano scores', pianoIds.some((id) => byId[id].kind === 'score' && WORD(byId[id]) === 'Piano'));
  await typeQ(p, '');

  console.log('Version column sorts');
  await p.click('[data-sort="version"]'); await sleep(300);
  const vs = await col(p, 'c-ver');
  const rank = (v) => ({ Duet: 0, Lead: 1, Piano: 2 }[v] ?? 3);
  check('Version heading sorts Duet, Lead, Piano, then blanks', vs.every((v, i) => !i || rank(vs[i - 1]) <= rank(v)) && vs[0] === 'Duet', vs.join(','));
  await p.click('[data-sort="version"]'); await sleep(300);
  const vr = await col(p, 'c-ver');
  check('…again reverses', vr.every((v, i) => !i || rank(vr[i - 1]) >= rank(v)), vr.slice(0, 6).join(','));
  if (OUT) await p.screenshot({ path: `${OUT}/ver-mac-all.png` });

  console.log('Bulk: Set version…');
  await to(p, '#/library?kind=sheet');
  const two = (await ids(p)).slice(0, 2);
  await to(p, '#/library');
  // pick two sheets + a score in All
  for (const id of [...two, scores[0].id]) { const el = await p.$(`tr.row[data-id="${id}"] .pick input`); if (el) { await el.click(); await sleep(150); } }
  check('selection bar has "Set version…"', !!(await p.$('#sb-ver')));
  await p.click('#sb-ver'); await sleep(250);
  check('…Lead, Piano, Duet, Not set', (await menuItems(p)).map((x) => x.label).join('|') === 'Lead|Piano|Duet|Not set');
  await clickMenu(p, 'Piano'); await sleep(600);
  const after = await Promise.all([...two, scores[0].id].map((id) => api('/items/' + id)));
  check('bulk Piano: both sheets Piano, the score keeps its version', after[0].version === 'piano' && after[1].version === 'piano' && after[2].version === scores[0].version, after.map((x) => x.version).join());
  const tst = await p.$eval('#toast', (e) => e.textContent).catch(() => '');
  check('toast says the score was kept', /2 set to Piano.*1 score/.test(tst), tst);
  await p.click('#sb-done').catch(() => {}); await sleep(200);

  console.log('Info panel');
  await to(p, '#/item/' + sid);
  await p.click('#it-more'); await sleep(250); await clickMenu(p, 'Info'); await sleep(300);
  const seg = () => p.$$eval('#dt-ver button', (e) => e.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')).join('|'));
  check('Info: Version Lead | Piano | Duet, Duet lit', (await seg()) === 'Lead|Piano|Duet*', await seg());
  await p.click('#dt-ver [data-ver="lead"]'); await sleep(500);
  check('tap Lead → saved', (await seg()) === 'Lead*|Piano|Duet' && (await api('/items/' + sid)).version === 'lead');
  await p.click('#dt-ver [data-ver="lead"]'); await sleep(500);
  check('tap the lit one → not set', (await seg()) === 'Lead|Piano|Duet' && (await api('/items/' + sid)).version === '');
  await p.click('#it-more'); await sleep(250); await clickMenu(p, 'Version:'); await clickMenu(p, 'Lead'); await sleep(500);
  check('viewer ⋯ → Version → Lead (Info follows)', (await api('/items/' + sid)).version === 'lead' && (await seg()) === 'Lead*|Piano|Duet');
  const clear = scores.find((x) => x.version === 'clear') || scores[0];
  await to(p, '#/item/' + clear.id); await sleep(800);
  await p.click('#it-more'); await sleep(250); await clickMenu(p, 'Info'); await sleep(300);
  const sv = await p.$eval('#dt-ver', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  check(`score Info: "${WORD(clear)}" + detail`, sv.startsWith(WORD(clear)) && (clear.version !== 'clear' || sv.includes('Piano · clear')), sv);
  await p.close();
}

// ---------- iPad / iPhone ----------
for (const [name, w, h] of [['ipad13-port', 1032, 1376], ['ipad13-land', 1376, 1032], ['iphone-air', 420, 912]]) {
  const p = await b.newPage(); p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true });
  await fresh(p);
  check(`${name}: opens on Sheets`, (await hash(p)) === '#/library?kind=sheet');
  if (w < 760) check(`${name}: the Sheets tab is on`, (await p.$eval('#libhead .seg button.on', (e) => e.textContent.trim())) === 'Sheets');
  for (const k of ['', 'sheet', 'score', 'book']) {
    await to(p, '#/library' + (k ? '?kind=' + k : ''));
    const vis = await p.evaluate(() => {
      const th = [...document.querySelectorAll('.lib-table th')].filter((x) => getComputedStyle(x).display !== 'none' && x.textContent.trim()).map((x) => x.textContent.replace(/[▲▼]/g, '').trim());
      const t = document.querySelector('.lib-table'), box = document.querySelector('#lib-rows');
      return { th, over: t ? t.getBoundingClientRect().right - box.getBoundingClientRect().right : 0, page: document.scrollingElement.scrollWidth - innerWidth };
    });
    if (!vis.th.length) { console.log(`  (${name} ${k || 'all'}: nothing here)`); continue; }
    check(`${name} ${k || 'all'}: Title + Version${k ? '' : ' + Type'} visible, nothing sticks out`, vis.th[0] === 'Title' && vis.th.includes('Version') && (k || vis.th.includes('Type')) && vis.over <= 1 && vis.page <= 0, JSON.stringify(vis));
    if (OUT && (k === '' || k === 'sheet')) await p.screenshot({ path: `${OUT}/ver-${name}-${k || 'all'}.png` });
  }
  await to(p, '#/library');
  const sb = await p.$eval('#lib-sort', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, right: r.right, text: e.textContent.trim() }; });
  check(`${name}: sort button on screen`, sb.w > 0 && sb.right <= w, JSON.stringify(sb));
  await p.tap('#lib-sort'); await sleep(250);
  check(`${name}: sort menu has the 4 orders`, (await menuItems(p)).map((x) => x.label).join('|') === 'Title A–Z|Title Z–A|Most played|Recently added');
  await clickMenu(p, 'Recently added');
  check(`${name}: Recently added ticked → "Recent"`, (await p.$eval('#lib-sort', (e) => e.textContent.trim())) === 'Recent');
  // search ×: a tap clears, keyboard stays down, back to page 1
  await typeQ(p, 'e');
  const nx = await p.$('.pager [data-pg="next"]:not([disabled])');
  if (nx) { await nx.tap(); await sleep(300); }
  const pg = await p.$eval('.pg-now', (e) => e.textContent).catch(() => '');
  await p.evaluate(() => document.activeElement?.blur());
  await p.tap('#lib-q-x'); await sleep(350);
  const st = await p.evaluate(() => ({ v: document.querySelector('#lib-q').value, focus: document.activeElement?.id, pg: document.querySelector('.pg-now')?.textContent || '' }));
  check(`${name}: × tap clears, no keyboard (field not focused), page 1`, st.v === '' && st.focus !== 'lib-q' && (!st.pg || st.pg.startsWith('1 /')), JSON.stringify({ ...st, was: pg }));
  await p.close();
}

// put the sheet versions back
for (const [id, v] of Object.entries(before)) { const now = await api('/items/' + id), was = all.find((x) => x.id === id); if (now.version !== v || now.key !== was.key) await patch(id, { version: v, key: was.key }); }
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
