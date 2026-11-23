// "Super easy piano" score look (server on $BASE with an AI Studio piece that has chord symbols, e.g. the
// G-major lead sheet with G C D7 added by ~/git/scripts/meowsic-add-ai-score.py): letter in every notehead,
// keyboard chord diagrams in order, transpose updates both, the ⋯ toggle removes them, playback still works.
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5215/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const api = (p) => fetch(BASE + 'api' + p).then((r) => r.json());

const items = await api('/items');
const ais = items.filter((x) => (x.ai || /^meowsic ai$/i.test(String(x.source || '').trim())) && !x.deleted);
const ai = ais.find((x) => /sunshine/i.test(x.title)) || ais[0];
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
    kbds: [...document.querySelectorAll('.easy-kbds .kbd')].map((k) => ({ chord: k.dataset.chord, notes: k.dataset.notes, grey: k.querySelectorAll('rect[fill="#b4b4b4"], rect[fill="#9a9a9a"]').length })),
    title: document.querySelector('.easy-title')?.textContent, credit: document.querySelector('.easy-credit')?.textContent,
    osmdTitle: [...document.querySelectorAll('#osmd svg text')].some((t) => t.textContent === document.querySelector('.easy-title')?.textContent),
  };
});
const norm = (c) => c.replace(/♯/g, '#').replace(/♭/g, 'b');

await page.goto(`${BASE}#/library`, { waitUntil: 'networkidle0' });
await page.evaluate((id) => { localStorage.removeItem(`meowsic-easy-${id}`); }, ai.id);
await page.goto(`${BASE}#/item/${ai.id}`, { waitUntil: 'networkidle0' }); await sleep(2500);
let s = await state();
check('AI piece: easy look is on by default', s.letters.length > 0 && !!s.title);
check('a letter on every notehead (rests none)', s.letters.length === want.steps.length && s.heads === s.letters.length && s.allHeads === s.letters.length + want.rests, `${s.letters.length} letters, ${s.heads}/${s.allHeads} heads, ${want.steps.length} notes`);
check('each letter is the note\'s pitch letter', s.letters.join('') === want.steps.join(''), `${s.letters.join('')} vs ${want.steps.join('')}`);
check('each letter sits inside its notehead', s.inside);
check('white letters on filled heads, black on open', s.fills.includes('#fff') && s.fills.includes('#000'), s.fills.join(','));
check('letters readable at default zoom (>= 9px)', s.minSize >= 9, String(s.minSize));
check('title on top, OSMD title hidden', s.title === ai.title && !s.osmdTitle, `${s.title} ${s.osmdTitle}`);
check('credit is the MusicXML creator', s.credit === 'Meowsic AI', s.credit);
check('one keyboard per chord, in order of first appearance', s.kbds.map((k) => norm(k.chord)).join(',') === want.chords.join(','), s.kbds.map((k) => k.chord).join(','));
check('shaded keys = notes listed', s.kbds.every((k) => k.grey === k.notes.split(' ').length && k.grey >= 3), JSON.stringify(s.kbds));
const kn = Object.fromEntries(s.kbds.map((k) => [norm(k.chord), k.notes]));
if (kn.G) check('G = D G B', kn.G === 'D G B', kn.G);
if (kn.D7) check('D7 = D F♯ A C', kn.D7 === 'D F♯ A C', kn.D7);
if (kn.C) check('C = C E G', kn.C === 'C E G', kn.C);

// transpose up a whole step: every letter moves one letter up, chords and diagrams follow
const up = (L) => 'CDEFGAB'['CDEFGAB'.indexOf(L) + 1] || 'C';
const shift = (c) => { const m = c.match(/^([A-G])(#|b)?(.*)$/); const sharpOf = { 'E': 'F#', 'B': 'C#' }; const r = m[1] + (m[2] || ''); const map = { C: 'D', D: 'E', E: 'F#', F: 'G', G: 'A', A: 'B', B: 'C#', 'F#': 'G#', 'C#': 'D#', Bb: 'C', Eb: 'F', Ab: 'Bb' }; return (map[r] || sharpOf[r] || r) + m[3]; };
await page.click('#sc-tup'); await sleep(1200); await page.click('#sc-tup'); await sleep(2000);
s = await state();
check('transpose +2: letters move up one letter', s.letters.join('') === want.steps.map(up).join(''), `${s.letters.join('')} vs ${want.steps.map(up).join('')}`);
check('transpose +2: still a letter on every notehead', s.heads === s.letters.length && s.allHeads === s.heads + want.rests && s.inside);
check('transpose +2: diagrams follow', s.kbds.map((k) => norm(k.chord)).join(',') === want.chords.map(shift).join(','), s.kbds.map((k) => k.chord).join(','));
const kt = Object.fromEntries(s.kbds.map((k) => [norm(k.chord), k.notes]));
if (kt.A) check('A = C♯ E A', kt.A === 'C♯ E A', kt.A);
if (kt.E7) check('E7 = D E G♯ B or E G♯ B D', ['E G♯ B D'].includes(kt.E7), kt.E7);
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
const menuItem = async () => { await page.click('#it-more'); await sleep(300); return page.$$eval('.menu button', (bs) => bs.map((x) => ({ t: x.textContent, c: x.getAttribute('aria-checked') }))).then((l) => l.find((x) => x.t.startsWith('Note names in noteheads'))); };
let mi = await menuItem();
check('⋯ menu has "Note names in noteheads", checked', mi && mi.c === 'true', JSON.stringify(mi));
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.startsWith('Note names in noteheads')).click()); await sleep(2000);
s = await state();
check('toggle off: no letters, no header', s.letters.length === 0 && !s.title && s.kbds.length === 0);
check('toggle off: OSMD title back', s.osmdTitle || (await page.$$eval('#osmd svg text', (t) => t.some((x) => x.textContent.includes('Sunshine') || x.textContent.length > 3))));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(2500);
s = await state();
check('off is remembered for this item', s.letters.length === 0);
mi = await menuItem();
check('menu shows it unchecked', mi && mi.c === 'false', JSON.stringify(mi));
await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.startsWith('Note names in noteheads')).click()); await sleep(2000);
s = await state();
check('toggle on again: letters back', s.letters.length === want.steps.length);
await page.screenshot({ path: 'easyscore.png' });

// print: the same look on the A4 page
await page.goto(`${BASE}#/print?item=${ai.id}`, { waitUntil: 'networkidle0' }); await sleep(5000);
const pr = await page.evaluate(() => ({ letters: [...document.querySelectorAll('#print-root text.nl')].map((t) => t.textContent).join(''), kbds: [...document.querySelectorAll('#print-root g.kbd')].map((k) => k.dataset.chord), credit: document.querySelector('#print-root text.easy-credit')?.textContent }));
check('print: letters in every notehead', pr.letters === want.steps.join(''), pr.letters);
check('print: keyboard diagrams + credit', pr.kbds.map(norm).join(',') === want.chords.join(',') && pr.credit === 'Meowsic AI', JSON.stringify(pr));

// another (non-AI) score: off by default, the toggle turns it on
if (plain) {
  await page.evaluate((id) => localStorage.removeItem(`meowsic-easy-${id}`), plain.id);
  await page.goto(`${BASE}#/item/${plain.id}`, { waitUntil: 'networkidle0' }); await sleep(3000);
  s = await state();
  check('other score: off by default', s.letters.length === 0 && !s.title);
  await menuItem();
  await page.evaluate(() => [...document.querySelectorAll('.menu button')].find((x) => x.textContent.startsWith('Note names in noteheads')).click()); await sleep(3000);
  s = await state();
  check('other score: toggle on draws letters on every notehead', s.letters.length > 0 && s.heads === s.letters.length, `${s.letters.length} / ${s.heads} / ${s.allHeads}`);
  await page.screenshot({ path: 'easyscore-other.png' });
  await page.evaluate((id) => localStorage.removeItem(`meowsic-easy-${id}`), plain.id);
}

const def = await page.evaluate(async () => { const m = await import('/js/easyscore.js'); return [m.easyOn({ id: 'x-src', source: 'Meowsic AI' }), m.easyOn({ id: 'x-ai', ai: 1 }), m.easyOn({ id: 'x-no', source: 'Transcribed' })]; });
check('on by default for source "Meowsic AI" or ai: 1, off otherwise', def.join() === 'true,true,false', def.join());
check('no page errors', !errs.length, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
