import Foundation
import SwiftData

/// A user-supplied title override, keyed by the song's first-page asset id.
/// Stored separately so re-scans never clobber renames.
@Model
final class SongRename {
    @Attribute(.unique) var songKey: String
    var customTitle: String

    init(songKey: String, customTitle: String) {
        self.songKey = songKey
        self.customTitle = customTitle
    }
}
