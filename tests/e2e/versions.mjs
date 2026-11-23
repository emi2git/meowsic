// Clean up → Versions against a test server (BASE, default :5190). Never the real library.
// Makes the song "Vtest Song" four times (three sheets with other suffixes + a score) and "Vtest Other" twice,
// then: groups shown, Keep only this one, undo, keys, saved after reload, Not the same + undo,
// Finish → Trash → Undo restores → delete for good; and that it fits iPad Pro 13 / iPhone Air without page scrolling.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const post = (p, body) => fetch(BASE + 'api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const newPage = async (vp) => {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(m.text()));
  return p;
};
const KEY = 't:vtest song', OTHER = 't:vtest other';

// ---- test items (old ones from an earlier run go for good first) ----
const old = (await api('/items')).concat(await api('/items?deleted=true')).filter((x) => /^v ?test/i.test(x.title));
if (old.length) await post('/items/purge', { ids: old.map((x) => x.id) });
const page = await newPage({ width: 1440, height: 900 });
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
const mk = (title, n) => page.evaluate(async (title, n) => {
  const fd = new FormData(); fd.append('title', title);
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const g = c.getContext('2d'); g.fillStyle = `hsl(${n * 70},70%,70%)`; g.fillRect(0, 0, 600, 800);
  g.fillStyle = '#000'; g.font = 'bold 60px sans-serif'; g.fillText(title, 20, 120); g.font = '20px sans-serif'; g.fillText(String(Date.now() + Math.random()), 20, 760);
  fd.append('files', await new Promise((r) => c.toBlob(r, 'image/png')), `v${n}.png`);
  return (await (await fetch('/api/sheets', { method: 'POST', body: fd })).json()).item;
}, title, n);
const s1 = await mk('Vtest Song', 1), s2 = await mk('Vtest Song (C)', 2), s3 = await mk('vtest song — p7', 3);
const anyScore = (await api('/items')).find((x) => x.kind === 'score' && x.musicxml);
const xml = anyScore ? await (await fetch(`${BASE}api/items/${anyScore.id}/musicxml`)).text() : null;
const sc = await (await post('/items', { kind: 'score', title: 'Vtest Song - Sheet Music', version: 'lead', ...(xml ? { musicxmlText: xml } : {}) })).json();
const o1 = await mk('Vtest Other', 4), o2 = await mk('Vtest Other (Easy Piano)', 5);
const ids = [s1.id, s2.id, s3.id, sc.id];
await post('/versions/decide', { set: Object.fromEntries([...ids, o1.id, o2.id].map((i) => [i, null])) });

let st = await api('/versions');
const gOf = (key) => st.groups.find((g) => g.key === key);
check('API groups the four copies of Vtest Song', gOf(KEY) && gOf(KEY).ids.length === 4 && ids.every((i) => gOf(KEY).ids.includes(i)), JSON.stringify(gOf(KEY)));
check('API groups Vtest Other', gOf(OTHER)?.ids.length === 2);
const sizes = st.groups.filter((g) => !g.notSame).map((g) => g.ids.length);
check('biggest groups first', sizes.every((n, k) => !k || sizes[k - 1] >= n), sizes.join());

// ---- Mac: open the tab on Vtest Song ----
await page.evaluate((k) => { localStorage.setItem('meowsic-cu-tab', 'versions'); localStorage.setItem('meowsic-cu-vkey', k); }, KEY);
await page.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
const name = () => page.$eval('#vv-name', (e) => e.textContent).catch(() => '');
const decs = async () => (await api('/versions')).decisions;
const cards = () => page.$$eval('.vv-card', (e) => e.map((x) => ({ id: x.dataset.id, cls: x.className })));
check('Versions tab is on', await page.$eval('[data-tab="versions"]', (e) => e.classList.contains('on')));
check('the group is shown', (await name()).toLowerCase().startsWith('vtest song'), await name());
check('four cards side by side', (await cards()).length === 4);
const cnt = await page.$eval('#vv-count', (e) => e.textContent);
check('counts shown (songs · items)', new RegExp(`^${st.counts.groups} songs · ${st.counts.items} items$`).test(cnt), cnt);
check('sheet preview is page 1', await page.$eval(`.vv-card[data-id="${s1.id}"] img`, (e) => e.src.includes(`/thumb/1?w=600`)));
if (xml) { await sleep(2500); check('score preview drawn', await page.$eval(`.vv-card[data-id="${sc.id}"] .vv-art`, (e) => !!e.querySelector('svg')), await page.$eval(`.vv-card[data-id="${sc.id}"] .vv-art`, (e) => e.innerHTML.slice(0, 80))); }
check('card shows type and version', /Score/.test(await page.$eval(`.vv-card[data-id="${sc.id}"] .vv-meta`, (e) => e.textContent)) && /Lead/.test(await page.$eval(`.vv-card[data-id="${sc.id}"] .vv-meta`, (e) => e.textContent)));
await page.screenshot({ path: 'versions-mac.png' });

// Keep only this one (card 2) marks the others Delete, then moves on
await page.click(`.vv-card[data-id="${s2.id}"] [data-only]`); await sleep(500);
let d = await decs();
check('Keep only this one: it is kept, the others marked delete', d[s2.id] === 'keep' && [s1.id, s3.id, sc.id].every((i) => d[i] === 'delete'), JSON.stringify(d));
check('…and goes on to another song', !(await name()).toLowerCase().startsWith('vtest song'), await name());
await page.click('#cu-undo'); await sleep(600);
d = await decs();
check('Undo takes all the marks back and returns to the song', !ids.some((i) => d[i]) && (await name()).toLowerCase().startsWith('vtest song'), JSON.stringify(d) + ' ' + await name());

// keys: 1 and 3 toggle Delete; K keeps all; Z undoes; → ← move between songs
await page.keyboard.press('1'); await sleep(300); await page.keyboard.press('3'); await sleep(400);
d = await decs();
check('keys 1 / 3 mark those versions delete', d[s1.id] === 'delete' && d[s3.id] === 'delete' && !d[s2.id], JSON.stringify(d));
check('cards show the marks', (await cards()).filter((c) => c.cls.includes('delete')).length === 2);
await page.keyboard.press('1'); await sleep(400);
check('1 again: keep', (await decs())[s1.id] === 'keep');
await page.keyboard.press('z'); await sleep(500);
check('Z undoes it', (await decs())[s1.id] === 'delete');
const n0 = await name();
await page.keyboard.press('ArrowRight'); await sleep(300);
const n1 = await name();
await page.keyboard.press('ArrowLeft'); await sleep(300);
check('→ / ← move between songs', n1 !== n0 && (await name()) === n0, `${n0} → ${n1} → ${await name()}`);

// saved on the Mac: a reload shows the same marks
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
const cs = await cards();
check('after reload: same song, same marks', (await name()) === n0 && cs.find((c) => c.id === s1.id).cls.includes('delete') && cs.find((c) => c.id === s3.id).cls.includes('delete') && !cs.find((c) => c.id === s2.id).cls.match(/delete|keep/), JSON.stringify(cs));

// Not the same song: Vtest Other disappears; undo brings it back
await page.evaluate((k) => localStorage.setItem('meowsic-cu-vkey', k), OTHER);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
check('Vtest Other shown', (await name()).startsWith('Vtest Other'), await name());
await page.click('#vv-notsame'); await sleep(600);
st = await api('/versions');
check('Not the same song hides the group (saved)', gOf(OTHER).notSame && !(await name()).startsWith('Vtest Other'));
await page.click('#cu-undo'); await sleep(600);
st = await api('/versions');
check('Undo brings it back', !gOf(OTHER).notSame && (await name()).startsWith('Vtest Other'), await name());

// ---- Finish: summary → Trash → Undo → for good ----
await page.click('#vv-finish'); await sleep(400);
const listed = await page.$$eval('.vv-sumbody [data-id]', (e) => e.map((x) => x.dataset.id));
check('summary lists the two marked items', listed.length === 2 && listed.includes(s1.id) && listed.includes(s3.id), listed.join());
await page.screenshot({ path: 'versions-summary.png' });
await page.click('#vv-go'); await sleep(300);
check('asks first', !!(await page.$('.modal [data-ok]')));
await page.click('.modal [data-ok]'); await sleep(900);
let trash = (await api('/items?deleted=true')).map((x) => x.id);
check('Delete moves them to the Trash', trash.includes(s1.id) && trash.includes(s3.id) && !trash.includes(s2.id));
check('done screen offers delete for good', !!(await page.$('#vv-purge')));
st = await api('/versions');
check('the group now has the two left', gOf(KEY)?.ids.length === 2, JSON.stringify(gOf(KEY)));
await page.click('#cu-undo'); await sleep(1200);
trash = (await api('/items?deleted=true')).map((x) => x.id);
d = await decs();
check('Undo restores them, still marked delete', !trash.includes(s1.id) && !trash.includes(s3.id) && d[s1.id] === 'delete' && d[s3.id] === 'delete', JSON.stringify(d));
check('…back on the summary', (await page.$$eval('.vv-sumbody [data-id]', (e) => e.length)) === 2);
await page.click('#vv-go'); await sleep(300); await page.click('.modal [data-ok]'); await sleep(900);
await page.click('#vv-purge'); await sleep(300);
check('delete for good asks again', !!(await page.$('.modal [data-ok]')));
await page.click('.modal [data-ok]'); await sleep(1200);
const all = (await api('/items')).concat(await api('/items?deleted=true')).map((x) => x.id);
check('deleted for good', !all.includes(s1.id) && !all.includes(s3.id) && all.includes(s2.id));
await page.close();

// ---- fit: iPad Pro 13 landscape / portrait, iPhone Air: no page scroll, every button reachable ----
await post('/versions/decide', { set: { [s2.id]: null, [sc.id]: null } });
const s4 = await (await post('/items', { kind: 'chords', title: 'VTEST SONG (G)', text: '{c: Verse}\n[G]Vtest [C]song [D]line\n[G]and an[Em]other' })).json();
for (const [label, w, h, cols] of [['ipad-land', 1376, 1032, 3], ['ipad-port', 1032, 1376, 2], ['iphone', 420, 912, 1]]) {
  const q = await newPage({ width: w, height: h, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await q.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
  await q.evaluate((k) => { localStorage.setItem('meowsic-cu-tab', 'versions'); localStorage.setItem('meowsic-cu-vkey', k); }, KEY);
  await q.goto(BASE + '#/cleanup', { waitUntil: 'networkidle0' }); await q.reload({ waitUntil: 'networkidle0' }); await sleep(1500);
  const f = await q.evaluate(() => {
    const se = document.scrollingElement, cs = [...document.querySelectorAll('.vv-card')], box = document.querySelector('.vv-cards').getBoundingClientRect();
    const seen = cs.filter((c) => { const r = c.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; });
    const hit = (el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === el || el.contains(t)); };
    const btns = seen.flatMap((c) => [...c.querySelectorAll('button[data-keep], button[data-del], button[data-only]')]).concat([...document.querySelectorAll('#vv-prev, #vv-next, #vv-notsame, #vv-finish, #vv-keepall')]);
    return { scroll: se.scrollHeight - innerHeight, xscroll: se.scrollWidth - innerWidth, cards: cs.length, seen: seen.length, hidden: btns.filter((x) => !hit(x)).map((x) => x.id || x.textContent),
      small: btns.filter((x) => x.getBoundingClientRect().height < 40).map((x) => x.id || x.textContent), art: Math.round(seen[0]?.querySelector('.vv-art').getBoundingClientRect().height || 0) };
  });
  check(`${label}: no page scroll`, f.scroll <= 0 && f.xscroll <= 0, JSON.stringify(f));
  check(`${label}: ${cols} column(s) of ${f.cards}`, f.seen === Math.min(cols, f.cards) && f.cards === 3, JSON.stringify(f));
  check(`${label}: every button visible and touch-sized`, !f.hidden.length && !f.small.length, JSON.stringify(f));
  check(`${label}: a real preview`, f.art >= 250, f.art);
  if (label === 'iphone') {  // swipe to the next card
    const before = await q.$eval('#vv-cards', (e) => e.scrollLeft);
    await q.$eval('#vv-cards', (e) => e.scrollBy({ left: e.clientWidth, behavior: 'instant' })); await sleep(500);
    check('iphone: swipe shows the next version', (await q.$eval('#vv-cards', (e) => e.scrollLeft)) > before + 200);
  }
  await q.screenshot({ path: `versions-${label}.png` }); await q.close();
}

// tidy up: the test items go for good
await post('/items/purge', { ids: [s2.id, sc.id, s4.id, o1.id, o2.id] });
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
