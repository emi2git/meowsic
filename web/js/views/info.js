// Info popup for one sheet, book, chord chart or score — the ONE place to read and edit an item: the editable
// fields (title, artist, album, key, version, tags; textinput.js puts the voice mic on every text field), the
// facts, Save / Cancel. Save = one PATCH (the Mac keeps history + Activities undo). Things to DO with an item
// (Edit pages, Make a score, Export, Move to Trash…) live only in the ⋯ menus (actions.js), never here too.
// iPhone: a full-screen sheet (app.css).
import { store } from '../store.js';
import { $, esc, badge, ago, mins, scoreSource, sheet, tagPicker, toast } from '../ui.js';
import { metaText, verLabel, verDetail, SHEET_VERSIONS } from './actions.js';
import { VERSIONS } from '../musicxml.js';

const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
// the item's original date: when the photo was taken / the file was made / the score transcribed / the chords fetched
function originRow(it) {
  const label = it.kind === 'sheet' ? (it.source === 'pdf' || !it.pageDates?.some(Boolean) && it.fileDate ? 'File date' : 'Photo taken')
    : it.kind === 'score' ? (it.source?.startsWith('From the score') ? 'Made' : 'Transcribed') : it.source === 'pasted' ? 'Pasted' : 'Fetched from the web';
  const t = it.originAt || (it.kind === 'sheet' ? it.pageDates?.find(Boolean) : null) || it.createdAt;
  const pages = it.kind === 'sheet' && it.pageDates?.length > 1 && new Set(it.pageDates.filter(Boolean).map((d) => new Date(d).toDateString())).size > 1
    ? `<br><small>Pages taken ${it.pageDates.map((d, i) => `${i + 1}: ${d ? new Date(d).toLocaleDateString() : '—'}`).join(' · ')}</small>` : '';
  return `<dt>${label}</dt><dd>${fmtDate(t)}${pages}</dd>`;
}

const FIELD = (k, label, v, ph) => `<label class="if-row"><span>${label}</span><input type="text" id="if-${k}" data-k="${k}" value="${esc(v || '')}" placeholder="${esc(ph)}" autocomplete="off"></label>`;

export function openInfo(id) {
  const it = store.get(id);
  if (!it) return null;
  const plays = store.plays(it.id);
  const total = plays.reduce((s, p) => s + (p.closedAt - p.openedAt), 0);
  const src = it.kind === 'score' ? scoreSource(it) : null;
  const versioned = it.kind === 'sheet' || it.kind === 'chords';
  let version = it.version || '', tags = [...it.tags];
  const onHash = () => s.close(); // going somewhere else (Back, a link): the popup goes too
  const s = sheet(`<div id="it-info" class="info">
    <div class="info-head"><h2>Info</h2><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" id="if-save">Save</button></div>
    <div class="if-fields">
      ${FIELD('title', 'Title', it.title, 'Title')}
      ${FIELD('artist', 'Artist', it.artist, 'e.g. Alan Menken, Trịnh Công Sơn')}
      ${FIELD('album', 'Album', it.album, 'e.g. Frozen, Les Misérables, Carnival of the Animals')}
      ${FIELD('key', 'Key', it.key, 'e.g. C, Am, F#m, Bb')}
      <div class="if-row"><span>Version</span>${versioned ? `<div class="seg ver-seg" id="if-ver" role="radiogroup" aria-label="Version">${Object.entries(SHEET_VERSIONS).map(([v, l]) =>
        `<button type="button" role="radio" aria-checked="${version === v}" class="${version === v ? 'on' : ''}" data-ver="${v}">${l}</button>`).join('')}</div>`
        : `<div id="if-ver">${esc(verLabel(it))}${verDetail(it) !== verLabel(it) ? ` <small class="muted" title="${esc(VERSIONS[it.version] || '')}">${esc(verDetail(it))}</small>` : ''}</div>`}</div>
      <div class="if-row if-tags"><span>Tags</span><div id="if-tags"></div></div>
    </div>
    <dl class="if-facts">
      <dt>Type</dt><dd>${badge(it)} ${metaText(it)}</dd>
      ${it.kind === 'sheet' ? `<dt>Pages</dt><dd>${it.pages || 0}</dd><dt>File</dt><dd>${it.source === 'pdf' ? 'PDF' : 'Photos (images)'}</dd>` : ''}
      ${it.kind === 'chords' ? `<dt>Source</dt><dd id="dt-source">${it.url ? `<a class="src-link" href="${esc(it.url)}" target="_blank" rel="noopener">${it.source === 'hopamchuan' ? 'Hợp Âm Chuẩn' : it.source === 'pasted' ? 'Pasted' : 'Ultimate Guitar'}</a>` : esc(it.source === 'pasted' ? 'Pasted' : it.source || '—')}${it.capo ? `<br><small>Capo ${it.capo}</small>` : ''}</dd>` : ''}
      ${src ? `<dt>Source</dt><dd id="dt-source"><span class="src-name">${esc(src.name || '—')}</span>${src.url ? `<br><a class="src-link" href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a><br><button type="button" class="link" id="dt-copy">Copy link</button>` : ''}</dd>` : ''}
      <dt>Practice</dt><dd>${plays.length} session${plays.length === 1 ? '' : 's'} · ${mins(total)}<br><small>Last played ${ago(store.lastPlayed(it.id))}</small></dd>
      ${originRow(it)}
      <dt>Added</dt><dd>${fmtDate(it.createdAt)}</dd>
      ${it.updatedAt ? `<dt>Changed</dt><dd>${fmtDate(it.updatedAt)}</dd>` : ''}
    </dl>
  </div>`, { wide: true, onClose: () => removeEventListener('hashchange', onHash) });
  s.el.classList.add('info-modal');
  addEventListener('hashchange', onHash, { once: true });
  $('#if-tags', s.el).append(tagPicker([...store.db.tags], tags, (v) => (tags = v)));
  $('#if-ver.ver-seg', s.el)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver]');
    if (!b) return;
    version = version === b.dataset.ver ? '' : b.dataset.ver; // tap the lit one again to clear it
    s.el.querySelectorAll('#if-ver [data-ver]').forEach((x) => { const on = x.dataset.ver === version; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  });
  const cp = $('#dt-copy', s.el);
  if (cp) cp.onclick = () => { (navigator.clipboard?.writeText(src.url) || Promise.reject()).then(() => toast('Link copied'), () => prompt('Copy the link', src.url)); };
  const save = () => {
    const patch = {};
    for (const el of s.el.querySelectorAll('.if-fields input[data-k]')) {
      const k = el.dataset.k, v = el.value.replace(/\s+/g, ' ').trim();
      if (k === 'title' && !v) { el.focus(); return toast('A title is needed'); }
      if (v !== (it[k] || '')) patch[k] = v;
    }
    if (versioned && version !== (it.version || '')) patch.version = version;
    if (tags.length !== it.tags.length || tags.some((t) => !it.tags.includes(t))) { patch.tags = tags; tags.forEach((t) => store.addTag(t)); }
    s.close();
    if (!Object.keys(patch).length) return;
    store.update(id, patch);
    toast('Saved');
  };
  $('#if-save', s.el).onclick = save;
  s.el.querySelector('.if-fields').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-k]')) { e.preventDefault(); save(); } });
  return s;
}
