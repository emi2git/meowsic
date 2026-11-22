// Tags (filter, print all) and the bin.
import { store } from '../store.js';
import { $, esc, icon, iconOn, badge, ago, menu, toast, promptSheet, confirmSheet, CAT } from '../ui.js';
import { go } from '../app.js';
import { thumbHtml, metaText, itemMenu } from './actions.js';

// ================= tags =================
export function tagsView(main) {
  main.innerHTML = `<header class="top"><h1>Tags</h1><span class="grow"></span><button id="mt-open">Make tags…</button><button class="primary" id="tg-add">${icon('plus')}New tag</button></header>
    <div class="pad"><p class="muted">Tap a tag to see its music. Use ⋯ to print everything with a tag (A–Z).</p><div class="tag-grid" id="tg"></div></div>`;
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
  $('#tg-add', main).onclick = async () => { const n = await promptSheet({ title: 'New tag', placeholder: 'e.g. Recital' }); if (n) store.addTag(n); };
  draw();
  return store.on(draw);
}

// ================= bin =================
export function binView(main) {
  main.innerHTML = `<header class="top"><h1>Trash</h1><span class="grow"></span><button class="danger-text" id="bn-empty">${icon('bin')}Empty Trash</button></header>
    <p class="pad muted">Items stay here until you delete them for good. Deleting for good also removes their page images and files from the Mac.</p><ul class="rows" id="bn"></ul>`;
  const draw = () => {
    const items = store.items({ deleted: true }).sort((a, b) => b.deletedAt - a.deletedAt);
    $('#bn-empty', main).disabled = !items.length;
    $('#bn', main).innerHTML = items.map((it) => `<li class="row" data-id="${it.id}">
      <div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${badge(it.kind)}<span>Deleted ${ago(it.deletedAt)}</span></div></div>
      <button data-act="restore">${icon('restore')}<span>Restore</span></button><button class="danger-text" data-act="purge">${icon('bin')}<span>Delete</span></button></li>`).join('') ||
      `<li class="empty">${CAT}<p>Trash is empty.</p></li>`;
  };
  $('#bn', main).onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.row').dataset.id, it = store.get(id);
    if (b.dataset.act === 'restore') { store.restore(id); toast(`Restored “${it.title}”`); }
    else if (await confirmSheet({ title: `Delete “${it.title}” for good?`, body: 'This cannot be undone.', ok: 'Delete for good', danger: true })) store.purge(id);
  };
  $('#bn-empty', main).onclick = async () => {
    const ids = store.items({ deleted: true }).map((x) => x.id);
    if (await confirmSheet({ title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'} for good?`, body: 'This cannot be undone.', ok: 'Empty Trash', danger: true })) store.purge(ids);
  };
  draw();
  return store.on(draw);
}
