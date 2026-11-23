// Meowsic 2.0 shell: sidebar (iPad / Mac), tab bar (iPhone), hash router.
import './device.js'; // first: sets <html data-device> before anything draws
import { store } from './store.js';
import { $, esc, icon, CAT, KIND, kindOf, menu } from './ui.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { addSheetsView, addChordsView, addScoreView } from './views/add.js';
import { tagsView, binView } from './views/organize.js';
import { printView } from './views/print.js';
import { statsView, settingsView, developerView } from './views/more.js';
import { activityView } from './views/activity.js';
import { cleanupView } from './views/cleanup.js';
import { makeTagsView } from './views/maketags.js';

const main = $('#main');
let cleanup = null;

export function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}

const ROUTES = {
  library: libraryView, item: itemView,
  'add-sheets': addSheetsView, 'add-chords': addChordsView, 'add-score': addScoreView, jobs: addScoreView,
  tags: tagsView, bin: binView,
  print: printView, stats: statsView, activity: activityView, cleanup: cleanupView, 'make-tags': makeTagsView, developer: developerView, settings: settingsView,
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
  const n = (k) => items.filter((x) => kindOf(x) === k).length;
  const kind = v === 'library' ? q.get('kind') || '' : null;
  const on = (cond) => (cond ? ' on' : '');
  $('#side').innerHTML = `
    <a class="brand" href="#/library"><span><b>Meowsic</b><small>2.0</small></span></a>
    <button class="add-btn primary" id="side-add">${icon('plus')}Add music</button>
    <nav aria-label="Library">
      <a class="nav${on(kind === '')}" href="#/library">${icon('library')}<span>All music</span><i>${items.length}</i></a>
      ${['sheet', 'score', 'chords', 'book', 'ai'].map((k) => `<a class="nav sub${on(kind === k)}" href="#/library?kind=${k}">${icon(KIND[k].icon)}<span>${KIND[k].plural}</span><i>${n(k)}</i></a>`).join('')}
      <a class="nav${on(v === 'tags')}" href="#/tags">${icon('tag')}<span>Tags</span></a>
      <a class="nav${on(v === 'stats')}" href="#/stats">${icon('stats')}<span>Stats</span></a>
      <h3>Utilities</h3>
      <a class="nav${on(v === 'activity')}" href="#/activity"><span>Logs</span>${store.jobs().some((j) => j.status === 'running') ? '<i class="live">•</i>' : ''}</a>
      ${store.mode === 'server' ? `<a class="nav${on(v === 'cleanup')}" href="#/cleanup"><span>Clean up</span></a>` : ''}
      <a class="nav${on(v === 'bin')}" href="#/bin">${icon('bin')}<span>Trash</span><i>${store.items({ deleted: true }).length || ''}</i></a>
      <a class="nav${on(v === 'settings')}" href="#/settings">${icon('settings')}<span>Settings</span></a>
      <a class="nav${on(v === 'developer')}" href="#/developer"><span>Developer</span></a>
    </nav>
    <div class="side-foot ${store.mode}">${icon('wifi')}<span>${store.mode === 'server' ? 'Connected to the Mac' : store.mode === 'offline' ? (store.items().length ? 'Offline — your last copy' : 'Can’t reach the Mac') : 'Preview'}</span></div>`;
  $('#side-add').onclick = (e) => addMenu(e.currentTarget);

  const tab = (href, ic, label, active) => `<a href="${href}" class="${active ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`;
  $('#tabbar').innerHTML =
    tab('#/library', 'library', 'Library', v === 'library' || v === 'item') +
    tab('#/tags', 'tag', 'Tags', v === 'tags') +
    `<button id="tab-add" class="tab-add" aria-label="Add music">Add</button>` +
    tab('#/stats', 'stats', 'Stats', v === 'stats') +
    `<button id="tab-more" class="${['bin', 'settings', 'print', 'activity', 'developer', 'cleanup'].includes(v) ? 'on' : ''}">${icon('more')}<span>Utilities</span></button>`;
  $('#tab-add').onclick = (e) => addMenu(e.currentTarget);
  $('#tab-more').onclick = (e) => menu(e.currentTarget, [
    { label: 'Logs', icon: 'wave', run: () => go('#/activity') },
    ...(store.mode === 'server' ? [{ label: 'Clean up', icon: 'tools', run: () => go('#/cleanup') }] : []),
    { label: 'Trash', icon: 'bin', run: () => go('#/bin') },
    { label: 'Settings', icon: 'settings', run: () => go('#/settings') },
    { label: 'Developer', icon: 'tools', run: () => go('#/developer') },
  ]);
}

export function addMenu(anchor) {
  menu(anchor, [
    { label: 'Sheet music — photos or PDF', icon: 'photo', run: () => go('#/add-sheets') },
    { label: 'Chords — search the web', icon: 'chords', run: () => go('#/add-chords') },
    { label: 'Score — from a recording', icon: 'wave', run: () => go('#/add-score') },
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
// new scores from a finished job → offer tags for review
addEventListener('meowsic-new-items', (e) => { if (e.detail?.length) import('./views/autotag.js').then((m) => m.autoTag(e.detail, { quiet: true })); });
route();

// mock transcription progress: advance running jobs while the app is open
import('./views/add.js').then((m) => m.tickJobs());
