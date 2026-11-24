// Tags (filter, print all) and the bin.
import { store } from '../store.js';
import { $, esc, iconOn, ago, menu, toast, promptSheet, confirmSheet, KIND, kindOf } from '../ui.js';
import { taps } from './managekit.js';
import { go } from '../app.js';
import { itemMenu } from './actions.js';

// ================= tags =================
export function tagsView(main) {
  main.innerHTML = `<header class="top"><h1>Tags</h1><span class="grow"></span><button id="mt-open">Generate tags…</button><button class="primary" id="tg-add">Create tag</button></header>
    <div class="pad"><div class="tag-grid" id="tg"></div></div>`;
  const draw = () => {
    const counts = store.tagCounts();
    const tags = [...store.db.tags].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
    $('#tg', main).innerHTML = tags.map((t) => `<div class="tag-card"><a href="#/library?tags=${encodeURIComponent(t)}"><b>${esc(t)}</b><span>${counts.get(t) || 0}</span></a>
      <button class="icon-btn" data-t="${esc(t)}" aria-label="More for ${esc(t)}" title="More">${iconOn('more')}</button></div>`).join('');
  };
  $('#tg', main).onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    menu(b, [
      { label: 'Rename', icon: 'edit', run: async () => { const n = await promptSheet({ title: 'Rename tag', value: t }); if (n) store.renameTag(t, n); } },
      { label: 'Print all', icon: 'print', run: () => go(`#/print?tags=${encodeURIComponent(t)}`) },
      '-',
      { label: 'Delete tag', icon: 'bin', danger: true, run: async () => { if (await confirmSheet({ title: `Delete the tag “${t}”?`, body: 'The music keeps everything else; only this tag is removed.', ok: 'Delete', danger: true })) store.deleteTag(t); } },
    ]);
  };
  $('#mt-open', main).onclick = () => go('#/make-tags');
  $('#tg-add', main).onclick = async () => { const n = await promptSheet({ title: 'Create tag', placeholder: 'e.g. Recital', ok: 'Create' }); if (n) store.addTag(n); };
  draw();
  return store.on(draw);
}

// ================= bin =================
// Manage library → Trash (#/manage/trash; #/bin and #/trash go there): Restore, Delete (for good, after a confirm), Empty Trash
export function binView(main) {
  main.innerHTML = `<header class="top mg-top"><a class="mg-back" href="#/manage">‹ Manage</a><div class="mg-t"><h1>Trash</h1></div><span class="grow"></span><button class="danger-text" id="bn-empty" data-act="empty">Empty Trash</button></header>
    <div class="mg-pad mg-wrap"><ul class="mg-rows bn-rows" id="bn"></ul>
    <p class="muted small">Items stay here until you delete them for good. Deleting for good also removes their page images and files from the Mac.</p></div>`;
  const draw = () => {
    const items = store.items({ deleted: true }).sort((a, b) => b.deletedAt - a.deletedAt);
    $('#bn-empty', main).disabled = !items.length;
    $('#bn', main).innerHTML = items.map((it) => `<li class="mg-row row" data-id="${it.id}">
      <span class="mg-rt"><b class="row-title">${esc(it.title)}</b><small>${KIND[kindOf(it)]?.label || 'Item'} · deleted ${ago(it.deletedAt).toLowerCase()}</small></span>
      <button data-act="restore">Restore</button><button class="danger-text" data-act="purge">Delete</button></li>`).join('') ||
      `<li class="mg-empty muted">Trash is empty.</li>`;
  };
  const off = taps(main, '[data-act]', async (b) => {
    if (b.dataset.act === 'empty') {
      const ids = store.items({ deleted: true }).map((x) => x.id);
      if (await confirmSheet({ title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'} for good?`, body: 'This cannot be undone.', ok: 'Empty Trash', danger: true })) store.purge(ids);
      return;
    }
    const id = b.closest('.row').dataset.id, it = store.get(id);
    if (b.dataset.act === 'restore') { store.restore(id); toast(`Restored “${it.title}”`); }
    else if (await confirmSheet({ title: `Delete “${it.title}” for good?`, body: 'This cannot be undone.', ok: 'Delete for good', danger: true })) store.purge(id);
  });
  draw();
  const off2 = store.on(draw);
  return () => { off(); off2(); };
}
