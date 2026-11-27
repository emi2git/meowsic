// Help (App section; iPhone: More): where music can come from and how each Add path works. Add music itself stays short.
import { store } from '../store.js';
import { noteIcon, EVEN_IC } from '../notevalue.js';
import { versionLine } from '../update.js';

// Edit notes' length keys: [key, quarters, name]
const LEN_KEYS = [['1', 0.125, '32nd note'], ['2', 0.25, '16th note'], ['3', 0.5, 'eighth note'], ['4', 1, 'quarter note'], ['5', 2, 'half note'], ['6', 4, 'whole note']];

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
        'With the Mac, <b>Sheet</b> opens on your “Sheet” album in Apple Photos and reads its new photos at once. Photos is only read, never changed.',
        'New = put into the album since the last time you added from it. A photo you added, or skipped, is never offered again — even if you delete its sheet.',
        '<b>✕ Skip</b> — not a sheet. <b>Show skipped</b> on the album screen brings one back.',
        '<b>Files</b> — photos or PDFs. On iPad / iPhone: photo library, camera or Files.',
        '<b>Camera</b> (iPad / iPhone) — take a photo of the page.',
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
        '<b>Tempo</b> (− 96 +, beats per minute): steps of 5, hold to keep going; tap the number to type it, tap the beat, or ↺ back to the score’s own tempo. Kept for each score; Edit notes and the voice play at it too.',
        'Runs on the Mac: about 3–6 minutes for a 4-minute song.',
        'Progress shows on the Add score page and in <b>Activities</b>; keep using Meowsic meanwhile.',
      ])}
      ${sec('editnotes', 'Edit notes', [
        'The score’s ✎ opens <b>Edit notes</b>. Tap / click a note or rest to pick it; drag a box around notes; tap a bar’s empty space for <b>Bar ▾</b>; tap above the top staff for a chord name.',
        'iPad / iPhone: hold a note, then tap or drag to another for a range; <b>Several</b> adds each tap.',
        'Mac mouse: ⌘-click adds one, Shift-click picks a range. <b>Drag a note</b> up / down to change its pitch (in the key; ⌥ a semitone) or sideways to another beat (onto rests; onto a note of the same length they swap); Esc cancels.',
        'Click a <b>tie or slur</b> to pick it, then its ✕ or ⌫ takes it away.',
        '<b>Words</b> are edited in the same view: click a word under a note (or pick a note and press Enter / <b>Aa</b>) and type; “-” the word goes on, space a new word, Enter / Tab next note, Esc back to the notes.',
        'A score with a voice part and a piano part: every staff can be picked and edited, the voice line too.',
        '<b>Type notes</b>: A–G sets the picked note (or rest) to that letter in the key, nearest octave, then moves on — type a run like CDEFG. Shift+letter an octave higher. A length key first (1–6) sets the rest’s length.',
        `<b>Lengths</b> (keys 1–6, or the buttons): ${LEN_KEYS.map(([k, q, w]) => `<span class="help-len" title="${w}"><kbd>${k}</kbd> ${noteIcon(q)}<span class="sr">${w}</span></span>`).join(' ')} · <kbd>.</kbd> dotted. A picked rest shows rests: ${LEN_KEYS.map(([, q, w]) => `${noteIcon(q, { rest: true })}<span class="sr">${w.replace('note', 'rest')}</span>`).join(' ')}. MIDI keyboard: the low length keys C D E F G B = ${[4, 2, 1, 0.5, 0.25, 0.125].map((q) => noteIcon(q)).join(' ')}.`,
        `<b>Even out</b> (<kbd>Q</kbd>, or ${EVEN_IC}<span class="sr">Even out</span>): pick 2 or more notes one after the other in one hand and bar — they get one length each, the same total: ${noteIcon(0.75)}${noteIcon(0.25)} → ${noteIcon(0.5)}${noteIcon(0.5)}, ${noteIcon(1.5)}${noteIcon(0.5)} → ${noteIcon(1)}${noteIcon(1)}. Pitches, ties, slurs and lyrics stay; a split that needs a triplet is refused.`,
        'Keys: ← → next note · Shift ← → range · ⌘A all · Esc let go · ↑ ↓ (or # + / -) semitone · ⌘↑ ⌘↓ octave · Shift ↑ ↓ other hand · J respell · 1–6 length · . dotted · Q even out · L fill next rest · T tie · S slur · N add a note · Enter words · ⌫ delete (a rest stays; on a rest: remove it) · ⌘C ⌘X ⌘V · R repeat · W whole bar · K chord name · ⌘Z / ⇧⌘Z undo / redo · space play · Page ↑ ↓ page.',
        'A bar left short shows a badge: tap it to fix.',
      ])}
      ${store.mode === 'mock' ? '<p class="muted small">Preview: sheets can be tried with <b>Samples</b>.</p>' : ''}
      <p class="center muted small" id="help-version">${versionLine(store.mode === 'mock')}</p>
    </div>`;
}
