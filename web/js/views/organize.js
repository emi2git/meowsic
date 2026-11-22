// Tags, collections (ordered, with page counts, print and set-list performance) and the bin.
import { store } from '../store.js';
import { $, esc, icon, badge, ago, menu, toast, promptSheet, confirmSheet, CAT } from '../ui.js';
import { go } from '../app.js';
import { thumbHtml, metaText, itemMenu } from './actions.js';
import { printedPages } from './print.js';

// ================= tags =================
export function tagsView(main) {
  main.innerHTML = `<header class="top"><h1>Tags</h1><span class="grow"></span><button class="primary" id="tg-add">${icon('plus')}New tag</button></header>
    <div class="pad"><p class="muted">Tap a tag to see its music. Kinds (sheet, chords, score) are filters in the library, not tags.</p><div class="tag-grid" id="tg"></div></div>`;
  const draw = () => {
    const counts = store.tagCounts();
    const tags = [...store.db.tags].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
    $('#tg', main).innerHTML = tags.map((t) => `<div class="tag-card"><a href="#/library?tag=${encodeURIComponent(t)}"><b>${esc(t)}</b><span>${counts.get(t) || 0}</span></a>
      <button class="icon-btn" data-t="${esc(t)}" aria-label="More for ${esc(t)}">${icon('more')}</button></div>`).join('');
  };
  $('#tg', main).onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    menu(b, [
      { label: 'Rename', icon: 'edit', run: async () => { const n = await promptSheet({ title: 'Rename tag', value: t }); if (n) store.renameTag(t, n); } },
      { label: 'Print everything with this tag', icon: 'print', run: () => go(`#/print?tag=${encodeURIComponent(t)}`) },
      '-',
      { label: 'Delete tag', icon: 'bin', danger: true, run: async () => { if (await confirmSheet({ title: `Delete the tag “${t}”?`, body: 'The music keeps everything else; only this tag is removed.', ok: 'Delete', danger: true })) store.deleteTag(t); } },
    ]);
  };
  $('#tg-add', main).onclick = async () => { const n = await promptSheet({ title: 'New tag', placeholder: 'e.g. Recital' }); if (n) store.addTag(n); };
  draw();
  return store.on(draw);
}

// ================= collections =================
export function collectionsView(main) {
  main.innerHTML = `<header class="top"><h1>Collections</h1><span class="grow"></span><button class="primary" id="cl-add">${icon('plus')}New collection</button></header><div class="pad cards-grid" id="cl"></div>`;
  const draw = () => {
    const cols = store.db.collections;
    $('#cl', main).innerHTML = cols.length ? cols.map((c) => {
      const items = c.itemIds.map((id) => store.get(id)).filter((x) => x && !x.deleted);
      const kinds = ['sheet', 'chords', 'score'].map((k) => [k, items.filter((x) => x.kind === k).length]).filter(([, n]) => n);
      return `<a class="col-card" href="#/collection/${c.id}">
        <div class="col-thumbs">${items.slice(0, 3).map(thumbHtml).join('') || `<span class="thumb">${icon('collection')}</span>`}</div>
        <b>${esc(c.name)}</b><small>${items.length} item${items.length === 1 ? '' : 's'} · ${kinds.map(([k, n]) => `${n} ${k === 'chords' ? 'chord chart' : k}${n > 1 ? 's' : ''}`).join(', ') || 'empty'}</small></a>`;
    }).join('') : `<div class="empty">${CAT}<p>No collections yet. Make one for a recital, a class or a set list.</p></div>`;
  };
  $('#cl-add', main).onclick = async () => { const n = await promptSheet({ title: 'New collection', placeholder: 'e.g. Spring recital' }); if (n) go(`#/collection/${store.addCollection(n).id}`); };
  draw();
  return store.on(draw);
}

export function collectionView(main, { parts }) {
  const c = store.collection(parts[1]);
  if (!c) { go('#/collections'); return; }
  main.innerHTML = `<header class="top"><a class="icon-btn back" href="#/collections" aria-label="Back">${icon('back')}</a><h1 id="cv-name">${esc(c.name)}</h1><span class="grow"></span>
      <button class="icon-btn" id="cv-perform">${icon('perform')}<span class="hide-s">Perform set</span></button>
      <a class="icon-btn" href="#/print?col=${c.id}">${icon('print')}<span class="hide-s">Print</span></a>
      <button class="icon-btn" id="cv-more" aria-label="More">${icon('more')}</button></header>
    <p class="pad muted" id="cv-sum"></p>
    <ol class="rows ordered" id="cv-rows"></ol>
    <div class="pad"><button id="cv-add">${icon('plus')}Add music</button></div>`;
  const draw = () => {
    const items = c.itemIds.map((id) => store.get(id)).filter((x) => x && !x.deleted);
    const pages = items.reduce((s, it) => s + printedPages(it, 'A4'), 0);
    $('#cv-name', main).textContent = c.name;
    $('#cv-sum', main).textContent = `${items.length} item${items.length === 1 ? '' : 's'} · about ${pages} printed A4 page${pages === 1 ? '' : 's'}. Drag ${'☰'} to reorder.`;
    $('#cv-rows', main).innerHTML = items.map((it, i) => `<li class="row" draggable="true" data-id="${it.id}" data-i="${i}">
      <span class="handle" aria-hidden="true">${icon('drag')}</span><span class="num">${i + 1}</span>${thumbHtml(it)}
      <div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${badge(it.kind)}<span>${metaText(it)}</span><span class="dot">·</span><span>${printedPages(it, 'A4')} A4 p</span></div></div>
      <span class="updown"><button class="icon-btn" data-mv="-1" ${i ? '' : 'disabled'} aria-label="Move up">${icon('up')}</button><button class="icon-btn" data-mv="1" ${i < items.length - 1 ? '' : 'disabled'} aria-label="Move down">${icon('down')}</button></span>
      <button class="icon-btn row-more" aria-label="More">${icon('more')}</button></li>`).join('') ||
      `<li class="empty">${CAT}<p>This collection is empty.</p></li>`;
  };
  const rows = $('#cv-rows', main);
  rows.onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id, i = +row.dataset.i;
    const mv = e.target.closest('[data-mv]');
    if (mv) return store.moveInCollection(c.id, c.itemIds.indexOf(id), c.itemIds.indexOf(id) + +mv.dataset.mv);
    if (e.target.closest('.row-more')) return itemMenu(e.target.closest('.row-more'), id, [
      { label: 'Remove from this collection', icon: 'close', run: () => store.removeFromCollection(c.id, id) },
      { label: 'Perform the set from here', icon: 'perform', run: () => go(`#/perform/${id}?set=${c.id}`) }]);
    if (!e.target.closest('.handle')) go(`#/item/${id}`);
  };
  // drag to reorder (mouse / trackpad); touch uses the arrows
  let dragId = null;
  rows.addEventListener('dragstart', (e) => { const r = e.target.closest('.row'); dragId = r?.dataset.id; r?.classList.add('dragging'); });
  rows.addEventListener('dragend', (e) => e.target.closest('.row')?.classList.remove('dragging'));
  rows.addEventListener('dragover', (e) => { e.preventDefault(); });
  rows.addEventListener('drop', (e) => {
    e.preventDefault();
    const r = e.target.closest('.row');
    if (!r || !dragId || r.dataset.id === dragId) return;
    store.moveInCollection(c.id, c.itemIds.indexOf(dragId), c.itemIds.indexOf(r.dataset.id));
  });
  $('#cv-perform', main).onclick = () => { const first = c.itemIds.find((id) => store.get(id) && !store.get(id).deleted); first ? go(`#/perform/${first}?set=${c.id}`) : toast('Add some music first.'); };
  $('#cv-add', main).onclick = () => go(`#/library`) || toast('Use ⋯ → Add to collection on any item, or Select several.');
  $('#cv-more', main).onclick = (e) => menu(e.currentTarget, [
    { label: 'Rename', icon: 'edit', run: async () => { const n = await promptSheet({ title: 'Rename collection', value: c.name }); if (n) store.renameCollection(c.id, n); } },
    '-',
    { label: 'Delete collection', icon: 'bin', danger: true, run: async () => { if (await confirmSheet({ title: `Delete “${c.name}”?`, body: 'The music stays in your library.', ok: 'Delete', danger: true })) { store.deleteCollection(c.id); go('#/collections'); } } },
  ]);
  draw();
  return store.on(draw);
}

// ================= bin =================
export function binView(main) {
  main.innerHTML = `<header class="top"><h1>Bin</h1><span class="grow"></span><button class="danger-text" id="bn-empty">${icon('bin')}Empty bin</button></header>
    <p class="pad muted">Items stay here until you delete them for good. Deleting for good also removes their page images and files from the Mac.</p><ul class="rows" id="bn"></ul>`;
  const draw = () => {
    const items = store.items({ deleted: true }).sort((a, b) => b.deletedAt - a.deletedAt);
    $('#bn-empty', main).disabled = !items.length;
    $('#bn', main).innerHTML = items.map((it) => `<li class="row" data-id="${it.id}">${thumbHtml(it)}
      <div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${badge(it.kind)}<span>Deleted ${ago(it.deletedAt)}</span></div></div>
      <button data-act="restore">${icon('restore')}<span class="hide-s">Restore</span></button><button class="danger-text" data-act="purge">${icon('bin')}<span class="hide-s">Delete</span></button></li>`).join('') ||
      `<li class="empty">${CAT}<p>The bin is empty.</p></li>`;
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
    if (await confirmSheet({ title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'} for good?`, body: 'This cannot be undone.', ok: 'Empty bin', danger: true })) store.purge(ids);
  };
  draw();
  return store.on(draw);
}
