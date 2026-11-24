// Request singing voice + the score player's Voice toggle (server on $BASE, default :5244, temp data; the server runs with
// MEOWSIC_SING_PYTHON = a stand-in that "sings" a 12 s test tone, so no model is needed):
// ⋯ → Request singing voice → job → Voice button appears (on); Play plays the audio with the playhead in sync; tap on
// the music and dragging the line move the audio; Voice off/on swaps piano ↔ voice at the same spot; Stop goes back to the start; a tempo change
// goes back to the piano; it ends; the choice is remembered; iPhone: a tap on Play starts the audio.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5244/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p, o) => fetch(BASE + 'api' + p, o).then((r) => r.json());
const errs = [];
// every Audio the page makes is kept so the test can read its clock (not the piano's silent unlock clip: audio.js mediaUnlock)
const spy = () => { const A = window.Audio; window.__audios = []; window.Audio = function (...a) { const x = new A(...a); if (!new Error().stack.includes('mediaUnlock')) window.__audios.push(x); return x; }; };
const newPage = async (vp) => { const p = await b.newPage(); await p.setViewport(vp); await p.evaluateOnNewDocument(spy); p.on('pageerror', (e) => errs.push(e.message)); return p; };

const XML = `<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<direction><direction-type><words>Slowly</words></direction-type><sound tempo="72"/></direction>
<note><rest/><duration>4</duration><type>half</type></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><syllabic>begin</syllabic><text>A</text></lyric></note></measure>
<measure number="2"><harmony><root><root-step>G</root-step></root><kind>major</kind></harmony><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><syllabic>middle</syllabic><text>maz</text></lyric></note>
<note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><syllabic>end</syllabic><text>ing</text></lyric></note></measure>
<measure number="3"><note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><syllabic>single</syllabic><text>grace</text></lyric></note>
<note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><syllabic>single</syllabic><text>how</text></lyric></note></measure>
<measure number="4"><note><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><type>half</type><dot/><lyric number="1"><syllabic>single</syllabic><text>sweet</text></lyric></note></measure>
</part></score-partwise>`;
const it = await api('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'score', title: 'Voice Test', version: 'original', bpm: 72, musicxmlText: XML }) });
check('test score added', it.id?.startsWith('m-'), JSON.stringify(it));

const page = await newPage({ width: 1440, height: 900 });
await page.goto(`${BASE}#/item/${it.id}`, { waitUntil: 'networkidle0' }); await sleep(1500);
check('score renders', (await page.$$('#osmd svg')).length >= 1);
check('no Voice button before it sings', await page.$eval('#sc-voice', (e) => e.hidden));
await page.click('#it-more'); await sleep(200);
const menuItems = await page.$$eval('.menu button', (e) => e.map((x) => x.textContent.trim()));
check('⋯ has Request singing voice', menuItems.includes('Request singing voice'), menuItems.join('|'));
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Request singing voice').click()); await sleep(300);
check('asks first', !!(await page.$('.modal [data-ok]')));
await page.click('.modal [data-ok]'); await sleep(300);
let job;
for (let i = 0; i < 40; i++) { await sleep(500); job = (await api('/jobs')).find((j) => j.kind === 'sing' && j.title === 'Voice Test'); if (job && ['done', 'failed'].includes(job.status)) break; }
check('sing job finishes', job?.status === 'done', JSON.stringify(job?.log?.slice(-3)));
check('job log has the checks', /100(\.0)?% of 2 notes within 50 cents/.test(job?.log?.at(-1)?.msg || ''), job?.log?.at(-1)?.msg);
const got = await api(`/items/${it.id}`);
check('score has vocalAudio + vocalBpm', got.vocalAudio === `${got.folder} vocal.m4a` && got.vocalBpm === 72, JSON.stringify([got.vocalAudio, got.vocalBpm]));
let shown = false;
for (let i = 0; i < 20 && !shown; i++) { await sleep(300); shown = await page.$eval('#sc-voice', (e) => !e.hidden && e.classList.contains('on')); }
check('Voice button appears, on, without reloading', shown);
check('says it sings now', /It sings now/.test(await page.$eval('#toast', (e) => e.textContent)));

const audio = () => page.evaluate(() => { const a = window.__audios.at(-1); return a ? { t: a.currentTime, paused: a.paused, src: a.src, n: window.__audios.length } : null; });
const pos = () => page.evaluate(() => window.__score.player.now());
const qps = 72 / 60;
await page.click('#sc-play'); await sleep(1800);
let a = await audio(), q = await pos();
check('Play plays the sung audio', a && !a.paused && /\/api\/items\/.+\/vocal/.test(a.src) && a.t > 1, JSON.stringify(a));
check('button says Pause', (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Pause');
check('playhead follows the audio (q = t × bpm / 60)', Math.abs(q - a.t * qps) < 0.35, `${q} vs ${a.t * qps}`);
check('speed shows 100% with the voice (no bpm)', (await page.$eval('#sc-rate', (e) => e.textContent)) === '100%');

await page.evaluate(() => window.__score.seek(6)); await sleep(400);
a = await audio();
check('seek moves the audio (playing)', !a.paused && Math.abs(a.t - 6 / qps) < 0.6, JSON.stringify(a));
await page.click('#sc-play'); await sleep(200);
a = await audio();
check('Pause pauses the audio', a.paused);
// tap on the music: the line jumps there and so does the audio
const box = await page.$eval('#osmd svg', (s) => { const r = s.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const stops = await page.$$eval('.playbar', (e) => e.length);
const bar = await page.$eval('.playbar', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.click(box.x + box.w * 0.25, bar.y); await sleep(300);
q = await pos(); a = await audio();
check('tap on the music moves the audio to the line', stops === 1 && Math.abs(a.t * qps - q) < 0.3 && q < 6, `q=${q} t=${a.t}`);
// drag the line to the right
const b2 = await page.$eval('.playbar', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(b2.x, b2.y); await page.mouse.down(); await page.mouse.move(b2.x + 120, b2.y, { steps: 6 }); await page.mouse.up(); await sleep(300);
const q2 = await pos(); a = await audio();
check('dragging the line moves the audio', q2 > q && Math.abs(a.t * qps - q2) < 0.3, `q ${q}→${q2} t=${a.t}`);

// Voice off while playing: the piano carries on from the same spot; on again: the voice from there
await page.click('#sc-play'); await sleep(800);
const qa = await pos();
await page.click('#sc-voice'); await sleep(700);
a = await audio(); const qb = await pos();
check('Voice off: audio stops, piano keeps playing on', a.paused && qb > qa && (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Pause' && !(await page.$eval('#sc-voice', (e) => e.classList.contains('on'))), JSON.stringify({ qa, qb, a }));
await page.click('#sc-voice'); await sleep(600);
a = await audio(); const qc = await pos();
check('Voice on again: the audio plays from the same spot', !a.paused && qc >= qb && Math.abs(a.t * qps - qc) < 0.35, JSON.stringify({ qb, qc, a }));
// Stop (the square before Play): the voice stops and goes back to the beginning; Play starts it from there
await page.click('#sc-stop'); await sleep(300);
a = await audio();
check('Stop: voice stops, back to the beginning', a.paused && a.t < 0.05 && (await pos()) === 0 && (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Play', JSON.stringify(a));
await page.click('#sc-play'); await sleep(900);
a = await audio();
check('Play after Stop: the voice from the start', !a.paused && a.t > 0.3 && a.t < 2, JSON.stringify(a));
// a tempo change goes back to the piano
await page.click('#sc-fast'); await sleep(300);
a = await audio();
check('tempo + turns Voice off (piano at the new tempo)', a.paused && !(await page.$eval('#sc-voice', (e) => e.classList.contains('on'))) && (await page.$eval('#sc-rate', (e) => e.textContent)) === '105%', await page.$eval('#sc-rate', (e) => e.textContent));
check('…and says why', /back to the piano/.test(await page.$eval('#toast', (e) => e.textContent)));
await page.click('#sc-play'); await sleep(200);
await page.click('#sc-slow'); await sleep(100);

// remembered per score: reload → off; turn on, play to the end
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1500);
check('reload: Voice stays off (remembered)', !(await page.$eval('#sc-voice', (e) => e.classList.contains('on') || e.hidden)));
await page.click('#sc-voice'); await sleep(200);
await page.evaluate(() => window.__score.seek(11)); await sleep(200);
await page.click('#sc-play');
let ended = false;
for (let i = 0; i < 30 && !ended; i++) { await sleep(250); ended = (await page.$eval('#sc-play', (e) => e.getAttribute('aria-label'))) === 'Play'; }
check('the end: button back to Play', ended);
const r = await fetch(`${BASE}api/items/${it.id}/vocal`, { headers: { Range: 'bytes=0-99' } });
check('vocal endpoint serves ranges (Safari)', r.status === 206 && r.headers.get('content-type') === 'audio/mp4' && (await r.arrayBuffer()).byteLength === 100, String(r.status));
await page.screenshot({ path: 'voice.png' });

// Add → Score lists the job with its own stages
await page.goto(`${BASE}#/jobs`, { waitUntil: 'networkidle0' }); await sleep(600);
const jl = await page.$$eval('section.job', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ')).find((t) => t.includes('Voice Test')) || '');
check('jobs list: sing stages + its result line', ['Read the score', 'Load the voice', 'Sing', 'Piano and mix', 'Check'].every((s) => jl.includes(s)) && /within 50 cents/.test(jl) && !jl.includes('Download audio'), jl);
// Activities: "Made … sing" → Undo = no voice again (the take stays in .history)
await page.goto(`${BASE}#/activities`, { waitUntil: 'networkidle0' }); await sleep(800);
const row = await page.evaluate(() => { const r = [...document.querySelectorAll('#ac tr.ac-row')].find((x) => x.querySelector('.ac-title')?.textContent === 'Made “Voice Test” sing'); return r && { id: r.dataset.id, btn: r.querySelector('[data-act]')?.textContent || '' }; });
check('Activities: "Made … sing" row with Undo', row?.btn === 'Undo', JSON.stringify(row));
if (row) {
  await page.click(`#ac [data-act][data-id="${row.id}"]`); await sleep(250);
  const sh = await page.$eval('.modal', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  check('confirm says what goes back', /no sung voice/.test(sh), sh);
  await page.click('.modal [data-ok]'); await sleep(800);
  check('undone: the score has no voice', (await api(`/items/${it.id}`)).vocalAudio === null);
  await page.goto(`${BASE}#/item/${it.id}`, { waitUntil: 'networkidle0' }); await sleep(1500);
  check('…and the Voice button is gone', await page.$eval('#sc-voice', (e) => e.hidden));
  // sing again so the iPhone part has audio
  const j2 = await api('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'sing', title: 'Voice Test', fromItemId: it.id }) });
  for (let i = 0; i < 40; i++) { await sleep(400); if ((await api(`/jobs/${j2.id}`)).status === 'done') break; }
}

// iPhone: a tap on Play starts the audio
const ph = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ph.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
await ph.evaluateOnNewDocument((id) => { try { localStorage.setItem(`meowsic-voice-${id}`, '1'); } catch {} }, it.id);
await ph.goto(`${BASE}#/item/${it.id}`, { waitUntil: 'networkidle0' }); await sleep(1800);
check('iPhone: Voice button shown and on', await ph.$eval('#sc-voice', (e) => !e.hidden && e.classList.contains('on')));
await ph.tap('#sc-play'); await sleep(1500);
const pa = await ph.evaluate(() => { const x = window.__audios.at(-1); return x && { t: x.currentTime, paused: x.paused }; });
check('iPhone: tap Play → the voice plays', pa && !pa.paused && pa.t > 0.5, JSON.stringify(pa));
await ph.screenshot({ path: 'voice-iphone.png' });
await ph.tap('#sc-play');

check('no page errors', !errs.length, errs.join(' | '));
await b.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
