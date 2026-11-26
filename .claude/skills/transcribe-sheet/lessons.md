# Lessons log (what went wrong, how it was caught)

Add a dated line whenever something new goes wrong.

- **2026-11-20, short / long bars from OMR.** An Audiveris result had missing notes and bars that didn't add up. The user's
  hard rule: every bar fills its time signature. *Caught by:* the user. *Now:* `omr-fix-bars.py` + `!SUM` in `score-onsets.py`.
  OMR is only a first guess.
- **2026-11-24, a save during the user's edit.** An agent wrote chords to "Our Singapore" while the user had worked in Edit notes for
  30 min, and the user's saves all failed. A debugger attach then killed the live server. *Now:* the editsession check + server.log
  10-min check before every write, and hands off the live process.
- **2026-11-26, ĐĐNVQ rhythm shifts from the audio.** The lead line in 6/8 (`m-4e35je7`, 18 bars) came
  partly from the recording via `sung-melody-to-musicxml.py`, whose grid is 4/4 only. Notes landed an eighth early or late, and an
  anticipation was snapped onto the downbeat. Held notes became note + rest, or three quarters instead of 0-2~3-5. Every bar
  still summed right, and the pitch-order check passed. *Caught by:* the user fixing it by hand. *Now:* onset + duration + pitch
  triples in every verifier (`score-onsets.py`, playbook §2 step 7 and §4).
- **2026-11-26, a bad source sheet.** The first ĐĐNVQ sheet gave the same wrong score twice; the user: "that sheet is …
  itself". *Now:* if a sheet looks wrong, say so and offer a recording or a better sheet. Kept-as-printed oddities go in the report.
- **2026-11-26, Sunset Boulevard lead songs got an arranged left hand.** "The Perfect Year" and "As If We Never Said Goodbye"
  were lead sheets, but the draft added our own LH. The user wants lead only when no piano sheet exists. *Fixed by:* `delstaff`
  + version `lead`. *Now:* never add accompaniment, and the markings verifier checks that a lead score has no added staff.
- **2026-11-26, the Think Of Me coda an octave low** (`m-i2menmk`). A whole passage was one octave off while the contour
  was right, so pitch-class checks passed. *Caught by:* the verifiers (blind re-read with octaves). *Now:* the triples carry the
  octave, and the blind reader writes pitch + octave.
- **2026-11-26, When I Grow Up (`m-1dapqsx`) bar 51.** A verified Csus move was blocked by two app bugs: `fix_ties` dropped
  the tie that runs back over the D.S., and "Csus" was parsed as major. *Fixed in the app* (f45cdd8: D.S. ties kept,
  sus → sus4), then applied through editnotes (act-2dkuc1j). *Now:* write `sus4`, and check that ties survive D.S. / coda jumps.
  If a logged op can't do a fix, fix the app first rather than working around it.
- **2026-11-26, pedal marks.** The scores copied "Ped." marks (55 in one song), and the user doesn't want them. *Now:* never
  write `<pedal>`, and remove existing ones with `{op:'unpedal'}`.
- **2026-11-26, the 5-verifier standard.** Single-pass scores were rejected. *Now:* 5 independent methods + 1 fixer for every
  song (`workflow-template.js`).
- **2026-11-26, a user test where the score was in fact correct.** The user said a verified score was wrong; on checking, it
  matched the sheet. *Now:* trust results the 5 verifiers confirmed, but ask for the bar number and check that bar before
  changing anything. Then say plainly whether the score or the sheet is the issue.
- **2026-11-26, the version name.** A workflow asked to save scores as version `piano`, but scores only take `original` /
  `lead` / …. *Now:* piano = `original`.
