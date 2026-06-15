import Foundation

/// Derived grouping — rebuilt from `PhotoAnalysis` on each launch/scan.
struct Song: Identifiable, Hashable {
    let id: String              // first-page asset id
    var title: String
    var pageAssetIDs: [String]  // ordered by capture time
    var firstPageDate: Date
    var tags: [String] = []
}
