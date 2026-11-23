// Fit lyrics by hand (score ⋯ → "Fit lyrics…") against a test server (BASE, default :5190). Never the real library.
// Per device (Mac, iPad Pro 13", iPhone Air): a made-up piano score of Twinkle Twinkle (public domain) → open the
// editor → type the words → Fit to notes → edit / shift / hold / skip / merge / split / drag / play / undo / redo →
// Preview → Save (Mac + iPhone: into this score; iPad: as a new score) → reload shows the words → Activities Undo
// puts the score back. Screenshots go to $SHOTS.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/fitlyrics';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

// Twinkle Twinkle, first line, on top of a piano's upper staff (a third below it) with a bass note per bar
const MEL = [[[60, 1], [60, 1], [67, 1], [67, 1]], [[69, 1], [69, 1], [67, 2]], [[65, 1], [65, 1], [64, 1], [64, 1]], [[62, 1], [62, 1], [60, 2]]];
const NAME = { 48: ['C', 3], 55: ['G', 3], 57: ['A', 3], 60: ['C', 4], 61: ['C', 4, 1], 62: ['D', 4], 63: ['E', 4, -1], 64: ['E', 4], 65: ['F', 4], 67: ['G', 4], 69: ['A', 4], 56: ['A', 3, -1], 58: ['B', 3, -1], 53: ['F', 3] };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (m, q, staff, chord = false) => { const [s, o, a] = NAME[m];
  return `<note>${chord ? '<chord/>' : ''}<pitch><step>${s}</step>${a ? `<alter>${a}</alter>` : ''}<octave>${o}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`; };
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + MEL.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type><sound tempo="100"/></direction>'}`
    + bar.map(([m, q]) => note(m, q, 1) + note(m - 4, q, 1, true)).join('') + '<backup><duration>8</duration></backup>' + note(48, 4, 2) + '</measure>').join('') + '</part></score-partwise>';
const WORDS = 'Twinkle twinkle little star\nhow I wonder what you are';

const lyricsOf = (xml) => [...xml.matchAll(/<lyric number="(\d+)">\s*<syllabic>(\w+)<\/syllabic>\s*<text>([^<]*)<\/text>(\s*<extend\s*\/>)?/g)].map((m) => ({ v: m[1], syl: m[2], text: m[3], ext: !!m[4] }));

async function run(name, vp, saveMode) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Twinkle Twinkle ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Traditional', musicxmlText: scoreXml(title), tags: ['Kids'] });
  const xml0 = await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text()); // as stored (server adds the Meowsic credit)
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`)); page.on('console', (m) => m.type() === 'error' && !/404|409/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(120); };
  const act = (a) => tap(`.fitly [data-a="${a}"]`);
  const toks = () => page.evaluate(() => window.__fitLyrics.tokens.map((t) => (t.t === 's' ? t.text + (t.syl === 'begin' || t.syl === 'middle' ? '-' : '') : t.t === 'h' ? '_' : '.')).join(' '));
  const pick = async (k) => { await tap(`.fitly .fl-n[data-k="${k}"] .fl-name`); };
  const leftCount = () => page.$$eval('.fitly .fl-chip.left', (e) => e.length);
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await tap('#it-more'); await sleep(150);
  const entries = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check('score ⋯ has Fit lyrics…', entries.includes('Fit lyrics…'), entries.join('|'));
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Fit lyrics…').click());
  await page.waitForSelector('.fitly #fl-text', { timeout: 8000 });
  check('a score with no words opens on the words box', !!(await page.$('.fitly .fl-words')));
  const noScroll = () => page.evaluate(() => ({ doc: document.scrollingElement.scrollHeight <= innerHeight + 1, top: document.scrollingElement.scrollTop, panel: document.querySelector('.fitly').getBoundingClientRect().bottom <= innerHeight + 1 }));
  await page.$eval('#fl-text', (e, w) => { e.value = w; e.dispatchEvent(new Event('input', { bubbles: true })); }, WORDS);
  await act('fit'); await sleep(250);
  check('auto fit: 14 syllables on the 14 notes', (await toks()) === 'Twin- kle twin- kle lit- tle star how I won- der what you are', await toks());
  check('nothing left over', (await leftCount()) === 0);
  const nNotes = await page.$$eval('.fitly .fl-n', (e) => e.length);
  check('the strip shows the 14 melody notes in 4 bars', nNotes === 14 && (await page.$$eval('.fitly .fl-bar', (e) => e.length)) === 4, nNotes);
  check('notes have names and length pictures', (await page.$$eval('.fitly .fl-n', (e) => e.map((x) => x.querySelector('.fl-name').textContent).join(' '))) === 'C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4' && (await page.$$('.fitly .fl-n .fl-pic')).length === 14);
  const sizes = await page.$$eval('.fitly .fl-chip, .fitly .fl-acts button', (e) => e.map((x) => x.getBoundingClientRect().height));
  check('touch targets are big', Math.min(...sizes) >= (touch ? 46 : 40), Math.min(...sizes));
  const ns = await noScroll();
  check('no page scrolling; the panel is on screen', ns.doc && ns.top === 0 && ns.panel, JSON.stringify(ns));

  // edit: tap a chip, tap it again → its words
  await tap('.fitly .fl-n[data-k="2"] .fl-chip'); await sleep(80);
  await tap('.fitly .fl-n[data-k="2"] .fl-chip'); await page.waitForSelector('#fl-edit');
  await page.$eval('#fl-edit', (e) => { e.value = 'Twin-'; }); await page.keyboard.press('Enter'); await sleep(200);
  check('edit a syllable', (await toks()).startsWith('Twin- kle Twin- kle'), await toks());
  // shift right / left
  await pick(4); await act('right'); await sleep(100);
  check('shift ▶: the rest moves one note later, the last one is left over (red)', (await toks()).startsWith('Twin- kle Twin- kle . lit- tle') && (await leftCount()) === 1, await toks());
  await pick(5); await act('left'); await sleep(100);
  check('◀ shift: back', (await toks()) === 'Twin- kle Twin- kle lit- tle star how I won- der what you are' && (await leftCount()) === 0, await toks());
  // hold: "tle" goes on over the next note, star moves on
  await pick(6); await act('hold'); await sleep(100);
  check('hold: a melisma, the rest moves on', (await toks()).startsWith('Twin- kle Twin- kle lit- tle _ star how') && (await leftCount()) === 1, await toks());
  // skip, then undo it
  await pick(0); await act('skip'); await sleep(100);
  check('skip: no syllable on this note', (await toks()).startsWith('. Twin- kle'), await toks());
  await act('undo'); await sleep(100);
  check('undo', (await toks()).startsWith('Twin- kle Twin- kle lit- tle _ star'), await toks());
  await act('redo'); await sleep(100);
  check('redo', (await toks()).startsWith('. Twin-'), await toks());
  await act('undo'); await sleep(100);
  // merge / split
  await pick(0); await act('merge'); await sleep(100);
  check('merge two syllables', (await toks()).startsWith('Twinkle Twin- kle'), await toks());
  await act('split'); await sleep(100);
  check('split it again', (await toks()).startsWith('Twin- kle Twin- kle'), await toks());
  // insert / delete
  await pick(7); await act('insert'); await page.waitForSelector('#fl-edit');
  await page.$eval('#fl-edit', (e) => { e.value = 'oh'; }); await page.keyboard.press('Enter'); await sleep(200);
  check('insert a syllable', (await toks()).includes('_ oh star'), await toks());
  await act('del'); await sleep(100);
  check('delete it', (await toks()).includes('_ star how'), await toks());
  if (!touch) { // drag a chip onto another note (mouse)
    const box = async (sel) => { const r = await page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }); return r; };
    const a = await box('.fitly .fl-n[data-k="7"] .fl-chip'), z = await box('.fitly .fl-n[data-k="6"] .fl-chip');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x - 20, a.y, { steps: 3 }); await page.mouse.move(z.x, z.y, { steps: 6 }); await page.mouse.up(); await sleep(200);
    check('drag a chip onto a held note', (await toks()).includes('tle star . how'), await toks());
    await act('undo'); await sleep(100);
  }
  check('the editor is back to: hold after tle', (await toks()) === 'Twin- kle Twin- kle lit- tle _ star how I won- der what you are', await toks());
  // play from a note
  await pick(7); await act('play'); await sleep(1200);
  const now = await page.$$eval('.fitly .fl-n.now', (e) => e.map((x) => +x.dataset.k));
  check('play from a note: the playing note lights up', now.length === 1 && now[0] >= 7, JSON.stringify(now));
  await act('play'); await sleep(150);
  check('stop', !(await page.$('.fitly .fl-n.now')));
  await page.screenshot({ path: `${SHOTS}/fitlyrics-${name.toLowerCase()}.png` });
  // preview: the score is drawn with the words
  await act('preview'); await sleep(2500);
  const drawn = await page.$$eval('#osmd svg text', (e) => e.map((x) => x.textContent).join(' '));
  check('preview draws the words in the score', /Twin/.test(drawn) && /star/.test(drawn), drawn.slice(0, 120));
  check('the preview saved nothing', (await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text())) === xml0);
  await page.screenshot({ path: `${SHOTS}/fitlyrics-${name.toLowerCase()}-preview.png` });
  await act('preview'); await sleep(200);
  // save
  await act('save'); await page.waitForSelector('.modal [data-mode]');
  check('save asks: this score or a new one', (await page.$$eval('.modal [data-mode]', (e) => e.map((x) => x.textContent).join('|'))) === 'Save as new score|Save to this score');
  await tap(`.modal [data-mode="${saveMode}"]`); await sleep(1500);
  let target = sc.id;
  if (saveMode === 'new') {
    const hash = await page.evaluate(() => location.hash);
    target = decodeURIComponent(hash.split('/')[2] || '');
    check('save as new: opens the new score; this one is untouched', target && target !== sc.id && (await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text())) === xml0, hash);
    const ni = await api(`/items/${target}`);
    check('the new score is in the same group, tagged Lyrics added', ni.groupId && ni.groupId === (await api(`/items/${sc.id}`)).groupId && ni.tags.includes('Lyrics added'), JSON.stringify(ni.tags));
  }
  const xml = await fetch(`${BASE}api/items/${target}/musicxml`).then((r) => r.text());
  const ly = lyricsOf(xml);
  check('saved: 13 syllables (the left-over one is left out)', ly.length === 13, ly.length);
  check('syllabic begin/end, extend on the held syllable', ly[0].syl === 'begin' && ly[1].syl === 'end' && ly[5].text === 'tle' && ly[5].ext && ly.filter((x) => x.ext).length === 1 && ly.every((x) => x.v === '1'), JSON.stringify(ly.slice(0, 7)));
  check('the panel closed', !(await page.$('.fitly')));
  // reload shows the words
  await page.goto(`${BASE}#/item/${target}`, { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  const drawn2 = await page.$$eval('#osmd svg text', (e) => e.map((x) => x.textContent).join(' '));
  check('reload: the score shows the words', /Twin/.test(drawn2) && /won/.test(drawn2), drawn2.slice(0, 80));
  // the editor reads them back (hold included)
  await tap('#it-more'); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Fit lyrics…').click());
  await page.waitForSelector('.fitly .fl-strip', { timeout: 8000 });
  check('the editor reads the saved words back', (await toks()) === 'Twin- kle Twin- kle lit- tle _ star how I won- der what you', await toks());
  await act('close'); await sleep(200);
  // Activities: Undo puts the score back
  await page.goto(`${BASE}#/activity`, { waitUntil: 'networkidle0' }); await sleep(800);
  const row = await page.evaluate((t) => { const r = [...document.querySelectorAll('#ac tr.ac-row')].find((x) => x.querySelector('.ac-title')?.textContent === `Fitted lyrics: ${t}`); return r && { id: r.dataset.id, btn: r.querySelector('[data-act]')?.textContent }; }, title);
  check('Activities has the fit, with Undo', row && /Undo/.test(row.btn || ''), JSON.stringify(row));
  if (row) {
    await tap(`#ac [data-act][data-id="${row.id}"]`); await sleep(300);
    await tap('.modal [data-ok]'); await sleep(1200);
    if (saveMode === 'new') check('Activities Undo: the new score goes to the Trash', (await api(`/items/${target}`)).deleted);
    else check('Activities Undo: the score is back as it was', (await fetch(`${BASE}api/items/${sc.id}/musicxml`).then((r) => r.text())) === xml0);
  }
  await page.close();
}

await run('Mac', MAC, 'this');
await run('iPad', IPAD, 'new');
await run('iPhone', PHONE, 'this');
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
process.exit(fail || errs.length ? 1 : 0);
