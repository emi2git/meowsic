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
