import Foundation

/// Lays songs out into a print-ready page sequence, read as a book: page 0 is a
/// lone right-hand page (recto); facing spreads are then (1,2), (3,4)…
///
/// A multi-page song must begin on a left-hand page (an **odd** index) so its
/// first two pages face each other with no mid-song page turn. To hit that parity
/// the planner first tries to slot in a **single-page song** (which needs no
/// facing pair) and only inserts a **blank** when no single is available — so the
/// total number of blanks is minimized.
enum PrintPlanner {
    struct Entry {
        let assetID: String?     // nil → blank page
        let text: String
        var blank: Bool { assetID == nil }
    }

    static func plan(_ songs: [Song]) -> [Entry] {
        var singles = songs.filter { $0.pageAssetIDs.count == 1 }
        let multis = songs.filter { $0.pageAssetIDs.count >= 2 }

        var pages: [Entry] = []

        func append(_ song: Song) {
            for i in song.pageAssetIDs.indices {
                pages.append(Entry(assetID: song.pageAssetIDs[i], text: "\(song.title) — page \(i + 1)"))
            }
        }

        for song in multis {
            // Need the song to start on an odd (verso) index. If the next slot is
            // even (recto), fill it — with a single song if we have one, else a blank.
            if pages.count.isMultiple(of: 2) {
                if !singles.isEmpty {
                    append(singles.removeFirst())
                } else {
                    pages.append(Entry(assetID: nil, text: "(blank page)"))
                }
            }
            append(song)
        }

        // Leftover single-page songs pack two-per-spread at the end — no blanks.
        for song in singles { append(song) }
        return pages
    }
}
