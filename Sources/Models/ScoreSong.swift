import Foundation
import SwiftData

/// A notated score imported from Emi Music Note's output: the MusicXML that is
/// drawn as notation, plus the matching MIDI for playback when there is one.
@Model
final class ScoreSong {
    @Attribute(.unique) var id: String   // UUID — also used as Song.id.
    var title: String
    /// MusicXML text, zlib-compressed (it shrinks ~20x, which keeps cloud snapshots small).
    @Attribute(.externalStorage) var xml: Data
    @Attribute(.externalStorage) var midi: Data?
    var createdAt: Date

    init(id: String = UUID().uuidString, title: String, xml: Data, midi: Data? = nil, createdAt: Date = .now) {
        self.id = id
        self.title = title
        self.xml = xml
        self.midi = midi
        self.createdAt = createdAt
    }

    static func pack(_ musicXML: String) -> Data {
        let raw = Data(musicXML.utf8)
        return ((try? (raw as NSData).compressed(using: .zlib)) as Data?) ?? raw
    }

    var musicXML: String {
        let raw = ((try? (xml as NSData).decompressed(using: .zlib)) as Data?) ?? xml
        return String(decoding: raw, as: UTF8.self)
    }
}
