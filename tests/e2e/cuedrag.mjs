// The orange play line in Edit notes: drag it by its grip (touch on iPad / iPhone, mouse on the Mac) to a later bar on
// another line → it snaps to a note, the picked notes stay picked (no box, no swipe-close), ▶ From here then plays
// from the dropped spot; dragging while playing plays on from the new spot; iPad / iPhone: holding it at the page's
// right edge turns the page. Against a test server (BASE; a fresh temp server, never the real library).
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];
const DEVICES = [
  ['iPad', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['iPhone', { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
  ['Mac', { width: 1440, height: 900 }],
];
const stamp = Date.now().toString(36);

// 24 bars of quarter notes (right hand) over whole notes (left hand): several lines on every device
const STEP = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const nt = (s, o, d, type, staff) => `<note><pitch><step>${s}</step><octave>${o}</octave></pitch><duration>${d}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + Array.from({ length: 24 }, (_, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><sound tempo="120"/>'}`
    + [0, 1, 2, 3].map((i) => nt(STEP[(k + i) % 7], 4, 1, 'quarter', 1)).join('') + '<backup><duration>4</duration></backup>' + nt(STEP[k % 7], 3, 4, 'whole', 2) + '</measure>').join('') + '</part></score-partwise>';

async function run(name, vp) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Drag line ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(200); };
  const grip = () => page.$eval('.playbar .pb-grip', (g) => { const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, shown: getComputedStyle(g.parentElement).display !== 'none' }; });
  // a drag in small steps; hold = ms to wait at the end before letting go
  const dragTo = async (x2, y2, { hold = 0 } = {}) => {
    const g = await grip();
    const steps = 12;
    if (touch) {
      await page.touchscreen.touchStart(g.x, g.y);
      for (let k = 1; k <= steps; k++) { await page.touchscreen.touchMove(g.x + ((x2 - g.x) * k) / steps, g.y + ((y2 - g.y) * k) / steps); await sleep(15); }
      if (hold) await sleep(hold);
      await page.touchscreen.touchEnd();
    } else {
      await page.mouse.move(g.x, g.y); await page.mouse.down();
      for (let k = 1; k <= steps; k++) { await page.mouse.move(g.x + ((x2 - g.x) * k) / steps, g.y + ((y2 - g.y) * k) / steps); await sleep(15); }
      if (hold) await sleep(hold);
      await page.mouse.up();
    }
    await sleep(300);
  };
  const head = (bar) => EN((bar) => {
    const n = window.__editNotes.notes.filter((n) => n.bar === bar && n.staff === 1 && !n.rest)[0];
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
  }, bar);

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  if (touch) await page.tap('#sc-edit'); else await page.click('#sc-edit'); // the toolbar ✎
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(700);

  let g = await grip();
  check('Edit notes: the orange line is on show with its grip', g.shown && g.w >= 10, JSON.stringify(g));
  // on show = inside the page (paged: the clip) and above the notes panel
  const vis = (h) => h && EN(({ y }) => {
    const c = (document.querySelector('#clip') || document.querySelector('#paper')).getBoundingClientRect(), p = document.querySelector('.notes-panel').getBoundingClientRect();
    return y > c.top && y < Math.min(c.bottom, p.top, innerHeight) - 10;
  }, h);
  // the first bar on show, and a later bar on the next line on show
  const lines = async () => {
    let a = null;
    for (let bi = 0; bi < 24; bi++) {
      const h = await head(bi);
      if (!(await vis(h))) continue;
      if (!a) a = { ...h, bar: bi }; else if (h.top > a.top + 40) return [a, { ...h, bar: bi }];
    }
    return [a, null];
  };
  let [first, target] = await lines();
  const pages = await EN(() => window.__score.pages);
  let turned = false;
  if (!target && touch && pages > 1) {
    // one line per page (iPhone): hold the line at the right edge → the next page, the line on its first note
    const p0 = await EN(() => window.__score.page);
    const pr = await page.$eval('#paper', (e) => e.getBoundingClientRect().right);
    await dragTo(pr - 4, g.y, { hold: 900 });
    const pg = await EN(() => ({ page: window.__score.page, cue: window.__score.cueQ }));
    check('hold at the right edge: the line moves to the next page', pg.page === p0 + 1 && pg.cue > 0, JSON.stringify({ p0, pg }));
    turned = true;
    [first, target] = await lines();
  }
  check('the score has a second line on the page', !!target);
  if (!target) { await page.close(); return; }

  // pick a note first: the drag must leave it picked
  await tapXY(first.x, first.y);
  const sel0 = JSON.stringify(await EN(() => window.__editNotes.sel));
  check('a note is picked', sel0 === `[${first.ref}]`, sel0);

  g = await grip();
  const hitG = await EN(({ x, y }) => { const e = document.elementFromPoint(x, y); return e?.closest?.('.pb-grip') ? 'grip' : (e?.className?.baseVal ?? e?.className) + ' ' + e?.tagName; }, g);
  check('the grip is on top where a finger lands', hitG === 'grip', hitG);
  await dragTo(target.x + 2, target.y);
  const st = await EN((bar) => ({ cue: window.__score.cueQ, now: window.__score.player.now(), want: window.__score.barStarts()[bar], playing: window.__score.player.playing, cueBar: window.__editNotes.cueBar, panel: !!document.querySelector('.notes-panel'), box: !!document.querySelector('.np-box'), hash: location.hash, sel: JSON.stringify(window.__editNotes.sel) }), target.bar);
  check(`drag: the line snaps to bar ${target.bar + 1} on the next line`, Math.abs(st.cue - st.want) < 1e-6 && Math.abs(st.now - st.want) < 1e-6, JSON.stringify(st));
  check('drag: the editor says it will play from that bar', st.cueBar === target.bar + 1, String(st.cueBar));
  check('drag: picked notes unchanged, no box, editor still open, not closed', st.sel === sel0 && !st.box && st.panel && st.hash.includes(sc.id), JSON.stringify(st));
  const gl = await grip();
  check('drag: the grip is drawn at that note', Math.abs(gl.x - target.x) < 30 && Math.abs(gl.y - target.y) < 120, JSON.stringify({ gl, target }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cuedrag-${name}.png` });

  // ▶ From here plays from the dropped spot (not from the picked note's bar)
  if (touch) await page.tap('.notes-panel [data-a="playhere"]'); else await page.click('.notes-panel [data-a="playhere"]');
  await page.waitForFunction(() => window.__score.player.playing, { timeout: 5000 }).catch(() => {}); await sleep(500);
  const p1 = await EN(() => ({ now: window.__score.player.now(), playing: window.__score.player.playing }));
  check('▶ From here: plays from the dropped spot', p1.playing && p1.now >= st.want - 1e-6 && p1.now < st.want + 3, JSON.stringify(p1));

  // dragging while playing: plays on from the new spot (the bar after the first one on the page)
  const b2 = await head(first.bar + 1);
  await dragTo(b2.x + 2, b2.y);
  await sleep(500);
  const p2 = await EN((bar) => ({ now: window.__score.player.now(), playing: window.__score.player.playing, want: window.__score.barStarts()[bar] }), first.bar + 1);
  check('drag while playing: plays on from the new spot', p2.playing && p2.now >= p2.want - 1e-6 && p2.now < p2.want + 2.5, JSON.stringify(p2));
  if (touch) await page.tap('.notes-panel [data-a="playhere"]'); else await page.click('.notes-panel [data-a="playhere"]');
  await sleep(300);
  check('paused', !(await EN(() => window.__score.player.playing)));

  // the transport's Play starts at the dropped spot too
  const t3 = await head(target.bar);
  await dragTo(t3.x + 2, t3.y);
  await EN(() => document.querySelector('#sc-play').click()); // (iPhone: under the panel)
  await sleep(700);
  const p3 = await EN((bar) => ({ now: window.__score.player.now(), want: window.__score.barStarts()[bar], playing: window.__score.player.playing }), target.bar);
  check('Play (transport): starts at the dropped spot', p3.playing && p3.now >= p3.want - 1e-6 && p3.now < p3.want + 2.5, JSON.stringify(p3));
  await EN(() => document.querySelector('#sc-play').click());
  await sleep(200);

  // paged (iPad / iPhone): hold the line at the right edge → the next page, the line on its first note
  const cueBefore = await EN(() => window.__score.cueQ);
  if (touch && pages > 1 && !turned && (await EN(() => window.__score.page)) < pages) {
    const p0 = await EN(() => window.__score.page);
    const pr = await page.$eval('#paper', (e) => { const r = e.getBoundingClientRect(); return { right: r.right, top: r.top }; });
    const gg = await grip();
    await dragTo(pr.right - 4, gg.y, { hold: 900 });
    const pg = await EN(() => ({ page: window.__score.page, cue: window.__score.cueQ }));
    check('hold at the right edge: the line moves to the next page', pg.page === p0 + 1 && pg.cue > cueBefore, JSON.stringify({ p0, pg, cueBefore }));
  }

  check('no errors', !errs.some((e) => e.startsWith(name)), errs.filter((e) => e.startsWith(name)).join(' | '));
  // close without saving, and remove the test score
  await EN(() => window.__editNotes?.close());
  await sleep(400);
  await page.close();
  await fetch(`${BASE}api/items/${sc.id}`, { method: 'DELETE' });
}

for (const [n, vp] of DEVICES) await run(n, vp);
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
