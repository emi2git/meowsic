// Tempo (score toolbar − 96 +): against a test server (BASE, a temp data folder — never the real library). Per device
// (Mac, iPad Pro 13", iPhone): a made-up score at ♩ = 96 with a repeat over bars 1–2, and one with no tempo → the
// control shows the score's own tempo (96; no tempo: 100), fits, no tempo mark is drawn; Play schedules the quarter
// notes 60/96 s apart; + while playing → 100 at once (still playing, no notes twice, repeat order kept), hold + runs
// on, the A–B loop keeps looping at the new tempo; tap the number → type 150, Tap the beat, ↺ back to 96; the tempo
// is kept per score (the entry's rate, after a reload; the other score keeps its own); Edit notes' ▶ From here and the
// cue play at the same tempo; Voice: the sung audio is time-stretched (playbackRate, pitch kept) and follows it.
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

const MEL = [[60, 64, 67, 64], [62, 65, 67, 71], [72, 71, 69, 67], [65, 64, 62, 60]];
const NAMES = { 60: 'C4', 62: 'D4', 64: 'E4', 65: 'F4', 67: 'G4', 69: 'A4', 71: 'B4', 72: 'C5' };
const note = (m) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
const scoreXml = (title, bpm) => '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>' + title + '</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">'
  + MEL.map((bar, k) => `<measure number="${k + 1}">${k ? '' : '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' + (bpm ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : '')}`
    + bar.map(note).join('')
    + (k === 1 ? '<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>' : '') + '</measure>').join('') + '</part></score-partwise>';

// the gap (s) between consecutive scheduled quarter notes from index i on (the median, so a jump does not count)
const gapOf = (at, from = 0) => { const g = []; for (let i = from + 1; i < at.length; i++) { const d = (at[i][1] - at[i - 1][1]) / (at[i][0] - at[i - 1][0] || NaN); if (d > 0 && at[i][0] > at[i - 1][0]) g.push(d); } g.sort((x, y) => x - y); return g[Math.floor(g.length / 2)] || 0; };
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;

for (const [name, vp] of DEVICES) {
  console.log(`\n${name}`);
  const touch = !!vp.hasTouch;
  const sc = await send('POST', '/items', { kind: 'score', title: `Tempo tune ${name} ${stamp}`, artist: 'Test', musicxmlText: scoreXml('Tempo tune', 96) });
  const plain = await send('POST', '/items', { kind: 'score', title: `No tempo ${name} ${stamp}`, artist: 'Test', musicxmlText: scoreXml('No tempo', 0) });
  const page = await b.newPage(); await page.setViewport(vp);
  page.on('pageerror', (e) => errs.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/404|409|favicon/.test(m.text()) && errs.push(`${name}: ${m.text()}`));
  const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); await sleep(150); };
  const E = (f, ...a) => page.evaluate(f, ...a);
  const open = async (id) => { await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#osmd svg', { timeout: 15000 }); await sleep(600); };
  const bpm = () => page.$eval('#sc-rate', (e) => +e.textContent);
  const P = (f) => E(f);

  // the score's own tempo, never drawn
  await open(plain.id);
  check('no tempo in the file: 100', (await bpm()) === 100, String(await bpm()));
  await open(sc.id);
  check('the score\'s own tempo: 96, not tinted', (await bpm()) === 96 && !(await page.$eval('#sc-tempo', (e) => e.classList.contains('changed'))));
  const svgTxt = await page.$$eval('#osmd svg text', (e) => e.map((t) => t.textContent).join(' '));
  check('no tempo mark drawn on the score', !/=\s*96|\b96\b|bpm/i.test(svgTxt), svgTxt.slice(0, 120));
  const fit = await page.$eval('#sc-tempo', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; });
  check('the tempo control fits on the screen', fit.l >= 0 && fit.r <= vp.width && fit.t >= 0 && fit.b <= vp.height && fit.w < 170, JSON.stringify(fit));
  check('no sideways scroll', (await E(() => document.documentElement.scrollWidth)) <= vp.width);
  const over = await E(() => { const bs = [...document.querySelectorAll('.toolbar.inline > *, .toolbar.inline .transport > *, .toolbar.inline .tg-row > *')].filter((e) => e.offsetWidth).map((e) => e.getBoundingClientRect()); for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i], c = bs[j]; const contains = (a.left <= c.left && a.right >= c.right && a.top <= c.top && a.bottom >= c.bottom) || (c.left <= a.left && c.right >= a.right && c.top <= a.top && c.bottom >= a.bottom); if (!contains && a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) return true; } return false; });
  check('toolbar controls do not overlap', !over);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tempo-${name}.png` });

  // Play at 96: quarters 60/96 s apart
  await tap('#sc-play');
  for (let i = 0; i < 40 && !(await P(() => window.__score.player.playing)); i++) await sleep(100);
  await sleep(1500);
  let at = await P(() => window.__score.player.heardAt);
  check('Play at 96: notes 0.625 s apart', near(gapOf(at), 60 / 96), String(gapOf(at)));
  // + while playing: 100 at once, still playing
  const n0 = at.length;
  await tap('#sc-fast');
  check('+ → 100, tinted', (await bpm()) === 100 && (await page.$eval('#sc-tempo', (e) => e.classList.contains('changed'))));
  await sleep(1600);
  at = await P(() => window.__score.player.heardAt);
  check('…playing on at 100: notes 0.6 s apart from then on', (await P(() => window.__score.player.playing)) && near(gapOf(at, n0 + 1), 0.6), String(gapOf(at, n0 + 1)));
  const qs = at.map(([q]) => q); let dup = false; for (let i = 1; i < qs.length; i++) if (qs[i] === qs[i - 1]) dup = true;
  const tm = at.map(([, t]) => t); let back = false; for (let i = 1; i < tm.length; i++) if (tm[i] < tm[i - 1] - 1e-6) back = true;
  check('…no note twice, no time going back (no restart)', !dup && !back, JSON.stringify(at.slice(-8)));
  // the playhead keeps pace with the scheduled notes
  const ph = await P(() => { const p = window.__score.player, t = p.ctx.currentTime, last = p.heardAt.filter(([, x]) => x <= t).pop(); return { q: p.now(), last: last?.[0] }; });
  check('…the playhead keeps pace with the notes', ph.last != null && ph.q >= ph.last - 0.05 && ph.q < ph.last + 1.2, JSON.stringify(ph));
  // repeats: play it out fast-ish and check the order (bars 1 2 1 2 3 4)
  await tap('#sc-play'); await P(() => window.__score.stop()); await sleep(100);
  await P(() => window.__score.setTempo(240)); // fastest; the control follows on the next change
  await tap('#sc-play');
  for (let i = 0; i < 80 && !(await P(() => window.__score.player.playing)); i++) await sleep(100);
  await sleep(1200);
  await P(() => window.__score.setTempo(200)); // mid-way, through the repeat
  for (let i = 0; i < 80 && (await P(() => window.__score.player.playing)); i++) await sleep(200);
  at = await P(() => window.__score.player.heardAt);
  const seq = []; for (const [q] of at) { const bar = Math.floor(q / 4) + 1; if (seq.at(-1) !== bar) seq.push(bar); }
  check('repeats: bars 1 2 1 2 3 4 across a tempo change', seq.join(' ') === '1 2 1 2 3 4', seq.join(' '));
  check('…the last notes at 200 (0.3 s)', near(gapOf(at, at.length - 5), 0.3), String(gapOf(at, at.length - 5)));
  // A–B loop: keeps looping at the new tempo
  await P(() => { const p = window.__score.player; p.stop(); p.loop = [0, 4]; window.__score.setTempo(120); });
  await tap('#sc-play');
  for (let i = 0; i < 40 && !(await P(() => window.__score.player.playing)); i++) await sleep(100);
  await sleep(1200); await P(() => window.__score.setTempo(150)); await sleep(2500);
  at = await P(() => window.__score.player.heardAt);
  check('loop: stays in bar 1, at 150 after the change (0.4 s)', at.every(([q]) => q < 4) && at.length > 8 && near(gapOf(at, at.length - 4), 0.4), JSON.stringify(at.slice(-5).map(([q, t]) => [q, +t.toFixed(2)])));
  await P(() => { const p = window.__score.player; p.stop(); p.loop = null; window.__score.setTempo(100); });
  await sleep(300);

  // hold + : it keeps going
  const fb = await page.$eval('#sc-fast', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await P(() => window.__score.setTempo(100)); await tap('#sc-slow'); await tap('#sc-fast'); // the label follows
  const t0 = await bpm();
  if (touch) { await page.touchscreen.touchStart(fb.x, fb.y); await sleep(1100); await page.touchscreen.touchEnd(); }
  else { await page.mouse.move(fb.x, fb.y); await page.mouse.down(); await sleep(1100); await page.mouse.up(); }
  await sleep(200);
  const t1 = await bpm();
  check('hold +: keeps going (several steps of 5)', t1 - t0 >= 20 && t1 % 5 === 0, `${t0} → ${t1}`);
  await sleep(400); const t2 = await bpm();
  check('…and stops on release', t2 === t1, `${t1} → ${t2}`);

  // tap the number: the pop-up — type, Tap, reset
  await tap('#sc-rate');
  const pop = await page.$eval('.tempo-pop', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }).catch(() => null);
  check('tap the number: the tempo pop-up, on screen', pop && pop.l >= 0 && pop.r <= vp.width && pop.t >= 0 && pop.b <= vp.height, JSON.stringify(pop));
  await page.$eval('.tempo-pop input', (e) => { e.value = ''; });
  await page.type('.tempo-pop input', '150'); await page.keyboard.press('Enter'); await sleep(200);
  check('type 150 + Enter → 150, the pop-up closes', (await bpm()) === 150 && !(await page.$('.tempo-pop')));
  await tap('#sc-rate');
  await page.$eval('.tempo-pop input', (e) => { e.value = ''; });
  await page.type('.tempo-pop input', '999'); await page.keyboard.press('Enter'); await sleep(200);
  check('typed 999 → 240 (the most)', (await bpm()) === 240);
  await tap('#sc-rate');
  for (let i = 0; i < 5; i++) { await page.$eval('.tempo-pop [data-tap]', (e) => e.click()); await sleep(500); }
  const tapped = await bpm();
  check('Tap the beat every 0.5 s → about 120', tapped >= 110 && tapped <= 122, String(tapped));
  await page.$eval('.tempo-pop [data-reset]', (e) => e.click()); await sleep(150);
  check('↺ → the score\'s 96, not tinted', (await bpm()) === 96 && !(await page.$eval('#sc-tempo', (e) => e.classList.contains('changed'))));
  await page.keyboard.press('Escape'); await sleep(100);
  check('Escape closes the pop-up', !(await page.$('.tempo-pop')));

  // kept per score
  await tap('#sc-rate');
  await page.$eval('.tempo-pop input', (e) => { e.value = ''; });
  await page.type('.tempo-pop input', '120'); await page.keyboard.press('Enter');
  await sleep(900);
  const saved = (await api(`/items/${sc.id}`)).rate ?? (await api('/items')).items?.find?.((x) => x.id === sc.id)?.rate;
  check('saved on the entry (rate 120 / 96)', near(+saved, 1.25, 1e-6), String(saved));
  await open(sc.id);
  check('reload: 120', (await bpm()) === 120 && (await P(() => window.__score.player.rate)) === 1.25);
  await open(plain.id);
  check('the other score keeps its own (100)', (await bpm()) === 100);
  await open(sc.id);

  // Edit notes: ▶ From here plays at the same tempo
  await tap('#sc-edit');
  await page.waitForSelector('.notes-panel', { timeout: 8000 }); await sleep(600);
  const tb = await page.$eval('#sc-tempo', (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).catch(() => false);
  await P(() => window.__editNotes.select([])); await sleep(150);
  await P(() => window.__score.stop());
  await tap('.notes-panel [data-a="playhere"]');
  for (let i = 0; i < 40 && !(await P(() => window.__score.player.playing)); i++) await sleep(100);
  await sleep(1500);
  at = await P(() => window.__score.player.heardAt);
  check('Edit notes ▶ From here at 120 (0.5 s)', near(gapOf(at), 0.5), String(gapOf(at)));
  if (tb) { // the toolbar stays: change it while Edit notes plays
    const n1 = at.length; await tap('#sc-slow'); await sleep(1600);
    at = await P(() => window.__score.player.heardAt);
    check('…− while Edit notes plays → 115 at once', (await bpm()) === 115 && near(gapOf(at, n1 + 1), 60 / 115), String(gapOf(at, n1 + 1)));
  } else check('(toolbar hidden in Edit notes: the tempo still applies)', true);
  await tap('.notes-panel [data-a="playhere"]'); await sleep(200);
  await P(() => window.__editNotes.close()); await sleep(300);

  // Voice: the sung audio follows the tempo (time-stretched, pitch kept)
  const v = await E(async () => {
    const { VoicePlayer } = await import('/js/audio.js');
    const sr = 8000, n = sr * 20, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf); // 20 s of a quiet tone
    const s = (o, t) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
    d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); s(36, 'data'); d.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin(i / 10) * 2000, true);
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const vp = new VoicePlayer({ url, bpm: 96, beats: 4, endQ: 32 });
    await new Promise((ok) => { vp.el.addEventListener('canplay', ok, { once: true }); setTimeout(ok, 3000); });
    vp.setRate(120 / 96);
    await vp.play();
    const q0 = vp.now(), t0 = performance.now();
    await new Promise((ok) => setTimeout(ok, 1500));
    const qps = (vp.now() - q0) / ((performance.now() - t0) / 1000);
    const r = { rate: vp.el.playbackRate, pitch: vp.el.preservesPitch !== false, qps };
    vp.setRate(60 / 96); const q1 = vp.now(), t1 = performance.now();
    await new Promise((ok) => setTimeout(ok, 1500));
    r.qps2 = (vp.now() - q1) / ((performance.now() - t1) / 1000); r.rate2 = vp.el.playbackRate; r.playing = !vp.el.paused;
    vp.destroy();
    return r;
  });
  check('Voice at 120 (sung at 96): playbackRate 1.25, pitch kept', near(v.rate, 1.25, 1e-6) && v.pitch, JSON.stringify(v));
  check('…the playhead runs at 2 beats a second', near(v.qps, 2, 0.15), JSON.stringify(v));
  check('…changed while playing to 60: 1 beat a second, still playing', near(v.rate2, 0.625, 1e-6) && near(v.qps2, 1, 0.12) && v.playing, JSON.stringify(v));
  // and the view hands the tempo to the voice it makes
  check('the score view: setTempo reaches both players', await E(() => { const s = window.__score; s.setTempo(144); return Math.abs(s.player.rate - 1.5) < 1e-9 && s.tempo === 144; }));
  await E(() => window.__score.setTempo(96)); await sleep(700);
  await page.close();
}

check('no page errors', !errs.length, errs.join('\n'));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
