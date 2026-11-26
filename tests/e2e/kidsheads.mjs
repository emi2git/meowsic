// Kids note names: every big notehead must still show its line or space. On a made-up two-staff score (a C major
// scale with ledger notes above and below, in treble and bass; quarters, halves and wholes) the kids heads are
// measured against the drawn staff lines, on Mac, iPad and iPhone and at 100% and a zoomed-in level:
//  - each head (and its white open-head oval) is at most one staff space tall, so a space note (F in the treble)
//    sits between two lines without covering them;
//  - each head's centre is within ±10% of a staff space of its line or space, and on the right one for its pitch;
//  - the letter is inside its head, centred on it, and fills enough of it to read (cap height ≥ 45% of a space).
// Screenshots in $SHOTS. Needs a fresh test server (BASE); makes its own score.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const errs = [];

// treble: A3 (ledger below the C) … C4 D4 E4 F4 G4 A4 B4 C5 … D6 (two ledgers above); bass: C2 (two ledgers below) … C3 … C4 E4 (ledgers above)
const TREBLE = [['A', 3], ['C', 4], ['D', 4], ['E', 4], ['F', 4], ['G', 4], ['A', 4], ['B', 4], ['C', 5], ['D', 5], ['F', 5], ['A', 5], ['C', 6], ['D', 6], ['F', 4], ['B', 4]];
const BASS = [['C', 2], ['E', 2], ['G', 2], ['C', 3], ['D', 3], ['E', 3], ['F', 3], ['G', 3], ['A', 3], ['B', 3], ['C', 4], ['E', 4], ['A', 2], ['F', 3], ['D', 3], ['B', 2]];
// lengths per bar of 4 notes: quarters, quarters, half + 2 quarters, whole-ish (half, half)… → filled and open heads
const TYPES = ['quarter', 'quarter', 'quarter', 'quarter', 'half', 'quarter', 'quarter', 'half', 'half', 'half', 'eighth', 'eighth', 'quarter', 'half', 'whole'];
const DUR = { eighth: 1, quarter: 2, half: 4, whole: 8 };
// bars of 4/4 (8 divisions): split each staff's notes into bars by TYPES
function bars(ps, staff) {
  const out = []; let cur = '', t = 0, i = 0;
  for (const [s, o] of ps) {
    let ty = TYPES[i % TYPES.length]; i++;
    if (t + DUR[ty] > 8) ty = ['half', 'quarter', 'eighth'].find((x) => t + DUR[x] <= 8);
    cur += `<note><pitch><step>${s}</step><octave>${o}</octave></pitch><duration>${DUR[ty]}</duration><voice>${staff}</voice><type>${ty}</type><staff>${staff}</staff></note>`;
    t += DUR[ty];
    if (t === 8) { out.push(cur); cur = ''; t = 0; }
  }
  if (t) { cur += `<note><rest/><duration>${8 - t}</duration><voice>${staff}</voice><staff>${staff}</staff></note>`; out.push(cur); }
  return out;
}
const rh = bars(TREBLE, 1), lh = bars(BASS, 2);
const n = Math.max(rh.length, lh.length);
const full = (staff) => `<note><rest measure="yes"/><duration>8</duration><voice>${staff}</voice><staff>${staff}</staff></note>`;
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + Array.from({ length: n }, (_, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + (rh[k] || full(1)) + '<backup><duration>8</duration></backup>' + (lh[k] || full(2)) + '</measure>').join('') + '</part></score-partwise>';
const it = await fetch(BASE + 'api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: `Kids heads ${Date.now().toString(36)}`, musicxmlText: xml }) }).then((r) => r.json());
check('test score made', !!it.id, JSON.stringify(it).slice(0, 200));

// steps above the bottom line: treble bottom line = E4, bass bottom line = G2
const STEP = (s, o) => o * 7 + 'CDEFGAB'.indexOf(s);
const want = [TREBLE.map(([s, o]) => STEP(s, o) - STEP('E', 4)), BASS.map(([s, o]) => STEP(s, o) - STEP('G', 2))];

// every head: its stave's line ys, its centre and visible height, all in screen px
const measure = (page, R = '#osmd') => page.evaluate((R) => {
  const ms = [...document.querySelectorAll(`${R} g.vf-measure`)];
  const staves = ms.map((g) => {
    const ys = [...g.querySelectorAll(':scope > path')].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 30 && r.height < 3).map((r) => r.y + r.height / 2);
    const u = [...new Set(ys.map((y) => Math.round(y * 10) / 10))].sort((a, c) => a - c);
    const r = g.getBoundingClientRect();
    return { lines: u, x0: r.left, x1: r.right };
  });
  const heads = [...document.querySelectorAll(`${R} .vf-notehead[data-nl]`)].map((h) => {
    const g = h.closest('.vf-stavenote');
    const oval = h.__nlOval; // an open head's white oval (drawn in place of the glyph)
    const vis = (oval || h).getBoundingClientRect(), r = h.getBoundingClientRect();
    const t = [...document.querySelectorAll(`${R} text.nl`)].find((x) => x.__nlHead === h);
    let letter = null;
    if (t) { const ctm = t.getScreenCTM(); const k = ctm.a; const r2 = t.getBoundingClientRect(); letter = { cx: r2.x + r2.width / 2, fs: +t.getAttribute('font-size') * k, cy: (+t.getAttribute('y') - +t.getAttribute('font-size') * 0.36) * ctm.d + ctm.f, top: r2.top, bottom: r2.bottom }; }
    return { m: ms.indexOf(h.closest('g.vf-measure')), L: h.dataset.nl, cx: r.x + r.width / 2, cy: r.y + r.height / 2, h: vis.height, w: vis.width, open: !!oval, letter };
  });
  return { staves, heads };
}, R);

async function run(name, vp, zooms, theme) {
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' });
  await page.evaluate((th) => { localStorage.setItem('meowsic-kids', '1'); localStorage.removeItem('meowsic-chords'); localStorage.setItem('meowsic-theme', th); }, theme);
  await page.goto(`${BASE}#/item/${it.id}`, { waitUntil: 'networkidle0' }); await sleep(2500);
  for (const z of zooms) {
    await page.evaluate((v) => window.__score.setZoom(v), z); await sleep(2200);
    const label = `${Math.round(z * 100)}%`;
    const tag = `${name} ${label}`;
    const { staves, heads } = await measure(page);
    check(`${tag}: two staves and a letter on every note`, staves.filter((x) => x.lines.length === 5).length >= 2 && heads.length === TREBLE.length + BASS.length, `${staves.length} staves, ${heads.length} heads`);
    // each head → the stave whose lines are nearest (vertically) and that spans it (horizontally)
    const per = staves.map(() => []);
    const bad = { size: [], pos: [], letter: [] };
    for (const hd of heads) {
      const best = hd.m; // the measure (one staff of one bar) the note is drawn in
      if (best < 0 || staves[best].lines.length !== 5) { bad.pos.push(`${hd.L} not in a 5-line measure`); continue; }
      const s = staves[best], sp = (s.lines[4] - s.lines[0]) / 4;
      const k = (s.lines[4] - hd.cy) / (sp / 2); // half-spaces above the bottom line
      per[best].push({ ...hd, k, sp });
      if (hd.h > sp) bad.size.push(`${hd.L} ${hd.h.toFixed(1)}px > space ${sp.toFixed(1)}px`);
      if (Math.abs(k - Math.round(k)) * (sp / 2) > sp * 0.1) bad.pos.push(`${hd.L} off by ${(Math.abs(k - Math.round(k)) * 50).toFixed(0)}% of a space`);
      const lt = hd.letter;
      if (!lt || Math.abs(lt.cx - hd.cx) > sp * 0.15 || Math.abs(lt.cy - hd.cy) > sp * 0.15 || lt.fs * 0.72 < sp * 0.45) bad.letter.push(`${hd.L} ${JSON.stringify(lt && { dx: +(lt.cx - hd.cx).toFixed(1), dy: +(lt.cy - hd.cy).toFixed(1), cap: +(lt.fs * 0.72).toFixed(1), sp: +sp.toFixed(1) })}`);
    }
    check(`${tag}: every head ≤ 1 staff space tall (open ovals too)`, !bad.size.length, bad.size.slice(0, 6).join('; '));
    check(`${tag}: every head centred on a line or space (±10% of a space)`, !bad.pos.length, bad.pos.slice(0, 6).join('; '));
    // treble = the upper of the two measures one above the other in a system; heads in reading order (system, then x)
    const got = [[], []];
    const order = [];
    per.forEach((list, i) => {
      const m = staves[i];
      const partner = staves.filter((o) => o.lines.length === 5 && o !== m && o.x0 < m.x1 - 5 && o.x1 > m.x0 + 5).sort((a, c) => Math.abs(a.lines[0] - m.lines[0]) - Math.abs(c.lines[0] - m.lines[0]))[0];
      const upper = !partner || m.lines[0] < partner.lines[0];
      const sys = Math.round(upper ? m.lines[0] : partner.lines[0]);
      for (const x of list) order.push({ ...x, clef: upper ? 0 : 1, sys });
    });
    order.sort((a, c) => a.sys - c.sys || a.cx - c.cx).forEach((x) => got[x.clef].push(Math.round(x.k)));
    check(`${tag}: treble heads on the right line / space (F in the first space…)`, got[0].join() === want[0].join(), `${got[0].join()} vs ${want[0].join()}`);
    check(`${tag}: bass heads on the right line / space`, got[1].join() === want[1].join(), `${got[1].join()} vs ${want[1].join()}`);
    check(`${tag}: letters centred in their heads and readable (cap ≥ 45% of a space)`, !bad.letter.length, bad.letter.slice(0, 4).join('; '));
    const f = per.flat().find((x) => x.L === 'F' && Math.round(x.k) === 1);
    if (f) console.log(`       ${tag}: space ${f.sp.toFixed(1)}px, F head ${f.h.toFixed(1)}px tall`);
    await page.screenshot({ path: `${SHOTS}/kidsheads-${name}-${label.replace('%', '')}.png` });
  }
  await page.close();
}

// 100% = each device's own default size (Mac / iPad 0.75, iPhone 0.62 drawn), then zoomed out and in
await run('mac', { width: 1440, height: 900 }, [1, 1.6], 'light');
await run('ipad', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, [0.7, 1, 1.3], 'dark');
await run('iphone', { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, [1, 1.45], 'light');

// print (A4): the same kids heads on the bigger staff, each ≤ 1 space and on its line / space
{
  const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errs.push(`print: ${e.message}`));
  await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.setItem('meowsic-kids', '1'));
  await page.goto(`${BASE}#/print?item=${it.id}`, { waitUntil: 'networkidle0' }); await sleep(4000);
  await page.emulateMediaType('print'); await sleep(300); // the A4 pages (#print-root) show only in print
  const { staves, heads } = await measure(page, '#print-root');
  let worst = 0, off = 0, sp0 = 0;
  for (const hd of heads) {
    const s = staves[hd.m]; if (!s || s.lines.length !== 5) { off = 9; continue; }
    const sp = (s.lines[4] - s.lines[0]) / 4, k = (s.lines[4] - hd.cy) / (sp / 2);
    worst = Math.max(worst, hd.h / sp); sp0 = sp; off = Math.max(off, Math.abs(k - Math.round(k)) / 2);
  }
  // a normal A4 score has a ~7.5 px staff space (794 px wide page); kids is 1.5× that
  check('print: the staff is bigger (space ≥ 10 px on the 794 px page)', sp0 >= 10, sp0.toFixed(1));
  check('print: a letter on every note', heads.length === TREBLE.length + BASS.length, String(heads.length));
  check('print: heads ≤ 1 staff space, centred on a line / space (±10%)', worst <= 1 && off <= 0.1, `${worst.toFixed(2)} spaces tall, off ${(off * 100).toFixed(0)}%`);
  await page.screenshot({ path: `${SHOTS}/kidsheads-print.png`, fullPage: true });
  await page.close();
}

await fetch(BASE + `api/items/${it.id}`, { method: 'DELETE' }).catch(() => {});
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
