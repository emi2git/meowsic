# omr — sheet photo → score (beta), offline

`omr.py --out DIR --title "Song" page1.png [page2.png …]` → `DIR/score.musicxml` + `DIR/report.json`.
Used by the server job kind `omr` (sheet ⋯ → "Make a score (beta)…"), and with `--first-verse` (several lines of words under a staff: keep the top one) by the job kind `lyrics` (Claude-only since the menu entry went: server/meowsic/lyricsfit.py, `scripts/sheet-lyrics.py`).

| Step | Tool |
|---|---|
| Before reading (server side) | junk trimmed off (`trim.py`), then coloured pen lines / highlighter taken off (`server/meowsic/inkclean.py`; coloured words and chord names stay). Work files in the job folder: `in<k>-raw.png`, `in<k>.png` (read), `in<k>-ink.png` (what was taken off) |
| Notes, rests, rhythm, ties, key, time | **homr** 0.7 (deep-learning OMR; models in `~/ai/models/homr`, linked into the venv). Printed triplets: every "3" beside a bracket / beam (shape-matched; staff lines off) makes the three notes under it a triplet, even when the bar adds up without one (`triplet_marks`, `apply_triplet`; `report.json` `triplets`) |
| Second opinion on every bar; lyrics/chord fallback | **Audiveris** (`~/Applications/Audiveris.app`) |
| Chord names | The strip above each top staff split into ink groups (`chord_tokens`; what the strip's edge cuts — stems, high notes, the words above — left out). Each group read 4 ways with Apple Vision (the strip; all groups tiled one per line; side by side far apart; the fast reader on each alone), every reading snapped to the chord grammar (`chord_snap`: '86' → B♭, 'Am?' → Am7, 'c' → C, volta '2.' dropped; words such as Coda / Moderately rejected) and voted; a raised ⁷/♭ one reading saw counts when the shapes are there. Names no reading made out exactly are read shape by shape against the page's own letters (`_PageFont`). Bar: the bar lines under the name; beat: the note / rest under it, else its place between the notes and the bar line (half-bar grid) — a chord over the middle of a held note splits it, tied (`chords_on_notes`). Audiveris' chord names only fill a name seen but not made out. `report.json` `chords`, `chordSplits`, `chordsAudiveris` |
| Words | Apple Vision under each top staff (vi + en), the strip enlarged by the staff size (2–4×, Lanczos, + a sharpened reading), each line read on its own band 3–4 times and voted syllable by syllable; syllables from hyphens (also dashes Vision missed, found in the ink); run-together words split ("Hômchia"); syllables placed on the notes in order (`place_syllables`); copyright / direction lines skipped. Every line is checked (`lyriccheck.py`: Vietnamese syllable shape + the Mac's vi / en spelling dictionaries, offline): syllables sung on separate notes judged as the word they make ("beau-ti-ful", hyphen read or not); every syllable read is written; under 80 % real words (or doubtful words) → the bars get "lyrics unsure — fix in the score editor (Lyrics)" as a hint (`check.json` `lyrics: {verse, bars}`). Audiveris' words only when Vision read none on the page |
| Bars marked "⚠ check" | only what needs a person (`bar_reasons`): a guess made to fill a bar, two readings that both add up but differ, lyrics unsure. Settled without asking (`report.json` `resolved`): both readers agree (e.g. after a printed triplet), one reader only and its bar adds up, the second reader only missed notes, a split into two voices that each fill the bar, a bar from the second reader with the same pitches |
| Full bars | every bar is then made to add up (pickup: kept short, written `<measure implicit="yes">` — no rests in front; short: missing dot or a rest; long: shortened; empty: whole rest) — `report.json` `filled` lists each change |
| Ties and slurs | homr's (a "slur" over two same notes in a row becomes a tie), Audiveris' (matched by onset + pitch), then the arcs on the page image (`page_arcs`: thin curved strokes once staff lines / stems / heads are off; pieces cut by a stem or bar line join up). Arc between two notes in a row with the same pitch = tie (plays as one note), else slur; a tie running to the next line / page is joined there. `report.json` `arcs`, `ties`, `slurs` |
| Bars to check | `check.json`: per bar the plain reason(s), the page + box (image pixels of `page<k>.png`) and the other reader's `<measure>` (made full). The job keeps it as `<folder> check.json` + `<folder> check p<k>.jpg`; `GET/POST /api/items/{id}/check` (server/meowsic/barcheck.py) |

Setup: `python3.12 -m venv .venv && .venv/bin/pip install homr onnxruntime music21 pyobjc-framework-Vision`,
`.venv/bin/homr --init`, then move the `.onnx` files to `~/ai/models/homr` and symlink them back.

## Checked by hand (Nov 2026, bar by bar against the photo)
| Page | Bars | Notes | Chord names | Words | Flags |
|---|---|---|---|---|---|
| Kiss The Girl p2 (lead sheet) | 21 | 21/21 right | 12/12 | all | bar 15 (false alarm) |
| Que Sera Sera p1 (lead sheet) | 32 | 32/32 right | 15/16 (C in bar 1 missed) | all | none |
| A Little Bit Of You (piano + voice) | 10 | 8/10 — spoken "×" notes read as B♭ | 12/12 | all ("loy al" no hyphen) | bars 8, 9 (the two wrong ones) |
| Mặt Trời Bé Con (lead sheet, 3 verses) | 36 | 35/36 — two-voice bar 36 | 11/18 (raised ♭/⁷ hard) | left out (several verses) | 5, 10, 16 (false), 36 (right) |
| Ru (2/4 with a 3/4 middle) | 83 | not checked bar by bar | — | — | 34–51: time change missed |

Chord names (Nov 2026, new reader, chord + beat right / printed): Beauty and the Beast 30/30 (was 24), Close To You 24/24 (15), Baby Mine 14/14 (10), Ánh trăng nói hộ lòng tôi 24/24 (17), You've Got a Friend 24/24 (24); not tuned on: A Dream Is a Wish 17/17, Away in a Manger 10/10, A Day at the Carnival (none printed) no false ones.

Known gaps: x noteheads, two voices in one staff, mid-piece time-signature changes, verse lines read out of order,
singer labels and tempo words (not read).
