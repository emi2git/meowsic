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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    TextField("New tag", text: $newTag).autocorrectionDisabled()
                    Button("Add") {
                        let t = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !t.isEmpty else { return }
                        coordinator.addVocabTag(t)
                        selected.insert(t)
                        newTag = ""
                    }
                    .disabled(newTag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
                Divider()

                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                        ForEach(coordinator.tagNames.filter { !AnalysisCoordinator.specialTags.contains($0) }, id: \.self) { tag in
                            let on = selected.contains(tag)
                            Button {
                                if on { selected.remove(tag) } else { selected.insert(tag) }
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
                        coordinator.setTags(selected.sorted(), for: song)
                        dismiss()
                    }
                }
            }
        }
    }
}
