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
        'It makes the <b>Original</b> score; change it under ⋯ → <b>Edit notes</b>.',
        'Runs on the Mac: about 3–6 minutes for a 4-minute song.',
        'Progress shows on the Add score page and in <b>Activities</b>; keep using Meowsic meanwhile.',
      ])}
      ${sec('editnotes', 'Edit notes', [
        'Score ⋯ → <b>Edit notes</b>. Tap / click a note or rest to pick it; drag a box around notes; tap a bar’s empty space for <b>Bar ▾</b>; tap above the top staff for a chord name.',
        'iPad / iPhone: hold a note, then tap or drag to another for a range; <b>Several</b> adds each tap.',
        'Mac mouse: ⌘-click adds one, Shift-click picks a range. <b>Drag a note</b> up / down to change its pitch (in the key; ⌥ a semitone) or sideways to another beat (onto rests; onto a note of the same length they swap); Esc cancels.',
        'Click a <b>tie or slur</b> to pick it, then its ✕ or ⌫ takes it away.',
        '<b>Type notes</b>: A–G sets the picked note (or rest) to that letter in the key, nearest octave, then moves on — type a run like CDEFG. Shift+letter an octave higher. A length key first (2–6) sets the rest’s length.',
        'Keys: ← → next note · Shift ← → range · ⌘A all · Esc let go · ↑ ↓ (or # + / -) semitone · ⌘↑ ⌘↓ octave · Shift ↑ ↓ other hand · J respell · 2–6 length (1/16 … whole) · . dotted · L fill next rest · T tie · S slur · N add a note · ⌫ delete (a rest stays; on a rest: remove it) · ⌘C ⌘X ⌘V · R repeat · W whole bar · K chord name · ⌘Z / ⇧⌘Z undo / redo · space play · Page ↑ ↓ page.',
        'A bar left short shows a badge: tap it to fix.',
      ])}
      ${store.mode === 'mock' ? '<p class="muted small">Preview: sheets can be tried with <b>Samples</b>.</p>' : ''}
    </div>`;
}
