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
