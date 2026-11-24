// Screenshot every screen at Mac / iPad / iPhone sizes, light + dark; collect console errors.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const OUT = new URL('./shots/', import.meta.url).pathname;
import fs from 'fs';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5181/?preview=1';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const sizes = (process.env.SIZES || 'mac,ipad,iphone').split(',');
const SIZE = { mac: { width: 1440, height: 900 }, ipad: { width: 1024, height: 1366, isMobile: true, hasTouch: true }, ipadl: { width: 1366, height: 1024, isMobile: true, hasTouch: true }, iphone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
const routes = (process.env.ROUTES || 'library,library?kind=sheet,item/s-001,item/c-024,item/m-02i,perform/s-001,perform/c-024,add-sheets,add-chords,add-score,jobs,tags,bin,print?tag=Christmas,library?tag=Piano%20recital,stats,tools,settings').split(',');
const schemes = (process.env.SCHEMES || 'light').split(',');
const errors = [];
for (const s of sizes) for (const scheme of schemes) {
  const page = await browser.newPage();
  await page.setViewport({ deviceScaleFactor: 1, ...SIZE[s] });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${s}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${s}] PAGEERROR ${e.message}`));
  for (const r of routes) {
    await page.goto(BASE + '#/' + r, { waitUntil: 'networkidle0' });
    await new Promise((ok) => setTimeout(ok, r.startsWith('item/m') || r.startsWith('perform/m') ? 1500 : 400));
    await page.screenshot({ path: `${OUT}${s}-${scheme}-${r.replace(/[^a-z0-9]+/gi, '_')}.png` });
  }
  await page.close();
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
