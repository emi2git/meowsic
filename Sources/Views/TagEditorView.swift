import SwiftUI

/// Edit the tags assigned to a single song, shown as tappable bubbles.
/// Toggle existing vocabulary tags or add a free-form custom tag.
struct TagEditorView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss

    let song: Song
    @State private var selected: Set<String>
    @State private var newTag = ""

    private let columns = [GridItem(.adaptive(minimum: 90), spacing: 8)]

    init(song: Song) {
        self.song = song
        _selected = State(initialValue: Set(song.tags))
    }

    /// Existing vocabulary tags matching what's typed (prefix matches first),
    /// excluding ones already on the song.
    private var suggestions: [String] {
        let q = newTag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return coordinator.tagNames
            .filter { !AnalysisCoordinator.specialTags.contains($0) && !selected.contains($0) && $0.lowercased().contains(q) }
            .sorted { a, b in
                let ap = a.lowercased().hasPrefix(q), bp = b.lowercased().hasPrefix(q)
                if ap != bp { return ap }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 8) {
                    HStack {
                        TextField("Add or search tags", text: $newTag)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .onSubmit { addTyped() }
                        Button("Add") { addTyped() }
                            .disabled(newTag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if !suggestions.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(suggestions, id: \.self) { tag in
                                    Button { withoutAnimation { selected.insert(tag); newTag = "" } } label: {
                                        Label(tag, systemImage: "plus.circle")
                                            .font(.subheadline)
                                            .padding(.horizontal, 10).padding(.vertical, 6)
                                            .background(Color(.secondarySystemBackground))
                                            .clipShape(Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                .padding()
                Divider()

                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                        ForEach(coordinator.tagNames.filter { !AnalysisCoordinator.specialTags.contains($0) }, id: \.self) { tag in
                            let on = selected.contains(tag)
                            Button {
                                withoutAnimation { if on { selected.remove(tag) } else { selected.insert(tag) } }
                            } label: {
                                Text(tag)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .frame(maxWidth: .infinity)
                                    .background(on ? Color.accentColor : Color(.secondarySystemBackground))
                                    .foregroundStyle(on ? Color.white : Color.primary)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding()
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        withoutAnimation { coordinator.setTags(selected.sorted(), for: song) }
                        dismiss()
                    }
                }
            }
        }
    }

    /// Apply the typed text: select an existing tag (case-insensitive) if one
    /// matches, otherwise create it in the vocabulary and select it.
    private func addTyped() {
        let t = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        withoutAnimation {
            if let existing = coordinator.tagNames.first(where: { $0.caseInsensitiveCompare(t) == .orderedSame }) {
                selected.insert(existing)
            } else {
                coordinator.addVocabTag(t)
                selected.insert(t)
            }
            newTag = ""
        }
    }
}
