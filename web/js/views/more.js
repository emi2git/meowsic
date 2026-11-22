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
        <section class="card fun"><h2>Fun facts <button class="link small" id="fun-more">More facts</button></h2><ul id="fun-list">${funFacts(plays, ranked, total).map((f) => `<li>${f}</li>`).join('')}</ul></section>
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
    $('#fun-more', main).onclick = () => ($('#fun-list', main).innerHTML = funFacts(plays, ranked, total).map((f) => `<li>${f}</li>`).join(''));
    $('#st-period', main).onchange = (e) => { period = +e.target.value; try { localStorage.setItem('meowsic-stats-period', period); } catch {} draw(); };
    const tip = $('#tip', main), bars = main.querySelector('.bars');
    const show = (col) => { const r = col.getBoundingClientRect(), p = bars.getBoundingClientRect(); tip.hidden = false; tip.textContent = col.dataset.tip; tip.style.left = r.left - p.left + r.width / 2 + 'px'; };
    bars.addEventListener('pointerover', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
    bars.addEventListener('focusin', (e) => { const c = e.target.closest('.bar-col'); if (c) show(c); });
    bars.addEventListener('pointerleave', () => (tip.hidden = true));
  };
  draw();
}

// A big pool of light facts; each visit shows a random handful (only facts that have data).
function funFacts(plays, ranked, total) {
  if (!plays.length) return ['Play something and fun facts will show up here.'];
  const items = store.items();
  const dur = (p) => p.closedAt - p.openedAt;
  const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const pool = [];
  const add = (f) => { try { const v = f(); if (v) pool.push(v); } catch {} };

  add(() => { const d = Array(7).fill(0); for (const p of plays) d[new Date(p.openedAt).getDay()] += dur(p); return `You practise most on <b>${DAYS[d.indexOf(Math.max(...d))]}</b>.`; });
  add(() => { const t = [...ranked].sort((a, b) => b.n - a.n)[0]; return t && `<b>${esc(t.it.title)}</b> is your favourite — opened ${t.n} times.`; });
  add(() => { const l = plays.reduce((m, p) => (dur(p) > dur(m) ? p : m)); const it = store.get(l.itemId); return it && `Longest session: <b>${mins(dur(l))}</b> with ${esc(it.title)}.`; });
  add(() => { const n = Math.floor(total / (120 * 60000)); return n >= 1 && `That's as long as watching <b>${n}</b> full-length movie${n > 1 ? 's' : ''}.`; });
  add(() => { const n = Math.floor(total / (3.5 * 3600000)); return n >= 1 && `In that time you could fly Hanoi → Singapore <b>${n}</b> time${n > 1 ? 's' : ''}.`; });
  add(() => { const n = plays.filter((p) => new Date(p.openedAt).getHours() >= 21).length; return n && `<b>${n}</b> session${n > 1 ? 's' : ''} started after 9 pm. Night owl!`; });
  add(() => { const n = plays.filter((p) => new Date(p.openedAt).getHours() < 8).length; return n && `<b>${n}</b> session${n > 1 ? 's' : ''} started before 8 am. Early bird!`; });
  add(() => { const h = Array(24).fill(0); for (const p of plays) h[new Date(p.openedAt).getHours()]++; const b = h.indexOf(Math.max(...h)); return `Your favourite time to play is around <b>${b % 12 || 12} ${b < 12 ? 'am' : 'pm'}</b>.`; });
  add(() => { const t = new Map(); for (const x of ranked) for (const g of x.it.tags) t.set(g, (t.get(g) || 0) + x.t); const top = [...t].sort((a, b) => b[1] - a[1])[0]; return top && `Your most played tag is <b>${esc(top[0])}</b>.`; });
  add(() => new Set(ranked.map((x) => x.it.kind)).size === 3 && 'You played sheets, chord charts <i>and</i> scores — all three!');
  add(() => `Average session: <b>${mins(total / plays.length)}</b>.`);
  add(() => { const d = new Map(); for (const p of plays) { const k = new Date(p.openedAt).toDateString(); d.set(k, (d.get(k) || 0) + dur(p)); } const [k, v] = [...d].sort((a, b) => b[1] - a[1])[0]; return `Your biggest day: <b>${mins(v)}</b> on ${new Date(k).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.`; });
  add(() => { const we = plays.filter((p) => [0, 6].includes(new Date(p.openedAt).getDay())).reduce((s, p) => s + dur(p), 0); const pct = Math.round((we / total) * 100); return `<b>${pct}%</b> of your practice happens at the weekend.`; });
  add(() => { const pages = items.filter((x) => x.kind === 'sheet').reduce((s, x) => s + x.pages, 0); return pages && `Your sheets add up to <b>${pages}</b> pages — a stack about ${(pages * 0.1 / 10).toFixed(1)} cm tall.`; });
  add(() => { const s = items.filter((x) => x.kind === 'sheet').length; return s && `Playing every sheet once at 3 minutes each would take <b>${mins(s * 3 * 60000)}</b>.`; });
  add(() => { const k = new Map(); for (const x of items.filter((i) => i.kind === 'chords')) k.set(x.key, (k.get(x.key) || 0) + 1); const top = [...k].sort((a, b) => b[1] - a[1])[0]; return top && `The most common key in your chord charts is <b>${esc(top[0])}</b>.`; });
  add(() => { const l = [...items].sort((a, b) => b.title.length - a.title.length)[0]; return `Longest title in your library: <b>${esc(l.title)}</b>.`; });
  add(() => { const played = new Set(store.plays().map((p) => p.itemId)); const n = items.filter((x) => !played.has(x.id)).length; return n && `<b>${n}</b> piece${n > 1 ? 's' : ''} in your library ${n > 1 ? 'have' : 'has'} never been opened. Something new to try!`; });
  add(() => { const last = new Map(); for (const p of store.plays()) last.set(p.itemId, Math.max(last.get(p.itemId) || 0, p.openedAt)); const old = [...last].filter(([id]) => store.get(id) && !store.get(id).deleted).sort((a, b) => a[1] - b[1])[0]; return old && `You haven't played <b>${esc(store.get(old[0]).title)}</b> in ${Math.round((Date.now() - old[1]) / DAY)} days.`; });
  add(() => { const a = new Map(); for (const x of ranked) if (x.it.artist && !/traditional/i.test(x.it.artist)) a.set(x.it.artist, (a.get(x.it.artist) || 0) + x.t); const top = [...a].sort((p, q) => q[1] - p[1])[0]; return top && `You play more <b>${esc(top[0])}</b> than anyone else.`; });
  add(() => { const vi = items.filter((x) => x.tags.includes('Vietnamese')).length; return vi && `<b>${vi}</b> Vietnamese song${vi > 1 ? 's' : ''} in your library.`; });
  add(() => { const o = [...items].sort((a, b) => a.createdAt - b.createdAt)[0]; return `The oldest piece in your library is <b>${esc(o.title)}</b>.`; });
  add(() => { const n = Object.keys(store.db.printed || {}).length; return n && `You've printed <b>${n}</b> piece${n > 1 ? 's' : ''} so far.`; });
  add(() => { const n = ranked.length; return `You played <b>${n}</b> different piece${n > 1 ? 's' : ''} in this period.`; });
  add(() => { const c = plays.filter((p) => store.get(p.itemId)?.tags.includes('Christmas')).length; return c && `You opened Christmas music <b>${c}</b> time${c > 1 ? 's' : ''}. 🎄`; });
  add(() => { const s = plays.reduce((m, p) => Math.min(m, dur(p)), Infinity); return `Shortest session: <b>${Math.max(1, Math.round(s / 60000))} min</b>. Quick warm-up?`; });

  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 5);
}

// ================= settings =================
export function settingsView(main) {
  let theme = 'system';
  try { theme = localStorage.getItem('meowsic-theme') || 'system'; } catch {}
  const items = store.items();
  main.innerHTML = `<header class="top"><h1>Settings</h1></header>
    <div class="pad narrow settings">
      <section class="card"><h2>${icon('wifi')} Mac connection</h2>
        <dl class="kv"><dt>Server</dt><dd>${esc(location.host)} <span class="pill ${store.mode === 'server' ? 'ok' : ''}">${store.mode === 'server' ? 'Connected' : 'Offline'}</span></dd>
        <dt>Last sync</dt><dd>${store.lastSync ? ago(store.lastSync) : '—'}</dd>
        <dt>Waiting to sync</dt><dd>${store.waiting} change${store.waiting === 1 ? '' : 's'}</dd></dl>
        <p class="muted small">Adding music, chord search and transcription need the Mac. Reading the library works offline.</p></section>
      <section class="card"><h2>${icon('download')} Offline on this device</h2>
        <label class="ctl check"><input type="checkbox" checked disabled> Keep the library readable offline</label>
        <dl class="kv"><dt>Stored here</dt><dd id="st-stored">${items.length} items</dd></dl></section>
      <section class="card"><h2>${icon('moon')} Appearance</h2>
        <div class="seg" id="st-theme">${[['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></section>
      <section class="card"><h2>${icon('upload')} Backup</h2>
        <p class="muted small">The Mac also keeps a daily copy of the database (last 30 days).</p>
        <div class="row-ctl"><button id="st-export">${icon('download')}Export backup</button>
        <label class="btn">${icon('upload')}Import backup<input type="file" id="st-import" accept="application/json,.json" hidden></label></div></section>
<p class="center muted">Meowsic 2.0 · UI preview</p>
    </div>`;
  navigator.storage?.estimate?.().then((e) => { const el = $('#st-stored', main); if (el && e.usage) el.textContent = `${store.items().length} items · ${Math.round(e.usage / 1e6)} MB on this device`; }).catch(() => {});
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
    </div>`;
}
