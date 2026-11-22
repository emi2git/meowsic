// Actions shared by the library, viewers and tags.
import { store } from '../store.js';
import { esc, icon, sheet, toast, menu, promptSheet, tagPicker, KIND } from '../ui.js';
import { go } from '../app.js';
import { sheetUrl } from '../sheet-art.js';

export function thumbHtml(it) {
  if (it.kind === 'sheet') {
    const src = it.upload ? store.sessionImage(`${it.id}:1`) || sheetUrl(it.title, 1, it.pages) : sheetUrl(it.title, 1, it.pages, { artist: it.artist });
    return `<span class="thumb t-sheet"><img src="${src}" alt="" loading="lazy"></span>`;
  }
  return `<span class="thumb t-${it.kind}">${icon(KIND[it.kind].icon)}</span>`;
}

export function metaText(it) {
  if (it.kind === 'sheet') return `${it.pages} page${it.pages > 1 ? 's' : ''}${it.source === 'pdf' ? ' · PDF' : ''}`;
  if (it.kind === 'chords') return `Key ${it.key}${it.source === 'hopamchuan' ? ' · Hợp Âm Chuẩn' : ' · Ultimate Guitar'}`;
  return `${it.versions.length} versions · ${it.key}`;
}

export function editTags(ids) {
  ids = [].concat(ids);
  const items = ids.map((id) => store.get(id));
  const common = store.db.tags.filter((t) => items.every((it) => it.tags.includes(t)));
  let chosen = common;
  const s = sheet(`<h2>${ids.length > 1 ? `Tags for ${ids.length} items` : `Tags — ${esc(items[0].title)}`}</h2>
    ${ids.length > 1 ? '<p class="muted">Tags you turn on are added to every selected item; tags you turn off are removed.</p>' : ''}
    <div class="pick"></div>
    <div class="modal-actions"><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`, { wide: true });
  s.el.querySelector('.pick').append(tagPicker([...store.db.tags], common, (v) => (chosen = v)));
  s.el.querySelector('[data-ok]').onclick = () => {
    const remove = common.filter((t) => !chosen.includes(t));
    store.setTags(ids, chosen, remove);
    s.close();
    toast('Tags saved');
  };
}

export async function rename(id) {
  const it = store.get(id);
  const t = await promptSheet({ title: 'Rename', value: it.title });
  if (t) store.update(id, { title: t });
}

export function binItems(ids) {
  ids = [].concat(ids);
  store.bin(ids);
  toast(ids.length > 1 ? `${ids.length} items moved to the bin` : 'Moved to the bin', { label: 'Undo', run: () => store.restore(ids) });
}

export function itemMenu(anchor, id, extra = []) {
  menu(anchor, [
    { label: 'Open', icon: 'right', run: () => go(`#/item/${id}`) },
    { label: 'Performance mode', icon: 'perform', run: () => go(`#/perform/${id}`) },
    '-',
    { label: 'Rename', icon: 'edit', run: () => rename(id) },
    { label: 'Edit tags', icon: 'tag', run: () => editTags(id) },
    { label: 'Print', icon: 'print', run: () => go(`#/print?item=${id}`) },
    ...extra,
    '-',
    { label: 'Move to bin', icon: 'bin', danger: true, run: () => binItems(id) },
  ]);
}
