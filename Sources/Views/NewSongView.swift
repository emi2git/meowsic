import SwiftUI

/// Review form shown before splitting a new song off a page. Pre-fills the
/// detected title and tags and lets the user edit them (remove a pre-filled tag,
/// add a new one) before tapping Create.
struct NewSongView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss

    let pageAssetID: String
    /// Called after the new song is created with its id (== pageAssetID), so the
    /// pager can auto-open it.
    var onCreated: (String) -> Void

    @State private var title = ""
    @State private var selected: Set<String> = []
    @State private var newTag = ""
    @State private var loaded = false
    @State private var titleSelectAllTrigger = 0

    private let columns = [GridItem(.adaptive(minimum: 90), spacing: 8)]

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        AssetImageView(assetID: pageAssetID, targetSize: CGSize(width: 600, height: 600))
                            .frame(maxWidth: .infinity)
                            .frame(height: 200)
                            .clipShape(RoundedRectangle(cornerRadius: 12))

                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 10) {
                                Text("Song name").font(.subheadline.bold())
                                Button { titleSelectAllTrigger += 1 } label: {
                                    Image(systemName: "highlighter").imageScale(.large)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Highlight all text")
                                Spacer()
                            }
                            SelectAllTextField(text: $title, placeholder: "Song name",
                                               autoSelectOnAppear: false,
                                               selectAllTrigger: titleSelectAllTrigger)
                                .frame(height: 24)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Tags").font(.subheadline.bold())
                            HStack {
                                TextField("Add a tag", text: $newTag).autocorrectionDisabled()
                                Button("Add") { addTag() }
                                    .disabled(newTag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            tagGrid
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("New song")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        coordinator.startNewSong(at: pageAssetID, title: trimmedTitle, tags: selected.sorted())
                        dismiss()
                        onCreated(pageAssetID)
                    }
                    .disabled(trimmedTitle.isEmpty)
                }
            }
            .onAppear {
                guard !loaded else { return }
                loaded = true
                let info = coordinator.detectedInfo(forPage: pageAssetID)
                title = info.title
                selected = Set(info.tags)
            }
        }
    }

    private var tagGrid: some View {
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
    }

    private func addTag() {
        let t = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        withoutAnimation {
            coordinator.addVocabTag(t)
            selected.insert(t)
            newTag = ""
        }
    }
}
