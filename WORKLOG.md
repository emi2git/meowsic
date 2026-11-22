# Meowsic 2.0 — work log

Read this first when resuming. Newest entries at the bottom. Task list with status: TASKS.md.

## 2026-11-23 01:20 — user away ~8 h, asked me to finish everything
State:
- Server done (server/, 52 tests incl. real runners: transcription via Emi Music Note pipeline, versions via music21).
- UI wired to server (store.js server/offline/mock modes). e2e vs real server: /private/tmp/.../scratchpad/e2e/real.mjs (needs a server on :5190 with temp data).
- Migration agent re-running (dry run → real run → verify) into ~/Documents/Meowsic.
- UI preview tests: scratchpad/e2e/flows.mjs (needs `python3 serve.py` on :5180); last run 157/158 (1 flaky: "bulk tag added Jazz").

Plan (in order):
1. Test real job runners through the UI (make version, transcribe clip) — fix issues.
2. Remove sample data from what the user sees (mock only behind ?preview=1 for tests); real connection status in sidebar/Settings; drop "Mock data" card.
3. Note editing on real scores (edit MusicXML DOM; PUT /api/items/{id}/musicxml; reset → POST revert).
4. Print real scores (render MusicXML with OSMD into print pages).
5. Frontend refactor (dead list code, shared helpers).
6. After migration: check data, HTTPS on (certs in ~/Documents/Meowsic/certs), Meowsic.app launcher via ~/git/scripts/make-app-launchers.sh, LaunchAgent? (no — launcher starts server), certificate profile for iPad/iPhone.
7. Test on real library at Mac/iPad/iPhone sizes.
8. Retire launchers: ~/Applications/Emi Songbook.app, Emi Music Note.app, old Meowsic.app (keep repos + data).

## 01:35 — migration done, real runners verified
- Migration: 964 items (+4 Trash) in ~/Documents/Meowsic, 3.8 GB; verify OK; re-runs idempotent. 58 Meowsic-1 sheets wait for Photos "Download Originals" (user turned it on ~01:35) → re-run `migrate/migrate.py` later.
- Real jobs through the UI: version 3 s, 20 s transcription 12 s (scratchpad/e2e/jobs.mjs).
- USER REQUEST: after the Photos originals download finishes AND the migration re-run is done, open Photos → Settings (osascript: click menu item "Settings…" of menu "Photos") so the user can switch back to "Optimize Mac Storage". Tell the user.

## 01:55 — live on the real library
- Server running: `server/start.sh` (HTTPS :5180, ~/Documents/Meowsic, certs in ~/Documents/Meowsic/certs). Launcher ~/Applications/Meowsic.app (make-app-launchers.sh, https). Log ~/Library/Logs/Meowsic.log.
- Old launchers Emi Songbook.app, Emi Music Note.app, old native Meowsic.app moved to the Trash (repos + data kept); their servers stopped.
- Read-only check on real data at Mac/iPad/iPhone sizes: all screens OK, no console errors (scratchpad/e2e/reallib.mjs, run with NODE_EXTRA_CA_CERTS=~/Documents/Meowsic/certs/meowsic-ca.pem).
- UI preview tests now need `?preview=1` (samples only there). 160/160.
Next: real-score note editing → print real scores → frontend refactor → migration re-run when Photos originals are down → reopen Photos Settings for the user.

## 02:30 — note editing on real scores
- New web/js/scoremodel.js: TuneModel (samples) and XmlModel (real MusicXML, upper staff, per-voice timing, divisions normalized to twelfths, per-bar time signatures). Editor uses one model; real edits PUT /api/items/{id}/musicxml (original kept), Reset → POST …/revert.
- Typing a note on a rest turns it into that note.
- Tests: scratchpad/e2e/realedit.mjs 10/10 (server :5190 temp data); flows.mjs 160/160 — preview server now on :5181 (`python3 serve.py 5181`), :5180 is the real HTTPS app.
Next: print real scores, frontend refactor, migration re-run after Photos download, reopen Photos Settings.

## 02:45 — print real scores
- print.js lays scores out with OSMD pageFormat A4_P (one SVG per page; real or sample). Test scratchpad/e2e/printscore.mjs: Memory = 6 A4 pages, PDF OK.
Next: frontend refactor (dead list-view code in library.js, shared helpers), migration re-run when Photos originals are down, reopen Photos Settings.

## 03:00 — frontend clean-up
- Removed the dead list view from library.js (table everywhere), unused thumbHtml imports; score editor moved to views/scoreeditor.js; score.js 441 → 306 lines.
- Tests: flows 160/160, realedit 10/10.

## 03:15 — AI tagging (UI side)
- web/js/views/autotag.js: aiCall (sync or job), Auto-tag review dialog. Wired: selection bar "Auto-tag", item ⋯ "Auto-tag…", Generate tags → POST /api/ai/collections, new sheets / chord charts / finished jobs → quiet auto-tag → "Tags found — Review".
- Server side being built by an agent (mlx-lm, model in ~/ai/models).
- Background loop re-running Meowsic-1 import every 20 min until the Photos originals are down (still 158 pages at 03:00).

## — iCloud-only sheets done
- Fetched only the 157 needed originals with osxphotos --download-missing --use-photokit (2 min), re-ran import: +55 sheets (+3 Trash), 3 refilled; 1 page gone from Photos. Verify passed.

## 03:40 — Clean up (trim sheet photos, odd titles)
- server/meowsic/trim.py: finds screen junk (✕ / status bar / coloured app bars on top; player bar, page dots, home bar at the bottom) by ink bands + staff lines; only flags pages with a real app sign. Real library: ~25% of 7,845 pages.
- server/meowsic/cleanup.py: background scan cached in work/cleanup.json; POST /items/{id}/pages/{n}/trim (keeps the photo in items/<folder>/.history + crop params, shifts notes), /untrim (undo, {all} = original), /cleanup/ok (looks fine, undoable); odd titles by rules (64 found).
- web/js/views/cleanup.js: Utilities → Clean up. Keys: Enter/T trim+next, F fine, →/J ←/K, ↑↓ top line, Shift↑↓ bottom line, R rename, Z/⌘Z undo, O original, 1/2 tabs, ? help. "Trim all…" with confirm.
- Test scratchpad/e2e/cleanup.mjs 20/20 (:5190). Server tests 62 passed. Real server restarted (start.sh, log ~/Documents/Meowsic/work/server.log).
- server/app.py registration is uncommitted together with the AI agent's ai.py work.

## 04:20 — Clean up round 2
- trim.py: even top/bottom margins; page dots read from the original photo (count + lit dot); page numbers no longer mistaken for dots.
- cleanup.py: every sheet song with issues (trim / dots: mixed songs, missing or extra pages, same page twice, out of order / odd title), "song is good" (G), ?id= for one song; cache v2.
- cleanup.js rebuilt: songs list with status + filters (Needs a look / Good / All), page strip with dot numbers, free crop box (edges, corners, draw your own), keys ] [ for songs, ⌥←→ left/right edges, X suggested box, C whole page.
- Test e2e/cleanup.mjs 27/27; server tests 62 passed. Real server restarted, rescan running.

## 04:50 — Clean up round 3 + recovery
- Every page gets a preset crop box (junk cut, or even white space above/below); Enter = trim + next page → next song; U/Z undo puts the trim box back; incomplete songs flagged ("incomplete: 3 of 4 pages (missing page 3)"); songs with no pages flagged; Delete (Trash, undoable) and Split… (tick pages → new song) in Clean up.
- server/meowsic/pages.py: real split / join (files, trim history, notes move and renumber); the song ⋯ Split/Join now use it. tests/test_pages.py.
- Toasts no longer block clicks (only their button is clickable).
- Fixed: Clean up keys kept working after leaving the page.
- The AI agent wiped scratchpad/e2e; test scripts rebuilt from the session record and now live in tests/e2e (npm install there). flows 164/164, cleanup 37/37.
- AI tagging server work committed (agent report: groups decent for works/composers, some wrong members; autotag over-tags; full grouping 22 min).

## 06:30 — photo → score (beta)
- omr/omr.py: homr (notes) + Audiveris (second opinion, fallback) + Apple Vision (chord names, words) → one MusicXML; unsure bars marked "⚠ check"; report.json. Models in ~/ai/models/homr.
- Server job kind 'omr' (runners.omr_runner, schema CHECK + migration); sheet ⋯ "Make a score (beta)…"; job card shows "please check: p1 bar 15…".
- Hand-checked 4 pages bar by bar (table in omr/README.md): lead sheets' notes 100%, chords 12/12 and 15/16, words complete; piano page 8/10 bars (× noteheads) with both wrong bars flagged.
- tests/e2e/omr.mjs 7/7 (temp server), server tests 63.
