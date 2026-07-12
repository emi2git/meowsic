import Foundation
import SwiftData

/// One row per viewer session that lasted at least 10 seconds. Captured by
/// SongPagerView (sheet) and ChordReaderView (chord) on dismiss. Provides the
/// raw data for "last opened" / "most played" / total practice time queries.
@Model
final class SongOpen {
    var songID: String
    var openedAt: Date
    var closedAt: Date

    init(songID: String, openedAt: Date, closedAt: Date) {
        self.songID = songID
        self.openedAt = openedAt
        self.closedAt = closedAt
    }
}
