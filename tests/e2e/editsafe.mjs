// Edit notes never loses edits (web/js/editdraft.js, server/meowsic/editsafe.py). Against a test server this
// suite starts and stops itself (SERVER = its shell command, BASE, DATA = its temp data folder; never :5180):
//  1. the editor's edit session locks the score: an agent's write gets 423 (the page's own edits go through);
//  2. conflict: another client saves the score while the editor is open, the user keeps editing, Save → merged
//     ("Saved ✓ hh:mm … merged"); when edits clash, the full edit is kept as "<title> (my edits)" — nothing lost;
//  3. a reload mid-edit → "Restore unsaved edits (N changes, …)" → Save works, the draft goes;
//  4. a browser that never saved (another context, no localStorage) gets the draft back from the Mac;
//  5. the server restarts mid-edit: the edits stay, a Save while it is down shows an error that stays, after it is
//     back Save works.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { spawn } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:5390/';
const SERVER = process.env.SERVER, DATA = process.env.DATA;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
let srv;
const up = async () => { try { return (await fetch(BASE + 'api/health')).ok; } catch { return false; } };
const start = async () => { srv = spawn(SERVER, { shell: true, detached: true, stdio: 'ignore' }); for (let i = 0; i < 150 && !(await up()); i++) await sleep(200); if (!(await up())) throw new Error('server did not start'); };
const stop = async () => { try { process.kill(-srv.pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50 && (await up()); i++) await sleep(200); };
if (!SERVER || !DATA) { console.error('SERVER (the shell command that starts the test server) and DATA are required'); process.exit(2); }
if (await up()) { console.error('Something already answers at ' + BASE + ' — this test owns the server'); process.exit(2); }
await start();

const api = (p, o) => fetch(BASE + 'api' + p, o);
const send = (method, p, body, h = {}) => api(p, { method, headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
const xmlOf = (id) => api(`/items/${id}/musicxml`).then((r) => r.text());
const STEPS = { 48: 'C3', 53: 'F3', 55: 'G3', 59: 'B3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4' };
const TYPE = { 1: 'quarter', 2: 'half', 4: 'whole' };
const note = (ms, q, staff) => ms.map((m, k) => `<note>${k ? '<chord/>' : ''}<pitch><step>${STEPS[m][0]}</step><octave>${STEPS[m][1]}</octave></pitch><duration>${q * 2}</duration><voice>${staff === 2 ? 5 : 1}</voice><type>${TYPE[q]}</type><staff>${staff}</staff></note>`).join('');
const RH = [[[[64, 60], 1], [[64], 1], [[65], 1], [[67], 1]], [[[67], 1], [[65], 1], [[64], 1], [[62], 1]], [[[60], 1], [[60], 1], [[62], 1], [[64], 1]], [[[64, 60], 4]]];
const LH = [[[[48], 2], [[55], 2]], [[[59], 2], [[55], 2]], [[[53], 2], [[55], 2]], [[[48, 55], 4]]];
const scoreXml = (title) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'}`
    + bar.map(([ms, q]) => note(ms, q, 1)).join('') + '<backup><duration>8</duration></backup>' + LH[k].map(([ms, q]) => note(ms, q, 2)).join('') + '</measure>').join('') + '</part></score-partwise>';
// what sounds where: "bar:staff:on:midi" (from the server's own reading)
const music = async (id) => { const p = await (await send('POST', `/items/${id}/editnotes/preview`, { ops: [] })).json(); return new Set(p.notes.filter((n) => !n.rest).map((n) => `${n.bar}:${n.staff}:${n.on}:${n.midi}`)); };
const refOf = (notes, bar, midi, on) => notes.find((n) => n.bar === bar && n.midi === midi && n.staff === 1 && (on == null || n.on === on))?.ref;
// "another client" (an agent through the API) saving a change; editor sessions don't lock each other out, so it
// goes in as an editor of its own (its lock lapses too): the same as a write that came while the lock was down
const agentSave = async (id, ops) => {
  const s = 'agent-' + Math.random().toString(36).slice(2, 8);
  await send('POST', `/items/${id}/editsession`, { session: s, beat: true });
  const p = await (await send('POST', `/items/${id}/editnotes/preview`, { ops: [] })).json();
  const r = await send('POST', `/items/${id}/editnotes`, { ops: ops(p.notes), mode: 'this', sha: p.sha }, { 'X-Edit-Session': s });
  await send('POST', `/items/${id}/editsession/end`, { session: s });
  return r;
};

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const errs = [];
const stamp = Date.now().toString(36);
const mkScore = async (t) => (await (await send('POST', '/items', { kind: 'score', title: `${t} ${stamp}`, artist: 'Beethoven', musicxmlText: scoreXml(t) })).json());
async function pageOn(ctx, tag) {
  const page = await ctx.newPage(); await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errs.push(`${tag}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|423|Failed to load resource|ERR_CONNECTION|Failed to fetch|favicon/.test(m.text()) && errs.push(`${tag}: ${m.text()}`));
  return page;
}
const EN = (page, f, ...a) => page.evaluate(f, ...a);
const idle = async (page) => { for (let i = 0; i < 80; i++) { await sleep(150); if (!(await EN(page, () => window.__editNotes?.busy))) break; } await sleep(400); };
async function openEditor(page, id, { restore } = {}) {
  await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(500);
  await page.click('#sc-edit');
  if (restore !== undefined) {
    await page.waitForSelector('.np-restore', { timeout: 8000 });
    const txt = await page.$eval('.modal', (e) => e.textContent);
    await page.click(`.np-restore [data-k="${restore ? 'restore' : 'discard'}"]`);
    await page.waitForSelector('.notes-panel', { timeout: 8000 }); await idle(page);
    return txt;
  }
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await idle(page);
}
const edit = async (page, f) => { const op = await EN(page, f); await EN(page, (o) => window.__editNotes.run(o), op); await idle(page); return op; };
const pitchUp = (bar, midi, by, on) => new Function(`const n = window.__editNotes.notes.find((n) => n.bar === ${bar} && n.midi === ${midi} && n.staff === 1${on == null ? '' : ` && n.on === ${on}`}); return { op: 'pitch', refs: [n.ref], by: ${by} };`);
async function save(page) {
  await page.evaluate(() => document.querySelector('.save-note')?.remove());
  await page.click('.notes-panel [data-a="save"]');
  await page.waitForSelector('.np-save [data-mode="this"]', { timeout: 5000 });
  await page.click('.np-save [data-mode="this"]');
  await page.waitForSelector('.save-note', { timeout: 15000 }); await sleep(600);
  return page.$eval('.save-note', (e) => ({ text: e.textContent, err: e.classList.contains('err') }));
}
const ls = (page, id) => EN(page, (k) => localStorage.getItem(k), `meowsic-editdraft-${id}`);

try {
  const ctx = await b.createBrowserContext();
  // ---- 1 + 2: lock, then a merge with a newer change ----
  console.log('\nlock + merge');
  const A = await mkScore('Ode safe A');
  let page = await pageOn(ctx, 'A');
  await openEditor(page, A.id);
  check('the editor holds an edit session', (await (await api(`/items/${A.id}/editsession`)).json()).active);
  let r = await api(`/items/${A.id}/musicxml`, { method: 'PUT', body: scoreXml('x') });
  check('an agent write while the editor is open: 423 Locked, with words', r.status === 423 && /Edit notes is open/.test((await r.json()).detail), String(r.status));
  r = await send('POST', `/items/${A.id}/editnotes`, { ops: [{ op: 'pitch', refs: [0], by: 1 }], mode: 'this' });
  check('an agent Edit notes save: 423 too', r.status === 423);
  await EN(page, async (id) => (await import('/js/store.js')).store.update(id, { transpose: 2 }), A.id); await sleep(800);
  check('the page\'s own writes to the score (transpose) pass the lock', (await (await api(`/items/${A.id}`)).json()).transpose === 2);
  await EN(page, async (id) => (await import('/js/store.js')).store.update(id, { transpose: 0 }), A.id); await sleep(500);
  await edit(page, pitchUp(1, 67, 2)); // bar 2: G4 -> A4
  r = await agentSave(A.id, (ns) => [{ op: 'pitch', refs: [refOf(ns, 0, 65)], by: 1 }]); // meanwhile: bar 1 F4 -> F#4
  check('another client saved the score meanwhile', r.ok, String(r.status));
  await edit(page, pitchUp(2, 62, -2)); // the user keeps editing: bar 3 D4 -> C4
  check('the editor still shows the score as it opened plus its edits', (await EN(page, () => window.__editNotes.notes.some((n) => n.bar === 0 && n.midi === 65))));
  let note = await save(page);
  check('Save: "Saved ✓ hh:mm" … merged with a newer change', /Saved ✓ \d\d:\d\d/.test(note.text) && /merged/i.test(note.text) && !note.err, note.text);
  check('no "close the editor and open it again"', !/close the editor/i.test(note.text));
  let m = await music(A.id);
  check('both the user\'s edits and the other change are in the score', m.has('1:1:0:69') && m.has('2:1:2:60') && m.has('0:1:2:66'), [...m].join(' '));
  check('the draft is gone after the save', !(await ls(page, A.id)) && !(await (await api(`/items/${A.id}/editnotes/draft`)).json()).drafts.length);
  check('the session ended with the editor', !(await (await api(`/items/${A.id}/editsession`)).json()).active);
  await sleep(500);
  const acts = await (await api('/activity')).json();
  check('Activities: "merged with a newer change"', acts.some((a) => /merged with a newer change/.test(a.detail || '')));

  // ---- 2b: the edits clash: what merges goes in, the full edit is kept as "(my edits)" ----
  console.log('\nclash');
  await openEditor(page, A.id);
  await edit(page, pitchUp(0, 64, 1, 1)); // bar 1 beat 2 E4 -> F4 (the other client changes that bar)
  await edit(page, pitchUp(1, 65, 1)); // bar 2 F4 -> F#4 (merges)
  const mine = await EN(page, () => window.__editNotes.notes.filter((n) => !n.rest).map((n) => `${n.bar}:${n.staff}:${n.on}:${n.midi}`));
  r = await agentSave(A.id, (ns) => [{ op: 'pitch', refs: [refOf(ns, 0, 64, 1)], by: -1 }]);
  note = await save(page);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editsafe-myedits.png` });
  check('Save: kept in full as "(my edits)", says so and stays', /my edits/.test(note.text) && /Saved ✓/.test(note.text), note.text);
  await sleep(1000);
  const copy = (await (await api('/backup')).json()).items.find((x) => x.title === `${A.title} (my edits)`);
  check('the "(my edits)" copy exists', !!copy);
  if (copy) { const cm = await music(copy.id); check('the copy is exactly the user\'s edited score', mine.length === cm.size && mine.every((x) => cm.has(x)), mine.join(' ')); }
  m = await music(A.id);
  check('the score: the other change stays, the user\'s mergeable edit is in', m.has('0:1:1:63') && m.has('1:1:1:66'), [...m].join(' '));
  check('the note stays on screen (not a 2 s toast)', await (async () => { await sleep(3000); return !!(await page.$('.save-note')); })());
  await page.close();

  // ---- 3: reload mid-edit → Restore ----
  console.log('\nreload → restore');
  const B = await mkScore('Ode safe B');
  page = await pageOn(ctx, 'B');
  await openEditor(page, B.id);
  await edit(page, pitchUp(1, 67, 2)); await edit(page, pitchUp(2, 60, 2, 0));
  const d0 = JSON.parse((await ls(page, B.id)) || 'null');
  check('a draft in this browser after every edit', d0?.ops?.length === 2 && d0.sha, JSON.stringify(d0)?.slice(0, 120));
  await page.reload({ waitUntil: 'networkidle0' });
  const txt = await openEditor(page, B.id, { restore: true });
  check('reopening offers "Restore unsaved edits (2 changes, hh:mm)"', /Restore unsaved edits \(2 changes, \d\d:\d\d\)/.test(txt) && /Discard/.test(txt), txt);
  check('restored: 2 edits, one undo step', (await EN(page, () => window.__editNotes.ops.length)) === 2 && (await EN(page, () => window.__editNotes.step)) === 1);
  note = await save(page);
  m = await music(B.id);
  check('Save after restore: both edits in the score', /Saved ✓/.test(note.text) && m.has('1:1:0:69') && m.has('2:1:0:62'), note.text);
  check('the draft is gone after the save (browser + Mac)', !(await ls(page, B.id)) && !(await (await api(`/items/${B.id}/editnotes/draft`)).json()).drafts.length);
  // Discard
  await openEditor(page, B.id); await edit(page, pitchUp(1, 65, 1));
  await page.reload({ waitUntil: 'networkidle0' });
  await openEditor(page, B.id, { restore: false });
  check('Discard: the editor opens on the saved score, no draft left', (await EN(page, () => window.__editNotes.step)) === 0 && !(await ls(page, B.id)));
  await EN(page, () => window.__editNotes.close()); await sleep(400);
  await page.close();

  // ---- 4 + 5: the Mac's draft, a browser with nothing, and a server restart mid-edit ----
  console.log('\nserver restart mid-edit');
  const C = await mkScore('Ode safe C');
  page = await pageOn(ctx, 'C');
  await openEditor(page, C.id);
  await edit(page, pitchUp(1, 67, 2));
  await EN(page, () => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(800);
  await EN(page, () => { delete document.visibilityState; });
  const onDisk = fs.existsSync(`${DATA}/drafts/${C.id}`) && fs.readdirSync(`${DATA}/drafts/${C.id}`).some((f) => /^draft-.*\.json$/.test(f));
  check('page hidden → the draft is on the Mac\'s disk', onDisk);
  await stop();
  check('server stopped', !(await up()));
  note = await save(page);
  check('Save while the Mac is down: an error that says the edits are kept', note.err && /Not saved/.test(note.text) && /kept/.test(note.text), note.text);
  await sleep(3500);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editsafe-error.png` });
  check('the error stays until dismissed', !!(await page.$('.save-note.err')));
  await page.evaluate(() => document.querySelector('.np-save')?.closest('.modal-wrap')?.remove());
  await start();
  check('server back', await up());
  const ds = (await (await api(`/items/${C.id}/editnotes/draft`)).json()).drafts;
  check('the draft survived the restart', ds.length === 1 && ds[0].n === 1, JSON.stringify(ds));
  check('the lock survived the restart', (await (await api(`/items/${C.id}/editsession`)).json()).active);
  // another browser with no local draft (a crash, another device): the Mac's draft is offered
  const ctx2 = await b.createBrowserContext();
  const p2 = await pageOn(ctx2, 'C2');
  const t2 = await openEditor(p2, C.id, { restore: true });
  check('another browser gets the Mac\'s draft back', /Restore unsaved edits \(1 change,/.test(t2) && (await EN(p2, () => window.__editNotes.ops.length)) === 1, t2);
  await p2.close(); await ctx2.close();
  await edit(page, pitchUp(2, 62, -2)); // the first page keeps editing after the restart
  note = await save(page);
  m = await music(C.id);
  check('after the restart Save works: both edits saved', /Saved ✓/.test(note.text) && !note.err && m.has('1:1:0:69') && m.has('2:1:2:60'), note.text + ' ' + [...m].join(' '));
  await page.close();
  await ctx.close();
} catch (e) { fail++; console.log('  FAIL', e.stack); }
await b.close();
await stop();
if (errs.length) { console.log('page errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail + errs.length} failed`);
process.exit(fail || errs.length ? 1 : 0);
