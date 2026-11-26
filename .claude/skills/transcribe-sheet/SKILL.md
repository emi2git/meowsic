---
name: transcribe-sheet
description: Turn sheet music in the Meowsic library into a verified Meowsic score (MusicXML item). Use when the user says "transcribe <song> from the sheet", "make a score from this sheet", "transcribe all songs from <musical>", "make a piano / lead score of X", "turn this sheet into a score", or asks to fix or re-verify a score made from a sheet.
---

# Sheet → Meowsic score

The procedure the user signed off on (Nov 2026). Accuracy matters more than speed: single-pass scores were rejected.
Detail lives beside this file:
- `drafting.md`: MusicXML by hand, meters, tools.
- `saving.md`: API routes, edit-session checks, editnotes ops.
- `verify.md`: the 5 verifiers and the fixer.
- `lessons.md`: what went wrong before. Read it first.
- `workflow-template.js`: the Workflow script for one song or many.

The main session is the PM. Subagents do the drafting, verifying, saving and fixing (`workflow-template.js` runs them).

## 1. Policy (hard)
- This is private use for the owner's own practice (CLAUDE.md "Transcribing songs (private use)"). Transcribing a sheet the owner owns or photographed is in scope, so do it.
- Never share, upload or post a score, sheet, lyrics or audio, and never put them in git. Publisher content (scans, words, even titles) stays on this Mac.
- Never print lyric text in chat, logs, reports or commits. Give counts only, or at most one word to point at a spot.
- Credit the composer (`artist`) and the source (`source: 'From the sheet “<sheet title>”'`). The app writes "Transcribed by Meowsic".
- Temp files (page crops, drafts, downloads) go in the scratchpad. Delete them when done, because they hold the words. Nothing goes in `~/git/apps/meowsic`.
- A video the user links as a check source may be downloaded without asking. Delete it after use.

## 2. Choose the source
1. Find the sheet item(s): `GET /api/items?kind=sheet`, then match the title / album. Use **all** pages in order (`GET /api/items/{id}/pages/{n}`, n from 1).
2. If a piano sheet exists, make a **piano** score. If only lead sheets exist, make a **lead** score: melody + chords + words. **Never add our own accompaniment or left hand.**
3. Make one score per song. With several sheets of one kind, pick the clearest, cross-check unclear spots with the others, and say which you used.
4. Copy the sheet **exactly**: every staff, note, rest, tie, slur, tuplet, accidental, key / time change, clef, ottava, dynamic, text mark, chord symbol (at its printed beat), all lyric verses, and repeats / voltas / segno / D.S. / coda as printed (not unrolled).
5. **Leave out pedal marks** ("Ped." / *). The user doesn't want them.
6. If the sheet itself looks wrong (bars that don't add up, garbled notes, missing pages), say so and offer to use a recording or another sheet. Don't paper over it.

## 3. Draft (see `drafting.md`)
- Write the MusicXML by hand from zoomed crops (about 3x, one system or bar at a time). OMR (Audiveris / homr) is only a first guess.
- Every voice of every bar must sum to the time signature. Check `<divisions>`, `<backup>` / `<forward>` and the voice numbers.
- Get the meter right: 6/8 = 2 × 3 eighths, 5/8 follows the printed beaming, and pickups use `pickup`. Keep ties as ties, dots as dots, and anticipations across the bar line as printed.
- Before handing the draft on, run `score-onsets.py draft.musicxml`: no `!SUM` or `!TYPE` flags allowed.

## 4. Save (see `saving.md`)
- Save as a **new** item: `POST /api/items {kind:'score', title, artist, album, version, tags, key, source, musicxmlText}`.
- The version is `original` for a piano score (the API refuses `piano`) and `lead` for a lead score. Set `key` yourself.
- **Before every write to an existing item**, two checks must both pass:
  - `GET /api/items/{id}/editsession` → `active:false`;
  - `~/Documents/Meowsic/work/server.log` shows no `editnotes` / `preview` / `draft` / `lyrics` request on that id in the last 10 min.
  If either fails, stop and wait or ask.
- Fix existing scores only through logged routes: `POST …/editnotes` (with `sha`, preview first) or `POST …/lyrics`. Never `PUT …/musicxml`.
- Never restart, signal, kill or attach a debugger to the live server.

## 5. Verify (see `verify.md`)
- Run 5 independent read-only agents, one method each: **visual**, **OMR diff**, **text layer**, **markings / structure** and **blind re-read**.
- Every method must compare **(onset, duration, pitch) per note** with `~/git/scripts/score-onsets.py`. **A matching pitch sequence is NOT a match.**
- Then **one fixer** checks every finding against the sheet, applies the real ones, re-runs the onset / sum checks, renders the changed bars, and only then saves.

## 6. Report to the user
- For each song: the item id, piano or lead (and why), the bar count, the fixes applied (bar + what), and the findings rejected.
- List oddities kept **as printed** (a wrong-looking chord, a missing bar on the sheet) and the bars still unsure.
- Use counts for words, never the words themselves. Keep it short: a few lines per song.
- If the user says a score is wrong, ask for the bar number and check that bar against the sheet before changing anything. Verified scores have been right before (see `lessons.md`).
