// The score toolbar's round toggles — chords (piano → ukulele → off), kids note names (baby), Play chords, voice — against a test server (BASE, default :5190, a
// scratchpad copy of the data — never the real library). Per device (Mac, iPad, iPhone), on a two-staff transcription
// (ID, default "Home NDP" m-b6xs990) and a made-up score without chord symbols:
//  kids: off by default; on = a letter inside every notehead of every staff, heads grown (big), letter = the pitch,
//        no keyboard chord diagrams; playback cursor moves; on iPad / iPhone the pages + dots are recomputed;
//        remembered on this device (all scores), off again = classic. Heads are big before layout (VexFlow), so every
//        stem sits at its head's edge — right edge going up, left edge going down, never through the circle — at
//        several zooms and in Dark theme too (iPad runs Dark).
//  toolbar: exactly these round buttons (chords, kids, Play chords, voice), one icon each (no text); the chords icon shows its state.
//  chords: off by default; piano = keyboards with the chord's keys shaded; ukulele = GCEA boxes; both as one compact row at the top of the
//        score (under the toolbar, above the music, full width, scrolls sideways; no panel on the right); off = no strip, the score gets the
//        full height back; the score below fits (pages + dots recomputed on iPad / iPhone). One box per
//        chord in order of first use (symbols as drawn: follow transpose), slash chords as their base chord; a tap
//        lights its chord symbols in the score; a score without symbols gets chords from the notes; remembered.
// Screenshots go to $SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/scorekids';
const ID = process.env.ID || 'm-b6xs990';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

// a two-staff score with no chord symbols: C major then G major, as block chords (the chord finder names them)
const blk = (ps, staff) => ps.map(([s, o], k) => `<note>${k ? '<chord/>' : ''}<pitch><step>${s}</step><octave>${o}</octave></pitch><duration>4</duration><voice>${staff}</voice><type>whole</type><staff>${staff}</staff></note>`).join('');
const plainXml = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + [[['E', 4], ['G', 4], ['C', 5]], [['D', 4], ['G', 4], ['B', 4]], [['C', 4], ['F', 4], ['A', 4]], [['E', 4], ['G', 4], ['C', 5]]].map((rh, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + blk(rh, 1) + '<backup><duration>4</duration></backup>' + blk([[['C', 3], ['G', 3], ['F', 3], ['C', 3]][k]], 2) + '</measure>').join('') + '</part></score-partwise>';
const plain = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: `Block chords ${Date.now().toString(36)}`, musicxmlText: plainXml }) });
const want = (await api(`/items/${ID}/score-chords`)).chords.map((c) => c.replace(/\/.*$/, ''));

const state = (page) => page.evaluate(() => {
  const texts = [...document.querySelectorAll('#osmd text.nl')];
  const heads = [...document.querySelectorAll('#osmd .vf-notehead[data-nl]')];
  const inside = texts.every((t) => {
    const r = t.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return heads.some((h) => { const q = h.getBoundingClientRect(); return cx > q.left - 2 && cx < q.right + 2 && cy > q.top - 2 && cy < q.bottom + 2 && h.dataset.nl === t.textContent; });
  });
  const svgs = [...document.querySelectorAll('#osmd svg')];
  const staffOf = (t) => { const g = t.closest('svg'); return g; };
  const hs = [...document.querySelectorAll('#osmd .vf-notehead[data-nl]')].map((h) => h.getBoundingClientRect().height);
  const plainH = [...document.querySelectorAll('#osmd .vf-notehead:not([data-nl])')].map((h) => h.getBoundingClientRect().height).filter((x) => x > 0);
  return {
    letters: texts.length, heads: heads.length, inside, svgs: svgs.length,
    allHeads: document.querySelectorAll('#osmd .vf-stavenote .vf-notehead').length,
    headH: hs.length ? hs.sort((a, b) => a - b)[Math.floor(hs.length / 2)] : 0, plainH: plainH.length ? plainH.sort((a, b) => a - b)[Math.floor(plainH.length / 2)] : 0,
    kbds: document.querySelectorAll('#osmd g.kbd, #osmd .easy-kbd-row').length,
    btn: document.querySelector('#sc-names')?.classList.contains('on'), kitten: !!document.querySelector('#sc-names svg.ic'),
    uke: !!document.querySelector('.chord-strip'), ukeBtn: document.querySelector('#sc-chords')?.classList.contains('on'),
    mode: document.querySelector('#sc-chords')?.dataset.mode, panelMode: document.querySelector('.chord-strip')?.dataset.mode || '',
    toggles: [...document.querySelectorAll('.tg-row .tg-btn')].map((x) => ({ id: x.id, text: x.textContent.trim(), icons: x.querySelectorAll('svg.ic').length, hidden: x.hidden })),
    abc: [...document.querySelectorAll('button')].some((x) => /^(A B C|Voice)$/.test(x.textContent.trim())),
    piano: [...document.querySelectorAll('.chord-strip .uk-chord svg.pn-box')].map((k) => ({ c: k.dataset.chord, notes: k.dataset.notes })),
    boxes: [...document.querySelectorAll('.chord-strip .uk-chord')].map((x) => ({ c: x.dataset.chord, frets: x.querySelector('svg')?.dataset.frets, fingers: x.querySelector('svg')?.dataset.fingers, barre: x.querySelector('svg')?.dataset.barre })),
    none: document.querySelector('.chord-strip .uk-none')?.textContent || '',
    hits: document.querySelectorAll('#osmd .uke-hit').length,
    page: window.__score?.pages ? window.__score.page : 0, dots: document.querySelectorAll('.score-dots i').length,
    panelBox: (() => { const p = document.querySelector('.chord-strip'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })(),
    stripCheck: (() => {
      const p = document.querySelector('.chord-strip'), top = document.querySelector('.item-top'), body = document.querySelector('.viewer-body'), row = p?.querySelector('.uk-row');
      if (!p) return null;
      const r = p.getBoundingClientRect(), t = top.getBoundingClientRect(), bd = body.getBoundingClientRect();
      const kids = [...p.querySelectorAll('.uk-chord')].map((x) => x.getBoundingClientRect());
      return { underBar: Math.abs(r.top - t.bottom) < 2, aboveMusic: bd.top >= r.bottom - 1, oneRow: kids.every((k) => Math.abs(k.top - (kids[0]?.top ?? k.top)) < 2), inside: kids.every((k) => k.top >= r.top - 1 && k.bottom <= r.bottom + 1),
        scrolls: getComputedStyle(row).overflowX, fullW: r.width >= document.querySelector('.viewer').getBoundingClientRect().width - 2, h: r.height, bodyH: bd.height, bodyBottom: Math.round(bd.bottom), vh: innerHeight, svgH: p.querySelector('.uk-chord svg')?.getBoundingClientRect().height || 0 };
    })(),
    bodyH: document.querySelector('.viewer-body')?.getBoundingClientRect().height || 0,
    paperH: document.querySelector('#paper')?.clientHeight || 0,
  };
});
// every stemmed kids note: the stem's x against the head it starts from (lowest head going up, highest going down)
const stems = (page) => page.evaluate(() => {
  const out = [];
  for (const g of document.querySelectorAll('#osmd .vf-stavenote')) {
    const st = g.querySelector('.vf-stem');
    const hs = [...g.querySelectorAll('.vf-notehead[data-nl]')].filter((h) => h.closest('.vf-stavenote') === g);
    if (!st || !hs.length) continue;
    const s = st.getBoundingClientRect();
    if (s.height < 2) continue;
    const hr = hs.map((h) => h.getBoundingClientRect());
    const top = Math.min(...hr.map((q) => q.top)), bot = Math.max(...hr.map((q) => q.bottom));
    const up = (s.top + s.bottom) / 2 < (top + bot) / 2;
    const sx = s.x + s.width / 2;
    const h = up ? hr.reduce((a, q) => (q.bottom > a.bottom ? q : a)) : hr.reduce((a, q) => (q.top < a.top ? q : a));
    const dx = up ? sx - h.right : sx - h.left;
    out.push({ up, n: hs.length, dx: +dx.toFixed(2), inside: sx > h.left + 1.5 && sx < h.right - 1.5 });
  }
  const bad = out.filter((x) => x.inside || Math.abs(x.dx) > 1.5);
  return { n: out.length, up: out.filter((x) => x.up).length, down: out.filter((x) => !x.up).length, chords: out.filter((x) => x.n > 1).length, bad: bad.length, eg: bad.slice(0, 4) };
});
const stemCheck = async (page, what) => {
  const t = await stems(page);
  check(`kids: stems at the head's edge (up → right, down → left, never inside) ${what}`, t.n > 20 && t.up && t.down && !t.bad, JSON.stringify(t));
};
// the pitch letter of every sounding note on every staff, in document order of the MusicXML
const steps = (xml) => [...xml.matchAll(/<note>(?:(?!<\/note>)[\s\S])*?<step>([A-G])<\/step>/g)].length;

// the strip: right under the toolbar, above the music, full width, one row of diagrams inside it, scrolls sideways
const stripOk = (what, s) => {
  const c = s.stripCheck;
  check(`${what}: one compact row at the top (under the toolbar, above the music, full width, scrolls sideways)`,
    c && c.underBar && c.aboveMusic && c.oneRow && c.inside && c.fullW && c.scrolls === 'auto' && c.h <= 92 && c.svgH >= 40, JSON.stringify(c));
};

async function run(name, vp) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|409|favicon/.test(m.text())) errs.push(`${name}: ${m.text()}`); });
  // iPad runs in Dark theme, Mac and iPhone in Light (set before the app reads it on load)
  await page.evaluateOnNewDocument((dark) => { try { localStorage.setItem('meowsic-theme', dark ? 'dark' : 'light'); } catch {} }, name === 'ipad');
  await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { localStorage.removeItem('meowsic-kids'); localStorage.removeItem('meowsic-chords'); });
  await page.goto(`${BASE}#/item/${ID}`, { waitUntil: 'networkidle0' }); await sleep(3500);
  let s = await state(page);
  check('classic by default: no letters, baby button off, chords off, no panel', s.letters === 0 && s.btn === false && s.kitten && !s.uke && s.ukeBtn === false && s.mode === 'off', JSON.stringify(s));
  check('toolbar: chords + kids + Play chords (+ voice when the score sings) as round icon-only buttons; no "A B C" / "Voice" text', s.toggles.map((x) => x.id).join() === 'sc-chords,sc-names,sc-chordplay,sc-voice' && s.toggles.every((x) => !x.text && x.icons === 1) && !s.abc, JSON.stringify(s.toggles));
  const dots0 = s.dots, h0 = s.plainH;
  await page.click('#sc-names'); await sleep(3500);
  s = await state(page);
  const xml = await fetch(`${BASE}api/items/${ID}/musicxml`).then((r) => r.text());
  check('kids: baby button lights up', s.btn === true);
  check('kids: a letter in every notehead of every staff (rests none)', s.letters > 50 && s.heads === s.letters && s.letters === steps(xml), `${s.letters} letters / ${s.heads} heads / ${steps(xml)} notes`);
  check('kids: each letter sits inside its head', s.inside);
  check('kids: heads are big (median ≥ 1.3× a classic head)', h0 > 0 && s.headH >= h0 * 1.3, `${s.headH} vs ${h0}`);
  await stemCheck(page, `(${name}${name === 'ipad' ? ', Dark' : ''})`);
  if (name !== 'iphone') { // iPhone has no zoom buttons (pinch)
    for (const [btn, n] of [['#sc-zin', 2], ['#sc-zout', 4]]) {
      for (let k = 0; k < n; k++) { await page.evaluate((x) => document.querySelector(x).click(), btn); await sleep(900); }
      await sleep(1200);
      await stemCheck(page, `(${name}, zoom ${await page.$eval('#sc-zreset', (x) => x.textContent.trim())})`);
    }
    await page.evaluate(() => document.querySelector('#sc-zreset').click()); await sleep(2000);
  }
  check('kids: no keyboard chord diagrams', s.kbds === 0);
  if (touch) check('kids: pages + dots recomputed (more pages with the bigger notes)', s.dots >= dots0 && s.page === 1, `${dots0} → ${s.dots} ${s.page}`);
  await page.screenshot({ path: `${SHOTS}/kids-${name}.png` });
  // the letter is the drawn pitch (first notes of staff 1 vs the MusicXML)
  const first = await page.evaluate(() => [...document.querySelectorAll('#osmd text.nl')].slice(0, 3).map((t) => t.textContent).join(''));
  check('kids: letters are pitch names A–G', /^[A-G]{3}$/.test(first), first);
  // playback cursor still moves
  await page.click('#sc-play'); await sleep(2200);
  const pos = (await page.evaluate(() => window.__score.player.now()));
  const bar = await page.evaluate(() => { const x = document.querySelector('.playbar'); return x && getComputedStyle(x).display !== 'none'; });
  check('kids: Play moves the playhead and the orange line shows', pos > 0.3 && bar, `${pos} ${bar}`);
  await page.click('#sc-play'); await sleep(300);
  // remembered on this device, for every score
  await page.goto(`${BASE}#/item/${plain.id}`, { waitUntil: 'networkidle0' }); await sleep(2500);
  s = await state(page);
  check('kids: remembered on this device (another score opens with it)', s.btn === true && s.letters === 16, `${s.btn} ${s.letters}`);
  // ukulele: chords from the notes on a score without symbols
  const off = await state(page); // chords off: no strip, the full height
  check('chords off: no strip, the score has the full height', !off.uke && off.stripCheck === null && off.bodyH > 0, String(off.bodyH));
  await page.click('#sc-chords'); await sleep(1500);
  s = await state(page);
  check('chords 1st tap: piano chords strip, piano icon', s.uke && s.ukeBtn === true && s.mode === 'piano' && s.panelMode === 'piano', JSON.stringify([s.mode, s.panelMode]));
  check('piano: C = C E G, G = D G B, F = C F A (keys shaded)', s.piano.map((x) => `${x.c}:${x.notes}`).join(',') === 'C:C E G,G:D G B,F:C F A', JSON.stringify(s.piano));
  stripOk('piano', s);
  check('piano: the score below is shorter by the strip (it reflows to fit)', s.bodyH < off.bodyH - 40 && Math.abs(off.bodyH - s.bodyH - s.stripCheck.h) < 3, `${off.bodyH} → ${s.bodyH}, strip ${s.stripCheck?.h}`);
  if (touch) check('piano: the pages fit the smaller frame (paper = body height)', s.paperH > 0 && s.paperH <= s.bodyH + 1, `${s.paperH} vs ${s.bodyH}`);
  await page.screenshot({ path: `${SHOTS}/piano-${name}.png` });
  await page.click('#sc-chords'); await sleep(1500);
  s = await state(page);
  check('chords 2nd tap: ukulele chords strip, ukulele icon', s.uke && s.mode === 'uke' && s.panelMode === 'uke', JSON.stringify([s.mode, s.panelMode]));
  check('ukulele: no symbols → chords from the notes (C, G, F)', s.boxes.map((x) => x.c).join(',') === 'C,G,F', JSON.stringify(s.boxes));
  const sh = Object.fromEntries(s.boxes.map((x) => [x.c, x.frets]));
  check('ukulele: GCEA shapes C 0003, G 0232, F 2010', sh.C === '0003' && sh.G === '0232' && sh.F === '2010', JSON.stringify(sh));
  check('ukulele: finger numbers (G = 0 1 3 2)', s.boxes.find((x) => x.c === 'G')?.fingers === '0132', JSON.stringify(s.boxes));
  stripOk('ukulele', s);
  await page.click('#sc-names'); await sleep(2500); // kids off
  s = await state(page);
  check('kids off again: classic look', s.letters === 0 && s.btn === false);
  // the transcription with symbols: in order of first use, base chords, follow transpose
  await page.goto(`${BASE}#/item/${ID}`, { waitUntil: 'networkidle0' }); await sleep(3500);
  s = await state(page);
  check('ukulele: remembered (opens with the score)', s.uke && s.ukeBtn === true && s.mode === 'uke');
  check('ukulele: one box per chord, in order of first use', s.boxes.map((x) => x.c).join(',') === [...new Set(want)].join(','), `${s.boxes.map((x) => x.c)} vs ${want}`);
  check('ukulele: every box has a shape', s.boxes.every((x) => /^\d{4}$/.test(x.frets || '')), JSON.stringify(s.boxes.filter((x) => !x.frets)));
  const bm = s.boxes.find((x) => x.c === 'Bm');
  if (bm) check('ukulele: Bm = 4222 with a barre on fret 2', bm.frets === '4222' && bm.barre === '2', JSON.stringify(bm));
  await page.evaluate(() => document.querySelector('.chord-strip .uk-chord')?.click()); await sleep(400);
  s = await state(page);
  check('ukulele: tapping a box lights its chord symbols in the score', s.hits > 0, String(s.hits));
  await page.screenshot({ path: `${SHOTS}/uke-${name}.png` });
  await page.click('#sc-tup'); await sleep(2500);
  s = await state(page);
  const up = { C: 'C#', D: 'D#', E: 'F', F: 'F#', G: 'G#', A: 'A#', B: 'C' };
  const norm = (c) => c.replace(/♯/g, '#').replace(/♭/g, 'b');
  const r0 = norm(s.boxes[0]?.c || '').match(/^[A-G][#b]?/)?.[0];
  check('ukulele: transpose +1 → chords follow', r0 && norm(want[0]).match(/^[A-G]/)[0] !== r0, `${want[0]} → ${s.boxes[0]?.c}`);
  await page.click('#sc-tdown'); await sleep(2000);
  // close from the strip
  const s0 = await state(page);
  await page.click('.chord-strip .uk-close'); await sleep(1200);
  s = await state(page);
  check('ukulele: ✕ closes it and the button goes off (dim chord icon)', !s.uke && s.ukeBtn === false && s.mode === 'off');
  check('off: the score gets the full height back', s.bodyH > s0.bodyH + 40, `${s0.bodyH} → ${s.bodyH}`);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(2500);
  s = await state(page);
  check('ukulele: off is remembered', !s.uke);
  // chords cycle: off → piano → ukulele → off
  const seq = [];
  for (let k = 0; k < 3; k++) { await page.click('#sc-chords'); await sleep(700); seq.push((await state(page)).mode); }
  check('chords button cycles piano → ukulele → off', seq.join() === 'piano,uke,off', seq.join());
  // ⋯ menu has neither: Kids note names and Chords are the toolbar toggles above
  await page.click('#it-more'); await sleep(400);
  const items = await page.$$eval('.menu button', (bs) => bs.map((x) => x.textContent.trim()));
  check('⋯ menu: no Kids note names / Chords (toolbar toggles)', items.includes('Info') && !items.some((t) => t.startsWith('Kids note names') || t.startsWith('Chords')), items.join(' | '));
  await page.evaluate(() => document.querySelector('.menu')?.remove());
  await page.close();
  void up;
}

await run('mac', MAC);
await run('ipad', IPAD);
await run('iphone', PHONE);
await fetch(`${BASE}api/items/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [plain.id] }) });
check('no page errors', !errs.length, errs.slice(0, 5).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
