// Manage library → Complete info (#/manage/info): the sheets the AI fill could not name a Key or Version for,
// one card at a time — the WHOLE page fitted in its frame (tap: zoom; the strip under it shows the other pages),
// then two choices and one save:
//   Key      common keys (with their key signature: 1♯, 2♭ …) or any other key typed ("F#m", "Db major")
//   Version  Lead · Piano · Duet · Accompaniment
// Nothing moves on by itself: pick Key and Version (a value the item already has counts as picked), then
// "Save & next" — one PATCH with both fields (one Activities row, Undo works). The AI's guess (server:
// completeinfo.py) is only a dashed hint, never a pick. The save runs in the background: the next card comes at
// once; a failed save shows a bar with Retry. Skip = later (to the end); Don't know = hidden until "Show again".
// Both are kept on the Mac, so every device has the same queue.
// Taps: pointerdown + pointerup on the same button acts at once (iPad: no lost taps, no 300 ms wait); the click
// that follows is ignored. The card is drawn once per song; a pick only changes classes (no re-render mid-tap).
// The header (views/manage.js) shows "N of M" and a progress bar (onProgress). The bottom bar: ‹ Back · Skip · Don't know · Save & next.
// Mac keys (? lists them): 1–4 version · type a key (A–G…) + Enter · Enter = Save & next (when on) · S skip · X don't know · ← back · Space zoom.
import { store } from '../store.js';
import { isDesktop } from '../device.js';
import { $, esc, toast, sheet as modal, unsaved } from '../ui.js';
import { SHEET_VERSIONS } from './actions.js';
import { pageSrc } from './sheet.js';

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((typeof data.detail === 'string' && data.detail) || `The Mac said no (${r.status}).`);
  return data;
};

// keys as the sheets store them ('Bb', 'F#m'); sig = its key signature, a help for reading page 1
const MAJORS = [['C', '0'], ['G', '1♯'], ['D', '2♯'], ['A', '3♯'], ['E', '4♯'], ['F', '1♭'], ['Bb', '2♭'], ['Eb', '3♭'], ['Ab', '4♭']];
const MINORS = [['Am', '0'], ['Em', '1♯'], ['Bm', '2♯'], ['Dm', '1♭'], ['Gm', '2♭'], ['Cm', '3♭']];
const VERS = [['lead', 'Lead', 'melody + chords', 'Lead'], ['piano', 'Piano', 'both hands', 'Piano'], ['duet', 'Duet', 'two players', 'Duet'], ['accomp', 'Accompaniment', 'no melody', 'Accomp.']]
  .filter(([v]) => v in SHEET_VERSIONS);
export const pretty = (k) => String(k || '').replace(/^([A-G])b/, '$1♭').replace(/^([A-G])#/, '$1♯');
const verName = (v) => VERS.find(([x]) => x === v)?.[1] || v;

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

// "1 sharp in the key signature" for a key (as stored: 'G', 'Bbm', 'F#m'), '' when not a common key
const SIG = Object.fromEntries([...MAJORS, ...MINORS]);
const sigText = (k) => {
  const sg = SIG[k]; if (sg == null) return '';
  if (sg === '0') return 'No sharps or flats in the key signature';
  const n = +sg[0], sharp = sg[1] === '♯';
  return `${n} ${sharp ? 'sharp' : 'flat'}${n > 1 ? 's' : ''} in the key signature`;
};
const KEYS_HELP = [['1–4', 'Version'], ['A–G (+ Enter)', 'Type a key: “eb”, “f#m”…'], ['Enter / →', 'Save & next (when both are set)'], ['S', 'Skip'], ['X', 'Don’t know'], ['← / Backspace', 'Back to the last one'], ['Space', 'Zoom the page']];

// page pictures, loaded off-page and put in only once decoded (no wrong size, no half picture, no stale song)
const pics = new Map(); // src -> { im, ready: Promise<boolean> }
function loadPic(src) {
  let c = pics.get(src);
  if (!c) {
    const im = new Image();
    im.draggable = false; im.decoding = 'async';
    c = { im };
    c.ready = new Promise((res) => {
      im.onload = () => (im.naturalWidth ? im.decode().catch(() => {}).then(() => res(true)) : res(false));
      im.onerror = () => res(false);
    });
    im.src = src;
    pics.set(src, c);
    while (pics.size > 6) pics.delete(pics.keys().next().value);
  }
  return c;
}

export function completeInfoView(body, { onProgress = () => {} } = {}) {
  if (store.mode !== 'server') { body.innerHTML = '<p class="pad muted">Complete info needs the Mac.</p>'; return; }
  // sel[f] = {v, how: 'have' (the item has it: picked and confirmed) | 'user' (tapped here)}
  const st = { q: null, hidden: 0, i: 0, sel: {}, back: [], done: 0, zoom: false, alive: true, err: '', gen: 0, saves: new Map(), retry: 0, pg: 1, other: false };
  const cur = () => st.q?.[st.i];
  const live = (r) => store.get(r.id) || r;
  const badge = () => onProgress({ at: Math.min(st.i + 1, st.q?.length || 0), left: st.q?.length || 0, done: st.done });
  const needVersion = (r) => r.kind === 'sheet' || r.kind === 'chords';
  const complete = (r) => !!r && !!st.sel.key && (!needVersion(r) || !!st.sel.version);
  // a pick not saved yet, or a save still going / failed: no auto-reload meanwhile (update.js)
  const mark = () => unsaved(body, Object.values(st.sel).some((s) => s?.how === 'user') || [...st.saves.values()].some((s) => s.status !== 'done'));

  const load = async () => {
    body.innerHTML = '<p class="pad muted">Loading…</p>';
    try { const r = await api('GET', '/completeinfo'); st.q = r.items; st.hidden = r.hidden; st.i = 0; } catch (e) { body.innerHTML = `<p class="pad muted">${esc(e.message)}</p>`; return; }
    start(); badge();
  };

  // a new card: what the item has now counts as picked; the AI guess is only a hint
  const start = (sel) => {
    const r = cur();
    st.sel = {}; st.err = ''; st.zoom = false; st.pg = 1; st.other = false;
    if (r) {
      const it = live(r);
      for (const f of ['key', 'version']) {
        if (f === 'version' && !needVersion(r)) continue;
        if (sel?.[f]) st.sel[f] = { ...sel[f] };
        else if (!isMissing(it[f])) st.sel[f] = { v: it[f], how: 'have' };
      }
    }
    mark(); draw();
  };

  const pick = (f, v) => {
    const r = cur(); if (!r) return;
    if (f === 'key') v = normKey(v, r.kind) || v;
    st.sel[f] = { v, how: 'user' }; st.err = '';
    mark(); paint();
  };

  // ---------- saving: one PATCH per card, in the background ----------
  const save = async (s) => {
    s.status = 'saving'; s.msg = ''; drawSaves();
    try {
      const fresh = await api('PATCH', `/items/${encodeURIComponent(s.r.id)}`, s.patch);
      if (fresh?.id) store.putItem(fresh);
      if (s.r.skipped) api('DELETE', `/completeinfo/${encodeURIComponent(s.r.id)}/mark`).catch(() => {});
      st.saves.delete(s.r.id);
    } catch (e) { s.status = 'failed'; s.msg = e.message || 'No answer from the Mac'; }
    mark(); drawSaves();
  };
  const next = () => {
    const r = cur(); if (!complete(r)) return;
    const it = live(r), patch = {};
    for (const f of ['key', 'version']) { const s = st.sel[f]; if (s && s.how === 'user' && s.v !== it[f]) patch[f] = s.v; }
    if (Object.keys(patch).length) { const s = { r, patch }; st.saves.set(r.id, s); save(s); }
    else if (r.skipped) api('DELETE', `/completeinfo/${encodeURIComponent(r.id)}/mark`).catch(() => {});
    st.back.push({ r, at: st.i, sel: { ...st.sel } });
    st.q.splice(st.i, 1); st.done++;
    if (st.i >= st.q.length) st.i = 0;
    badge(); start();
  };
  const back = () => {
    const b = st.back.pop(); if (!b) return;
    st.q.splice(Math.min(b.at, st.q.length), 0, b.r); st.i = Math.min(b.at, st.q.length - 1); st.done = Math.max(0, st.done - 1);
    badge(); start(b.sel);
  };
  const skip = async () => {
    const r = cur(); if (!r) return;
    st.q.splice(st.i, 1); st.q.push({ ...r, skipped: Date.now() });
    if (st.i >= st.q.length - 1 && st.q.length > 1) st.i = 0;
    start();
    try { await api('PUT', `/completeinfo/${encodeURIComponent(r.id)}/mark`, { how: 'skip' }); } catch (e) { toast(e.message); }
  };
  const dunno = async () => {
    const r = cur(); if (!r) return;
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
    const inp = $('#ci-other', body), r = cur(); if (!inp || !r) return;
    const k = normKey(inp.value, r.kind);
    if (!k) { st.err = `“${inp.value}” is not a key — try C, F#m, Bb or Db major`; paint(); return; }
    inp.blur(); inp.value = pretty(k);
    pick('key', k);
  };
  // the strip under the page: show another page whole
  const page = (p) => {
    const r = cur(); if (!r || p === st.pg) return;
    st.pg = p;
    body.querySelectorAll('.ci-thumb').forEach((b) => b.classList.toggle('on', +b.dataset.p === p));
    showPic(r, ++st.gen);
  };
  const zoom = () => {
    if (!$('#ci-pic img', body)) return;
    st.zoom = !st.zoom;
    $('#ci-card', body)?.classList.toggle('zoomed', st.zoom);
    const h = $('.ci-zoomhint', body); if (h) h.textContent = st.zoom ? 'Tap to fit' : 'Tap to zoom';
  };

  // ---------- the page picture ----------
  const picSrc = (r, pg = 1) => {
    const it = live(r);
    if (r.kind !== 'sheet') return '';
    if (it.pageFiles?.length) return pageSrc(it, Math.min(pg, it.pageFiles.length));
    return r.pages ? store.pageUrl(r.id, pg, it.updatedAt || r.updatedAt) : '';
  };
  const showPic = (r, g, src0) => {
    const fig = $('#ci-pic', body); if (!fig) return;
    const src = src0 || picSrc(r, st.pg);
    fig.dataset.state = 'loading';
    fig.querySelector('.ci-ph').innerHTML = `<span class="ci-spin" aria-hidden="true"></span><span>Loading page ${st.pg}…</span>`;
    const c = loadPic(src);
    const slow = setTimeout(() => {
      if (g !== st.gen || fig.dataset.state !== 'loading') return;
      fig.querySelector('.ci-ph').innerHTML = `<span class="ci-spin" aria-hidden="true"></span><span>Still loading page ${st.pg}…</span><button class="ci-retry" data-act="retry">Retry</button>`;
    }, 6000);
    c.ready.then((ok) => {
      clearTimeout(slow);
      if (g !== st.gen || !st.alive || !fig.isConnected) return;  // another card by now: never show its page here
      if (!ok) {
        pics.delete(src);
        fig.dataset.state = 'error';
        fig.querySelector('.ci-ph').innerHTML = `<span>Couldn’t load page ${st.pg}.</span><button class="ci-retry" data-act="retry">Retry</button>`;
        return;
      }
      const im = c.im;
      im.alt = `Page ${st.pg} of ${r.title}`;
      im.className = 'ci-img';
      fig.querySelector('.ci-img')?.remove();
      fig.prepend(im);
      fig.dataset.state = 'ok';
      // the next card's page, ahead
      const n = st.q?.[st.i + 1]; if (n) { const s = picSrc(n); if (s) loadPic(s); }
    });
  };
  const retryPic = () => {
    const r = cur(); if (!r) return;
    const src = picSrc(r, st.pg); pics.delete(src);
    showPic(r, st.gen, `${src}${src.includes('?') ? '&' : '?'}retry=${++st.retry}`);
  };

  // ---------- drawing: draw() = a new card; paint() = the picks only ----------
  const keyBtn = ([k]) => `<button type="button" class="ci-key" data-key="${k}" aria-pressed="false"><b>${pretty(k)}</b></button>`;
  const savesHtml = () => {
    const bad = [...st.saves.values()].filter((s) => s.status === 'failed');
    const busy = [...st.saves.values()].filter((s) => s.status === 'saving').length;
    return bad.map((s) => `<div class="ci-savefail" role="alert"><span>Couldn’t save “${esc(s.r.title)}”: ${esc(s.msg)}</span><button type="button" data-act="resave" data-id="${esc(s.r.id)}">Retry</button></div>`).join('')
      + (busy ? `<div class="ci-saving muted">Saving${busy > 1 ? ` ${busy}` : ''}…</div>` : '');
  };
  const drawSaves = () => { const el = $('#ci-saves', body); if (el) el.innerHTML = savesHtml(); };

  const draw = () => {
    if (!st.alive) return;
    st.gen++;
    const r = cur();
    if (!r) {
      body.innerHTML = `<div class="ci-empty"><div id="ci-saves" class="ci-saves">${savesHtml()}</div><h2>All done</h2><p class="muted">Every sheet has a key and a version${st.done ? ` — ${st.done} filled in just now` : ''}.</p>
        ${st.hidden ? `<p class="muted">${st.hidden} hidden as “Don't know”.</p><button type="button" id="ci-again" data-act="again">Show them again</button>` : ''}
        ${st.back.length ? '<button type="button" id="ci-back" data-act="back">‹ Back to the last one</button>' : ''}</div>`;
      return;
    }
    const sug = (f) => (r.suggest?.[f] ? `<span class="ci-ai" title="${esc(r.suggest[f].why)}">Suggested: ${esc(f === 'key' ? pretty(r.suggest[f].value) : verName(r.suggest[f].value))}</span>` : '');
    const pic = picSrc(r), np = r.kind === 'sheet' ? Math.min(r.pages || 1, 12) : 0;
    body.innerHTML = `<div class="ci" id="ci-card">
      <div class="ci-prev">
        <div id="ci-saves" class="ci-saves">${savesHtml()}</div>
        <div class="ci-head"><h2 id="ci-title">${esc(r.title)}</h2>
          <span class="muted small">${esc([r.artist, r.kind === 'sheet' ? `${r.pages} page${r.pages === 1 ? '' : 's'}` : r.kind === 'score' ? 'Score' : 'Chord chart'].filter(Boolean).join(' · '))}${r.skipped ? ' · skipped before' : ''}</span>
          <span class="grow"></span><a class="small ci-open" href="#/item/${encodeURIComponent(r.id)}">Open sheet</a></div>
        <figure class="ci-pic" id="ci-pic" ${pic ? 'data-act="zoom" role="button" tabindex="0" aria-label="Zoom the page"' : ''}>
          ${pic ? `<div class="ci-ph"></div><span class="ci-zoomhint">Tap to zoom</span>`
    : `<div class="ci-nopic">${r.kind === 'score' ? 'A score — no page photo.' : r.kind === 'chords' ? 'A chord chart.' : 'No page image.'}<br><a href="#/item/${encodeURIComponent(r.id)}">Open it ›</a></div>`}
        </figure>
        ${pic && np > 1 ? `<div class="ci-strip" role="group" aria-label="Pages">${Array.from({ length: np }, (_, k) => `<button type="button" class="ci-thumb" data-act="pg" data-p="${k + 1}" aria-label="Page ${k + 1}"><img src="/api/items/${encodeURIComponent(r.id)}/thumb/${k + 1}?w=120&v=${live(r).updatedAt || 0}" alt="" draggable="false" loading="lazy"></button>`).join('')}<span class="muted small">Tap a page to see it whole</span></div>` : ''}
      </div>
      <div class="ci-form">
        <div class="ci-field">
          <div class="ci-lab"><b>Key</b>${sug('key')}<span class="ci-ok" id="ci-okkey"></span></div>
          <div class="ci-keys" id="ci-keys" role="group" aria-label="Major keys">${MAJORS.map(keyBtn).join('')}</div>
          <div class="ci-keys minor" role="group" aria-label="Minor keys">${MINORS.map(keyBtn).join('')}<button type="button" class="ci-key ci-more" id="ci-more" data-act="other" aria-expanded="false">Other…</button></div>
          <form class="ci-otherrow" id="ci-form" autocomplete="off" hidden><input id="ci-other" placeholder="Other key: F#m, Db major…" aria-label="Other key" autocapitalize="off" spellcheck="false" enterkeyhint="done"><button type="button" id="ci-set" data-act="set">Set</button></form>
          <p class="ci-sig muted small" id="ci-sig"></p>
          <p class="ci-err" id="ci-err" role="alert" hidden></p>
        </div>
        ${needVersion(r) ? `<div class="ci-field">
          <div class="ci-lab"><b>Version</b>${sug('version')}<span class="ci-ok" id="ci-okver"></span></div>
          <div class="ci-vers" id="ci-vers" role="group" aria-label="Version">${VERS.map(([v, , d, short], n) => `<button type="button" class="ci-ver" data-ver="${v}" aria-pressed="false"><b>${short}</b><small>${d}</small>${isDesktop() ? `<kbd>${n + 1}</kbd>` : ''}</button>`).join('')}</div></div>` : ''}
        <p class="ci-foot muted">${st.hidden ? `${st.hidden} hidden as “Don't know” · <button type="button" class="link" id="ci-again" data-act="again">Show again</button>` : ''}</p>
      </div></div>
      <div class="ci-acts">
        <button type="button" class="ghost" id="ci-prev" data-act="back" ${st.back.length ? '' : 'disabled'} aria-label="Back to the last one">‹<span class="hide-phone"> Back</span></button>
        <button type="button" id="ci-skip" data-act="skip">Skip</button>
        <button type="button" id="ci-dunno" data-act="dunno">Don't know</button>
        <span class="grow hide-phone"></span>
        ${isDesktop() ? '<button type="button" class="ghost" id="ci-keyshelp" data-act="keys" aria-label="Keys" title="Keys">?</button>' : ''}
        <button type="button" class="primary" id="ci-next" data-act="next" disabled>Save &amp; next ›</button>
      </div>`;
    badge();
    (body.closest('#main') || body).scrollTop = 0;  // a new song starts at its top (iPhone: the page, not the buttons of the last one)
    const inp = $('#ci-other', body), sk = st.sel.key;
    if (sk && ![...MAJORS, ...MINORS].some(([k]) => same(k, sk.v))) { inp.value = pretty(sk.v); st.other = true; }
    paint();
    if (pic) showPic(r, st.gen);
  };

  const paint = () => {
    const r = cur(); if (!r || !$('#ci-card', body)) return;
    const sk = st.sel.key, sv = st.sel.version, hk = r.suggest?.key?.value, hv = r.suggest?.version?.value;
    body.querySelectorAll('.ci-key').forEach((b) => {
      const on = !!sk && same(sk.v, b.dataset.key);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      b.classList.toggle('hint', !sk && !!hk && same(hk, b.dataset.key));
    });
    body.querySelectorAll('.ci-ver').forEach((b) => {
      const on = sv?.v === b.dataset.ver;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      b.classList.toggle('hint', !sv && hv === b.dataset.ver);
    });
    const inp = $('#ci-other', body);
    const typedKey = !!sk && ![...MAJORS, ...MINORS].some(([k]) => same(k, sk.v));
    inp.classList.toggle('on', typedKey);
    if (sk && !typedKey && document.activeElement !== inp) inp.value = '';
    const open = st.other || typedKey;
    $('#ci-form', body).hidden = !open;
    const more = $('#ci-more', body); more.setAttribute('aria-expanded', open); more.classList.toggle('on', typedKey);
    const sigOf = sk ? sigText(sk.v) : hk ? sigText(normKey(hk) || hk) : '';
    $('#ci-sig', body).textContent = sigOf;
    const ok = (el, s, name) => { if (el) el.textContent = s ? `✓ ${name(s.v)}${s.how === 'have' ? ' (already set)' : ''}` : ''; };
    ok($('#ci-okkey', body), sk, pretty); ok($('#ci-okver', body), sv, verName);
    body.querySelectorAll('.ci-thumb').forEach((b) => b.classList.toggle('on', +b.dataset.p === st.pg));
    const e = $('#ci-err', body); e.hidden = !st.err; e.textContent = st.err;
    const nx = $('#ci-next', body); nx.disabled = !complete(r);
    nx.title = complete(r) ? '' : needVersion(r) && !sv ? (sk ? 'Pick a version' : 'Pick a key and a version') : 'Pick a key';
  };

  // ---------- taps ----------
  const act = (el) => {
    if (el.disabled) return;
    if (el.dataset.key) return pick('key', el.dataset.key);
    if (el.dataset.ver) return pick('version', el.dataset.ver);
    switch (el.dataset.act) {
      case 'next': return next();
      case 'skip': return skip();
      case 'dunno': return dunno();
      case 'back': return back();
      case 'again': return showAgain();
      case 'set': return typed();
      case 'zoom': return zoom();
      case 'other': { st.other = !st.other || !!st.err; paint(); if (st.other) $('#ci-other', body)?.focus(); return; }
      case 'pg': return page(+el.dataset.p);
      case 'keys': return modal(`<h2>Keys</h2><table class="pe-keys">${KEYS_HELP.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
      case 'retry': return retryPic();
      case 'resave': { const s = st.saves.get(el.dataset.id); if (s) save(s); }
    }
  };
  const target = (e) => e.target.closest?.('button, [data-act]');
  // a tap = down and up on the same button, hardly moved (a scroll is a pointercancel); act on the up
  let down = null, tapped = 0;
  body.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !e.isPrimary) return;
    const el = target(e);
    down = el && body.contains(el) ? { el, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
  });
  body.addEventListener('pointercancel', () => { down = null; });
  body.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || d.id !== e.pointerId || !d.el.isConnected) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 16) return;
    const b = d.el.getBoundingClientRect(), m = 10;
    if (e.clientX < b.left - m || e.clientX > b.right + m || e.clientY < b.top - m || e.clientY > b.bottom + m) return;
    if (d.el.id === 'ci-other') return;
    tapped = Date.now();
    act(d.el);
  });
  // the click after a handled tap is dropped; a click with no tap before it (keyboard, VoiceOver) acts
  body.addEventListener('click', (e) => {
    const el = target(e); if (!el) return;
    if (Date.now() - tapped < 700) { e.preventDefault(); return; }
    act(el);
  });
  body.addEventListener('submit', (e) => { if (e.target.id === 'ci-form') { e.preventDefault(); typed(); } });

  const onKey = (e) => {
    if (!cur() || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-wrap, .menu')) return;
    const inInput = e.target.closest?.('input, textarea, select');
    if (inInput) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape' && st.zoom) { zoom(); return; }
    if (/^[1-4]$/.test(e.key) && needVersion(cur()) && VERS[+e.key - 1]) { e.preventDefault(); pick('version', VERS[+e.key - 1][0]); }
    else if (/^[a-gA-G]$/.test(e.key)) { e.preventDefault(); st.other = true; paint(); const inp = $('#ci-other', body); inp.value = e.key.toUpperCase(); inp.focus(); }
    else if (e.key === '?') { e.preventDefault(); act({ dataset: { act: 'keys' } }); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); if (complete(cur())) next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 's' || e.key === 'S') skip();
    else if (e.key === 'x' || e.key === 'X') dunno();
    else if (e.key === ' ') { e.preventDefault(); zoom(); }
  };
  document.addEventListener('keydown', onKey);
  load();
  return () => { st.alive = false; document.removeEventListener('keydown', onKey); };
}
