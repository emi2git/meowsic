import Foundation
import SwiftData

/// A tag in the user's vocabulary. The AI tags new songs using only these.
@Model
final class Tag {
    @Attribute(.unique) var name: String
    var category: String = "custom"   // "genre" | "custom" (Star/Deleted are treated as Special by name)

    init(name: String, category: String = "custom") {
        self.name = name
        self.category = category
    }
}
