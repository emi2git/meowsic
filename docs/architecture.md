# Meowsic 2.0: architecture

This file keeps the parts of the old DESIGN.md (phase 2, Nov 2026) that are still true, plus how the pieces fit together.
Start with `CLAUDE.md` for the rules, the scripts and where things live.

## Pieces
```
iPad / iPhone / Mac browser ── PWA (web/, ES modules, no build) ── service worker web/sw.js (shell + saved copies)
          │  https://<mac>:5180  (/api/* JSON, files, and web/ as static files with Cache-Control: no-store)
          ▼
FastAPI server (server/meowsic, Python 3.12) ── SQLite ~/Documents/Meowsic/meowsic.db (schema: server/schema.sql)
          │                                    └─ files ~/Documents/Meowsic/items/<id>/
          ├─ jobs in threads (jobs.py, runners.py): transcribe · omr · lyrics · sing · version · tags
          │     transcribe → Emi Music Note's pipeline (its own venv; musicnote_driver.py)
          │     omr        → omr/omr.py (omr/.venv: homr + Audiveris + Apple Vision)
          │     sing       → sing/sing.py in ~/ai/SoulX-Singer/.venv
          │     tags       → local MLX model from ~/ai/models (ai.py)
          └─ background loops: daily DB copy (backup.py), daily clean-up (dailycleanup.py)
```

## Library model
- Kinds: **sheet** (page photos / PDF pages), **chords** (ChordPro text), **score** (MusicXML + MIDI). A **book** is a sheet
  with the `book` flag (a scanned songbook, read-only, folder `items/Books/<name>/`). Tables: `item` plus one per kind.
- Each score version is its own item. Versions share a `group_id`, and the version name is a field (`version`). There are no
  collections: tags do that job (the main tag shows in Info; lists never show tags).
- Item folders: `items/<id>/` with `<id> 1.jpg`, `<id>.musicxml`, … (`idfolders.py` moved the old `<id> <title>` folders).
  `.history/` inside each folder keeps every earlier version of a file (crops, edits, lyrics, checks).
- Original date (photo taken / file / transcribed / fetched) and the added date are both kept (`origin_at`, `created_at`).

## The web app
- `app.js` is the shell: a sidebar on Mac / iPad, tabs on iPhone, and the hash router. A view is `view(main, ctx)` and returns its clean-up.
- `store.js` has three modes:
  - **server**: every change goes to `/api`.
  - **offline**: the last copy is used and changes wait in an outbox. `conn.js` shows the banner.
  - **mock**: the UI preview's sample data (`?preview=1`, `mock.js`).
  Views only use `store`.
- `sw.js` caches the shell (`SHELL` cache, bumped by hand) and saves pages / scores / API answers as they are viewed, with a size cap
  (`saved.js`, Settings → Storage on this device). `/api/health` is never cached.
- `device.js` decides phone / tablet / desktop once (`data-device` on `<html>`). CSS and JS both read it.
- Scores are drawn with OpenSheetMusicDisplay (`web/vendor/osmd.min.js`) and played with sampled piano (`audio.js`, Salamander, CC BY 3.0).

## Changes, undo, clean-up
- `undolog.record_undo(c, type, step, …)` writes an Activities row with the step needed to roll it back. Steps made within a
  short window can share one row. `POST /api/activity/{id}/undo` (`undo.py`) rolls back. Undo stays open for 24 h (`GRACE_MS`).
- Before a file changes, the old one is copied into `.history/`. Bulk one-off scripts (`server/scripts/`) write a log to
  `<data>/history/*.json[l]` and register an undo.
- `dailycleanup.py`, every 24 h, makes old activities Final, then deletes what only their Undo needed (`.history` copies, bulk logs,
  ended job folders) and old DB backups, always keeping the newest backup. Activities → Clean up now shows the preview first.

## Rules carried over from DESIGN.md
- Runs on this Mac only (port 5180, home Wi-Fi, HTTPS with the local CA in `~/Documents/Meowsic/certs`; iPad / iPhone trust
  `Meowsic-CA.crt` once). The second MacBook (`ssh_server`) is not used.
- No cloud, no API keys. AI runs locally. The model list is in `models.json`, the candidates in `docs/model-candidates.md`.
- Purchased content (scans, lyrics) never goes to GitHub or any server: `items/` and the DB stay in `~/Documents/Meowsic`.
- Old data is read-only: `~/Documents/Meowsic/Meowsic.store*` (Meowsic 1), `~/Documents/Emi Songbook/library.json`, `~/Documents/Emi Music Note/`.

## Outdated parts of DESIGN.md (for the record)
- "Backups keep 30 daily copies": `backup.py` still trims to 30, but the daily clean-up now keeps only the newest copy (plus the
  pre-deploy / pre-script copies made in the last 24 h).
- "Log: ~/Library/Logs/Meowsic.log" is still written. The live server's stdout goes to `~/Documents/Meowsic/work/server.log`.
- "Transcription cache work/<id>/": job folders are `work/job-<id>/`, and the daily clean-up removes them 24 h after a job ends.
