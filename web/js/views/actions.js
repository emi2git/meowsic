// Actions shared by the library, viewers and tags.
import { store } from '../store.js';
import { esc, icon, sheet, toast, menu, promptSheet, tagPicker, KIND } from '../ui.js';
import { go } from '../app.js';
import { sheetUrl } from '../sheet-art.js';
import { VERSIONS } from '../musicxml.js';

export function thumbHtml(it) {
  if (it.kind === 'sheet') {
    const src = it.upload ? store.sessionImage(`${it.id}:1`) || sheetUrl(it.title, 1, it.pages) : sheetUrl(it.title, 1, it.pages, { artist: it.artist });
    return `<span class="thumb t-sheet"><img src="${src}" alt="" loading="lazy"></span>`;
  }
  return `<span class="thumb t-${it.kind}">${esc(String(it.key).split(' ')[0])}</span>`;
}

// "C major" → "C", "A minor" → "Am", "Key G" → "G"
export const keyShort = (k) => String(k || '').replace(/^key\s*/i, '').replace(/\s*major$/i, '').replace(/\s*minor$/i, 'm').trim();

export function metaText(it) {
  if (it.kind === 'sheet') return `${it.pages} page${it.pages > 1 ? 's' : ''}`; // file type lives under Info
  if (it.kind === 'chords') return keyShort(it.key); // the source site lives under Info, not in the list
  return keyShort(it.key); // the version has its own column on the Scores view
}

// Version, in the user's three words. Sheets: 'lead' | 'piano' | 'duet' ('' = not known; books too).
// Scores: what the notes are (the server counts the MusicXML's staves into `staves`):
//   duet → Duet; lead, or one staff (a melody line) → Lead; a grand staff (right + left hand) → Piano.
//   Voice + piano ('vocal') shows as Piano ("Piano · vocals" under Info).
export const SHEET_VERSIONS = { lead: 'Lead', piano: 'Piano', duet: 'Duet' };
export function verLabel(it) {
  if (it.kind === 'sheet' || it.kind === 'chords') return SHEET_VERSIONS[it.version] || '';
  if (it.kind === 'score') return it.version === 'duet' ? 'Duet' : it.version === 'lead' || it.staves === 1 ? 'Lead' : 'Piano';
  return '';
}
const DETAIL = { original: 'original', vocal: 'vocals', accomp: 'accompaniment', clear: 'clear', pro: 'pro', easy: 'easy' };
// the score's own version under the word: "Piano · clear" (sheets and lead sheets: just the word)
export const verDetail = (it) => (it.kind === 'score' && verLabel(it) === 'Piano' && DETAIL[it.version] ? `Piano · ${DETAIL[it.version]}` : verLabel(it));

// pick Lead / Piano / Duet / Not set for one sheet / chord chart or many (scores are skipped)
export function versionMenu(anchor, ids) {
  ids = [].concat(ids);
  const sheets = ids.map((id) => store.get(id)).filter((it) => it?.kind === 'sheet' || it?.kind === 'chords');
  const cur = sheets.length && sheets.every((it) => (it.version || '') === (sheets[0].version || '')) ? sheets[0].version || '' : null;
  menu(anchor, [...Object.entries(SHEET_VERSIONS), ['', 'Not set']].map(([v, l]) => ({
    label: l, checked: cur === v,
    run: () => {
      if (!sheets.length) return toast('Only sheets, books and chord charts get a version here — a score’s version is its arrangement');
      store.setVersion(sheets.map((it) => it.id), v);
      const skip = ids.length - sheets.length;
      toast((ids.length > 1 ? `${sheets.length} set to ${l}` : `Version: ${l}`) + (skip ? ` · ${skip} score${skip > 1 ? 's' : ''} kept` : ''));
    },
  })));
}

// a sheet's key ('F', 'Am', 'Eb major'); empty clears it
export async function editKey(id) {
  const it = store.get(id);
  const k = await promptSheet({ title: `Key — ${it.title}`, value: it.key || '', placeholder: 'e.g. C, Am, F#m, Bb', required: false });
  if (k !== null && k !== (it.key || '')) store.update(id, { key: k });
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

// An item's actions, grouped ('-' = a line). The library ⋯ menu shows them; in a viewer the ⋯ holds only Info and
// these are the Actions section of the Info popup (info.js), so whatever a view adds to tools / exports shows there too.
export function itemActions(anchor, id, { viewer = false, info, tools = [], exports = [] } = {}) {
  const group = (...g) => g.filter((x) => x.length).flatMap((x, i) => (i ? ['-', ...x] : x));
  return group(
    viewer ? (info ? [{ label: 'Info', icon: 'info', run: info }] : []) : [{ label: 'Open', icon: 'right', run: () => go(`#/item/${id}`) }],
    [{ label: 'Rename…', icon: 'edit', run: () => rename(id) }, { label: 'Edit tags…', icon: 'tag', run: () => editTags(id) },
      ...(['sheet', 'chords'].includes(store.get(id)?.kind) ? [{ label: `Version: ${verLabel(store.get(id)) || 'Lead / Piano / Duet'}…`, icon: 'score', run: () => versionMenu(anchor, id) },
        { label: `Key: ${store.get(id).key || 'not set'}…`, icon: 'edit', run: () => editKey(id) }] : [])],
    tools,
    [{ label: 'Print…', icon: 'print', run: () => go(`#/print?item=${id}`) }, ...exports],
    [{ label: 'Move to Trash', icon: 'bin', danger: true, run: () => binItems(id) }],
  );
}
export function itemMenu(anchor, id, opts = {}) {
  menu(anchor, itemActions(anchor, id, opts));
}
