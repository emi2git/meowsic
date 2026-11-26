# Meowsic — read this first

One app for the family's sheet music, chord charts, books and scores, used on Mac, iPad and iPhone.
- **web/**: a PWA in vanilla JS ES modules (no build step, no framework); `web/sw.js` caches the shell for offline.
- **server/meowsic/**: FastAPI + SQLite (Python 3.12, `server/.venv`). It serves `web/` and `/api/*`.
- **omr/**: sheet photo → score (homr + Audiveris + Apple Vision), with its own `omr/.venv`.
- **sing/**: "Make it sing (beta)", run in SoulX-Singer's venv at `~/ai/SoulX-Singer/.venv`. Default singer for every song (English, Vietnamese, Mandarin): `zh_target`, a low male voice (the user's pick, "take C"); the auto octave (`octave_for`) fits the melody to its range. `{voice, octave}` on the sing job still picks another.
- **migrate/**: one-off importers from the three old apps (done; the old data stays read-only).
- **Making scores for the user** (from a sheet, video or lyrics) → read `docs/score-playbook.md` first.
- **Sheet → score** ("transcribe <song> from the sheet", a whole musical): follow the skill `.claude/skills/transcribe-sheet/SKILL.md` (procedure, 5 verifiers, lessons log, workflow template).
- More detail: `docs/architecture.md`. History: `WORKLOG.md`, `docs/history/`. Task list: `TASKS.md`.

## Where things live
| What | Where |
|---|---|
| Code | `~/git/apps/meowsic`, branch **v2**, pushed to the emi2git GitHub repo `meowsic` (the old iPad app is tag `v1`) |
| Data | `~/Documents/Meowsic`: `meowsic.db`, `items/<id>/` (each with `.history/`), `history/` (bulk logs), `backups/`, `work/` (job folders, `server.log`, `cleanup.log`), `certs/` |
| Logs | `~/Documents/Meowsic/work/server.log` (the live server's stdout) and `~/Library/Logs/Meowsic.log` (Python logging) |
| AI models | `~/ai/models` only, never in git (`models.json` lists them) |
| Helper scripts | `~/git/scripts/meowsic-*.py` (feedback, sheet-lyrics, sing, add-ai-score); one-off fixes in `server/scripts/` |
| Launcher | `~/Applications/Meowsic.app` (starts `server/start.sh` if it is down, opens https://localhost:5180) |

## Module map
Server (`server/meowsic/`; each file's docstring explains it, and most list their endpoints):
- `app.py`: makes the app, mounts the routers and `web/`, `/api/health`, settings, background loops. `__main__.py`: CLI.
- `db.py`: paths (`Config`), connection, row↔JSON. `schema.sql` holds the tables (all IF NOT EXISTS).
- `items.py`: items, Trash, tags, plays, ink, files, sheet upload, MusicXML get/put/revert.
- `jobs.py` + `runners.py`: background jobs (transcribe, omr, lyrics, sing, version) and their runners.
- `undo.py` + `undolog.py`: Activities rows and their 24 h Undo. `dailycleanup.py`: the daily Final + clean-up.
- `staffmove.py`: the Edit notes API (`POST /api/items/{id}/editnotes`). It uses `barops`, `rangeops`, `structops`, `noteset`, `barnorm`, `easerests`, `divisions` (finer `<divisions>` when a 32nd needs them).
- `editsafe.py`: Edit notes never loses edits: edit sessions (the 423 lock), drafts on disk (`<data>/drafts/<item>/`), and the rebase that merges a Save onto a score changed meanwhile.
- `lyricsedit.py`: lyrics by hand and Edit notes → Lyrics. `lyricsfit.py`: a sheet's words placed on a score.
- `simplepiano.py` + `smoothrhythm.py` + `arrange.py`: the Simple piano versions. `chordfind.py`: chords from notes.
- `organize.py`, `pages.py`, `booksplit.py`, `cleanup.py` + `cleanstate.py` + `trim.py`: Manage library (Fix pages, split / join, books, crops).
- `photoimport.py`: Add sheet music = the Photos album (only new photos since the last check; added / skipped ones never again). `titles.py`: title from a page photo. `metafill.py` / `autofill.py` / `completeinfo.py`: song info.
- `barcheck.py`: Check bars on OMR scores. `voice.py` + `singscore.py`: singing. `feedback.py`: the Feedback queue. `ai.py`: offline tag AI.
- `backup.py`: JSON export / import and daily DB copies. `version.py`: git sha and shell version for health.

Web (`web/js/`): `app.js` is the shell and hash router, `store.js` the library store (server / offline / mock modes), `ui.js` the shared helpers, `audio.js` playback (sampled piano; the chords on a synthesised pad, `chordplay.js`), `hands.js` the part toggles, `device.js` the device class, `easyscore.js` kids note names (heads ≤ 1 staff space on a 1.5× staff; `kidsheads.mjs`) and no tempo marks, `notevalue.js` the note / rest glyphs (SVG) for length buttons and Help.
Views (`web/js/views/`):
- `library.js`: lists. `item.js`: the viewer frame. `sheet.js`, `chordsview.js`, `score.js`: the three viewers. `info.js`: the one edit popup.
- `scoreeditor.js` is the ✎ entry: real scores open `editnotes.js` (+ `lyricmode.js`, `lyricspanel.js`, `../midiedit.js`, `../editdraft.js`: drafts, session, the Save note), and preview samples open the old one-line bar (`../scoremodel.js`). `checkbars.js`: Check bars.
- `simplepiano.js`, `print.js`, `annotate.js` (ink), `actions.js` (⋯ menus), `add.js` + `photoimport.js` (Add music; with the Mac, Add sheet music is `photoimport.js` with Files / Camera below).
- `manage.js` hub + `managekit.js`, `review.js`, `pageeditor.js`, `completeinfo.js`, `organize.js` (Tags, Trash).
- `activity.js` (Activities + Undo), `more.js` (Stats, Settings, Developer), `feedback.js`, `help.js`, `beta-keyboard.js`, `autotag.js`, `maketags.js`, `verified.js`.

## How to run
- **Live**: `server/start.sh`. It serves HTTPS on port 5180 with `~/Documents/Meowsic/certs`, at https://localhost:5180 and https://192.168.1.50:5180. Only the deploy procedure restarts it.
- **Test server**: `scripts/dev-server` picks a free port above 5300 and a temp data folder. With `--data DIR` it uses a COPY of the data, never the live folder.
- **UI preview**: `scripts/dev-server --preview` (= `python3 serve.py <port>`), then open `/?preview=1`. It needs no server: the sample library lives in the browser (store mode `mock`), and `/api/health` says `{ok: false, mock: true}`. Without `?preview` it is an empty offline app.
- **First setup in a new worktree**: symlink the ignored folders from the live checkout: `server/.venv`, `tests/e2e/node_modules`, `omr/.venv`.

## Remote access (Tailscale)
- https://meowsic-mac.tailf62bf.ts.net — tailnet only (`tailscale serve` → `https+insecure://localhost:5180`, Let's Encrypt cert from Tailscale). **Funnel is OFF; never enable it.** Devices: meowsic-mac, iphone184, ipad163.
- Homebrew `tailscale`, rootless, userspace-networking. State, socket, log: `~/Library/Application Support/Tailscale-Meowsic/`. LaunchAgent `~/Library/LaunchAgents/com.emi.tailscaled.plist` (RunAtLoad, KeepAlive).
- CLI: `tailscale --socket="$HOME/Library/Application Support/Tailscale-Meowsic/tailscaled.sock" …`. Stop: `launchctl bootout gui/$(id -u)/com.emi.tailscaled`. Proxy off: `tailscale --socket=… serve --https=443 off`.
- No host/CORS change in the app. The ts.net origin is a separate PWA origin: its localStorage and per-device settings are separate from the LAN address.
- Tailnet admin needs MagicDNS + HTTPS Certificates + Serve on.

## How to test
- `scripts/test-smoke` runs pytest (~600 tests, ~2 min) plus `flows.mjs` (~200 checks on the UI preview). Run it before every push.
- `scripts/test-all` runs pytest plus the main e2e suites (about 30, about 15 min). Each suite gets its own fresh server or preview on a free port with temp data; 4 run at a time, a failed suite gets one more go alone, and a summary comes at the end. `scripts/test-all menus editnotes` runs just those suites. `--list` shows each suite's kind; `--every` adds the extras.
- By hand: `cd server && .venv/bin/python -m pytest -q`. For e2e, `cd tests/e2e && BASE=http://127.0.0.1:<port>/ node <suite>.mjs` against a dev-server. Preview suites (flows, libfit, macnoswipe, sheetfit, playback, scorezoom, topcast, touchseek, keycolumn, betakeyboard) take `PREVIEW=http://127.0.0.1:<port>` instead. Most suites also read `SHOTS=<dir>` for screenshots; `offline` and `storage` need `SERVER=<shell command>`, because they stop and start the server.
- Never point a test at :5180 or `~/Documents/Meowsic`. Hard guards enforce it: every e2e suite imports `tests/e2e/live-guard.mjs` first (refuses live env vars, exits 3 on any request to :5180); `scripts/meowsic_dev.py` refuses ports ≤ 5300 and the live data folder (or inside it); test-all stops restart-suite servers only via `kill_test_servers` (temp folders only, never the :5180 PID); pytest's default data folder is a temp one. `reallib.mjs` is the one read-only look at the live library: `MEOWSIC_LIVE_READONLY=1 node reallib.mjs` (GETs only).
- Test Chrome has no real sound: `live-guard.mjs` adds `--disable-audio-output` to every `puppeteer.launch`, a fake output whose audio clock always runs. With the real output the clock stands still when the lid is closed (or CoreAudio is stuck), Play gives up ("No sound yet") and the playback checks fail although the app is fine.
- Never signal, debug (lldb / py-spy attach) or kill the live server process; a failed `lldb -p` attach killed it on 2026-11-24. Restarts go through the deploy agent.
- Extras (`--every`, or by hand) need songs that a fresh server lacks: point BASE at `scripts/dev-server --data <copy of the library>`. They are aimusic, addchords, books, checkbars, easyscore, libversion, metadata, notenames, omr, printscore, real, realedit, resync, simplepiano, touchfill, touchlib, touchpages, touchview, and voice (slow: it loads the SoulX model). `shots.mjs` and `renderall.mjs` are manual tools.

## How to deploy
- Worktree agents commit, merge the latest origin/v2, retest, and `git push origin HEAD:v2`. They never touch the live folder (they can't write it anyway).
- One deploy agent runs `~/git/apps/meowsic/scripts/deploy`. The script:
  - refuses on a dirty tree or a non-fast-forward;
  - refuses while the app is in use, when web/ or server/ would change (`scripts/deploy_quiet.py`; `--dry-run` only reports it): an **edit session active on any item** (Edit notes open, from any client, never skippable), a request from a **user device** in the last **5 min** (background polls `GET /api/health`, `/api/jobs`, `/sw.js`, edit-session heartbeats aside), or an **API write** from a user device in the last **2 min**. User devices = every client except this Mac: loopback (`127.0.0.1`, `::1`: agents, scripts, curl, the deploy's own checks) and the Mac's own addresses never count, so agent work never holds a deploy back. Own addresses (`deploy_quiet.self_addresses`) = ifconfig's non-tailnet ones (the LAN IP) + the tailnet IPs of the node the Meowsic server listens on (`tailscale --socket=…Tailscale-Meowsic… ip`: meowsic-mac, 100.95.140.90) + the allowlist: env `MEOWSIC_SELF_IPS="a, b"` or `deploy_quiet.py --self a b`. The Mac also has Tailscale.app's own node (emis-macbook-air, 100.74.199.55): it is NOT this Mac (a browser on it uses the tailnet like a device), unless put in the allowlist. Tailnet devices show their own `100.x` address in `server.log` (proxy headers), so they count. Fail closed: if the check can't run (e.g. the DB can't be read; it opens `mode=ro`, else a normal connection with `PRAGMA query_only`) the deploy refuses with one line (exit 2). `deploy_quiet.py <data> --dry-run` only reports. The Mac's own browser on `localhost` counts as loopback: only its Edit notes sessions (and the app's own unsaved-work guard, below) protect it;
  - runs `merge --ff-only origin/v2`;
  - backs up the DB to `backups/pre-deploy-<time>.db`;
  - restarts the server only when `server/` changed since the code it is running (health `serverSha`) and no job is running;
  - checks the health: sha, shell and `/sw.js`.
  It is safe to run again. Use `--dry-run` first if unsure, or `--check` for the health check only.
  Any checkout's copy works: it always acts on `~/git/apps/meowsic`. For the very first deploy, run the copy in a worktree, because the live folder doesn't have the script yet.
- Never merge, edit or `git stash` inside `~/git/apps/meowsic`.
- **Bump `SHELL` in `web/sw.js` (meowsic-shell-vN)** on any shell change (index.html, css/, icons, vendor/). Otherwise iPad / iPhone keep the old files.

## Data rules
- Every bulk or data change is logged as an Activities row with an Undo that works for 24 h (`undolog.record_undo`). Files are copied into `items/<id>/.history/` (or `history/` for bulk logs) before they change.
- The daily clean-up (`dailycleanup.py`, inside the server) runs every 24 h. It makes activities older than 24 h Final, then deletes their `.history` copies, the bulk logs, old job folders and old DB backups. It always keeps the newest backup.
- Deleting moves items to the Trash (Manage → Trash: Restore, Delete for good, Empty). Only Trash deletes for good.
- Back up the DB before any restart or one-off script (`scripts/deploy` does it). One-off scripts go in `server/scripts/`; each needs an undo or a backup.
- Old apps' data is read-only: `Meowsic.store*` in the data folder, `~/Documents/Emi Songbook`, `~/Documents/Emi Music Note`.

- **Never write to an item someone is editing.** While Edit notes is open on a score it holds an edit session (`GET /api/items/{id}/editsession` → `active`); every other API write to that item (edit notes, lyrics, chords, check bars, simple piano, MusicXML, pages, PATCH, Trash, a lyrics job) gets **423 Locked**. Agents and scripts must check first, wait, and retry later — never work around it. The lock lets go 2 min after the editor's last heartbeat.
- Edit notes keeps drafts in the browser (localStorage / IndexedDB) and on disk (`<data>/drafts/`, pruned after 30 days); a Save on a score changed meanwhile merges, or keeps the full edit as "<title> (my edits)". Never bring back a dead-end 409.

## Product rules
- Publisher content (scans, lyrics text, even the names) stays on this Mac. Nothing goes to external services or GitHub: `items/` and the DB never enter git. All AI runs offline.
- Never print lyric text in logs, reports, commits or chat: give counts only.
- No downloads (models, packages, media) without the user's OK.
- Test end-to-end before reporting done.
- In-app Feedback is the user's request queue: Developer → Feedback; CLI `~/git/scripts/meowsic-feedback.py`. Claude sets status and fix notes, and the history is kept.
- Tasks: `TASKS.md` in this repo (moved from `~/Documents/Meowsic/work/pm-tasks.md`, which now only points here).

## Transcribing songs (private use)
- Meowsic is a private practice library for one household. It runs on the owner's Mac and can be reached only from the owner's own devices over the tailnet (Funnel is never on). Nothing in it is published, shared, sold or uploaded.
- Song transcriptions are made when the owner asks, for the owner's own practice: melody and chords from videos the owner links, sheets the owner photographs or owns, and lyrics the owner pastes or OKs looking up. On 2026-11-26 the owner decided this is in scope. Do the work when asked; don't refuse it as "stealing".
- Guardrails that keep it private (keep them strictly):
  - Never publish, upload, share or post scores, sheets, lyrics or audio outside the owner's devices.
  - Never print lyric text in chat, logs or reports.
  - Credit the composer / artist and the source URL on each score.
  - A sheet from the user's library (one they own or photographed) is the source: copy it exactly. A sheet only seen inside a video is for checking only: there the audio (singing or playing) is the primary source; say so in the report.
  - Downloaded videos are temp files: delete them after use.
  - Publisher content stays on this device.
- If the owner asks to share or distribute something, that's a different case: raise it with them first.

## UI defaults (the user's choices — keep them)
- Light theme, chosen per device (`meowsic-theme`). The library opens on **Sheets**.
- Every library list (All, Sheets, Scores, Chords, Books) is sorted by **Last modified** (`updatedAt`), newest first, by default: "Modified ▼" sits after the Title ⌄ (tap: reverse), "Last modified" is first in the ⌄ menu. A pick is per device (`meowsic-sort2`; the old `meowsic-sort` is dropped once). `updatedAt` changes on edits to content or info only: viewing, playing, zoom, transpose and speed (`items.py` / `store.js` `VIEW_ONLY`) don't bump it.
- **Playback defaults to piano; voice only when chosen.** Every score plays the sampled piano (all staves, a voice staff too), even with a sung audio from Make it sing; the toolbar Voice button turns the sung audio on, remembered per score on this device (`meowsic-voice2-<id>` = '1'). The old `meowsic-voice-<id>` keys (no key meant on) are dropped once by `score.js` (`meowsic-voice-lang` stays). `pianodefault.mjs` checks it.
- **Part toggles, no "Both".** Beside Play: one on / off toggle per part, several on at once: V (Vocal), R, L (one staff + chord names: M), C (Chords, only when the score has chord names). All staves on by default, C off unless it was last turned on; remembered per score (`meowsic-parts-<id>`). The last one on can't be turned off (aria-disabled). C plays a soft synth pad (no pad samples ship), close block chords C3–C5 with the root at the bottom, about 9 dB under the melody. `hands.mjs`, `chordplay.mjs` check it.
- Score zoom is per device: Mac / iPad 0.75, iPhone 0.62 (`score.js` `Z_BASE`).
- **Mac (desktop): no swipe gestures, buttons only; library pager buttons.** No mouse-drag page turns (sheet, photo import), Chrome's trackpad history swipe is off (`overscroll-behavior-x: none` on the root), the library never scrolls: rows fit the window with the ‹ n / N › pager on every list and search (shown even for one page; ← → / Page Up / Down too). iPad / iPhone keep their swipes. `macnoswipe.mjs` checks it.
- **Mac sheet: 1 or 2 pages by fit.** Two pages side by side while both fit at the current zoom in the window; zoomed in or a narrow window → one page (re-checked on zoom and resize; 100% = the spread fits, so it is two at ≤ 100%). ‹ › / page-half clicks / keys move 1 page in one-page mode, a spread in two-page mode; a switch keeps the page being read in view. "3 / 7" or "3–4 / 7" bottom right (`sheet.js`, `sheetfit.mjs`). iPad / iPhone: one page, unchanged.
- Buttons are single icons with an aria-label, not icon + text. No tags in library lists. No tempo marks drawn on scores (`noTempoXml`).

## Claude-only tools (server endpoints with no UI, kept on purpose)
- `GET/POST /api/items/{id}/lyrics`, `POST …/lyrics/sheet`, `…/lyrics/preview` (`lyricsedit.py` + `lyricsfit.py`, job kind `lyrics`). Driven by `~/git/scripts/meowsic-sheet-lyrics.py`.
- `POST /api/items/{id}/sing` (`~/git/scripts/meowsic-sing.py`) and `/api/feedback` (`meowsic-feedback.py`).
- Clean-up state from before Manage library (`cleanup.py`):
  - `GET /api/cleanup` (pages to trim, odd titles), `/cleanup/ok`, `/cleanup/later`, `/cleanup/sort`;
  - `/cleanup/notes` (notes for Claude) and `/cleanup/suggest` (suggested names: accept, dismiss or undo);
  - `GET /api/versions` (same-song groups) in `versions.py`.
  Their tables, Undo and tests stay.
- `POST /api/items/{id}/credit` (`{dryRun}`): a score's MusicXML credits brought up to date (`db.credit_xml` + `score_byline`), logged + undoable. Photo → score says "Transcribed by Meowsic" since Nov 2026 (it was "Read by Meowsic"; the old text is still matched). Bulk: `server/scripts/credit_transcribed.py`.
- `POST /api/items {fromItemId, musicxmlText, version, title?, note?}`: a hand-made MusicXML saved as a new version of that score (same song group, Activities + Undo; `items._version_of`). `server/scripts/arrange_piano.py`: voice + piano → piano solo.
- Job kind `version` (`runners.version_runner`): another arrangement of a score; the UI's "Make another version" is gone. Also `GET /api/ai/status` and `POST /api/backup/snapshot`.

## Gotchas
- **iOS audio**: set `navigator.audioSession.type = 'playback'` so sound plays with the Silent switch on. After the app was in the background the AudioContext can be stale or "interrupted": `audio.js` throws it away and makes a fresh one on the next Play. Test Play after backgrounding on a real iPad.
- **iPad top "white cast"** (reported 3 times): the cause was our own fixed full-width `.topedge` band (`--bg`, inset + 48px, shells v49–v57), which drew a white strip over the grey sidebar and an empty white gap above every header. No band now: `--sat` = `env(safe-area-inset-top)` (use `var(--sat)` for top padding), each column paints its own colour under the status bar, status bar style `black-translucent`. The iPadOS 26.5 Simulator home-screen app showed no system blur, at rest or while scrolling. Never add a full-width top band or extra top padding again. Check top-edge changes in the Simulator as a home-screen app (Share → Add to Home Screen on a dev server), not only Chromium. `topcast.mjs` checks it.
- **Ports**: 5180 is live. Other agents leave test servers running on many ports (5190–5450 seen), so never hard-code one: the scripts pick a free port above 5300 (`scripts/meowsic_dev.py`).
- **Symlinked venvs / node_modules** in worktrees: `.gitignore` lists `server/.venv`, `omr/.venv` and `tests/e2e/node_modules` without a trailing slash, so the symlinks can't be committed. Don't "fix" that to `dir/`.
- **Preview vs server**: preview (`?preview=1`) uses sample data in localStorage (`meowsic-mock-v6`) and never calls `/api` except health. A feature that needs the Mac must check the store mode, or the preview logs errors.
- **Worktree agents can't write the live folder** (`~/git/apps/meowsic`) and must not restart the live server. Ask the deploy agent.
- The server's tests make their own temp data (`server/tests/conftest.py`). An e2e suite that needs particular songs must make them itself, or say it needs a library copy.
- Health: `GET /api/health` → `{ok, data, sha, serverSha, shell}`. `sha` is the checkout now and `serverSha` the code the process started with.
- **Self-update** (`web/js/update.js`): the Mac stamps `index.html` with `<meta name="meowsic-build" content="<shell> <sha>">` (app.py). On start and back in view the page compares it with health; on a difference it updates the SW and reloads once (sessionStorage `meowsic-reloaded-for` stops loops). **Unsaved work holds the reload**: while `.notes-panel` or any element with `data-unsaved="1"` is in the page, only the "New version — Reload" pill shows, and the reload goes once they are closed / saved. Every editor marks its root with `ui.js` `unsaved(el, on)` (Simple piano, old edit bar, Check bars, ink bar, Crop, Add sheet music's arrangement / crop, Complete info picks, Feedback text, Quick feedback); a sheet (modal) marks itself when a field in it is typed into or its tags change. A new editing screen must do the same; `unsavedreload.mjs` checks it. `sw.js` activate deletes every cache but SHELL / DATA; navigations are network-first (4 s), then the saved shell. App and Help show the running sha + shell. `MEOWSIC_WEB` serves another web/ folder (e2e `swupdate`).
