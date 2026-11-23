import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--ignore-certificate-errors'] });
for (const [name, touch, w] of [['ipad', true, 1180], ['mac', false, 1440]]) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: 820, hasTouch: touch, isMobile: touch });
  await p.goto('https://localhost:5180/#/library', { waitUntil: 'networkidle0' }); await new Promise((r) => setTimeout(r, 1200));
  const vis = await p.$$eval('.lib-table thead th', (e) => e.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent.trim()));
  console.log(name, JSON.stringify(vis)); await p.screenshot({ path: `lib-${name}.png` });
}
await b.close();
