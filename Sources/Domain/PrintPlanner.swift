import Foundation

/// Lays songs out into a print-ready page sequence, read as a book: page 0 is a
/// lone right-hand page (recto); facing spreads are then (1,2), (3,4)…
///
/// A multi-page song must begin on a left-hand page (an **odd** index) so its
/// first two pages face each other with no mid-song page turn. To hit that parity
/// the planner first tries to slot in a **single-page song** (which needs no
/// facing pair) and only inserts a **blank** when no single is available — so the
/// total number of blanks is minimized.
///
/// Chord songs (text, no photos) are paginated by line count: every block of up
/// to `chordLinesPerPage` lines becomes one chord entry. Single-page chord songs
/// act as parity fillers like single-page sheet songs.
enum PrintPlanner {
    static let chordLinesPerPage = 55

    struct Entry {
        let assetID: String?    // image page — full-res photo to draw
        let chordText: String?  // chord text page — drawn as monospaced text
        let text: String        // human-readable label for the preview list
        var blank: Bool { assetID == nil && chordText == nil }
    }

    /// One "item" = the full ordered page sequence for a single song (sheet or chord).
    private struct Item {
        let pages: [Entry]
        var isSingle: Bool { pages.count == 1 }
    }

    static func plan(_ songs: [Song]) -> [Entry] {
        let items: [Item] = songs.compactMap(Self.itemFor)
        var singles = items.filter(\.isSingle)
        let multis = items.filter { !$0.isSingle }

        var pages: [Entry] = []

        for item in multis {
            // Need the song to start on an odd (verso) index. If the next slot is
            // even (recto), fill it — with a single song if we have one, else a blank.
            if pages.count.isMultiple(of: 2) {
                if !singles.isEmpty {
                    pages.append(contentsOf: singles.removeFirst().pages)
                } else {
                    pages.append(Entry(assetID: nil, chordText: nil, text: "(blank page)"))
                }
            }
            pages.append(contentsOf: item.pages)
        }

        // Leftover single-page songs pack two-per-spread at the end — no blanks.
        for item in singles { pages.append(contentsOf: item.pages) }
        return pages
    }

    private static func itemFor(_ song: Song) -> Item? {
        switch song.kind {
        case .sheet:
            guard !song.pageAssetIDs.isEmpty else { return nil }
            let entries = song.pageAssetIDs.enumerated().map { i, id in
                Entry(assetID: id, chordText: nil, text: "\(song.title) — page \(i + 1)")
            }
            return Item(pages: entries)
        case .chord:
            let body = song.chordText ?? ""
            guard !body.isEmpty else { return nil }
            let lines = body.components(separatedBy: "\n")
            var entries: [Entry] = []
            var i = 0
            while i < lines.count {
                let end = min(i + chordLinesPerPage, lines.count)
                let chunk = lines[i..<end].joined(separator: "\n")
                let pageNum = entries.count + 1
                entries.append(Entry(assetID: nil, chordText: chunk,
                                     text: "\(song.title) — page \(pageNum)"))
                i = end
            }
            return Item(pages: entries)
        case .score:
            return nil   // notation is drawn live by the score reader; nothing to lay out here
        }
    }
}
