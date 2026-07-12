import Foundation
import SwiftData

/// Cached result of analyzing one photo. One row per asset → never re-analyzed.
/// `song` + `pageIndex` link each analyzed page to its parent Song row so
/// merge/unmerge/boundary edits eventually become direct relationship mutations
/// instead of indirect string-key writes (PageGroup / PageBoundary). For now
/// they're populated as a mirror by `AnalysisCoordinator.upsertSongs`.
@Model
final class PhotoAnalysis {
    @Attribute(.unique) var assetLocalIdentifier: String
    var creationDate: Date
    var isMusicSheet: Bool
    var isSongStart: Bool
    var title: String?
    var tags: [String] = []      // AI auto-tags (first page)
    var analyzedAt: Date
    /// 0-based ordinal of this page within its Song (denormalized for fast read).
    var pageIndex: Int = 0
    @Relationship var song: Song?

    init(assetLocalIdentifier: String, creationDate: Date,
         isMusicSheet: Bool, isSongStart: Bool, title: String?,
         tags: [String] = [], analyzedAt: Date) {
        self.assetLocalIdentifier = assetLocalIdentifier
        self.creationDate = creationDate
        self.isMusicSheet = isMusicSheet
        self.isSongStart = isSongStart
        self.title = title
        self.tags = tags
        self.analyzedAt = analyzedAt
    }
}
