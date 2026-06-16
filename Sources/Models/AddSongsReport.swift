import Foundation

/// Summary of one "Add Songs" run, shown to the user when it finishes.
struct AddSongsReport {
    enum IgnoreReason: String, CaseIterable {
        case alreadyAdded = "Already in your library"
        case noImage      = "Couldn't load the photo"
    }

    struct Ignored: Identifiable {
        let assetID: String
        let reason: IgnoreReason
        var id: String { assetID }
    }

    var selected: Int
    var songsCreated = 0
    var sheetsAdded = 0       // photos that became song pages
    var stopped = false       // true if the user hit Stop mid-run
    var ignored: [Ignored] = []
}
