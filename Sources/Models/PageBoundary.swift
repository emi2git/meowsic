import Foundation
import SwiftData

/// Manual override of where a song begins, keyed by page asset id.
/// `isStart == true` forces a new song at this page; `false` joins it to the previous song.
@Model
final class PageBoundary {
    @Attribute(.unique) var assetID: String
    var isStart: Bool

    init(assetID: String, isStart: Bool) {
        self.assetID = assetID
        self.isStart = isStart
    }
}
