// Note names (server on $BASE with an AI piece that has chord symbols, e.g. a lead sheet added by
// meowsic-add-ai-score.py): every score, AI ones included, opens in OSMD's classic look
// (title, the real composer + "… by Meowsic", tempo as OSMD draws them); the kids button (baby icon) / ⋯ toggle draws big
// noteheads with the note's letter inside — no chord diagrams (those are the chords button's); the text
// stays the same; transpose updates the letters; remembered on this device; playback still works.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5215/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());

const items = await api('/items');
const ais = items.filter((x) => (x.ai || /^meowsic( ai)?$/i.test(String(x.source || '').trim())) && !x.deleted);
let ai = ais.find((x) => /sunshine/i.test(x.title));
for (const x of ais) { if (ai) break; if (/<harmony[\s>]/.test(await fetch(`${BASE}api/items/${x.id}/musicxml`).then((r) => r.text()))) ai = x; }
check('server has an AI Studio piece', !!ai, JSON.stringify(items.map((x) => [x.title, x.ai])));
const xml = await fetch(`${BASE}api/items/${ai.id}/musicxml`).then((r) => r.text());
const plain = items.find((x) => x.kind === 'score' && !ais.includes(x) && !x.deleted);

// what the MusicXML says: the step of every sounding note (tie continuations included), chords in order
const want = await page.evaluate((text) => {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  const steps = [...d.querySelectorAll('part:first-of-type note')].filter((n) => n.querySelector('pitch') && !n.querySelector('rest')).map((n) => n.querySelector('pitch > step').textContent);
  const KIND = { major: '', minor: 'm', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7' };
  const chords = [];
  for (const h of d.querySelectorAll('harmony')) {
    const alt = +(h.querySelector('root-alter')?.textContent || 0);
    const n = h.querySelector('root-step').textContent + (alt > 0 ? '#' : alt < 0 ? 'b' : '') + (KIND[h.querySelector('kind').textContent] ?? '');
    if (!chords.includes(n)) chords.push(n);
  }
  const rests = [...d.querySelectorAll('part:first-of-type note')].filter((n) => n.querySelector('rest')).length;
  return { steps, chords, rests };
}, xml);
check('test piece has chords and notes', want.steps.length > 8 && want.chords.length >= 2, JSON.stringify(want));

const state = () => page.evaluate(() => {
  const texts = [...document.querySelectorAll('#osmd text.nl')];
  const heads = [...document.querySelectorAll('#osmd .vf-notehead[data-nl]')];
  // every letter sits inside its notehead
  const inside = texts.every((t) => {
    const r = t.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return heads.some((h) => { const q = h.getBoundingClientRect(); return cx > q.left - 2 && cx < q.right + 2 && cy > q.top - 2 && cy < q.bottom + 2 && h.dataset.nl === t.textContent; });
  });
  const fills = texts.map((t) => t.getAttribute('fill'));
  const sizes = texts.map((t) => t.getBoundingClientRect().height);
  return {
    letters: texts.map((t) => t.textContent), heads: heads.length, allHeads: document.querySelectorAll('#osmd .vf-stavenote .vf-notehead').length, inside, fills, minSize: Math.min(...sizes),
    kbds: [...document.querySelectorAll('#osmd g.kbd')].map((k) => ({ chord: k.dataset.chord, notes: k.dataset.notes, grey: k.querySelectorAll('rect[fill="#b4b4b4"], rect[fill="#9a9a9a"]').length })),
    texts: [...document.querySelectorAll('#osmd svg text:not(.nl)')].filter((t) => !t.closest('g.kbd')).map((t) => ({ t: t.textContent, f: t.getAttribute('font-family') || '' })),
    grown: [...document.querySelectorAll('#osmd .vf-notehead[data-nl]')].filter((h) => /scale/.test(h.getAttribute('transform') || '')).length,
    headH: Math.min(...[...document.querySelectorAll('#osmd .vf-notehead')].map((h) => h.getBoundingClientRect().height)),
    btn: document.querySelector('#sc-names')?.classList.contains('on'),
  };
});
const norm = (c) => c.replace(/♯/g, '#').replace(/♭/g, 'b');

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.removeItem('meowsic-kids'); localStorage.removeItem('meowsic-chords'); });
await page.goto(`${BASE}#/item/${ai.id}`, { waitUntil: 'networkidle0' }); await sleep(2500);
let s = await state();
check('AI piece: classic look by default (no letters, no diagrams, kids off)', s.letters.length === 0 && s.kbds.length === 0 && s.btn === false, JSON.stringify({ l: s.letters.length, k: s.kbds.length, b: s.btn }));
check('classic: OSMD draws the title and "… by Meowsic", serif text', s.texts.some((t) => t.t === ai.title) && s.texts.some((t) => /^(Made|Arranged|Transcribed|Read) by Meowsic$/.test(t.t)) && !s.texts.some((t) => /Helvetica/.test(t.f)), JSON.stringify(s.texts.slice(0, 4)));
check('classic: default zoom 100%', (await page.$eval('#sc-zreset', (e) => e.textContent)) === '100%');
const classicTexts = s.texts.map((t) => t.t + '|' + t.f).join();
await page.click('#sc-names'); await sleep(2500);
s = await state();
check('kids button lights up', s.btn === true);
check('a letter on every notehead (rests none)', s.letters.length === want.steps.length && s.heads === s.letters.length && s.allHeads === s.letters.length + want.rests, `${s.letters.length} letters, ${s.heads}/${s.allHeads} heads, ${want.steps.length} notes`);
check('each letter is the note\'s pitch letter', s.letters.join('') === want.steps.join(''), `${s.letters.join('')} vs ${want.steps.join('')}`);
check('each letter sits inside its notehead', s.inside);
check('white letters on filled heads, black on open', s.fills.includes('#fff') && s.fills.includes('#000'), s.fills.join(','));
check('noteheads are big (scaled up)', s.grown >= s.letters.length * 0.6, `${s.grown}/${s.letters.length}`);
check('letters fill the big heads (>= 75% of their height)', s.minSize >= s.headH * 0.75, `${s.minSize} vs ${s.headH}`);
check('same title, composer, tempo, chord and lyric text and fonts (bar numbers aside: the lines break elsewhere)', s.texts.filter((t) => !/^\d+$/.test(t.t)).map((t) => t.t + '|' + t.f).sort().join() === classicTexts.split(',').filter((x) => !/^\d+\|/.test(x)).sort().join());
check('no keyboard chord diagrams in the score', s.kbds.length === 0, JSON.stringify(s.kbds));

// transpose up a whole step: every letter moves one letter up, chords and diagrams follow
const up = (L) => 'CDEFGAB'['CDEFGAB'.indexOf(L) + 1] || 'C';
const shift = (c) => { const m = c.match(/^([A-G])(#|b)?(.*)$/); const sharpOf = { 'E': 'F#', 'B': 'C#' }; const r = m[1] + (m[2] || ''); const map = { C: 'D', D: 'E', E: 'F#', F: 'G', G: 'A', A: 'B', B: 'C#', 'F#': 'G#', 'C#': 'D#', Bb: 'C', Eb: 'F', Ab: 'Bb' }; return (map[r] || sharpOf[r] || r) + m[3]; };
await page.click('#sc-tup'); await sleep(1200); await page.click('#sc-tup'); await sleep(2000);
s = await state();
check('transpose +2: letters move up one letter', s.letters.join('') === want.steps.map(up).join(''), `${s.letters.join('')} vs ${want.steps.map(up).join('')}`);
check('transpose +2: still a letter on every notehead', s.heads === s.letters.length && s.allHeads === s.heads + want.rests && s.inside);
await page.screenshot({ path: 'easyscore-transposed.png' });
await page.click('#sc-tdown'); await sleep(1200); await page.click('#sc-tdown'); await sleep(2000);
s = await state();
check('back to 0: original letters', s.letters.join('') === want.steps.join(''));

// zoom re-draws them
await page.click('#sc-zin'); await sleep(1500);
s = await state();
check('zoom in: letters redrawn on every notehead', s.letters.length === want.steps.length && s.inside);
await page.click('#sc-zreset'); await sleep(1200);

// playback still works with the letters on
await page.click('#sc-play'); await sleep(2500);
const pos = +(await page.$eval('#sc-pos', (e) => e.value));
check('Play moves the playhead', pos > 0.3, String(pos));
await page.click('#sc-play'); await sleep(300);

// ⋯ menu toggle
const menuItem = async () => { await page.click('#it-more'); await sleep(300); await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.trim() === 'Info').click()); await sleep(300); return page.$$eval('.info-actions button', (bs) => bs.map((x) => ({ t: x.textContent, c: x.getAttribute('aria-checked') }))).then((l) => l.find((x) => x.t.startsWith('Kids note names'))); };
let mi = await menuItem();
check('⋯ menu has "Kids note names", checked', mi && mi.c === 'true', JSON.stringify(mi));
await page.evaluate(() => [...document.querySelectorAll('.info-actions button')].find((x) => x.textContent.startsWith('Kids note names')).click()); await sleep(2000);
s = await state();
check('toggle off: no letters, button off', s.letters.length === 0 && s.kbds.length === 0 && s.btn === false);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(2500);
s = await state();
check('off is remembered on this device', s.letters.length === 0);
mi = await menuItem();
check('menu shows it unchecked', mi && mi.c === 'false', JSON.stringify(mi));
await page.evaluate(() => [...document.querySelectorAll('.info-actions button')].find((x) => x.textContent.startsWith('Kids note names')).click()); await sleep(2000);
s = await state();
check('toggle on again: letters back', s.letters.length === want.steps.length);
await page.screenshot({ path: 'easyscore.png' });

// print: the same look on the A4 page
await page.goto(`${BASE}#/print?item=${ai.id}`, { waitUntil: 'networkidle0' }); await sleep(5000);
const pr = await page.evaluate(() => ({ letters: [...document.querySelectorAll('#print-root text.nl')].map((t) => t.textContent).join(''), kbds: [...document.querySelectorAll('#print-root g.kbd')].map((k) => k.dataset.chord), credit: [...document.querySelectorAll('#print-root svg text')].some((t) => /^(Made|Arranged|Transcribed|Read) by Meowsic$/.test(t.textContent)), sans: [...document.querySelectorAll('#print-root svg text:not(.nl)')].some((t) => /Helvetica/.test(t.getAttribute('font-family') || '') && !t.closest('g.kbd')) }));
check('print: letters in every notehead', pr.letters === want.steps.join(''), pr.letters);
check('print: no keyboard diagrams; OSMD "… by Meowsic", classic fonts', pr.kbds.length === 0 && pr.credit && !pr.sans, JSON.stringify(pr));

// another (non-AI) score: off by default, the toggle turns it on
if (plain) {
  await page.evaluate(() => localStorage.removeItem('meowsic-kids'));
  await page.goto(`${BASE}#/item/${plain.id}`, { waitUntil: 'networkidle0' }); await sleep(3000);
  s = await state();
  check('other score: off by default', s.letters.length === 0 && s.kbds.length === 0);
  await page.click('#sc-names'); await sleep(3000);
  s = await state();
  check('other score: toggle on draws letters on every notehead', s.letters.length > 0 && s.heads === s.letters.length, `${s.letters.length} / ${s.heads} / ${s.allHeads}`);
  await page.screenshot({ path: 'easyscore-other.png' });
  await page.evaluate(() => localStorage.removeItem('meowsic-kids'));
}

const def = await page.evaluate(async () => { localStorage.removeItem('meowsic-kids'); const m = await import('/js/easyscore.js'); return [m.easyOn({ id: 'x-src', source: 'Meowsic' }), m.easyOn({ id: 'x-ai', ai: 1 }), m.easyOn({ id: 'x-no', source: 'Transcribed' })]; });
check('off by default for every score (AI ones too)', def.join() === 'false,false,false', def.join());
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
