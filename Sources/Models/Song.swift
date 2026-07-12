import Foundation
import SwiftData

enum SongKind: String, Hashable, Codable { case sheet, chord }

/// Persisted song row — the single source of truth the UI reads via @Query.
/// Materialized by `AnalysisCoordinator.rebuildSongs()` from the underlying
/// PhotoAnalysis / SongRename / SongTagSet / SongMeta / PageGroup / PageBoundary
/// / ChordSong source tables. Mutations to those source tables trigger an
/// incremental upsert here so per-row SwiftUI observation works.
@Model
final class Song {
    @Attribute(.unique) var id: String     // sheet: first-page asset id. chord: ChordSong.id (UUID).
    var kindRaw: String                    // SongKind.rawValue ("sheet" | "chord")
    var title: String
    /// True iff `title` is a user rename (replaces the SongRename table).
    /// Mirrored from `SongRename` rows during migration; rewritten by `renameSong`.
    var titleIsCustom: Bool = false
    var pageAssetIDs: [String]             // sheet: ordered by capture time. chord: [].
    var firstPageDate: Date                // sheet: first page date. chord: createdAt.
    /// Display mirror of `tagLinks.map(\.name)` plus synthesized markers
    /// (Sheet/Chord, Deleted). Read by views for chip display. Authoritative
    /// state lives in `tagLinks`; this is rewritten by `upsertSongs`.
    var tags: [String]
    /// Authoritative many-to-many to Tag. Mutated directly by tag operations
    /// so per-row SwiftUI observation invalidates only the affected row.
    @Relationship var tagLinks: [Tag] = []
    /// Pages that belong to this song, kept in sync with `pageAssetIDs` by
    /// `upsertSongs`. Inverse of `PhotoAnalysis.song`.
    @Relationship(inverse: \PhotoAnalysis.song) var pages: [PhotoAnalysis] = []
    var chordText: String?
    var artist: String?
    /// Soft-deleted flag. Named `isHidden` to avoid collision with
    /// `PersistentModel.isDeleted` (which has unrelated context-pending-delete
    /// semantics and silently shadows custom `isDeleted` properties).
    /// `@Attribute(originalName:)` migrates existing on-device data whose
    /// column was named `isDeleted` in earlier builds of this same schema.
    @Attribute(originalName: "isDeleted") var isHidden: Bool

    var kind: SongKind {
        get { SongKind(rawValue: kindRaw) ?? .sheet }
        set { kindRaw = newValue.rawValue }
    }

    init(id: String, title: String, pageAssetIDs: [String], firstPageDate: Date,
         tags: [String] = [], kind: SongKind = .sheet,
         chordText: String? = nil, artist: String? = nil, isHidden: Bool = false) {
        self.id = id
        self.kindRaw = kind.rawValue
        self.title = title
        self.pageAssetIDs = pageAssetIDs
        self.firstPageDate = firstPageDate
        self.tags = tags
        self.chordText = chordText
        self.artist = artist
        self.isHidden = isHidden
    }
}

/// Pure value type the GroupingEngine emits. The coordinator diffs these
/// against existing @Model Song rows and upserts.
struct SongDerivation: Equatable {
    let id: String
    let title: String
    let titleIsCustom: Bool
    let pageAssetIDs: [String]
    let firstPageDate: Date
    let tags: [String]
    let kind: SongKind
    let chordText: String?
    let artist: String?
    let isHidden: Bool
}

extension String {
    /// Title Case: first letter of each word capitalized, the rest lowercased —
    /// applied to every song title regardless of how it's written/typed.
    var titleCased: String {
        split(separator: " ", omittingEmptySubsequences: true).map { word -> String in
            guard let i = word.firstIndex(where: { $0.isLetter }) else { return String(word) }
            return word[..<i] + word[i].uppercased() + word[word.index(after: i)...].lowercased()
        }.joined(separator: " ")
    }
}
