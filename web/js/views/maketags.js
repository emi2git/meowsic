// Make tags: pick what to look for, let the (offline) AI detect groups, review every proposed tag and
// its songs (rename, add, remove, skip), then apply. In this UI preview the detection is simulated
// from a small built-in song list; phase 2 runs the local LLM on the Mac.
import { store } from '../store.js';
import { $, esc, toast, sheet as modal, badge } from '../ui.js';
import { go } from '../app.js';

const OPTIONS = [
  ['work', 'Movie or musical', 'Frozen, Les Misérables, Cats…'],
  ['singer', 'Singer or band', 'Teresa Teng, The Beatles…'],
  ['composer', 'Composer or songwriter', 'Andrew Lloyd Webber, Joe Hisaishi…'],
  ['language', 'Language', 'English, Vietnamese, Chinese…'],
  ['occasion', 'Occasion', 'Christmas, birthday…'],
  ['printed', 'Printed / Never printed', 'from your print history'],
];

// mock knowledge: what a local LLM would know from the song title
const WORKS = {
  Frozen: ['Let It Go', 'Do You Want to Build a Snowman', 'Into the Unknown'],
  'Les Misérables': ['I Dreamed a Dream', 'On My Own', 'Castle on a Cloud', 'One Day More', 'Bring Him Home'],
  'The Phantom of the Opera': ['The Phantom of the Opera', 'The Music of the Night', 'Think of Me'],
  Cats: ['Memory'],
  'The Sound of Music': ['16 Going on 17', 'Edelweiss', 'Do-Re-Mi'],
  'Miss Saigon': ['The Sun and Moon', 'Last Night of the World'],
  Matilda: ['Naughty', 'When I Grow Up'],
  'Studio Ghibli': ['Merry-Go-Round of Life', 'Summer', "One Summer's Day"],
  'The Greatest Showman': ['A Million Dreams'],
  Aladdin: ['A Whole New World'],
  'The Lion King': ['Can You Feel the Love Tonight'],
};
const OCCASION = { Christmas: ['Silent Night', 'Jingle Bells', 'We Wish You a Merry Christmas', 'Last Christmas', 'Auld Lang Syne'], Birthday: ['Happy Birthday to You'] };

function detect(opts, scope) {
  let items = store.items();
  if (scope === 'untagged') items = items.filter((x) => !x.tags.length);
  else if (scope !== 'all') items = items.filter((x) => x.kind === scope);
  const by = (t) => items.filter((x) => x.title === t || x.title.startsWith(t + ' (')).map((x) => x.id);
  const out = [];
  const push = (name, why, ids) => { ids = [...new Set(ids)]; if (ids.length) out.push({ name, why, ids, on: true }); };
  if (opts.has('work')) for (const [w, titles] of Object.entries(WORKS)) push(w, 'Movie or musical', titles.flatMap(by));
  const group = (why) => {
    const m = new Map();
    for (const x of items) if (x.artist && !/traditional|đồng dao|dân ca/i.test(x.artist)) m.set(x.artist, [...(m.get(x.artist) || []), x.id]);
    for (const [a, ids] of m) if (ids.length >= 2) push(a, why, ids);
  };
  if (opts.has('composer') || opts.has('singer')) group(opts.has('composer') ? 'Composer or songwriter' : 'Singer or band');
  if (opts.has('language')) {
    push('Vietnamese', 'Language', items.filter((x) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(x.title + x.artist)).map((x) => x.id));
    push('Russian', 'Language', items.filter((x) => /Katyusha|Moscow Nights|Wait for Me|Kalinka/.test(x.title)).map((x) => x.id));
  }
  if (opts.has('occasion')) for (const [o, titles] of Object.entries(OCCASION)) push(o, 'Occasion', titles.flatMap(by));
  if (opts.has('printed')) {
    const printed = store.db.printed || {};
    push('Printed', 'Print history', items.filter((x) => printed[x.id]).map((x) => x.id));
    push('Never printed', 'Print history', items.filter((x) => !printed[x.id]).map((x) => x.id));
  }
  return out;
}

export function makeTagsView(main) {
  const opts = new Set(['work', 'composer', 'occasion']);
  let scope = 'all';
  main.innerHTML = `<header class="top"><a class="icon-btn back" href="#/tags">‹ Back</a><h1>Generate tags</h1></header>
    <form class="pad narrow form" id="mt">
      <fieldset><legend>Look for</legend><div class="cards one-col" id="mt-o">${OPTIONS.map(([k, l, d]) =>
        `<button type="button" class="card-opt ${opts.has(k) ? 'on' : ''}" data-k="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div></fieldset>
      <label class="field">In <select id="mt-s"><option value="all">All music</option><option value="untagged">Only music with no tags</option><option value="sheet">Sheets</option><option value="score">Scores</option><option value="chords">Chord charts</option></select></label>
      <p class="muted small">Runs on the Mac with a local AI model, from the song titles. Nothing is saved until you review it.</p>
      <button class="primary big" id="mt-go">Find tags</button>
    </form>`;
  $('#mt-o', main).onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; opts.has(b.dataset.k) ? opts.delete(b.dataset.k) : opts.add(b.dataset.k); b.classList.toggle('on'); $('#mt-go', main).disabled = !opts.size; };
  $('#mt-s', main).onchange = (e) => (scope = e.target.value);
  $('#mt', main).onsubmit = (e) => {
    e.preventDefault();
    main.innerHTML = `<header class="top"><h1>Generating tags…</h1></header><div class="pad narrow center"><p id="mt-msg">Reading song titles</p><progress id="mt-p" max="1" value="0"></progress></div>`;
    let p = 0;
    const t = setInterval(() => {
      p += 0.2;
      const bar = $('#mt-p', main);
      if (!bar) return clearInterval(t);
      bar.value = p;
      if (p >= 1) { clearInterval(t); review(main, detect(opts, scope)); }
    }, 250);
  };
}

function review(host, groups) {
  host.innerHTML = '';
  const main = document.createElement('div');
  host.append(main);
  const all = store.items();
  const existing = new Set(store.db.tags);
  const draw = () => {
    const on = groups.filter((g) => g.on && g.ids.length && g.name.trim());
    main.innerHTML = `<header class="top"><a class="icon-btn back" href="#/make-tags">‹ Start over</a><h1>Review tags</h1><span class="grow"></span>
        <button class="primary" id="mt-apply" ${on.length ? '' : 'disabled'}>Apply ${on.length} tag${on.length === 1 ? '' : 's'}</button></header>
      <p class="pad muted hint">Rename a tag, remove songs with ×, add songs, or untick a tag to skip it. Nothing is saved until you press Apply.</p>
      <div class="review" id="mt-r">${groups.length ? groups.map((g, gi) => `
        <section class="rv-card ${g.on ? '' : 'skipped'}" data-g="${gi}">
          <div class="rv-head">
            <input type="checkbox" class="mt-on" ${g.on ? 'checked' : ''} aria-label="Use this tag">
            <input class="rv-title" value="${esc(g.name)}" aria-label="Tag name">
            <span class="pill">${existing.has(g.name.trim()) ? 'adds to existing tag' : 'new tag'}</span>
          </div>
          <p class="muted small">${esc(g.why)} · ${g.ids.length} song${g.ids.length === 1 ? '' : 's'}</p>
          <ul class="mt-songs">${g.ids.map((id) => { const it = store.get(id); return `<li>${badge(it.kind)}<span>${esc(it.title)}</span><small class="muted">${esc(it.artist || '')}</small><button class="x" data-rm="${id}" aria-label="Remove ${esc(it.title)}">×</button></li>`; }).join('')}</ul>
          <button class="link" data-add>+ Add songs</button>
        </section>`).join('') : '<p class="muted">No tags found. Try other options.</p>'}</div>`;
    $('#mt-apply', main)?.addEventListener('click', apply);
  };
  const apply = () => {
    const on = groups.filter((g) => g.on && g.ids.length && g.name.trim());
    for (const g of on) store.setTags(g.ids, [g.name.trim()]);
    store.logEvent('make-tags', `${on.length} tag${on.length === 1 ? '' : 's'}`, on.map((g) => `${g.name.trim()} (${g.ids.length})`).join(', '));
    toast(`Applied ${on.length} tag${on.length === 1 ? '' : 's'}`);
    go('#/tags');
  };
  main.addEventListener('input', (e) => { if (e.target.classList.contains('rv-title')) groups[+e.target.closest('[data-g]').dataset.g].name = e.target.value; });
  main.addEventListener('change', (e) => { if (e.target.classList.contains('mt-on')) { groups[+e.target.closest('[data-g]').dataset.g].on = e.target.checked; draw(); } if (e.target.classList.contains('rv-title')) draw(); });
  main.addEventListener('click', (e) => {
    const card = e.target.closest('[data-g]');
    if (!card) return;
    const g = groups[+card.dataset.g];
    const rm = e.target.closest('[data-rm]');
    if (rm) { g.ids = g.ids.filter((x) => x !== rm.dataset.rm); draw(); }
    if (e.target.closest('[data-add]')) {
      const s = modal(`<h2>Add songs to “${esc(g.name)}”</h2><input type="search" placeholder="Find a song" id="mt-q">
        <div class="list-pick" id="mt-l"></div><div class="modal-actions"><button data-close>Done</button></div>`, { wide: true, onClose: draw });
      const list = $('#mt-l', s.el);
      const fill = (q = '') => (list.innerHTML = all.filter((x) => !g.ids.includes(x.id) && x.title.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
        .map((x) => `<button data-id="${x.id}"><span>${esc(x.title)}</span><i>${esc(x.artist || '')}</i></button>`).join(''));
      fill();
      $('#mt-q', s.el).oninput = (ev) => fill(ev.target.value);
      list.onclick = (ev) => { const b = ev.target.closest('[data-id]'); if (!b) return; g.ids.push(b.dataset.id); b.remove(); };
    }
  });
  draw();
}
