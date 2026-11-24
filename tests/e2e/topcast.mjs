// No white veil over the top of the app: whatever sits at the top of the screen (under the status bar on
// iPad / iPhone) is opaque, with no blur and no see-through white. Light + Dark, iPad, iPhone and Mac.
// The installed app runs under the status bar (black-translucent), so the top bars pad by the inset.
import './live-guard.mjs'; // refuses the live app / library
import puppeteer from 'puppeteer-core';
const ORIGIN = process.env.PREVIEW || 'http://localhost:5181';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };

const devices = [['ipad', 820, 1180, true], ['iphone', 402, 874, true], ['mac', 1440, 900, false]];
const views = ['#/library', '#/settings', '#/help'];
for (const [dev, w, h, touch] of devices) for (const theme of ['light', 'dark']) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' });
  await p.evaluate((t) => localStorage.setItem('meowsic-theme', t), theme);
  for (const v of views) {
    await p.goto(ORIGIN + '/?preview=1' + v, { waitUntil: 'networkidle0' }); await sleep(500);
    // scroll the content so anything see-through at the top would show it
    await p.evaluate(() => { const m = document.getElementById('main'); if (m) m.scrollTop = 400; }); await sleep(150);
    const bad = await p.evaluate(() => {
      const out = [];
      const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return c === 'transparent' ? 0 : 1; const a = m[1].split(/[ ,/]+/).filter(Boolean); return a.length > 3 ? parseFloat(a[3]) : 1; };
      for (let x = 4; x < innerWidth; x += Math.max(20, innerWidth / 24)) for (const y of [2, 30, 60]) {
        const el = document.elementFromPoint(x, y); if (!el) continue;
        // the first element (from the hit one up) with a background must be opaque; nothing on the way blurs
        let e = el, ok = false;
        for (; e && e !== document.documentElement; e = e.parentElement) {
          const s = getComputedStyle(e);
          if ((s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none')) { out.push(`${x},${y} blur on ${e.className || e.tagName}`); break; }
          if (parseFloat(s.opacity) < 1 && e.getBoundingClientRect().width > 120) { /* a dimmed icon is not a veil */ out.push(`${x},${y} opacity ${s.opacity} on ${e.className || e.tagName}`); break; }
          const a = alpha(s.backgroundColor);
          if (a >= 1) { ok = true; break; }
          if (a > 0) { out.push(`${x},${y} see-through ${s.backgroundColor} on ${e.className || e.tagName}`); break; }
        }
        if (!ok && !out.length && e === document.documentElement) ok = true; // falls through to the page background
      }
      return [...new Set(out)];
    });
    check(`${dev} ${theme} ${v}: top is opaque, no blur`, bad.length === 0, bad.slice(0, 4).join(' | '));
  }
  // the app fills the screen; the title is fully opaque
  const r = await p.evaluate(() => {
    const app = document.querySelector('.app').getBoundingClientRect();
    const brand = document.querySelector('.brand b');
    return { appH: Math.round(app.height), vh: innerHeight, brand: brand && getComputedStyle(brand).display !== 'none' ? getComputedStyle(brand).opacity : '1' };
  });
  check(`${dev} ${theme}: app fills the screen, title opaque`, Math.abs(r.appH - r.vh) <= 1 && r.brand === '1', JSON.stringify(r));
  await p.close();
}
// the page asks to run under the status bar, and the top bars / sidebar pad by the inset
const p = await b.newPage(); await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' });
const meta = await p.$eval('meta[name="apple-mobile-web-app-status-bar-style"]', (m) => m.content);
check('status bar style is black-translucent (no system veil)', meta === 'black-translucent', meta);
const css = await p.evaluate(async () => (await (await fetch('css/app.css')).text()));
check('sidebar pads by the top inset', /\.side \{[^}]*padding: calc\(14px \+ env\(safe-area-inset-top\)\)/.test(css));
check('top bar is opaque (no blur)', /\.top \{[^}]*background: var\(--bg\);/.test(css) && !/\.top \{[^}]*backdrop-filter/.test(css));
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
