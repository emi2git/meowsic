# omr — sheet photo → score (beta), offline

`omr.py --out DIR --title "Song" page1.png [page2.png …]` → `DIR/score.musicxml` + `DIR/report.json`.
Used by the server job kind `omr` (sheet ⋯ → "Make a score (beta)…"), and with `--first-verse` (several lines of words under a staff: keep the top one) by the job kind `lyrics` (score ⋯ → "Add lyrics from a sheet…", server/meowsic/lyricsfit.py).

| Step | Tool |
|---|---|
| Before reading (server side) | junk trimmed off (`trim.py`), then coloured pen lines / highlighter taken off (`server/meowsic/inkclean.py`; coloured words and chord names stay). Work files in the job folder: `in<k>-raw.png`, `in<k>.png` (read), `in<k>-ink.png` (what was taken off) |
| Notes, rests, rhythm, ties, key, time | **homr** 0.7 (deep-learning OMR; models in `~/ai/models/homr`, linked into the venv) |
| Second opinion on every bar; lyrics/chord fallback | **Audiveris** (`~/Applications/Audiveris.app`) |
| Chord names | Apple Vision on the strip above each top staff + shape matching for lone letters (C, F, B♭) |
| Words | Apple Vision under each top staff (Vietnamese + English), syllables from hyphens; each line of words is a verse (`<lyric number="1">`, `2`, …). Audiveris fills gaps (its Tesseract reads eng, + vie when `vie.traineddata` is in its tessdata) |
| Bars marked "⚠ check" | the two readers disagree, or the bar didn't add up to the time signature |
| Full bars | every bar is then made to add up (pickup: rest in front; short: missing dot or a rest; long: shortened; empty: whole rest) — `report.json` `filled` lists each change |
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

Known gaps: x noteheads, two voices in one staff, mid-piece time-signature changes, verse lines read out of order,
chord names with small raised ♭/⁷, singer labels and tempo words (not read).
