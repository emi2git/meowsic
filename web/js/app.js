// Meowsic 2.0 shell: sidebar (iPad / Mac), tab bar (iPhone), hash router.
import { store } from './store.js';
import { $, esc, icon, CAT, KIND, menu } from './ui.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { performView } from './views/perform.js';
import { addSheetsView, addChordsView, addScoreView, jobsView } from './views/add.js';
import { tagsView, collectionsView, collectionView, binView } from './views/organize.js';
import { printView } from './views/print.js';
import { statsView, toolsView, settingsView } from './views/more.js';

const main = $('#main');
let cleanup = null;

export function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}

const ROUTES = {
  library: libraryView, item: itemView, perform: performView,
  'add-sheets': addSheetsView, 'add-chords': addChordsView, 'add-score': addScoreView, jobs: jobsView,
  tags: tagsView, collections: collectionsView, collection: collectionView, bin: binView,
  print: printView, stats: statsView, tools: toolsView, settings: settingsView,
};

function route() {
  const { parts, q } = parseHash();
  const name = parts[0] || 'library';
  const view = ROUTES[name] || libraryView;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  document.body.dataset.view = name;
  main.scrollTop = 0;
  main.innerHTML = '';
  cleanup = view(main, { parts, q });
  renderSide();
  $('#main').focus({ preventScroll: true });
}

export function renderSide() {
  const { parts, q } = parseHash();
  const v = parts[0] || 'library';
  const items = store.items();
  const n = (k) => items.filter((x) => x.kind === k).length;
  const kind = v === 'library' ? q.get('kind') || '' : null;
  const on = (cond) => (cond ? ' on' : '');
  const running = store.jobs().filter((j) => j.status === 'running').length;
  $('#side').innerHTML = `
    <a class="brand" href="#/library">${CAT}<span><b>Meowsic</b><small>2.0</small></span></a>
    <button class="add-btn primary" id="side-add">${icon('plus')}Add music</button>
    <nav aria-label="Library">
      <a class="nav${on(kind === '')}" href="#/library">${icon('library')}<span>All music</span><i>${items.length}</i></a>
      ${['sheet', 'chords', 'score'].map((k) => `<a class="nav sub${on(kind === k)}" href="#/library?kind=${k}">${icon(KIND[k].icon)}<span>${KIND[k].plural}</span><i>${n(k)}</i></a>`).join('')}
      <a class="nav${on(v === 'tags')}" href="#/tags">${icon('tag')}<span>Tags</span></a>
      <a class="nav${on(v === 'collections' || v === 'collection')}" href="#/collections">${icon('collection')}<span>Collections</span></a>
      <div class="side-cols">${store.db.collections.map((c) => `<a class="nav sub${on(v === 'collection' && parts[1] === c.id)}" href="#/collection/${c.id}"><span>${esc(c.name)}</span><i>${c.itemIds.length}</i></a>`).join('')}</div>
      <h3>Practice</h3>
      <a class="nav${on(v === 'tools')}" href="#/tools">${icon('metronome')}<span>Metronome &amp; tuner</span></a>
      <a class="nav${on(v === 'stats')}" href="#/stats">${icon('stats')}<span>Stats</span></a>
      <h3>More</h3>
      <a class="nav${on(v === 'jobs')}" href="#/jobs">${icon('wave')}<span>Transcriptions</span>${running ? `<i class="live">${running}</i>` : ''}</a>
      <a class="nav${on(v === 'bin')}" href="#/bin">${icon('bin')}<span>Bin</span><i>${store.items({ deleted: true }).length || ''}</i></a>
      <a class="nav${on(v === 'settings')}" href="#/settings">${icon('settings')}<span>Settings</span></a>
    </nav>
    <div class="side-foot">${icon('wifi')}<span>Connected to Mac <small>(mock)</small></span></div>`;
  $('#side-add').onclick = (e) => addMenu(e.currentTarget);

  const tab = (href, ic, label, active) => `<a href="${href}" class="${active ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`;
  $('#tabbar').innerHTML =
    tab('#/library', 'library', 'Library', v === 'library' || v === 'item') +
    tab('#/collections', 'collection', 'Collections', v === 'collections' || v === 'collection') +
    `<button id="tab-add" class="tab-add" aria-label="Add music">${icon('plus')}</button>` +
    tab('#/tools', 'metronome', 'Practice', v === 'tools' || v === 'stats') +
    `<button id="tab-more" class="${['tags', 'bin', 'settings', 'jobs', 'print'].includes(v) ? 'on' : ''}">${icon('more')}<span>More</span></button>`;
  $('#tab-add').onclick = (e) => addMenu(e.currentTarget);
  $('#tab-more').onclick = (e) => menu(e.currentTarget, [
    { label: 'Tags', icon: 'tag', run: () => go('#/tags') },
    { label: 'Stats', icon: 'stats', run: () => go('#/stats') },
    { label: 'Transcriptions', icon: 'wave', run: () => go('#/jobs') },
    { label: 'Bin', icon: 'bin', run: () => go('#/bin') },
    { label: 'Settings', icon: 'settings', run: () => go('#/settings') },
  ]);
}

export function addMenu(anchor) {
  menu(anchor, [
    { label: 'Sheet music — photos or PDF', icon: 'photo', run: () => go('#/add-sheets') },
    { label: 'Chords — search the web', icon: 'chords', run: () => go('#/add-chords') },
    { label: 'Score — from a song recording', icon: 'wave', run: () => go('#/add-score') },
  ]);
}

// ---------- theme ----------
export function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('meowsic-theme') || 'system'; } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
applyTheme();

// re-render the side when data changes; views subscribe themselves
store.on(() => renderSide());
addEventListener('hashchange', route);
route();

// mock transcription progress: advance running jobs while the app is open
import('./views/add.js').then((m) => m.tickJobs());
