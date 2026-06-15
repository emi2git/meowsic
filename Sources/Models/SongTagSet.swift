import Foundation
import SwiftData

/// The effective tags for a song, keyed by its first-page asset id.
/// Seeded from the AI's auto-tags, then fully user-editable; kept across rescans.
@Model
final class SongTagSet {
    @Attribute(.unique) var songKey: String
    var tags: [String]

    init(songKey: String, tags: [String]) {
        self.songKey = songKey
        self.tags = tags
    }
}
