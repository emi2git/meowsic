# Meowsic — read this first

One app for the family's sheet music, chord charts, books and scores, used on Mac, iPad and iPhone.
- **web/**: a PWA in vanilla JS ES modules (no build step, no framework); `web/sw.js` caches the shell for offline.
- **server/meowsic/**: FastAPI + SQLite (Python 3.12, `server/.venv`). It serves `web/` and `/api/*`.
- **omr/**: sheet photo → score (homr + Audiveris + Apple Vision), with its own `omr/.venv`.
- **sing/**: "Make it sing (beta)", run in SoulX-Singer's venv at `~/ai/SoulX-Singer/.venv`. Default singer for every song (English, Vietnamese, Mandarin): `zh_target`, a low male voice (the user's pick, "take C"); the auto octave (`octave_for`) fits the melody to its range. `{voice, octave}` on the sing job still picks another.
- **migrate/**: one-off importers from the three old apps (done; the old data stays read-only).
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
- `lyricsedit.py`: lyrics by hand and Edit notes → Lyrics. `lyricsfit.py`: a sheet's words placed on a score.
- `simplepiano.py` + `smoothrhythm.py` + `arrange.py`: the Simple piano versions. `chordfind.py`: chords from notes.
- `organize.py`, `pages.py`, `booksplit.py`, `cleanup.py` + `cleanstate.py` + `trim.py`: Manage library (Fix pages, split / join, books, crops).
- `photoimport.py`: Add music → From Photos. `titles.py`: title from a page photo. `metafill.py` / `autofill.py` / `completeinfo.py`: song info.
- `barcheck.py`: Check bars on OMR scores. `voice.py` + `singscore.py`: singing. `feedback.py`: the Feedback queue. `ai.py`: offline tag AI.
- `backup.py`: JSON export / import and daily DB copies. `version.py`: git sha and shell version for health.

Web (`web/js/`): `app.js` is the shell and hash router, `store.js` the library store (server / offline / mock modes), `ui.js` the shared helpers, `audio.js` playback (`chordplay.js`: Play chords), `device.js` the device class, `easyscore.js` kids note names and no tempo marks, `notevalue.js` the note / rest glyphs (SVG) for length buttons and Help.
Views (`web/js/views/`):
- `library.js`: lists. `item.js`: the viewer frame. `sheet.js`, `chordsview.js`, `score.js`: the three viewers. `info.js`: the one edit popup.
- `scoreeditor.js` is the ✎ entry: real scores open `editnotes.js` (+ `lyricmode.js`, `lyricspanel.js`, `../midiedit.js`), and preview samples open the old one-line bar (`../scoremodel.js`). `checkbars.js`: Check bars.
- `simplepiano.js`, `print.js`, `annotate.js` (ink), `actions.js` (⋯ menus), `add.js` + `photoimport.js` (Add music).
- `manage.js` hub + `managekit.js`, `review.js`, `pageeditor.js`, `completeinfo.js`, `organize.js` (Tags, Trash).
- `activity.js` (Activities + Undo), `more.js` (Stats, Settings, Developer), `feedback.js`, `help.js`, `beta-keyboard.js`, `autotag.js`, `maketags.js`, `verified.js`.

## How to run
- **Live**: `server/start.sh`. It serves HTTPS on port 5180 with `~/Documents/Meowsic/certs`, at https://localhost:5180 and https://192.168.1.50:5180. Only the deploy procedure restarts it.
- **Test server**: `scripts/dev-server` picks a free port above 5300 and a temp data folder. With `--data DIR` it uses a COPY of the data, never the live folder.
- **UI preview**: `scripts/dev-server --preview` (= `python3 serve.py <port>`), then open `/?preview=1`. It needs no server: the sample library lives in the browser (store mode `mock`), and `/api/health` says `{ok: false, mock: true}`. Without `?preview` it is an empty offline app.
- **First setup in a new worktree**: symlink the ignored folders from the live checkout: `server/.venv`, `tests/e2e/node_modules`, `omr/.venv`.

## How to test
- `scripts/test-smoke` runs pytest (~600 tests, ~2 min) plus `flows.mjs` (~200 checks on the UI preview). Run it before every push.
- `scripts/test-all` runs pytest plus the main e2e suites (about 30, about 15 min). Each suite gets its own fresh server or preview on a free port with temp data; 4 run at a time, a failed suite gets one more go alone, and a summary comes at the end. `scripts/test-all menus editnotes` runs just those suites. `--list` shows each suite's kind; `--every` adds the extras.
- By hand: `cd server && .venv/bin/python -m pytest -q`. For e2e, `cd tests/e2e && BASE=http://127.0.0.1:<port>/ node <suite>.mjs` against a dev-server. Preview suites (flows, playback, scorezoom, topcast, touchseek, keycolumn, betakeyboard) take `PREVIEW=http://127.0.0.1:<port>` instead. Most suites also read `SHOTS=<dir>` for screenshots; `offline` and `storage` need `SERVER=<shell command>`, because they stop and start the server.
- Never point a test at :5180 or `~/Documents/Meowsic`. `reallib.mjs` is the one read-only look at the live library.
- Extras (`--every`, or by hand) need songs that a fresh server lacks: point BASE at `scripts/dev-server --data <copy of the library>`. They are aimusic, addchords, books, checkbars, easyscore, libversion, metadata, notenames, omr, printscore, real, realedit, resync, simplepiano, touchfill, touchlib, touchpages, touchview, and voice (slow: it loads the SoulX model). `shots.mjs` and `renderall.mjs` are manual tools.

## How to deploy
- Worktree agents commit, merge the latest origin/v2, retest, and `git push origin HEAD:v2`. They never touch the live folder (they can't write it anyway).
- One deploy agent runs `~/git/apps/meowsic/scripts/deploy`. The script:
  - refuses on a dirty tree or a non-fast-forward;
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

## Product rules
- Publisher content (scans, lyrics text, even the names) stays on this Mac. Nothing goes to external services or GitHub: `items/` and the DB never enter git. All AI runs offline.
- Never print lyric text in logs, reports, commits or chat: give counts only.
- No downloads (models, packages, media) without the user's OK.
- Test end-to-end before reporting done.
- In-app Feedback is the user's request queue: Developer → Feedback; CLI `~/git/scripts/meowsic-feedback.py`. Claude sets status and fix notes, and the history is kept.
- Tasks: `TASKS.md` in this repo (moved from `~/Documents/Meowsic/work/pm-tasks.md`, which now only points here).

## UI defaults (the user's choices — keep them)
- Light theme, chosen per device (`meowsic-theme`). The library opens on **Sheets**.
- Score zoom is per device: Mac / iPad 0.75, iPhone 0.62 (`score.js` `Z_BASE`).
- Buttons are single icons with an aria-label, not icon + text. No tags in library lists. No tempo marks drawn on scores (`noTempoXml`).

## Claude-only tools (server endpoints with no UI, kept on purpose)
- `GET/POST /api/items/{id}/lyrics`, `POST …/lyrics/sheet`, `…/lyrics/preview` (`lyricsedit.py` + `lyricsfit.py`, job kind `lyrics`). Driven by `~/git/scripts/meowsic-sheet-lyrics.py`.
- `POST /api/items/{id}/sing` (`~/git/scripts/meowsic-sing.py`) and `/api/feedback` (`meowsic-feedback.py`).
- Clean-up state from before Manage library (`cleanup.py`):
  - `GET /api/cleanup` (pages to trim, odd titles), `/cleanup/ok`, `/cleanup/later`, `/cleanup/sort`;
  - `/cleanup/notes` (notes for Claude) and `/cleanup/suggest` (suggested names: accept, dismiss or undo);
  - `GET /api/versions` (same-song groups) in `versions.py`.
  Their tables, Undo and tests stay.
- Job kind `version` (`runners.version_runner`): another arrangement of a score; the UI's "Make another version" is gone. Also `GET /api/ai/status` and `POST /api/backup/snapshot`.

## Gotchas
- **iOS audio**: set `navigator.audioSession.type = 'playback'` so sound plays with the Silent switch on. After the app was in the background the AudioContext can be stale or "interrupted": `audio.js` throws it away and makes a fresh one on the next Play. Test Play after backgrounding on a real iPad.
- **Ports**: 5180 is live. Other agents leave test servers running on many ports (5190–5450 seen), so never hard-code one: the scripts pick a free port above 5300 (`scripts/meowsic_dev.py`).
- **Symlinked venvs / node_modules** in worktrees: `.gitignore` lists `server/.venv`, `omr/.venv` and `tests/e2e/node_modules` without a trailing slash, so the symlinks can't be committed. Don't "fix" that to `dir/`.
- **Preview vs server**: preview (`?preview=1`) uses sample data in localStorage (`meowsic-mock-v6`) and never calls `/api` except health. A feature that needs the Mac must check the store mode, or the preview logs errors.
- **Worktree agents can't write the live folder** (`~/git/apps/meowsic`) and must not restart the live server. Ask the deploy agent.
- The server's tests make their own temp data (`server/tests/conftest.py`). An e2e suite that needs particular songs must make them itself, or say it needs a library copy.
- Health: `GET /api/health` → `{ok, data, sha, serverSha, shell}`. `sha` is the checkout now and `serverSha` the code the process started with.
