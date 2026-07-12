# Meowsic — Requirements Log

| ID | Requirement | Status | Notes | Updated |
|---|---|---|---|---|
| R-001 | Remove all explicit animations | DONE | 10 sites in SongPagerView + ChordReaderView removed; offscreen scaffolding dropped; sim build green | 2026-06-19 |
| R-002 | Investigate non-responsiveness/slowness; report cause + fix plan | DONE (report) | findings below; no code changes yet — awaiting go-ahead | 2026-06-19 |
| R-003 | Refactor: clean up old code, unused files, restructure if needed | DONE (plan) | proposal below; awaiting go-ahead | 2026-06-19 |
| R-004 | Architect redesign: data model + app to fix derived-Song re-fetch problem | IN PROGRESS | 8-step plan; user chose option B (sequential approval). | 2026-06-19 |
| R-004.1 | Step 1: SongMeta table; kill Favorite/Deleted magic strings | DONE | 10 files; sim build green; needs device QA | 2026-06-19 |
| R-004-schema | LOCKED target schema: 5 tables (PhotoAnalysis, Song, Tag, SongTag, SongOpen). Tag.isSystem Bool. Song.isDeleted bool. SongOpen(songID, openedAt, closedAt) — one row per open session >=10s in SongPagerView OR ChordReaderView. manualBoundary dropped. Favorite feature dropped entirely. | LOCKED | Drives Steps 2-8 | 2026-06-19 |
| R-004.1b | Drop Favorite feature entirely (UI + data) | DONE | star button gone from list/pager/chord reader; sort-by-favorite gone; Tag vocab "Favorite"/"Star" auto-purged on launch; SongMeta.isFavorite dropped; CatHead assets deleted; sim build green | 2026-06-19 |
| R-004.23 | Step 2+3: Song @Model + SongListView @Query (per-row repaint) | DONE | Song is class; GroupingEngine returns SongDerivation; rebuildSongs upserts (diff); init populates Song rows; SongListView uses @Query with isDeleted predicate; sim build green; needs device QA | 2026-06-19 |
| R-004.4 | Step 4: Song↔Tag many-to-many; SongTagSet retired | DONE | Tag.songs + Song.tagLinks relationships; renameTag/deleteVocabTag O(1); per-song tag mutations bypass rebuildSongs; one-shot SongTagSet→tagLinks migration at init; upsertSongs sweeps stale SongTagSet rows; Tag.isSystem flag (Sheet/Chord); backup export now from tagLinks; sim build green; needs device QA | 2026-06-19 |
| R-004.5-8 | Steps 5-8 bundle (partial): SongOpen wired; SongRename folded into Song.title+titleIsCustom; SongMeta folded into Song.isDeleted; PhotoAnalysis.song + Song.pages relationship | DONE (partial) | SongOpen tracks viewer sessions >=10s in both pager and reader; renameSong / softDelete / restore write Song directly; sweep deletes SongRename + SongMeta rows; PhotoAnalysis.song relationship populated by upsertSongs; sim build green; needs device QA. DEFERRED: ChordSong inlining, setBoundary/merge/unmerge cutover to relationships, BackupData v2, VersionedSchema removal of legacy @Model classes. | 2026-06-19 |
