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
    check('Stop again: back to the beginning, the line goes', s.q === 0 && s.cue === 0 && !(await lineOn()), JSON.stringify(s));
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
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift'); await sleep(300);
    check('Shift ← turns back a page', (await S()).page === 1);
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
  check('rest picked: length buttons on, “+ Note here” shown, a hint', await page.$eval('.notes-panel [data-len="1"]', (e) => !e.disabled)
    && (await page.$eval('.notes-panel [data-a="add"]', (e) => e.textContent.trim())) === '+ Note here' && !!(await page.$('.np-rest-help')));
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

  // 5. Fill next rest (Mac: E) on bar 2's C5: one rest per press, the C5 stays picked; then nothing more to fill
  const c5 = await pick((n) => n.bar === 1 && n.staff === 1 && n.midi === 72);
  check('Fill next rest is on for a note with a rest after it', await page.$eval('.notes-panel [data-a="fill"]', (e) => !e.disabled));
  const fill = async () => { if (touch) await act('fill'); else { await page.keyboard.press('e'); await sleep(150); } await idle(); };
  await fill();
  check('fill 1: C5 a half note, the half rest after it stays', (await voice(1, 1)) === '72@0:2 R@2:2' && (await sel()).length === 1, await voice(1, 1));
  check('the play start is a bar before the edit (bar 1)', (await EN(() => window.__editNotes.cueBar)) === 1, String(await EN(() => window.__editNotes.cueBar)));
  await fill();
  check('fill 2: C5 a whole note', (await voice(1, 1)) === '72@0:4', await voice(1, 1));
  check('then Fill next rest is off (last in its bar)', await page.$eval('.notes-panel [data-a="fill"]', (e) => e.disabled));
  await act('undo'); await idle(); await act('undo'); await idle();
  check('Undo twice: C5 · rests again', (await voice(1, 1)) === '72@0:1 R@1:1 R@2:2', await voice(1, 1));
  // a note right before a note: Mac E says so
  if (!touch) {
    await pick((n) => n.bar === 0 && n.staff === 1 && n.midi === 74);
    await page.keyboard.press('e'); await sleep(300);
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
  check('rest picked: the Delete button says Remove rest', (await page.$eval('.notes-panel [data-a="del"]', (e) => e.textContent.trim())) === 'Remove rest');
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
  check('saved with a warning: 1 bar not complete', /1 bar not complete/.test(await toastText()), await toastText());
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
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
