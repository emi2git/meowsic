import SwiftUI

struct SongPagerView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.dismiss) private var dismiss
    let song: Song

    @State private var selection = 0
    @State private var showRename = false
    @State private var draftTitle = ""
    @State private var showTags = false
    @State private var showDelete = false

    private var isDeleted: Bool { song.tags.contains(AnalysisCoordinator.deletedTag) }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Array(song.pageAssetIDs.enumerated()), id: \.offset) { idx, id in
                AssetImageView(assetID: id, full: true)
                    .ignoresSafeArea(edges: .bottom)
                    .tag(idx)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .automatic))
        .onAppear { prefetch(after: 0) }
        .onChange(of: selection) { prefetch(after: selection) }
        .background(Color.black)
        .simultaneousGesture(
            DragGesture(minimumDistance: 30)
                .onEnded { value in
                    // Clear downward swipe → close the song (horizontal page swipes are unaffected).
                    if value.translation.height > 120,
                       value.translation.height > abs(value.translation.width) {
                        dismiss()
                    }
                }
        )
        .navigationTitle(song.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Tags") { showTags = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Rename") { draftTitle = song.title; showRename = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if selection > 0 {
                        Button {
                            coordinator.setBoundary(song.pageAssetIDs[selection], isStart: true); dismiss()
                        } label: { Label("Start new song from this page", systemImage: "scissors") }
                    }
                    Button {
                        coordinator.setBoundary(song.id, isStart: false); dismiss()
                    } label: { Label("Join previous song", systemImage: "arrow.triangle.merge") }
                    Button { coordinator.unmerge(song); dismiss() } label: {
                        Label("Unmerge pages", systemImage: "rectangle.split.2x1")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) { showDelete = true } label: { Image(systemName: "trash") }
            }
        }
        .sheet(isPresented: $showTags) { TagEditorView(song: song) }
        .confirmationDialog(isDeleted ? "Permanently delete “\(song.title)”?" : "Move “\(song.title)” to Deleted?",
                            isPresented: $showDelete, titleVisibility: .visible) {
            if isDeleted {
                Button("Restore") { coordinator.restore(song); dismiss() }
                Button("Delete song only", role: .destructive) { Task { await delete(deletePhotos: false) } }
                Button("Delete song and \(song.pageAssetIDs.count) photo\(song.pageAssetIDs.count == 1 ? "" : "s")",
                       role: .destructive) { Task { await delete(deletePhotos: true) } }
                Button("Cancel", role: .cancel) {}
            } else {
                Button("Move to Deleted", role: .destructive) { coordinator.softDelete(song); dismiss() }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            Text(isDeleted
                 ? "“Delete song only” removes it from Meowsic but keeps your photos. The other option also deletes the page photo(s) from Apple Photos."
                 : "This hides the song under the Deleted tag. Filter by Deleted to restore it or delete it for good.")
        }
        .alert("Rename song", isPresented: $showRename) {
            TextField("Title", text: $draftTitle)
            Button("Save") { coordinator.renameSong(song, to: draftTitle) }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// Pre-download the next couple of pages from iCloud so swiping forward is fast.
    private func prefetch(after index: Int) {
        for offset in 1...2 {
            let next = index + offset
            guard next < song.pageAssetIDs.count else { continue }
            let id = song.pageAssetIDs[next]
            Task { if let asset = library.asset(for: id) { _ = await library.fullImage(for: asset) } }
        }
    }

    private func delete(deletePhotos: Bool) async {
        if await coordinator.deleteSong(song, deletePhotos: deletePhotos) {
            dismiss()
        }
    }
}
