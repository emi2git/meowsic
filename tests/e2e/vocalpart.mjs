// Edit notes on a voice + piano score (two <part>s: the voice on its own staff, the piano on two), against a test
// server (BASE, temp data — never the real library). "I cannot edit the score's vocal line" (2026-11-27):
//   Mac: Voice | Piano shows; Piano is edited by default; Voice → the vocal notes can be picked and changed (↑, A–G,
//   drag), the piano stays as it was; back to Piano → its notes; Undo walks back across the switch; Save keeps the
//   vocal edit and the words; the part is remembered when the editor opens again;
//   iPhone: Voice | Piano shows, a tap on Voice then on a vocal note picks it.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5391/';
const SHOTS = process.env.SHOTS || '/private/tmp/claude-501/-Users-emi2mac/4133b106-9ccb-4a6c-97de-aed86ecf9500/scratchpad/vocalpart';
fs.mkdirSync(SHOTS, { recursive: true });
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const xmlOf = (id) => fetch(`${BASE}api/items/${id}/musicxml`).then((r) => r.text());
const errs = [];
const MAC = { width: 1440, height: 900 };
const PHONE = { width: 420, height: 912, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const stamp = Date.now().toString(36);

const STEP = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const TY = { 1: 'quarter', 2: 'half', 4: 'whole' };
const n = (m, q, staff, voice = 1, lyric = false) => `<note>${m == null ? '<rest/>' : `<pitch><step>${STEP[m % 12]}</step><octave>${Math.floor(m / 12) - 1}</octave></pitch>`}<duration>${q * 2}</duration><voice>${voice}</voice><type>${TY[q]}</type>${staff ? `<staff>${staff}</staff>` : ''}${lyric ? '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>' : ''}</note>`;
const ATT = '<divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>';
const VOICE = [[[72, 1], [74, 1], [76, 2]], [[77, 1], [76, 1], [74, 2]], [[72, 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
  + '<part id="P1">' + VOICE.map((bar, k) => `<measure number="${k + 1}">${k ? '' : `<attributes>${ATT}<clef><sign>G</sign><line>2</line></clef></attributes>`}${bar.map(([m, q]) => n(m, q, 0, 1, true)).join('')}</measure>`).join('') + '</part>'
  + '<part id="P2">' + VOICE.map((_, k) => `<measure number="${k + 1}">${k ? '' : `<attributes>${ATT}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`}${n(60, 4, 1)}<backup><duration>8</duration></backup>${n(48, 4, 2, 5)}</measure>`).join('') + '</part></score-partwise>';
const partMidis = (x, id) => { const d = x.split(`<part id="${id}">`)[1].split('</part>')[0]; return [...d.matchAll(/<note>([\s\S]*?)<\/note>/g)].map(([, t]) => { const s = t.match(/<step>(\w)<\/step>/), o = t.match(/<octave>(\d)<\/octave>/), a = t.match(/<alter>(-?\d)<\/alter>/); return s ? 12 * (+o[1] + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[s[1]] + (a ? +a[1] : 0) : null; }); };

async function open(vp, name, id) {
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/400|404|409|423|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800);
  await page.evaluate(() => document.querySelector('#sc-edit').click());
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(900);
  const EN = (f, ...a) => page.evaluate(f, ...a);
  const idle = async () => { await sleep(150); for (let i = 0; i < 80; i++) { if (!(await EN(() => window.__editNotes.busy))) break; await sleep(100); } await sleep(600); };
  return { page, EN, idle };
}

// ---------------- Mac ----------------
console.log('\nMac');
const title = `Voice and piano ${stamp}`;
const sc = await send('POST', '/items', { kind: 'score', title, artist: 'Test', musicxmlText: scoreXml(title), tags: ['Kids'] });
{
  const { page, EN, idle } = await open(MAC, 'Mac', sc.id);
  const seg = await EN(() => [...document.querySelectorAll('.np-partseg button')].map((x) => [x.textContent, x.classList.contains('on')]));
  check('Voice | Piano shows; Piano is edited first', JSON.stringify(seg) === '[["Voice",false],["Piano",true]]', JSON.stringify(seg));
  check('piano notes are the picks', (await EN(() => window.__editNotes.notes.filter((x) => !x.rest).map((x) => x.midi))).every((m) => m === 60 || m === 48));
  await page.click('.np-partseg [data-part="P1"]'); await idle();
  const vn = await EN(() => window.__editNotes.notes.filter((x) => !x.rest).map((x) => x.midi));
  check('Voice: the vocal notes can be picked', JSON.stringify(vn) === '[72,74,76,77,76,74,72]' && (await EN(() => window.__editNotes.partId)) === 'P1', JSON.stringify(vn));
  const tagged = await EN(() => window.__editNotes.notes.every((x) => document.querySelector(`#paper g[data-ref="${x.ref}"]`)));
  check('every vocal note is drawn and tagged', tagged);
  await page.screenshot({ path: `${SHOTS}/mac-voice.png` });
  // click the 2nd vocal note, ↑
  const d5 = await EN(() => { const x = window.__editNotes.notes.find((x) => x.bar === 0 && x.on === 1); const r = document.querySelector(`#paper g[data-ref="${x.ref}"]`).getBoundingClientRect(); return { ref: x.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(d5.x, d5.y); await sleep(250);
  check('a click picks the vocal note', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${d5.ref}]`);
  await page.keyboard.press('ArrowUp'); await idle();
  let x = await EN(() => window.__editNotes.xml);
  check('↑ on the vocal note: D5 → E♭5 in the voice part, the piano unchanged', partMidis(x, 'P1')[1] === 75 && JSON.stringify(partMidis(x, 'P2')) === '[60,48,60,48,60,48]', JSON.stringify([partMidis(x, 'P1'), partMidis(x, 'P2')]));
  // A–G on the next one (picked), then drag a note up a step
  await EN(() => { const x = window.__editNotes.notes.find((x) => x.bar === 1 && x.on === 0); window.__editNotes.select([x.ref]); }); await sleep(150);
  await page.keyboard.press('g'); await idle();
  x = await EN(() => window.__editNotes.xml);
  check('G typed: F5 → G5 in the voice part', partMidis(x, 'P1')[3] === 79, JSON.stringify(partMidis(x, 'P1')));
  const c6 = await EN(() => { const x = window.__editNotes.notes.find((x) => x.bar === 2 && x.on === 0); const g = document.querySelector(`#paper g[data-ref="${x.ref}"]`), r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, step: g.ownerSVGElement.getScreenCTM().d * 5 }; });
  await page.mouse.move(c6.x, c6.y); await page.mouse.down(); await page.mouse.move(c6.x, c6.y - c6.step * 2, { steps: 6 }); await page.mouse.up(); await idle();
  x = await EN(() => window.__editNotes.xml);
  check('drag the last vocal note up two steps: C5 → E5', partMidis(x, 'P1')[6] === 76, JSON.stringify(partMidis(x, 'P1')));
  check('the words stay on the voice part (7)', (x.split('<part id="P1">')[1].match(/<lyric/g) || []).length === 7);
  // back to Piano, then Undo walks back
  await page.click('.np-partseg [data-part="P2"]'); await idle();
  check('Piano again: its notes are the picks', (await EN(() => window.__editNotes.notes.filter((x) => !x.rest).map((x) => x.midi))).every((m) => m === 60 || m === 48));
  const s0 = await EN(() => window.__editNotes.step);
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta'); await idle();
  check('Undo after the switch: one step back (the drag undone), piano notes still the picks', (await EN(() => window.__editNotes.step)) === s0 - 1
    && partMidis(await EN(() => window.__editNotes.xml), 'P1')[6] === 72 && (await EN(() => window.__editNotes.notes.filter((x) => !x.rest).every((x) => x.midi === 60 || x.midi === 48))));
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta'); await idle();
  // save into this score
  await page.click('.notes-panel [data-a="save"]'); await sleep(300);
  await page.click('.modal [data-mode="this"]'); await sleep(1500);
  const saved = await xmlOf(sc.id);
  check('saved: the vocal edits are in, the piano unchanged, the words kept', JSON.stringify(partMidis(saved, 'P1')) === '[72,75,76,79,76,74,76]' && JSON.stringify(partMidis(saved, 'P2')) === '[60,48,60,48,60,48]' && (saved.split('<part id="P1">')[1].match(/<lyric/g) || []).length === 7, JSON.stringify(partMidis(saved, 'P1')));
  // opens again on the part edited last (Piano was picked last)
  await sleep(500);
  await page.evaluate(() => document.querySelector('#sc-edit').click()); await page.waitForSelector('.notes-panel', { timeout: 8000 }); await idle();
  check('opens again on the part picked last (Piano)', (await EN(() => window.__editNotes.partId)) === 'P2');
  await page.click('.np-partseg [data-part="P1"]'); await idle();
  await EN(() => window.__editNotes.close(true)); await sleep(400);
  await page.evaluate(() => document.querySelector('#sc-edit').click()); await page.waitForSelector('.notes-panel', { timeout: 8000 }); await idle();
  check('…and Voice after Voice was picked', (await EN(() => window.__editNotes.partId)) === 'P1' && (await EN(() => window.__editNotes.notes.filter((x) => !x.rest).length)) === 7);
  await EN(() => window.__editNotes.close(true)); await sleep(300);
  await page.close();
}

// ---------------- iPhone ----------------
console.log('\niPhone');
{
  const t2 = `Voice and piano phone ${stamp}`;
  const s2 = await send('POST', '/items', { kind: 'score', title: t2, artist: 'Test', musicxmlText: scoreXml(t2), tags: ['Kids'] });
  const { page, EN, idle } = await open(PHONE, 'iPhone', s2.id);
  check('Voice | Piano shows on iPhone', await EN(() => document.querySelectorAll('.np-partseg button').length === 2));
  await page.tap('.np-partseg [data-part="P1"]'); await idle();
  const v = await EN(() => { const x = window.__editNotes.notes.find((x) => x.bar === 0 && x.on === 0); const g = document.querySelector(`#paper g[data-ref="${x.ref}"]`); if (!g) return null; g.scrollIntoView({ block: 'center' }); const r = g.getBoundingClientRect(); return { ref: x.ref, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await sleep(300);
  const v2 = await EN((ref) => { const r = document.querySelector(`#paper g[data-ref="${ref}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, v.ref);
  await page.touchscreen.tap(v2.x, v2.y); await sleep(300);
  check('a tap picks the vocal note', JSON.stringify(await EN(() => window.__editNotes.sel)) === `[${v.ref}]`, JSON.stringify(await EN(() => window.__editNotes.sel)));
  await page.screenshot({ path: `${SHOTS}/phone-voice.png` });
  await EN(() => window.__editNotes.close(true)); await sleep(300);
  await page.close();
}

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
