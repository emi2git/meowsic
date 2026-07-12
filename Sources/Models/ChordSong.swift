import Foundation
import SwiftData

/// A text-based chord chart (lyrics with inline chord names). Created via the
/// in-app "Add Chord" flow, not from the Photos pipeline. Always single-page.
@Model
final class ChordSong {
    @Attribute(.unique) var id: String   // UUID — also used as Song.id and SongRename/SongTagSet songKey.
    var title: String
    var artist: String?
    var chordText: String
    var sourceURL: String?
    var createdAt: Date

    init(id: String = UUID().uuidString, title: String, artist: String? = nil,
         chordText: String, sourceURL: String? = nil, createdAt: Date = .now) {
        self.id = id
        self.title = title
        self.artist = artist
        self.chordText = chordText
        self.sourceURL = sourceURL
        self.createdAt = createdAt
    }
}
