// Every score renders (server on $BASE): opens each listed score (or IDS=a,b) in the viewer and fails on
// page errors / OSMD console errors (e.g. "reading 'parentVoiceEntry'", "Before render, please load").
import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://localhost:5190/';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await b.newPage(); await page.setViewport({ width: +(process.env.W || 1440), height: +(process.env.H || 900) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /OSMD|parentVoiceEntry|Cannot read/.test(t)) errs.push(t); });
const items = await fetch(BASE + 'api/items').then((r) => r.json());
const ids = process.env.IDS ? process.env.IDS.split(',') : items.filter((x) => x.kind === 'score' && !x.deleted && x.musicxml).map((x) => x.id);
let fail = 0;
await page.goto(BASE + '#/library', { waitUntil: 'networkidle0' });
for (const id of ids) {
  errs = [];
  await page.goto(`${BASE}#/item/${id}`, { waitUntil: 'networkidle0' }); await sleep(+(process.env.WAIT || 2500));
  const st = await page.evaluate(() => ({ err: document.querySelector('#osmd .err')?.textContent || '', notes: document.querySelectorAll('#osmd .vf-stavenote').length }));
  const bad = errs.filter((e) => !/favicon|404/.test(e));
  if (bad.length || st.err || !st.notes) { fail++; console.log('  FAIL', id, st.notes, st.err, bad.slice(0, 3).join(' | ')); } else console.log('  ok  ', id, st.notes);
}
console.log(`\n${ids.length - fail} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
