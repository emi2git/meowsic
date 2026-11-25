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
// Score view on iPad, after tapping Verified (toast "Marked verified"): the header text is at full opacity,
// nothing see-through overlaps the header, and a solid fixed strip touches the top edge (iOS 26 samples it
// and draws a plain bar instead of its blurred white fade over the header). Portrait + landscape, light +
// dark, Safari (inset 0) + home-screen app (status bar inset 24).
for (const [orient, w, h] of [['portrait', 834, 1194], ['landscape', 1194, 834]]) for (const theme of ['light', 'dark']) for (const inset of [0, 24]) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: h, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  if (inset) { const cdp = await p.createCDPSession(); await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset } }).catch(() => {}); }
  await p.goto(ORIGIN + '/?preview=1#/library', { waitUntil: 'networkidle0' });
  await p.evaluate((t) => localStorage.setItem('meowsic-theme', t), theme);
  await p.goto(ORIGIN + '/?preview=1#/item/m-02i', { waitUntil: 'networkidle0' }); await sleep(1000);
  const tag = `ipad ${orient} ${theme} ${inset ? 'app' : 'safari'}`;
  for (const step of ['open', 'verify', 'unverify']) {
    if (step !== 'open') { await p.tap('#it-verified'); await sleep(250); }
    const r = await p.evaluate((inset) => {
      const out = [];
      const top = document.querySelector('.item-top'); const tr = top.getBoundingClientRect();
      const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return c === 'transparent' ? 0 : 1; const a = m[1].split(/[ ,/]+/).filter(Boolean); return a.length > 3 ? parseFloat(a[3]) : 1; };
      const eff = (e) => { let o = 1; for (; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
      // header text: Back, the title
      for (const sel of ['.back', '.item-title']) { const e = top.querySelector(sel); if (!e) out.push(`no ${sel}`); else if (eff(e) !== 1) out.push(`${sel} opacity ${eff(e)}`); else if (getComputedStyle(e).filter !== 'none') out.push(`${sel} filter`); }
      // nothing see-through (or blurring) overlaps the header, the toast included
      for (const e of document.body.querySelectorAll('*')) {
        if (e.contains(top) || top.contains(e)) continue;
        const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden') continue;
        const er = e.getBoundingClientRect(); if (!er.width || !er.height) continue;
        if (er.right <= tr.left || er.left >= tr.right || er.bottom <= tr.top || er.top >= tr.bottom) continue;
        const a = alpha(s.backgroundColor), bf = (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none');
        if (bf || (a > 0 && a < 1) || (a > 0 && eff(e) < 1)) out.push(`over header: ${e.className || e.tagName} bg ${s.backgroundColor}${bf ? ' blur' : ''}`);
      }
      // the solid fixed strip at the top edge: page colour, full width, status bar high, no blur
      const edge = document.querySelector('.topedge'); const es = edge && getComputedStyle(edge), er = edge?.getBoundingClientRect();
      if (!edge) out.push('no .topedge');
      else {
        if (es.position !== 'fixed' || er.top !== 0 || er.width < innerWidth - 1 || Math.round(er.height) !== Math.max(1, inset)) out.push(`topedge box ${es.position} ${er.top} ${er.width} ${er.height}`);
        if (alpha(es.backgroundColor) !== 1 || es.backgroundColor !== getComputedStyle(document.body).backgroundColor || eff(edge) !== 1) out.push(`topedge bg ${es.backgroundColor}`);
        if (Math.round(er.bottom) > Math.round(top.querySelector('.back').getBoundingClientRect().top)) out.push('topedge covers Back');
      }
      return { out, toast: !document.getElementById('toast').hidden };
    }, inset);
    check(`${tag} ${step}: header crisp, nothing see-through over it, solid top edge`, r.out.length === 0 && (step === 'open' || r.toast), r.out.slice(0, 4).join(' | '));
  }
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/topcast-${orient}-${theme}-${inset ? 'app' : 'safari'}.png`, clip: { x: 0, y: 0, width: w, height: 140 } });
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
