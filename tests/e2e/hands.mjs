// Parts to play (score toolbar + Edit notes: V / R / L / C on / off toggles, several on at once, no "Both"): against a
// test server (BASE, a temp data folder — never the real library). Per device (Mac, iPad Pro 13", iPhone): made-up
// scores — one staff (no toggles), a piano (two staves, chord names, a repeat over bars 1–2) and a voice over a piano
// (three staves) → R L C for the piano (no Both), every staff on and C off at first, short labels with full-name
// aria-labels, aria-pressed + the --acc-soft fill when on; Play schedules notes only from the staves on
// (window.__score.player.heard = [q, midi, staff]); the repeat still plays; C alone plays only the chords; the last
// one on stays on (aria-disabled); a change while playing takes effect at once; remembered per score on this device
// after a reload (another score keeps its own); three staves: V R L; in Edit notes the toolbar's toggles stay on show
// (iPhone, where the toolbar is hidden: the edit bar has them, without adding a row), in step, and ▶ From here plays
// only the parts on.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5371/';
const SHOTS = process.env.SHOTS || '';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const send = (method, p, body) => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errs = [];
const DEVICES = [
  ['Mac', { width: 1440, height: 900 }],
  ['iPad', { width: 1032, height: 1376, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ['iPhone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
];
const stamp = Date.now().toString(36);

// four bars of quarter notes (divisions 1): RH C4…C5, LH C3/G2 half notes; voice part (when there) E5s
const RH = [[60, 64, 67, 64], [62, 65, 67, 71], [72, 71, 69, 67], [65, 64, 62, 60]];
const LH = [[48, 43], [43, 47], [45, 41], [41, 48]];
const NAMES = { 41: 'F2', 43: 'G2', 45: 'A2', 47: 'B2', 48: 'C3', 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4', 71: 'B4', 72: 'C5', 76: 'E5' };
const note = (m, d, staff, voice) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>${d}</duration><voice>${voice}</voice><type>${d === 2 ? 'half' : 'quarter'}</type>${staff ? `<staff>${staff}</staff>` : ''}</note>`;
const harm = (step) => `<harmony><root><root-step>${step}</root-step></root><kind>major</kind></harmony>`;
const attrs = (staves) => `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>${staves === 2 ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>'}</attributes>`;
const tempo = '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>200</per-minute></metronome></direction-type><sound tempo="200"/></direction>';
const pianoPart = (id, staves, chords) => `<part id="${id}">` + RH.map((bar, k) => `<measure number="${k + 1}">${k ? '' : attrs(staves) + tempo}`
  + (chords && k === 0 ? harm('C') : '') + (chords && k === 2 ? harm('F') : '') + bar.map((m) => note(m, 1, staves === 2 ? 1 : 0, 1)).join('')
  + (staves === 2 ? '<backup><duration>4</duration></backup>' + LH[k].map((m) => note(m, 2, 2, 5)).join('') : '')
  + (k === 1 ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : '') + '</measure>').join('') + '</part>';
const voicePart = (id) => `<part id="${id}">` + RH.map((_, k) => `<measure number="${k + 1}">${k ? '' : attrs(1)}${[76, 76, 76, 76].map((m) => note(m, 1, 0, 1)).join('')}${k === 1 ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : ''}</measure>`).join('') + '</part>';
const doc = (title, parts) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list>'
  + parts.map(([id, name]) => `<score-part id="${id}"><part-name>${name}</part-name></score-part>`).join('') + '</part-list>' + parts.map(([, , x]) => x).join('') + '</score-partwise>';

const one = await send('POST', '/items', { kind: 'score', title: `One staff ${stamp}`, artist: 'Test', musicxmlText: doc('One staff', [['P1', 'Piano', pianoPart('P1', 1, false)]]) });
const two = await send('POST', '/items', { kind: 'score', title: `Two hands ${stamp}`, artist: 'Test', musicxmlText: doc('Two hands', [['P1', 'Piano', pianoPart('P1', 2, true)]]) });
const two2 = await send('POST', '/items', { kind: 'score', title: `Two hands again ${stamp}`, artist: 'Test', musicxmlText: doc('Two hands again', [['P1', 'Piano', pianoPart('P1', 2, true)]]) });
const three = await send('POST', '/items', { kind: 'score', title: `Voice and piano ${stamp}`, artist: 'Test', musicxmlText: doc('Voice and piano', [['P1', 'Voice', voicePart('P1')], ['P2', 'Piano', pianoPart('P2', 2, false)]]) });

for (const [name, vp] of DEVICES) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const E = (f, ...a) => page.evaluate(f, ...a);
  const open = async (id) => { await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
  const staffSet = () => E(() => [...new Set(window.__score.player.heard.map((h) => h[2]))].sort().join());
  // the toggles as "label+" (on) / "label-" (off)
  const state = (sel = '#sc-hands') => E((s) => [...document.querySelectorAll(`${s} button`)].map((x) => x.textContent + (x.getAttribute('aria-pressed') === 'true' && x.classList.contains('on') ? '+' : '-')).join(), sel);
  const playAll = async () => { // fast, to the end
    await E(() => { window.__score.player.rate = 2; });
    await tap('#sc-play');
    for (let i = 0; i < 60 && !(await E(() => window.__score.player.playing)); i++) await sleep(100); // the piano loading
    for (let i = 0; i < 60 && (await E(() => window.__score.player.playing)); i++) await sleep(150);
  };
  const stop = async () => { await tap('#sc-stop'); await sleep(150); await tap('#sc-stop'); await sleep(150); };
  const fits = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await E((ids) => { try { localStorage.removeItem('meowsic-chordplay'); for (const id of ids) localStorage.removeItem(`meowsic-parts-${id}`); } catch {} }, [one.id, two.id, two2.id, three.id]);

  // one staff, no chord names: no toggles
  await open(one.id);
  check('one staff, no chords: no part toggles', (await E(() => !document.querySelector('#sc-hands .hands') && window.__score.staves.length === 1)));

  // two staves + chord names: R L C, no Both
  await open(two.id);
  check('two staves: toggles R, L, C; R and L on, C off; no Both', (await state()) === 'R+,L+,C-', await state());
  check('no "Both" button', !(await E(() => [...document.querySelectorAll('#sc-hands button')].some((x) => /both/i.test(x.textContent + x.getAttribute('aria-label') + (x.dataset.hand || ''))))));
  check('full names in aria-label and title', (await E(() => [...document.querySelectorAll('#sc-hands button')].map((x) => x.getAttribute('aria-label') + '|' + x.title.split(':')[0]).join())) === 'Right hand|Right hand,Left hand|Left hand,Chords|Chords');
  const look = await E(() => { const soft = getComputedStyle(document.documentElement).getPropertyValue('--acc-soft').trim(), d = document.createElement('div'); d.style.color = soft; document.body.append(d); const want = getComputedStyle(d).color; d.remove();
    const [r, , c] = document.querySelectorAll('#sc-hands button'); return { on: getComputedStyle(r).backgroundColor === want, off: getComputedStyle(c).backgroundColor !== want && +getComputedStyle(c).opacity < 1 }; });
  check('on = the --acc-soft fill; off = no fill, dimmed', look.on && look.off, JSON.stringify(look));
  check('it fits on the screen', await fits('#sc-hands .hands'));
  check('no sideways scroll', (await E(() => document.documentElement.scrollWidth)) <= vp.width);
  await playAll();
  check('R + L: notes from both staves, no chords (C off)', (await staffSet()) === '0,1' && (await E(() => window.__score.player.heardChords.length)) === 0, await staffSet());
  await stop();

  await tap('#sc-hands [data-staff="L"]');
  check('L off: R on alone, remembered for this score', (await state()) === 'R+,L-,C-' && (await E((id) => localStorage.getItem(`meowsic-parts-${id}`), two.id)) === '{"off":["L"],"chords":false}', await state());
  await playAll();
  const hr = await E(() => ({ s: [...new Set(window.__score.player.heard.map((h) => h[2]))].join(), n: window.__score.player.heard.length, played: window.__score.player.played.length }));
  check('R only: notes only from the top staff (both times through the repeat)', hr.s === '0' && hr.n === 24 && hr.played === 2, JSON.stringify(hr));
  check('the last one on (R) is marked so', await page.$eval('#sc-hands [data-staff="R"]', (e) => e.getAttribute('aria-disabled') === 'true'));
  await tap('#sc-hands [data-staff="R"]');
  check('tapping the last one on: it stays on', (await state()) === 'R+,L-,C-', await state());
  await stop();

  await tap('#sc-hands [data-staff="L"]'); await tap('#sc-hands [data-staff="R"]');
  check('L on, R off', (await state()) === 'R-,L+,C-', await state());
  await playAll();
  const hl = await E(() => ({ s: [...new Set(window.__score.player.heard.map((h) => h[2]))].join(), n: window.__score.player.heard.length }));
  check('L only: notes only from the bottom staff', hl.s === '1' && hl.n === 12, JSON.stringify(hl));
  await stop();

  await tap('#sc-hands [data-part="chords"]'); await tap('#sc-hands [data-staff="L"]');
  check('C on, L off: chords alone', (await state()) === 'R-,L-,C+', await state());
  await playAll();
  const hc = await E(() => ({ n: window.__score.player.heard.length, c: window.__score.player.heardChords.length }));
  check('chords alone: chord notes only, no melody / bass notes', hc.n === 0 && hc.c > 0, JSON.stringify(hc));
  await stop();
  await tap('#sc-hands [data-staff="R"]'); await tap('#sc-hands [data-staff="L"]');
  check('all three on together', (await state()) === 'R+,L+,C+', await state());
  await playAll();
  check('R + L + C: both staves and the chords', (await staffSet()) === '0,1' && (await E(() => window.__score.player.heardChords.length)) > 0);
  await stop();
  await tap('#sc-hands [data-part="chords"]');

  // while playing: at once
  await E(() => { window.__score.player.rate = 1; });
  await tap('#sc-play'); await sleep(500);
  await tap('#sc-hands [data-staff="L"]');
  const k0 = await E(() => window.__score.player.heard.length);
  await sleep(900);
  const after = await E((k) => window.__score.player.heard.slice(k).map((h) => h[2]), k0);
  check('L off while playing: from then on only the right hand', after.length > 0 && after.every((s) => s === 0), after.join());
  await tap('#sc-hands [data-staff="L"]'); await tap('#sc-hands [data-staff="R"]');
  const k1 = await E(() => window.__score.player.heard.length);
  await sleep(900);
  const after2 = await E((k) => window.__score.player.heard.slice(k).map((h) => h[2]), k1);
  check('…L on, R off: only the left hand', after2.length > 0 && after2.every((s) => s === 1), after2.join());
  await tap('#sc-hands [data-part="chords"]'); await sleep(600);
  check('…C on while playing: chords come in', (await E(() => window.__score.player.heardChords.length)) > 0);
  check('still playing', await E(() => window.__score.player.playing));
  await stop();

  // remembered after a reload, per score: another score starts all on (and C as last set on this device)
  await open(two.id);
  check('after a reload: still R off, L on, C on', (await state()) === 'R-,L+,C+' && (await E(() => [...window.__score.player.mute].join())) === '0' && (await E(() => window.__score.player.chordsOn)), await state());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-hands.png` });
  await open(two2.id);
  check('another score: its own choice — R and L on (C as last set here: on)', (await state()) === 'R+,L+,C+', await state());
  await tap('#sc-hands [data-part="chords"]');
  await open(two.id);
  check('…and the first score kept its own', (await state()) === 'R-,L+,C+', await state());
  await tap('#sc-hands [data-part="chords"]');

  // Edit notes: the same toggles, in step; ▶ From here plays the parts on only
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel #np-hands', { timeout: 8000 }); await sleep(600);
  // iPhone: the toolbar is hidden while editing, so the edit bar has the toggles; Mac / iPad: the toolbar's stay on show
  const phone = name === 'iPhone', ep = phone ? '#np-hands' : '#sc-hands';
  check(`Edit notes: one set on show (${phone ? 'in the edit bar' : 'on the toolbar'}), L on`, (await state(ep)) === 'R-,L+,C-' && (await E(() => [...document.querySelectorAll('#np-hands, #sc-hands .hands')].filter((e) => e.getBoundingClientRect().width > 0).length)) === 1, await state(ep));
  check('Edit notes: it fits', await fits(phone ? '#np-hands' : '#sc-hands .hands'));
  check('Edit notes: the edit bar is no taller for it (iPhone: three rows)', !phone || (await E(() => [...document.querySelector('.notes-panel .np-row').children].filter((k) => k.getBoundingClientRect().width > 0).map((k) => k.getBoundingClientRect().top).sort((x, y) => x - y).filter((t, i, ts) => !i || t - ts[i - 1] > 20).length)) <= 3);
  await tap(`${ep} [data-staff="R"]`); await tap(`${ep} [data-staff="L"]`);
  check('Edit notes: R on, L off → the other set follows', (await state('#np-hands')) === 'R+,L-,C-' && (await state('#sc-hands')) === 'R+,L-,C-', `${await state('#np-hands')} ${await state('#sc-hands')}`);
  await E(() => { window.__score.player.rate = 2; });
  await tap('.notes-panel [data-a="playhere"]');
  for (let i = 0; i < 60 && (await E(() => window.__score.player.playing)); i++) await sleep(150);
  check('Edit notes ▶ From here, R only: only the top staff', (await staffSet()) === '0', await staffSet());
  await tap(`${ep} [data-staff="L"]`); await tap(`${ep} [data-staff="R"]`);
  await tap('.notes-panel [data-a="playhere"]'); await sleep(700);
  const ke = await E(() => window.__score.player.heard.length);
  await tap(`${ep} [data-staff="R"]`); await sleep(700);
  const ae = await E((k) => [...new Set(window.__score.player.heard.slice(k).map((h) => h[2]))].sort().join(), ke);
  check('Edit notes: L, then R on too while playing', (await E((k) => window.__score.player.heard.slice(0, k).every((h) => h[2] === 1), ke)) && ae === '0,1', ae);
  await tap('.notes-panel [data-a="playhere"]'); await sleep(200);
  await tap('.notes-panel [data-a="close"]'); await sleep(500);

  // three staves (voice + piano, no chord names): V R L toggles, all on; the last one on stays on
  await open(three.id);
  check('voice + piano: a toggle per staff (V R L), all on, no C (no chord names)', (await state()) === 'V+,R+,L+', await state());
  check('voice + piano: full names', (await E(() => [...document.querySelectorAll('#sc-hands button')].map((x) => x.getAttribute('aria-label')).join())) === 'Vocal,Right hand,Left hand');
  check('voice + piano: it fits', await fits('#sc-hands .hands'));
  await tap('#sc-hands [data-staff="V"]'); await tap('#sc-hands [data-staff="L"]');
  await tap('#sc-hands [data-staff="R"]'); // the last one on: stays on
  check('V and L off; R (the last one on) stays on', (await state()) === 'V-,R+,L-', await state());
  await playAll();
  check('voice + piano, R only: notes only from the piano top staff', (await staffSet()) === '1', await staffSet());
  await stop();
  await tap('#sc-hands [data-staff="V"]');
  await playAll();
  check('V + R: the voice staff and the right hand', (await staffSet()) === '0,1', await staffSet());
  await stop();
  await tap('#sc-hands [data-staff="L"]');
  await playAll();
  check('V + R + L: every staff, on the piano (no voice audio)', (await staffSet()) === '0,1,2' && (await E(() => !window.__score.voice)), await staffSet());
  await stop();
  await page.close();
}

await b.close();
if (errs.length) { console.log('\nconsole errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(`\n${pass} passed, ${fail} failed${errs.length ? `, ${errs.length} console errors` : ''}`);
process.exit(fail || errs.length ? 1 : 0);
