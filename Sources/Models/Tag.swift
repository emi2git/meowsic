import Foundation
import SwiftData

/// A tag in the user's vocabulary. The AI tags new songs using only these.
/// `isSystem` flags Sheet/Chord (reserved, can't be deleted/renamed). All other
/// tags are user-managed. The `songs` inverse drives O(1) tag-count and rename.
@Model
final class Tag {
    @Attribute(.unique) var name: String
    var isSystem: Bool = false
    /// Legacy: "genre" | "custom". Kept during transition; consumers should use
    /// `isSystem` instead. Will be dropped in a later cleanup with VersionedSchema.
    var category: String = "custom"

    @Relationship(inverse: \Song.tagLinks)
    var songs: [Song] = []

    init(name: String, isSystem: Bool = false, category: String = "custom") {
        self.name = name
        self.isSystem = isSystem
        self.category = category
    }
}
