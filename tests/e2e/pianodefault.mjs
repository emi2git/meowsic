// Every score plays the PIANO by default; Voice (the sung audio from "Make it sing") only when chosen. Against a test
// server only (BASE, DB = its meowsic.db, DATA = its data folder: written to give a score a sung audio file).
// Per device (Mac, iPad, iPhone): a voice-over-piano score (V R L staves) WITH a sung audio and one without →
// both open with Voice off and Play plays the piano (notes scheduled, no sung audio); the old per-score key
// (`meowsic-voice-<id>`, where no key meant "on") is dropped, `meowsic-voice-lang` stays; tapping Voice plays the sung
// audio, is remembered after a reload (`meowsic-voice2-<id>`), and off again goes back to the piano.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || '';
const DB = process.env.DB || '', DATA = process.env.DATA || '';
if (!BASE || !DB || !DATA) { console.log('BASE, DB and DATA (a test server) are needed'); process.exit(2); }
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString();
const errs = [];
const stamp = Date.now().toString(36);

// a voice part (lyrics) over a two-staff piano, 4 bars of quarters
const n = (step, oct, staff, lyr) => `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type>${staff ? `<staff>${staff}</staff>` : ''}${lyr ? '<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>' : ''}</note>`;
const bars = (f) => [1, 2, 3, 4].map((k) => `<measure number="${k}">${f(k)}</measure>`).join('');
const att = (st) => `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>${st === 2 ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>'}</attributes>`;
const XML = '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
  + `<part id="P1">${bars((k) => (k === 1 ? att(1) : '') + ['E', 'F', 'G', 'A'].map((s) => n(s, 5, 0, true)).join(''))}</part>`
  + `<part id="P2">${bars((k) => (k === 1 ? att(2) : '') + ['C', 'D', 'E', 'F'].map((s) => n(s, 4, 1)).join('') + '<backup><duration>4</duration></backup>' + ['C', 'G', 'C', 'G'].map((s) => n(s, 3, 2)).join(''))}</part></score-partwise>`;
const sung = await send('/items', { kind: 'score', title: `Piano default sung ${stamp}`, version: 'original', bpm: 100, musicxmlText: XML });
const staffOnly = await send('/items', { kind: 'score', title: `Piano default staff ${stamp}`, version: 'original', bpm: 100, musicxmlText: XML });
// the sung audio: a 10 s tone as AAC (.m4a), in the TEST data folder only
const tmp = mkdtempSync(join(tmpdir(), 'pianodefault-'));
const rate = 22050, len = rate * 10, wav = Buffer.alloc(44 + len * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + len * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(len * 2, 40);
for (let i = 0; i < len; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
writeFileSync(join(tmp, 'v.wav'), wav);
execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', join(tmp, 'v.wav'), join(tmp, 'v.m4a')]);
const name = `${sung.folder} vocal.m4a`;
copyFileSync(join(tmp, 'v.m4a'), join(DATA, 'items', sung.folder, name));
rmSync(tmp, { recursive: true, force: true });
sql(`UPDATE score SET vocal_audio='${name.replace(/'/g, "''")}', vocal_bpm=100 WHERE item_id='${sung.id}'`);
sql(`UPDATE item SET updated_at=${Date.now()} WHERE id='${sung.id}'`);
check('the test score has a sung audio', (await api(`/items/${sung.id}`)).vocalAudio === name);

const spy = () => { const A = window.Audio; window.__audios = []; window.Audio = function (...a) { const x = new A(...a); if (!new Error().stack.includes('mediaUnlock')) window.__audios.push(x); return x; }; };
for (const [dev, vp] of [['Mac', { width: 1440, height: 900 }], ['iPad', { width: 1032, height: 1376, isMobile: true, hasTouch: true }], ['iPhone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  console.log(`\n${dev}`);
  const p = await b.newPage(); await p.setViewport(vp); await p.evaluateOnNewDocument(spy);
  p.on('pageerror', (e) => errs.push(`${dev}: ${e.message}`));
  const E = (f, ...a) => p.evaluate(f, ...a);
  const tap = async (sel) => { if (vp.hasTouch) await p.tap(sel); else await p.click(sel); await sleep(200); };
  const open = async (id) => { await p.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await p.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(800); };
  const vocalPlaying = () => E(() => window.__audios.some((a) => /\/vocal/.test(a.src) && !a.paused && a.currentTime > 0.2));
  const playPiano = async () => {
    await tap('#sc-play');
    for (let i = 0; i < 40 && !(await E(() => window.__score.player.playing && window.__score.player.now() > 0.5)); i++) await sleep(150);
    const r = await E(() => ({ playing: window.__score.player.playing, heard: (window.__score.player.heard || []).length, staves: [...new Set((window.__score.player.heard || []).map((h) => h[2]))].sort().join(), voice: window.__score.voice }));
    await tap('#sc-stop');
    return r;
  };
  // an old saved choice from before (no key / '1' meant Voice on); voice input language must survive the reset
  await p.goto(BASE, { waitUntil: 'networkidle0' });
  await E((id) => { localStorage.setItem(`meowsic-voice-${id}`, '1'); localStorage.setItem('meowsic-voice-lang', 'vi-VN'); localStorage.removeItem(`meowsic-voice2-${id}`); localStorage.removeItem('meowsic-hands'); }, sung.id);

  await open(sung.id);
  check(`${dev}: sung score: Voice button shown, OFF`, await p.$eval('#sc-voice', (e) => !e.hidden && !e.classList.contains('on') && e.getAttribute('aria-pressed') === 'false'));
  check(`${dev}: the old Voice key is gone, voice input language kept`, await E((id) => localStorage.getItem(`meowsic-voice-${id}`) === null && localStorage.getItem('meowsic-voice-lang') === 'vi-VN', sung.id));
  check(`${dev}: the voice staff is in the piano's staves (V R L)`, (await E(() => window.__score.staves.join())) === 'V,R,L', await E(() => window.__score.staves.join()));
  let r = await playPiano();
  check(`${dev}: Play plays the piano, every staff (vocal staff too)`, r.playing && !r.voice && r.heard > 0 && r.staves === '0,1,2', JSON.stringify(r));
  check(`${dev}: no sung audio played`, !(await E(() => window.__audios.some((a) => /\/vocal/.test(a.src) && !a.paused))));

  // choosing Voice still works
  await tap('#sc-voice'); await sleep(300);
  check(`${dev}: Voice on`, (await p.$eval('#sc-voice', (e) => e.classList.contains('on'))) && (await E(() => window.__score.voice)));
  await tap('#sc-play');
  let ok = false; for (let i = 0; i < 30 && !ok; i++) { await sleep(200); ok = await vocalPlaying(); }
  check(`${dev}: Voice: Play plays the sung audio`, ok, JSON.stringify(await E(() => window.__audios.map((a) => [a.src.slice(-30), a.paused, a.currentTime]))));
  await tap('#sc-play');
  await open(sung.id);
  check(`${dev}: reload: Voice stays on (picked on this device)`, (await p.$eval('#sc-voice', (e) => e.classList.contains('on'))) && (await E((id) => localStorage.getItem(`meowsic-voice2-${id}`), sung.id)) === '1');
  await tap('#sc-voice'); await sleep(300);
  await open(sung.id);
  r = await playPiano();
  check(`${dev}: Voice off → reload → the piano again`, !(await p.$eval('#sc-voice', (e) => e.classList.contains('on'))) && r.playing && !r.voice && r.heard > 0, JSON.stringify(r));

  // a vocal staff without a sung audio: piano, no Voice button
  await open(staffOnly.id);
  r = await playPiano();
  check(`${dev}: vocal staff, no sung audio: no Voice button, piano plays`, (await p.$eval('#sc-voice', (e) => e.hidden)) && r.playing && !r.voice && r.staves === '0,1,2', JSON.stringify(r));
  await p.close();
}
check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
