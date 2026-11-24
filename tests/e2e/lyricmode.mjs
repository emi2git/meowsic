// Edit notes → Lyrics mode and the Lyrics text panel, against a test server (BASE, default :5391, a scratchpad data
// folder — never the real library). Made-up melody and made-up words only. Per device (Mac, iPad Pro 13", iPhone Air):
// open Edit notes (score ⋯ has no Fit lyrics / Add lyrics from a sheet any more) → Notes | Lyrics → type syllables
// ("-" goes on, space ends the word, Enter next, "_" hold, Backspace in an empty box goes back) → the words draw
// under the notes → Paste text… lays a verse out (rests and tied notes skipped), Vietnamese one per word → verse 2
// (verse 1 faded) → Shift ▶ / ◀ Shift / Skip / Clear from here → undo / redo → Mac: a note edit too, both saved into
// this score (the right <lyric>s, the notes as they were apart from that one), Activities undo; iPad: touch picking
// with the on-screen keyboard (simulated) not covering the note, Lyrics text drawer upright, save as a new version;
// iPhone: close without saving. The Lyrics text panel: the chart of the same title, toggled and remembered,
// chords hidden, A− / A+, "Use from selected note"; a score with no chart of its name: "No chord chart" + search.
// Screenshots go to $SHOTS.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5391/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/lyricmode';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const errs = [];
const MAC = { width: 1440, height: 900 };
const IPAD = { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const IPAD_SIDE = { width: 1376, height: 1032, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

// a made-up tune: bar 1 opens on a chord, bar 2 has a rest, bar 3 a tied note; the left hand a whole note per bar
const P = { 48: ['C', 3], 55: ['G', 3], 60: ['C', 4], 62: ['D', 4], 64: ['E', 4], 65: ['F', 4], 67: ['G', 4], 69: ['A', 4] };
const TY = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (ms, q, staff, tie) => (ms ? ms.map((m, k) => `<note>${k ? '<chord/>' : ''}<pitch><step>${P[m][0]}</step><octave>${P[m][1]}</octave></pitch><duration>${q * 2}</duration>${tie ? `<tie type="${tie}"/>` : ''}<voice>${staff === 2 ? 5 : 1}</voice><type>${TY[q]}</type><staff>${staff}</staff>${tie ? `<notations><tied type="${tie}"/></notations>` : ''}</note>`).join('')
  : `<note><rest/><duration>${q * 2}</duration><voice>1</voice><type>${TY[q]}</type><staff>1</staff></note>`);
const RH = [[[[55, 60], 1], [[62], 1], [[64], 1], [[65], 1]], [[[67], 2], [null, 1], [[67], 1]], [[[69], 2, 'start'], [[69], 1, 'stop'], [[67], 1]], [[[65], 1], [[64], 1], [[62], 1], [[60], 1]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.map(([ms, q, tie]) => note(ms, q, 1, tie)).join('') + '<backup><duration>8</duration></backup>' + note([48], 4, 2) + '</measure>').join('') + '</part></score-partwise>';
// the notes of a score without its words: pitch, length, ties, chords, staff, in order
const music = (x) => (x.match(/<note>[\s\S]*?<\/note>/g) || []).map((n) => n.replace(/<lyric[\s\S]*?<\/lyric>/g, '').replace(/<(stem|beam)[^>]*>[^<]*<\/\1>/g, '').replace(/\s+/g, '')).join('');
const lyrics = (x, v = '1') => [...x.matchAll(/<lyric number="(\d+)">\s*<syllabic>(\w+)<\/syllabic>\s*<text>([^<]*)<\/text>(\s*<extend\s*\/>)?/g)].filter((m) => m[1] === v).map((m) => `${m[3]}:${m[2]}${m[4] ? '+' : ''}`).join(' ');
const CHART = '{c: Verse 1}\n[C]Ma-ple [G]moon a-[F]bove the [C]hill\n[F]Qui-et [G]wa-ter [C]still\n\n{c: Verse 2}\n[C]Pa-per [G]boats go [C]by';

async function run(name, vp, how) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const title = `Moonbeam Tune ${name} ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Nobody', musicxmlText: scoreXml(title) });
  const ch = await send('POST', '/items', { kind: 'chords', title: `moonbeam tune ${name.toUpperCase()} ${stamp} (Live)`, artist: 'Nobody', key: 'C', capo: 0, source: 'pasted', url: '', text: CHART });
  const x0 = await xmlOf(sc.id);
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tapXY = async (x, y) => { if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await sleep(150); };
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const ly = (a) => tap(`.ly-bar [data-ly="${a}"]`);
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { for (let i = 0; i < 80; i++) { await sleep(150); if (!(await EN(() => window.__editNotes?.busy || window.__editNotes?.lyrics?.pending))) break; } await sleep(600); };
  const toks = () => EN(() => window.__editNotes.lyrics.tokens);
  const headOf = (ref) => EN((r) => { const g = document.querySelector(`#paper g[data-ref="${r}"]`); if (!g) return null; const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, bottom: b.bottom, top: b.top }; }, ref);
  const lineRef = (k) => EN((i) => window.__editNotes.lyrics.line[i], k);
  const typeIn = async (s) => { await page.keyboard.type(s, { delay: 25 }); await sleep(120); };
  const press = async (k) => { await page.keyboard.press(k); await sleep(120); };

  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await tap('#it-more'); await sleep(200);
  const entries = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
  check('score ⋯: no Edit notes (toolbar ✎), no Fit lyrics / Add lyrics from a sheet / Edit lyrics', entries.length > 0 && !entries.some((t) => /Edit notes|Fit lyrics|lyrics from a sheet|Edit lyrics/.test(t)), entries.join('|'));
  await page.evaluate(() => document.querySelector('.menu')?.remove()); await sleep(150);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel .np-mode', { timeout: 8000 }); await sleep(500);
  check('the edit bar has Notes | Lyrics, Notes on', (await page.$$eval('.np-mode button', (e) => e.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')).join('|'))) === 'Notes*|Lyrics');
  await tap('.np-mode [data-m="lyrics"]'); await sleep(400);
  const vis = await EN(() => ({ tools: !!document.querySelector('.notes-panel .np-tools')?.offsetParent, bar: !!document.querySelector('.ly-bar')?.offsetParent, undo: !!document.querySelector('.notes-panel [data-a="undo"]')?.offsetParent, play: !!document.querySelector('.notes-panel [data-a="playhere"]')?.offsetParent }));
  check('Lyrics: note tools hidden, lyrics bar shown, undo + ▶ From here stay', !vis.tools && vis.bar && vis.undo && vis.play, JSON.stringify(vis));
  const line = await EN(() => window.__editNotes.lyrics.line);
  check('the line: 12 notes (no rest, no tied note, top of the chord)', line.length === 12, line.length);
  check('the first note is picked', (await EN(() => window.__editNotes.lyrics.at)) === 0 && (await EN(() => window.__editNotes.sel[0])) === line[0]);

  // ---- typing ----
  if (touch) { const h = await headOf(line[0]); await tapXY(h.x, h.y); }
  else await page.focus('#ly-text');
  check('the box has the focus', await EN(() => document.activeElement?.id === 'ly-text'));
  await typeIn('Ma');
  check('typing shows at once under the note', await EN(() => [...document.querySelectorAll('#paper .ly-live text')].some((t) => t.textContent === 'Ma')));
  await typeIn('-');
  check('"-": the word goes on, next note', (await toks()) === 'Ma-' && (await EN(() => window.__editNotes.lyrics.at)) === 1, await toks());
  await typeIn('ple ');
  await typeIn('moon');
  await press('Enter');
  check('space ends the word, Enter = next note', (await toks()) === 'Ma- ple moon' && (await EN(() => window.__editNotes.lyrics.at)) === 3, await toks());
  await typeIn('_');
  check('"_": hold (melisma) and on', (await toks()) === 'Ma- ple moon _' && (await EN(() => window.__editNotes.lyrics.at)) === 4, await toks());
  await typeIn('rise');
  await press('Tab');
  await typeIn('zzz');
  await page.keyboard.down('Shift'); await press('Tab'); await page.keyboard.up('Shift');
  check('Tab on, Shift-Tab back', (await EN(() => window.__editNotes.lyrics.at)) === 4, await EN(() => window.__editNotes.lyrics.at));
  await press('Tab');
  for (let k = 0; k < (touch ? 4 : 2); k++) await press('Backspace'); // the 3 letters (Mac: picked, one key), then the empty box
  check('Backspace in an empty box takes it off and goes back', (await toks()) === 'Ma- ple moon _ rise' && (await EN(() => window.__editNotes.lyrics.at)) === 4, await toks());
  await idle();
  let x = await EN(() => window.__editNotes.xml);
  check('the words are in the drawn score: begin / end / extend', lyrics(x) === 'Ma:begin ple:end moon:single+ rise:single', lyrics(x));
  check('OSMD draws them under the notes', await EN(() => [...document.querySelectorAll('#paper svg .lyrics')].some((t) => t.textContent.trim() === 'moon')));
  check('the notes are as they were', music(x) === music(x0));
  if (name === 'Mac') await page.screenshot({ path: `${SHOTS}/${name}-typing.png` });

  // ---- paste a verse: one syllable per note from the picked note ----
  let h = await headOf(line[5]); await tapXY(h.x, h.y);
  check('tap a note picks it in the line', (await EN(() => window.__editNotes.lyrics.at)) === 5);
  await ly('paste'); await page.waitForSelector('#ly-paste');
  await page.$eval('#ly-paste', (e) => { e.value = 'Qui-et wa-ter\nstill and blue'; });
  await page.click('.modal [data-lang="auto"]');
  await page.click('.modal [data-ok]'); await idle();
  check('Paste: split into syllables, laid from the picked note (rest + tied note skipped)', (await toks()) === 'Ma- ple moon _ rise Qui- et wa- ter still and blue', await toks());
  x = await EN(() => window.__editNotes.xml);
  const tiedLy = await EN(() => { const d = new DOMParser().parseFromString(window.__editNotes.xml, 'application/xml'); return [...d.querySelectorAll('note')].filter((n) => n.querySelector('tie[type="stop"]') && n.querySelector('lyric')).length; });
  check('no words on the tied note or the rest', tiedLy === 0 && !/<rest\/>[\s\S]{0,200}<lyric/.test(x.replace(/\s+/g, '')));
  // Vietnamese: one syllable per word
  h = await headOf(line[0]); await tapXY(h.x, h.y);
  await ly('paste'); await page.waitForSelector('#ly-paste');
  await page.$eval('#ly-paste', (e) => { e.value = 'Trăng lên đồi xanh'; });
  await page.click('.modal [data-ok]'); await idle();
  check('Vietnamese: one syllable per word', (await toks()).startsWith('Trăng lên đồi xanh rise'), await toks());

  // ---- verse 2 ----
  await ly('addverse'); await sleep(300);
  check('+ adds verse 2 and edits it', (await EN(() => window.__editNotes.lyrics.verse)) === '2' && (await page.$$eval('.ly-verse [data-ly="verse"]', (e) => e.map((x) => x.textContent).join(','))) === '1,2');
  await page.focus('#ly-text');
  await typeIn('Pa-per boats ');
  await idle();
  x = await EN(() => window.__editNotes.xml);
  check('verse 2 written, verse 1 kept', lyrics(x, '2') === 'Pa:begin per:end boats:single' && lyrics(x, '1').startsWith('Trăng:single'), lyrics(x, '2'));
  check('verse 1 drawn faded', (await page.$$eval('#paper svg .lyrics.ly-other', (e) => e.length)) >= 4);
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/${name}-verse2.png` });
  await tap('.ly-verse [data-v="1"]'); await sleep(300);

  // ---- shift / skip / clear ----
  h = await headOf(line[1]); await tapXY(h.x, h.y);
  await ly('right'); await idle();
  check('Shift ▶: this syllable and the rest one note later', (await toks()).startsWith('Trăng . lên đồi xanh'), await toks());
  await ly('left'); await idle();
  check('◀ Shift: back', (await toks()).startsWith('Trăng lên đồi xanh rise'), await toks());
  h = await headOf(line[2]); await tapXY(h.x, h.y);
  await ly('skip'); await idle();
  check('Skip note: none here, the rest moves on, next note picked', (await toks()).startsWith('Trăng lên . đồi xanh') && (await EN(() => window.__editNotes.lyrics.at)) === 3, await toks());
  h = await headOf(line[9]); await tapXY(h.x, h.y);
  await ly('clear'); await idle();
  check('Clear from here', (await toks()) === 'Trăng lên . đồi xanh rise Qui- et wa-', await toks());

  // ---- undo / redo ----
  const steps = await EN(() => window.__editNotes.step);
  await tap('.notes-panel [data-a="undo"]'); await idle();
  check('Undo: the words come back', (await toks()).startsWith('Trăng lên . đồi xanh rise Qui- et wa- ter') && (await EN(() => window.__editNotes.step)) === steps - 1, await toks());
  await tap('.notes-panel [data-a="redo"]'); await idle();
  check('Redo (a word cut short reads as ended)', (await toks()) === 'Trăng lên . đồi xanh rise Qui- et wa' && (await EN(() => window.__editNotes.step)) === steps, await toks());

  // ---- the Lyrics text panel ----
  if (!(await EN(() => window.__editNotes.lyrics.text.open))) await tap('.notes-panel .np-lt');
  await sleep(900);
  const lt = await EN(() => ({ open: !!document.querySelector('.lt-panel'), side: document.querySelector('.viewer').classList.contains('lt-side'), drawer: document.querySelector('.viewer').classList.contains('lt-drawer'), chart: window.__editNotes.lyrics.text.chart?.title || '', lines: document.querySelectorAll('.lt-text .ln').length, chords: document.querySelectorAll('.lt-text .ch').length }));
  check('Lyrics text: the chart of the same title (case / bracket left out), chords above the words', lt.open && /moonbeam tune/i.test(lt.chart) && lt.lines >= 3 && lt.chords >= 4, JSON.stringify(lt));
  check(`Lyrics text sits ${how === 'new' || name === 'iPhone' ? 'in a drawer (upright / iPhone)' : 'on the right'}`, how === 'new' || name === 'iPhone' ? lt.drawer : lt.side, JSON.stringify(lt));
  const fitW = await EN(() => { const s = document.querySelector('#it-body').getBoundingClientRect(), p = document.querySelector('.lt-panel').getBoundingClientRect(), svg = document.querySelector('#osmd svg').getBoundingClientRect(); return { ok: s.right <= p.left + 1 || s.bottom <= p.top + 1, svg: svg.right <= Math.max(s.right, innerWidth) + 1, scroll: document.scrollingElement.scrollWidth <= innerWidth + 1 }; });
  check('the score lays out in the room left (no overlap, no page scroll)', fitW.ok && fitW.scroll, JSON.stringify(fitW));
  await tap('.lt-panel [data-lt="chords"]'); await sleep(200);
  check('Chords off: words only', await EN(() => [...document.querySelectorAll('.lt-text .ch')].every((c) => getComputedStyle(c).display === 'none')));
  const s0 = await EN(() => parseFloat(getComputedStyle(document.querySelector('.lt-text')).fontSize));
  await tap('.lt-panel [data-lt="bigger"]'); await sleep(150);
  check('A+ makes the text bigger', (await EN(() => parseFloat(getComputedStyle(document.querySelector('.lt-text')).fontSize))) > s0);
  await tap('.lt-panel [data-lt="chords"]'); await sleep(200);
  // Use from selected note: pick bar 4's first note, select the second line of the text (chords shown: taken out)
  const k10 = 7;
  h = await headOf(line[k10]); await tapXY(h.x, h.y);
  await EN(() => { const l = document.querySelectorAll('.lt-text .ln')[1]; const r = document.createRange(); r.selectNodeContents(l); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await sleep(200);
  await tap('.lt-panel [data-lt="use"]'); await idle();
  check('Use from selected note: the words (no chords), one syllable per note from there', (await toks()).endsWith('Qui- et wa- ter still'), await toks());
  if (name !== 'iPhone') await page.screenshot({ path: `${SHOTS}/${name}-lyrics-text.png` });

  // ---- iPad: touch, the on-screen keyboard must not cover the picked note ----
  if (how === 'new') {
    await tap('.notes-panel .np-lt'); await sleep(900); // the drawer away: more room
    await EN(() => document.activeElement?.blur());
    h = await headOf(line[11]); await tapXY(h.x, h.y);
    check('a tap on a note focuses the box (the keyboard comes up)', await EN(() => document.activeElement?.id === 'ly-text'), JSON.stringify([h, await EN(() => [window.__editNotes.sel, window.__editNotes.lyrics.at, document.activeElement?.tagName])]));
    await EN(() => { const v = window.visualViewport; Object.defineProperty(v, 'height', { configurable: true, get: () => innerHeight - 420 }); v.dispatchEvent(new Event('resize')); });
    await sleep(400);
    const kb = await EN((r) => { const g = document.querySelector(`#paper g[data-ref="${r}"]`).getBoundingClientRect(), p = document.querySelector('.notes-panel').getBoundingClientRect(); return { note: g.bottom, panelTop: p.top, panelBottom: p.bottom, kbTop: innerHeight - 420 }; }, line[11]);
    check('keyboard up: the panel sits above it and the note above the panel', kb.panelBottom <= kb.kbTop + 1 && kb.note < kb.panelTop, JSON.stringify(kb));
    await page.screenshot({ path: `${SHOTS}/${name}-keyboard.png` });
    await EN(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
    await sleep(300);
    await tap('.notes-panel .np-lt'); await sleep(600);
  }

  // ---- notes and words in one session (Mac) ----
  if (how === 'this') {
    await tap('.np-mode [data-m="notes"]'); await sleep(300);
    check('Notes again: the note tools are back', await EN(() => !!document.querySelector('.notes-panel .np-tools')?.offsetParent && !document.querySelector('.ly-bar')));
    const f = await EN(() => window.__editNotes.notes.find((n) => n.bar === 3 && n.midi === 62).ref);
    h = await headOf(f); await tapXY(h.x, h.y);
    await tap('.notes-panel [data-a="semi+"]'); await idle();
  }
  const want = await EN(() => window.__editNotes.xml);
  if (how === 'this' || how === 'new') {
    await tap(how === 'this' ? '.notes-panel [data-a="save"]' : '.ly-bar [data-ly="save"]'); await page.waitForSelector('.np-save'); await sleep(200);
    await page.evaluate((m) => document.querySelector(`.np-save [data-mode="${m}"]`).click(), how); await sleep(2500);
    check('saved, the editor closed', !(await page.$('.notes-panel')));
  }
  if (how === 'this') {
    const saved = await xmlOf(sc.id);
    check('saved: the <lyric>s of both verses', lyrics(saved) === lyrics(want) && lyrics(saved, '2') === 'Pa:begin per:end boats:single' && /<lyric number="1">\s*<syllabic>begin<\/syllabic>\s*<text>Qui<\/text>/.test(saved), lyrics(saved));
    check('saved: the note edit too (D → D♯), every other note unchanged', music(saved) === music(want) && music(saved) !== music(x0) && (music(saved).match(/<note>/g) || []).length === (music(x0).match(/<note>/g) || []).length);
    check('saved: ties and chords kept', (saved.match(/<tie type="start"\s*\/>/g) || []).length === 1 && (saved.match(/<chord\s*\/>/g) || []).length === 1);
    const row = (await api('/activity')).find((r) => r.type === 'edit-notes' && r.title.includes(title));
    check('Activities: one row with words and notes, undoable', row && row.action === 'undo' && /lyrics of verses 1, 2/.test(row.detail) && /higher/.test(row.detail), JSON.stringify(row || {}));
    await send('POST', `/activity/${row.id}/undo`, {});
    check('Activities undo puts the score back', (await xmlOf(sc.id)) === x0);
  } else if (how === 'new') {
    await sleep(1000);
    const id = await page.evaluate(() => decodeURIComponent(location.hash.split('/').pop()));
    const it = await api(`/items/${id}`);
    check('saved as a new version tagged Lyrics added, this score unchanged', id !== sc.id && it.tags?.includes('Lyrics added') && (await xmlOf(sc.id)) === x0, JSON.stringify(it.tags));
    check('the new version has the words and the same notes', music(await xmlOf(id)) === music(x0) && lyrics(await xmlOf(id)) === lyrics(want));
    const row = (await api('/activity')).find((r) => r.type === 'edit-notes' && r.title.includes(title));
    await send('POST', `/activity/${row.id}/undo`, {});
  } else {
    await page.screenshot({ path: `${SHOTS}/${name}-lyrics.png` });
    await tap('.notes-panel [data-a="close"]'); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal-wrap button')].find((x) => x.textContent.trim() === 'Close').click()); await sleep(1200);
    check('closed without saving: unchanged', !(await page.$('.notes-panel')) && (await xmlOf(sc.id)) === x0);
  }

  // ---- the panel is remembered; a score with no chord chart of its name ----
  const other = await send('POST', '/items', { kind: 'score', title: `Lonely Tune ${name} ${stamp}`, musicxmlText: scoreXml('Lonely') });
  await page.goto(`${BASE}#/item/${other.id}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.evaluate(() => window.__score && 0);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel .np-lt', { timeout: 8000 }); await sleep(700);
  check('Lyrics text stays open next time (this device)', !!(await page.$('.lt-panel')) && (await page.$eval('.notes-panel .np-lt', (e) => e.getAttribute('aria-pressed'))) === 'true');
  check('no chart of that name: “No chord chart for this song” and a search', /No chord chart for this song/.test(await page.$eval('.lt-panel', (e) => e.textContent)) && !!(await page.$('.lt-q')));
  await page.type('.lt-q', 'moonbeam tune ' + name.toLowerCase()); await sleep(300);
  await tap('.lt-list [data-lt="chart"]'); await sleep(300);
  check('search picks any chord chart', (await page.$$eval('.lt-text .ln', (e) => e.length)) >= 3);
  await tap('.notes-panel .np-lt'); await sleep(300);
  check('toggled off', !(await page.$('.lt-panel')) && (await EN(() => JSON.parse(localStorage.getItem('meowsic-lyricstext')).open)) === false);
  await send('POST', '/items/trash', { ids: [sc.id, other.id, ch.id] }).catch(() => {});
  await page.close();
}

// iPad sideways: the panel on the right
async function sideways() {
  console.log('\niPad sideways');
  const title = `Sideways Tune ${stamp}`;
  const sc = await send('POST', '/items', { kind: 'score', title, musicxmlText: scoreXml(title) });
  const ch = await send('POST', '/items', { kind: 'chords', title, key: 'C', capo: 0, source: 'pasted', url: '', text: CHART });
  const page = await b.newPage(); await page.setViewport(IPAD_SIDE);
  page.on('pageerror', (e) => errs.push(`side: ${e.message}`));
  await page.goto(`${BASE}#/item/${sc.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600);
  await page.evaluate(() => localStorage.setItem('meowsic-lyricstext', JSON.stringify({ open: true, chords: true, size: 16 })));
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.lt-panel', { timeout: 8000 }); await sleep(900);
  check('iPad sideways: Lyrics text on the right', await page.evaluate(() => document.querySelector('.viewer').classList.contains('lt-side')));
  await page.screenshot({ path: `${SHOTS}/iPad-sideways.png` });
  await send('POST', '/items/trash', { ids: [sc.id, ch.id] }).catch(() => {});
  await page.close();
}

await run('Mac', MAC, 'this');
await run('iPad', IPAD, 'new');
await run('iPhone', PHONE, 'plain');
await sideways();
await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
