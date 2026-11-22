# omr — sheet photo → score (beta), offline

`omr.py --out DIR --title "Song" page1.png [page2.png …]` → `DIR/score.musicxml` + `DIR/report.json`.
Used by the server job kind `omr` (sheet ⋯ → "Make a score (beta)…").

| Step | Tool |
|---|---|
| Notes, rests, rhythm, ties, key, time | **homr** 0.7 (deep-learning OMR; models in `~/ai/models/homr`, linked into the venv) |
| Second opinion on every bar; lyrics/chord fallback | **Audiveris** (`~/Applications/Audiveris.app`) |
| Chord names | Apple Vision on the strip above each top staff + shape matching for lone letters (C, F, B♭) |
| Words | Apple Vision under each top staff (Vietnamese + English), syllables from hyphens |
| Bars marked "⚠ check" | the two readers disagree, or the bar doesn't add up to the time signature |

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

Known gaps: x noteheads, two voices in one staff, mid-piece time-signature changes, several verses of words,
chord names with small raised ♭/⁷, singer labels and tempo words (not read).
