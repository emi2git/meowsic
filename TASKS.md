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
