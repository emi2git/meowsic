// Clean up → Versions: the library's items that are the same song (same title once "(C)", "(Easy Piano)",
// "- Sheet Music", " — p7"… are ignored, or score versions of one recording), one song at a time, every
// version side by side. Mark each Keep or Delete ("Keep only this one" marks the others); the marks are kept
// on the Mac (versions.py), so you can stop and go on later. "Not the same song" hides a group for good.
// Finish lists what is marked, then moves it to the Trash (Undo brings it back); deleting for good is a
// second step. Every action can be undone (Clean up's Undo, U or Z).
import { store } from '../store.js';
import { go } from '../app.js';
import { $, esc, toast, badge, confirmSheet } from '../ui.js';
import { VERSIONS } from '../musicxml.js';

export const VERSION_KEYS = [
  ['← / →', 'Previous / next song'],
  ['1 – 9', 'Delete / keep that version (again: the other way)'],
  ['K', 'Keep all versions of this song'],
  ['U / Z', 'Undo'],
];

const api = async (method, path, body) => {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || 'The Mac said no.');
  return data;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const KIND_WORD = { sheet: 'Sheet', score: 'Score', chords: 'Chord chart' };

let cssOn = false;
const css = () => { if (cssOn) return; cssOn = true; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/cleanup-versions.css'; document.head.append(l); };

// a score's first lines, drawn once per version of the file (kept while the app is open)
const scoreArt = new Map();
let osmdQ = Promise.resolve();
const drawScore = (el, it) => (osmdQ = osmdQ.then(async () => {
  const k = `${it.id}:${it.updatedAt}`;
  if (!scoreArt.has(k)) {
    let svg = '';
    try {
      const { loadOsmd } = await import('./score.js');
      await loadOsmd();
      const r = await fetch(`/api/items/${encodeURIComponent(it.id)}/musicxml`);
      if (!r.ok) throw 0;
      const xml = (await r.text()).replace(/<direction(?:\s[^>]*)?>\s*<direction-type>\s*<words\s*\/>\s*<\/direction-type>[\s\S]*?<\/direction>/g, '');
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:-9999px;top:0;width:640px';
      document.body.append(box);
      try {
        const o = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(box, { autoResize: false, backend: 'svg', drawTitle: true, drawSubtitle: false,
          drawComposer: false, drawPartNames: false, drawCredits: false, drawMeasureNumbers: false, drawUpToMeasureNumber: 8 });
        await o.load(xml); o.zoom = 0.7; o.render();
        svg = box.innerHTML;
      } finally { box.remove(); }
    } catch { svg = ''; }
    scoreArt.set(k, svg);
  }
  if (!el.isConnected) return;
  const svg = scoreArt.get(k);
  el.innerHTML = svg || '<span class="vv-none">Could not draw this score</span>';
  el.classList.add('drawn');
}));

// a chord chart's first lines: chords above the words, like the chart itself
const chordLines = (text) => String(text || '').split('\n').filter((l) => l.trim() && !/^\{(?!c:|comment:)/.test(l.trim())).slice(0, 12)
  .map((l) => {
    const c = /^\{(?:c|comment):\s*(.*)\}$/.exec(l.trim());
    if (c) return `<i>${esc(c[1])}</i>`;
    let words = '', chords = '';
    for (const [, ch, w] of l.matchAll(/(?:\[([^\]]*)\])?([^[]*)/g)) {
      if (ch) { if (chords.length > words.length) words = words.padEnd(chords.length, ' '); chords = chords.padEnd(words.length, ' ') + ch + ' '; }
      words += w;
    }
    return (chords.trim() ? `<b>${esc(chords.trimEnd())}</b>\n` : '') + esc(words);
  }).join('\n');

// ctx: { body, st (Clean up state, for st.undo), busy(fn), undo(), help(), drawHead(), tab(name) }
export function makeVersions(ctx) {
  const { body, st } = ctx;
  css();
  let key0 = null; try { key0 = localStorage.getItem('meowsic-cu-vkey'); } catch {}
  const vs = { data: null, key: key0, show: 'all', summary: false, done: null, loading: false };
  const visible = () => (vs.data?.groups || []).filter((g) => (vs.show === 'notsame' ? g.notSame : !g.notSame) && (vs.show !== 'todo' || g.ids.some((i) => !vs.data.decisions[i])));
  const allShown = () => (vs.data?.groups || []).filter((g) => !g.notSame);
  const group = () => visible().find((g) => g.key === vs.key) || null;
  const dec = (id) => vs.data?.decisions[id] || null;
  const toDelete = () => allShown().flatMap((g) => g.ids.filter((i) => dec(i) === 'delete'));
  const card = (id) => vs.data.items[id] || store.get(id) || { id, title: '?', kind: 'sheet', tags: [] };

  const load = async () => { vs.data = await api('GET', '/versions'); };

  const draw = async () => {
    if (!vs.data) {
      if (vs.loading) return;
      vs.loading = true;
      if (!body.querySelector('.vv')) body.innerHTML = '<p class="pad muted">Looking for songs you have more than once…</p>';
      try { await load(); } catch (e) { toast(e.message); vs.loading = false; return; }
      vs.loading = false;
      if (st.tab !== 'versions') return;
    }
    document.querySelector('.cu-tabs button.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); // iPhone: the tabs scroll sideways
    if (vs.done) return drawDone();
    if (vs.summary) return drawSummary();
    render();
  };

  const counts = () => vs.data.counts;
  const chips = () => {
    const all = allShown(), todo = all.filter((g) => g.ids.some((i) => !dec(i))).length, ns = counts().notSame;
    return [['all', 'All songs', all.length], ['todo', 'Not decided', todo], ...(ns ? [['notsame', 'Not the same', ns]] : [])]
      .map(([k, l, n]) => `<button data-show="${k}" class="${vs.show === k ? 'on' : ''}">${l} <i>${n}</i></button>`).join('');
  };

  const render = () => {
    const list = visible();
    if (!list.some((g) => g.key === vs.key)) vs.key = list[0]?.key || null;
    try { if (vs.key) localStorage.setItem('meowsic-cu-vkey', vs.key); } catch {}
    const g = group(), nDel = toDelete().length, c = counts();
    const top = `<div class="vv-top">
        <div class="cu-filter vv-show">${chips()}</div>
        <span class="muted small vv-count" id="vv-count">${plural(c.groups, 'song')} · ${plural(c.items, 'item')}</span>
        <span class="grow"></span>
        <button id="vv-finish" class="${nDel ? 'danger-btn' : 'ghost'}" ${nDel ? '' : 'disabled'}>Finish<span class="vv-long"> — delete</span> ${nDel} ›</button></div>`;
    if (!g) {
      body.innerHTML = `<div class="vv">${top}<p class="pad muted vv-empty">${vs.show === 'todo' && c.groups ? `Every song is decided ✓${nDel ? ` — ${nDel} marked to delete: tap Finish.` : ''}`
        : vs.show === 'notsame' ? 'No songs marked “not the same”.' : 'No song is in the library more than once. 🎉'}</p></div>`;
      return wire();
    }
    const pos = list.indexOf(g), n = g.ids.length;
    const cols = Math.min(n, innerWidth >= 1200 ? 3 : innerWidth > 760 ? 2 : 1);
    body.innerHTML = `<div class="vv">${top}
      <div class="vv-head">
        <button id="vv-prev" class="ghost vv-arrow" aria-label="Previous song" ${pos > 0 ? '' : 'disabled'}>‹</button>
        <div class="vv-title"><b id="vv-name">${esc(g.title)}</b>
          <small>${plural(n, 'version')} · song ${pos + 1} of ${list.length}${g.notSame ? ' · marked not the same' : ''}</small></div>
        <div class="vv-gbtn">
          <button id="vv-keepall" class="ghost" title="Keep all (K)">Keep all</button>
          <button id="vv-notsame" class="ghost">${g.notSame ? 'Same song after all' : 'Not the same song'}</button></div>
        <button id="vv-next" class="ghost vv-arrow" aria-label="Next song" ${pos < list.length - 1 ? '' : 'disabled'}>›</button>
      </div>
      <div class="vv-cards" id="vv-cards" style="--cols:${cols}">${g.ids.map((id, k) => cardHtml(card(id), k)).join('')}</div>
      ${cols < n ? `<div class="vv-dots" id="vv-dots">${g.ids.map((id, k) => `<span data-k="${k}" class="${dec(id) || ''}"></span>`).join('')}</div>` : ''}
    </div>`;
    wire();
    for (const el of body.querySelectorAll('.vv-art[data-score]')) drawScore(el, card(el.dataset.score));
    const cs = $('#vv-cards', body), dots = $('#vv-dots', body);
    if (dots) {
      const mark = () => { const w = cs.firstElementChild?.offsetWidth || 1, k = Math.round(cs.scrollLeft / (w + 12)); dots.querySelectorAll('span').forEach((s, i) => s.classList.toggle('at', i >= k && i < k + cols)); };
      cs.onscroll = mark; mark();
      dots.onclick = (e) => { const s = e.target.closest('[data-k]'); if (s) cs.children[+s.dataset.k]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); };
    }
  };

  const cardHtml = (it, k) => {
    const d = dec(it.id);
    const ver = it.kind === 'score' ? VERSIONS[it.version] || it.version : it.version;
    const facts = [it.kind === 'sheet' ? plural(it.pages || 0, 'page') : '', ver ? esc(ver) : '', it.key ? `key ${esc(it.key)}` : '', it.capo ? `capo ${it.capo}` : ''].filter(Boolean).join(' · ');
    const src = it.kind === 'sheet' ? (it.source === 'pdf' ? 'From a PDF' : 'Photos') : it.source ? esc(it.source) : '';
    let art;
    if (it.kind === 'sheet') art = it.pages ? `<img src="/api/items/${encodeURIComponent(it.id)}/thumb/1?w=600&v=${it.updatedAt || 0}" alt="" loading="lazy" draggable="false">` : '<span class="vv-none">No pages</span>';
    else if (it.kind === 'score') art = '<span class="vv-none">Drawing the score…</span>';
    else art = `<div class="vv-chords">${chordLines(it.text) || '<span class="vv-none">Empty chart</span>'}</div>`;
    return `<article class="vv-card ${d || ''}" data-id="${esc(it.id)}" data-k="${k}">
      <button class="vv-art ${it.kind}" data-open ${it.kind === 'score' ? `data-score="${esc(it.id)}"` : ''} aria-label="Open ${esc(it.title)}">${art}</button>
      <span class="vv-num" aria-hidden="true">${k + 1}</span>
      <span class="vv-flag">${d === 'delete' ? 'Will be deleted' : d === 'keep' ? 'Keep' : ''}</span>
      <div class="vv-meta">
        <b class="vv-t">${esc(it.title)}</b>
        <small>${badge(it.kind)} ${facts}</small>
        <small class="muted">${[src, it.artist ? esc(it.artist) : '', `added ${day(it.originAt || it.createdAt)}`, it.playCount ? `played ${plural(it.playCount, 'time')}` : 'never played'].filter(Boolean).join(' · ')}</small>
        ${it.tags?.length ? `<small class="vv-tags">${it.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</small>` : ''}
      </div>
      <div class="vv-btns">
        <button data-keep class="${d === 'keep' ? 'on' : ''}" aria-pressed="${d === 'keep'}">Keep</button>
        <button data-del class="${d === 'delete' ? 'on' : ''}" aria-pressed="${d === 'delete'}">Delete</button>
      </div>
      <div class="vv-btns2"><button data-only class="ghost">Keep only this one</button><button data-open class="ghost">Open ›</button></div>
    </article>`;
  };

  const wire = () => {
    body.querySelector('.vv-show').onclick = (e) => { const b = e.target.closest('[data-show]'); if (b) { vs.show = b.dataset.show; vs.key = visible()[0]?.key || null; render(); } };
    $('#vv-finish', body).onclick = () => { vs.summary = true; draw(); };
    $('#vv-prev', body)?.addEventListener('click', () => step(-1));
    $('#vv-next', body)?.addEventListener('click', () => step(1));
    $('#vv-keepall', body)?.addEventListener('click', keepAll);
    $('#vv-notsame', body)?.addEventListener('click', notSame);
    const cs = $('#vv-cards', body);
    if (cs) cs.onclick = (e) => {
      const c = e.target.closest('.vv-card'); if (!c) return;
      const id = c.dataset.id;
      if (e.target.closest('[data-open]')) return go(`#/item/${id}`);
      if (e.target.closest('[data-keep]')) return set({ [id]: dec(id) === 'keep' ? null : 'keep' }, 'keep');
      if (e.target.closest('[data-del]')) return set({ [id]: dec(id) === 'delete' ? null : 'delete' }, 'delete mark');
      if (e.target.closest('[data-only]')) return keepOnly(id);
    };
  };

  const step = (d) => {
    const list = visible(), k = list.findIndex((g) => g.key === vs.key);
    const nx = list[k + d];
    if (!nx) return toast(d > 0 ? 'That was the last song' : 'That is the first song');
    vs.key = nx.key; render();
  };
  // after a whole song is decided: on to the next one still to decide (or the next one)
  const onward = () => {
    const list = visible(), k = list.findIndex((g) => g.key === vs.key);
    const nx = list.slice(k + 1).find((g) => g.ids.some((i) => !dec(i))) || list[k + 1];
    if (nx) vs.key = nx.key;
    render();
  };

  // marks: {id: keep | delete | null}; undo puts back what each one was
  const set = (marks, label, next = false) => ctx.busy(async () => {
    const g = group(); if (!g) return;
    const was = Object.fromEntries(Object.keys(marks).map((id) => [id, dec(id)]));
    if (Object.keys(marks).every((id) => marks[id] === was[id])) { if (next) onward(); return; }
    vs.data.decisions = (await api('POST', '/versions/decide', { key: g.key, set: marks })).decisions;
    const key = g.key;
    st.undo.push({ label, tab: 'versions', local: true, run: async () => {
      vs.data.decisions = (await api('POST', '/versions/decide', { key, set: was })).decisions;
      vs.summary = false; vs.done = null; vs.key = key;
      if (!visible().some((x) => x.key === key)) vs.show = 'all';
    } });
    ctx.drawHead();
    if (next) onward(); else render();
  });
  const keepOnly = (id) => { const g = group(); if (g) set(Object.fromEntries(g.ids.map((i) => [i, i === id ? 'keep' : 'delete'])), 'keep only one', true); };
  const keepAll = () => { const g = group(); if (g) set(Object.fromEntries(g.ids.map((i) => [i, 'keep'])), 'keep all', true); };
  const toggleNth = (n) => {
    const g = group(), id = g?.ids[n]; if (!id) return;
    set({ [id]: dec(id) === 'delete' ? 'keep' : 'delete' }, dec(id) === 'delete' ? 'keep' : 'delete mark');
    $('#vv-cards', body)?.children[n]?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  };

  const notSame = () => ctx.busy(async () => {
    const g = group(); if (!g) return;
    const on = !g.notSame, list = visible(), k = list.indexOf(g);
    vs.data = await api('POST', '/versions/notsame', { key: g.key, ids: g.ids, undo: !on });
    st.undo.push({ label: on ? 'not the same' : 'same song', tab: 'versions', local: true, run: async () => {
      vs.data = await api('POST', '/versions/notsame', { key: g.key, ids: g.ids, undo: on });
      vs.summary = false; vs.done = null; vs.key = g.key; vs.show = on ? 'all' : 'notsame';
    } });
    toast(on ? `“${g.title}” hidden — not the same song` : `“${g.title}” is back`);
    const after = visible(); vs.key = after[Math.min(k, after.length - 1)]?.key || null;
    if (!after.length && vs.show === 'notsame') vs.show = 'all';
    ctx.drawHead(); render();
  });

  // ---------- Finish: what is marked, then to the Trash ----------
  const drawSummary = () => {
    const ids = toDelete(), byGroup = allShown().map((g) => ({ g, del: g.ids.filter((i) => dec(i) === 'delete') })).filter((x) => x.del.length);
    const none = byGroup.filter((x) => x.del.length === x.g.ids.length);
    body.innerHTML = `<div class="vv vv-sum">
      <div class="vv-top"><button id="vv-back" class="ghost">‹ Back to the songs</button></div>
      <div class="vv-sumbody">
      <h2>${ids.length ? `${plural(ids.length, 'item')} to delete` : 'Nothing marked to delete'}</h2>
      <p class="muted">From ${plural(byGroup.length, 'song')}. Tap one to keep it after all.</p>
      ${none.length ? `<p class="vv-warn">No version would be left of: ${none.map((x) => `<b>${esc(x.g.title)}</b>`).join(', ')}</p>` : ''}
      ${byGroup.map(({ g, del }) => `<h3>${esc(g.title)} <small class="muted">${del.length} of ${g.ids.length}</small></h3><div class="sv-grid vv-sgrid">${del.map((id) => { const it = card(id); return `<button data-id="${esc(id)}" class="on">${it.kind === 'sheet' && it.pages ? `<img src="/api/items/${encodeURIComponent(id)}/thumb/1?w=240&v=${it.updatedAt || 0}" alt="" loading="lazy">` : `<div class="sv-nopage">${KIND_WORD[it.kind]}</div>`}<span>${esc(it.title)}</span><small>${KIND_WORD[it.kind]}${it.kind === 'sheet' ? ` · ${it.pages} p` : it.version ? ` · ${esc(VERSIONS[it.version] || it.version)}` : ''}</small></button>`; }).join('')}</div>`).join('')}
      </div>
      ${ids.length ? `<div class="sv-act"><button id="vv-go" class="danger-btn big">Delete ${plural(ids.length, 'item')}</button></div>` : ''}</div>`;
    $('#vv-back', body).onclick = () => { vs.summary = false; draw(); };
    body.querySelector('.vv-sumbody').onclick = (e) => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      const id = b.dataset.id, g = allShown().find((x) => x.ids.includes(id));
      ctx.busy(async () => {
        vs.data.decisions = (await api('POST', '/versions/decide', { key: g.key, set: { [id]: 'keep' } })).decisions;
        st.undo.push({ label: 'keep', tab: 'versions', local: true, run: async () => { vs.data.decisions = (await api('POST', '/versions/decide', { key: g.key, set: { [id]: 'delete' } })).decisions; vs.summary = true; vs.done = null; } });
        drawSummary();
      });
    };
    $('#vv-go', body)?.addEventListener('click', () => reallyDelete(ids));
  };

  const reallyDelete = (ids) => ctx.busy(async () => {
    if (!(await confirmSheet({ title: `Delete ${plural(ids.length, 'item')}?`, body: 'They go to the Trash now. Undo brings them back.', ok: 'Delete', danger: true }))) return;
    store.bin(ids);
    await api('POST', '/items/trash', { ids }); // (store.bin already asked; this waits until it is done)
    await api('POST', '/versions/decide', { clear: ids });
    const marks = Object.fromEntries(ids.map((i) => [i, 'delete']));
    st.undo.push({ label: `delete ${ids.length}`, tab: 'versions', local: true, run: async () => {
      store.restore(ids);
      await api('POST', '/items/restore', { ids });
      await api('POST', '/versions/decide', { set: marks });
      await load(); vs.done = null; vs.summary = true;
    } });
    store.logEvent('cleanup', `Deleted ${ids.length} versions`, 'Clean up → Versions');
    await load();
    vs.summary = false; vs.done = ids;
    ctx.drawHead(); draw();
  });
  const drawDone = () => {
    const ids = vs.done;
    body.innerHTML = `<div class="vv vv-sum"><div class="vv-sumbody"><h2>${plural(ids.length, 'item')} deleted</h2>
      <p class="muted">They are in the Trash for now. Undo brings them back.</p></div>
      <div class="sv-act"><button id="vv-again" class="primary big">Go on with the rest</button>
      <button id="vv-purge" class="danger-btn">Also remove them from the Trash for good…</button></div></div>`;
    $('#vv-again', body).onclick = () => { vs.done = null; draw(); };
    $('#vv-purge', body).onclick = async () => {
      if (!(await confirmSheet({ title: `Delete ${plural(ids.length, 'item')} for good?`, body: 'Their files are removed from the Mac. This cannot be undone.', ok: 'Delete for good', danger: true }))) return;
      store.purge(ids);
      await api('POST', '/items/purge', { ids }).catch(() => {});
      st.undo = st.undo.filter((u) => !(u.tab === 'versions' && u.label === `delete ${ids.length}`)); ctx.drawHead();
      toast(`${plural(ids.length, 'item')} deleted for good`);
      vs.done = null; draw();
    };
  };

  // ---------- keys (Mac) ----------
  const onKey = (e) => {
    const k = e.key;
    if (/^[1-9]$/.test(k) && !e.metaKey && !e.ctrlKey && !e.altKey) { if (vs.summary || vs.done) return; e.preventDefault(); return toggleNth(+k - 1); }
    const a = { ArrowRight: () => step(1), ArrowLeft: () => step(-1), k: keepAll, u: ctx.undo, z: ctx.undo, '?': ctx.help }[k.length === 1 ? k.toLowerCase() : k];
    if (!a || (e.metaKey && k.toLowerCase() !== 'z') || e.ctrlKey || e.altKey) return;
    if ((vs.summary || vs.done) && a !== ctx.undo && a !== ctx.help) return;
    e.preventDefault(); a();
  };

  return { draw, onKey };
}
