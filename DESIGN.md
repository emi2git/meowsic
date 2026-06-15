# Meowsic — Design

iPad app (iOS 18, SwiftUI + SwiftData) that finds **sheet-music photos** in your Photos
library, groups them into **songs**, and lets you tag, search, view, and print them.

## What it does
- **Scan** the photo library, detect which photos are sheet music, read each one's **title**,
  whether it's a **song's first page**, its **key** and **chords**, and auto-assign **tags**.
- **Group** consecutive sheet pages into songs by **photo timestamp** (a "first page" starts a
  new song; following pages are appended).
- Browse songs in a **sortable, searchable, paginated table**; open a song to swipe through its
  pages (full-res, iCloud-downloaded on demand with next-page prefetch).
- **Tag** songs (AI + manual), **filter** by tag, **merge** songs, **soft-delete** (recycle bin),
  and **print** all songs of a tag to a facing-pages PDF.

## Architecture (`Sources/`)
| Folder | Files | Role |
|--------|-------|------|
| **App/** | `MeowsicApp`, `ContentView` | Entry point, SwiftData container, Photos auth gate. Animations globally disabled. |
| **Models/** | `PhotoAnalysis`, `SongRename`, `SongTagSet`, `PageGroup`, `Tag`, `Song`, `BackupData` | SwiftData models + derived `Song` + backup DTO. |
| **Services/** | `PhotoLibraryService`, `ClaudeClient`, `CornerColorPrefilter`, `PDFExporter`, `KeychainStore` | External I/O (PhotoKit, Claude HTTP, on-device prefilter, PDF, Keychain). |
| **Domain/** | `AnalysisCoordinator`, `GroupingEngine` | Scan pipeline + state; pure timestamp/merge grouping. |
| **Views/** | `SongListView`, `SongPagerView`, `TagsView`, `TagEditorView`, `PrintView`, `SettingsView`, `AssetImageView`, `ActivityView`, `FlowLayout` | UI. |

## Data model (SwiftData)
- **PhotoAnalysis** (one per analyzed asset — the cache): `assetLocalIdentifier`, `creationDate`,
  `isMusicSheet`, `isSongStart`, `title`, `key`, `chords`, `tags` (AI auto-tags), `analyzedAt`.
- **SongRename** (`songKey` → custom title), **SongTagSet** (`songKey` → user tag list),
  **PageGroup** (`assetID` → merged-song `groupKey`), **Tag** (vocabulary).
- **Song** is **derived** (not stored): id = first-page asset id; title/tags/key/chords come from the
  first page, overridden by SongRename/SongTagSet; pages ordered by timestamp; merged via PageGroup.

## Scan pipeline (`AnalysisCoordinator.run`)
1. **Incremental**: `Scan New` analyzes photos newer than the most recently scanned (first scan = all).
2. **Concurrent** (8 at a time), per photo:
   - **Corner-color prefilter** on a cheap **on-device thumbnail** (no iCloud download) — uniform
     corners ⇒ likely a sheet on paper. Rejects obvious non-sheets for free.
   - Survivors download the full 640px image and go to **Claude (Sonnet 4.6)** in **real time**
     (structured-output JSON: is_sheet / is_start / title / key / chords / tags).
3. Results are cached in `PhotoAnalysis`; songs rebuilt via `GroupingEngine`.
4. Live status: photos done/%, sheets detected, last photo date, current step.

`Tag`s sent to Claude exclude the reserved **Deleted** tag. Tagging is prompted to be conservative
(language/region tags only when the title/lyrics are in that language; key blank unless confident).

## Tags
- Editable **vocabulary** (seeded with genre/language/source tags; "Genre" = predefined, "Custom" = the rest).
- **TagsView** (one screen): add, rename, delete, per-tag **song counts** (bubbles), tap to **filter**,
  and **Tag songs…** → select songs on the main list and apply.
- Per-song editing via the bubble **TagEditorView**.

## Other behaviors
- **Merge**: drag one song row onto another → one song, pages by timestamp (`PageGroup`).
- **Soft delete**: deleting a song adds the **Deleted** tag (hidden from the list unless filtering by
  Deleted). On a Deleted song you can **Restore** or hard-delete (metadata, or metadata + Photos).
- **Print** (`PrintView` + `PDFExporter`): pick a tag + order; US-Letter PDF read as a book — a blank
  is inserted before a **multi-page** song that would start on a right page so its pages face each
  other (1-page songs never get a blank). Preview shows pages, blanks, sheet count.
- **Settings**: Anthropic API key (Keychain), last-scan time, **Export/Import** database (JSON),
  **Wipe database** (clears song data + last-scan; keeps tag vocabulary).

## Notes / constraints
- Songs reference photos by **device-specific asset ids**, so a database backup restores fully only on
  the same device/library; the tag vocabulary always restores.
- Real-time analysis (Sonnet) is faster but ~no batch discount; closing the app stops a scan.
