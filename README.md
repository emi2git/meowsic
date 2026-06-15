# Meowsic

An iPad app (iOS 18, SwiftUI + SwiftData) that turns the **sheet-music photos** in your
Photos library into an organized library of **songs** you can tag, search, view, and print.

Everything runs **100% on-device** — no accounts, no API keys, no network calls. Your photos
never leave the iPad.

## Features

- **Add Songs** — pick photos from your library; Meowsic reads them on-device and builds songs.
- **On-device detection** — Apple Vision text recognition reads each page's title and decides
  which pages are song first-pages; a corner-color check rejects non-sheet photos.
- **Automatic grouping** — consecutive pages are grouped into songs by capture time (a first
  page starts a new song; following pages are appended).
- **Review before creating** — when you split a new song off a page, a form pre-fills the
  detected title and tags so you can edit them before tapping **Create**.
- **Tags** — an editable vocabulary (genres, languages, sources, plus your own). Filter by tag,
  bulk-tag songs, or edit a song's tags directly. Auto-tags are matched from your tag list
  against the recognized page text.
- **Browse & view** — sortable, searchable, paginated song table; open a song to swipe through
  full-resolution pages (iCloud-downloaded on demand, with next-page prefetch).
- **Organize** — drag one song onto another to **merge**, **soft-delete** to a recycle bin
  (restore or delete for good, optionally removing the photos from Apple Photos).
- **Print** — export all songs of a tag to a US-Letter, facing-pages PDF (blanks inserted so a
  multi-page song's pages face each other).
- **Backup** — export/import the whole database as JSON.

## Requirements

- Xcode 16+ (iOS 18 SDK)
- An iPad (or simulator) running iOS 18+
- [XcodeGen](https://github.com/yonsei/XcodeGen) (`brew install xcodegen`) — the `.xcodeproj`
  is generated, not committed.

## Build & run

```sh
# 1. Generate the Xcode project from project.yml
xcodegen generate

# 2. Open and run
open Meowsic.xcodeproj
```

Set your signing team in `project.yml` (`DEVELOPMENT_TEAM`) or in Xcode's Signing &
Capabilities, then build to your iPad. The app needs **Photos** access (full access is
recommended so it can see all your photos).

## How it works

The pipeline is fully local:

1. You select photos (`PhotoPicker`).
2. For each photo (`AnalysisCoordinator.addSongs`, 8 concurrent):
   - **Corner-color prefilter** (`CornerColorPrefilter`) — a photo is treated as a sheet only
     if its four corners share roughly the same color (a uniform paper background). Others are
     ignored.
   - **Vision OCR** (`SheetTextRecognizer`) — reads the page; the largest heading near the top
     becomes the title and marks the page as a song start; tags are any vocabulary names that
     appear in the recognized text.
   - Photos already in the database are skipped.
3. Results are cached in `PhotoAnalysis`; songs are rebuilt by `GroupingEngine`.
4. A report summarizes how many songs were created, pages added, and photos ignored (with
   thumbnails and the reason for each).

## Architecture (`Sources/`)

| Folder | Role |
|--------|------|
| **App/** | Entry point, SwiftData container, Photos authorization gate. |
| **Models/** | SwiftData models (`PhotoAnalysis`, `SongRename`, `SongTagSet`, `PageGroup`, `PageBoundary`, `Tag`), the derived `Song`, the `AddSongsReport`, and backup DTOs. |
| **Services/** | On-device I/O: `PhotoLibraryService` (PhotoKit), `SheetTextRecognizer` (Vision OCR), `CornerColorPrefilter` (Core Image), `PDFExporter`. |
| **Domain/** | `AnalysisCoordinator` (Add Songs pipeline + state) and `GroupingEngine` (pure timestamp/merge grouping). |
| **Views/** | `SongListView`, `SongPagerView`, `NewSongView`, `PhotoPicker`, `AddSongsReportView`, `TagsView`, `TagEditorView`, `PrintView`, `SettingsView`, and helpers. |

## Data model (SwiftData)

- **PhotoAnalysis** — one per analyzed asset (the cache): asset id, creation date,
  `isMusicSheet`, `isSongStart`, `title`, `tags`.
- **SongRename** (`songKey` → custom title), **SongTagSet** (`songKey` → tag list),
  **PageGroup** (`assetID` → merged-song key), **PageBoundary** (`assetID` → manual start flag),
  **Tag** (vocabulary).
- **Song** is **derived**, not stored: its id is the first-page asset id; title/tags come from
  the first page, overridden by `SongRename`/`SongTagSet`; pages are ordered by timestamp and
  merged via `PageGroup`.

## Notes

- Songs reference photos by **device-specific asset ids**, so a JSON backup restores fully only
  on the same device/library; the tag vocabulary always restores.
- The only off-device traffic is iCloud Photos downloading *your own* originals when a selected
  photo isn't already on the device — that's Apple's photo sync, not analysis.
