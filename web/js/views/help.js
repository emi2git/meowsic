// Help (App section; iPhone: More): where music can come from and how each Add path works. Add music itself stays short.
import { store } from '../store.js';

const sec = (id, title, items) => `<section class="card help-sec" id="help-${id}"><h2>${title}</h2><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></section>`;

export function helpView(main) {
  main.innerHTML = `
    <header class="top"><h1>Help</h1></header>
    <div class="pad narrow help">
      ${sec('add', 'Add music', [
        '<b>Sheet</b> — photos or PDFs of printed music.',
        '<b>Chords</b> — a chord chart from the web, or pasted.',
        '<b>Score</b> — notes written out from a recording.',
        'Tap <b>Add music</b> in the left bar (or <b>Add</b> on iPhone), then pick one.',
      ])}
      ${sec('sheet', 'Sheet', [
        '<b>Files</b> — photos or PDFs. On iPad / iPhone: photo library, camera or Files.',
        '<b>Camera</b> (iPad / iPhone) — take a photo of the page.',
        '<b>Photos</b> — the new photos in your “SHEET” album in Apple Photos. Only read, never changed. Needs the Mac.',
        'On the Mac you can also drag files onto the page.',
        'The Mac reads each page and finds its title.',
        'A page with a title starts a new sheet; the pages after it join it.',
        'Check the grouping, fix titles and tags, then add.',
      ])}
      ${sec('chords', 'Chords', [
        'Type a song name. Results come from Ultimate Guitar (English) and Hợp Âm Chuẩn (Vietnamese).',
        '<b>Auto / English / Vietnamese</b> picks the source.',
        'Pick a result to preview, change the key, add tags, then <b>Save to library</b>.',
        '<b>Paste</b> — type or paste a chart yourself; chords in [square brackets] before the syllable.',
      ])}
      ${sec('score', 'Score', [
        '<b>YouTube</b> — paste a YouTube (or Facebook) link.',
        '<b>Audio file</b> — MP3, M4A, WAV or a video.',
        'It makes the <b>Original</b> score; change it with the ✎ <b>Edit notes</b> button above the score.',
        'Runs on the Mac: about 3–6 minutes for a 4-minute song.',
        'Progress shows on the Add score page and in <b>Activities</b>; keep using Meowsic meanwhile.',
      ])}
      ${store.mode === 'mock' ? '<p class="muted small">Preview: sheets can be tried with <b>Samples</b>.</p>' : ''}
    </div>`;
}
