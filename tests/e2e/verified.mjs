// Verified badge against a test server (BASE, default :5347, a temp data folder). Never the real library.
// Score view: an icon-only round toggle beside the title (seal outline, grey; aria-label/title "Not verified"); tap → filled green seal
// with a check ("Verified") and the item has the
// tag "Verified" (made if missing); an Activities row whose Undo takes it back; the library row shows a small ✓.
// Tags is in the Organize section (left bar after Manage library; iPhone: the More menu, not the tab bar).
// Mac, iPad Pro 13 and iPhone Air; screenshots in SHOTS.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5347/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/verified2';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);
const xml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + [1, 2].map((n) => `<measure number="${n}">${n === 1 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>`).join('') + '</part></score-partwise>';

const badge = (page) => page.$eval('#it-verified', (e) => { const seal = e.querySelector('svg .seal'); return { on: e.classList.contains('on'), pressed: e.getAttribute('aria-pressed'), text: e.textContent.trim(), label: e.getAttribute('aria-label'), title: e.title, w: e.offsetWidth, h: e.offsetHeight, round: getComputedStyle(e).borderRadius === '50%', tgBtn: e.classList.contains('tg-btn'), seal: !!seal, fill: seal ? getComputedStyle(seal).fill : '', tick: !!e.querySelector('svg .tick'), color: getComputedStyle(e).color, top: e.getBoundingClientRect().top }; }).catch(() => null);
const waitTags = async (id, cond, ms = 4000) => { const end = Date.now() + ms; let t; while (Date.now() < end) { t = (await api('/items/' + id)).tags; if (cond(t)) return t; await sleep(150); } return t; };

for (const [name, vp, dev] of [['Mac', MAC, 'mac'], ['iPad Pro 13', IPAD, 'ipad'], ['iPhone Air', PHONE, 'iphone']]) {
  console.log(name);
  const title = `Verify me ${stamp} ${dev}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: xml(title), tags: ['Kids'] });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (vp.hasTouch) await page.tap(sel); else await page.click(sel); await sleep(400); };

  await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await sleep(1200);
  let bd = await badge(page);
  check('score view shows the Verified toggle, off: icon-only round, seal outline, no tick', bd && !bd.on && bd.pressed === 'false' && bd.text === '' && bd.tgBtn && bd.round && bd.w === bd.h && bd.w <= 40 && bd.seal && bd.fill === 'none' && !bd.tick, JSON.stringify(bd));
  check('off: aria-label and title "Not verified"; quiet grey', bd && bd.label === 'Not verified' && bd.title === 'Not verified' && !/rgb\(15, 122, 61\)/.test(bd.color), JSON.stringify(bd));
  const sc2 = await page.$eval('#it-verified', (e) => { const o = document.createElement('button'); o.className = 'tg-btn'; e.parentNode.appendChild(o); const r = [e.offsetWidth, o.offsetWidth]; o.remove(); return r; });
  check('same size as the score toggle buttons', sc2[0] === sc2[1], JSON.stringify(sc2));
  check('badge is in the title bar, on screen', bd && bd.top >= 0 && bd.top < 120 && (await page.$eval('#it-verified', (e) => !!e.closest('.item-top'))), JSON.stringify(bd));
  await page.screenshot({ path: `${SHOTS}/${dev}-score-off.png` });

  await tap('#it-verified');
  bd = await badge(page);
  check('tap → filled green seal with a check, icon only', bd?.on && bd.pressed === 'true' && bd.text === '' && /rgb\(15, 122, 61\)/.test(bd.fill) && bd.tick, JSON.stringify(bd));
  check('on: aria-label and title "Verified"', bd?.label === 'Verified' && bd.title === 'Verified', JSON.stringify(bd));
  check('toast "Marked verified"', await page.evaluate(() => document.body.innerText.includes('Marked verified')));
  let t = await waitTags(sc.id, (x) => x.includes('Verified'));
  check('item has the tag Verified (and keeps Kids)', t.includes('Verified') && t.includes('Kids'), JSON.stringify(t));
  check('tag Verified exists', (await api('/tags')).some((x) => x.name === 'Verified'));
  await page.screenshot({ path: `${SHOTS}/${dev}-score-on.png` });

  // reload: still verified (from the Mac)
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
  check('after reload the badge is still on', (await badge(page))?.on);

  // the library list shows the small mark next to this score only
  await page.goto(BASE + '#/library?kind=score', { waitUntil: 'networkidle0' }); await sleep(800);
  await page.type('#lib-q', title); await sleep(500);
  const row = await page.$$eval('#lib-rows tr.row', (rs) => rs.map((r) => ({ t: r.querySelector('.c-title')?.textContent, mark: !!r.querySelector('.verified-mark') })));
  check('library row shows the verified mark', row.length === 1 && row[0].mark, JSON.stringify(row));
  check('no other tags in the list', (await page.$$eval('#lib-rows .tagchip, #lib-rows .c-tag', (e) => e.length)) === 0);
  await page.screenshot({ path: `${SHOTS}/${dev}-library.png` });

  // Activities: one row, Undo takes the tag off
  const acts = await api('/activity');
  const a = acts.find((x) => x.type === 'tags' && (x.title || '').includes('+Verified') && (x.title || '').includes(title));
  check('Activities row "+Verified · title" with undo', !!a && !a.noUndo, JSON.stringify(acts.slice(0, 3).map((x) => [x.type, x.title])));
  if (a) {
    await send('POST', `/activity/${a.id}/undo`, {});
    t = await waitTags(sc.id, (x) => !x.includes('Verified'));
    check('Undo removes Verified', !t.includes('Verified') && t.includes('Kids'), JSON.stringify(t));
  }

  // tap twice from the viewer: on then off
  await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200); // the undo went straight to the Mac: load it fresh
  check('after undo the badge is off', !(await badge(page))?.on);
  await tap('#it-verified'); await tap('#it-verified');
  t = await waitTags(sc.id, (x) => !x.includes('Verified'));
  check('tap again → off, tag removed', !(await badge(page))?.on && !t.includes('Verified'), JSON.stringify(t));

  // Tags lives under Organize now
  if (vp === PHONE) {
    check('tab bar has no Tags', !(await page.$('#tabbar a[href="#/tags"]')));
    await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' }); await sleep(500);
    await tap('#tab-more');
    const util = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
    check('More menu: Activities, Manage library, Tags, Settings, Help, Developer', util.join('|') === 'Activities|Manage library|Tags|Settings|Help|Developer', util.join('|'));
    await page.screenshot({ path: `${SHOTS}/${dev}-more.png` });
    await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.includes('Tags')).click()); await sleep(500);
    check('Tags opens the tags page; More tab lit', (await page.evaluate(() => location.hash)) === '#/tags' && (await page.$eval('#tab-more', (e) => e.classList.contains('on'))));
  } else {
    await page.goto(BASE + '#/tags', { waitUntil: 'networkidle0' }); await sleep(500);
    const side = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('#side nav > *')].map((e) => e.textContent.trim().replace(/\d+$/, '').trim());
      return { nav, on: document.querySelector('#side a[href="#/tags"]')?.classList.contains('on') };
    });
    const u = side.nav.indexOf('Organize');
    check('left bar: Tags under Organize, after Manage library, before Settings', u > 0 && side.nav.indexOf('Tags') === side.nav.indexOf('Manage library') + 1 && side.nav.indexOf('Tags') > u && side.nav.indexOf('Tags') < side.nav.indexOf('Settings'), side.nav.join('|'));
    check('left bar order: Library / Activity / Organize / App', side.nav.join('|') === 'Library|All music|Sheets|Scores|Chords|Books|Activity|Stats|Activities|Organize|Manage library|Tags|App|Settings|Help|Developer', side.nav.join('|'));
    check('Tags link lit on the tags page', side.on);
    if (vp === MAC) await page.screenshot({ path: `${SHOTS}/${dev}-sidebar.png` });
  }
  await page.close();
}
check('no page errors', !errs.length, errs.join('\n'));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
