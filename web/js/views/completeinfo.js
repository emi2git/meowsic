// Manage library → Complete info (#/manage/info): the sheets the AI fill could not name a Key or Version for,
// one card at a time — page 1 big (tap: zoom), then single taps:
//   Key      common keys (with their key signature: 1♯, 2♭ …) or any other key typed ("F#m", "Db major")
//   Version  Lead · Piano · Duet · Accompaniment
// A tap saves at once (the normal PATCH: Activities + Undo work); once Key and Version are both set the next
// card comes. The AI's guess (server: completeinfo.py) is pre-selected. Skip = later (to the end);
// Don't know = hidden until "Show again". Both are kept on the Mac, so every device has the same queue.
// Mac keys: 1–4 version · type a key (A–G…) + Enter · Enter = Save & next · S skip · X don't know · ← back · Space zoom.
import { store } from '../store.js';
import { isDesktop } from '../device.js';
import { $, esc, toast } from '../ui.js';
import { SHEET_VERSIONS } from './actions.js';

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((typeof data.detail === 'string' && data.detail) || 'The Mac said no.');
  return data;
};

// keys as the sheets store them ('Bb', 'F#m'); sig = its key signature, a help for reading page 1
const MAJORS = [['C', '0'], ['G', '1♯'], ['D', '2♯'], ['A', '3♯'], ['E', '4♯'], ['F', '1♭'], ['Bb', '2♭'], ['Eb', '3♭'], ['Ab', '4♭']];
const MINORS = [['Am', '0'], ['Em', '1♯'], ['Bm', '2♯'], ['Dm', '1♭'], ['Gm', '2♭'], ['Cm', '3♭']];
const VERS = [['lead', 'Lead', 'melody + chords'], ['piano', 'Piano', 'both hands'], ['duet', 'Duet', 'two players'], ['accomp', 'Accompaniment', 'piano part, no melody']]
  .filter(([v]) => v in SHEET_VERSIONS);
export const pretty = (k) => String(k || '').replace(/^([A-G])b/, '$1♭').replace(/^([A-G])#/, '$1♯');

// "f# minor", "Db major", "B♭m", "key of G" → 'F#m', 'Db', 'Bbm', 'G' (sheets / chord charts); scores: 'F# minor' …
export function normKey(s, kind = 'sheet') {
  const t = String(s || '').trim().replace(/^key\s*(of\s*)?[:\-]?\s*/i, '').replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = t.match(/^([A-Ga-g])\s*(#|b|-?\s*sharp|-?\s*flat)?\s*(m|min|minor|moll|M|maj|major|dur)?\.?$/i);
  if (!m) return null;
  const root = m[1].toUpperCase();
  const a = (m[2] || '').toLowerCase().replace(/[-\s]/g, ''), acc = a === '#' || a === 'sharp' ? '#' : a === 'b' || a === 'flat' ? 'b' : '';
  const q = m[3] || '', minor = q !== 'M' && /^m(in|inor|oll)?$/i.test(q);
  return kind === 'score' ? `${root}${acc} ${minor ? 'minor' : 'major'}` : `${root}${acc}${minor ? 'm' : ''}`;
}
const same = (a, b) => !!a && !!b && normKey(a) === normKey(b);
const isMissing = (v) => ['', '?', '??', 'unknown', 'none', 'n/a', '-', 'not set'].includes(String(v || '').trim().toLowerCase());

// the tab badge: how many are still to do (any Manage library tab)
export async function infoBadge(root) {
  if (store.mode !== 'server') return;
  try { const { count } = await api('GET', '/completeinfo/count'); const el = $('#cu-ninfo', root); if (el) el.textContent = count || ''; } catch {}
}

export function completeInfoView(body) {
  if (store.mode !== 'server') { body.innerHTML = '<p class="pad muted">Complete info needs the Mac.</p>'; return; }
  const st = { q: null, hidden: 0, i: 0, sel: {}, back: [], done: 0, timer: 0, zoom: false, alive: true, err: '' };
  const cur = () => st.q?.[st.i];
  const live = (r) => store.get(r.id) || r;
  const badge = () => { const el = document.getElementById('cu-ninfo'); if (el) el.textContent = st.q?.length || ''; };

  const load = async () => {
    body.innerHTML = '<p class="pad muted">Loading…</p>';
    try { const r = await api('GET', '/completeinfo'); st.q = r.items; st.hidden = r.hidden; st.i = 0; } catch (e) { body.innerHTML = `<p class="pad muted">${esc(e.message)}</p>`; return; }
    start(); badge();
  };

  // the selection for the card: what it has now, else the AI's guess (pre-selected, not saved yet)
  const start = () => {
    clearTimeout(st.timer);
    const r = cur();
    st.sel = {}; st.err = ''; st.zoom = false;
    if (r) {
      const it = live(r);
      for (const f of ['key', 'version']) {
        if (!isMissing(it[f]) && !(r.kind === 'score' && f === 'version')) st.sel[f] = { v: it[f], saved: true };
        else if (r.suggest?.[f]) st.sel[f] = { v: r.suggest[f].value, saved: false, ai: true };
      }
    }
    draw();
  };

  const needVersion = (r) => r.kind === 'sheet' || r.kind === 'chords';
  const complete = (r) => !!st.sel.key && (!needVersion(r) || !!st.sel.version);

  // save one field (PATCH through the store, so the list and Activities follow)
  const save = (f, v) => {
    const r = cur(); if (!r) return;
    if (f === 'key') v = normKey(v, r.kind) || v;
    st.sel[f] = { v, saved: true };
    if (store.get(r.id)) store.update(r.id, { [f]: v });
    else api('PATCH', `/items/${encodeURIComponent(r.id)}`, { [f]: v }).then((it) => store.putItem(it)).catch((e) => toast(e.message));  // added since the app loaded
  };
  const pick = (f, v) => {
    save(f, v);
    draw();
    const r = cur();
    if (complete(r)) { clearTimeout(st.timer); st.timer = setTimeout(next, 450); $('#ci-card', body)?.classList.add('ci-done'); }
  };
  // Save & next: the pre-selected guesses are saved too
  const next = () => {
    clearTimeout(st.timer);
    const r = cur(); if (!r) return;
    if (!complete(r)) { toast(needVersion(r) && !st.sel.version ? 'Tap a version first' : 'Tap a key first'); return; }
    for (const f of ['key', 'version']) if (st.sel[f] && !st.sel[f].saved) save(f, st.sel[f].v);
    if (r.skipped) api('DELETE', `/completeinfo/${encodeURIComponent(r.id)}/mark`).catch(() => {});
    st.back.push({ r, at: st.i });
    st.q.splice(st.i, 1); st.done++;
    if (st.i >= st.q.length) st.i = 0;
    toast(`Saved “${r.title}”`);
    badge(); start();
  };
  const back = () => {
    const b = st.back.pop(); if (!b) return;
    clearTimeout(st.timer);
    st.q.splice(Math.min(b.at, st.q.length), 0, b.r); st.i = Math.min(b.at, st.q.length - 1); st.done = Math.max(0, st.done - 1);
    badge(); start();
  };
  const skip = async () => {
    const r = cur(); if (!r) return;
    clearTimeout(st.timer);
    st.q.splice(st.i, 1); st.q.push({ ...r, skipped: Date.now() });
    if (st.i >= st.q.length - 1 && st.q.length > 1) st.i = 0;
    start();
    try { await api('PUT', `/completeinfo/${encodeURIComponent(r.id)}/mark`, { how: 'skip' }); } catch (e) { toast(e.message); }
  };
  const dunno = async () => {
    const r = cur(); if (!r) return;
    clearTimeout(st.timer);
    const at = st.i;
    st.q.splice(st.i, 1); st.hidden++;
    if (st.i >= st.q.length) st.i = 0;
    badge(); start();
    try { await api('PUT', `/completeinfo/${encodeURIComponent(r.id)}/mark`, { how: 'unknown' }); } catch (e) { toast(e.message); return; }
    toast(`“${r.title}” hidden — Don't know`, { label: 'Undo', run: async () => {
      await api('DELETE', `/completeinfo/${encodeURIComponent(r.id)}/mark`).catch(() => {});
      st.q.splice(Math.min(at, st.q.length), 0, r); st.i = Math.min(at, st.q.length - 1); st.hidden = Math.max(0, st.hidden - 1); badge(); start();
    } });
  };
  const showAgain = async () => { try { await api('POST', '/completeinfo/reset', {}); } catch (e) { return toast(e.message); } await load(); };
  const typed = () => {
    const inp = $('#ci-other', body), r = cur();
    const k = normKey(inp.value, r.kind);
    if (!k) { st.err = `“${inp.value}” is not a key — try C, F#m, Bb or Db major`; draw(); $('#ci-other', body)?.focus(); return; }
    pick('key', k);
  };

  // ---------- drawing ----------
  const keyBtn = ([k, sig], r) => {
    const on = st.sel.key && same(st.sel.key.v, k);
    return `<button class="ci-key${on ? ' on' : ''}${on && st.sel.key.ai ? ' ai' : ''}" data-key="${k}" aria-pressed="${!!on}"><b>${pretty(k)}</b><small>${sig}</small></button>`;
  };
  const draw = () => {
    if (!st.alive) return;
    const r = cur();
    if (!r) {
      body.innerHTML = `<div class="ci-empty"><h2>All done</h2><p class="muted">Every sheet has a key and a version${st.done ? ` — ${st.done} filled in just now` : ''}.</p>
        ${st.hidden ? `<p class="muted">${st.hidden} hidden as “Don't know”.</p><button id="ci-again">Show them again</button>` : ''}
        ${st.back.length ? '<button id="ci-back">‹ Back to the last one</button>' : ''}</div>`;
      $('#ci-again', body)?.addEventListener('click', showAgain);
      $('#ci-back', body)?.addEventListener('click', back);
      return;
    }
    const it = live(r), sk = st.sel.key, sv = st.sel.version;
    const typedKey = sk && ![...MAJORS, ...MINORS].some(([k]) => same(k, sk.v));
    const sug = (f) => (r.suggest?.[f] ? `<span class="ci-sug" title="${esc(r.suggest[f].why)}">Suggested: <b>${esc(f === 'key' ? pretty(r.suggest[f].value) : (VERS.find(([v]) => v === r.suggest[f].value)?.[1] || r.suggest[f].value))}</b> · ${esc(r.suggest[f].why)}</span>` : '');
    const pic = it.kind === 'sheet' && (it.pageFiles?.length || r.pages) ? store.pageUrl(r.id, 1, it.updatedAt) : '';
    body.innerHTML = `<div class="ci${st.zoom ? ' zoomed' : ''}" id="ci-card">
      <figure class="ci-pic" id="ci-pic" ${pic ? 'role="button" tabindex="0" aria-label="Zoom page 1"' : ''}>
        ${pic ? `<img src="${pic}" alt="Page 1 of ${esc(r.title)}" draggable="false"><span class="ci-zoomhint">${st.zoom ? 'Tap to fit' : 'Tap to zoom'}</span>`
    : `<div class="ci-nopic">${r.kind === 'score' ? 'A score — no page photo.' : r.kind === 'chords' ? 'A chord chart.' : 'No page image.'}<br><a href="#/item/${encodeURIComponent(r.id)}">Open it ›</a></div>`}
      </figure>
      <section class="ci-side">
        <div class="ci-head">
          <span class="ci-count">${st.i + 1} of ${st.q.length}${st.done ? ` · ${st.done} done` : ''}${r.skipped ? ' · skipped before' : ''}</span>
          <h2 id="ci-title">${esc(r.title)}</h2>
          <p class="muted">${esc([r.artist, r.kind === 'sheet' ? `${r.pages} page${r.pages === 1 ? '' : 's'}` : r.kind === 'score' ? 'Score' : 'Chord chart'].filter(Boolean).join(' · '))} · <a href="#/item/${encodeURIComponent(r.id)}">Open</a></p>
        </div>
        <div class="ci-field">
          <div class="ci-lab"><b>Key</b>${sk?.saved ? `<span class="ci-ok">✓ ${esc(pretty(sk.v))}</span>` : ''}${sug('key')}</div>
          <div class="ci-keys" id="ci-keys" role="group" aria-label="Major keys">${MAJORS.map((k) => keyBtn(k, r)).join('')}</div>
          <div class="ci-keys minor" role="group" aria-label="Minor keys">${MINORS.map((k) => keyBtn(k, r)).join('')}</div>
          <form class="ci-otherrow" id="ci-form" autocomplete="off"><input id="ci-other" class="${typedKey ? 'on' : ''}" placeholder="Other key: F#m, Db major…" value="${typedKey ? esc(pretty(sk.v)) : ''}" aria-label="Other key" autocapitalize="off" spellcheck="false" enterkeyhint="done"><button type="submit" id="ci-set">Set</button></form>
          ${st.err ? `<p class="ci-err" role="alert">${esc(st.err)}</p>` : ''}
        </div>
        ${needVersion(r) ? `<div class="ci-field">
          <div class="ci-lab"><b>Version</b>${sv?.saved ? `<span class="ci-ok">✓ ${esc(VERS.find(([v]) => v === sv.v)?.[1] || sv.v)}</span>` : ''}${sug('version')}</div>
          <div class="ci-vers" id="ci-vers" role="group" aria-label="Version">${VERS.map(([v, l, d], n) => {
    const on = sv?.v === v;
    return `<button class="ci-ver${on ? ' on' : ''}${on && sv.ai ? ' ai' : ''}" data-ver="${v}" aria-pressed="${on}"><b>${l}</b><small>${d}</small>${isDesktop() ? `<kbd>${n + 1}</kbd>` : ''}</button>`;
  }).join('')}</div></div>` : ''}
        <div class="ci-acts">
          <button id="ci-prev" ${st.back.length ? '' : 'disabled'} aria-label="Back to the last one">‹ Back</button>
          <button id="ci-skip">Skip</button>
          <button id="ci-dunno">Don't know</button>
          <button class="primary" id="ci-next" ${complete(r) ? '' : 'disabled'}>Save &amp; next ›</button>
        </div>
        <p class="ci-foot muted">${st.hidden ? `${st.hidden} hidden as “Don't know” · <button class="link" id="ci-again">Show again</button>` : ''}
          ${isDesktop() ? '<span class="ci-keyshelp">Keys: 1–4 version · type a key + Enter · Enter next · S skip · X don’t know · ← back · Space zoom</span>' : ''}</p>
      </section></div>`;
  };

  body.onclick = (e) => {
    const k = e.target.closest('[data-key]'); if (k) return pick('key', k.dataset.key);
    const v = e.target.closest('[data-ver]'); if (v) return pick('version', v.dataset.ver);
    if (e.target.closest('#ci-pic') && $('#ci-pic img', body)) { st.zoom = !st.zoom; $('#ci-card', body)?.classList.toggle('zoomed', st.zoom); const h = $('.ci-zoomhint', body); if (h) h.textContent = st.zoom ? 'Tap to fit' : 'Tap to zoom'; return; }
    const id = e.target.closest('button')?.id;
    if (id === 'ci-next') next(); else if (id === 'ci-skip') skip(); else if (id === 'ci-dunno') dunno(); else if (id === 'ci-prev') back(); else if (id === 'ci-again') showAgain();
  };
  body.onsubmit = (e) => { if (e.target.id === 'ci-form') { e.preventDefault(); typed(); } };
  const onKey = (e) => {
    if (!cur() || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-wrap, .menu')) return;
    const inInput = e.target.closest?.('input, textarea, select');
    if (inInput) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape' && st.zoom) { $('#ci-pic img', body)?.click(); return; }
    if (/^[1-4]$/.test(e.key) && needVersion(cur()) && VERS[+e.key - 1]) { e.preventDefault(); pick('version', VERS[+e.key - 1][0]); }
    else if (/^[a-gA-G]$/.test(e.key)) { e.preventDefault(); const inp = $('#ci-other', body); inp.value = e.key.toUpperCase(); inp.focus(); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 's' || e.key === 'S') skip();
    else if (e.key === 'x' || e.key === 'X') dunno();
    else if (e.key === ' ') { e.preventDefault(); $('#ci-pic img', body)?.click(); }
  };
  document.addEventListener('keydown', onKey);
  load();
  return () => { st.alive = false; clearTimeout(st.timer); document.removeEventListener('keydown', onKey); };
}
