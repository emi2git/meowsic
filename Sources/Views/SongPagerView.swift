import SwiftUI

/// Full-screen song viewer, shown as an overlay *over* the song list (not a nav
/// push) so closing slides the whole viewer away to reveal the real list behind
/// it — no black flash. Opens by sliding up; a vertical swipe (or Close) slides
/// it off in that direction; horizontal swipes flip pages quickly.
struct SongPagerView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library
    let song: Song
    var onClose: () -> Void

    @State private var selection = 0
    @State private var showRename = false
    @State private var draftTitle = ""
    @State private var showTags = false
    @State private var showDelete = false
    @State private var newSongPageID: String?
    @State private var dragOffset: CGFloat = offscreen   // starts off-screen → slides up to open
    @State private var pageDrag: CGFloat = 0
    @State private var axis: DragAxis?

    private static let offscreen: CGFloat = 1400
    private enum DragAxis { case horizontal, vertical }

    private var isDeleted: Bool { song.tags.contains(AnalysisCoordinator.deletedTag) }
    private var pageCount: Int { song.pageAssetIDs.count }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let w = geo.size.width
                ZStack {
                    Color.black
                    HStack(spacing: 0) {
                        ForEach(Array(song.pageAssetIDs.enumerated()), id: \.offset) { _, id in
                            AssetImageView(assetID: id, full: true)
                                .frame(width: w, height: geo.size.height)
                        }
                    }
                    .frame(width: w, alignment: .leading)
                    .offset(x: -CGFloat(selection) * w + pageDrag)
                }
                .contentShape(Rectangle())
                .gesture(dragGesture(width: w))
                .overlay(alignment: .bottom) { pageDots }
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle(song.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $showTags) { TagEditorView(song: song) }
            .sheet(isPresented: Binding(
                get: { newSongPageID != nil },
                set: { if !$0 { newSongPageID = nil } }
            )) {
                if let id = newSongPageID {
                    NewSongView(pageAssetID: id) { onClose() }
                }
            }
            .confirmationDialog(isDeleted ? "Permanently delete “\(song.title)”?" : "Move “\(song.title)” to Deleted?",
                                isPresented: $showDelete, titleVisibility: .visible) {
                if isDeleted {
                    Button("Restore") { coordinator.restore(song); onClose() }
                    Button("Delete song only", role: .destructive) { Task { await delete(deletePhotos: false) } }
                    Button("Delete song and \(song.pageAssetIDs.count) photo\(song.pageAssetIDs.count == 1 ? "" : "s")",
                           role: .destructive) { Task { await delete(deletePhotos: true) } }
                    Button("Cancel", role: .cancel) {}
                } else {
                    Button("Move to Deleted", role: .destructive) { coordinator.softDelete(song); onClose() }
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
        .offset(y: dragOffset)
        .onAppear {
            prefetch(after: 0)
            withAnimation(.easeOut(duration: 0.22)) { dragOffset = 0 }   // slide up to open
        }
        .onChange(of: selection) { prefetch(after: selection) }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { Button("Close") { closeDown() } }
        ToolbarItem(placement: .topBarTrailing) { Button("Tags") { showTags = true } }
        ToolbarItem(placement: .topBarTrailing) { Button("Rename") { draftTitle = song.title; showRename = true } }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if selection > 0 {
                    Button {
                        newSongPageID = song.pageAssetIDs[selection]
                    } label: { Label("Start new song from this page", systemImage: "scissors") }
                }
                Button {
                    coordinator.setBoundary(song.id, isStart: false); onClose()
                } label: { Label("Join previous song", systemImage: "arrow.triangle.merge") }
                Button { coordinator.unmerge(song); onClose() } label: {
                    Label("Unmerge pages", systemImage: "rectangle.split.2x1")
                }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(role: .destructive) { showDelete = true } label: { Image(systemName: "trash") }
        }
    }

    // MARK: - Paging

    /// One gesture flips pages (horizontal) and closes the song (vertical). The
    /// axis is locked on the first meaningful movement so the two never fight.
    private func dragGesture(width w: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                let t = value.translation
                if axis == nil, abs(t.width) + abs(t.height) > 10 {
                    axis = abs(t.height) > abs(t.width) ? .vertical : .horizontal
                }
                switch axis {
                case .horizontal:
                    var dx = t.width
                    if (selection == 0 && dx > 0) || (selection == pageCount - 1 && dx < 0) { dx *= 0.35 } // rubber-band at ends
                    pageDrag = dx
                case .vertical:
                    dragOffset = t.height
                case nil:
                    break
                }
            }
            .onEnded { value in
                let current = axis
                axis = nil
                switch current {
                case .horizontal:
                    let t = value.predictedEndTranslation.width   // honor flick velocity
                    var next = selection
                    if t < -w * 0.2 { next = min(pageCount - 1, selection + 1) }
                    else if t > w * 0.2 { next = max(0, selection - 1) }
                    withAnimation(.easeOut(duration: 0.16)) { selection = next; pageDrag = 0 }
                case .vertical:
                    let h = value.translation.height
                    if abs(h) > 120 {
                        withAnimation(.easeOut(duration: 0.14)) { dragOffset = h < 0 ? -Self.offscreen : Self.offscreen } completion: { onClose() }
                    } else {
                        withAnimation(.easeOut(duration: 0.16)) { dragOffset = 0 }   // snap back
                    }
                case nil:
                    break
                }
            }
    }

    private var pageDots: some View {
        HStack(spacing: 6) {
            ForEach(0..<pageCount, id: \.self) { i in
                Circle()
                    .fill(i == selection ? Color.white : Color.white.opacity(0.35))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 12)
        .background(.black.opacity(0.25), in: Capsule())
        .padding(.bottom, 10)
        .opacity(pageCount > 1 ? 1 : 0)
    }

    private func closeDown() {
        withAnimation(.easeOut(duration: 0.14)) { dragOffset = Self.offscreen } completion: { onClose() }
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
        if await coordinator.deleteSong(song, deletePhotos: deletePhotos) { onClose() }
    }
}
