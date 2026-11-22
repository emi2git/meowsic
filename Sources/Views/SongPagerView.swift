import SwiftUI
import SwiftData

/// Full-screen song viewer, shown as an overlay *over* the song list (not a nav
/// push) so closing reveals the real list behind it. Vertical swipe (or Close)
/// dismisses; horizontal swipes flip pages.
struct SongPagerView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.modelContext) private var modelContext
    let song: Song
    var onClose: () -> Void
    /// Asks the host (SongListView) to switch the pager to a different song by id.
    /// Used after "Start new song from this page" so we land in the new song
    /// instead of closing back to the list.
    var onOpenSong: (String) -> Void

    /// Set when the viewer opens; cleared after the SongOpen row is recorded
    /// on dismiss. A session is recorded only if it lasted >= 10 seconds.
    @State private var openedAt: Date?
    /// Captured at onAppear so onDisappear can record a SongOpen row even
    /// when the underlying Song @Model has been deleted (e.g. user hit
    /// "Delete song and photos") — accessing `song.id` post-delete crashes.
    @State private var openedSongID: String?

    @State private var selection = 0
    @State private var showRename = false
    @State private var draftTitle = ""
    @State private var renameSelectAllTrigger = 0
    @State private var showTags = false
    @State private var showDelete = false
    @State private var newSongPageID: String?
    @State private var dragOffset: CGFloat = 0
    @State private var pageDrag: CGFloat = 0
    @State private var axis: DragAxis?
    @State private var zoom: CGFloat = 1
    @State private var zoomStart: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var panStart: CGSize = .zero
    /// Pages shown side by side right now (mirrors the layout, for the toolbar).
    @State private var perScreen = 1

    private enum DragAxis { case horizontal, vertical }

    private var isHidden: Bool { song.isHidden }
    private var pageCount: Int { song.pageAssetIDs.count }

    /// A Mac's wide window shows a two-page spread; everywhere else one page.
    private func pagesPerScreen(_ size: CGSize) -> Int {
        #if targetEnvironment(macCatalyst)
        return pageCount > 1 && size.width > size.height ? 2 : 1
        #else
        return 1
        #endif
    }

    /// First page of the screen currently shown.
    private func screenStart(_ per: Int) -> Int { selection - selection % per }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let w = geo.size.width
                let per = pagesPerScreen(geo.size)
                let start = screenStart(per)
                let ids = song.pageAssetIDs
                ZStack {
                    Color.black
                    HStack(spacing: 0) {
                        ForEach(Array(stride(from: 0, to: ids.count, by: per)), id: \.self) { first in
                            HStack(spacing: 0) {
                                ForEach(first..<min(first + per, ids.count), id: \.self) { idx in
                                    AssetImageView(assetID: ids[idx], full: true)
                                        .frame(width: w / CGFloat(per), height: geo.size.height)
                                }
                            }
                            .frame(width: w, height: geo.size.height, alignment: .leading)
                            .scaleEffect(first == start ? zoom : 1)
                            .offset(first == start ? pan : .zero)
                        }
                    }
                    .frame(width: w, alignment: .leading)
                    .offset(x: -CGFloat(start / per) * w + pageDrag)
                }
                .contentShape(Rectangle())
                .gesture(dragGesture(width: w, height: geo.size.height, per: per))
                .simultaneousGesture(magnifyGesture(width: w, height: geo.size.height))
                .onTapGesture(count: 2) { resetZoom() }
                .overlay(alignment: .bottom) { pageDots(per: per) }
                .accessibilityElement()
                .accessibilityIdentifier("songPages")
                .accessibilityValue("Page \(start + 1) of \(pageCount)")
                .onChange(of: per, initial: true) { perScreen = per }
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle(song.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: Binding(
                get: { newSongPageID != nil },
                set: { if !$0 { newSongPageID = nil } }
            )) {
                if let id = newSongPageID {
                    NewSongView(pageAssetID: id) { newID in
                        newSongPageID = nil
                        onOpenSong(newID)
                    }
                }
            }
            .confirmationDialog(isHidden ? "Permanently delete “\(song.title)”?" : "Move “\(song.title)” to Deleted?",
                                isPresented: $showDelete, titleVisibility: .visible) {
                if isHidden {
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
                Text(isHidden
                     ? "“Delete song only” removes it from Meowsic but keeps your photos. The other option also deletes the page photo(s) from Apple Photos."
                     : "This hides the song under the Deleted tag. Filter by Deleted to restore it or delete it for good.")
            }
        }
        .offset(y: dragOffset)
        .onAppear {
            prefetch(after: 0)
            openedAt = Date()
            openedSongID = song.id
        }
        .onDisappear { recordOpenIfQualified() }
        .onChange(of: selection) { prefetch(after: selection); resetZoom() }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { Button("Close") { closeDown() } }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Tags") { showTags = true }
                .popover(isPresented: $showTags) {
                    TagEditorView(song: song)
                        .frame(minWidth: 380, minHeight: 460)
                }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Rename") { draftTitle = song.title; showRename = true }
                .popover(isPresented: $showRename) { renamePopover }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                let start = screenStart(perScreen)
                ForEach(start..<min(start + perScreen, pageCount), id: \.self) { idx in
                    if idx > 0 {
                        Button {
                            newSongPageID = song.pageAssetIDs[idx]
                        } label: {
                            Label(perScreen > 1 ? "Start new song from page \(idx + 1)" : "Start new song from this page",
                                  systemImage: "scissors")
                        }
                    }
                }
                Button {
                    coordinator.setBoundary(song.id, isStart: false); onClose()
                } label: { Label("Join previous song", systemImage: "arrow.triangle.merge") }
                Button { coordinator.unmerge(song); onClose() } label: {
                    Label("Unmerge pages", systemImage: "rectangle.split.2x1")
                }
            } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("More")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(role: .destructive) { showDelete = true } label: { Image(systemName: "trash") }
                .accessibilityLabel("Delete")
        }
    }

    /// Rename UI as a popover anchored under the Rename button. The text field
    /// auto-focuses with the whole title selected; the highlighter icon next
    /// to the heading re-selects the full text on demand.
    private var renamePopover: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("Rename song").font(.headline)
                Button { renameSelectAllTrigger += 1 } label: {
                    Image(systemName: "highlighter").imageScale(.large)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Highlight all text")
                Spacer()
            }
            SelectAllTextField(text: $draftTitle, placeholder: "Title",
                               selectAllTrigger: renameSelectAllTrigger,
                               onSubmit: { saveRename() })
                .frame(height: 24)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
            HStack {
                Spacer()
                Button("Cancel") { showRename = false }
                Button("Save") { saveRename() }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 320)
    }

    private func saveRename() {
        coordinator.renameSong(song, to: draftTitle)
        showRename = false
    }

    // MARK: - Paging

    /// One gesture flips pages (horizontal) and closes the song (vertical). The
    /// axis is locked on the first meaningful movement so the two never fight.
    private func dragGesture(width w: CGFloat, height h: CGFloat, per: Int) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                // Zoomed in: a one-finger drag pans the photo instead of paging/closing.
                if zoom > 1 {
                    pan = clampedPan(CGSize(width: panStart.width + value.translation.width,
                                            height: panStart.height + value.translation.height),
                                     width: w, height: h)
                    return
                }
                let t = value.translation
                if axis == nil, abs(t.width) + abs(t.height) > 6 {
                    axis = abs(t.height) > abs(t.width) ? .vertical : .horizontal
                }
                switch axis {
                case .horizontal:
                    var dx = t.width
                    let start = screenStart(per)
                    if (start == 0 && dx > 0) || (start + per >= pageCount && dx < 0) { dx *= 0.35 } // rubber-band at ends
                    pageDrag = dx
                case .vertical:
                    dragOffset = t.height
                case nil:
                    break
                }
            }
            .onEnded { value in
                if zoom > 1 { panStart = pan; return }
                let current = axis
                axis = nil
                switch current {
                case .horizontal:
                    let t = value.predictedEndTranslation.width   // honor flick velocity
                    let start = screenStart(per)
                    var next = start
                    if t < -w * 0.12 { next = min((pageCount - 1) / per * per, start + per) }
                    else if t > w * 0.12 { next = max(0, start - per) }
                    selection = next
                    pageDrag = 0
                case .vertical:
                    let h = value.predictedEndTranslation.height
                    if abs(h) > 80 {
                        onClose()
                    } else {
                        dragOffset = 0
                    }
                case nil:
                    break
                }
            }
    }

    /// Two-finger pinch zoom on the current page.
    private func magnifyGesture(width w: CGFloat, height h: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                zoom = min(5, max(1, zoomStart * value.magnification))
                pan = clampedPan(pan, width: w, height: h)
            }
            .onEnded { _ in
                if zoom <= 1.01 { resetZoom() }
                else { zoomStart = zoom; panStart = pan }
            }
    }

    /// Keep the panned image from drifting past its edges.
    private func clampedPan(_ p: CGSize, width w: CGFloat, height h: CGFloat) -> CGSize {
        let maxX = max(0, (zoom - 1) * w / 2)
        let maxY = max(0, (zoom - 1) * h / 2)
        return CGSize(width: min(maxX, max(-maxX, p.width)),
                      height: min(maxY, max(-maxY, p.height)))
    }

    private func resetZoom() {
        zoom = 1; zoomStart = 1; pan = .zero; panStart = .zero
    }

    private func pageDots(per: Int) -> some View {
        let start = screenStart(per)
        return HStack(spacing: 6) {
            ForEach(0..<pageCount, id: \.self) { i in
                Circle()
                    .fill(i >= start && i < start + per ? Color.white : Color.white.opacity(0.35))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 12)
        .background(.black.opacity(0.25), in: Capsule())
        .padding(.bottom, 10)
        .opacity(pageCount > 1 ? 1 : 0)
    }

    private func closeDown() { onClose() }

    /// Insert a SongOpen row when the viewer dismisses, but only if the
    /// session lasted at least 10 seconds — short open-and-close attempts
    /// don't count as views.
    private func recordOpenIfQualified() {
        guard let openedAt, let openedSongID else { return }
        self.openedAt = nil
        self.openedSongID = nil
        let closedAt = Date()
        guard closedAt.timeIntervalSince(openedAt) >= 10 else { return }
        modelContext.insert(SongOpen(songID: openedSongID, openedAt: openedAt, closedAt: closedAt))
        try? modelContext.save()
    }

    /// Pre-download the next couple of pages from iCloud so swiping forward is fast.
    private func prefetch(after index: Int) {
        for offset in 1...3 {
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

