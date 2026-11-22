// Actions shared by the library, viewers and tags.
import { store } from '../store.js';
import { esc, icon, sheet, toast, menu, promptSheet, tagPicker, KIND } from '../ui.js';
import { go } from '../app.js';
import { sheetUrl } from '../sheet-art.js';
import { VERSIONS } from '../musicxml.js';
import { ITEM_ICONS } from '../item-icons.js';

// each song's icon, chosen offline on the Mac (tools/pick_icons.py); new music gets the default by type
const ICON_BASE = new URL('../../vendor/phosphor/', import.meta.url).href;
const DEFAULT_ICON = { sheet: 'file-text', score: 'music-notes', chords: 'guitar' };
export const songIcon = (it) => `<span class="song-ic" aria-hidden="true" style="--ic:url(${ICON_BASE}${it.icon || ITEM_ICONS[it.title] || DEFAULT_ICON[it.kind]}.svg)"></span>`;

export function thumbHtml(it) {
  if (it.kind === 'sheet') {
    const src = it.upload ? store.sessionImage(`${it.id}:1`) || sheetUrl(it.title, 1, it.pages) : sheetUrl(it.title, 1, it.pages, { artist: it.artist });
    return `<span class="thumb t-sheet"><img src="${src}" alt="" loading="lazy"></span>`;
  }
  return `<span class="thumb t-${it.kind}">${esc(String(it.key).split(' ')[0])}</span>`;
}

export function metaText(it) {
  if (it.kind === 'sheet') return `${it.pages} page${it.pages > 1 ? 's' : ''}${it.source === 'pdf' ? ' · PDF' : ''}`;
  if (it.kind === 'chords') return `Key ${it.key}${it.source === 'hopamchuan' ? ' · Hợp Âm Chuẩn' : ' · Ultimate Guitar'}`;
  return it.key;
}

export function editTags(ids) {
  ids = [].concat(ids);
  const items = ids.map((id) => store.get(id));
  const common = store.db.tags.filter((t) => items.every((it) => it.tags.includes(t)));
  let chosen = common;
  const s = sheet(`<h2>${ids.length > 1 ? `Tags for ${ids.length} items` : `Tags — ${esc(items[0].title)}`}</h2>
    ${ids.length > 1 ? '<p class="muted">Tags you turn on are added to every selected item; tags you turn off are removed.</p>' : ''}
    <div class="pick"></div>
    <div class="modal-actions"><button class="danger-text" data-none style="margin-right:auto">Remove all tags</button><button data-close>Cancel</button><button class="primary" data-ok>Save</button></div>`, { wide: true });
  const fill = (on) => { const box = s.el.querySelector('.pick'); box.innerHTML = ''; box.append(tagPicker([...store.db.tags], on, (v) => (chosen = v))); };
  fill(common);
  s.el.querySelector('[data-none]').onclick = () => {
    chosen = [];
    fill([]);
    // with several items selected, also strip tags they don't share
    if (ids.length > 1) s.el.querySelector('[data-ok]').onclick = () => { store.setTags(ids, [], [...new Set(items.flatMap((it) => it.tags))]); s.close(); toast('All tags removed'); };
  };
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
  toast(ids.length > 1 ? `${ids.length} items moved to Trash` : 'Moved to Trash', { label: 'Undo', run: () => store.restore(ids) });
}

// ⋯ menu. In the library: Open, edit, Print, bin. In a viewer, grouped as
// Info · Rename / Edit tags · what this kind can do · Print / Export · Move to Trash.
export function itemMenu(anchor, id, { viewer = false, info, tools = [], exports = [] } = {}) {
  const group = (...g) => g.filter((x) => x.length).flatMap((x, i) => (i ? ['-', ...x] : x));
  menu(anchor, group(
    viewer ? [{ label: 'Info', icon: 'info', run: info }] : [{ label: 'Open', icon: 'right', run: () => go(`#/item/${id}`) }],
    [{ label: 'Rename…', icon: 'edit', run: () => rename(id) }, { label: 'Edit tags…', icon: 'tag', run: () => editTags(id) }],
    tools,
    [{ label: 'Print…', icon: 'print', run: () => go(`#/print?item=${id}`) }, ...exports],
    [{ label: 'Move to Trash', icon: 'bin', danger: true, run: () => binItems(id) }],
  ));
}
