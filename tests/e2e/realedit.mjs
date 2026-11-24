// note editing on a real (transcribed) score, against the temp server on :5190
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const xmlOf = (id, orig) => fetch(`${BASE}api/items/${id}/musicxml${orig ? '?original=true' : ''}`).then((r) => r.text());
const xml = fs.readFileSync('/Users/emi2mac/Documents/Emi Music Note/memory-from-cats-andrew-lloyd-webber/memory-from-cats-andrew-lloyd-webber.musicxml', 'utf8');
const sc = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: 'Memory edit test', version: 'original', musicxmlText: xml }) });
await page.goto(BASE + '#/item/' + sc.id, { waitUntil: 'networkidle0' }); await sleep(4500);
await page.click('#sc-edit'); await sleep(400);
check('editor opens on a real score', !!(await page.$('.editbar')));
const notes = await page.$$eval('#osmd g.note-hit', (e) => e.length);
check('real score notes are clickable', notes > 50, notes);
const clickNote = async (bar, n) => {
  const r = await page.$eval(`#osmd g[data-bar="${bar}"][data-note="${n}"]`, (g) => { g.scrollIntoView({ block: 'center' }); const x = g.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height - 4 }; });
  await page.mouse.click(r.x, r.y); await sleep(250);
};
await clickNote(2, 0);
const before = await page.$eval('#eb-pitch', (e) => e.value);
check('click selects a real note (or rest)', before === '' || /^[A-G][#b]?\d$/.test(before), before);
await page.$eval('#eb-pitch', (e) => { e.value = ''; e.focus(); }); await page.keyboard.type('C6'); await page.keyboard.press('Enter'); await sleep(2500);
let x1 = await xmlOf(sc.id);
console.log('   after pitch, bar3:', (x1.match(/<measure[^>]*number="3"[^>]*>[\s\S]*?<\/measure>/)[0].replace(/\s+/g,' ').slice(0,140)));
check('typed pitch saved into the MusicXML on the Mac', x1 !== xml && x1.includes('<octave>6</octave>'));
check('original kept for reset', (await xmlOf(sc.id, true)).length > 1000);
await page.click('.editbar [data-a="add"]'); await sleep(2500);
x1 = await xmlOf(sc.id);
const bar3 = (t) => t.match(/<measure[^>]*number="3"[^>]*>[\s\S]*?<\/measure>/)[0];
console.log('   after add, bar3:', bar3(x1).replace(/\s+/g,' ').slice(0,140), '| notes', (bar3(x1).match(/<note/g)||[]).length);
check('adding a note gives bar 3 its own time signature', /<time>/.test(bar3(x1)), bar3(x1).slice(0, 200));
check('score still draws after edits', (await page.$$('#osmd svg')).length > 0);
await page.click('#sc-play'); await sleep(2000); check('edited score plays', (await page.evaluate(() => window.__score.player.now())) > 0.3); await page.click('#sc-play');
await page.click('.editbar [data-a="undo"]'); await sleep(2500);
{ const u = bar3(await xmlOf(sc.id)); check('undo removes the added note', !/<time>/.test(u), (u.match(/<note/g) || []).length + ' notes; ' + u.slice(0, 300)); }
await page.click('.editbar [data-a="reset"]'); await sleep(3000);
const back = await xmlOf(sc.id);
check('reset gives back the original notes', back.split('<octave>6</octave>').length === xml.split('<octave>6</octave>').length);
console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
await b.close();
