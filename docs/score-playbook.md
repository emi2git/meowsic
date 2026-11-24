# Making a score for the user: the playbook

The user often asks "make me a score of X" and gives a clue: sheet photos / screenshots, a sheet already in
the library, a YouTube video, or lyrics. This is what worked (Nov 2026). Read §0 before you touch anything.

## 0. Safety rules (hard, learned the hard way on 2026-11-24)
- **Never write to an item the user may be editing.** Before any write, look in `~/Documents/Meowsic/work/server.log`
  for `editnotes` / `editnotes/preview` / `lyrics` requests on that id in the last 10 min. If you see any, wait or ask.
  (A server-side "item is being edited" lock was planned. As of this writing v2 has none:
  `grep -rniE 'edit.?lock|being edited' server/meowsic`. If that finds a lock, honour it.)
- **One logged, undoable save per change** (an Activities row + a `.history/` copy). Use `POST …/editnotes`,
  `POST …/lyrics` or `POST /api/items` (new item). Don't use `PUT …/musicxml`. It writes no Activities row.
  Pass `sha` (from the GET) so a save fails with 409 if the score changed underneath you.
- **Never restart, signal, kill or debugger-attach the live server** (port 5180). A failed `lldb -p` attach killed it
  and lost the user's unsaved work. Only the deploy agent restarts it (`scripts/deploy`).
- Tests never touch :5180 or `~/Documents/Meowsic` (use `scripts/dev-server`, with `--data <copy>` if you need real songs).
- Publisher content (scans, lyrics, even titles) stays on this Mac. Never print lyric text in chat, logs or commits.
  Give counts only.
- **Downloads need the user's explicit OK, every time** (video, models, packages). Say what it is and how big.
- Main session = PM. Subagents do the work. Only the deploy agent touches the live checkout `~/git/apps/meowsic`.
- Originals stay untouched: a new reading or a fix of someone else's score becomes a **new item** (same `groupId`).

## 1. Inputs and routes
All API calls go to `https://localhost:5180/api/…`, with the CA at `~/Documents/Meowsic/certs/meowsic-ca.pem`.
| Clue | Route |
|---|---|
| Sheet photos in the Photos album | Add music → From Photos (`photoimport.py`: `GET /api/photos/album?name=SHEET`, `POST /api/photos/sessions`, `…/import`) |
| Screenshots not in an album | Export the originals read-only with the helper: `migrate/.venv/bin/python migrate/photos_album.py fetch <out dir> <photo id> …` (iCloud-only photos are downloaded, HEIC becomes JPEG). Then upload them as a sheet: `POST /api/sheets` (multipart `files`, `title`, `artist`, `tags`; `item_id` adds pages to an existing sheet) |
| Sheet already in the library | Make a score, the same call as the sheet's ⋯ → "Make a score…": `POST /api/jobs {kind:'omr', title, source:'From the sheet “T”', outputs:['original'], fromItemId:<sheet id>, artist}`. Poll `GET /api/jobs/{id}` |
| YouTube video | See §1a |
| Lyrics text | See §1b |
| Composed / hand-written MusicXML | `~/git/scripts/meowsic-add-ai-score.py score.musicxml --title … --artist "<real artist>"` (it checks bars first), or `POST /api/items {kind:'score', title, musicxmlText, groupId?, version?, tags?}` |

### 1a. From a video
1. Ask before downloading (say the size). `yt-dlp -f 'bv*[height<=1080]+ba/b' …`: use 1080p when the on-screen lyrics
   are small. Work in a scratch folder and **delete the video afterwards**.
2. On-screen lyrics: `omr/.venv/bin/python ~/git/scripts/video-subtitle-ocr.py VIDEO out.json --fps 4 --crop W:H:X:Y --lang en-US`
   (Apple Vision OCR, all local; crop = the subtitle strip). **YouTube auto-captions are often wrong. Don't use them
   for the words.** Use Whisper (`~/ai/models`, mlx whisper-large-v3-turbo) only for word timing.
3. The sung melody: separate the vocals (HTDemucs in `~/ai/models/huggingface`). Pitch-track them with librosa pyin
   (`pitch.npz`) or basic-pitch (`notes.json`), get beats with beat_this (`bt.json`), then:
   `omr/.venv/bin/python ~/git/scripts/sung-melody-to-musicxml.py --beats bt.json --words aligned.json --syl syl.json (--pyin pitch.npz | --bp notes.json) [--grid 2|4] [--triplets] [--key N] --out X.musicxml --report rep.json`
4. Make **several versions (A–D)**: pyin vs basic-pitch, `--grid 2` (1/8) vs `--grid 4 --triplets` (1/16 + triplets).
   Score each one on pitch accuracy and on how well syllable onsets match the notes. Octave-normalize each phrase
   (keep one singable register). Show the user the best one and say which bars are borderline.

### 1b. Lyrics
- Sources, in this order: the user's own text; the library (chord charts `c-*` of the same song; the sheet's own words
  through OMR, `server/.venv/bin/python ~/git/scripts/meowsic-sheet-lyrics.py <score id> <sheet id> [--dry]`;
  older copies in `items/<id>/.history/`); on-screen lyrics from the video (§1a).
- Online lyric lookup **only with the user's explicit OK, for each song** (copyright). Only the title goes out.
- Never print the words. Report syllable / line counts.

## 2. Accuracy method (sheet → score)
1. OMR reads with two readers (`omr/omr.py`: homr + Audiveris) and votes bar by bar. Bars where they disagree or that
   don't add up are marked "check" (`<miscellaneous-field name="meowsic-check-bars">`, shown by Check bars:
   `GET/POST /api/items/{id}/check`).
2. Then check **every bar** against a zoomed crop of the page image (crop each system or bar with PIL and look at it):
   pitches, accidentals, rhythm, ties, rests, lyrics.
3. Then a **second, independent auditor** (a fresh subagent that is given the page crops and the score, not your
   conclusions) checks the bars again. Fix what it finds.
4. Every bar must be full: each voice adds up to the time signature (`~/git/scripts/omr-fix-bars.py in.mxl out.musicxml`
   pads, dots or copies. It only reports long bars). Check bars must end with **0 open flags**.
5. Render it and compare it with the page side by side (open the score in a dev-server, or render with music21/OSMD).
6. Watch for: triplets, pickup bars (`pickup` op), key / time changes mid-song (`keysig`, `timesig`), duet parts written
   as chords in one staff, and more than one lyric line (verse 2 = `<lyric number="2">`).

## 3. Fitting lyrics
- One syllable per note. A split word keeps all its pieces (`syllabic` begin/middle/end), and every piece is a real syllable.
- A tie or melisma carries the syllable on (`holds` → `<extend/>`). No words on rests or on instrumental bars.
- Repeats: the second time's words go on verse 2.
- When the notes are misread, align by rhythm and phrasing, not note count. When the singer has an extra syllable on a
  tied note, break the tie.
- API: `GET /api/items/{id}/lyrics?line=` (notes + refs + sha), `POST …/lyrics/preview`, then
  `POST …/lyrics {line, verse, notes:[{ref,text,syllabic}], holds, sha, mode:'this'|'new'}`.

## 4. Fixing a melody against a recording
- Agreement rule: change a note only when **at least 3 of the 4** pitch-tracked versions (A–D) agree.
- Keep the score's register, its chords and its left hand. Change only the tune.
- List the borderline bars for the user. Don't guess silently.

## 5. Chord symbols
- Work out the harmony from the notes (functional harmony, in the key). Use a slash chord only for clear bass motion
  (C/E in a walking-down line). `chordfind.py`, the automatic finder, never writes slash chords.
- Write the names in the `chordname.py` grammar (`Bbm7`, `C/E`, `N.C.`) so the Play chords toggle can voice them.
  Add each one with the editnotes op `{op:'chord', bar, on, text}`.

## 6. Merging two sources
Example: an accurate sheet as the base, plus an intro, fills, decorations or left hand from a YouTube transcription.
- Transpose the extra source into the base's keys. Align the two by melody contour, bar by bar.
- Add only ornaments, intro and fills. The base's melody, rhythm and **lyrics** stay.
- Save it as a new item in the same group.

## 7. Library conventions
- Title as printed on the page. If the user calls it something else, ask which one to use.
- Album, e.g. `NDP songs`. Tags as the user uses them. Add `Verified` only after a full check (the user's badge).
- Autofill fills artist / album from the library and **never sets the key**. Set `key` yourself (PATCH `/api/items/{id}`).
- No tempo marks on scores (the app hides them anyway, `noTempoXml`). The bpm goes in the item field.
- New versions are new items (`POST /api/items` with `groupId`, or `mode:'new'` on editnotes / lyrics). Originals stay as they are.
- `PATCH /api/items/{id}` for title / artist / album / tags / key (one Activities row each).

## 8. Saving edits in place (summary)
`POST /api/items/{id}/editnotes {sha, ops:[…], mode:'this'|'new'}`. The ops are listed in the `staffmove.py`
`edit()` docstring: pitch, len, set, add, delete, tie, slur, alt (replace a bar with given `<measure>` XML),
fillbar, bartime, pickup, keysig, timesig, chord, … Preview first with `POST …/editnotes/preview`.
Each save = one Activities row with a 24 h Undo.

## 9. Reference songs (ids)
| Song | Ids / notes |
|---|---|
| Home (NDP) | `m-b6xs990` |
| One Day More | score `m-7kynu6y` (from YouTube, A major); sheet `s-3hmg922` (4 pages, C major). Lyrics fitted with meowsic-sheet-lyrics.py |
| Our Singapore | `m-irrw2nj`: from MuseScore screenshots + the video's on-screen lyrics, Verified. Sung-melody versions A–D: `m-dpfen7t`, `m-r3wf2af`, `m-7rqhz65`, `m-9f43ynr` |
| You Are My Sunshine | `m-g3vp6s7` |
| Two Tigers (两只老虎) | `m-nrogmyq` (Mandarin singing) |
