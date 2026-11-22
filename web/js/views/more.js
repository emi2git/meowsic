// Stats and settings.
import { store } from '../store.js';
import { $, esc, icon, badge, ago, mins, toast, confirmSheet, CAT } from '../ui.js';
import { applyTheme } from '../app.js';
import { thumbHtml } from './actions.js';

const DAY = 86400000, WEEK = 7 * DAY;

// ================= stats =================
export function statsView(main) {
  const plays = store.plays();
  const now = Date.now();
  const last30 = plays.filter((p) => p.openedAt > now - 30 * DAY);
  const total30 = last30.reduce((s, p) => s + p.closedAt - p.openedAt, 0);
  const days = new Set(plays.map((p) => new Date(p.openedAt).toDateString()));
  let streak = 0;
  const has = (d) => days.has(new Date(now - d * DAY).toDateString());
  for (let d = has(0) ? 0 : 1; has(d); d++) streak++;
  const weeks = Array.from({ length: 10 }, (_, i) => {
    const end = now - (9 - i) * WEEK, start = end - WEEK;
    const m = plays.filter((p) => p.openedAt > start && p.openedAt <= end).reduce((s, p) => s + p.closedAt - p.openedAt, 0) / 60000;
    return { label: new Date(start + DAY).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), m: Math.round(m) };
  });
  const max = Math.max(30, ...weeks.map((w) => w.m));
  const nice = Math.ceil(max / 60) * 60;
  const per = new Map();
  for (const p of plays) { const e = per.get(p.itemId) || { n: 0, t: 0, last: 0 }; e.n++; e.t += p.closedAt - p.openedAt; e.last = Math.max(e.last, p.openedAt); per.set(p.itemId, e); }
  const ranked = [...per.entries()].map(([id, e]) => ({ it: store.get(id), ...e })).filter((x) => x.it && !x.it.deleted);
  const most = [...ranked].sort((a, b) => b.t - a.t).slice(0, 8);
  const recent = [...ranked].sort((a, b) => b.last - a.last).slice(0, 8);
  const row = (x, right) => `<li class="row" onclick="location.hash='#/item/${x.it.id}'">${thumbHtml(x.it)}<div class="row-main"><div class="row-title">${esc(x.it.title)}</div><div class="row-sub">${badge(x.it.kind)}</div></div><div class="row-when">${right}</div></li>`;

  main.innerHTML = `<header class="top"><h1>Stats</h1></header>
    <div class="pad">
      <div class="tiles">
        <div class="tile"><small>Practice, last 30 days</small><b>${mins(total30)}</b></div>
        <div class="tile"><small>Sessions, last 30 days</small><b>${last30.length}</b></div>
        <div class="tile"><small>Pieces played, all time</small><b>${per.size}</b></div>
        <div class="tile"><small>Day streak</small><b>${streak} ${icon('paw', 'paw-ic')}</b></div>
      </div>
      <section class="card">
        <h2>Practice minutes per week</h2>
        <div class="chart-bars" role="img" aria-label="Practice minutes per week for the last 10 weeks">
          <div class="axis">${[nice, nice / 2, 0].map((v) => `<span>${v}</span>`).join('')}</div>
          <div class="bars">${weeks.map((w) => `<div class="bar-col" tabindex="0" data-tip="Week of ${w.label}: ${w.m} min"><div class="bar" style="height:${(w.m / nice) * 100}%"></div><span>${w.label}</span></div>`).join('')}</div>
          <div class="tip" id="tip" hidden></div>
        </div>
        <details class="table-view"><summary>Show as table</summary><table><tr><th>Week of</th><th>Minutes</th></tr>${weeks.map((w) => `<tr><td>${w.label}</td><td>${w.m}</td></tr>`).join('')}</table></details>
      </section>
      <div class="two-col">
        <section class="card"><h2>Most practised</h2><ul class="rows compact">${most.map((x) => row(x, mins(x.t))).join('') || '<li class="muted">Nothing yet</li>'}</ul></section>
        <section class="card"><h2>Recently played</h2><ul class="rows compact">${recent.map((x) => row(x, ago(x.last))).join('') || '<li class="muted">Nothing yet</li>'}</ul></section>
      </div>
      <p class="muted small">A session counts when a piece stays open for at least 10 seconds.</p>
    </div>`;
  const tip = $('#tip', main), bars = main.querySelector('.bars');
  const show = (col) => { const r = col.getBoundingClientRect(), p = bars.getBoundingClientRect(); tip.hidden = false; tip.textContent = col.dataset.tip; tip.style.left = r.left - p.left + r.width / 2 + 'px'; };
  bars.addEventListener('pointerover', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
  bars.addEventListener('focusin', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
  bars.addEventListener('pointerleave', () => (tip.hidden = true));
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
      <section class="card"><h2>${icon('restore')} Bring in the old apps</h2>
        <ul class="plain">
          <li>${icon('check')} Meowsic 1 (iPad): 485 sheets, 11 chord charts, 1 score, 31 tags <small class="muted">— phase 2</small></li>
          <li>${icon('check')} Emi Songbook: 11 songs; its 3 collections become tags <small class="muted">— phase 2</small></li>
          <li>${icon('check')} Emi Music Note: 4 transcriptions <small class="muted">— phase 2</small></li>
        </ul></section>
      <section class="card"><h2>${icon('info')} Mock data</h2>
        <p class="muted small">This is the UI preview. Everything you change is kept in this browser only.</p>
        <button class="danger-text" id="st-reset">Reset mock data</button></section>
      <p class="center muted">${CAT}<br>Meowsic 2.0 · UI preview</p>
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
  $('#st-reset', main).onclick = async () => { if (await confirmSheet({ title: 'Reset the mock data?', body: 'Your test changes in this browser are thrown away.', ok: 'Reset', danger: true })) { store.reset(); toast('Mock data reset'); } };
}
