import Foundation
import SwiftData

/// Per-song flags that aren't user-facing tags. Currently just `isHidden`
/// (soft-delete). Keyed by `songKey` (first-page asset id for sheets,
/// ChordSong.id for chords).
@Model
final class SongMeta {
    @Attribute(.unique) var songKey: String
    @Attribute(originalName: "isDeleted") var isHidden: Bool

    init(songKey: String, isHidden: Bool = false) {
        self.songKey = songKey
        self.isHidden = isHidden
    }
}
