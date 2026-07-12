import Foundation

/// Column the song list can be sorted by.
enum SongSort: String, CaseIterable, Hashable, Codable {
    case title, type, date, pages

    var label: String {
        switch self {
        case .title: return "Title"
        case .type:  return "Type"
        case .date:  return "Date"
        case .pages: return "Pages"
        }
    }
}

/// One entry in the active sort stack: which column and which direction.
struct SortKey: Hashable, Codable {
    var column: SongSort
    var ascending: Bool
}

/// Pure filtering + multi-key sorting of the derived song list.
///
/// Tag filtering is **AND**: a song must carry *every* selected tag to show.
/// Sort keys are applied in priority order — the first non-equal comparison wins.
enum SongQuery {
    static func run(_ songs: [Song],
                    search: String,
                    tags: Set<String>,
                    sortKeys: [SortKey]) -> [Song] {
        var list = songs

        if !tags.contains(AnalysisCoordinator.deletedTag) {
            list = list.filter { !$0.isHidden }
        }
        if !search.isEmpty {
            let needle = foldedForSearch(search)
            list = list.filter { foldedForSearch($0.title).contains(needle) }
        }
        if !tags.isEmpty {
            list = list.filter { tags.isSubset(of: Set($0.tags)) }
        }

        let keys = sortKeys.isEmpty ? [SortKey(column: .date, ascending: false)] : sortKeys
        list.sort { a, b in
            for key in keys {
                let cmp = compare(a, b, by: key.column)
                if cmp != .orderedSame {
                    return key.ascending ? cmp == .orderedAscending : cmp == .orderedDescending
                }
            }
            return false
        }
        return list
    }

    /// Pairwise ordering for a single column. Used inside the multi-key sort.
    private static func compare(_ a: Song, _ b: Song, by column: SongSort) -> ComparisonResult {
        switch column {
        case .title:
            return a.title.localizedCaseInsensitiveCompare(b.title)
        case .type:
            // Stable order: sheet vs chord. Sheets ascend before chords alphabetically.
            return a.kind.rawValue.localizedCaseInsensitiveCompare(b.kind.rawValue)
        case .date:
            if a.firstPageDate == b.firstPageDate { return .orderedSame }
            return a.firstPageDate < b.firstPageDate ? .orderedAscending : .orderedDescending
        case .pages:
            if a.pageAssetIDs.count == b.pageAssetIDs.count { return .orderedSame }
            return a.pageAssetIDs.count < b.pageAssetIDs.count ? .orderedAscending : .orderedDescending
        }
    }

    private static func foldedForSearch(_ s: String) -> String {
        s.replacingOccurrences(of: "đ", with: "d")
         .replacingOccurrences(of: "Đ", with: "D")
         .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    }
}
