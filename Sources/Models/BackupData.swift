import Foundation

/// Codable snapshot of the database for export/import.
/// `assetMap` carries each referenced photo's iCloud cloud-identifier so a backup
/// can relink to the right photos on another device sharing the same iCloud library.
struct BackupData: Codable {
    struct AnalysisDTO: Codable {
        var assetID: String
        var creationDate: Date
        var isMusicSheet: Bool
        var isSongStart: Bool
        var title: String?
        var tags: [String]
        var analyzedAt: Date
    }
    struct RenameDTO: Codable { var songKey: String; var customTitle: String }
    struct TagSetDTO: Codable { var songKey: String; var tags: [String] }
    struct GroupDTO: Codable { var assetID: String; var groupKey: String }
    struct BoundaryDTO: Codable { var assetID: String; var isStart: Bool }
    struct MetaDTO: Codable {
        var songKey: String
        var isHidden: Bool
        // JSON key stays `isDeleted` for backward compat with existing cloud snapshots.
        enum CodingKeys: String, CodingKey { case songKey; case isHidden = "isDeleted" }
    }
    struct ChordSongDTO: Codable {
        var id: String
        var title: String
        var artist: String?
        var chordText: String
        var sourceURL: String?
        var createdAt: Date
    }
    struct ScoreSongDTO: Codable {
        var id: String
        var title: String
        var xml: Data        // zlib-compressed MusicXML, as stored
        var midi: Data?
        var createdAt: Date
    }
    /// local asset id ↔ stable iCloud cloud-identifier (cloud nil if not in iCloud).
    struct AssetRef: Codable { var local: String; var cloud: String? }

    var analyses: [AnalysisDTO]
    var renames: [RenameDTO]
    var tagSets: [TagSetDTO]
    var groups: [GroupDTO]
    var boundaries: [BoundaryDTO]?
    var tags: [String]
    var tagCategories: [String: String]?
    var assetMap: [AssetRef]?
    var chordSongs: [ChordSongDTO]?
    var metas: [MetaDTO]?
    var scoreSongs: [ScoreSongDTO]?
}
