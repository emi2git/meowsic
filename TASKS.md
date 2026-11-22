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

## Phase 2: backend (after UI approval)
- [ ] (see DESIGN.md once approved)
- [ ] AI models live in `~/ai/models`, never in git; `models.json` in the repo lists name, version, file, size, source URL, checksum
- [ ] `setup` script downloads any missing model into `~/ai/models` and verifies checksums
- [ ] Move transkun `2.0.pt` from Emi Music Note's .venv into `~/ai/models/transkun/`
- [ ] README section "AI models" explains the above
