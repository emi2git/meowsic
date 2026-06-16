import Foundation

/// Column the song list is sorted by.
enum SongSort { case title, date, pages }

/// Pure filtering + sorting of the derived song list, shared by the UI and
/// testable in isolation.
///
/// Tag filtering is **AND**: a song must carry *every* selected tag to show.
enum SongQuery {
    static func run(_ songs: [Song],
                    search: String,
                    tags: Set<String>,
                    sort: SongSort,
                    ascending: Bool) -> [Song] {
        var list = songs

        // Hide soft-deleted songs unless the user is explicitly filtering on Deleted.
        if !tags.contains(AnalysisCoordinator.deletedTag) {
            list = list.filter { !$0.tags.contains(AnalysisCoordinator.deletedTag) }
        }
        if !search.isEmpty {
            // Diacritic- and case-insensitive: typing plain ASCII ("thuong")
            // matches accented titles ("Thương").
            let needle = foldedForSearch(search)
            list = list.filter { foldedForSearch($0.title).contains(needle) }
        }
        if !tags.isEmpty {
            list = list.filter { tags.isSubset(of: Set($0.tags)) }
        }

        switch sort {
        case .title: list.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .date:  list.sort { $0.firstPageDate < $1.firstPageDate }
        case .pages: list.sort { $0.pageAssetIDs.count < $1.pageAssetIDs.count }
        }
        if !ascending { list.reverse() }
        return list
    }

    /// Lowercase and strip diacritics for accent-insensitive matching. `đ/Đ`
    /// (a Vietnamese letter, not a combining diacritic) is mapped to `d` first.
    private static func foldedForSearch(_ s: String) -> String {
        s.replacingOccurrences(of: "đ", with: "d")
         .replacingOccurrences(of: "Đ", with: "D")
         .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    }
}
