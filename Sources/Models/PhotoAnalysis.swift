import Foundation
import SwiftData

/// Cached result of analyzing one photo. One row per asset → never re-analyzed.
@Model
final class PhotoAnalysis {
    @Attribute(.unique) var assetLocalIdentifier: String
    var creationDate: Date
    var isMusicSheet: Bool
    var isSongStart: Bool
    var title: String?
    var tags: [String] = []      // AI auto-tags (first page)
    var analyzedAt: Date

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
