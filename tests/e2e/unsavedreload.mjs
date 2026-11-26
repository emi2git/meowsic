// The stale-shell auto-reload (js/update.js) never throws away unsaved work: while an editor on screen holds
// changes (Edit notes, or anything marked data-unsaved="1" via ui.js unsaved()), coming back to the app after a
// deploy shows the "New version — Reload" pill instead, and the reload goes only once the editor is closed / saved.
// Against a test server (BASE, a temp data folder — never the real library). A new shell is faked: /api/health is
// answered with another shell name while window.__fakeShell is set (gone again after the reload).
//   - Simple piano open: no reload, pill; closing it → the reload goes
//   - Info popup with a typed title (a sheet with a typed field): no reload; Cancel → reload
//   - Feedback page with text typed: no reload; text cleared → reload
//   - nothing open: the reload goes at once (the control)
//   BASE=http://127.0.0.1:5341/ node unsavedreload.mjs
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:5341/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(c ? '  ok  ' : '  FAIL', n, c ? '' : x); };
const send = (method, p, body) => fetch(BASE + 'api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const errs = [];

// a small two-staff piano score with rests (Simple piano has something to smooth)
const NAMES = { 43: ['G', 2], 48: ['C', 3], 60: ['C', 4], 62: ['D', 4], 64: ['E', 4], 67: ['G', 4] };
const note = (m, d, staff, type) => `<note><pitch><step>${NAMES[m][0]}</step><octave>${NAMES[m][1]}</octave></pitch><duration>${d}</duration><voice>${staff === 1 ? 1 : 5}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const rest = (d, staff, type) => `<note><rest/><duration>${d}</duration><voice>${staff === 1 ? 1 : 5}</voice><type>${type}</type><staff>${staff}</staff></note>`;
const attrs = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>';
const bar = (k) => `<measure number="${k}">${k === 1 ? attrs : ''}${note(60, 1, 1, 'eighth')}${rest(1, 1, 'eighth')}${note(64, 2, 1, 'quarter')}${note(67, 1, 1, 'eighth')}${rest(1, 1, 'eighth')}${note(62, 2, 1, 'quarter')}`
  + `<backup><duration>8</duration></backup>${note(48, 4, 2, 'half')}${note(43, 4, 2, 'half')}</measure>`;
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>Unsaved reload</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
  + `<part id="P1">${[1, 2, 3, 4].map(bar).join('')}</part></score-partwise>`;

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
try {
  const it = await send('POST', '/items', { kind: 'score', title: `Unsaved reload ${Date.now().toString(36)}`, artist: 'Test', musicxmlText: XML });
  check('a test score is made', !!it?.id, JSON.stringify(it).slice(0, 200));
  const page = await b.newPage(); await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errs.push(e.message));
  let navs = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  await page.evaluateOnNewDocument(() => {
    const f = window.fetch;
    window.fetch = async (u, o) => {
      if (window.__fakeShell && String(u).includes('/api/health')) { const h = await (await f(u, o)).json(); return new Response(JSON.stringify({ ...h, shell: window.__fakeShell }), { headers: { 'Content-Type': 'application/json' } }); }
      return f(u, o);
    };
  });
  const ev = async (fn, ...a) => { for (let i = 0; i < 40; i++) { try { return await page.evaluate(fn, ...a); } catch { await sleep(250); } } return undefined; };
  const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(fn)) return true; await sleep(200); } return false; };
  let n = 0;
  // a deploy happened (a new shell) and the app comes back to the foreground
  const deployAndReturn = async () => {
    navs = 0;
    await ev((s) => { window.__fakeShell = s; document.getElementById('update-pill')?.remove(); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); }, `meowsic-shell-v${90000 + ++n}`);
    await sleep(3500);
  };
  const pill = () => ev(() => !!document.getElementById('update-pill'));
  const reloadedSoon = async () => { const t = Date.now(); while (Date.now() - t < 6000 && navs === 0) await sleep(200); await sleep(800); return navs; };
  const open = async (hash) => { await page.goto(BASE + hash, { waitUntil: 'networkidle0' }); await until(() => !!window.__meowsicBuild?.shell, 8000); await sleep(800); };

  // ---- the control: nothing open → the reload goes at once ----
  await open('#/');
  await deployAndReturn();
  check('nothing open: back in view after a deploy, the page reloads', navs >= 1, `navigations: ${navs}`);

  // ---- Simple piano ----
  await open(`#/item/${encodeURIComponent(it.id)}`);
  await until(() => !!document.querySelector('#sc-simple'), 15000);
  await page.click('#sc-simple');
  const spOpen = await until(() => !!document.querySelector('.sp-panel') && document.querySelector('#sp-count')?.textContent !== 'Working…', 15000);
  check('Simple piano opens', spOpen);
  check('Simple piano marks itself unsaved (data-unsaved)', await ev(() => document.querySelector('.sp-panel')?.dataset.unsaved === '1'));
  await ev(() => { const r = document.querySelector('#sp-level'); r.value = 80; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(1200);
  await deployAndReturn();
  check('Simple piano open: no reload', navs === 0, `navigations: ${navs}`);
  check('Simple piano open: the "New version — Reload" pill shows', await pill());
  check('Simple piano is still open with its setting', await ev(() => !!document.querySelector('.sp-panel') && document.querySelector('#sp-level')?.value === '80'));
  await sleep(2500);
  check('…still no reload a while later', navs === 0, `navigations: ${navs}`);
  await ev(() => document.querySelector('.sp-panel [data-a="cancel"]').click());
  check('Simple piano closed: the waiting reload goes', (await reloadedSoon()) >= 1, `navigations: ${navs}`);

  // ---- Info popup (a sheet with a typed field) ----
  await open(`#/item/${encodeURIComponent(it.id)}`);
  await ev((id) => import('/js/views/info.js').then((m) => m.openInfo(id)), it.id);
  await until(() => !!document.querySelector('#if-title'), 5000);
  await page.click('#if-title', { clickCount: 3 }); await page.keyboard.type('A new title');
  check('Info: typing marks the popup unsaved', await ev(() => document.querySelector('#it-info')?.closest('.modal-wrap')?.dataset.unsaved === '1'));
  await deployAndReturn();
  check('Info with a typed title: no reload', navs === 0, `navigations: ${navs}`);
  check('Info: the pill shows', await pill());
  const tv = await ev(() => document.querySelector('#if-title')?.value);
  check('Info: the typed title is still there', /A new title/.test(tv || ''), tv);
  await ev(() => document.querySelector('#it-info [data-close]').click());
  check('Info cancelled: the waiting reload goes', (await reloadedSoon()) >= 1, `navigations: ${navs}`);

  // ---- an untouched sheet does not hold the reload ----
  await open(`#/item/${encodeURIComponent(it.id)}`);
  await ev((id) => import('/js/views/info.js').then((m) => m.openInfo(id)), it.id);
  await until(() => !!document.querySelector('#if-title'), 5000);
  await deployAndReturn();
  check('Info open but nothing changed: the reload goes', navs >= 1, `navigations: ${navs}`);

  // ---- Feedback page with text typed ----
  await open('#/feedback');
  await until(() => !!document.querySelector('#fb-text'), 5000);
  await page.click('#fb-text'); await page.keyboard.type('Something to say');
  await deployAndReturn();
  check('Feedback text typed: no reload', navs === 0, `navigations: ${navs}`);
  check('Feedback: the pill shows', await pill());
  await ev(() => { const t = document.querySelector('#fb-text'); t.value = ''; t.dispatchEvent(new Event('input')); });
  check('Feedback text cleared: the waiting reload goes', (await reloadedSoon()) >= 1, `navigations: ${navs}`);

  await send('POST', '/items/trash', { ids: [it.id] }).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`); console.log(errs.length ? 'errors:\n' + errs.join('\n') : 'no page errors');
} finally { await b.close(); }
process.exit(fail ? 1 : 0);
