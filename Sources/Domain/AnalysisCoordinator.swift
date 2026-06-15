import Foundation
import Photos
import SwiftData

/// Drives the scan pipeline (prefilter → Claude → cache) and exposes the grouped songs.
@MainActor
@Observable
final class AnalysisCoordinator {
    var songs: [Song] = []
    var isScanning = false
    var progressDone = 0
    var progressTotal = 0
    var lastError: String?
    var lastScanMessage: String?
    var lastScanDate: Date?        // newest sheet photo currently in the song list (derived)
    var scanStatus: String?
    var sheetsFound = 0
    var lastItemDate: Date?
    var tagNames: [String] = []
    var tagCategories: [String: String] = [:]   // tag name → "genre" | "custom"

    static let deletedTag = "Deleted"
    static let starTag = "Star"
    static let specialTags: Set<String> = [starTag, deletedTag]
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
    private let claude = ClaudeClient()
    private let prefilter = CornerColorPrefilter()

    init(context: ModelContext, library: PhotoLibraryService) {
        self.context = context
        self.library = library
        seedTagsIfNeeded()
        migrateTagCategoriesIfNeeded()
        refreshTagNames()
    }

    // MARK: - Scanning

    /// Incremental: only photos newer than the most recently scanned one
    /// (first scan → all photos).
    func scanNew(apiKey: String) async {
        await run(assets: library.assetsToScan(after: latestScannedDate()), apiKey: apiKey)
    }

    private func run(assets toScan: [PHAsset], apiKey: String) async {
        guard !isScanning else { return }
        isScanning = true
        lastError = nil
        scanStatus = nil
        sheetsFound = 0
        lastItemDate = nil
        progressDone = 0
        progressTotal = toScan.count
        defer { isScanning = false; scanStatus = nil }

        let songIDsBefore = Set(songs.map(\.id))
        let existing = Set(all(PhotoAnalysis.self).map(\.assetLocalIdentifier))
        let toProcess = toScan.filter { !existing.contains($0.localIdentifier) }
        progressDone += toScan.count - toProcess.count

        // One concurrent pipeline: on-device prefilter → real-time Claude call for
        // anything that passes. Progress advances per photo as each finishes.
        let vocabulary = tagNames.filter { !Self.specialTags.contains($0) }   // never auto-tag Star/Deleted
        scanStatus = "Analyzing photos with Anthropic…"
        await withTaskGroup(of: AssetOutcome.self) { group in
            var index = 0
            func addNext() {
                guard index < toProcess.count else { return }
                let asset = toProcess[index]; index += 1
                group.addTask { await self.analyze(asset, vocabulary: vocabulary, apiKey: apiKey) }
            }
            for _ in 0 ..< min(Self.maxConcurrent, toProcess.count) { addNext() }

            for await outcome in group {
                if Task.isCancelled { break }
                switch outcome {
                case let .notSheet(id, date):
                    store(id: id, date: date, sheet: false, start: false, title: nil)
                    lastItemDate = date
                case let .analyzed(id, date, c):
                    store(id: id, date: date, sheet: c.is_music_sheet, start: c.is_song_start,
                          title: c.title, tags: c.tags ?? [])
                    if c.is_music_sheet { sheetsFound += 1 }
                    lastItemDate = date
                case let .failed(message):
                    lastError = message   // left unanalyzed → retried next scan
                case .skip:
                    break
                }
                progressDone += 1
                addNext()
            }
            group.cancelAll()
        }

        let cancelled = Task.isCancelled
        rebuildSongs()
        let added = songs.filter { !songIDsBefore.contains($0.id) }.count
        if cancelled {
            lastScanMessage = "Scan stopped. \(added) song\(added == 1 ? "" : "s") added so far."
        } else {
            lastScanMessage = progressTotal == 0
                ? "No new photos to scan."
                : "Scanned \(progressTotal) photo\(progressTotal == 1 ? "" : "s"). Added \(added) song\(added == 1 ? "" : "s")."
        }
    }

    private enum AssetOutcome: Sendable {
        case notSheet(String, Date)
        case analyzed(String, Date, ClaudeClient.Classification)
        case failed(String)
        case skip(String)
    }

    /// Prefilter one asset on-device; if it passes, download the full image and
    /// classify it in real time via Claude.
    private func analyze(_ asset: PHAsset, vocabulary: [String], apiKey: String) async -> AssetOutcome {
        let id = asset.localIdentifier
        let date = asset.creationDate ?? .distantPast
        if let thumb = await library.prefilterThumbnail(for: asset), !prefilter.looksLikeSheet(thumb) {
            return .notSheet(id, date)
        }
        guard let image = await library.analysisImage(for: asset),
              let jpeg = image.jpegData(compressionQuality: 0.7) else { return .skip(id) }
        do {
            let c = try await claude.classify(jpeg: jpeg, vocabulary: vocabulary, apiKey: apiKey)
            return .analyzed(id, date, c)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func latestScannedDate() -> Date? {
        var descriptor = FetchDescriptor<PhotoAnalysis>(sortBy: [SortDescriptor(\.creationDate, order: .reverse)])
        descriptor.fetchLimit = 1
        return (try? context.fetch(descriptor))?.first?.creationDate
    }

    private func store(id: String, date: Date, sheet: Bool, start: Bool, title: String?, tags: [String] = []) {
        context.insert(PhotoAnalysis(assetLocalIdentifier: id, creationDate: date,
                                     isMusicSheet: sheet, isSongStart: start,
                                     title: title, tags: tags, analyzedAt: .now))
        try? context.save()
    }

    // MARK: - Songs

    func rebuildSongs() {
        let renameMap = Dictionary(all(SongRename.self).map { ($0.songKey, $0.customTitle) }, uniquingKeysWith: { a, _ in a })
        let tagMap = Dictionary(all(SongTagSet.self).map { ($0.songKey, $0.tags) }, uniquingKeysWith: { a, _ in a })
        let groupMap = Dictionary(all(PageGroup.self).map { ($0.assetID, $0.groupKey) }, uniquingKeysWith: { a, _ in a })
        let boundaryMap = Dictionary(all(PageBoundary.self).map { ($0.assetID, $0.isStart) }, uniquingKeysWith: { a, _ in a })
        let analyses = all(PhotoAnalysis.self)
        songs = GroupingEngine.group(analyses: analyses, renames: renameMap,
                                     tagOverrides: tagMap, pageGroups: groupMap, boundaries: boundaryMap)
        // "Last scan" = the newest sheet photo that made it into the song list.
        lastScanDate = analyses.filter { $0.isMusicSheet }.map(\.creationDate).max()
    }

    /// Manually mark a page as the start of a new song (true) or part of the previous song (false).
    func setBoundary(_ assetID: String, isStart: Bool) {
        if let existing = (try? context.fetch(FetchDescriptor<PageBoundary>(predicate: #Predicate { $0.assetID == assetID })))?.first {
            existing.isStart = isStart
        } else {
            context.insert(PageBoundary(assetID: assetID, isStart: isStart))
        }
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
        guard !trimmed.isEmpty else { return }
        if let existing = songTagRename(song.id) { existing.customTitle = trimmed }
        else { context.insert(SongRename(songKey: song.id, customTitle: trimmed)) }
        saveAndRebuild()
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

    /// Soft delete: tag the song "Deleted" (hidden from the main list, recoverable).
    func softDelete(_ song: Song) {
        addTag(Self.deletedTag, toSongIDs: [song.id])
    }

    /// Restore a soft-deleted song by removing its "Deleted" tag.
    func restore(_ song: Song) {
        setTags(song.tags.filter { $0 != Self.deletedTag }, for: song)
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
        saveAndRebuild()
        return true
    }

    /// Wipe all song data and the last-scan timestamp, so the next "Scan New"
    /// re-analyzes the whole library. The tag vocabulary and photos are untouched.
    func wipeDatabase() {
        wipeSongData(includingTags: false)
        saveAndRebuild()
    }

    // MARK: - Tags

    /// Number of songs currently carrying each tag.
    func tagSongCounts() -> [String: Int] {
        var counts: [String: Int] = [:]
        for song in songs {
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
    func renameTag(_ old: String, to newName: String) {
        let new = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !new.isEmpty, new != old else { return }

        if let oldTag = tag(named: old) {
            if tag(named: new) == nil { oldTag.name = new } else { context.delete(oldTag) }  // merge
        } else if tag(named: new) == nil {
            context.insert(Tag(name: new))
        }
        for set in all(SongTagSet.self) where set.tags.contains(old) {
            var t = set.tags.filter { $0 != old }
            if !t.contains(new) { t.append(new) }
            set.tags = t
        }
        for a in all(PhotoAnalysis.self) where a.tags.contains(old) {
            var t = a.tags.filter { $0 != old }
            if !t.contains(new) { t.append(new) }
            a.tags = t
        }
        try? context.save()
        refreshTagNames()
        rebuildSongs()
    }

    func deleteVocabTag(_ name: String) {
        if let tag = tag(named: name) { context.delete(tag) }
        for set in all(SongTagSet.self) where set.tags.contains(name) { set.tags.removeAll { $0 == name } }
        for a in all(PhotoAnalysis.self) where a.tags.contains(name) { a.tags.removeAll { $0 == name } }
        try? context.save()
        refreshTagNames()
        rebuildSongs()
    }

    /// Add one tag to many songs at once (adds it to the vocabulary if new).
    func addTag(_ name: String, toSongIDs ids: Set<String>) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        if tag(named: n) == nil { context.insert(Tag(name: n)) }
        for song in songs where ids.contains(song.id) {
            var tags = Set(song.tags); tags.insert(n)
            setTagsRaw(Array(tags), forKey: song.id)
        }
        try? context.save()
        refreshTagNames()
        rebuildSongs()
    }

    /// Set the full tag list for a song (creates/updates its override).
    func setTags(_ tags: [String], for song: Song) {
        setTagsRaw(tags, forKey: song.id)
        saveAndRebuild()
    }

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

    private func refreshTagNames() {
        let tags = all(Tag.self)
        tagNames = tags.map(\.name).sorted()
        tagCategories = Dictionary(tags.map { ($0.name, $0.category) }, uniquingKeysWith: { a, _ in a })
    }

    /// Toggle the reserved "Star" tag on a song.
    func toggleStar(_ song: Song) {
        if song.tags.contains(Self.starTag) {
            setTags(song.tags.filter { $0 != Self.starTag }, for: song)
        } else {
            addTag(Self.starTag, toSongIDs: [song.id])
        }
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
        let tagSets = all(SongTagSet.self).map { BackupData.TagSetDTO(songKey: $0.songKey, tags: $0.tags) }
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

        let backup = BackupData(
            analyses: analyses, renames: renames, tagSets: tagSets, groups: groups,
            boundaries: boundaries, tags: tagNames, tagCategories: tagCategories, assetMap: assetMap
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(backup)) ?? Data()
    }

    struct ImportSummary { let songs: Int; let photos: Int; let relinked: Int; let fallback: Int }

    /// Replace the current database with a backup. Returns nil if the file is invalid.
    /// Photo references are relinked to this device via iCloud cloud-identifiers when possible.
    func importData(_ data: Data) -> ImportSummary? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let backup = try? decoder.decode(BackupData.self, from: data) else { return nil }

        // Build old-local → this-device-local remap from cloud identifiers.
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

        wipeSongData(includingTags: true)
        for a in backup.analyses {
            context.insert(PhotoAnalysis(assetLocalIdentifier: mapID(a.assetID), creationDate: a.creationDate,
                                         isMusicSheet: a.isMusicSheet, isSongStart: a.isSongStart,
                                         title: a.title, tags: a.tags, analyzedAt: a.analyzedAt))
        }
        for r in backup.renames { context.insert(SongRename(songKey: mapID(r.songKey), customTitle: r.customTitle)) }
        for t in backup.tagSets { context.insert(SongTagSet(songKey: mapID(t.songKey), tags: t.tags)) }
        for g in backup.groups { context.insert(PageGroup(assetID: mapID(g.assetID), groupKey: mapID(g.groupKey))) }
        for b in backup.boundaries ?? [] { context.insert(PageBoundary(assetID: mapID(b.assetID), isStart: b.isStart)) }
        for name in backup.tags {
            let category = backup.tagCategories?[name] ?? (Self.predefinedTagSet.contains(name) ? "genre" : "custom")
            context.insert(Tag(name: name, category: category))
        }
        refreshTagNames()
        saveAndRebuild()
        return ImportSummary(songs: songs.count, photos: assetMap.count, relinked: relinked, fallback: fallback)
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

    private func wipeSongData(includingTags: Bool) {
        try? context.delete(model: PhotoAnalysis.self)
        try? context.delete(model: SongRename.self)
        try? context.delete(model: SongTagSet.self)
        try? context.delete(model: PageGroup.self)
        try? context.delete(model: PageBoundary.self)
        if includingTags { try? context.delete(model: Tag.self) }
    }

    private func saveAndRebuild() {
        try? context.save()
        rebuildSongs()
    }
}
