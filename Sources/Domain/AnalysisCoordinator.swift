import Foundation
import Photos
import SwiftData

/// Drives the on-device Add Songs pipeline (Vision OCR → cache) and exposes the
/// grouped songs.
@MainActor
@Observable
final class AnalysisCoordinator {
    var songs: [Song] = []
    var isScanning = false
    var isAutoScanning = false
    var progressDone = 0
    var progressTotal = 0
    var lastError: String?
    var lastReport: AddSongsReport?   // result of the most recent Add Songs run (drives the report sheet)
    var lastScanDate: Date?        // newest sheet photo currently in the song list (derived)
    var scanStatus: String?
    var sheetsFound = 0
    var lastItemDate: Date?
    var tagNames: [String] = []
    var tagCategories: [String: String] = [:]   // tag name → "genre" | "custom"
    /// Set by `ContentView` to a closure that pushes the current state to cloud.
    /// Fired after every chord-song mutation so chord additions survive an app
    /// kill (e.g. a reinstall via `devicectl`) before the next background push.
    var onMutate: (() -> Void)?
    /// Non-nil → ContentView shows the "Loading from cloud" overlay with this label.
    /// Set by `importData` as it walks the snapshot in phases.
    var importStatus: String?
    /// 0.0...1.0 progress for the overlay's bar; nil → indeterminate spinner.
    var importProgress: Double?

    static let deletedTag = "Deleted"
    static let sheetTag = "Sheet"
    static let chordTag = "Chord"
    /// Tags that the user can't add/remove or delete from vocabulary. Sheet/Chord
    /// are derived from `Song.kind`; Deleted is toggled by softDelete/restore.
    static let specialTags: Set<String> = [deletedTag, sheetTag, chordTag]
    private static let maxConcurrent = 8

    /// Initial vocabulary on first launch — fully editable in-app afterwards.
    static let predefinedTags = [
        "Pop", "Rock", "Ballad", "Jazz", "Classical", "Folk", "Country", "R&B/Soul", "Instrumental",
        "Vietnamese", "English", "K-pop", "J-pop", "Chinese", "Latin",
        "Disney", "Musical", "Movie/Soundtrack", "Anime", "Video Game",
        "Christmas/Holiday", "Religious/Worship", "Children's", "Wedding",
    ]
    static let predefinedTagSet = Set(predefinedTags)

    private let context: ModelContext
    private let library: PhotoLibraryService
    private let recognizer = SheetTextRecognizer()

    init(context: ModelContext, library: PhotoLibraryService) {
        self.context = context
        self.library = library
        seedTagsIfNeeded()
        migrateTagCategoriesIfNeeded()
        migrateDeletedToMetaIfNeeded()
        purgeFavoriteVocabIfNeeded()
        ensureSystemTagsExist()
        refreshTagNames()
        // Defer everything so init returns immediately and the UI appears
        // against the already-persisted Song @Model rows via @Query. We only
        // run the full re-derive when there's a real reason — never on every
        // launch.
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.startupSyncIfNeeded()
        }
    }

    /// Called once after init returns. Only does work when persisted state
    /// is suspected stale (first launch on the @Model build, or a previously
    /// failed migration). Subsequent launches do zero work here — Song rows
    /// already reflect the world and explicit user mutations call rebuildSongs
    /// directly when they change source data.
    private func startupSyncIfNeeded() {
        let songCount = (try? context.fetchCount(FetchDescriptor<Song>())) ?? 0
        let analysisCount = (try? context.fetchCount(FetchDescriptor<PhotoAnalysis>())) ?? 0
        let chordCount = (try? context.fetchCount(FetchDescriptor<ChordSong>())) ?? 0
        // First launch with @Model Song, or some other reason the cache is
        // out of sync with source rows → populate it.
        if songCount == 0 && (analysisCount > 0 || chordCount > 0) {
            rebuildSongs()
        }
        migrateSongTagSetToTagLinksIfNeeded()
        sweepLegacySongTables()
    }

    /// Drop SongRename rows whose data is now reflected on the Song row
    /// (titleIsCustom == true) and SongMeta rows since isHidden now lives on
    /// Song directly. Idempotent; safe to run every launch. Pure cleanup —
    /// the model classes stay registered until a VersionedSchema cleanup PR.
    private func sweepLegacySongTables() {
        let songByID = Dictionary(uniqueKeysWithValues: all(Song.self).map { ($0.id, $0) })
        for r in all(SongRename.self) {
            if let song = songByID[r.songKey] {
                // Promote the rename onto Song if it hasn't already been folded in.
                if !song.titleIsCustom {
                    if song.title != r.customTitle { song.title = r.customTitle }
                    song.titleIsCustom = true
                }
                context.delete(r)
            }
        }
        for m in all(SongMeta.self) {
            // isHidden has already been mirrored onto Song.isHidden by rebuildSongs.
            // Safe to drop the row.
            context.delete(m)
        }
        try? context.save()
    }

    // MARK: - Add Songs

    /// Turn an explicit set of user-picked photos into songs, regardless of
    /// capture date. Fully on-device — no network, no API key. A photo is ignored
    /// when it is already in the database or when it can't be loaded. Everything
    /// else becomes a page; titles/tags come from on-device OCR. Grouping reuses
    /// the capture-time + heading heuristic. Publishes `lastReport`.
    func addSongs(from assets: [PHAsset]) async {
        guard !isScanning else { return }
        isScanning = true
        lastError = nil
        sheetsFound = 0
        lastItemDate = nil
        progressDone = 0
        progressTotal = assets.count
        scanStatus = "Reading sheet music…"
        defer { isScanning = false; scanStatus = nil }

        var report = AddSongsReport(selected: assets.count)
        let songIDsBefore = Set(songs.map(\.id))

        // Skip anything already in the database up front.
        let existing = Set(all(PhotoAnalysis.self).map(\.assetLocalIdentifier))
        let fresh = assets.filter { !existing.contains($0.localIdentifier) }
        for asset in assets where existing.contains(asset.localIdentifier) {
            report.ignored.append(.init(assetID: asset.localIdentifier, reason: .alreadyAdded))
            progressDone += 1
        }

        let vocabulary = tagNames.filter { !Self.specialTags.contains($0) }   // never auto-tag Star/Deleted
        let customWords = knownWords()   // bias OCR toward titles/tags already in the library
        await withTaskGroup(of: AddOutcome.self) { group in
            var index = 0
            func addNext() {
                guard index < fresh.count else { return }
                let asset = fresh[index]; index += 1
                group.addTask { await self.analyzeForAdd(asset, vocabulary: vocabulary, customWords: customWords) }
            }
            for _ in 0 ..< min(Self.maxConcurrent, fresh.count) { addNext() }

            for await outcome in group {
                if Task.isCancelled { break }
                switch outcome {
                case let .added(id, date, r):
                    store(id: id, date: date, sheet: true, start: r.isSongStart,
                          title: r.title, tags: r.tags)
                    sheetsFound += 1
                    lastItemDate = date
                case let .ignored(id, reason):
                    report.ignored.append(.init(assetID: id, reason: reason))
                }
                progressDone += 1
                addNext()
            }
            group.cancelAll()
        }

        rebuildSongs()
        report.sheetsAdded = sheetsFound
        report.songsCreated = songs.filter { !songIDsBefore.contains($0.id) }.count
        report.stopped = Task.isCancelled
        lastReport = report
    }

    // MARK: - Auto Scan

    /// Walk the photo library newest-first, collecting every photo until reaching
    /// one that's already in the library — i.e. all photos taken since the last
    /// Add. Returns the run of candidates so the caller can confirm the count
    /// before feeding them to `addSongs`.
    func autoScanCandidates() async -> [PHAsset] {
        guard !isScanning, !isAutoScanning else { return [] }
        isAutoScanning = true
        scanStatus = "Looking for new photos…"
        defer { isAutoScanning = false; scanStatus = nil }

        let existing = Set(all(PhotoAnalysis.self).map(\.assetLocalIdentifier))
        var candidates: [PHAsset] = []
        for asset in library.allImagesNewestFirst() {
            if Task.isCancelled { break }
            if existing.contains(asset.localIdentifier) { break }   // reached a photo already added
            candidates.append(asset)
            scanStatus = "Found \(candidates.count) new photo\(candidates.count == 1 ? "" : "s")…"
        }
        return candidates
    }

    private enum AddOutcome: Sendable {
        case added(String, Date, SheetTextRecognizer.Result)
        case ignored(String, AddSongsReport.IgnoreReason)
    }

    /// On-device only: Vision OCR for title/tags. A missing image yields
    /// `ignored`; every loadable photo becomes a page.
    private func analyzeForAdd(_ asset: PHAsset, vocabulary: [String], customWords: [String]) async -> AddOutcome {
        let id = asset.localIdentifier
        let date = asset.creationDate ?? .distantPast
        guard let image = await library.analysisImage(for: asset) else { return .ignored(id, .noImage) }
        let result = await recognizer.analyze(image, vocabulary: vocabulary, customWords: customWords)
        return .added(id, date, result)
    }

    /// Titles and tag names already in the library, fed to Vision as custom words
    /// so repeated songs and known vocabulary read more accurately.
    private func knownWords() -> [String] {
        let titles = songs.map(\.title).filter { !$0.isEmpty && $0 != "Untitled" }
        return Array(Set(titles + tagNames))
    }

    private func store(id: String, date: Date, sheet: Bool, start: Bool, title: String?, tags: [String] = []) {
        context.insert(PhotoAnalysis(assetLocalIdentifier: id, creationDate: date,
                                     isMusicSheet: sheet, isSongStart: start,
                                     title: title, tags: tags, analyzedAt: .now))
        try? context.save()
    }

    // MARK: - Songs

    func rebuildSongs() {
        // Title overrides: prefer Song.title where titleIsCustom (post-Step5
        // direct mutation), fall back to legacy SongRename for any not-yet-migrated.
        var renameMap = Dictionary(uniqueKeysWithValues:
            all(Song.self).filter { $0.titleIsCustom }.map { ($0.id, $0.title) })
        for r in all(SongRename.self) where renameMap[r.songKey] == nil {
            renameMap[r.songKey] = r.customTitle
        }
        // Tag overrides come from the authoritative Song.tagLinks relationship.
        // Falls back to legacy SongTagSet only for songs not yet promoted to @Model
        // (zero rows after the migration runs at init — kept for safety).
        var tagMap = Dictionary(all(Song.self).map { ($0.id, $0.tagLinks.map(\.name)) },
                                uniquingKeysWith: { a, _ in a })
        for set in all(SongTagSet.self) where tagMap[set.songKey] == nil {
            tagMap[set.songKey] = set.tags
        }
        let groupMap = Dictionary(all(PageGroup.self).map { ($0.assetID, $0.groupKey) }, uniquingKeysWith: { a, _ in a })
        let boundaryMap = Dictionary(all(PageBoundary.self).map { ($0.assetID, $0.isStart) }, uniquingKeysWith: { a, _ in a })
        // Deleted state: prefer Song.isHidden (post-cutover direct mutation),
        // fall back to legacy SongMeta for not-yet-migrated rows.
        var deletedKeys = Set(all(Song.self).filter { $0.isHidden }.map(\.id))
        for m in all(SongMeta.self) where m.isHidden { deletedKeys.insert(m.songKey) }
        let analyses = all(PhotoAnalysis.self)
        let chordSongs = all(ChordSong.self)
        let derived = GroupingEngine.group(analyses: analyses, chordSongs: chordSongs,
                                           renames: renameMap, tagOverrides: tagMap,
                                           pageGroups: groupMap, boundaries: boundaryMap,
                                           deletedKeys: deletedKeys,
                                           sheetTag: Self.sheetTag, chordTag: Self.chordTag,
                                           deletedTag: Self.deletedTag)
        upsertSongs(from: derived)
        songs = all(Song.self).sorted { $0.firstPageDate > $1.firstPageDate }
        // "Last scan" = the newest sheet photo that made it into the song list.
        lastScanDate = analyses.filter { $0.isMusicSheet }.map(\.creationDate).max()
    }

    /// Diff & apply: only writes to Song rows that actually changed, so SwiftUI
    /// per-row observation (@Query + ForEach) repaints only the affected rows.
    /// Inserts new derivations, deletes Song rows that no longer derive, and
    /// updates each existing row only on per-field difference. Tag changes
    /// resolve names → Tag entities and write Song.tagLinks (authoritative)
    /// plus mirror to Song.tags (for back-compat readers).
    private func upsertSongs(from derived: [SongDerivation]) {
        upsertSongsCore(from: derived, onChunk: nil)
    }

    /// Async variant that yields between chunks so SwiftUI can repaint and
    /// the cloud-import overlay's progress bar can advance through the
    /// long rebuild phase. Used only by `importData`.
    func upsertSongsAsync(from derived: [SongDerivation],
                          progressOffset: Double, progressRange: Double) async {
        await upsertSongsCoreAsync(from: derived, progressOffset: progressOffset, progressRange: progressRange)
    }

    private func upsertSongsCore(from derived: [SongDerivation],
                                 onChunk: ((Int, Int) -> Void)?) {
        let existing = Dictionary(uniqueKeysWithValues: all(Song.self).map { ($0.id, $0) })
        let derivedByID = Dictionary(uniqueKeysWithValues: derived.map { ($0.id, $0) })

        for (id, row) in existing where derivedByID[id] == nil {
            context.delete(row)
        }
        let analysisByID = Dictionary(uniqueKeysWithValues:
            all(PhotoAnalysis.self).map { ($0.assetLocalIdentifier, $0) })
        let total = derived.count
        for (idx, d) in derived.enumerated() {
            applyOneDerivation(d, existing: existing, analysisByID: analysisByID)
            if let onChunk, idx % 100 == 99 { onChunk(idx + 1, total) }
        }
        let liveIDs = Set(derivedByID.keys)
        for set in all(SongTagSet.self) where liveIDs.contains(set.songKey) {
            context.delete(set)
        }
        try? context.save()
    }

    private func upsertSongsCoreAsync(from derived: [SongDerivation],
                                      progressOffset: Double, progressRange: Double) async {
        let existing = Dictionary(uniqueKeysWithValues: all(Song.self).map { ($0.id, $0) })
        let derivedByID = Dictionary(uniqueKeysWithValues: derived.map { ($0.id, $0) })

        for (id, row) in existing where derivedByID[id] == nil {
            context.delete(row)
        }
        let analysisByID = Dictionary(uniqueKeysWithValues:
            all(PhotoAnalysis.self).map { ($0.assetLocalIdentifier, $0) })
        let total = derived.count
        for (idx, d) in derived.enumerated() {
            applyOneDerivation(d, existing: existing, analysisByID: analysisByID)
            if idx % 50 == 49 {
                importStatus = "Rebuilding song list (\(idx + 1)/\(total))…"
                importProgress = progressOffset + progressRange * Double(idx + 1) / Double(max(1, total))
                await Task.yield()
            }
        }
        let liveIDs = Set(derivedByID.keys)
        for set in all(SongTagSet.self) where liveIDs.contains(set.songKey) {
            context.delete(set)
        }
        try? context.save()
    }

    private func applyOneDerivation(_ d: SongDerivation,
                                    existing: [String: Song],
                                    analysisByID: [String: PhotoAnalysis]) {
        if let row = existing[d.id] {
            if row.title != d.title { row.title = d.title }
            if row.titleIsCustom != d.titleIsCustom { row.titleIsCustom = d.titleIsCustom }
            if row.pageAssetIDs != d.pageAssetIDs { row.pageAssetIDs = d.pageAssetIDs }
            if row.firstPageDate != d.firstPageDate { row.firstPageDate = d.firstPageDate }
            if row.kindRaw != d.kind.rawValue { row.kindRaw = d.kind.rawValue }
            if row.chordText != d.chordText { row.chordText = d.chordText }
            if row.artist != d.artist { row.artist = d.artist }
            if row.isHidden != d.isHidden { row.isHidden = d.isHidden }
            applyTagSnapshot(d.tags, to: row)
            syncPages(of: row, to: d.pageAssetIDs, analysisByID: analysisByID)
        } else {
            let row = Song(id: d.id, title: d.title, pageAssetIDs: d.pageAssetIDs,
                           firstPageDate: d.firstPageDate, tags: d.tags, kind: d.kind,
                           chordText: d.chordText, artist: d.artist, isHidden: d.isHidden)
            row.titleIsCustom = d.titleIsCustom
            context.insert(row)
            applyTagSnapshot(d.tags, to: row)
            syncPages(of: row, to: d.pageAssetIDs, analysisByID: analysisByID)
        }
    }

    /// Resolve the derivation's tag-name list to Tag entities, updating both
    /// `tagLinks` (authoritative) and `tags` (display mirror). Only mutates if
    /// the resolved name set differs from the current `tagLinks`.
    private func applyTagSnapshot(_ names: [String], to song: Song) {
        let want = orderedUniqueNames(names)
        let have = song.tagLinks.map(\.name)
        let mirror = song.tags
        if want == have && want == mirror { return }
        let resolved: [Tag] = want.compactMap { name in
            if let t = tag(named: name) { return t }
            let t = Tag(name: name)
            context.insert(t)
            return t
        }
        if song.tagLinks.map(\.name) != want { song.tagLinks = resolved }
        if song.tags != want { song.tags = want }
    }

    private func orderedUniqueNames(_ names: [String]) -> [String] {
        var seen = Set<String>(); var out: [String] = []
        for n in names where !n.isEmpty && seen.insert(n).inserted { out.append(n) }
        return out
    }

    /// Mirror the song's ordered page list into the Song.pages relationship +
    /// each PhotoAnalysis.pageIndex. Lookup table is shared across all songs
    /// in one upsert pass to avoid per-song refetches.
    private func syncPages(of song: Song, to assetIDs: [String],
                           analysisByID: [String: PhotoAnalysis]) {
        let resolved: [PhotoAnalysis] = assetIDs.compactMap { analysisByID[$0] }
        let currentIDs = song.pages.map(\.assetLocalIdentifier)
        if currentIDs != assetIDs { song.pages = resolved }
        for (idx, page) in resolved.enumerated() where page.pageIndex != idx {
            page.pageIndex = idx
        }
    }

    // MARK: - Chord songs

    /// First existing ChordSong matching `title` (and `artist` if both sides
    /// have one — when either side's artist is nil/empty we match on title
    /// alone). Case- and diacritic-insensitive. Used by ChordAddView to warn
    /// before inserting an accidental duplicate.
    func findChordSong(title: String, artist: String?) -> ChordSong? {
        let normalize: (String?) -> String = { s in
            (s ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .folding(options: .diacriticInsensitive, locale: .current)
        }
        let nt = normalize(title)
        let na = normalize(artist)
        guard !nt.isEmpty else { return nil }
        return all(ChordSong.self).first { c in
            guard normalize(c.title) == nt else { return false }
            let other = normalize(c.artist)
            if na.isEmpty || other.isEmpty { return true }
            return na == other
        }
    }

    /// Add a new text-based chord song and rebuild the song list. `initialTags`
    /// is applied as a tag override on the new song (special tags like Sheet/Chord
    /// are filtered out; they're derived from kind, not stored).
    @discardableResult
    func addChordSong(title: String, artist: String?, chordText: String, sourceURL: String?, initialTags: [String] = []) -> ChordSong {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedArtist = artist?.trimmingCharacters(in: .whitespacesAndNewlines)
        let chord = ChordSong(
            title: trimmedTitle.isEmpty ? "Untitled" : trimmedTitle,
            artist: (trimmedArtist?.isEmpty == false) ? trimmedArtist : nil,
            chordText: chordText,
            sourceURL: sourceURL
        )
        context.insert(chord)
        let cleanTags = initialTags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !Self.specialTags.contains($0) }
        if !cleanTags.isEmpty {
            for name in cleanTags where tag(named: name) == nil {
                context.insert(Tag(name: name))
            }
            setTagsRaw(cleanTags, forKey: chord.id)
        }
        try? context.save()
        refreshTagNames()
        rebuildSongs()
        onMutate?()
        return chord
    }

    /// Update an existing chord song's text and rebuild.
    func updateChordSong(id: String, title: String? = nil, artist: String? = nil, chordText: String? = nil) {
        guard let chord = chordSong(id: id) else { return }
        if let title { chord.title = title }
        if let artist { chord.artist = artist.isEmpty ? nil : artist }
        if let chordText { chord.chordText = chordText }
        try? context.save()
        rebuildSongs()
        onMutate?()
    }

    /// Hard-delete a chord song (no Photos involved). Also clears its rename/tag overrides.
    func deleteChordSong(id: String) {
        if let chord = chordSong(id: id) { context.delete(chord) }
        if let rename = songTagRename(id) { context.delete(rename) }
        if let tagSet = songTagSet(id) { context.delete(tagSet) }
        if let m = songMeta(id) { context.delete(m) }
        try? context.save()
        rebuildSongs()
        onMutate?()
    }

    private func chordSong(id: String) -> ChordSong? {
        (try? context.fetch(FetchDescriptor<ChordSong>(predicate: #Predicate { $0.id == id })))?.first
    }

    /// Manually mark a page as the start of a new song (true) or part of the previous song (false).
    func setBoundary(_ assetID: String, isStart: Bool) {
        markBoundary(assetID, isStart: isStart)
        saveAndRebuild()
    }

    private func markBoundary(_ assetID: String, isStart: Bool) {
        if let existing = (try? context.fetch(FetchDescriptor<PageBoundary>(predicate: #Predicate { $0.assetID == assetID })))?.first {
            existing.isStart = isStart
        } else {
            context.insert(PageBoundary(assetID: assetID, isStart: isStart))
        }
    }

    /// The on-device-detected heading and tags for a single page, used to
    /// pre-fill the "new song" review form.
    func detectedInfo(forPage assetID: String) -> (title: String, tags: [String]) {
        let analysis = all(PhotoAnalysis.self).first { $0.assetLocalIdentifier == assetID }
        let title = (analysis?.title?.isEmpty == false) ? analysis!.title! : ""
        let tags = (analysis?.tags ?? []).filter { !Self.specialTags.contains($0) }
        return (title, tags)
    }

    /// Split a new song off starting at `assetID`, applying a user-reviewed title
    /// and tag list. The new song's key is its start page id, so the overrides
    /// attach to it once regrouped.
    func startNewSong(at assetID: String, title: String, tags: [String]) {
        markBoundary(assetID, isStart: true)
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let rename = songTagRename(assetID) { rename.customTitle = trimmed }
            else { context.insert(SongRename(songKey: assetID, customTitle: trimmed)) }
        }
        setTagsRaw(tags.filter { !Self.specialTags.contains($0) }, forKey: assetID)
        saveAndRebuild()
    }

    /// Undo a merge: remove the page groups rooted at this song so its pages regroup naturally.
    func unmerge(_ song: Song) {
        let pageSet = Set(song.pageAssetIDs)
        for group in all(PageGroup.self) where group.groupKey == song.id || pageSet.contains(group.assetID) {
            context.delete(group)
        }
        saveAndRebuild()
    }

    func renameSong(_ song: Song, to newTitle: String) {
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let row = songRow(song.id) else { return }
        let titled = trimmed.titleCased
        if row.title != titled { row.title = titled }
        if !row.titleIsCustom { row.titleIsCustom = true }
        try? context.save()
    }

    /// Merge song `a` into song `b`: all their pages (and any already-merged
    /// members) become one song, ordered by photo timestamp.
    func merge(_ a: Song, into b: Song) {
        guard a.id != b.id else { return }
        let groups = all(PageGroup.self)
        let groupByID = Dictionary(groups.map { ($0.assetID, $0.groupKey) }, uniquingKeysWith: { x, _ in x })

        var pages = Set(a.pageAssetIDs).union(b.pageAssetIDs)
        let keys = Set((a.pageAssetIDs + b.pageAssetIDs).compactMap { groupByID[$0] })
        for g in groups where keys.contains(g.groupKey) { pages.insert(g.assetID) }

        let dateByID = Dictionary(all(PhotoAnalysis.self).map { ($0.assetLocalIdentifier, $0.creationDate) },
                                  uniquingKeysWith: { x, _ in x })
        guard let root = pages.min(by: { (dateByID[$0] ?? .distantFuture) < (dateByID[$1] ?? .distantFuture) })
        else { return }

        for id in pages {
            if let existing = groups.first(where: { $0.assetID == id }) { existing.groupKey = root }
            else { context.insert(PageGroup(assetID: id, groupKey: root)) }
        }
        saveAndRebuild()
    }

    /// Soft delete: hide the song from the main list (recoverable via Restore).
    /// Maintains the `Song.tags` display mirror so the "Deleted" chip appears
    /// alongside the song's other tags and TagsView counts it correctly.
    func softDelete(_ song: Song) {
        guard let row = songRow(song.id) else { return }
        if !row.isHidden { row.isHidden = true }
        if !row.tags.contains(Self.deletedTag) {
            row.tags = [Self.deletedTag] + row.tags
        }
        try? context.save()
    }

    /// Restore a soft-deleted song.
    func restore(_ song: Song) {
        guard let row = songRow(song.id) else { return }
        if row.isHidden { row.isHidden = false }
        if row.tags.contains(Self.deletedTag) {
            row.tags = row.tags.filter { $0 != Self.deletedTag }
        }
        try? context.save()
    }

    /// Bulk soft-delete: mark every matching Song.isHidden = true in one save.
    /// Used by multi-select "Move to Deleted" so the action mirrors the single-song
    /// trash behavior (recoverable via Restore from the Deleted filter).
    func softDeleteMany(ids: Set<String>) {
        guard !ids.isEmpty else { return }
        var changed = false
        for song in all(Song.self) where ids.contains(song.id) && !song.isHidden {
            song.isHidden = true
            if !song.tags.contains(Self.deletedTag) {
                song.tags = [Self.deletedTag] + song.tags
            }
            changed = true
        }
        if changed { try? context.save() }
    }

    /// Delete a song's metadata. If `deletePhotos`, also remove its page photos
    /// from Apple Photos (the system shows its own confirmation). Returns false
    /// if the photo deletion was cancelled/failed (metadata is then left intact).
    func deleteSong(_ song: Song, deletePhotos: Bool) async -> Bool {
        if deletePhotos {
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: song.pageAssetIDs, options: nil)
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.deleteAssets(assets)
                }
            } catch {
                return false   // user cancelled the system delete prompt
            }
        }
        let ids = Set(song.pageAssetIDs)
        for analysis in all(PhotoAnalysis.self) where ids.contains(analysis.assetLocalIdentifier) { context.delete(analysis) }
        for group in all(PageGroup.self) where ids.contains(group.assetID) { context.delete(group) }
        for boundary in all(PageBoundary.self) where ids.contains(boundary.assetID) { context.delete(boundary) }
        if let rename = songTagRename(song.id) { context.delete(rename) }
        if let tagSet = songTagSet(song.id) { context.delete(tagSet) }
        if let m = songMeta(song.id) { context.delete(m) }
        saveAndRebuild()
        return true
    }

    /// Batch-delete several songs at once. With `deletePhotos`, all their page
    /// photos are removed from Apple Photos in a single system prompt. Returns
    /// false if the photo deletion was cancelled (metadata then left intact).
    /// Chord songs are deleted directly (no Photos involvement) regardless of `deletePhotos`.
    func deleteSongs(_ targets: [Song], deletePhotos: Bool) async -> Bool {
        guard !targets.isEmpty else { return true }
        let sheetTargets = targets.filter { $0.kind == .sheet }
        let chordTargets = targets.filter { $0.kind == .chord }

        if deletePhotos && !sheetTargets.isEmpty {
            let allIDs = sheetTargets.flatMap { $0.pageAssetIDs }
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: allIDs, options: nil)
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.deleteAssets(assets)
                }
            } catch {
                return false
            }
        }
        for song in sheetTargets {
            let ids = Set(song.pageAssetIDs)
            for analysis in all(PhotoAnalysis.self) where ids.contains(analysis.assetLocalIdentifier) { context.delete(analysis) }
            for group in all(PageGroup.self) where ids.contains(group.assetID) { context.delete(group) }
            for boundary in all(PageBoundary.self) where ids.contains(boundary.assetID) { context.delete(boundary) }
            if let rename = songTagRename(song.id) { context.delete(rename) }
            if let tagSet = songTagSet(song.id) { context.delete(tagSet) }
            if let m = songMeta(song.id) { context.delete(m) }
        }
        for song in chordTargets {
            if let chord = chordSong(id: song.id) { context.delete(chord) }
            if let rename = songTagRename(song.id) { context.delete(rename) }
            if let tagSet = songTagSet(song.id) { context.delete(tagSet) }
            if let m = songMeta(song.id) { context.delete(m) }
        }
        saveAndRebuild()
        return true
    }


    // MARK: - Tags

    /// Number of (non-deleted) songs carrying each tag. Reads directly from the
    /// Tag↔Song relationship — O(vocabulary) instead of scanning every song.
    /// The "Deleted" system tag is special-cased: its count is the number of
    /// soft-deleted songs (Song.isHidden == true), since deletion is a bool
    /// on Song rather than a real relationship.
    func tagSongCounts() -> [String: Int] {
        var counts: [String: Int] = [:]
        let deletedCount = all(Song.self).filter { $0.isHidden }.count
        for t in all(Tag.self) {
            if t.name == Self.deletedTag {
                counts[t.name] = deletedCount
            } else {
                counts[t.name] = t.songs.filter { !$0.isHidden }.count
            }
        }
        return counts
    }

    /// Co-occurrence counts: among the songs that already match `selected` (AND
    /// semantics, soft-deleted hidden unless Deleted is selected), how many carry
    /// each tag. With nothing selected this matches `tagSongCounts`.
    func tagSongCounts(matching selected: Set<String>) -> [String: Int] {
        let base = SongQuery.run(songs, search: "", tags: selected,
                                 sortKeys: [SortKey(column: .title, ascending: true)])
        var counts: [String: Int] = [:]
        for song in base {
            for tag in song.tags { counts[tag, default: 0] += 1 }
        }
        return counts
    }

    func addVocabTag(_ name: String) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, tag(named: n) == nil else { return }
        context.insert(Tag(name: n))
        try? context.save()
        refreshTagNames()
    }

    /// Rename a tag everywhere. If `newName` already exists, the two are merged.
    /// O(1) on the relationship — the Tag row's name field is mutated and every
    /// linked Song picks up the new name automatically.
    func renameTag(_ old: String, to newName: String) {
        guard !Self.specialTags.contains(old) else { return }   // system tags are reserved
        let new = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !new.isEmpty, new != old, !Self.specialTags.contains(new) else { return }

        if let oldTag = tag(named: old) {
            if let newTag = tag(named: new) {
                // Merge: move all songs from old → new, delete old.
                for song in oldTag.songs where !song.tagLinks.contains(where: { $0.name == new }) {
                    song.tagLinks.append(newTag)
                }
                context.delete(oldTag)
            } else {
                oldTag.name = new
            }
        } else if tag(named: new) == nil {
            insertTag(new)
        }
        // PhotoAnalysis.tags is the immutable AI snapshot — still rewrite to keep
        // re-tag suggestions consistent.
        for a in all(PhotoAnalysis.self) where a.tags.contains(old) {
            var t = a.tags.filter { $0 != old }
            if !t.contains(new) { t.append(new) }
            a.tags = t
        }
        try? context.save()
        // Mirror the display field on every affected Song.
        for song in all(Song.self) {
            let names = song.tagLinks.map(\.name)
            if song.tags != names { song.tags = names }
        }
        try? context.save()
        refreshTagNames()
    }

    func deleteVocabTag(_ name: String) {
        guard !Self.specialTags.contains(name) else { return }   // system tags can't be deleted
        if let tag = tag(named: name) {
            // SwiftData clears the inverse relationship; we still need to refresh
            // the legacy display mirror on each affected song.
            let affected = tag.songs
            context.delete(tag)
            for song in affected {
                let names = song.tagLinks.filter { $0.name != name }.map(\.name)
                if song.tags != names { song.tags = names }
            }
        }
        for a in all(PhotoAnalysis.self) where a.tags.contains(name) { a.tags.removeAll { $0 == name } }
        try? context.save()
        refreshTagNames()
    }

    /// Add one tag to many songs at once (adds it to the vocabulary if new).
    /// Operates directly on the relationship: per-row mutation only.
    func addTag(_ name: String, toSongIDs ids: Set<String>) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        let tagEntity = tag(named: n) ?? insertTag(n)
        for song in all(Song.self) where ids.contains(song.id) {
            if !song.tagLinks.contains(where: { $0.name == n }) {
                song.tagLinks.append(tagEntity)
                song.tags = song.tagLinks.map(\.name)
            }
        }
        try? context.save()
        refreshTagNames()
    }

    /// Add several tags to many songs at once (creating any new vocabulary tags).
    func addTags(_ names: Set<String>, toSongIDs ids: Set<String>) {
        let clean = names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !clean.isEmpty, !ids.isEmpty else { return }
        let resolved: [Tag] = clean.map { tag(named: $0) ?? insertTag($0) }
        for song in all(Song.self) where ids.contains(song.id) {
            var changed = false
            for t in resolved where !song.tagLinks.contains(where: { $0.name == t.name }) {
                song.tagLinks.append(t); changed = true
            }
            if changed { song.tags = song.tagLinks.map(\.name) }
        }
        try? context.save()
        refreshTagNames()
    }

    /// Remove several tags from many songs at once.
    func removeTags(_ names: Set<String>, fromSongIDs ids: Set<String>) {
        guard !names.isEmpty, !ids.isEmpty else { return }
        for song in all(Song.self) where ids.contains(song.id) {
            let before = song.tagLinks.count
            song.tagLinks.removeAll { names.contains($0.name) }
            if song.tagLinks.count != before {
                song.tags = song.tagLinks.map(\.name)
            }
        }
        try? context.save()
        refreshTagNames()
    }

    /// Set the full tag list for a song. Resolves names → Tag entities (creating
    /// missing vocabulary) and writes the relationship + display mirror.
    func setTags(_ tags: [String], for song: Song) {
        guard let row = songRow(song.id) else { return }
        let want = orderedUniqueNames(tags.filter { !Self.specialTags.contains($0) })
        let resolved: [Tag] = want.map { tag(named: $0) ?? insertTag($0) }
        // Preserve any system tag (Sheet/Chord) already attached so kind chips remain.
        let systemKeep = row.tagLinks.filter { $0.isSystem }
        row.tagLinks = systemKeep + resolved
        row.tags = row.tagLinks.map(\.name)
        try? context.save()
        refreshTagNames()
    }

    private func songRow(_ id: String) -> Song? {
        (try? context.fetch(FetchDescriptor<Song>(predicate: #Predicate { $0.id == id })))?.first
    }

    /// Legacy seed: writes a brand-new song's initial tags into the temporary
    /// SongTagSet table. `rebuildSongs` then resolves them into the @Model
    /// Song's `tagLinks` and the next launch's migration helper drops the row.
    /// Used only by `addChordSong` and `startNewSong` for new-song creation;
    /// existing-song mutations bypass this and write `tagLinks` directly.
    private func setTagsRaw(_ tags: [String], forKey key: String) {
        if let set = songTagSet(key) { set.tags = tags }
        else { context.insert(SongTagSet(songKey: key, tags: tags)) }
    }

    private func seedTagsIfNeeded() {
        guard (try? context.fetchCount(FetchDescriptor<Tag>())) == 0 else { return }
        for name in Self.predefinedTags { context.insert(Tag(name: name, category: "genre")) }
        try? context.save()
    }

    /// One-time fix for installs created before tags had a category.
    private func migrateTagCategoriesIfNeeded() {
        let key = "tagCategoriesMigrated_v1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        for t in all(Tag.self) where !Self.specialTags.contains(t.name) {
            t.category = Self.predefinedTagSet.contains(t.name) ? "genre" : "custom"
        }
        try? context.save()
        UserDefaults.standard.set(true, forKey: key)
    }

    /// Ensure the Sheet/Chord/Deleted system tags exist in the vocabulary so they
    /// appear in TagsView for filtering, and that they're flagged `isSystem` so
    /// the UI guards their delete/rename. The Deleted chip is what lets the user
    /// surface soft-deleted songs (which match by Song.isHidden == true, not by
    /// the relationship). Idempotent — runs every launch.
    private func ensureSystemTagsExist() {
        for name in [Self.sheetTag, Self.chordTag, Self.deletedTag] {
            if let t = tag(named: name) {
                if !t.isSystem { t.isSystem = true }
            } else {
                context.insert(Tag(name: name, isSystem: true))
            }
        }
        try? context.save()
    }

    /// One-time migration: replace `SongTagSet.tags` (inlined String array) with
    /// the real `Song.tagLinks` many-to-many. Reads each set, resolves names to
    /// Tag entities (creating any missing), attaches to the matching Song row,
    /// then deletes the SongTagSet row. Sheet/Chord get attached based on Song.kind.
    private func migrateSongTagSetToTagLinksIfNeeded() {
        let key = "songTagSetToTagLinks_v1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        let songByID = Dictionary(uniqueKeysWithValues: all(Song.self).map { ($0.id, $0) })
        for set in all(SongTagSet.self) {
            // Only migrate when the matching Song row exists. If it doesn't,
            // leave the SongTagSet row intact so rebuildSongs's fallback can
            // still seed tagLinks via applyTagSnapshot on the next pass.
            guard let song = songByID[set.songKey] else { continue }
            let names = orderedUniqueNames(set.tags.filter { !Self.specialTags.contains($0) })
            var resolved: [Tag] = names.compactMap { tag(named: $0) ?? insertTag($0) }
            let kindName = song.kind == .sheet ? Self.sheetTag : Self.chordTag
            if let kindTag = tag(named: kindName) ?? Optional(insertTag(kindName, isSystem: true)) {
                if !resolved.contains(where: { $0.name == kindName }) {
                    resolved.insert(kindTag, at: 0)
                }
            }
            song.tagLinks = resolved
            context.delete(set)
        }
        try? context.save()
        UserDefaults.standard.set(true, forKey: key)
    }

    @discardableResult
    private func insertTag(_ name: String, isSystem: Bool = false) -> Tag {
        let t = Tag(name: name, isSystem: isSystem)
        context.insert(t)
        return t
    }

    /// One-time migration that promotes the "Deleted" reserved-tag string from
    /// `SongTagSet.tags` (and `PhotoAnalysis.tags`) into `SongMeta.isHidden`,
    /// then strips the string. Also strips any legacy "Favorite"/"Star" strings.
    private func migrateDeletedToMetaIfNeeded() {
        let key = "favoriteDeletedToMeta_v1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        let legacy: Set<String> = [Self.deletedTag, "Favorite", "Star"]
        for set in all(SongTagSet.self) {
            let hadDel = set.tags.contains(Self.deletedTag)
            let needsStrip = set.tags.contains { legacy.contains($0) }
            guard needsStrip else { continue }
            if hadDel { meta(for: set.songKey).isHidden = true }
            set.tags.removeAll { legacy.contains($0) }
        }
        for a in all(PhotoAnalysis.self) where a.tags.contains(where: { legacy.contains($0) }) {
            a.tags.removeAll { legacy.contains($0) }
        }
        try? context.save()
        UserDefaults.standard.set(true, forKey: key)
    }

    /// Drop any "Favorite" / "Star" rows from the Tag vocabulary, since the
    /// favorite feature was removed. Idempotent; cheap to run every launch.
    private func purgeFavoriteVocabIfNeeded() {
        for name in ["Favorite", "Star"] {
            if let t = tag(named: name) { context.delete(t) }
        }
        try? context.save()
    }

    private func refreshTagNames() {
        let tags = all(Tag.self)
        tagNames = tags.map(\.name).sorted()
        tagCategories = Dictionary(tags.map { ($0.name, $0.category) }, uniquingKeysWith: { a, _ in a })
    }

    /// Move a normal tag between the Genre and Custom groups.
    func setTagCategory(_ name: String, to category: String) {
        guard !Self.specialTags.contains(name), let t = tag(named: name) else { return }
        t.category = category
        try? context.save()
        refreshTagNames()
    }

    // MARK: - Backup

    func exportData() -> Data {
        let analyses = all(PhotoAnalysis.self).map {
            BackupData.AnalysisDTO(assetID: $0.assetLocalIdentifier, creationDate: $0.creationDate,
                                   isMusicSheet: $0.isMusicSheet, isSongStart: $0.isSongStart,
                                   title: $0.title, tags: $0.tags, analyzedAt: $0.analyzedAt)
        }
        let renames = all(SongRename.self).map { BackupData.RenameDTO(songKey: $0.songKey, customTitle: $0.customTitle) }
        // Tag sets now derive from the Song.tagLinks relationship (legacy
        // SongTagSet is empty after the v1 migration sweep).
        let tagSets = all(Song.self)
            .filter { !$0.tagLinks.isEmpty }
            .map { BackupData.TagSetDTO(songKey: $0.id, tags: $0.tagLinks.map(\.name)) }
        let groups = all(PageGroup.self).map { BackupData.GroupDTO(assetID: $0.assetID, groupKey: $0.groupKey) }
        let boundaries = all(PageBoundary.self).map { BackupData.BoundaryDTO(assetID: $0.assetID, isStart: $0.isStart) }

        // Every referenced local asset id, mapped to its iCloud cloud-identifier.
        var ids = Set<String>()
        analyses.forEach { ids.insert($0.assetID) }
        renames.forEach { ids.insert($0.songKey) }
        tagSets.forEach { ids.insert($0.songKey) }
        groups.forEach { ids.insert($0.assetID); ids.insert($0.groupKey) }
        boundaries.forEach { ids.insert($0.assetID) }
        let cloud = library.cloudIDs(for: Array(ids))
        let assetMap = ids.map { BackupData.AssetRef(local: $0, cloud: cloud[$0]) }

        let chords = all(ChordSong.self).map {
            BackupData.ChordSongDTO(id: $0.id, title: $0.title, artist: $0.artist,
                                    chordText: $0.chordText, sourceURL: $0.sourceURL, createdAt: $0.createdAt)
        }
        // Deletion state now lives on Song.isHidden (SongMeta is empty in steady
        // state after the Step 5 sweep). Derive metas from Song rows so cloud
        // snapshots preserve soft-deletes across devices.
        let metas = all(Song.self).filter { $0.isHidden }.map {
            BackupData.MetaDTO(songKey: $0.id, isHidden: true)
        }
        let backup = BackupData(
            analyses: analyses, renames: renames, tagSets: tagSets, groups: groups,
            boundaries: boundaries, tags: tagNames, tagCategories: tagCategories,
            assetMap: assetMap, chordSongs: chords, metas: metas
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(backup)) ?? Data()
    }

    struct ImportSummary { let songs: Int; let photos: Int; let relinked: Int; let fallback: Int }

    /// Replace the current database with a backup. Returns nil if the file is invalid.
    /// Photo references are relinked to this device via iCloud cloud-identifiers when possible.
    /// Async so we can yield to the SwiftUI run loop between phases, letting
    /// the "Loading from cloud" overlay actually update mid-import on a
    /// multi-thousand-song restore. Each phase updates `importStatus` and
    /// `importProgress` before yielding.
    @discardableResult
    func importData(_ data: Data) async -> ImportSummary? {
        importStatus = "Reading cloud snapshot…"
        importProgress = 0
        defer { importStatus = nil; importProgress = nil }
        await Task.yield()

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let backup = try? decoder.decode(BackupData.self, from: data) else { return nil }

        // Build old-local → this-device-local remap from cloud identifiers.
        importStatus = "Matching photos…"
        importProgress = 0.05
        await Task.yield()
        var remap: [String: String] = [:]
        var relinked = 0, fallback = 0
        let assetMap = backup.assetMap ?? []
        if !assetMap.isEmpty {
            let cloudToLocal = library.localIDs(forCloud: assetMap.compactMap { $0.cloud })
            for ref in assetMap {
                if let cloud = ref.cloud, let newLocal = cloudToLocal[cloud] {
                    remap[ref.local] = newLocal; relinked += 1
                } else {
                    remap[ref.local] = ref.local; fallback += 1
                }
            }
        }
        func mapID(_ id: String) -> String { remap[id] ?? id }

        importStatus = "Clearing local cache…"
        importProgress = 0.1
        await Task.yield()
        // Wipe everything EXCEPT chord songs. They get merged in below so a
        // pull from an older cloud snapshot can't destroy chords she just added
        // locally but hasn't pushed yet (e.g. before a reinstall via devicectl).
        wipeSongData(includingTags: true, includingChords: false)

        let total = backup.analyses.count
        for (i, a) in backup.analyses.enumerated() {
            context.insert(PhotoAnalysis(assetLocalIdentifier: mapID(a.assetID), creationDate: a.creationDate,
                                         isMusicSheet: a.isMusicSheet, isSongStart: a.isSongStart,
                                         title: a.title, tags: a.tags, analyzedAt: a.analyzedAt))
            if i % 100 == 0 {
                importStatus = "Restoring photos (\(i)/\(total))…"
                importProgress = total > 0 ? 0.15 + 0.45 * Double(i) / Double(total) : 0.6
                await Task.yield()
            }
        }
        importProgress = 0.6
        await Task.yield()

        importStatus = "Restoring metadata…"
        for r in backup.renames { context.insert(SongRename(songKey: mapID(r.songKey), customTitle: r.customTitle)) }
        // Tag sets: strip legacy Favorite/Deleted strings; isHidden lives in SongMeta now,
        // Favorite is gone entirely.
        let legacyStrip: Set<String> = [Self.deletedTag, "Favorite", "Star"]
        var legacyDel = Set<String>()
        for t in backup.tagSets {
            let key = mapID(t.songKey)
            if t.tags.contains(Self.deletedTag) { legacyDel.insert(key) }
            let clean = t.tags.filter { !legacyStrip.contains($0) }
            context.insert(SongTagSet(songKey: key, tags: clean))
        }
        for g in backup.groups { context.insert(PageGroup(assetID: mapID(g.assetID), groupKey: mapID(g.groupKey))) }
        for b in backup.boundaries ?? [] { context.insert(PageBoundary(assetID: mapID(b.assetID), isStart: b.isStart)) }
        if let metas = backup.metas {
            for m in metas {
                context.insert(SongMeta(songKey: mapID(m.songKey), isHidden: m.isHidden))
            }
        } else {
            for key in legacyDel {
                context.insert(SongMeta(songKey: key, isHidden: true))
            }
        }
        for name in backup.tags {
            let category = backup.tagCategories?[name] ?? (Self.predefinedTagSet.contains(name) ? "genre" : "custom")
            context.insert(Tag(name: name, category: category))
        }
        importProgress = 0.75
        await Task.yield()

        importStatus = "Merging chord songs…"
        let existingChords = Dictionary(all(ChordSong.self).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for chord in backup.chordSongs ?? [] {
            if let existing = existingChords[chord.id] {
                existing.title = chord.title
                existing.artist = chord.artist
                existing.chordText = chord.chordText
                existing.sourceURL = chord.sourceURL
                existing.createdAt = chord.createdAt
            } else {
                context.insert(ChordSong(id: chord.id, title: chord.title, artist: chord.artist,
                                         chordText: chord.chordText, sourceURL: chord.sourceURL,
                                         createdAt: chord.createdAt))
            }
        }
        ensureSystemTagsExist()
        refreshTagNames()
        importStatus = "Rebuilding song list…"
        importProgress = 0.85
        await Task.yield()
        // Chunked rebuild so the progress bar moves visibly during the
        // expensive Song @Model materialization on large libraries.
        await rebuildSongsAsync(progressOffset: 0.85, progressRange: 0.15)
        importProgress = 1.0
        await Task.yield()
        return ImportSummary(songs: songs.count, photos: assetMap.count, relinked: relinked, fallback: fallback)
    }

    /// Async version of rebuildSongs that yields during the upsert loop so
    /// the cloud-import overlay can advance its progress bar instead of
    /// freezing at one value for the whole rebuild.
    private func rebuildSongsAsync(progressOffset: Double, progressRange: Double) async {
        let renameMap = collectRenameMap()
        let tagMap = collectTagOverrideMap()
        let groupMap = Dictionary(all(PageGroup.self).map { ($0.assetID, $0.groupKey) }, uniquingKeysWith: { a, _ in a })
        let boundaryMap = Dictionary(all(PageBoundary.self).map { ($0.assetID, $0.isStart) }, uniquingKeysWith: { a, _ in a })
        var deletedKeys = Set(all(Song.self).filter { $0.isHidden }.map(\.id))
        for m in all(SongMeta.self) where m.isHidden { deletedKeys.insert(m.songKey) }
        let analyses = all(PhotoAnalysis.self)
        let chordSongs = all(ChordSong.self)
        let derived = GroupingEngine.group(analyses: analyses, chordSongs: chordSongs,
                                           renames: renameMap, tagOverrides: tagMap,
                                           pageGroups: groupMap, boundaries: boundaryMap,
                                           deletedKeys: deletedKeys,
                                           sheetTag: Self.sheetTag, chordTag: Self.chordTag,
                                           deletedTag: Self.deletedTag)
        await upsertSongsAsync(from: derived, progressOffset: progressOffset, progressRange: progressRange)
        songs = all(Song.self).sorted { $0.firstPageDate > $1.firstPageDate }
        lastScanDate = analyses.filter { $0.isMusicSheet }.map(\.creationDate).max()
    }

    private func collectRenameMap() -> [String: String] {
        var map = Dictionary(uniqueKeysWithValues:
            all(Song.self).filter { $0.titleIsCustom }.map { ($0.id, $0.title) })
        for r in all(SongRename.self) where map[r.songKey] == nil { map[r.songKey] = r.customTitle }
        return map
    }

    private func collectTagOverrideMap() -> [String: [String]] {
        var map = Dictionary(all(Song.self).map { ($0.id, $0.tagLinks.map(\.name)) },
                             uniquingKeysWith: { a, _ in a })
        for set in all(SongTagSet.self) where map[set.songKey] == nil {
            map[set.songKey] = set.tags
        }
        return map
    }

    // MARK: - SwiftData helpers

    private func all<T: PersistentModel>(_ type: T.Type) -> [T] {
        (try? context.fetch(FetchDescriptor<T>())) ?? []
    }

    private func tag(named name: String) -> Tag? {
        (try? context.fetch(FetchDescriptor<Tag>(predicate: #Predicate { $0.name == name })))?.first
    }

    private func songTagSet(_ key: String) -> SongTagSet? {
        (try? context.fetch(FetchDescriptor<SongTagSet>(predicate: #Predicate { $0.songKey == key })))?.first
    }

    private func songTagRename(_ key: String) -> SongRename? {
        (try? context.fetch(FetchDescriptor<SongRename>(predicate: #Predicate { $0.songKey == key })))?.first
    }

    private func songMeta(_ key: String) -> SongMeta? {
        (try? context.fetch(FetchDescriptor<SongMeta>(predicate: #Predicate { $0.songKey == key })))?.first
    }

    /// Get-or-create the SongMeta row for `key`.
    private func meta(for key: String) -> SongMeta {
        if let m = songMeta(key) { return m }
        let m = SongMeta(songKey: key)
        context.insert(m)
        return m
    }

    private func wipeSongData(includingTags: Bool, includingChords: Bool = true) {
        try? context.delete(model: Song.self)
        try? context.delete(model: PhotoAnalysis.self)
        try? context.delete(model: SongRename.self)
        try? context.delete(model: SongTagSet.self)
        try? context.delete(model: SongMeta.self)
        try? context.delete(model: PageGroup.self)
        try? context.delete(model: PageBoundary.self)
        if includingChords { try? context.delete(model: ChordSong.self) }
        if includingTags { try? context.delete(model: Tag.self) }
    }

    private func saveAndRebuild() {
        try? context.save()
        rebuildSongs()
    }
}
