# Meowsic — tasks

The one task list (it used to be ~/Documents/Meowsic/work/pm-tasks.md, which now only points here).
Kept by Claude (PM). Each task is done by a subagent and only marked done once it is tested and live.
Edit it in a worktree and push to v2 like any other change. The user's own requests arrive through in-app
Feedback (Developer → Feedback; ~/git/scripts/meowsic-feedback.py). Old phase 1–2 lists: docs/history/.


Updated: 2026-11-24

## In progress
| # | Task | Status |
|---|------|--------|
| 1 | Edit notes: rest length, Fill next rest, Remove rest, re-spelling (½+⅛ → ⅛+½), incomplete-bar highlight + "Change time for this bar" | ✅ Live (cc127a3) |
| 2 | Edit notes: Lyrics mode (Notes \| Lyrics), paste verse, verses, lyrics-text side panel from chord chart; remove Fit lyrics / Add lyrics from sheet menu | ✅ Live (a5f7384) |
| 3 | Edit notes: Bar ▾ (clear/add LH or RH bar, insert/delete bar), add/remove staff, vocal + piano (3 staves); remove "Make another version" | ✅ Live (584ef94) |
| 12 | Edit notes (Mac mouse + keys): drag a note (pitch in key / ⌥ semitone, sideways onto rests or swap; ghost + name; Esc), click a tie / slur → ✕ or ⌫ removes it, A–G note entry (fill key E→L, whole bar B→W), help text gone → Help page lists the keys | ✅ Pushed, deploying |
| 8 | Pro-editor top 8 (range select, copy/paste, repeat, octave, respell, bar options, repeats/endings, chord symbols + realize) | ✅ Live (54891c1) |
| 12 | Edit notes speed: server keeps each step (no replay of all edits), score stops read without OSMD's cursor repaint, keys queue while an edit is on its way; 70-bar score 1.2–2.2 s → ~0.4 s, 44-bar 0.4–0.7 s → ~0.14 s per edit (e2e editperf) | ✅ Pushed, deploying |
| 11 | Singing voice: default = zh_target (take C, low male) for English, Vietnamese and Mandarin; auto octave fits it; {voice, octave} still override | ✅ Pushed, deploying |
| 10 | Maintainability: project CLAUDE.md, scripts (test-all/smoke/deploy/dev-server), docs tidy, dead-code sweep, /api/health | ✅ Pushed, deploying |
| 4 | Add music → Chords: fit iPad Pro/iPhone, auto-tags + "+ Tag", never save empty chords, refill One Day More | ✅ Live (a6de135) |
| 4b | Singing: only sing lyric notes, wrong-note diagnosis, Approve/Reject toggles, Mandarin + voice choice, sing 两只老虎 (m-nrogmyq) | ✅ Live (takes page re-rendered; verdicts via ~/git/scripts/meowsic-verdicts.py) |
| 5 | Manage library on iPad: fix layout, no suggested starts, no hint text, Help button, search-only picker, no "Show hidden", ✓ icon, small Undo, declutter | ✅ Pushed 290e665, deploying |
| 6 | flows.mjs 1 failing check after the Manage library merge | ✅ Test-setup bug, fixed (0b3f98b) |
| 7 | Sidebar: Developer → Feedback; sections Manage (Library, Tags, App) + Developer (Stats, Activities, Feedback, Keyboard); no Beta | ✅ Live (e1ca1d3) |

## Next (queued)
| # | Task |
|---|------|
| 8 | Pro-editor features: range select, copy/cut/paste, repeat (R), octave ±, ♯/♭ respell, pickup + key/time change, repeat signs + 1st/2nd endings, chord symbol edit + realize to LH. Starts after 1–3 merge. |
| 9 | Runners-up: add interval (chord), playback follow-scroll, per-staff mute/solo |

## Waiting on you (tests on the device)
- iPad Play after the app has been in the background
- iPad mic
- Re-add Home Screen icon (white top band)
- Keyboard beta + Edit notes 🎹 on the Mac with the Yamaha (Calibrate first)
- Approve voices: https://192.168.1.50:5180/takes/

## Parked
- Record your own singing/talking voice (future beta, in Feedback)

## Done today (live)
- Edit notes: 32nd notes and rests (button, key 1, dotted, MIDI key B, A–G after a length key, paste; divisions raised safely) and every length shown as a note / rest glyph instead of 1/16-style text, also in Help and the Keyboard beta (pytest test_note32, e2e note32)
- Hands: L · Both · R beside Play (score view + Edit notes); 3+ staves = a toggle per staff (V R L); plays only the chosen staves, at once while playing; chords follow the left hand; remembered per device (e2e hands)
- Edit notes: drag the orange play line by its grip (touch + mouse), snaps to notes, across lines; hold at the page edge turns the page; dropping sets Play / ▶ From here start; dragging while playing seeks (e2e cuedrag)
- Play chords: score toolbar toggle plays the chord names above the bars as piano chords with the score (repeats, from here, tempo, stop; remembered per device)
- Add score: only running/queued jobs, compact, below the form; done/failed live in Activities
- Singing: Vietnamese lyrics keep every letter (Unicode, NFC; the A-Z reader cut most syllables) and each syllable is read as ARPAbet for SoulX-Singer (it has no Vietnamese phonemes)
- OMR: keep all lyrics; chords from sheet fixed (all 5 benchmark songs 100%); scores remade, old copies in Trash
- One Day More + Home NDP lyrics fitted; Home NDP lyric-loss bug (Revert) fixed + recovered
- Verified badge (icon) + library ✓; Tags moved; Key column; library auto-fill on add
- Complete info tab (+ glitch fixes); Manage library redesign (hub, review, Fix pages, crop, trash)
- Menus cleaned (Info / tools / Export / Trash); Request singing voice; Books read-only; complete-song bug
- Quick feedback button; mic fix; white top band fix; swipe-close only in view mode
- Chord strip on top; kids note-name stems; no tempo marks; score zoom per device
- Play button iOS fixes (stuck audio after background)
- Edit notes: both hands, beams/rest tidy, play from here, auto-cue, pages, ties/slurs kept, MIDI keyboard input
- Keyboard beta (Connect + Fix notes by playing, length keys, accurate hold-to-length)
- 22 voices × 4 songs on the takes page
- Left menu regrouped; Help moved to Settings
- Score ⋯: Edit notes removed (it is the toolbar ✎, on screen at every width); menus/editnotes tests updated
- Score tempo control (− BPM +, steps of 5, hold repeats, tap to type / Tap / ↺ score tempo; 30–240; per score on the entry's rate; live change without restart; Edit notes and Voice follow it, the voice time-stretched with pitch kept); tests/e2e/tempo.mjs
- Edit notes: Even out (= button / key Q): 2+ notes or rests one after the other in one voice and bar get one length each, same total (dotted 8th + 16th or Scotch snap → two 8ths; quarter + 8th → two dotted 8ths); pitches, ties, slurs, lyrics kept; triplet-only splits refused (pytest test_evenout, e2e evenout)
