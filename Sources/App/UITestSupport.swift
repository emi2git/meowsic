#if DEBUG
import Foundation
import Photos
import SwiftData

/// Launching with `-uitest` (the UI test suite does) runs the app on throwaway
/// data: an in-memory database seeded with a few songs of every kind, built
/// from whatever photos the simulator has. The suite also blanks the cloud-sync
/// settings on the command line, so a test run can never read or write the
/// real library or its cloud copy.
enum UITestSupport {
    static let isActive = ProcessInfo.processInfo.arguments.contains("-uitest")

    @MainActor
    static func seed(coordinator: AnalysisCoordinator, context: ModelContext) {
        // Sheets: three songs (3 pages, 1 page, 2 pages) from the first six photos.
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let photos = PHAsset.fetchAssets(with: .image, options: options)
        let plan: [(title: String, pages: Int)] = [("Test Waltz", 3), ("Solo Page", 1), ("Duet", 2)]
        var index = 0
        let start = Date(timeIntervalSince1970: 1_750_000_000)
        for (songNumber, song) in plan.enumerated() {
            for page in 0..<song.pages where index < photos.count {
                let date = start.addingTimeInterval(Double(songNumber) * 3600 + Double(page) * 5)
                context.insert(PhotoAnalysis(assetLocalIdentifier: photos.object(at: index).localIdentifier,
                                             creationDate: date, isMusicSheet: true, isSongStart: page == 0,
                                             title: page == 0 ? song.title : nil, analyzedAt: date))
                index += 1
            }
        }
        try? context.save()

        // Chords: one long enough to span several pages, plus fillers so the list paginates.
        let verse = "[G]Amazing [G7]grace how [C]sweet the [G]sound\nThat [G]saved a [Em]wretch like [D]me\n"
        coordinator.addChordSong(title: "Amazing Grace", artist: "Traditional",
                                 chordText: String(repeating: verse + "\n", count: 60),
                                 sourceURL: nil, initialTags: ["Folk"])
        for n in 1...45 {
            coordinator.addChordSong(title: String(format: "Filler Song %02d", n), artist: nil,
                                     chordText: "C  G  Am  F\nla la la", sourceURL: nil)
        }

        // Score: Emi Music Note output named by the test run, if any.
        if let path = ProcessInfo.processInfo.environment["MEOWSIC_UITEST_SCORE"] {
            _ = coordinator.importScoreFiles([URL(fileURLWithPath: path)])
        }
        coordinator.rebuildSongs()
    }
}
#endif
