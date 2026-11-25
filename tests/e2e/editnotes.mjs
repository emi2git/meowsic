// Edit notes (the score toolbar ✎) and the score player's Stop + Play / Pause, against a test server (BASE,
// default :5371, a scratchpad copy of the data — never the real library). Per device (Mac, iPad Pro 13", iPhone Air):
// a made-up piano score (Ode to Joy, public domain) → the player has Stop before Play / Pause and no position bar;
// Play moves the orange line, Stop puts it back at the start → open Edit notes → pick a note (tap), a range
// (Shift-click, Mac), a box (drag), a whole bar → move them to the other hand: the score draws again, both staves
// keep full bars, chords stay together → undo / redo → Mac: save into this score (Activities undo puts it back),
// iPad: save as a new version (tagged "Hands moved"; undone after), iPhone: close without saving (unchanged).
// Screenshots go to $SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/editnotes';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

// Ode to Joy: right hand melody (bar 1 opens on a third), left hand half notes, bar 4 a whole-note chord
const STEPS = { 48: 'C3', 50: 'D3', 52: 'E3', 53: 'F3', 55: 'G3', 59: 'B3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 72: 'C5' };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (ms, q, staff) => ms.map((m, k) => `<note>${k ? '<chord/>' : ''}<pitch><step>${STEPS[m][0]}</step><octave>${STEPS[m][1]}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`).join('');
const RH = [[[[64, 60], 1], [[64], 1], [[65], 1], [[67], 1]], [[[67], 1], [[65], 1], [[64], 1], [[62], 1]], [[[60], 1], [[60], 1], [[62], 1], [[64], 1]], [[[64, 60], 4]]];
const LH = [[[[48], 2], [[55], 2]], [[[59], 2], [[55], 2]], [[[53], 2], [[55], 2]], [[[48, 55], 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>'}`
    + bar.map(([ms, q]) => note(ms, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH[k].map(([ms, q]) => note(ms, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';

// every voice of every bar = the time signature, and both staves have a voice in every bar
const barsFull = (x) => {
  let div = 1, need = 4, ok = true;
  for (const m of x.split('<measure').slice(1)) {
    const dv = m.match(/<divisions>(\d+)<\/divisions>/); if (dv) div = +dv[1];
    const ts = m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/); if (ts) need = (4 * ts[1]) / ts[2];
    const sum = {};
    for (const n of m.split('<note').slice(1)) {
      if (/<chord\s*\/>/.test(n) || /<grace\b/.test(n)) continue;
      const k = (n.match(/<staff>(\d+)/)?.[1] || '1') + '/' + (n.match(/<voice>(\d+)/)?.[1] || '1');
      sum[k] = (sum[k] || 0) + +(n.match(/<duration>(\d+)/)?.[1] || 0) / div;
    }
    if (Object.values(sum).some((v) => Math.abs(v - need) > 1e-6)) ok = false;
    if (!Object.keys(sum).some((k) => k.startsWith('1/')) || !Object.keys(sum).some((k) => k.startsWith('2/'))) ok = false;
  }
  return ok;
};
const clefs = (x) => (x.match(/<clef[\s\S]*?<\/clef>/g) || []).map((c) => c.replace(/\s+/g, '')).join('|');

async function run(name, vp, how) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Ode to Joy ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Beethoven', musicxmlText: scoreXml(title), tags: ['Kids'] });
  const x0 = await xmlOf(sc.id);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const EN = (f) => page.evaluate(f);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const headAt = (pred) => page.evaluate((src) => {
    const f = new Function('n', `return (${src})(n)`);
    const n = window.__editNotes.notes.find(f);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, pred.toString());

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);

  // ---- the player: Stop before one Play / Pause button, no position bar ----
  const tr = await page.$eval('.transport', (e) => ({ kids: [...e.children].map((c) => c.id), range: !!document.querySelector('#it-bar input[type=range], .transport input'), time: !!document.querySelector('#sc-time') }));
  check('player: Stop then Play, nothing else', tr.kids.join(',') === 'sc-stop,sc-play' && !tr.range && !tr.time, JSON.stringify(tr));
  check('Play is an icon button labelled Play', await page.$eval('#sc-play', (e) => e.getAttribute('aria-label') === 'Play' && !!e.querySelector('svg') && !e.textContent.trim()));
  await tap('#sc-play'); await sleep(1500);
  const q1 = await EN(() => window.__score.player.now());
  check('Play: playing, the button says Pause', q1 > 0.5 && (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Pause', String(q1));
  check('the orange line shows where it is', await page.$eval('.playbar', (e) => getComputedStyle(e).display !== 'none'));
  await tap('#sc-play'); await sleep(300);
  const q2 = await EN(() => window.__score.player.now());
  await sleep(500);
  check('Pause: stays where it was', Math.abs((await EN(() => window.__score.player.now())) - q2) < 1e-6 && q2 > 0.5 && (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Play');
  await tap('#sc-play'); await sleep(600);
  await tap('#sc-stop'); await sleep(300);
  check('Stop: stopped, back to the beginning, the line goes', (await EN(() => !window.__score.player.playing && window.__score.player.now() === 0)) && (await page.$eval('.playbar', (e) => getComputedStyle(e).display === 'none')) && (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Play');
  const box = await page.$eval('.transport', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, right: r.right }; });
  check('player fits on the screen', box.right <= vp.width && box.w < 160, JSON.stringify(box));
  if (name === 'Mac' || name === 'iPhone') await page.screenshot({ path: `${SHOTS}/${name}-player.png` });

  // ---- Edit notes: the toolbar ✎ (on every width); not in the score ⋯ too ----
  await tap('#it-more'); await sleep(200);
  const entries = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check('score ⋯ has no Edit notes (it is the toolbar ✎)', !entries.includes('Edit notes…') && entries.length > 0, entries.join('|'));
  await page.evaluate(() => document.querySelector('.menu')?.remove()); await sleep(150);
  const edBox = await page.$eval('#sc-edit', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, right: r.right, vw: innerWidth }; });
  check(`${name}: the toolbar ✎ Edit notes shows on screen`, edBox.w > 20 && edBox.h > 20 && edBox.x >= 0 && edBox.right <= edBox.vw, JSON.stringify(edBox));
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);
  const nNotes = await EN(() => window.__editNotes.notes.filter((n) => !n.rest).length);
  const tagged = await page.$$eval('#paper g[data-ref]', (e) => new Set(e.map((g) => g.dataset.ref)).size);
  check('every note on the score can be picked (23)', nNotes === 23 && tagged === 23, `${nNotes} / ${tagged}`);
  const fits = await page.evaluate(() => { const r = document.querySelector('.notes-panel').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1; });
  check('panel fits the screen', fits);

  // 1. tap one note (bar 1, the F on beat 3) → To left hand
  let f = await headAt((n) => n.bar === 0 && n.midi === 65);
  await tapXY(f.x, f.y);
  check('tap picks that note', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${f.ref}]`, JSON.stringify(await EN(() => window.__editNotes.sel)));
  check('picked note is coloured', await page.$eval(`#paper g[data-ref="${f.ref}"]`, (g) => g.classList.contains('nh-on')));
  check('“To right hand” is off for a right-hand note', await page.$eval('.notes-panel [data-a="up"]', (e) => e.disabled) && !(await page.$eval('.notes-panel [data-a="down"]', (e) => e.disabled)));
  await act('down'); await idle();
  let x = await EN(() => window.__editNotes.xml);
  let ns = await EN(() => window.__editNotes.notes);
  check('the F is in the left hand now', ns.some((n) => n.bar === 0 && n.midi === 65 && n.staff === 2) && !ns.some((n) => n.bar === 0 && n.midi === 65 && n.staff === 1));
  check('both staves keep full bars', barsFull(x));
  check('clefs unchanged', clefs(x) === clefs(x0));
  check('score drew again, the moved note is still picked', (await page.$$eval('#paper g[data-ref]:not(.nh-rest)', (e) => new Set(e.map((g) => g.dataset.ref)).size)) === 23 && (await page.$$eval('#paper g.nh-on', (e) => e.length)) === 1);
  check('a rest where the F was', /<rest\b/.test(x.split('<measure')[1]));
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/${name}-moved-one.png` });

  // 2. a whole-note chord: tap one of bar 4's right-hand notes, Whole bar → both notes → To left hand: joins the left chord
  f = await headAt((n) => n.bar === 3 && n.staff === 1 && n.midi === 64);
  await tapXY(f.x, f.y);
  await act('barmenu'); await sleep(250);  // Whole bar is the first entry of Bar ▾ (B on a keyboard)
  await page.evaluate(() => [...document.querySelectorAll('.menu > button')].find((x) => x.textContent.startsWith('Whole bar')).click()); await sleep(200);
  check('Whole bar picks the chord (2 notes)', (await EN(() => window.__editNotes.sel.length)) === 2, JSON.stringify(await EN(() => window.__editNotes.sel)));
  await act('down'); await idle();
  ns = await EN(() => window.__editNotes.notes);
  const b4 = ns.filter((n) => n.bar === 3 && n.staff === 2);
  check('chord moved together: one 4-note chord in the left hand', b4.length === 4 && new Set(b4.map((n) => n.voice)).size === 1 && b4.every((n) => n.on === 0 && n.dur === 4), JSON.stringify(b4));
  x = await EN(() => window.__editNotes.xml);
  const m4 = x.split('<measure')[4];
  check('right hand rests the whole bar 4', /<rest measure="yes"\s*\/>/.test(m4) && barsFull(x));

  // 3. a box around bar 2's left-hand notes (or Shift-click range on the Mac) → To right hand
  const a = await headAt((n) => n.bar === 1 && n.staff === 2 && n.midi === 59), z = await headAt((n) => n.bar === 1 && n.staff === 2 && n.midi === 55);
  if (how === 'this') { // Mac: click, then Shift-click
    await tapXY(a.x, a.y);
    await page.keyboard.down('Shift'); await page.mouse.click(z.x, z.y); await page.keyboard.up('Shift'); await sleep(150);
  } else { // drag a box from above-left of the first to below-right of the last
    const x1 = a.x - 14, y1 = Math.min(a.y, z.y) - 14, x2 = z.x + 14, y2 = Math.max(a.y, z.y) + 14;
    if (touch) { await page.touchscreen.touchStart(x1, y1); for (let k = 1; k <= 6; k++) await page.touchscreen.touchMove(x1 + ((x2 - x1) * k) / 6, y1 + ((y2 - y1) * k) / 6); await page.touchscreen.touchEnd(); }
    else { await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 6 }); await page.mouse.up(); }
    await sleep(200);
  }
  const s3 = await EN(() => window.__editNotes.sel);
  check(`${how === 'this' ? 'Shift-click range' : 'drag box'} picks bar 2's two left-hand notes`, s3.length === 2 && s3.includes(a.ref) && s3.includes(z.ref), JSON.stringify(s3));
  await act('up'); await idle();
  ns = await EN(() => window.__editNotes.notes);
  x = await EN(() => window.__editNotes.xml);
  check('bar 2 left hand moved up, left hand rests', !ns.some((n) => !n.rest && n.bar === 1 && n.staff === 2) && ns.filter((n) => !n.rest && n.bar === 1 && n.staff === 1).length === 6 && barsFull(x));
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/${name}-moved-three.png` });
  else await page.screenshot({ path: `${SHOTS}/${name}-editor.png` });

  // undo / redo
  check('three steps', (await EN(() => window.__editNotes.step)) === 3);
  await act('undo'); await idle();
  ns = await EN(() => window.__editNotes.notes);
  check('Undo: bar 2 back in the left hand', ns.filter((n) => !n.rest && n.bar === 1 && n.staff === 2).length === 2 && (await EN(() => window.__editNotes.step)) === 2);
  check('Undo: drawn again with those notes', (await page.$$eval('#paper g[data-ref]:not(.nh-rest)', (e) => e.length)) === 23);
  await act('redo'); await idle();
  ns = await EN(() => window.__editNotes.notes);
  check('Redo: bar 2 up again', !ns.some((n) => !n.rest && n.bar === 1 && n.staff === 2) && (await EN(() => window.__editNotes.step)) === 3);
  if (!touch) { await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta'); await idle(); check('⌘Z undoes', (await EN(() => window.__editNotes.step)) === 2); await act('redo'); await idle(); }
  const want = await EN(() => window.__editNotes.xml);
  const wantNotes = await EN(() => window.__editNotes.notes.map((n) => `${n.bar}/${n.staff}/${n.on}/${n.dur}/${n.midi}`).sort().join(','));

  if (how === 'this' || how === 'new') {
    await act('save'); await sleep(300);
    await page.evaluate((m) => document.querySelector(`.np-save [data-mode="${m}"]`).click(), how); await sleep(2500);
    check('panel closed after saving', !(await page.$('.notes-panel')));
  }
  if (how === 'this') {
    const saved = await xmlOf(sc.id);
    check('saved into this score: the moved notes, bars full', barsFull(saved) && saved.replace(/\s+/g, '') === want.replace(/\s+/g, ''));
    const pv = await send('POST', `/items/${sc.id}/editnotes/preview`, { ops: [] });
    check('saved score has the same music as the editor showed', pv.notes.map((n) => `${n.bar}/${n.staff}/${n.on}/${n.dur}/${n.midi}`).sort().join(',') === wantNotes);
    await page.screenshot({ path: `${SHOTS}/${name}-saved.png` });
    const row = (await api('/activity')).find((r) => r.type === 'edit-notes' && r.title.includes(title));
    check('Activities has the edit, undoable', row && row.action === 'undo', JSON.stringify(row || {}));
    await send('POST', `/activity/${row.id}/undo`, {});
    check('Activities undo puts the score back', (await xmlOf(sc.id)) === x0);
  } else if (how === 'new') {
    await sleep(1000);
    const id = await page.evaluate(() => decodeURIComponent(location.hash.split('/').pop()));
    const it = await api(`/items/${id}`);
    check('saved as a new version (opened, tagged Hands moved)', id !== sc.id && it.tags?.includes('Hands moved') && it.groupId, JSON.stringify(it.tags));
    check('the new version has the moved notes, bars full', barsFull(await xmlOf(id)) && (await xmlOf(sc.id)) === x0);
    await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(500);
    await page.screenshot({ path: `${SHOTS}/${name}-new-version.png` });
    const row = (await api('/activity')).find((r) => r.type === 'edit-notes' && r.title.includes(title));
    await send('POST', `/activity/${row.id}/undo`, {});
    check('Activities undo trashes the new version', (await api(`/items/${id}`)).deleted);
  } else {
    // the other note tools: pitch, length, delete, add (on a note and on a rest), each one drawn again with full bars
    const pick = async (pred) => { const h = await headAt(pred); await act('none'); await tapXY(h.x, h.y); return h.ref; };
    const notesNow = () => EN(() => window.__editNotes.notes);
    await pick((n) => n.bar === 2 && n.staff === 1 && n.on === 1);  // bar 3, beat 2: C4
    await act('semi+'); await idle();
    let nn = await notesNow();
    check('♯: a semitone up (C → C♯)', nn.some((n) => n.bar === 2 && n.on === 1 && n.midi === 61 && !n.rest) && barsFull(await EN(() => window.__editNotes.xml)));
    await act('oct-'); await idle();
    check('8↓: an octave down', (await notesNow()).some((n) => n.bar === 2 && n.on === 1 && n.midi === 49));
    await tap('.notes-panel [data-len="2"]'); await idle();
    nn = await notesNow();
    check('½: a half note on beat 2 (written quarter~quarter tied, by the meter), over the next beat, bar still full', nn.some((n) => n.bar === 2 && n.on === 1 && n.dur === 1 && n.midi === 49 && n.tie) && nn.some((n) => n.bar === 2 && n.on === 2 && n.midi === 49) && !nn.some((n) => n.bar === 2 && n.staff === 1 && n.on === 2 && !n.rest && n.midi !== 49) && barsFull(await EN(() => window.__editNotes.xml)));
    await act('del'); await idle();
    nn = await notesNow();
    check('Delete: a rest in its place', !nn.some((n) => n.bar === 2 && n.midi === 49) && nn.some((n) => n.bar === 2 && n.staff === 1 && n.on === 1 && n.rest) && barsFull(await EN(() => window.__editNotes.xml)));
    const rr = await headAt((n) => n.bar === 2 && n.staff === 1 && n.on === 1 && n.rest);
    check('the rest can be picked on the score', !!rr);
    await act('none'); await tapXY(rr.x, rr.y);
    await act('add'); await idle();
    nn = await notesNow();
    check('+ Note on a rest: a note there', nn.some((n) => n.bar === 2 && n.staff === 1 && n.on === 1 && !n.rest && n.midi === 71) && barsFull(await EN(() => window.__editNotes.xml)));
    await act('add'); await idle();
    nn = await notesNow();
    check('+ Note on a note: a third above, same chord', nn.filter((n) => n.bar === 2 && n.staff === 1 && n.on === 1 && !n.rest).map((n) => n.midi).sort().join() === '71,75');
    await page.screenshot({ path: `${SHOTS}/${name}-tools.png` });
    await act('close'); await sleep(300);
    check('closing asks first', !!(await page.$('.modal-wrap')));
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close').click()); await sleep(1500);
    check('closed without saving: score unchanged, drawn as saved', !(await page.$('.notes-panel')) && (await xmlOf(sc.id)) === x0 && (await page.$$eval('#paper g[data-ref]', (e) => e.length)) === 0);
    check('player works after the editor', await (async () => { await tap('#sc-play'); await sleep(900); const q = await EN(() => window.__score.player.now()); await tap('#sc-stop'); return q > 0.3; })());
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

// ---- the left hand, from the score bar's pencil (it used to edit the upper staff only) ----
// bar 1: right hand a whole note, left hand eight 8ths with no beams; bar 2 repeats 4/4 (tidied away on an edit),
// left hand quarter, quarter rest, half.
const P = { 43: ['G', 2], 48: ['C', 3], 50: ['D', 3], 52: ['E', 3], 53: ['F', 3], 55: ['G', 3], 57: ['A', 3], 59: ['B', 3], 60: ['C', 4], 72: ['C', 5], 74: ['D', 5] };
const N = (m, d, staff, ty) => `<note>${m ? `<pitch><step>${P[m][0]}</step><octave>${P[m][1]}</octave></pitch>` : '<rest/>'}<duration>${d}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${ty}</type><staff>${staff}</staff></note>`;
const lhXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + '<measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
  + N(72, 8, 1, 'whole') + '<backup><duration>8</duration></backup>' + [48, 50, 52, 53, 55, 57, 59, 60].map((m) => N(m, 1, 2, 'eighth')).join('') + '</measure>'
  + '<measure number="2"><attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' + N(74, 8, 1, 'whole') + '<backup><duration>8</duration></backup>' + N(48, 2, 2, 'quarter') + N(0, 2, 2, 'quarter') + N(43, 4, 2, 'half') + '</measure></part></score-partwise>';
// the staff-2 notes of a bar: [{beam, rest, midi-ish, dur}] from the editor's MusicXML
const lhBar = (x, k) => x.split('<measure').slice(1)[k].split('<note').slice(1).filter((s) => /<staff>2</.test(s) && !/<chord\s*\/>/.test(s))
  .map((s) => ({ beam: s.match(/<beam number="1">([^<]+)</)?.[1] || '', rest: /<rest\b/.test(s), type: s.match(/<type>(\w+)/)?.[1], dur: +s.match(/<duration>(\d+)/)[1] }));

async function leftHand(name, vp) {
  console.log(`\nLeft hand — ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Left hand ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: lhXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`LH ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`LH ${name}: ${m.text()}`));
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const EN = (f) => page.evaluate(f);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const head = (pred) => page.evaluate((src) => {
    const f = new Function('n', `return (${src})(n)`);
    const n = window.__editNotes.notes.find(f);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    g.scrollIntoView({ block: 'center' });
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, pred.toString());
  const pick = async (pred) => { await act('none'); const h = await head(pred); await tapXY(h.x, h.y); return h.ref; };
  const xml = () => EN(() => window.__editNotes.xml);

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);
  check('the score bar\'s pencil opens Edit notes (both hands)', !!(await page.$('.notes-panel')) && !(await page.$('.editbar')));
  const lhTagged = await page.evaluate(() => window.__editNotes.notes.filter((n) => n.staff === 2).every((n) => document.querySelector(`#paper g[data-ref="${n.ref}"]`)));
  check('every left-hand note and rest can be picked', lhTagged);
  await page.screenshot({ path: `${SHOTS}/LH-${name}-before.png` });

  // pitch: tap the left hand's first 8th → ♯
  const c3 = await pick((n) => n.bar === 0 && n.staff === 2 && n.midi === 48);
  check('tap picks a left-hand note', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${c3}]`, JSON.stringify(await EN(() => window.__editNotes.sel)));
  await act('semi+'); await idle();
  let ns = await EN(() => window.__editNotes.notes);
  check('left hand ♯: C3 → C♯3', ns.some((n) => n.bar === 0 && n.staff === 2 && n.on === 0 && n.midi === 49));
  let x = await xml();
  check('after the edit the left-hand 8ths are beamed per half bar', lhBar(x, 0).map((n) => n.beam).join() === 'begin,continue,continue,end,begin,continue,continue,end', JSON.stringify(lhBar(x, 0)));
  check('the repeated 4/4 in bar 2 is gone', !/<time>/.test(x.split('<measure').slice(1)[1]) && (x.match(/<time>/g) || []).length === 1);
  check('bars still full', barsFull(x));

  // delete: the last four 8ths of bar 1 (Mac: click + Shift-click, iPad: Pick several) → one half rest
  const last = ns.filter((n) => n.bar === 0 && n.staff === 2 && n.on >= 2).sort((a, b) => a.on - b.on);
  await act('none');
  if (touch) {
    await act('several');
    for (const n of last) { const h = await page.evaluate((r) => { const g = document.querySelector(`#paper g[data-ref="${r}"]`); const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, n.ref); await tapXY(h.x, h.y); }
    await act('several');
  } else {
    const a = await head((n) => n.bar === 0 && n.staff === 2 && n.on === 2), z = await head((n) => n.bar === 0 && n.staff === 2 && n.on === 3.5);
    await tapXY(a.x, a.y);
    await page.keyboard.down('Shift'); await page.mouse.click(z.x, z.y); await page.keyboard.up('Shift'); await sleep(150);
  }
  check('four left-hand 8ths picked', (await EN(() => window.__editNotes.sel.length)) === 4, JSON.stringify(await EN(() => window.__editNotes.sel)));
  await act('del'); await idle();
  x = await xml();
  const b1 = lhBar(x, 0);
  check('four 8th rests become one half rest', b1.filter((n) => n.rest).length === 1 && b1.find((n) => n.rest).type === 'half' && b1.find((n) => n.rest).dur === 4, JSON.stringify(b1));
  check('the 8ths left stay beamed', b1.filter((n) => !n.rest).map((n) => n.beam).join() === 'begin,continue,continue,end');

  // add: bar 2's left-hand C3 → ⅛ (an 8th rest after it), + Note on that rest → two 8ths, beamed
  await pick((n) => n.bar === 1 && n.staff === 2 && n.midi === 48);
  await tap('.notes-panel [data-len="0.5"]'); await idle();
  await pick((n) => n.bar === 1 && n.staff === 2 && n.rest && n.on === 0.5);
  await act('add'); await idle();
  x = await xml(); ns = await EN(() => window.__editNotes.notes);
  check('+ Note on a left-hand rest: a note there', ns.some((n) => n.bar === 1 && n.staff === 2 && n.on === 0.5 && !n.rest));
  const b2 = lhBar(x, 1);
  check('two adjacent left-hand 8ths are beamed', b2[0].beam === 'begin' && b2[1].beam === 'end' && b2[0].type === 'eighth' && b2[1].type === 'eighth', JSON.stringify(b2));
  check('bar 2 still full (quarter rest, half note)', barsFull(x) && b2.length === 4 && b2[2].rest && b2[2].type === 'quarter', JSON.stringify(b2));

  // move: the left hand's C♯3 to the right hand
  await pick((n) => n.bar === 0 && n.staff === 2 && n.midi === 49);
  await act('up'); await idle();
  ns = await EN(() => window.__editNotes.notes);
  check('left-hand note to the right hand', ns.some((n) => n.bar === 0 && n.staff === 1 && n.midi === 49) && !ns.some((n) => n.bar === 0 && n.staff === 2 && n.midi === 49) && barsFull(await xml()));
  await page.screenshot({ path: `${SHOTS}/LH-${name}-after.png` });
  const want = await xml();
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  const saved = await xmlOf(sc.id);
  check('saved: same as the editor showed', saved.replace(/\s+/g, '') === want.replace(/\s+/g, ''));
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.screenshot({ path: `${SHOTS}/LH-${name}-saved.png` });
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

// ---- the play start after an edit, ▶ From here, Stop, page turning while editing, ties and slurs ----
// 48 bars, 4/4, quarters (bar k: its own four pitches); bar 2's last half note is tied into bar 3; bar 4 = G G F E
// (a tie G→G can be made, F→E cannot); left hand a whole note per bar.
const LS = { 48: ['C', 3], 53: ['F', 3], 55: ['G', 3], 60: ['C', 4], 62: ['D', 4], 64: ['E', 4], 65: ['F', 4], 67: ['G', 4], 69: ['A', 4], 71: ['B', 4], 72: ['C', 5] };
const LN = (m, d, staff, ty, tie = '') => `<note><pitch><step>${LS[m][0]}</step><octave>${LS[m][1]}</octave></pitch><duration>${d}</duration>${tie ? `<tie type="${tie}"/>` : ''}<voice>${staff === 2 ? 5 : 1}</voice><type>${ty}</type><staff>${staff}</staff>${tie ? `<notations><tied type="${tie}"/></notations>` : ''}</note>`;
const RH16 = (k) => k === 1 ? LN(64, 2, 1, 'quarter') + LN(65, 2, 1, 'quarter') + LN(67, 4, 1, 'half', 'start')
  : k === 2 ? LN(67, 2, 1, 'quarter', 'stop') + LN(65, 2, 1, 'quarter') + LN(64, 2, 1, 'quarter') + LN(62, 2, 1, 'quarter')
  : k === 3 ? LN(67, 2, 1, 'quarter') + LN(67, 2, 1, 'quarter') + LN(65, 2, 1, 'quarter') + LN(64, 2, 1, 'quarter')
  : [60, 62, 64, 65, 67, 69, 71, 72].slice(k % 5, (k % 5) + 4).map((m) => LN(m, 2, 1, 'quarter')).join('');
const longXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + Array.from({ length: 48 }, (_, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type><sound tempo="120"/></direction>'}`
    + RH16(k) + '<backup><duration>8</duration></backup>' + LN([48, 53, 55][k % 3], 8, 2, 'whole') + '</measure>').join('') + '</part></score-partwise>';
const arcs = (x) => ({ ties: (x.match(/<tied type="start"/g) || []).length, stops: (x.match(/<tied type="stop"/g) || []).length, slurs: (x.match(/<slur\b[^>]*type="start"/g) || []).length });

async function cueAndArcs(name, vp) {
  console.log(`\nPlay start, pages, ties / slurs — ${name}`);
  const touch = !!vp.hasTouch, phone = vp.width < 500;
  const title = `Cue ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: longXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`cue ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/400|404|409|favicon/.test(m.text()) && errs.push(`cue ${name}: ${m.text()}`)); // 400: the refused tie (F → E), on purpose
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const notes = () => EN(() => window.__editNotes.notes);
  const refOf = async (pred) => (await notes()).find(pred)?.ref;
  const select = async (refs) => { await EN((r) => window.__editNotes.select(r), refs); await sleep(100); };
  const lineOn = () => page.$eval('.playbar', (e) => getComputedStyle(e).display !== 'none');
  const S = () => EN(() => ({ q: window.__score.player.now(), cue: window.__score.cueQ, bar: window.__editNotes?.cueBar, page: window.__score.page, pages: window.__score.pages, playing: window.__score.player.playing }));

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  if (touch && !phone) { await EN(() => window.__score.setZoom(1.6)); await sleep(1200); } // iPad: big enough for pages
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);
  const starts = await EN(() => window.__score.barStarts());
  check('bar starts read from the score (48 bars of 4)', starts.length === 48 && starts[4] === 16, JSON.stringify(starts));

  // edit bar 5 (its 2nd note up a semitone) → the line goes to bar 4; Play plays the edited notes from there
  const r5 = await refOf((n) => n.bar === 4 && n.staff === 1 && n.on === 1);
  const m5 = (await notes()).find((n) => n.ref === r5).midi;
  await select([r5]); await act('semi+'); await idle();
  let s = await S();
  check('edit bar 5 → the play start is bar 4', s.bar === 4 && s.cue === 12 && s.q === 12, JSON.stringify(s));
  check('the orange line shows at the cue', await lineOn());
  const heard = await EN((m) => window.__score.player.notes.filter((n) => n.q === 17).map((n) => n.n), m5);
  check('the player has the edited (unsaved) note: bar 5 beat 2 is a semitone up', heard.includes(m5 + 1) && !heard.includes(m5), JSON.stringify(heard));
  if (!phone) { // iPhone: the score bar is hidden while editing; ▶ From here plays
    await tap('#sc-play'); await sleep(700);
    s = await S();
    check('Play starts at the cue (bar 4), not at the top', s.playing && s.q >= 12 && s.q < 14.5, JSON.stringify(s));
    await tap('#sc-stop'); await sleep(250);
    s = await S();
    check('Stop: back to the cue, the line stays', !s.playing && s.q === 12 && (await lineOn()), JSON.stringify(s));
    await tap('#sc-stop'); await sleep(250);
    s = await S();
    // (Edit notes keeps the line on show at the start, so its grip can be dragged — cuedrag.mjs)
    const atStart = await page.$eval('.playbar', (e) => new DOMMatrix(getComputedStyle(e).transform).m41);
    const first = await page.evaluate(() => { const g = document.querySelector('#paper g[data-ref]'); const h = document.querySelector('.playbar').parentElement; return g.getBoundingClientRect().left - h.getBoundingClientRect().left; });
    check('Stop again: back to the beginning, the line at the start', s.q === 0 && s.cue === 0 && (await lineOn()) && Math.abs(atStart - first) < 40, JSON.stringify({ s, atStart, first }));
  }
  await select([r5]);
  await act('playhere'); await sleep(700);
  s = await S();
  check('▶ From here: plays from the bar before the picked note', s.playing && s.q >= 12 && s.q < 14.5 && s.bar === 4, JSON.stringify(s));
  check('…and turns into Pause', (await page.$eval('.notes-panel [data-a="playhere"]', (e) => e.getAttribute('aria-label'))) === 'Pause');
  await act('playhere'); await sleep(200);
  check('Pause stops it', !(await S()).playing);

  // edit bar 1 → the play start is bar 1 (the line shows at the very start)
  const r1 = await refOf((n) => n.bar === 0 && n.staff === 1 && n.on === 0);
  await select([r1]); await act('semi-'); await idle();
  s = await S();
  check('edit bar 1 → the play start is bar 1', s.bar === 1 && s.cue === 0 && s.q === 0 && (await lineOn()), JSON.stringify(s));
  await act('undo'); await idle();
  check('undo: cue at the bar before the undone edit (bar 1)', (await S()).bar === 1);

  // ties and slurs
  let x = await EN(() => window.__editNotes.xml);
  check('the score has its tie (bar 2 → 3)', arcs(x).ties === 1 && arcs(x).stops === 1, JSON.stringify(arcs(x)));
  const tied = await EN(() => window.__score.player.notes.filter((n) => n.n === 67 && (n.q === 6 || n.q === 8)));
  check('playback: the tie joins the sound (one G, 3 beats)', tied.length === 1 && tied[0].q === 6 && tied[0].d === 3, JSON.stringify(tied));
  const paths0 = await page.$$eval('#osmd svg path', (e) => e.length);
  const g1 = await refOf((n) => n.bar === 3 && n.staff === 1 && n.on === 0);
  await select([g1]); await act('tie'); await idle();
  x = await EN(() => window.__editNotes.xml);
  check('⌒ Tie: G → G in bar 4', arcs(x).ties === 2 && (await notes()).find((n) => n.bar === 3 && n.on === 0 && n.staff === 1)?.tie, JSON.stringify(arcs(x)));
  check('the tie is drawn at once', (await page.$$eval('#osmd svg path', (e) => e.length)) > paths0);
  check('tie button shows on for a tied note', await EN((r) => { window.__editNotes.select([r]); return document.querySelector('.notes-panel [data-a="tie"]').classList.contains('on'); }, (await notes()).find((n) => n.bar === 3 && n.on === 0 && n.staff === 1).ref));
  const f4 = await refOf((n) => n.bar === 3 && n.staff === 1 && n.on === 2);
  await select([f4]); await act('tie'); await idle();
  const tt = await page.$eval('#toast', (e) => ({ text: e.textContent, hidden: e.hidden }));
  check('⌒ Tie F → E: refused, offers a slur', !tt.hidden && /another pitch/.test(tt.text) && /Make it a slur/.test(tt.text), JSON.stringify(tt));
  await tap('#toast button'); await idle();
  check('“Make it a slur”: F ⁀ E', arcs(await EN(() => window.__editNotes.xml)).slurs === 1 && (await notes()).find((n) => n.bar === 3 && n.on === 3 && n.staff === 1)?.slur);
  // a slur over a range (bar 7, beats 1–4), then away again
  const b7 = (await notes()).filter((n) => n.bar === 6 && n.staff === 1 && !n.rest).map((n) => n.ref);
  await select(b7); await act('slur'); await idle();
  check('⁀ Slur over bar 7', arcs(await EN(() => window.__editNotes.xml)).slurs === 2 && (await notes()).filter((n) => n.bar === 6 && n.staff === 1).every((n) => n.slur));
  await select([b7[1]]); await act('slur'); await idle();
  check('⁀ Slur on a slurred note takes it away', arcs(await EN(() => window.__editNotes.xml)).slurs === 1);
  // edits keep them: pitch on the tied G (its partner goes too), a length inside the slur
  const before = arcs(await EN(() => window.__editNotes.xml));
  await select([await refOf((n) => n.bar === 2 && n.on === 0 && n.staff === 1)]); await act('semi+'); await idle();
  const gs = (await notes()).filter((n) => n.staff === 1 && ((n.bar === 1 && n.on === 2) || (n.bar === 2 && n.on === 0))).map((n) => n.midi);
  check('pitch on a tied note: both notes move, the tie stays', gs.join() === '68,68' && JSON.stringify(arcs(await EN(() => window.__editNotes.xml))) === JSON.stringify(before), JSON.stringify([gs, arcs(await EN(() => window.__editNotes.xml))]));
  await select([await refOf((n) => n.bar === 3 && n.on === 3 && n.staff === 1)]); await tap('.notes-panel [data-len="0.5"]'); await idle();
  check('a length change on a slurred note keeps the slur', arcs(await EN(() => window.__editNotes.xml)).slurs === 1 && barsFull(await EN(() => window.__editNotes.xml)));

  // pages while editing (iPad / iPhone): ‹ › and the dots turn, ← → walk the notes and turn with them; all kept
  s = await S();
  if (touch && s.pages > 1) {
    const keep = await EN(() => ({ sel: window.__editNotes.sel, step: window.__editNotes.step, cue: window.__score.cueQ }));
    await act('none');
    await EN(() => window.__score.goTo(1)); await sleep(200);
    await select([await refOf((n) => n.bar === 0 && n.on === 0 && n.staff === 1)]);
    const kept = await EN(() => window.__editNotes.sel);
    await sleep(600); // the panel's height settles (a picked note changes it; the pages are cut again after 250 ms)
    await act('next'); await sleep(300);
    s = await S();
    check('› turns to page 2 while editing', s.page === 2, JSON.stringify(s));
    check('…the picked note, the edits and the play start stay', JSON.stringify(await EN(() => window.__editNotes.sel)) === JSON.stringify(kept) && (await EN(() => window.__editNotes.step)) === keep.step && s.cue === keep.cue);
    check('the page number shows in the edit bar', (await page.$eval('#np-pageno', (e) => e.textContent)) === `2/${s.pages}`);
    await act('prev'); await sleep(300);
    check('‹ turns back', (await S()).page === 1);
    const dot = await page.$eval('.score-dots i:nth-child(2)', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
    await tapXY(dot.x, dot.y); await sleep(300);
    check('tapping a page dot turns there (and picks nothing)', (await S()).page === 2 && JSON.stringify(await EN(() => window.__editNotes.sel)) === JSON.stringify(kept) && dot.w >= 20, JSON.stringify(dot));
    await page.keyboard.press('PageUp'); await sleep(300);
    check('Page ↑ turns back a page', (await S()).page === 1);
    // the last right-hand note on page 1, then → : the next note, on page 2
    const lastOn1 = await EN(() => {
      const clip = document.querySelector('#clip').getBoundingClientRect();
      const on = window.__editNotes.notes.filter((n) => n.staff === 1).filter((n) => { const g = document.querySelector(`#paper g[data-ref="${n.ref}"]`); if (!g) return false; const r = g.getBoundingClientRect(); return r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1; });
      on.sort((a, c) => a.bar * 1e4 + a.on - (c.bar * 1e4 + c.on));
      return on.at(-1);
    });
    await select([lastOn1.ref]);
    await page.keyboard.press('ArrowRight'); await sleep(400);
    const nowSel = await EN(() => window.__editNotes.notes.find((n) => n.ref === window.__editNotes.sel[0]));
    check('→ past the page\'s last bar: the next note is picked and the page turns', (await S()).page === 2 && nowSel && nowSel.bar * 1e4 + nowSel.on > lastOn1.bar * 1e4 + lastOn1.on, JSON.stringify([lastOn1, nowSel, await S()]));
    await page.keyboard.press('ArrowLeft'); await sleep(400);
    check('← back: page 1 again', (await S()).page === 1);
  } else if (!touch) {
    await select([r1]);
    await page.keyboard.press('ArrowRight'); await sleep(200);
    const n2 = await EN(() => window.__editNotes.notes.find((n) => n.ref === window.__editNotes.sel[0]));
    check('→ picks the next note (Mac)', n2 && n2.bar === 0 && n2.on === 1, JSON.stringify(n2));
  } else check(`${name}: the long score has pages while editing`, false, JSON.stringify(s));
  await page.screenshot({ path: `${SHOTS}/cue-${name}.png` });

  // save into this score: ties and slurs kept; the play start = a bar before the first bar edited
  const want = arcs(await EN(() => window.__editNotes.xml));
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  const saved = await xmlOf(sc.id);
  check('saved: ties and slurs kept', JSON.stringify(arcs(saved)) === JSON.stringify(want) && barsFull(saved), JSON.stringify([arcs(saved), want]));
  s = await EN(() => ({ q: window.__score.player.now(), cue: window.__score.cueQ }));
  check('after the save the play start is a bar before the first bar edited (bar 3 → bar 2)', s.cue === 4 && s.q === 4 && (await lineOn()), JSON.stringify(s));
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

// ---- Bar ▾: pick a bar (tap its empty space, or a note), clear / add a hand, insert / delete bars, add / remove a
// staff (a voice line on top for lyrics), undo; then a 3-staff score with lyrics on the top staff: picking, an edit,
// Save keeps everything, it plays ----
async function barTools(name, vp) {
  console.log(`\nBar ▾ ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Bar tools ${name} ${stamp}`;
  // bar 3 has no left hand at all (an odd file); the rest as Ode to Joy
  const xml = scoreXml(title).replace(/(<measure number="3">[\s\S]*?)<backup><duration>8<\/duration><\/backup>[\s\S]*?<\/measure>/, '$1</measure>');
  const sc = await send('POST', '/items', { kind: 'score', title, musicxmlText: xml });
  let page;
  const newPage = async () => {
    page = await b.newPage(); await page.setViewport(vp);
    page.on('pageerror', (e) => errs.push(`bar ${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`bar ${name}: ${m.text()}`));
  };
  await newPage();
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(200); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(200); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const menuItems = () => page.$$eval('.menu > button', (e) => e.map((x) => x.textContent.trim() + (x.disabled ? ' (off)' : '')));
  const pickMenu = async (label) => {
    await act('barmenu'); await sleep(250);
    const i = await page.$$eval('.menu > button', (e, l) => e.findIndex((x) => x.textContent.trim() === l), label);
    if (i < 0) { check(`menu has “${label}”`, false, (await menuItems()).join(' | ')); return; }
    await tap(`.menu > button:nth-of-type(${i + 1})`);
  };
  const confirm = async () => { await sleep(300); await page.evaluate(() => document.querySelector('.modal-wrap .modal-actions button:last-child').click()); await sleep(200); };
  const nowNotes = () => EN(() => window.__editNotes.notes);
  const sounding = (ns) => ns.filter((n) => !n.rest).map((n) => `${n.bar}/${n.staff}/${n.on}/${n.midi}`).sort().join();
  // a point in a bar's staff, away from every notehead and rest (the bar's empty space)
  const emptySpot = (bar, staff) => EN(([bar, staff]) => {
    const osmd = window.__score.osmd, gm = osmd.GraphicSheet.MeasureList[bar][staff - 1], ps = gm.PositionAndShape;
    const svg = document.querySelectorAll('#osmd svg')[Math.max(0, osmd.GraphicSheet.MusicPages.indexOf(gm.ParentMusicSystem.Parent))];
    const m = svg.getScreenCTM(), y0 = (gm.ParentStaffLine?.PositionAndShape || ps).AbsolutePosition.y;
    const heads = [...document.querySelectorAll('#paper g[data-ref]')].map((g) => g.getBoundingClientRect()).map((r) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2]);
    let best = null;
    for (let fx = 0.05; fx < 1; fx += 0.03) for (const fy of [0.5, 1.5, 2.5, 3.5]) {
      const p = new DOMPoint((ps.AbsolutePosition.x + ps.BorderLeft + fx * (ps.BorderRight - ps.BorderLeft)) * 10, (y0 + fy) * 10).matrixTransform(m);
      const d = Math.min(...heads.map(([x, y]) => Math.hypot(x - p.x, y - p.y)));
      if (!best || d > best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }, [bar, staff]);

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(700);
  const n0 = await nowNotes();

  // 1. tap bar 2's empty space (left hand) → the bar is picked, shaded; Bar ▾ says which bar
  let spot = await emptySpot(1, 2);
  await tapXY(spot.x, spot.y);
  check('tapping a bar’s empty space picks the bar', JSON.stringify(await EN(() => window.__editNotes.barPick)) === '{"bar":1,"staff":2}' && (await EN(() => window.__editNotes.sel.length)) === 0, `${JSON.stringify(await EN(() => window.__editNotes.barPick))} d=${spot.d}`);
  check('the bar is shaded, the button says “Bar 2 ▾”', (await page.$$('#paper rect.np-barpick')).length === 2 && (await page.$eval('[data-a="barmenu"]', (e) => e.textContent.trim())) === 'Bar 2 ▾');
  await act('barmenu'); await sleep(250);
  const items = await menuItems();
  check('Bar ▾: clear / add each hand, insert before / after, delete, add / remove a staff',
    ['Clear the right hand in bar 2', 'Clear the left hand in bar 2', 'Add the right hand to bar 2', 'Add the left hand to bar 2', 'Insert an empty bar before bar 2', 'Insert an empty bar after bar 2', 'Delete bar 2', 'Add a voice staff on top (for lyrics)', 'Add a staff…', 'Remove the right hand staff…', 'Remove the left hand staff…'].every((l) => items.includes(l)), items.join(' | '));
  if (name === 'iPad') await page.screenshot({ path: `${SHOTS}/${name}-barmenu.png` });
  await page.evaluate(() => document.querySelector('.menu')?.remove());

  // 2. clear the left hand in bar 2: a whole rest; the right hand stays; undo brings it back
  await pickMenu('Clear the left hand in bar 2'); await idle();
  let ns = await nowNotes(), x = await EN(() => window.__editNotes.xml);
  check('Clear left hand: bar 2’s left hand is one whole rest, right hand kept', ns.filter((n) => n.bar === 1 && n.staff === 2).every((n) => n.rest) && ns.filter((n) => n.bar === 1 && n.staff === 2).length === 1
    && sounding(ns.filter((n) => n.staff === 1)) === sounding(n0.filter((n) => n.staff === 1)), JSON.stringify(ns.filter((n) => n.bar === 1 && n.staff === 2)));
  check('the score drew again with it', (await page.$$eval('#paper g.nh-rest', (e) => e.length)) >= 1);
  await act('undo'); await idle();
  check('Undo: the left hand is back', sounding(await nowNotes()) === sounding(n0));
  await act('redo'); await idle();
  check('Redo: cleared again', (await nowNotes()).filter((n) => n.bar === 1 && n.staff === 2 && !n.rest).length === 0);
  await act('undo'); await idle();

  // 3. bar 3 has no left hand: pick one of its notes, Bar ▾ → Add the left hand → a whole rest, picked; + Note writes there
  let h = await page.evaluate(() => { const n = window.__editNotes.notes.find((x) => x.bar === 2 && x.staff === 1 && !x.rest); const r = document.querySelector(`#paper g[data-ref="${n.ref}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await tapXY(h.x, h.y);
  check('a note picked: Bar ▾ is that bar', (await page.$eval('[data-a="barmenu"]', (e) => e.textContent.trim())) === 'Bar 3 ▾');
  await pickMenu('Add the left hand to bar 3'); await idle();
  ns = await nowNotes(); x = await EN(() => window.__editNotes.xml);
  const lh3 = ns.filter((n) => n.bar === 2 && n.staff === 2);
  check('Add left hand: bar 3 gets a whole-bar rest on the left hand, picked', lh3.length === 1 && lh3[0].rest && lh3[0].dur === 4 && (await EN(() => window.__editNotes.sel)).includes(lh3[0].ref) && barsFull(x), JSON.stringify(lh3));
  await act('add'); await idle();
  check('+ Note on it: a note in the new left hand', (await nowNotes()).some((n) => n.bar === 2 && n.staff === 2 && !n.rest));
  const afterAdd = await nowNotes();

  // 4. insert an empty bar after bar 1, then delete it (empty: no question) and delete bar 1 (asks first), undo
  spot = await emptySpot(0, 1); await tapXY(spot.x, spot.y);
  await pickMenu('Insert an empty bar after bar 1'); await idle();
  ns = await nowNotes(); x = await EN(() => window.__editNotes.xml);
  check('Insert after: 5 bars, bar 2 empty on both staves, later bars moved on, renumbered', new Set(ns.map((n) => n.bar)).size === 5 && ns.filter((n) => n.bar === 1).every((n) => n.rest) && ns.filter((n) => n.bar === 1).length === 2
    && sounding(ns.filter((n) => n.bar >= 2).map((n) => ({ ...n, bar: n.bar - 1 }))) === sounding(afterAdd.filter((n) => n.bar >= 1)) && /<measure number="5"/.test(x) && barsFull(x));
  await pickMenu('Delete bar 2'); await idle();
  check('Delete an empty bar: no question, 4 bars again', !(await page.$('.modal-wrap')) && sounding(await nowNotes()) === sounding(afterAdd));
  spot = await emptySpot(0, 2); await tapXY(spot.x, spot.y);
  await pickMenu('Delete bar 1'); await sleep(300);
  check('Delete a bar with notes asks first', !!(await page.$('.modal-wrap')));
  await confirm(); await idle();
  ns = await nowNotes(); x = await EN(() => window.__editNotes.xml);
  check('Delete bar 1: 3 bars, the key / time / clefs / tempo carry on', new Set(ns.map((n) => n.bar)).size === 3 && /<divisions>/.test(x.split('<measure')[1]) && /<clef number="2">/.test(x.split('<measure')[1]) && /tempo="120"/.test(x.split('<measure')[1]) && barsFull(x));
  await act('undo'); await idle();
  check('Undo: bar 1 is back', sounding(await nowNotes()) === sounding(afterAdd));

  // 5. a voice staff on top: 3 staves, all pickable; ↓ moves a right-hand note to the left hand (one staff down)
  await pickMenu('Add a voice staff on top (for lyrics)'); await idle();
  ns = await nowNotes(); x = await EN(() => window.__editNotes.xml);
  check('Add a voice staff: 3 staves, a rest in every bar of the top one, the piano one staff down', (await EN(() => window.__editNotes.staves)) === 3 && /<staves>3<\/staves>/.test(x)
    && ns.filter((n) => n.staff === 1).length === 4 && ns.filter((n) => n.staff === 1).every((n) => n.rest) && sounding(ns.map((n) => ({ ...n, staff: n.staff - 1 }))) === sounding(afterAdd));
  check('every note and rest of the 3 staves can be picked', (await page.$$eval('#paper g[data-ref]', (e) => new Set(e.map((g) => g.dataset.ref)).size)) === ns.length, `${await page.$$eval('#paper g[data-ref]', (e) => e.length)} / ${ns.length}`);
  h = await page.evaluate(() => { const n = window.__editNotes.notes.find((x) => x.bar === 1 && x.staff === 2 && !x.rest); const r = document.querySelector(`#paper g[data-ref="${n.ref}"]`).getBoundingClientRect(); return { ref: n.ref, midi: n.midi, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await act('none'); await tapXY(h.x, h.y);
  check('the move buttons name the staves', (await page.$eval('[data-a="up"]', (e) => e.textContent.trim())).startsWith('↑ To voice') && (await page.$eval('[data-a="down"]', (e) => e.textContent.trim())).startsWith('↓ To left hand'));
  await act('down'); await idle();
  check('↓ moves it to the left hand (staff 3)', (await nowNotes()).some((n) => n.bar === 1 && n.staff === 3 && n.midi === h.midi) && barsFull(await EN(() => window.__editNotes.xml)));
  if (name === 'iPad') await page.screenshot({ path: `${SHOTS}/${name}-three-staves.png` });
  await act('none');
  await pickMenu('Remove the voice staff…'); await sleep(300);
  check('Remove a staff asks first', !!(await page.$('.modal-wrap')));
  await confirm(); await idle();
  check('Remove the voice staff: 2 staves again', (await EN(() => window.__editNotes.staves)) === 2 && !/<staves>3/.test(await EN(() => window.__editNotes.xml)));
  await act('undo'); await idle();
  check('Undo: the voice staff is back', (await EN(() => window.__editNotes.staves)) === 3);
  // Save into the score keeps all of it
  const want = await EN(() => window.__editNotes.xml);
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  check('Save: the file is what the editor showed (3 staves)', (await xmlOf(sc.id)) === want && /<staves>3<\/staves>/.test(want));
  check('the 3-staff score plays', await (async () => { await tap('#sc-play'); await sleep(900); const q = await EN(() => window.__score.player.now()); await tap('#sc-stop'); return q > 0.3; })());
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});

  // 6. voice + piano with lyrics on the voice staff (made by the Mac's own ops): it draws the words, every note picks,
  // an edit on the piano and Save keep the voice line and its words
  const t2 = `Voice and piano ${name} ${stamp}`;
  const base2 = await send('POST', '/items', { kind: 'score', title: t2, musicxmlText: scoreXml(t2) });
  let pv = await send('POST', `/items/${base2.id}/editnotes/preview`, { ops: [{ op: 'addstaff', at: 1, clef: 'treble' }] });
  const rests = pv.notes.filter((n) => n.staff === 1).map((n) => n.ref);
  pv = await send('POST', `/items/${base2.id}/editnotes/preview`, { ops: [{ op: 'addstaff', at: 1, clef: 'treble' }, { op: 'add', refs: rests, midi: 72 }] });
  let k = 0;
  const sung = pv.xml.replace(/(<note>\s*<pitch>\s*<step>C<\/step>\s*<octave>5<\/octave>\s*<\/pitch>[\s\S]*?<staff>1<\/staff>)/g, (m) => `${m}<lyric number="1"><syllabic>single</syllabic><text>la${k++}</text></lyric>`);
  const voc = await send('POST', '/items', { kind: 'score', title: `${t2} sung`, musicxmlText: sung });
  await send('POST', '/items/trash', { ids: [base2.id] }).catch(() => {});
  await page.close(); await newPage();
  await page.goto(`${BASE}#/item/${voc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(900);
  const words = await page.$$eval('#osmd svg text', (e) => e.map((t) => t.textContent).filter((t) => /^la\d$/.test(t)));
  check('voice + piano: the words are drawn under the voice staff', k === 4 && words.length === 4, `${k} / ${words.join(',')}`);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(700);
  ns = await nowNotes();
  check('voice + piano: 3 staves, every note picks', (await EN(() => window.__editNotes.staves)) === 3 && (await page.$$eval('#paper g[data-ref]', (e) => new Set(e.map((g) => g.dataset.ref)).size)) === ns.length);
  h = await page.evaluate(() => { const n = window.__editNotes.notes.find((x) => x.bar === 0 && x.staff === 3 && !x.rest); const r = document.querySelector(`#paper g[data-ref="${n.ref}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await tapXY(h.x, h.y);
  await act('semi+'); await idle();
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  const saved = await xmlOf(voc.id);
  check('voice + piano: an edit + Save keeps the voice line and its words', (saved.match(/<text>la\d<\/text>/g) || []).length === 4 && /<staves>3<\/staves>/.test(saved) && saved !== sung);
  check('voice + piano plays', await (async () => { await tap('#sc-play'); await sleep(900); const q = await EN(() => window.__score.player.now()); await tap('#sc-stop'); return q > 0.3; })());
  await send('POST', '/items/trash', { ids: [voc.id] }).catch(() => {});
  await page.close();
}

// ---- the edit bar fits on one row per line (nothing wraps) on iPad Pro 13" and iPad 11", portrait and landscape:
// nothing picked, a note picked, a bar picked, and with 3 staves ----
async function editBarFits() {
  console.log('\nEdit bar on iPads');
  const title = `Edit bar fits ${stamp}`;
  const pv = await send('POST', '/items', { kind: 'score', title: title + ' src', musicxmlText: scoreXml(title) });
  const p0 = await send('POST', `/items/${pv.id}/editnotes/preview`, { ops: [] });
  const one = await send('POST', `/items/${pv.id}/editnotes/preview`, { ops: [{ op: 'delete', refs: [p0.notes.find((n) => n.bar === 0 && n.staff === 1 && n.on === 1).ref] }] });
  await send('POST', '/items/trash', { ids: [pv.id] }).catch(() => {});
  const pv0 = await send('POST', '/items', { kind: 'score', title, musicxmlText: one.xml });
  const wrapped = () => page.evaluate(() => [...document.querySelectorAll('.notes-panel .np-row, .notes-panel .np-acts')].filter((row) => {
    const kids = [...row.children].filter((k) => k.offsetParent && !k.classList.contains('grow'));
    const bot = Math.min(...kids.map((k) => k.getBoundingClientRect().bottom));
    return kids.some((k) => k.getBoundingClientRect().top >= bot - 1);
  }).map((row) => row.className));
  let page;
  for (const [dev, w, h] of [['iPad Pro 13"', 1032, 1376], ['iPad Pro 13"', 1376, 1032], ['iPad 11"', 834, 1194], ['iPad 11"', 1194, 834], ['iPad Air 11"', 820, 1180], ['iPad Air 11"', 1180, 820]]) {
    page = await b.newPage(); await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errs.push(`fits ${w}: ${e.message}`));
    await page.goto(`${BASE}#/item/${pv0.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
    await page.evaluate(() => document.querySelector('#sc-edit').click());
    await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);
    const bad = [];
    bad.push(...(await wrapped()).map((c) => `nothing picked: ${c}`));
    await page.evaluate(() => window.__editNotes.select([window.__editNotes.notes.find((n) => !n.rest && n.staff === 1).ref])); await sleep(200);
    bad.push(...(await wrapped()).map((c) => `a note: ${c}`));
    await page.evaluate(() => window.__editNotes.select([window.__editNotes.notes.find((n) => n.rest)?.ref ?? window.__editNotes.notes[0].ref])); await sleep(200);
    bad.push(...(await wrapped()).map((c) => `a rest: ${c}`));
    await page.evaluate(() => window.__editNotes.pickBar(3, 2)); await sleep(200);
    bad.push(...(await wrapped()).map((c) => `a bar: ${c}`));
    await page.evaluate(() => window.__editNotes.run({ op: 'addstaff', at: 1, clef: 'treble' }));
    for (let i = 0; i < 40 && (await page.evaluate(() => window.__editNotes.busy)); i++) await sleep(150);
    await sleep(600);
    await page.evaluate(() => window.__editNotes.select([window.__editNotes.notes.find((n) => !n.rest && n.staff === 2).ref])); await sleep(200);
    bad.push(...(await wrapped()).map((c) => `3 staves: ${c}`));
    check(`${dev} ${w}×${h}: the edit bar does not wrap`, !bad.length, bad.join('; '));
    if (w === 820) await page.screenshot({ path: `${SHOTS}/editbar-${w}.png` });
    await page.evaluate(() => { window.__editNotes.close(); }); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close')?.click()); await sleep(300);
    await page.close();
  }
  await send('POST', '/items/trash', { ids: [pv0.id] }).catch(() => {});
}

// ---- range tools: a range (Mac: Shift-click, Shift ← →, ⌘A, Esc; iPad: long-press then tap / drag), copy / cut /
// paste, ⟳ Repeat, octave on a range, ♯/♭ respell and the accidentals menu — one undo step each, saved like any edit ----
async function rangeTools(name, vp) {
  console.log(`\nRange tools ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Ranges ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`range ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`range ${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(600); };
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const act = async (a) => { if (touch) await page.tap(`.notes-panel [data-a="${a}"]`); else await page.click(`.notes-panel [data-a="${a}"]`); await sleep(150); };
  const key = async (k, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(k); for (const m of [...mods].reverse()) await page.keyboard.up(m); await sleep(150); };
  const headAt = (pred) => page.evaluate((src) => {
    const f = new Function('n', `return (${src})(n)`);
    const n = window.__editNotes.notes.find(f);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, pred.toString());
  const music = (bar, staff) => EN(([bar, staff]) => window.__editNotes.notes.filter((n) => n.bar === bar && n.staff === staff).map((n) => (n.rest ? 'R' : n.midi) + '@' + n.on + ':' + n.dur).sort().join(' '), [bar, staff]);
  const toastText = () => page.$eval('#toast', (e) => e.textContent).catch(() => '');
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);
  const b1 = [await music(0, 1), await music(0, 2)], b2 = [await music(1, 1), await music(1, 2)];

  // 1. a range over bars 1–2, both staves
  let a = await headAt((n) => n.bar === 0 && n.staff === 1 && n.midi === 64 && n.on === 0);
  let z = await headAt((n) => n.bar === 1 && n.staff === 2 && n.on === 2);
  if (!touch) {
    await tapXY(a.x, a.y);
    await page.keyboard.down('Shift'); await page.mouse.click(z.x, z.y); await page.keyboard.up('Shift'); await sleep(200);
  } else {
    await page.touchscreen.touchStart(a.x, a.y); await sleep(700); await page.touchscreen.touchEnd(); await sleep(200);
    check('long-press: a range of one note, waiting for the last one', (await EN(() => window.__editNotes.rangeArm)) && (await EN(() => window.__editNotes.range?.b)) === 1, JSON.stringify(await EN(() => window.__editNotes.range)));
    z = await headAt((n) => n.bar === 1 && n.staff === 2 && n.on === 2);
    await tapXY(z.x, z.y); await sleep(200);
  }
  let r = await EN(() => window.__editNotes.range);
  check(`${touch ? 'long-press + tap' : 'Shift-click'}: a range over bars 1–2 on both staves`, r && r.a === 0 && r.b === 8 && r.s0 === 1 && r.s1 === 2, JSON.stringify(r));
  check('…every note of it picked, drawn as a blue box', (await EN(() => window.__editNotes.sel.length)) === 13 && (await page.$$eval('#paper .np-range', (e) => e.length)) >= 2, `${await EN(() => window.__editNotes.sel.length)} / ${await page.$$eval('#paper .np-range', (e) => e.length)}`);
  check('Copy / Cut / Repeat are on', !(await page.$eval('.notes-panel [data-a="copy"]', (e) => e.disabled)) && !(await page.$eval('.notes-panel [data-a="repeat"]', (e) => e.disabled)));
  await page.screenshot({ path: `${SHOTS}/Range-${name}.png` });
  if (touch) { // long-press, then drag to the last note
    await EN(() => window.__editNotes.select([])); await sleep(150);
    a = await headAt((n) => n.bar === 0 && n.staff === 1 && n.midi === 65);
    z = await headAt((n) => n.bar === 1 && n.staff === 1 && n.on === 3);
    await page.touchscreen.touchStart(a.x, a.y); await sleep(700);
    for (let k = 1; k <= 8; k++) { await page.touchscreen.touchMove(a.x + ((z.x - a.x) * k) / 8, a.y + ((z.y - a.y) * k) / 8); await sleep(30); }
    await page.touchscreen.touchEnd(); await sleep(250);
    r = await EN(() => window.__editNotes.range);
    check('long-press + drag: the range runs to the note let go on', r && r.a === 2 && r.b === 8 && r.s0 === 1 && r.s1 === 1 && !(await EN(() => window.__editNotes.rangeArm)), JSON.stringify(r));
    await EN(() => window.__editNotes.setRange({ a: 0, b: 8, s0: 1, s1: 2 })); await sleep(200);
  } else {
    await key('ArrowRight', ['Shift']);
    check('Shift →: the range a note longer', (await EN(() => window.__editNotes.range.b)) === 9, JSON.stringify(await EN(() => window.__editNotes.range)));
    await key('ArrowLeft', ['Shift']);
    check('Shift ←: back', (await EN(() => window.__editNotes.range.b)) === 8);
  }
  if (touch) await act('copy'); else await key('c', ['Meta']);
  await sleep(600);
  const clip = await EN(() => window.__editNotes.clip);
  check(`${touch ? 'Copy' : '⌘C'}: 2 bars on 2 staves copied`, clip?.bars === 2 && clip.staves === 2 && clip.whole, JSON.stringify(clip && { bars: clip.bars, staves: clip.staves }));
  check('…it says so', /Copied 2 bars on 2 staves/.test(await toastText()), await toastText());

  // 2. paste at bar 3: bars 3–4 are bars 1–2 now
  a = await headAt((n) => n.bar === 2 && n.staff === 1 && n.on === 0);
  await tapXY(a.x, a.y);
  const s0 = await EN(() => window.__editNotes.step);
  if (touch) await act('paste'); else await key('v', ['Meta']);
  await idle();
  check(`${touch ? 'Paste' : '⌘V'}: bars 3–4 are bars 1–2, both hands`, (await music(2, 1)) === b1[0] && (await music(2, 2)) === b1[1] && (await music(3, 1)) === b2[0] && (await music(3, 2)) === b2[1], await music(3, 1));
  let x = await EN(() => window.__editNotes.xml);
  check('…one undo step, the bars full, 4 bars still', (await EN(() => window.__editNotes.step)) === s0 + 1 && barsFull(x) && x.split('<measure').length - 1 === 4);
  r = await EN(() => window.__editNotes.range);
  check('…what it wrote is the range now', r && r.a === 8 && r.b === 16, JSON.stringify(r));
  // paste again at the last bar: a bar more at the end
  a = await headAt((n) => n.bar === 3 && n.staff === 1 && n.on === 0);
  await tapXY(a.x, a.y);
  if (touch) await act('paste'); else await key('v', ['Meta']);
  await idle();
  x = await EN(() => window.__editNotes.xml);
  check('Paste over the end: a bar added for it', x.split('<measure').length - 1 === 5 && barsFull(x) && (await music(4, 1)) === b2[0], String(x.split('<measure').length - 1));
  await act('undo'); await idle();
  check('Undo: 4 bars again', (await EN(() => window.__editNotes.xml)).split('<measure').length - 1 === 4);

  // 3. octave on a range (⌘A: the whole score) / on a chord
  if (!touch) {
    await key('a', ['Meta']);
    r = await EN(() => window.__editNotes.range);
    check('⌘A: the whole score is the range', r.a === 0 && r.b === 16 && r.s1 === 2, JSON.stringify(r));
    const before = await EN(() => window.__editNotes.notes.filter((n) => !n.rest).map((n) => n.midi).join());
    await key('ArrowUp', ['Meta']); await idle();
    const after = await EN(() => window.__editNotes.notes.filter((n) => !n.rest).map((n) => n.midi - 12).join());
    check('⌘↑: every note of the range an octave up, the range stays', before === after && (await EN(() => window.__editNotes.range?.b)) === 16, `${before} | ${after}`);
    await key('z', ['Meta']); await idle();
    await key('Escape');
    check('Esc: the range goes', !(await EN(() => window.__editNotes.range)) && !(await EN(() => window.__editNotes.sel.length)));
  } else {
    await EN(() => window.__editNotes.select(window.__editNotes.notes.filter((n) => n.bar === 0 && n.on === 0 && n.staff === 1).map((n) => n.ref))); await sleep(150);
    await act('oct+'); await idle();
    check('8↑ on a chord: both notes an octave up', (await EN(() => window.__editNotes.notes.filter((n) => n.bar === 0 && n.on === 0 && n.staff === 1).map((n) => n.midi).sort().join())) === '72,76');
    await act('undo'); await idle();
  }

  // 4. ⟳ Repeat one note: the F4 on beat 3 again on beat 4, then again over the bar line
  a = await headAt((n) => n.bar === 0 && n.staff === 1 && n.midi === 65);
  await tapXY(a.x, a.y);
  if (touch) await act('repeat'); else await key('r');
  await idle();
  check(`${touch ? '⟳' : 'R'}: the note again right after it`, (await music(0, 1)).split(' ').includes('65@3:1') && !(await music(0, 1)).includes('67@3'), await music(0, 1));
  if (touch) await act('repeat'); else await key('r');
  await idle();
  check('…again: the next one too (into bar 2)', (await music(1, 1)).split(' ').includes('65@0:1'), await music(1, 1));
  await act('undo'); await idle(); await act('undo'); await idle();
  check('Undo twice: bar 1 as it was', (await music(0, 1)) === b1[0]);

  // 5. Repeat a range of bars: bars 1–2 again as bars 3–4
  await EN(() => window.__editNotes.setRange({ a: 0, b: 8, s0: 1, s1: 2 })); await sleep(200);
  if (touch) await act('repeat'); else await key('r');
  await idle();
  check('Repeat a range: bars 3–4 are bars 1–2', (await music(2, 1)) === b1[0] && (await music(3, 2)) === b2[1] && barsFull(await EN(() => window.__editNotes.xml)));
  await act('undo'); await idle();

  // 6. cut bar 2's right hand: rests are left, the left hand stays
  await EN(() => window.__editNotes.setRange({ a: 4, b: 8, s0: 1, s1: 1 })); await sleep(200);
  if (touch) await act('cut'); else await key('x', ['Meta']);
  await idle();
  check(`${touch ? 'Cut' : '⌘X'}: bar 2's right hand is a whole-bar rest, the left hand stays`, (await music(1, 1)) === 'R@0:4' && (await music(1, 2)) === b2[1], await music(1, 1));
  check('…the clip has it', (await EN(() => window.__editNotes.clip?.notes)) === 4);
  await act('undo'); await idle();

  // 7. ♯/♭ respell: F4 → E♯4 → G𝄫4 → F4 (the sound stays); held / right-click: ♯ ♭ ♮, courtesy
  a = await headAt((n) => n.bar === 0 && n.staff === 1 && n.midi === 65);
  await tapXY(a.x, a.y);
  const spell = () => EN(() => { const n = window.__editNotes.notes.find((n) => n.bar === 0 && n.staff === 1 && n.on === 2); const m = new DOMParser().parseFromString(window.__editNotes.xml, 'application/xml'); const el = [...m.querySelectorAll('part > measure note')][n.ref]; return el.querySelector('step').textContent + (el.querySelector('alter')?.textContent || '') + ':' + (el.querySelector('accidental')?.textContent || '') + ':' + n.midi; });
  if (touch) await act('respell'); else await key('j');
  await idle();
  check(`${touch ? '♯/♭' : 'J'}: F4 written as E♯4, a sharp shown, same pitch`, (await spell()) === 'E1:sharp:65', await spell());
  if (touch) await act('respell'); else await key('j');
  await idle();
  check('…then G𝄫4', (await spell()) === 'G-2:flat-flat:65', await spell());
  if (touch) await act('respell'); else await key('j');
  await idle();
  check('…then F4 again, no accidental', (await spell()) === 'F::65', await spell());
  if (touch) {
    const bb = await page.$eval('.notes-panel [data-a="respell"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.touchStart(bb.x, bb.y); await sleep(700); await page.touchscreen.touchEnd(); await sleep(300);
  } else {
    await page.click('.notes-panel [data-a="respell"]', { button: 'right' }); await sleep(300);
  }
  const items = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check(`${touch ? 'holding' : 'right-click on'} ♯/♭: ♯ ♭ ♮ and a courtesy accidental`, ['♯ Sharp', '♭ Flat', '♮ Natural'].every((t) => items.includes(t)) && items.some((t) => /Courtesy/.test(t)), items.join('|'));
  check('…and holding did not respell', (await spell()) === 'F::65', await spell());
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === '♯ Sharp').click()); await idle();
  check('♯ Sharp: F♯4', (await spell()) === 'F1:sharp:66', await spell());
  await act('respell'); await idle();
  check('♯/♭ on F♯4: G♭4', (await spell()) === 'G-1:flat:66', await spell());

  // 8. save (into this score): the edits as one Activities step
  if (!touch) {
    await act('save'); await sleep(300);
    await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
    const saved = await xmlOf(sc.id);
    check('Save: the respelled note is in the score', /<step>G<\/step>\s*<alter>-1<\/alter>\s*<octave>4<\/octave>/.test(saved));
  } else {
    await EN(() => { window.__editNotes.close(); }); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close')?.click()); await sleep(300);
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}
if (process.env.ONLY === 'range') { await rangeTools('Mac', MAC); await rangeTools('iPad', IPAD); await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
// ---- bar structure in Bar ▾: pickup, key / time from here, repeat signs, 1st / 2nd endings — and playback follows
// the repeats (the player's stretches and the notes it actually plays, in order) ----
async function structure(name, vp) {
  console.log(`\nBar structure ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Structure ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`structure ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`structure ${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const act = async (a) => { if (touch) await page.tap(`.notes-panel [data-a="${a}"]`); else await page.click(`.notes-panel [data-a="${a}"]`); await sleep(200); };
  const pickIn = (bar) => EN((bar) => window.__editNotes.select([window.__editNotes.notes.find((n) => n.bar === bar && n.staff === 1 && !n.rest).ref]), bar);
  const menuItems = () => page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  const choose = async (re) => {
    const i = await page.$$eval('.menu button', (e, src) => e.findIndex((x) => new RegExp(src).test(x.textContent.trim())), re.source);
    if (i < 0) return false;
    const sel = `.menu button:nth-of-type(${i + 1})`;
    const h = (await page.$$('.menu button'))[i];
    if (touch) await h.tap(); else await h.click();
    await sleep(250);
    return true;
  };
  const sheetBtn = async (sel) => { const h = await page.$(`.modal ${sel}`); if (touch) await h.tap(); else await h.click(); await sleep(200); };
  const xml = () => EN(() => window.__editNotes.xml);
  const bars = (x) => x.split('<measure').length - 1;
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);

  // 1. pickup (first bar only): 1 beat — the bar is short but not "incomplete"
  await pickIn(0); await act('barmenu');
  check('Bar ▾ on bar 1: Pickup, Key, Time, repeats, endings', (await menuItems()).some((t) => /^Pickup/.test(t)) && (await menuItems()).some((t) => /^Key from bar 1/.test(t)) && (await menuItems()).some((t) => /^Time from bar 1/.test(t)) && (await menuItems()).some((t) => /^Ending 2 over bar 1/.test(t)), (await menuItems()).join('|'));
  await choose(/^Pickup/);
  await sheetBtn('[data-b="1"]'); await idle();
  let x = await xml();
  check('Pickup 1 beat: bar 1 is a short (implicit) bar with its last beat', /<measure[^>]*implicit="yes"/.test(x) && (await EN(() => window.__editNotes.notes.filter((n) => n.bar === 0 && n.staff === 1 && !n.rest).map((n) => n.midi).join())) === '67');
  check('…not shown as incomplete', !(await page.$('.ib-badge')));
  await pickIn(1); await act('barmenu');
  check('Pickup is offered on the first bar only', !(await menuItems()).some((t) => /^Pickup/.test(t)));
  await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelector('.menu')?.remove());
  await act('undo'); await idle();

  // 2. key from bar 2: the circle of fifths
  await pickIn(1); await act('barmenu'); await choose(/^Key from bar 2/);
  check('Key from here: a circle of fifths of 15 keys, C on', (await page.$$eval('.np-fifths button', (e) => e.length)) === 15 && (await page.$eval('.np-fifths button.on', (e) => e.dataset.f)) === '0');
  if (name === 'Mac') await page.screenshot({ path: `${SHOTS}/Structure-key-${name}.png` });
  await sheetBtn('[data-f="2"]'); await idle();
  x = await xml();
  check('D major from bar 2: a key change there, pitches the same', /<measure number="2">[\s\S]*?<fifths>2<\/fifths>/.test(x.split('<measure number="3"')[0]));
  check('…F♯ and C♯ need naturals now: written', (x.split('<measure number="3"')[0].split('<measure number="2"')[1].match(/<accidental>natural<\/accidental>/g) || []).length >= 1);

  // 3. time from bar 3: 3/4 — barred again
  await pickIn(2); await act('barmenu'); await choose(/^Time from bar 3/);
  await sheetBtn('[data-t="3/4"]'); await idle();
  x = await xml();
  check('3/4 from bar 3: bars 3–4 (8 beats) barred again as 3 bars of 3/4, all full', bars(x) === 5 && barsFull(x), `${bars(x)} bars`);
  await act('undo'); await idle(); await act('undo'); await idle();
  check('Undo twice: 4 bars in 4/4 again', bars(await xml()) === 4 && !/<fifths>2/.test(await xml()));

  // 3b. clef over bars 1–2 of the left hand: treble there, bass again at bar 3
  const lhClefs = (x) => [...x.matchAll(/<measure number="(\d+)"[\s\S]*?(?=<measure|<\/part>)/g)].flatMap((m) => [...m[0].matchAll(/<clef number="2">\s*<sign>(\w)/g)].map((c) => `${m[1]}${c[1]}`)).join(' ');
  await EN(() => { const e = window.__editNotes; e.select([0, 1].map((b) => e.notes.find((n) => n.bar === b && n.staff === 2).ref)); });
  await act('barmenu');
  check('Bar ▾ on the left hand, bars 1–2: Clef Treble / Bass, Bass ticked', (await menuItems()).some((t) => /^Clef: Treble \(left hand, bars 1–2\)/.test(t))
    && (await page.$$eval('.menu button[aria-checked="true"]', (e) => e.map((x) => x.textContent.trim()))).some((t) => /^Clef: Bass/.test(t)), (await menuItems()).join('|'));
  await choose(/^Clef: Treble/); await idle();
  x = await xml();
  check('treble clef for bars 1–2 of the left hand, bass back at bar 3', lhClefs(x) === '1G 3F', lhClefs(x));
  check('…pitches the same', (await EN(() => window.__editNotes.notes.filter((n) => n.staff === 2 && !n.rest).length)) > 0);
  await act('undo'); await idle();
  check('Undo: the left hand is in bass clef all through', lhClefs(await xml()) === '1F', lhClefs(await xml()));

  // 4. repeats and endings: start repeat at bar 1, ending 1 over bar 3 (an end repeat comes with it), ending 2 over bar 4
  await pickIn(0); await act('barmenu'); await choose(/^Start repeat at bar 1/); await idle();
  await pickIn(2); await act('barmenu'); await choose(/^Ending 1 over bar 3/); await idle();
  await pickIn(3); await act('barmenu'); await choose(/^Ending 2 over bar 4/); await idle();
  x = await xml();
  check('repeat sign, ending 1 with its end repeat, ending 2', /<repeat direction="forward"/.test(x) && /<repeat direction="backward"/.test(x) && /<ending number="1" type="start"/.test(x) && /<ending number="2" type="start"/.test(x));
  await pickIn(2); await act('barmenu');
  check('Bar ▾ shows them ticked', (await page.$$eval('.menu button[aria-checked="true"]', (e) => e.map((x) => x.textContent.trim()))).some((t) => /^Ending 1/.test(t)));
  await page.evaluate(() => document.querySelector('.menu')?.remove());
  if (name === 'Mac') await page.screenshot({ path: `${SHOTS}/Structure-repeats-${name}.png` });
  check('the score draws the volta brackets', (await page.$$eval('#osmd svg text', (e) => e.map((t) => t.textContent))).some((t) => /^1\.?$/.test(t.trim())));
  const segs = await EN(() => window.__score.player.segments);
  check('the player plays bars 1 2 3 · 1 2 · 4', JSON.stringify(segs) === JSON.stringify([[0, 12], [0, 8], [12, 16]]), JSON.stringify(segs));
  // play it fast and listen: the notes come in repeat order
  await EN(() => window.__editNotes.select([])); await sleep(200);
  await EN(() => { const p = window.__score.player; p.stop?.(); p.rate = 6; });
  await act('playhere'); // nothing picked → from where the player is (the start)
  for (let i = 0; i < 40 && !(await EN(() => window.__score.player.playing)); i++) await sleep(100); // the sound starts
  for (let i = 0; i < 80 && (await EN(() => window.__score.player.playing)); i++) await sleep(250);
  const heard = await EN(() => window.__score.player.heard.map(([q]) => q));
  const seq = []; for (const q of heard) { const bar = Math.floor(q / 4) + 1; if (seq.at(-1) !== bar) seq.push(bar); }
  check('played in order: bars 1 2 3 1 2 4', seq.join(' ') === '1 2 3 1 2 4', seq.join(' '));
  check('…it ended, the player went back to the start', !(await EN(() => window.__score.player.playing)) && (await EN(() => window.__score.player.played.join())) === '0,1,2');
  await EN(() => { window.__score.player.rate = 1; });

  // 5. save: the score (not editing) plays the repeats too
  if (!touch) {
    await act('save'); await sleep(300);
    await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
    check('saved: the player follows the repeats', JSON.stringify(await EN(() => window.__score.player.segments)) === JSON.stringify([[0, 12], [0, 8], [12, 16]]));
  } else {
    await EN(() => { window.__editNotes.close(); }); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close')?.click()); await sleep(800);
    check('closed without saving: no repeats', !(await EN(() => window.__score.player.segments)));
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}
if (process.env.ONLY === 'structure') { await structure('Mac', MAC); await structure('iPad', IPAD); await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
// ---- chord names: tap above the top staff (an empty beat or a chord name) → type it (the chord grammar checks it);
// K on a picked note; Realize to left hand (block / root–fifth / broken) over a range; the chord list keeps working ----
async function chordNames(name, vp) {
  console.log(`\nChord names ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Chords ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, musicxmlText: scoreXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`chords ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|400|favicon/.test(m.text()) && errs.push(`chords ${name}: ${m.text()}`));
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(250); };
  const act = async (a) => { if (touch) await page.tap(`.notes-panel [data-a="${a}"]`); else await page.click(`.notes-panel [data-a="${a}"]`); await sleep(200); };
  const btn = async (sel) => { const h = await page.$(sel); if (touch) await h.tap(); else await h.click(); await sleep(200); };
  const chords = () => EN(() => window.__editNotes.chords.map((c) => `${c.bar}@${c.on}:${c.name}`).join(' '));
  const lh = (bar) => EN((bar) => window.__editNotes.notes.filter((n) => n.bar === bar && n.staff === 2 && !n.rest).map((n) => n.midi + '@' + n.on + ':' + n.dur).join(' '), bar);
  // a point above the top staff over the note of bar `bar` at onset `on`
  const above = (bar, on) => EN(([bar, on]) => {
    const n = window.__editNotes.notes.find((n) => n.bar === bar && n.staff === 1 && n.on === on && !n.rest);
    const g = document.querySelector(`#paper g[data-ref="${n.ref}"]`).getBoundingClientRect();
    const x = g.left + g.width / 2;
    let y = g.top; // up to the chord-name strip over the top staff, then a little into it
    while (y > 0 && !window.__editNotes.chordAt(x, y)) y -= 2;
    return { x, y: y - 14 };
  }, [bar, on]);
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);

  // 1. tap above bar 1 beat 1: the chord sheet; a wrong name is refused, then C
  let p = await above(0, 0);
  await tapXY(p.x, p.y);
  check('tap above the top staff: the chord name sheet for bar 1, beat 1', /bar 1, beat 1/.test(await page.$eval('.modal h2', (e) => e.textContent).catch(() => '')), await page.$eval('.modal h2', (e) => e.textContent).catch(() => 'no sheet'));
  await page.type('#np-chord', 'Hm7'); await sleep(150);
  check('…“Hm7” is not a chord name: Use is off', (await page.$eval('.modal [data-ok]', (e) => e.disabled)) && /not a chord name/.test(await page.$eval('#np-chord-err', (e) => e.textContent)));
  await page.$eval('#np-chord', (e) => { e.value = ''; }); await page.type('#np-chord', 'C'); await sleep(100);
  await btn('.modal [data-ok]'); await idle();
  check('C on bar 1, beat 1', (await chords()) === '0@0:C', await chords());
  await sleep(400);
  check('…drawn above the staff', (await page.$$eval('#osmd svg text', (e) => e.map((t) => t.textContent.trim()))).includes('C'));
  if (name === 'Mac') await page.screenshot({ path: `${SHOTS}/Chords-${name}.png` });
  // 2. G7 on beat 3 (Mac: K on the picked note; iPad: tap above it)
  if (!touch) {
    await EN(() => window.__editNotes.select([window.__editNotes.notes.find((n) => n.bar === 0 && n.staff === 1 && n.on === 2).ref])); await sleep(150);
    await page.keyboard.press('k'); await sleep(300);
  } else { p = await above(0, 2); await tapXY(p.x, p.y); }
  check(`${touch ? 'tap above beat 3' : 'K'}: the sheet for beat 3`, /bar 1, beat 3/.test(await page.$eval('.modal h2', (e) => e.textContent).catch(() => '')));
  check('…the chords already used are offered', (await page.$$eval('.np-used button', (e) => e.map((x) => x.textContent))).includes('C'));
  await page.type('#np-chord', 'G7'); await page.keyboard.press('Enter'); await idle();
  // 3. F/A at bar 2, then change it to Dm7, and take a chord away
  p = await above(1, 0); await tapXY(p.x, p.y);
  await page.type('#np-chord', 'F/A'); await btn('.modal [data-ok]'); await idle();
  check('C, G7, F/A', (await chords()) === '0@0:C 0@2:G7 1@0:F/A', await chords());
  p = await above(1, 0); await tapXY(p.x, p.y);
  check('tapping a chord name: its sheet, filled in, with Take away', (await page.$eval('#np-chord', (e) => e.value)) === 'F/A' && !!(await page.$('.modal [data-del]')));
  await page.$eval('#np-chord', (e) => { e.value = ''; }); await page.type('#np-chord', 'Dm7'); await btn('.modal [data-ok]'); await idle();
  check('changed to Dm7', (await chords()) === '0@0:C 0@2:G7 1@0:Dm7', await chords());
  p = await above(0, 2); await tapXY(p.x, p.y); await btn('.modal [data-del]'); await idle();
  check('Take away: G7 gone', (await chords()) === '0@0:C 1@0:Dm7', await chords());
  await act('undo'); await idle();
  check('Undo: back', (await chords()) === '0@0:C 0@2:G7 1@0:Dm7');

  // 4. Realize to left hand over bars 1–2 (a range): block chords, then broken chords (one undo step each)
  const lh3 = await lh(2);
  await EN(() => window.__editNotes.setRange({ a: 0, b: 8, s0: 1, s1: 2 })); await sleep(200);
  await act('barmenu');
  const items = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check('Bar ▾ has Realize chords to left hand', items.includes('Realize chords to left hand…'), items.join('|'));
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Realize chords to left hand…').click()); await sleep(300);
  check('…over bars 1–2, three patterns', /bars 1–2/.test(await page.$eval('.modal p', (e) => e.textContent)) && (await page.$$eval('.np-patterns button', (e) => e.length)) === 3);
  const s0 = await EN(() => window.__editNotes.step);
  await btn('.np-patterns [data-p="block"]'); await idle();
  check('block: C3 E3 G3 for C, G2 B2 D3 F3 for G7, D3 F3 A3 C4 for Dm7', (await lh(0)) === '48@0:2 52@0:2 55@0:2 43@2:2 47@2:2 50@2:2 53@2:2' && (await lh(1)).split(' ').map((x) => +x.split('@')[0]).sort().join() === '50,53,57,60', `${await lh(0)} | ${await lh(1)}`);
  check('…bar 3 untouched, one undo step, bars full', (await lh(2)) === lh3 && (await EN(() => window.__editNotes.step)) === s0 + 1 && barsFull(await EN(() => window.__editNotes.xml)));
  check('…the chord names stay', (await chords()) === '0@0:C 0@2:G7 1@0:Dm7');
  await act('undo'); await idle();
  await EN(() => window.__editNotes.setRange({ a: 0, b: 8, s0: 1, s1: 2 })); await sleep(200);
  await act('barmenu');
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Realize chords to left hand…').click()); await sleep(300);
  await btn('.np-patterns [data-p="broken"]'); await idle();
  check('broken: C3 G3 E4 G3 in eighths', (await lh(0)).startsWith('48@0:0.5 55@0.5:0.5 64@1:0.5 55@1.5:0.5'), await lh(0));
  if (name === 'Mac') await page.screenshot({ path: `${SHOTS}/Realize-${name}.png` });

  // 5. save: the chord list (ukulele panel) has them
  if (!touch) {
    await act('save'); await sleep(300);
    await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
    const list = await api(`/items/${sc.id}/score-chords`);
    check('saved: the chord list reads C, G7, Dm7', JSON.stringify(list.chords) === '["C","G7","Dm7"]', JSON.stringify(list));
    check('…and the score shows them', (await page.$$eval('#osmd svg text', (e) => e.map((t) => t.textContent.trim()))).includes('G7'));
  } else {
    await EN(() => { window.__editNotes.close(); }); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close')?.click()); await sleep(300);
  }
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}
if (process.env.ONLY === 'chords') { await chordNames('Mac', MAC); await chordNames('iPad', IPAD); await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
if (process.env.ONLY === 'fits') { await editBarFits(); await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
if (process.env.ONLY === 'bar') { await barTools('Mac', MAC); await barTools('iPad', IPAD); await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
// ---- rests: pick one in either hand (whole-bar rests too), change its length, Undo; Fill next rest ----
// bar 1: right hand C5 · quarter rest · D5 · E5, left hand a whole-bar rest; bar 2: right hand C5 · quarter rest ·
// half rest, left hand C3 whole; bar 3: both hands quarter · quarter rest · quarter · quarter; bar 4: whole notes;
// bar 5: right hand a whole-bar rest, left hand G2 whole.
const restXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + '<measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
  + N(72, 2, 1, 'quarter') + N(0, 2, 1, 'quarter') + N(74, 2, 1, 'quarter') + '<note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff><lyric number="1"><text>la</text></lyric></note>'
  + '<backup><duration>8</duration></backup><note><rest measure="yes"/><duration>8</duration><voice>5</voice><staff>2</staff></note></measure>'
  + '<measure number="2">' + N(72, 2, 1, 'quarter') + N(0, 2, 1, 'quarter') + N(0, 4, 1, 'half') + '<backup><duration>8</duration></backup>' + N(48, 8, 2, 'whole') + '</measure>'
  + '<measure number="3">' + N(72, 2, 1, 'quarter') + N(0, 2, 1, 'quarter') + N(74, 2, 1, 'quarter') + N(72, 2, 1, 'quarter') + '<backup><duration>8</duration></backup>'
  + N(48, 2, 2, 'quarter') + N(0, 2, 2, 'quarter') + N(50, 2, 2, 'quarter') + N(48, 2, 2, 'quarter') + '</measure>'
  + '<measure number="4">' + N(74, 8, 1, 'whole') + '<backup><duration>8</duration></backup>' + N(50, 8, 2, 'whole') + '</measure>'
  + '<measure number="5"><note><rest measure="yes"/><duration>8</duration><voice>1</voice><staff>1</staff></note><backup><duration>8</duration></backup>' + N(43, 8, 2, 'whole') + '</measure></part></score-partwise>';

async function rests(name, vp) {
  console.log(`\nRests — ${name}`);
  const touch = !!vp.hasTouch;
  const title = `Rests ${name} ${stamp}`;
  P[76] = ['E', 5];
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: restXml(title) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`Rests ${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|400|favicon/.test(m.text()) && errs.push(`Rests ${name}: ${m.text()}`));
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  // the panel draws itself again on edits / player events: a button found a moment ago may be gone — try again
  const tap = async (sel) => { for (let k = 0; ; k++) { try { if (touch) await page.tap(sel); else await page.click(sel); break; } catch (e) { if (k > 4 || !/detached|not clickable|No element/.test(e.message)) throw e; await sleep(200); } } await sleep(150); };
  const act = (a) => tap(`.notes-panel [data-a="${a}"]`);
  const EN = (f) => page.evaluate(f);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy))) break; } await sleep(700); };
  const head = (pred) => page.evaluate((src) => {
    const f = new Function('n', `return (${src})(n)`);
    const n = window.__editNotes.notes.find(f);
    const g = n && document.querySelector(`#paper g[data-ref="${n.ref}"]`);
    if (!g) return null;
    g.scrollIntoView({ block: 'center' });
    const r = g.getBoundingClientRect();
    return { ref: n.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, pred.toString());
  const pick = async (pred) => { await act('none'); const h = await head(pred); if (!h) return null; await tapXY(h.x, h.y); return h.ref; };
  const sel = () => EN(() => window.__editNotes.sel);
  const notes = () => EN(() => window.__editNotes.notes);
  const voice = async (bar, staff) => (await notes()).filter((n) => n.bar === bar && n.staff === staff).sort((a, z) => a.on - z.on).map((n) => `${n.rest ? 'R' : n.midi}@${n.on}:${n.dur}`).join(' ');
  const toastText = () => EN(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : ''; });
  const len = (q) => tap(`.notes-panel [data-len="${q}"]`);

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(800);
  const restsTagged = await EN(() => window.__editNotes.notes.filter((n) => n.rest).every((n) => document.querySelector(`#paper g[data-ref="${n.ref}"].nh-rest`)));
  check('every rest (both hands, the whole-bar rest too) can be picked', restsTagged);

  // 1. the left hand's whole-bar rest → ¼: the quarter stays (not joined back), the rest of the bar rests; Undo
  const lr = await pick((n) => n.bar === 0 && n.staff === 2 && n.rest);
  check('tap picks the left-hand whole-bar rest', JSON.stringify(await sel()) === `[${lr}]`, JSON.stringify(await sel()));
  check('the picked rest is coloured', await page.$eval(`#paper g[data-ref="${lr}"]`, (g) => g.classList.contains('nh-on')));
  check('rest picked: length buttons on, “+ Note here” shown, no help text', await page.$eval('.notes-panel [data-len="1"]', (e) => !e.disabled)
    && (await page.$eval('.notes-panel [data-a="add"]', (e) => e.textContent.trim())) === '+ Note here' && !(await page.$('.np-help')));
  if (name === 'iPhone') await page.screenshot({ path: `${SHOTS}/Rests-${name}-picked.png` });
  await len(1); await idle();
  check('left-hand rest → a quarter rest, then quarter + half', (await voice(0, 2)) === 'R@0:1 R@1:1 R@2:2', await voice(0, 2));
  { const s = await sel(), m = (await notes()).find((n) => n.ref === s[0]); check('the shortened rest stays picked', s.length === 1 && m?.rest && m.staff === 2 && m.on === 0 && m.dur === 1, JSON.stringify(m)); }
  check('offer: pull the next notes earlier', /Pull the next notes earlier/.test(await toastText()), await toastText());
  check('bars still full', barsFull(await EN(() => window.__editNotes.xml)));
  await act('undo'); await idle();
  check('Undo: the whole-bar rest is back', (await voice(0, 2)) === 'R@0:4', await voice(0, 2));

  // 2. the right hand's quarter rest (beat 2) → ½: takes the D5 (gone; said), split by the beat; Undo brings it back
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  { const s = await sel(), m = (await notes()).find((n) => n.ref === s[0]); check('tap picks the right-hand rest', s.length === 1 && m?.rest && m.staff === 1 && m.on === 1, JSON.stringify(m)); }
  await len(2); await idle();
  const t2 = await toastText();
  check('right-hand rest longer: the D5 is gone, E5 and its lyric stay', (await voice(0, 1)) === '72@0:1 R@1:1 R@2:1 76@3:1' && /<text>la<\/text>/.test(await EN(() => window.__editNotes.xml)), await voice(0, 1));
  check('the toast names the note taken and the split', /took time from D5 on beat 3 \(gone\)/.test(t2) && /half rest on beat 2/.test(t2) && /Undo/.test(t2), t2);
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/Rests-${name}-longer.png` });
  await act('undo'); await idle();
  check('Undo: the D5 is back', (await voice(0, 1)) === '72@0:1 R@1:1 74@2:1 76@3:1', await voice(0, 1));

  // 3. too long for the bar: refused, nothing changes
  const st = await EN(() => window.__editNotes.step);
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  await len(4); await idle();
  check('a whole rest from beat 2: refused with a clear message', /Too long for the bar/.test(await toastText()) && (await EN(() => window.__editNotes.step)) === st, await toastText());

  // 4. shorter + "Pull the next notes earlier": the D5 / E5 come an 8th earlier (one undo step)
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  await len(0.5); await idle();
  const s4 = await EN(() => window.__editNotes.step);
  await page.evaluate(() => document.querySelector('#toast button')?.click()); await idle();
  const v4 = await voice(0, 1);
  check('pull: D5 on the and of 2, an 8th rest at the end', v4.startsWith('72@0:1 R@1:0.5 74@1.5:0.5') && v4.endsWith('R@3.5:0.5') && (await EN(() => window.__editNotes.step)) === s4, v4);
  await act('undo'); await idle();
  check('Undo after pull: back as it was (one step)', (await voice(0, 1)) === '72@0:1 R@1:1 74@2:1 76@3:1', await voice(0, 1));

  // 5. Fill next rest (Mac: L) on bar 2's C5: one rest per press, the C5 stays picked; then nothing more to fill
  const c5 = await pick((n) => n.bar === 1 && n.staff === 1 && n.midi === 72);
  check('Fill next rest is on for a note with a rest after it', await page.$eval('.notes-panel [data-a="fill"]', (e) => !e.disabled));
  const fill = async () => { if (touch) await act('fill'); else { await page.keyboard.press('l'); await sleep(150); } await idle(); };
  await fill();
  check('fill 1: C5 a half note, the half rest after it stays', (await voice(1, 1)) === '72@0:2 R@2:2' && (await sel()).length === 1, await voice(1, 1));
  check('the play start is a bar before the edit (bar 1)', (await EN(() => window.__editNotes.cueBar)) === 1, String(await EN(() => window.__editNotes.cueBar)));
  await fill();
  check('fill 2: C5 a whole note', (await voice(1, 1)) === '72@0:4', await voice(1, 1));
  check('then Fill next rest is off (last in its bar)', await page.$eval('.notes-panel [data-a="fill"]', (e) => e.disabled));
  await act('undo'); await idle(); await act('undo'); await idle();
  check('Undo twice: C5 · rests again', (await voice(1, 1)) === '72@0:1 R@1:1 R@2:2', await voice(1, 1));
  // a note right before a note: Mac L says so
  if (!touch) {
    await pick((n) => n.bar === 0 && n.staff === 1 && n.midi === 74);
    await page.keyboard.press('l'); await sleep(300);
    check('no rest after the note: says so', /No rest after this note/.test(await toastText()), await toastText());
  }
  // 6. + Note here on the left-hand rest → a note
  await pick((n) => n.bar === 0 && n.staff === 2 && n.rest);
  await act('add'); await idle();
  check('+ Note here turns the rest into a note', (await notes()).some((n) => n.bar === 0 && n.staff === 2 && !n.rest));
  void c5;

  // 7. Remove rest (Delete): bar 1's right-hand rest — the notes after it come earlier, the bar is left short and shown
  const badge = (bar) => page.$eval(`.ib-badge[data-bar="${bar}"]`, (e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).catch(() => null);
  const tapBadge = async (bar) => { const h = await badge(bar); if (h) await tapXY(h.x, h.y); await sleep(300); };
  const sheetBtn = async (text) => { await page.evaluate((t) => [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === t)?.click(), text); await sleep(200); };
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  check('rest picked: the Delete button says Remove rest (its label: an icon button)', (await page.$eval('.notes-panel [data-a="del"]', (e) => e.getAttribute('aria-label'))) === 'Remove rest');
  if (touch) await act('del'); else { await page.keyboard.press('Backspace'); await sleep(150); }
  await idle();
  check('Remove rest: D5 / E5 come a beat earlier, no rest added', (await voice(0, 1)) === '72@0:1 74@1:1 76@2:1', await voice(0, 1));
  const bd = await badge(1);
  check('the short bar is tinted with a badge “3 of 4 beats”', bd?.text === '3 of 4 beats' && !!(await page.$('.ib-mark[data-bar="1"]')), JSON.stringify(bd));
  check('offer: Previous note fills it instead', /Previous note fills it instead/.test(await toastText()), await toastText());
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/Rests-${name}-short-bar.png` });
  // playing a short bar: no crash
  await act('playhere'); await sleep(1200);
  const playing = await EN(() => window.__score.player.playing && window.__score.player.now() > 0);
  await act('playhere'); await sleep(200);
  check('a short bar plays as it is', playing);
  const s7 = await EN(() => window.__editNotes.step);
  await page.evaluate(() => document.querySelector('#toast button')?.click()); await idle();
  check('Previous note fills it: C5 a half note, the bar full, the badge gone, one step', (await voice(0, 1)) === '72@0:2 74@2:1 76@3:1' && !(await badge(1)) && (await EN(() => window.__editNotes.step)) === s7, await voice(0, 1));
  await act('undo'); await idle();
  check('Undo: the rest is back', (await voice(0, 1)) === '72@0:1 R@1:1 74@2:1 76@3:1', await voice(0, 1));

  // 8. bar 3: both hands' rests removed → 3 beats; the badge → Fill with rest; Undo; → Change time for this bar
  await EN(() => window.__editNotes.select(window.__editNotes.notes.filter((n) => n.bar === 2 && n.rest).map((n) => n.ref)));
  await act('del'); await idle();
  check('both hands: bar 3 is 3 of 4 beats', (await badge(3))?.text === '3 of 4 beats', JSON.stringify(await badge(3)));
  await tapBadge(3);
  check('tapping the badge offers the fixes', !!(await page.$('.ib-fix')) && (await page.$$eval('.ib-fix button', (e) => e.map((x) => x.textContent.trim()).join('|'))) === 'Keep editing|Change time for this bar|Fill with rest');
  await sheetBtn('Keep editing');
  check('Keep editing: nothing changes', !(await page.$('.ib-fix')) && !!(await badge(3)));
  await tapBadge(3); await sheetBtn('Fill with rest'); await idle();
  check('Fill with rest: a rest at the end of both hands, the badge gone', (await voice(2, 1)).endsWith('R@3:1') && (await voice(2, 2)).endsWith('R@3:1') && !(await badge(3)), await voice(2, 1));
  await act('undo'); await idle();
  check('Undo: the bar is short again', !!(await badge(3)));
  await tapBadge(3); await sheetBtn('Change time for this bar'); await idle();
  const xs = await EN(() => window.__editNotes.xml);
  const tms = xs.split('<measure').slice(1).map((m) => (m.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)/) || []).slice(1).join('/'));
  check('Change time: bar 3 in 3/4, bar 4 back in 4/4, no badge', tms[2] === '3/4' && tms[3] === '4/4' && !(await badge(3)), tms.join(','));
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/Rests-${name}-bar-time.png` });

  // 9. a rest that ends its bar (bar 2's half rest): pull notes from the next bar
  await pick((n) => n.bar === 1 && n.staff === 1 && n.rest && n.on === 2);
  await act('del'); await sleep(300);
  check('a rest at the end of its bar: two ways offered', !!(await page.$('.np-rmrest')));
  await sheetBtn('Pull notes from the next bar'); await idle();
  check('pulled: bar 2 goes on with bar 3’s notes', (await voice(1, 1)) === '72@0:1 R@1:1 72@2:1 74@3:1', await voice(1, 1));
  await act('undo'); await idle();

  // 10. a whole-bar rest (bar 5): Remove rest → Delete this bar
  const nBars = async () => (await EN(() => window.__editNotes.xml)).split('<measure').length - 1;
  const before = await nBars();
  await pick((n) => n.bar === 4 && n.staff === 1 && n.rest);
  await act('del'); await sleep(300);
  check('a whole-bar rest offers Delete this bar', /Delete bar 5\?/.test(await page.$eval('.modal h2', (e) => e.textContent).catch(() => '')));
  await page.evaluate(() => document.querySelector('.modal [data-ok]').click()); await idle();
  check('the bar is gone', (await nBars()) === before - 1, `${before} → ${await nBars()}`);
  await act('undo'); await idle();
  check('Undo: the bar is back', (await nBars()) === before);

  // 11. save with a short bar: allowed, says so; after a reload the badge is still there
  await pick((n) => n.bar === 0 && n.staff === 1 && n.rest);
  await act('del'); await idle();
  await act('save'); await sleep(300);
  await page.evaluate(() => document.querySelector('.np-save [data-mode="this"]').click()); await sleep(2500);
  const noteText = () => EN(() => document.querySelector('.save-note')?.textContent || '');
  check('saved with a warning: "Saved ✓ hh:mm" · 1 bar not complete', /Saved ✓ \d\d:\d\d/.test(await noteText()) && /1 bar not complete/.test(await noteText()), await noteText());
  await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(1000);
  check('after a reload the short bar still shows', (await badge(1))?.text === '3 of 4 beats');
  // not editing: the badge fixes it at once (saved; Activities can undo)
  await tapBadge(1); await sheetBtn('Fill with rest'); await sleep(2500);
  check('not editing: Fill with rest saves, the badge goes', !(await badge(1)) && /R@|rest/.test(await xmlOf(sc.id)) && !(await page.$('.ib-badge')));
  await send('POST', '/items/trash', { ids: [sc.id] }).catch(() => {});
  await page.close();
}

await rests('Mac', MAC);
await rests('iPad', IPAD);
await rests('iPhone', PHONE);
if (process.env.ONLY === 'rests') { await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
await cueAndArcs('Mac', MAC);
await cueAndArcs('iPad', IPAD);
await cueAndArcs('iPhone', PHONE);
if (process.env.ONLY === 'cue') { await b.close(); console.log(`\n${pass} passed, ${fail} failed`); if (errs.length) errs.forEach((e) => console.log('  ', e)); process.exit(fail || errs.length ? 1 : 0); }
await run('Mac', MAC, 'this');
await run('iPad', IPAD, 'new');
await run('iPhone', PHONE, 'close');
await leftHand('Mac', MAC);
await leftHand('iPad', IPAD);
await barTools('Mac', MAC);
await barTools('iPad', IPAD);
await rangeTools('Mac', MAC);
await rangeTools('iPad', IPAD);
await structure('Mac', MAC);
await structure('iPad', IPAD);
await chordNames('Mac', MAC);
await chordNames('iPad', IPAD);
await editBarFits();
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
