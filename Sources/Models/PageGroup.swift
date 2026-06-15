import Foundation
import SwiftData

/// Marks a page (by asset id) as belonging to a merged song identified by
/// `groupKey` (the earliest page's asset id). Lets users merge songs while
/// keeping grouping derivable and rescan-safe.
@Model
final class PageGroup {
    @Attribute(.unique) var assetID: String
    var groupKey: String

    init(assetID: String, groupKey: String) {
        self.assetID = assetID
        self.groupKey = groupKey
    }
}
