// Meowsic 2.0 shell: sidebar (iPad / Mac), tab bar (iPhone), hash router.
import './device.js'; // first: sets <html data-device> before anything draws
import './update.js'; // the page updates itself when the Mac serves a newer shell / commit
import { store } from './store.js';
import { $, esc, icon, CAT, KIND, kindOf, menu } from './ui.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { addSheetsView, addChordsView, addScoreView } from './views/add.js';
import { tagsView } from './views/organize.js';
import { printView } from './views/print.js';
import { statsView, settingsView, developerView } from './views/more.js';
import { activityView } from './views/activity.js';
import { manageView } from './views/manage.js';
import { makeTagsView } from './views/maketags.js';
import { helpView } from './views/help.js';
import { placeBanner } from './conn.js';
import './textinput.js'; // mic + double-tap select-all on every text box

const main = $('#main');
let cleanup = null;

// where the app opens and where Back / the logo land: Sheets (All music is one tap away)
export const HOME = '#/library?kind=sheet';
export function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

// Leave a finished step (a saved crop, say) so that Back / swipe-back never opens it again: when we came here from
// `target`, step back onto that entry (then fix up its query); otherwise replace this entry. The finished entry is
// marked: coming forward onto it again goes straight on to `target`.
let hashNow = '', hashBefore = '';
const pathOf = (h) => (h || '').replace(/^#\/?/, '#/').split('?')[0];
export function leaveTo(target) {
  try { history.replaceState({ ...(history.state || {}), leftTo: target }, '', location.href); } catch {}
  if (hashBefore && pathOf(hashBefore) === pathOf(target) && history.length > 1) {
    addEventListener('popstate', () => { if (location.hash !== target) location.replace(target); }, { once: true });
    history.back();
  } else location.replace(target);
}

export function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}

const ROUTES = {
  library: libraryView, item: itemView,
  'add-sheets': addSheetsView, 'add-chords': addChordsView, 'add-score': addScoreView, jobs: addScoreView,
  tags: tagsView,
  print: printView, stats: statsView, activity: activityView, activities: activityView, manage: manageView, 'make-tags': makeTagsView, developer: developerView, settings: settingsView, help: helpView, beta: betaView,
};

// Beta pages load on demand (#/beta/keyboard → views/beta-keyboard.js, render(main, ctx)); a page not built yet shows "coming soon"
const BETA = { keyboard: 'Keyboard' };
function betaView(main, ctx) {
  const page = ctx.parts[1] || 'keyboard';
  const soon = () => { main.innerHTML = `<header class="top"><h1>${BETA[page] || 'Beta'}</h1><span class="pill">Beta</span></header><div class="pad narrow"><section class="card beta-soon"><h2>${icon('piano')} Coming soon</h2><p class="muted small">This beta page isn’t ready yet.</p></section></div>`; };
  let done = false, inner = null;
  main.innerHTML = `<header class="top"><h1>${BETA[page] || 'Beta'}</h1></header>`;
  (BETA[page] ? import(`./views/beta-${page}.js`) : Promise.reject(new Error('no such beta page')))
    .then((m) => { if (done) return; const r = m.render || m.default; if (typeof r !== 'function') return soon(); inner = r(main, ctx); })
    .catch(() => { if (!done) soon(); });
  return () => { done = true; if (typeof inner === 'function') inner(); };
}

function route() {
  if (history.state?.leftTo) return void location.replace(history.state.leftTo);  // a finished step (see leaveTo)
  if (/^#\/?feedback\b/.test(location.hash)) return void location.replace('#/developer'); // #/feedback alias of the Feedback page (#/developer)
  const { parts, q } = parseHash();
  const to = manageRedirect(parts, q);
  if (to) { location.replace(to); return; }
  if (parts[0] === 'add-photos') { location.replace('#/add-sheets'); return; }  // From Photos is Add sheet music now
  if (location.hash !== hashNow) { hashBefore = hashNow; hashNow = location.hash; }
  const name = parts[0] || 'library';
  const view = ROUTES[name] || libraryView;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  document.body.dataset.view = name;
  main.scrollTop = 0;
  main.innerHTML = '';
  cleanup = view(main, { parts, q });
  renderSide();
  requestAnimationFrame(placeBanner);
  $('#main').focus({ preventScroll: true });
}

// Manage library (views/manage.js): #/manage, /review, /info, /trash, /pages, /pages/<id>, /pages/<id>/crop/<p>.
// Old links: #/bin and #/trash → Trash; #/cleanup, #/organize and #/manage?id=X(&crop=P) → Fix pages on that sheet
// (its crop); any other #/manage/<old tab> → the hub.
export function manageRedirect(parts, q) {
  if (parts[0] === 'bin' || parts[0] === 'trash') return '#/manage/trash';
  if (!['manage', 'cleanup', 'organize'].includes(parts[0])) return null;
  const id = q.get('id');
  if (id && parts.length === 1) {
    const back = q.get('back') === 'item' ? '?back=item' : '';
    return `#/manage/pages/${encodeURIComponent(id)}${+q.get('crop') ? `/crop/${+q.get('crop')}` : ''}${back}`;
  }
  if (parts[0] !== 'manage') return '#/manage';
  const [, a, , c, p] = parts, n = parts.length;
  const ok = n === 1 || (n === 2 && ['review', 'info', 'trash', 'pages'].includes(a)) || (a === 'pages' && (n === 3 || (n === 5 && c === 'crop' && +p > 0)));
  return ok ? null : '#/manage';
}

export function renderSide() {
  const { parts, q } = parseHash();
  const v = parts[0] || 'library';
  const items = store.items();
  const n = (k) => items.filter((x) => kindOf(x) === k).length;
  const kind = v === 'library' ? q.get('kind') || '' : null;
  const on = (cond) => (cond ? ' on' : '');
  $('#side').innerHTML = `
    <a class="brand" href="${HOME}"><span><b>Meowsic</b><small>2.0</small></span></a>
    <button class="add-btn primary" id="side-add">${icon('plus')}Add music</button>
    <nav aria-label="Main">
      <a class="nav lib${on(kind === '')}" href="#/library">${icon('library')}<span>Library</span><i>${items.length}</i></a>
      ${['sheet', 'score', 'chords', 'book'].map((k) => `<a class="nav sub${on(kind === k)}" href="#/library?kind=${k}">${icon(KIND[k].icon)}<span>${KIND[k].plural}</span><i>${n(k)}</i></a>`).join('')}
      <h3>Manage</h3>
      <a class="nav${on(v === 'manage')}" href="#/manage"><span>Library</span></a>
      <a class="nav${on(v === 'tags' || v === 'make-tags')}" href="#/tags"><span>Tags</span></a>
      <a class="nav${on(v === 'settings' || v === 'help')}" href="#/settings">${icon('settings')}<span>App</span></a>
      <h3>Developer</h3>
      <a class="nav${on(v === 'stats')}" href="#/stats">${icon('stats')}<span>Stats</span></a>
      <a class="nav${on(v === 'activity' || v === 'activities')}" href="#/activity"><span>Activities</span>${store.jobs().some((j) => j.status === 'running') ? '<i class="live">•</i>' : ''}</a>
      <a class="nav${on(v === 'developer')}" href="#/developer"><span>Feedback</span></a>
      <a class="nav${on(v === 'beta' && (parts[1] || 'keyboard') === 'keyboard')}" href="#/beta/keyboard">${icon('piano')}<span>Keyboard</span></a>
    </nav>
    <div class="side-foot ${store.mode}">${icon('wifi')}<span>${store.mode === 'server' ? 'Connected to the Mac' : store.mode === 'offline' ? (store.items().length ? 'Offline — your last copy' : 'Can’t reach the Mac') : 'Preview'}</span></div>`;
  $('#side-add').onclick = (e) => addMenu(e.currentTarget);

  const tab = (href, ic, label, active) => `<a href="${href}" class="${active ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`;
  $('#tabbar').innerHTML =
    tab(HOME, 'library', 'Library', v === 'library' || v === 'item') +
    `<button id="tab-add" class="tab-add" aria-label="Add music">Add</button>` +
    tab('#/stats', 'stats', 'Stats', v === 'stats') +
    `<button id="tab-more" class="${['bin', 'settings', 'print', 'activity', 'activities', 'developer', 'manage', 'help', 'tags', 'make-tags', 'beta'].includes(v) ? 'on' : ''}">${icon('more')}<span>More</span></button>`;
  $('#tab-add').onclick = (e) => addMenu(e.currentTarget);
  $('#tab-more').onclick = (e) => menu(e.currentTarget, [
    { head: 'Manage' },
    { label: 'Library', icon: 'tools', run: () => go('#/manage') },
    { label: 'Tags', icon: 'tag', run: () => go('#/tags') },
    { label: 'App', icon: 'settings', run: () => go('#/settings') },
    { head: 'Developer' }, // Stats is a bottom tab on the iPhone, so not repeated here
    { label: 'Activities', icon: 'wave', run: () => go('#/activity') },
    { label: 'Feedback', icon: 'tools', run: () => go('#/developer') },
    { label: 'Keyboard', icon: 'piano', run: () => go('#/beta/keyboard') },
  ]);
}

export function addMenu(anchor) {
  // three short choices; where the music comes from is picked inside each one (explained in Help)
  menu(anchor, [
    { label: 'Sheet', icon: 'photo', run: () => go('#/add-sheets') },
    { label: 'Chords', icon: 'chords', run: () => go('#/add-chords') },
    { label: 'Score', icon: 'wave', run: () => go('#/add-score') },
  ]);
  document.querySelector('.menu')?.classList.add('add-menu');
}

// ---------- theme ----------
export function applyTheme() {
  let t = 'light';
  try { t = localStorage.getItem('meowsic-theme') || 'light'; } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
applyTheme();

// re-render the side when data changes; views subscribe themselves
store.on(() => renderSide());
addEventListener('hashchange', route);
// a fresh start on #/ or #/library (no type picked) opens Sheets
if (/^#?\/?(library)?\/?$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + HOME);
// new scores from a finished job → offer tags for review
addEventListener('meowsic-new-items', (e) => { if (e.detail?.length) import('./views/autotag.js').then((m) => m.autoTag(e.detail, { quiet: true })); });
route();

// mock transcription progress: advance running jobs while the app is open
import('./views/add.js').then((m) => m.tickJobs());
