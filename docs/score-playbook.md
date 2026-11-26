# Making a score for the user: the playbook

> Private use only: read "Transcribing songs (private use)" in `CLAUDE.md` first (what is in scope, and the guardrails).
> Sheet → score: the step-by-step procedure, the 5-verifier workflow and the lessons log are in the skill `.claude/skills/transcribe-sheet/` (`SKILL.md`).

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
| Sheet photos in the Photos album | Add sheet music opens on the album (`photoimport.py`: `GET /api/photos/album?name=SHEET`, `POST /api/photos/sessions`, `…/import`; added / skipped photos are remembered in `photo_handled`, the last check in `photo_check`) |
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
7. **Onset check (rhythm placement), every bar, every staff.** A pitch-sequence diff and a note-type diff both pass
   a melody whose notes sit an eighth early or late, so they prove nothing about rhythm. Learned from the user's own
   fixes of a 6/8 lead sheet (`m-4e35je7`, act-3xskunq, 18 bars): the draft had
   - notes struck one eighth late or early (an anticipation across the bar line moved onto the downbeat; a note on
     the 3rd eighth moved to the 2nd);
   - a note held across the middle of the 6/8 bar (eighth tied over beat 2) written as note + **rest** + re-attack,
     or as three quarters (0-2-4) instead of the compound 0-2~3-5 pattern;
   - lengths that were wrong because the next onset was wrong, so every bar still added up (the sum check can't see it).
   The method:
   - Dump where each note starts: `python3 ~/git/scripts/score-onsets.py draft.musicxml --staff 1`
     (onset:pitch/length in eighths from the bar start, worked out from `<divisions>`, `<duration>`, `<chord/>`,
     `<backup>`, `<forward>`; it also flags `!SUM` and `!TYPE` = `<type>`/`<dot>` that disagree with `<duration>`).
   - Write the same list **from the sheet crop (or the recording) first**, then compare **(onset, length, pitch)**
     triples bar by bar. A verifier's "matches" must mean this list matches, never "same pitches in the same order".
   - Compound meters (6/8, 9/8, 12/8): the beat is a dotted quarter = 3 eighths. Any onset on eighth 2 or 5, and any
     tie across eighth 3, is real syncopation: keep it as printed or sung. Three quarters in a 6/8 bar is a hemiola:
     only write it when the source shows it.
   - Odd meters (5/8, 7/8): the beaming on the page says the grouping (2+3 or 3+2, and it can change bar to bar);
     keep the printed beams (`<beam>`) and check the onsets fall on that grouping.
   - Look at the render too: each RH note must line up over the LH note struck at the same onset.
   - `score-onsets.py old.musicxml --diff new.musicxml` lists only the bars whose onsets, lengths or pitches differ.

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
- Rhythm from audio is where the user had to fix by hand (`m-4e35je7`). `sung-melody-to-musicxml.py` snaps each onset
  and each END to the nearest grid step in a simple-meter beat grid (4/4 only), and a silence longer than one step
  becomes a rest. So a singer's early release turns a held note into note + rest, an anticipation snaps onto the
  beat, and 6/8 eighths land on the wrong eighth. For a compound-meter song use `--triplets` (3 per beat) and
  write 6/8; then, for every bar, play the recording and check each onset with §2 step 7: a rest inside a sung
  phrase is suspicious (usually the note is held or tied over the beat).

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
fillbar, bartime, pickup, keysig, timesig, chord, clef, … (struct ops, clef included: the `structops.py` docstring).
Preview first with `POST …/editnotes/preview`.
`alt` (and Check bars' "use") keeps the bar's words **by time**, not by note order (`barcheck.carry_lyrics`; fixed
Nov 2026, so no need to rewrite the lyrics after adding a fill note any more). Each word, every verse with its syllabic
and extend, goes to the new note of the same staff/voice struck at its onset; else to the note sounding there (a tie
chain counts from its first note) if that line is free on it; else (a rest there, or that note has its own word) to
the next free note in the voice; else it is dropped. Tied-into notes and new onsets with no old word get no word.
Removing notes can therefore drop words: check the lyrics after an `alt` that thins a bar out.
- **Clef change**: `{op:'clef', bar, staff, clef:'treble'|'bass', until?}` (bars 0-based, staff 1 = top). Without `until`
  the clef holds from `bar` to the staff's next clef change; with `until` bars `bar…until` get it and the bar after gets
  its old clef back. E.g. left hand treble in bars 1–4, bass again from bar 5:
  `{"op":"clef","bar":0,"until":3,"staff":2,"clef":"treble"}`. Pitches stay. (Editor: Bar ▾ → Clef: Treble / Bass,
  over the picked bars of the picked staff.)
Each save = one Activities row with a 24 h Undo.

**Octave lines (8va / 8vb)**: a passage full of ledger lines (a high intro, a very low last bass note) gets a line
instead of new notes: `{op:'ottava', staff, from_bar, to_bar, shift}` (bars 0-based; shift `8` = 8va, `-8` = 8vb,
`15` / `-15`; `0` takes the line off those bars). In the editor: pick the bars' notes → Bar ▾ → "8va over bars …".
It writes `<octave-shift>` start / stop directions only. MusicXML `<pitch>` is the **sounding** pitch, so never
transpose the notes yourself: playback, singing, chords and OMR tools read the same notes, and OSMD draws them an
octave lower / higher under the dashed line.
Part of a bar: add `from_beat` (1-based beat of `from_bar`; the line starts at the staff's first note from there) and/or
`to_beat` (the line stops in `to_bar` before the notes from that beat on). E.g. bar 4 (1-based) up to, not including,
pickup 8ths on beat 4, joining an 8va over bars 1–3: `{"op":"ottava","staff":1,"from_bar":3,"to_bar":3,"to_beat":4,"shift":8}`.
`shift: 0` with beats takes the line off just there. Editor: pick 2+ notes (or a range) inside the bar → Bar ▾ →
"8va over bar 4, before beat 4"; a single note or the whole bar's notes still give whole bars.

## 9. Reference songs (ids)
| Song | Ids / notes |
|---|---|
| Home (NDP) | `m-b6xs990` |
| One Day More | score `m-7kynu6y` (from YouTube, A major); sheet `s-3hmg922` (4 pages, C major). Lyrics fitted with meowsic-sheet-lyrics.py |
| Our Singapore | `m-irrw2nj`: from MuseScore screenshots + the video's on-screen lyrics, Verified. Sung-melody versions A–D: `m-dpfen7t`, `m-r3wf2af`, `m-7rqhz65`, `m-9f43ynr` |
| You Are My Sunshine | `m-g3vp6s7` |
| Two Tigers (两只老虎) | `m-nrogmyq` (Mandarin singing) |
