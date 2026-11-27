# Drafting the MusicXML

## Getting the pages
- `GET https://localhost:5180/api/items/{sheetId}` gives `pages`. Then `GET …/pages/{n}` (n = 1…pages) gives each page.
  Use the CA `~/Documents/Meowsic/certs/meowsic-ca.pem`, or an unverified context for this local self-signed cert.
- Save the pages to the scratchpad. Crop each system, then each bar, at about 3x with PIL, and read the crops, not the whole page.

## Tools
| Tool | Use |
|---|---|
| `~/Applications/Audiveris.app/Contents/MacOS/Audiveris -batch -export -output OUT p1.png p2.png` | First-guess OMR (classic). Never trust it bar by bar. |
| `omr/.venv/bin/python ~/git/scripts/omr-fix-bars.py in.mxl out.musicxml` | Pads / dots short bars and only *reports* long ones. It must print "all bars full". Its padding is a guess: re-read those bars on the crop. |
| homr | `omr/omr.py`, models in `~/ai/models/homr`; the library's "Make a score…" job is `POST /api/jobs {kind:'omr', fromItemId}`. A second OMR opinion. |
| `python3 ~/git/scripts/score-onsets.py X.musicxml [--staff N]` | Per bar / staff / voice `onset:pitch/len` in eighths from the bar start (`3:D5/2~` = D5 on the 4th eighth, a quarter, tied on). It flags `!SUM` (the voice doesn't fill the bar) and `!TYPE` (`<type>`/`<dot>` disagrees with `<duration>`). `--diff B.musicxml` lists only the bars that differ. It never prints words. |
| `/Applications/MuseScore 4.app/Contents/MacOS/mscore -o out.png X.musicxml` | Render for the side-by-side check. music21 is in `omr/.venv` (verovio isn't installed). |
| `scripts/sung-melody-to-musicxml.py` | Audio → lead line. **Its grid is 4/4 only** (see the pitfalls). Use it only to check a recording, never as the score. |

## Writing it
- Use one `<part>`. A piano score has `<staves>2</staves>` (staff 1 RH, staff 2 LH); a lead score has one treble staff.
- Put the composer in `<creator type="composer">`. The server adds "Transcribed by Meowsic" on save.
- `<divisions>`: pick one that fits the smallest value, including triplets (e.g. 12 for 16ths + 8th triplets).
- Per bar, write staff 1 voice 1, then `<backup>` the full bar length, then staff 2 voice 5 (the convention). Extra
  voices on a staff (voice 2 / 6) each get their own `<backup>`. Every voice fills the bar: use rests or `<forward>`,
  never a short voice.
- `<chord/>` notes have no duration of their own. A grace note has no `<duration>`.
- **Ties vs dots**: a note held across the middle of a 6/8 bar or across a beat is written as the sheet shows it
  (tied pair or dotted value). Keep `<tie>` + `<tied>` on both notes. A slur (different pitches) is `<slur>`, not a tie.
- **Anticipations across the bar line**: a note struck on the last eighth and tied into the next bar stays there. Don't
  "tidy" it onto the downbeat.
- **Pickup**: the first bar is `implicit="yes"`, holds only the printed pickup length, and is numbered 0. On an existing item, use the editnotes `pickup` op.
- **Repeats / D.S. / coda**: use `<barline><repeat>`, `<ending>`, `<segno/>`, `<coda/>`, and `<words>D.S. al Coda</words>` / `To Coda` with `<sound dalsegno=… tocoda=…>`, at the printed bars. Don't unroll them. A tie that runs back to the segno must stay a tie.
- **Every score has chord symbols over the whole piece** (SKILL.md §1a). They are `<harmony>` at the printed beat, in the
  `chordname.py` grammar (`Bbm7`, `C/E`, `Csus4`, `N.C.`). Write `sus4`, not a bare `sus`.
  - Printed on the sheet: copy them exactly.
  - Not printed: derive them from the harmony (LH + RH, or melody + accompaniment). One per harmonic change (usually a bar or
    half bar), slash chords only for a clear bass line. Check each against the notes on its span and list the doubtful ones.
- Lyrics: one syllable per note, with `syllabic` begin / middle / end and `<extend/>` on melismas. Verse 2 is `<lyric number="2">`. No words on rests or tied-into notes.
- No tempo marks (the app hides them; the bpm goes in the item field). **No `<pedal>`.**
- Ottava: `<octave-shift>`. `<pitch>` is always the **sounding** pitch.

## Meter rules
- 4/4, 3/4 and 2/4 are simple meters: the beat is a quarter.
- 6/8, 9/8 and 12/8 are compound: the beat is a dotted quarter = 3 eighths. An onset on eighth 2 or 5 (counting from
  0), or a tie across eighth 3, is real syncopation: keep it. Three quarters in a 6/8 bar (0-2-4) is a hemiola. Write it only
  if printed; the usual held note is 0-2~3-5.
- 5/8 and 7/8: the printed beaming gives the grouping (2+3 or 3+2, and it can change from bar to bar). Keep `<beam>`, and
  check that the onsets fall on that grouping.
- Mid-song key / time changes go in `<attributes>` at that bar.

## Self-check before handing over
1. `score-onsets.py draft.musicxml` shows no `!SUM` and no `!TYPE`.
2. Write your own onset list for 3–4 hard bars from the crops, and check it against the dump.
   **Every note→rest boundary** (a note followed straight by a rest in its voice, above all at a beat, bar or phrase end):
   look at that spot on the crop. If the sheet prints one longer note (or a tie) and no rest there, the draft is wrong.
   Note + rest where the sheet shows one longer note is a known recurring error (lessons.md, 2026-11-27).
3. Render the draft and look at each system beside its crop. Each RH note must sit over the LH note struck at the same onset.
4. Check the chords: every bar is covered (a symbol, or a carried one that still fits), and each fits its notes.
5. Return the draft path, the sheet used and why, a structure summary (bars, staves, keys, meters, repeats) the chord source (printed / derived), the doubtful chords and the unsure bars.
