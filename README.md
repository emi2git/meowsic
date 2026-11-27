# Meowsic 2.0

An offline-first music library for one family: sheet music, chord charts, books and scores in one app. It is a PWA
served by a small FastAPI + SQLite server on a Mac, used on the Mac, iPad and iPhone, and it keeps working offline with
whatever was opened before. All AI (sheet → score, recording → score, singing, tagging) runs on the Mac, offline.

It replaces three earlier apps (the Swift iPad Meowsic, now tag [`v1`](https://github.com/emi2git/meowsic/tree/v1), a songbook and a piano
transcriber), whose data was migrated once and kept read-only.

## What it does

- **Read and play**: sheets and books page by page, chord charts in any key with piano / ukulele shapes, scores drawn
  and played on a sampled piano, with zoom per device, kids note names, ink and printing.
- **Add music**: photos or PDFs, the Photos album, chord search, a recording or link turned into a score, or a sheet
  photo read into a score (beta).
- **Edit**: Edit notes (notes, rests, bars, staves, repeats, lyrics, MIDI keyboard), Simple piano versions, Check bars.
- **Manage the library**: fix pages and crops, split / join songs, books, complete song info, Trash. Every change has
  Undo for 24 hours.
- **Private by design**: the library (scans, lyrics, the database) lives only on the Mac and never enters git. No cloud,
  no API keys, no outside services.

## Why

A family's music is scattered across paper books, photos, chord sites and recordings. Meowsic puts it in one place that
works the same on every device in the house, opens instantly offline, and never uploads anything. One Mac is the
server, so there is nothing to host and nothing to pay for.

## Architecture

```
iPad / iPhone / Mac browser ── PWA (web/, ES modules, no build) ── service worker (shell + saved copies, offline)
          │  HTTPS :5180  (/api/* JSON, files, static web/)
          ▼
FastAPI server (server/meowsic, Python 3.12) ── SQLite (schema: server/schema.sql) + item folders on disk
          ├─ background jobs: transcribe · omr · lyrics · sing · version · tags
          │     omr   → omr/   (homr + Audiveris + Apple Vision)
          │     sing  → sing/  (SoulX-Singer on PyTorch MPS)
          │     tags  → local MLX model (Qwen2.5 7B 4-bit)
          └─ daily loops: DB backup, clean-up of expired undo history
```

- **Library model**: three kinds of item (sheet, chords, score); a book is a sheet with a flag. Score versions share a
  group id. Every earlier version of a file is kept in a `.history/` folder next to it.
- **Web app**: a hash-routed shell (sidebar on Mac / iPad, tabs on iPhone). `store.js` has three modes: *server*,
  *offline* (an outbox replays changes later) and *mock* (sample data for UI previews). Scores render with
  OpenSheetMusicDisplay.
- **Safe editing**: an open editor holds an edit session; any other write to that score gets `423 Locked`. Drafts are
  kept in the browser and on disk, and a save onto a score changed meanwhile is merged, never dropped.
- **Self-update**: the page compares its build stamp with the server and reloads once, but never while there is
  unsaved work on screen.

More in [docs/architecture.md](docs/architecture.md).

## Stack

| Layer | Tech |
|---|---|
| Client | Vanilla JS ES modules, no framework and no build step; service worker; OpenSheetMusicDisplay; Web Audio (sampled piano) |
| Server | Python 3.12, FastAPI, SQLite, background job threads |
| On-device AI | homr (ONNX) + Audiveris + Apple Vision for OMR; SoulX-Singer for singing; MLX (Qwen2.5) for tags — models listed in [models.json](models.json), never committed |
| Tests | pytest (~600 tests), Puppeteer e2e suites (~30 main + extras) |
| Devices | macOS (server + client), iPadOS, iOS as home-screen PWAs; HTTPS with a local CA |

## Run

```sh
server/start.sh                 # live server: HTTPS on :5180
scripts/dev-server              # test server on a free port > 5300 with temp data
scripts/dev-server --preview    # UI only, sample library in the browser: open /?preview=1
```

A fresh worktree symlinks the ignored `server/.venv`, `omr/.venv` and `tests/e2e/node_modules` from the main checkout.

## Test

```sh
scripts/test-smoke              # pytest + UI flow checks, ~2 min — before every push
scripts/test-all                # pytest + all main e2e suites in parallel, ~15 min
scripts/test-all menus editnotes   # just those suites
```

Each e2e suite starts its own server or preview on a free port with temp data. Hard guards stop any test from touching
the live port or the live data folder.

## Deploy

```sh
scripts/deploy --dry-run        # report only
scripts/deploy                  # fast-forward, back up the DB, restart only if server/ changed, health check
```

The deploy refuses on a dirty tree, a non-fast-forward, or while someone is using the app (an open editor, or recent
requests from a family device), and fails closed if it cannot tell. Shell changes bump the service-worker cache version
so iPad and iPhone pick them up.

## Engineering practices

- **Tests before ship**: smoke tests on every push, the full e2e run before a deploy; a change is done when it works end
  to end on the real devices.
- **Undo for everything**: every data change writes an Activities row with a 24 h Undo; files are copied to history
  first; deleting goes to the Trash. A daily clean-up finalises old activities and always keeps the newest DB backup.
- **Never lose an edit**: edit-session locks, on-disk drafts and merge-on-save.
- **One-command deploy** that knows when not to deploy.
- **Docs in the repo**: [CLAUDE.md](CLAUDE.md) (where things live, how to run / test / deploy, the rules),
  [docs/](docs/), [TASKS.md](TASKS.md), [WORKLOG.md](WORKLOG.md).

## License

[MIT](LICENSE). Bundled third-party pieces keep their own licenses (e.g. the Salamander piano samples, CC BY 3.0).
