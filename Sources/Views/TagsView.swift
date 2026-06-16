import SwiftUI

/// Unified tag view: add tags, see counts (bubbles), tap to filter, long-press to
/// tag songs / rename / delete, and drag bubbles between Genre and Custom.
/// Star and Deleted live in a fixed "Special" group (filter only).
struct TagsView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss
    @Binding var filter: Set<String>
    var onTagSongs: (String) -> Void

    @State private var newTag = ""
    @State private var renameTarget: String?
    @State private var renameText = ""

    private var genreTags: [String] {
        coordinator.tagNames.filter { !AnalysisCoordinator.specialTags.contains($0) && coordinator.tagCategories[$0] == "genre" }
    }
    private var customTags: [String] {
        coordinator.tagNames.filter { !AnalysisCoordinator.specialTags.contains($0) && coordinator.tagCategories[$0] != "genre" }
    }
    private var specialTags: [String] {
        coordinator.tagNames.filter { AnalysisCoordinator.specialTags.contains($0) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    TextField("New tag", text: $newTag).autocorrectionDisabled()
                    Button("Add") { withoutAnimation { coordinator.addVocabTag(newTag); newTag = "" } }
                        .disabled(newTag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
                Divider()

                ScrollView {
                    // When a filter is active, counts reflect co-occurrence with the
                    // selected tags and zero-count tags are hidden. Special tags
                    // (Star/Deleted) always show their global counts.
                    let active = !filter.isEmpty
                    let counts = active ? coordinator.tagSongCounts(matching: filter) : coordinator.tagSongCounts()
                    let globalCounts = coordinator.tagSongCounts()
                    VStack(alignment: .leading, spacing: 18) {
                        droppableGroup("Genre", tags: genreTags, category: "genre", counts: counts, hideZero: active)
                        droppableGroup("Custom", tags: customTags, category: "custom", counts: counts, hideZero: active)
                        if !specialTags.isEmpty { specialGroup(specialTags, counts: globalCounts) }
                    }
                    .padding()
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Clear filter") { withoutAnimation { filter.removeAll() } }.disabled(filter.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .alert("Rename tag", isPresented: Binding(
                get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } }
            )) {
                TextField("Tag name", text: $renameText)
                Button("Save") {
                    withoutAnimation { if let old = renameTarget { coordinator.renameTag(old, to: renameText) } }
                    renameTarget = nil
                }
                Button("Cancel", role: .cancel) { renameTarget = nil }
            } message: {
                Text("Renames this tag across all songs.")
            }
        }
    }

    // Genre / Custom — draggable bubbles, droppable area (drag a tag here to recategorize).
    private func droppableGroup(_ title: String, tags: [String], category: String, counts: [String: Int], hideZero: Bool) -> some View {
        // Hide tags that no longer co-occur with the active filter (keep selected ones).
        let visible = hideZero ? tags.filter { counts[$0, default: 0] > 0 || filter.contains($0) } : tags
        return VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.bold()).foregroundStyle(.secondary)
            FlowLayout(spacing: 8) {
                ForEach(visible, id: \.self) { tag in
                    bubble(tag, count: counts[tag, default: 0])
                        .draggable(tag)
                        .contextMenu {
                            Button { onTagSongs(tag) } label: { Label("Tag songs…", systemImage: "music.note.list") }
                            Button { renameTarget = tag; renameText = tag } label: { Label("Rename…", systemImage: "pencil") }
                            Button(role: .destructive) { withoutAnimation { coordinator.deleteVocabTag(tag) } } label: { Label("Delete tag", systemImage: "trash") }
                        }
                }
                if visible.isEmpty {
                    Text("Drag tags here").font(.caption).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(8)
            .background(Color(.secondarySystemBackground).opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .dropDestination(for: String.self) { items, _ in
                withoutAnimation { for name in items { coordinator.setTagCategory(name, to: category) } }
                return true
            } isTargeted: { hovering in
                // visual feedback handled by the system drop highlight
                _ = hovering
            }
        }
    }

    // Special — Star / Deleted, filter only (no drag, no edit).
    private func specialGroup(_ tags: [String], counts: [String: Int]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Special").font(.caption.bold()).foregroundStyle(.secondary)
            FlowLayout(spacing: 8) {
                ForEach(tags, id: \.self) { bubble($0, count: counts[$0, default: 0]) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func bubble(_ tag: String, count: Int) -> some View {
        let on = filter.contains(tag)
        return Button {
            withoutAnimation { if on { filter.remove(tag) } else { filter.insert(tag) } }
        } label: {
            Text("\(tag) (\(count))")
                .font(.subheadline)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(on ? Color.white : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
