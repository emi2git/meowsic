// Stats and settings.
import { store } from '../store.js';
import { $, esc, icon, badge, ago, mins, toast, confirmSheet, CAT } from '../ui.js';
import { applyTheme } from '../app.js';
import { thumbHtml } from './actions.js';

const DAY = 86400000, WEEK = 7 * DAY;

// ================= stats =================
const PERIODS = { 30: 'Last 30 days', 91: 'Last 3 months', 182: 'Last 6 months', 365: 'Last year', 0: 'All time' };
let period = 30;
try { period = +(localStorage.getItem('meowsic-stats-period') ?? 30); } catch {}

export function statsView(main) {
  const draw = () => {
    const now = Date.now();
    const all = store.plays();
    const plays = period ? all.filter((p) => p.openedAt > now - period * DAY) : all;
    const total = plays.reduce((s, p) => s + p.closedAt - p.openedAt, 0);
    const days = new Set(all.map((p) => new Date(p.openedAt).toDateString()));
    const has = (d) => days.has(new Date(now - d * DAY).toDateString());
    let streak = 0;
    for (let d = has(0) ? 0 : 1; has(d); d++) streak++;

    // chart: days for 30 days, weeks up to 6 months, months beyond
    const first = all.length ? Math.min(...all.map((p) => p.openedAt)) : now;
    const span = period || Math.max(30, Math.ceil((now - first) / DAY));
    const step = span <= 31 ? DAY : span <= 190 ? 7 * DAY : 30.44 * DAY;
    const n = Math.ceil(span * DAY / step);
    const buckets = Array.from({ length: n }, (_, i) => {
      const end = now - (n - 1 - i) * step, start = end - step;
      const m = plays.filter((p) => p.openedAt > start && p.openedAt <= end).reduce((s, p) => s + p.closedAt - p.openedAt, 0) / 60000;
      const lab = new Date(start + step / 2).toLocaleDateString(undefined, step >= 30 * DAY ? { month: 'short' } : { day: 'numeric', month: 'short' });
      return { label: lab, m: Math.round(m) };
    });
    const max = Math.max(10, ...buckets.map((w) => w.m));
    const nice = Math.ceil(max / 30) * 30;
    const every = Math.ceil(n / 10); // label at most ~10 bars
    const per = new Map();
    for (const p of plays) { const e = per.get(p.itemId) || { n: 0, t: 0, last: 0 }; e.n++; e.t += p.closedAt - p.openedAt; e.last = Math.max(e.last, p.openedAt); per.set(p.itemId, e); }
    const ranked = [...per.entries()].map(([id, e]) => ({ it: store.get(id), ...e })).filter((x) => x.it && !x.it.deleted);
    const most = [...ranked].sort((a, b) => b.t - a.t).slice(0, 8);
    const recent = [...ranked].sort((a, b) => b.last - a.last).slice(0, 8);
    const row = (x, right) => `<li class="row" onclick="location.hash='#/item/${x.it.id}'"><div class="row-main"><div class="row-title">${esc(x.it.title)}</div><div class="row-sub">${badge(x.it.kind)}</div></div><div class="row-when">${right}</div></li>`;
    const unit = step === DAY ? 'day' : step >= 30 * DAY ? 'month' : 'week';

    main.innerHTML = `<header class="top"><h1>Stats</h1><span class="grow"></span>
        <select id="st-period" aria-label="Period">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}" ${+k === period ? 'selected' : ''}>${l}</option>`).join('')}</select></header>
      <div class="pad">
        <div class="tiles">
          <div class="tile"><small>Practice time</small><b>${mins(total)}</b></div>
          <div class="tile"><small>Sessions</small><b>${plays.length}</b></div>
          <div class="tile"><small>Pieces played</small><b>${per.size}</b></div>
          <div class="tile"><small>Day streak</small><b>${streak}</b></div>
        </div>
        <section class="card fun"><h2>Fun facts</h2><ul>${funFacts(plays, ranked, total).map((f) => `<li>${f}</li>`).join('')}</ul></section>
        <section class="card">
          <h2>Practice minutes per ${unit}</h2>
          <div class="chart-bars" role="img" aria-label="Practice minutes per ${unit}">
            <div class="axis">${[nice, nice / 2, 0].map((v) => `<span>${v}</span>`).join('')}</div>
            <div class="bars">${buckets.map((w, i) => `<div class="bar-col" tabindex="0" data-tip="${w.label}: ${w.m} min"><div class="bar" style="height:${(w.m / nice) * 100}%"></div>${i % every === 0 ? `<span>${w.label}</span>` : ''}</div>`).join('')}</div>
            <div class="tip" id="tip" hidden></div>
          </div>
        </section>
        <div class="two-col">
          <section class="card"><h2>Most practised</h2><ul class="rows compact">${most.map((x) => row(x, mins(x.t))).join('') || '<li class="muted">Nothing yet</li>'}</ul></section>
          <section class="card"><h2>Recently played</h2><ul class="rows compact">${recent.map((x) => row(x, ago(x.last))).join('') || '<li class="muted">Nothing yet</li>'}</ul></section>
        </div>
        <p class="muted small">A session counts when a piece stays open for at least 10 seconds.</p>
      </div>`;
    $('#st-period', main).onchange = (e) => { period = +e.target.value; try { localStorage.setItem('meowsic-stats-period', period); } catch {} draw(); };
    const tip = $('#tip', main), bars = main.querySelector('.bars');
    const show = (col) => { const r = col.getBoundingClientRect(), p = bars.getBoundingClientRect(); tip.hidden = false; tip.textContent = col.dataset.tip; tip.style.left = r.left - p.left + r.width / 2 + 'px'; };
    bars.addEventListener('pointerover', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
    bars.addEventListener('focusin', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
    bars.addEventListener('pointerleave', () => (tip.hidden = true));
  };
  draw();
}

// a few light facts from the play history
function funFacts(plays, ranked, total) {
  if (!plays.length) return ['Play something and fun facts will show up here.'];
  const f = [];
  const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const byDay = Array(7).fill(0);
  for (const p of plays) byDay[new Date(p.openedAt).getDay()] += p.closedAt - p.openedAt;
  f.push(`You practise most on <b>${DAYS[byDay.indexOf(Math.max(...byDay))]}</b>.`);
  const top = [...ranked].sort((a, b) => b.n - a.n)[0];
  if (top) f.push(`<b>${esc(top.it.title)}</b> is your favourite — opened ${top.n} times.`);
  const long = plays.reduce((m, p) => (p.closedAt - p.openedAt > m.closedAt - m.openedAt ? p : m));
  const li = store.get(long.itemId);
  if (li) f.push(`Longest session: <b>${mins(long.closedAt - long.openedAt)}</b> with ${esc(li.title)}.`);
  const films = total / (120 * 60000);
  if (films >= 1) f.push(`That's as long as watching <b>${Math.floor(films)}</b> full-length movie${Math.floor(films) > 1 ? 's' : ''}.`);
  const late = plays.filter((p) => new Date(p.openedAt).getHours() >= 21).length;
  if (late) f.push(`<b>${late}</b> session${late > 1 ? 's' : ''} started after 9 pm. Night owl!`);
  const tagT = new Map();
  for (const x of ranked) for (const t of x.it.tags) tagT.set(t, (tagT.get(t) || 0) + x.t);
  const tt = [...tagT].sort((a, b) => b[1] - a[1])[0];
  if (tt) f.push(`Your most played tag is <b>${esc(tt[0])}</b>.`);
  const kinds = new Set(ranked.map((x) => x.it.kind));
  if (kinds.size === 3) f.push('You played sheets, chord charts <i>and</i> scores — all three!');
  return f.slice(0, 5);
}

// ================= settings =================
export function settingsView(main) {
  let theme = 'system';
  try { theme = localStorage.getItem('meowsic-theme') || 'system'; } catch {}
  const items = store.items();
  main.innerHTML = `<header class="top"><h1>Settings</h1></header>
    <div class="pad narrow settings">
      <section class="card"><h2>${icon('wifi')} Mac connection</h2>
        <dl class="kv"><dt>Server</dt><dd>https://meowsic.local:5180 <span class="pill ok">Connected (mock)</span></dd>
        <dt>Last sync</dt><dd>${ago(Date.now() - 4 * 60000)}</dd>
        <dt>Waiting to sync</dt><dd>0 changes</dd></dl>
        <p class="muted small">Adding music, chord search and transcription need the Mac. Reading the library works offline.</p></section>
      <section class="card"><h2>${icon('download')} Offline on this device</h2>
        <label class="ctl check"><input type="checkbox" checked> Keep the whole library readable offline</label>
        <dl class="kv"><dt>Stored here</dt><dd>${items.length} items · about ${Math.round(items.filter((x) => x.kind === 'sheet').reduce((s, x) => s + x.pages, 0) * 0.45)} MB</dd></dl></section>
      <section class="card"><h2>${icon('moon')} Appearance</h2>
        <div class="seg" id="st-theme">${[['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></section>
      <section class="card"><h2>${icon('upload')} Backup</h2>
        <p class="muted small">The Mac also keeps a daily copy of the database (last 30 days).</p>
        <div class="row-ctl"><button id="st-export">${icon('download')}Export backup</button>
        <label class="btn">${icon('upload')}Import backup<input type="file" id="st-import" accept="application/json,.json" hidden></label></div></section>
<p class="center muted">Meowsic 2.0 · UI preview</p>
    </div>`;
  $('#st-theme', main).onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    try { localStorage.setItem('meowsic-theme', b.dataset.t); } catch {}
    applyTheme();
    main.querySelectorAll('#st-theme button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#st-export', main).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([store.exportJson()], { type: 'application/json' }));
    a.download = `meowsic-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#st-import', main).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { store.importJson(await f.text()); toast('Backup imported'); } catch (err) { toast(err.message); }
  };
}

// ================= developer =================
// Things for building and testing Meowsic, kept out of Settings.
export function developerView(main) {
  main.innerHTML = `<header class="top"><h1>Developer</h1></header>
    <div class="pad narrow settings">
      <section class="card"><h2>Bring in the old apps</h2>
        <ul class="plain">
          <li>Meowsic 1 (iPad): 485 sheets, 11 chord charts, 1 score, 31 tags <small class="muted">— phase 2</small></li>
          <li>Emi Songbook: 11 songs; its 3 collections become tags <small class="muted">— phase 2</small></li>
          <li>Emi Music Note: 4 transcriptions <small class="muted">— phase 2</small></li>
        </ul></section>
      <section class="card"><h2>Mock data</h2>
        <p class="muted small">This is the UI preview. Everything you change is kept in this browser only.</p>
        <button class="danger-text" id="st-reset">Reset mock data</button></section>
    </div>`;
  $('#st-reset', main).onclick = async () => { if (await confirmSheet({ title: 'Reset the mock data?', body: 'Your test changes in this browser are thrown away.', ok: 'Reset', danger: true })) { store.reset(); toast('Mock data reset'); } };
}
