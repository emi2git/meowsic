// Actions shared by the library, viewers and tags, and the item ⋯ menus.
import { store } from '../store.js';
import { esc, sheet, toast, menu, tagPicker } from '../ui.js';
import { go } from '../app.js';
import { sheetUrl } from '../sheet-art.js';
import { openInfo } from './info.js';

// The item menus. Info (info.js) is the one place to read and edit an item (title, artist, album, key, version,
// tags), so a ⋯ menu holds only things to DO with it, and nothing twice:
//   library row ⋯   Info · Move to Trash   (nothing to print or change in a song that is not open)
//   viewer ⋯        Info · the kind's tools · Export ▸ · Move to Trash
// tools / exports come from the view (sheet.js sheetTools / sheetExports, score.js scoreTools / scoreExportMenu,
// chordsview.js chordsExports) and are built each time ⋯ is tapped, so their labels follow the item.
const infoEntry = (id) => ({ label: 'Info', icon: 'info', run: () => openInfo(id) });
const trashEntry = (id) => ({ label: 'Move to Trash', icon: 'bin', danger: true, run: () => binItems(id) });
export function itemMenu(anchor, id) {
  menu(anchor, [infoEntry(id), '-', trashEntry(id)]);
}
export function viewerMenu(anchor, id, { tools = [], exports = [] } = {}) {
  const group = (...g) => g.filter((x) => x.length).flatMap((x, i) => (i ? ['-', ...x] : x));
  menu(anchor, group([infoEntry(id)], tools, exports.length ? [{ label: 'Export', icon: 'download', sub: exports }] : [], [trashEntry(id)]));
}
// Export ▸ "Print / PDF…": the print view (the browser's print dialog also saves a PDF)
export const printEntry = (id) => ({ label: 'Print / PDF…', icon: 'print', run: () => go(`#/print?item=${encodeURIComponent(id)}`) });
// save a file: text or a Blob (or { url } for a file the Mac serves)
export function download(name, data, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = data?.url || URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  if (!data?.url) setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function thumbHtml(it) {
  if (it.kind === 'sheet') {
    const src = it.upload ? store.sessionImage(`${it.id}:1`) || sheetUrl(it.title, 1, it.pages) : sheetUrl(it.title, 1, it.pages, { artist: it.artist });
    return `<span class="thumb t-sheet"><img src="${src}" alt="" loading="lazy"></span>`;
  }
  return `<span class="thumb t-${it.kind}">${esc(String(it.key).split(' ')[0])}</span>`;
}

// "C major" → "C", "A minor" → "Am", "Key G" → "G"
// a song's key as a chord name, written like the chord charts (b / #): "A major" → A, "D minor" → Dm, "Bb major" → Bb
export const keyShort = (k) => String(k || '').replace(/^key\s*/i, '').replace(/\s*(major|maj)$/i, '').replace(/\s*(minor|min)$/i, 'm').replace(/♭/g, 'b').replace(/♯/g, '#').trim();

export function metaText(it) {
  if (it.kind === 'sheet') return `${it.pages} page${it.pages > 1 ? 's' : ''}`; // file type lives under Info
  if (it.kind === 'chords') return keyShort(it.key); // the source site lives under Info, not in the list
  return keyShort(it.key); // the version has its own column on the Scores view
}

// Version, in the user's three words. Sheets: 'lead' | 'piano' | 'duet' ('' = not known; books too).
// Scores: what the notes are (the server counts the MusicXML's staves into `staves`):
//   duet → Duet; lead, or one staff (a melody line) → Lead; a grand staff (right + left hand) → Piano.
//   Voice + piano ('vocal') shows as Piano ("Piano · vocals" under Info).
export const SHEET_VERSIONS = { lead: 'Lead', piano: 'Piano', duet: 'Duet', accomp: 'Accomp.' };  // accomp: the piano part only, no melody
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

export function binItems(ids) {
  ids = [].concat(ids);
  store.bin(ids);
  toast(ids.length > 1 ? `${ids.length} items moved to Trash` : 'Moved to Trash', { label: 'Undo', run: () => store.restore(ids) });
}

