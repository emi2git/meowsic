// Hard guard: no e2e suite may touch the LIVE app (port 5180) or the live library (~/Documents/Meowsic).
// Every suite imports this first. It (1) refuses to start when a BASE / PREVIEW / *_BASE / SERVER / DATA-like
// env var points at live, and (2) kills the run (exit 3) the moment any page or node fetch requests :5180.
// The one exception is reallib.mjs, a read-only look at the live library: it needs MEOWSIC_LIVE_READONLY=1 and
// may only send GET requests.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';

const LIVE_PORT = /:5180(?![0-9])/;
const LIVE_DATA = path.join(os.homedir(), 'Documents', 'Meowsic');
const suite = path.basename(process.argv[1] || '');
const readOnly = suite === 'reallib.mjs';

const die = (why) => {
  console.error(`\nlive-guard: STOP (${suite}): ${why}.\nTests never touch the live app (:5180) or ${LIVE_DATA}. Use scripts/test-all, or scripts/dev-server and BASE=http://127.0.0.1:<port>/.`);
  process.exit(3);
};
const isLiveData = (v) => { const p = path.resolve(String(v).replace(/^~(?=\/|$)/, os.homedir())); return p === LIVE_DATA || p.startsWith(LIVE_DATA + path.sep); };

if (readOnly && process.env.MEOWSIC_LIVE_READONLY !== '1') die('reallib reads the LIVE library; run it only on purpose with MEOWSIC_LIVE_READONLY=1');

// 1. env pointing at live
for (const [k, v] of Object.entries(process.env)) {
  if (!v || !/BASE|PREVIEW|SERVER|URL|DATA|^DB$/.test(k)) continue;
  if (!readOnly && LIVE_PORT.test(v)) die(`${k}=${v} is the live app`);
  if (/DATA|^DB$/.test(k) && isLiveData(v)) die(`${k}=${v} is the live library`);
  if (k === 'SERVER' && (/\s--data\s+\S*Documents\/Meowsic(\s|\/|$)/.test(v) || !/--data\s/.test(v) && /-m meowsic/.test(v))) die(`SERVER would start a server on the live library: ${v}`);
}

// 2. tripwires on every request
const bad = (url, method = 'GET') => LIVE_PORT.test(url) && (!readOnly || method !== 'GET');
const watch = (page) => {
  if (!page || page.__liveGuard) return page;
  page.__liveGuard = true;
  page.on('request', (r) => { if (bad(r.url(), r.method())) die(`a page requested ${r.method()} ${r.url()}`); });
  return page;
};
const hookContext = (c) => {
  if (!c || c.__liveGuard) return c;
  c.__liveGuard = true;
  const np = c.newPage.bind(c);
  c.newPage = async (...a) => watch(await np(...a));
  return c;
};
const hookBrowser = (b) => {
  hookContext(b);
  b.on('targetcreated', async (t) => { try { watch(await t.page()); } catch { /* not a page */ } });
  for (const k of ['createBrowserContext', 'createIncognitoBrowserContext']) {
    if (typeof b[k] !== 'function') continue;
    const f = b[k].bind(b);
    b[k] = async (...a) => hookContext(await f(...a));
  }
  return b;
};
for (const k of ['launch', 'connect']) {
  const f = puppeteer[k].bind(puppeteer);
  puppeteer[k] = async (...a) => hookBrowser(await f(...a));
}
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (bad(url, (init.method || input?.method || 'GET').toUpperCase())) die(`fetch ${url}`);
  return nodeFetch(input, init);
};

export { die };
