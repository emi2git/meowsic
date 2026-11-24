// Edit notes (score ⋯ → "Edit notes…") and the score player's Stop + Play / Pause, against a test server (BASE,
// default :5371, a scratchpad copy of the data — never the real library). Per device (Mac, iPad Pro 13", iPhone Air):
// a made-up piano score (Ode to Joy, public domain) → the player has Stop before Play / Pause and no position bar;
// Play moves the orange line, Stop puts it back at the start → open Edit notes → pick a note (tap), a range
// (Shift-click, Mac), a box (drag), a whole bar → move them to the other hand: the score draws again, both staves
// keep full bars, chords stay together → undo / redo → Mac: save into this score (Activities undo puts it back),
// iPad: save as a new version (tagged "Hands moved"; undone after), iPhone: close without saving (unchanged).
// Screenshots go to $SHOTS.
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

  // ---- Edit notes… in the score ⋯ ----
  await tap('#it-more'); await sleep(200);
 
  const entries = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check('score ⋯ has Edit notes…', entries.includes('Edit notes…'), entries.join('|'));
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Edit notes…').click());
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
  await act('bar');
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
    check('½: a half note, written over the next beat, bar still full', nn.some((n) => n.bar === 2 && n.on === 1 && n.dur === 2 && n.midi === 49) && !nn.some((n) => n.bar === 2 && n.staff === 1 && n.on === 2 && !n.rest) && barsFull(await EN(() => window.__editNotes.xml)));
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

await run('Mac', MAC, 'this');
await run('iPad', IPAD, 'new');
await run('iPhone', PHONE, 'close');
await leftHand('Mac', MAC);
await leftHand('iPad', IPAD);
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
