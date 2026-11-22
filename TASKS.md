# Meowsic 2.0 — tasks

## Phase 1: UI with mock data (no backend)
- [x] Save old iPad app as git tag `v1`; build 2.0 on branch `v2`
- [x] App shell: cat theme, light/dark, sidebar (iPad/Mac), bottom tabs (iPhone)
- [x] Mock data: sheets, chord charts, scores, tags, collections, play history
- [x] Library: one list, kind filter (Sheet / Chords / Score), search, tag filter, sort, select mode (bulk tag, add to collection, bin)
- [x] Sheet viewer: pages, swipe/arrows, 1 or 2 pages, thumbnails, rename, tags, split / merge
- [x] Chord viewer: transpose, key list with original marked, ukulele diagrams pinned, font size
- [x] Score viewer: versions, notation, piano playback, tempo, loop bars, transpose, zoom, downloads
- [x] Annotations: pen, highlighter, eraser, undo, per page
- [x] Add sheets: pick photos / PDFs, review grouping, edit titles and tags
- [x] Add chords: search English / Vietnamese, preview, save
- [x] Add score: YouTube link or audio file, output + method, job progress
- [x] Tags page (print all, play all as a set list), Bin — collections removed, tags cover them
- [x] Print: collection or tag, A4 / Letter, facing pages with blanks, chord frame + cat
- [x] Stats: practice time, most played, recently played
- [x] Settings: Mac connection, offline, backup export / import, theme, reset mock data
- [x] Test every screen on Mac, iPad and iPhone sizes in light and dark

## Phase 2 — status (2026-11-23)
### Done
- [x] Server (FastAPI + SQLite): items, tags, plays, annotations, logs, jobs, settings, backup, sheet upload, chord search (Ultimate Guitar / Hợp Âm Chuẩn) — 36 tests
- [x] Folders / files named `<id> <title>` and `<id> <title> <n>.<ext>`; renamed with the title
- [x] Original date (photo taken / file / transcribed / fetched) + added date in Info
- [x] UI talks to the server; offline copy + outbox; real uploads, chord search, real scores view + play — 18 end-to-end checks
- [x] HTTPS certificate made (`~/Documents/Meowsic/certs`)
- [x] Service worker (offline library)
- [x] Edit score (sample scores): click a note, note box, note/rest, lengths with pictures (incl. dotted, 1/16), triplets, add, delete, undo, reset; bar time signature auto-changes
- [x] Library: table with per-view columns, one main tag, numbered pages, sort by heading, multi-select, multi-tag filter
- [x] Migration: 964 items (+4 Trash) from Meowsic 1, Emi Songbook, Emi Music Note, 2023 folder; verify OK
- [x] Real transcription + "Make another version" (music21) on the server; wired to the UI (3 s version, 12 s for a 20 s clip)
- [x] No sample data shown to the user; real connection status
- [x] Note editing on real (transcribed) scores (MusicXML, keeps the original for Reset)
- [x] Print real scores as A4 notation
- [x] Frontend clean-up (old list view removed, editor module)
- [x] HTTPS server on the real library (:5180), Meowsic launcher; old launchers moved to the Trash
- [x] Read-only check of the real library at Mac / iPad / iPhone sizes
### In progress
- [ ] Offline AI tagging: server side (agent, mlx-lm in ~/ai/models); UI done
- [ ] 58 iCloud-only sheets: background re-run every 20 min until Photos has the originals; then open Photos Settings for the user ("Optimize Mac Storage")
### Waiting on the user
- [ ] Trust Meowsic-CA.crt on the Mac; install it on iPad + iPhone

## Requirements (agreed, not built yet)
- ~~Icons per entry~~ — dropped by the user (2026-11-22): no song icons.
- [ ] **Auto-tag on request (offline AI):** select items or use ⋯ → Auto-tag…; the Mac reads title + page text (Apple Vision) and a local model suggests tags from the user's tag list; user ticks/unticks before saving. Bigger local LLM (≈3B via MLX) is the phase-2 upgrade if the small model is not good enough.
- [ ] **Make tags by collection (offline AI, on request):** "Make tags…" groups songs into new tags by movie, musical, singer or composer (e.g. Frozen, Les Misérables, Andrew Lloyd Webber). Works from the **song title** (the user keeps titles correct); printed page text only breaks ties for shared titles. Local LLM ≈8B via MLX (Qwen 2.5 7B / Llama 3.1 8B, ~5 GB in `~/ai/models`). Chord charts use the artist from their source. User reviews suggested tags and songs before saving.
- [ ] **Auto-tag new music:** every newly added sheet, score or chord chart runs auto-tag and make-tags-by-collection automatically; when tags are found, Meowsic asks the user to review them (tick / untick) before saving. Nothing is tagged without review.
- [x] **Edit score (UI):** ✎ in the score bar → click a bar → raise/lower, octave, length, rest, add, delete, chord name; undo; revert. A bar whose notes don't fit the meter gets its own time signature (5 beats in 4/4 → 5/4). Phase 2: same edits on the real MusicXML via music21.
- [ ] **Printed / Never printed:** Meowsic records every print; Auto-tag sets the tag Printed or Never printed. Works with the tag filter and Print all.

## Phase 2: backend (after UI approval)
- [ ] (see DESIGN.md once approved)
- [ ] Compare model candidates in docs/model-candidates.md on our own recordings and sheets
- [ ] AI models live in `~/ai/models`, never in git; `models.json` in the repo lists name, version, file, size, source URL, checksum
- [ ] `setup` script downloads any missing model into `~/ai/models` and verifies checksums
- [ ] Move transkun `2.0.pt` from Emi Music Note's .venv into `~/ai/models/transkun/`
- [ ] README section "AI models" explains the above
