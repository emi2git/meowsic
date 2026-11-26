# Verifying: 5 independent methods, then one fixer

The verifiers are read-only: they don't write to the library or the draft. Each one works in its own scratch folder and deletes it at the end.
They get the draft path, the sheet id and the transcriber's summary. They do **not** get each other's results.
The blind verifier doesn't get the draft until it has written its own reading.

## The rule every method follows
For every bar of every staff, compare **(onset, duration, pitch)** triples, never only the pitch order:
1. From the sheet crop, write the bar's list first: `onset:pitch/len` in eighths, as `score-onsets.py` prints it.
2. Dump the draft: `python3 ~/git/scripts/score-onsets.py draft.musicxml --staff N`.
3. Diff the two. A note an eighth early or late, a held note written as note + rest, or a 0-2-4 where the sheet has 0-2~3-5 is an
   error, even when every pitch and every bar sum is right.
"Matches" means the triple lists match. **A matching pitch sequence is NOT a match.**

## The five methods
| Key | Method |
|---|---|
| visual | Render the draft (MuseScore CLI) and crop every sheet system at about 3x. Compare every bar of every staff: pitches, accidentals, rhythm, rests, ties, beams / tuplets, clefs, dynamics, text. Then the onset triples. |
| omr | Run local OMR on the pages (Audiveris + `omr-fix-bars.py`, homr; no downloads). Align bar by bar (music21 / `score-onsets.py --diff`) and diff onset + duration + pitch per staff. Check each mismatch on the image, and report only confirmed draft errors (OMR is often the one that's wrong). |
| text | Check every lyric syllable on all verses (spelling, punctuation, hyphen, extender, which note), every chord symbol (name + exact beat), and every tempo / expression / text mark, in order against the sheet. Also check that each syllable's note has the right onset. Report the words by bar and position, never as text. |
| markings | Read the MusicXML directly, with no rendering: bar count, key / time signatures and changes, clefs, repeats / voltas / segno / To Coda / D.S. / coda placement, barlines, every accidental (carried / courtesy), ties vs slurs (and ties that survive the D.S. jump), tuplets, dynamics, articulations, ottavas, voices, **no `<pedal>`**, `!SUM` / `!TYPE` on every voice. A lead sheet must have no added staff. **Chords:** symbols cover the whole piece; each one (printed or derived) fits the notes on its span (root, quality, bass); printed ones match the sheet. |
| blind | Without opening the draft, write your own per-bar triple list for every staff from the sheet (pitch + octave, length, rests, ties; extra care on chords, the bass staff and ledger lines). Only then diff it with the draft, re-check the sheet at each difference, and report only confirmed errors. This catches octave slips (a lead-sheet musical number's coda, `m-i2menmk`). |

Each verifier returns `{method, barsChecked, findings:[{bar, staff, beat, sheet, score, confidence: sure|likely|unsure}]}`.

## The fixer (one agent)
1. Look at the sheet crop yourself for **every** finding and decide whether it is real. Several verifiers agreeing makes it likely, but check anyway.
   Count the rejected ones and give a one-line reason for each.
2. Apply the real ones: in the draft for a new score, or through logged editnotes / lyrics ops for an existing one (`saving.md`).
3. Re-verify the fixed bars: `score-onsets.py` (no `!SUM` / `!TYPE`), `score-onsets.py old --diff new` (only the intended bars
   changed), and a render of the changed bars beside the crops.
4. Save (the edit-session and server.log checks first), read it back, and delete the song's scratch folder.
5. Return the item id, version, the sheet used, activity ids, the structure, the fixes (bar + what), the number rejected, the bars still unsure, and the oddities kept as printed.

## When the user reports an error
Ask which bar (and staff) and check that bar's triples against the sheet. Change it only if the sheet disagrees.
If the score matches the sheet, say so plainly and show the bar. The sheet itself may be the problem: offer a recording or a better sheet.
