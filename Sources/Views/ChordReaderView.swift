import SwiftUI
import SwiftData

/// Full-screen reader for a chord song.
/// Layout rules:
/// - Horizontal swipe flips pages (`TabView` page style).
/// - Vertical swipe (up *or* down) dismisses back to the song list — there's
///   no inner scroll view, so the swipe gesture isn't ambiguous.
/// - Pages are sized to the screen (lines-per-page recomputed from font size
///   and screen height), so a page always fits without scrolling.
/// - Toolbar (top-right): transpose `-` / offset / `+` / Reset, then `A-` / `A+`
///   font controls, star toggle, and an overflow menu for rename / tags / edit /
///   delete. Font size is global and persisted across app launches.
/// - Transpose offset is persisted per-song.
struct ChordReaderView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.modelContext) private var modelContext
    let song: Song
    var onClose: () -> Void

    @AppStorage("meowsic.chord.fontSize") private var fontSize: Double = 15
    /// Reader-session tracking — recorded as a SongOpen row on dismiss if it
    /// lasted at least 10 seconds. `openedSongID` is captured at appear-time
    /// so dismiss after a song deletion can still record without crashing on
    /// the now-deleted @Model.
    @State private var openedAt: Date?
    @State private var openedSongID: String?

    @State private var isEditing = false
    @State private var draftTitle = ""
    @State private var draftArtist = ""
    @State private var draftText = ""
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showTags = false
    @State private var showDelete = false
    @State private var dragOffset: CGFloat = 0
    @State private var transposeOffset: Int = 0
    @State private var currentPage: Int = 0
    @State private var showTransposePopover = false

    private var displayedText: String {
        ChordTransposer.transpose(song.chordText ?? "", by: transposeOffset)
    }

    /// Lines-per-page heuristic. Leaves room for nav bar and a little bottom
    /// padding so the last line isn't clipped against the page-dots indicator.
    private func linesPerPage(height: CGFloat) -> Int {
        let lineHeight = fontSize * 1.35
        let usable = max(180, height - 88)
        return max(6, Int(usable / lineHeight))
    }

    private func pages(linesPerPage n: Int) -> [String] {
        let lines = displayedText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count > n else { return [displayedText] }
        var out: [String] = []
        var i = 0
        while i < lines.count {
            let end = min(lines.count, i + n)
            out.append(lines[i..<end].joined(separator: "\n"))
            i = end
        }
        return out
    }

    private var isHidden: Bool { song.isHidden }
    private var transposeKey: String { "meowsic.transpose.\(song.id)" }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let n = linesPerPage(height: geo.size.height)
                let chunks = pages(linesPerPage: n)
                TabView(selection: $currentPage) {
                    ForEach(Array(chunks.enumerated()), id: \.offset) { idx, chunk in
                        Text(chunk)
                            .font(.system(size: CGFloat(fontSize), design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .tag(idx)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: chunks.count > 1 ? .automatic : .never))
                .indexViewStyle(.page(backgroundDisplayMode: .always))
                .background(Color(.systemBackground))
                .onChange(of: chunks.count) { _, _ in
                    if currentPage >= chunks.count { currentPage = max(0, chunks.count - 1) }
                }
            }
            .navigationTitle(song.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $isEditing) {
                ChordEditSheet(title: $draftTitle, artist: $draftArtist, text: $draftText) {
                    coordinator.updateChordSong(id: song.id, title: draftTitle, artist: draftArtist, chordText: draftText)
                }
            }
            .sheet(isPresented: $showTags) {
                TagEditorView(song: song)
            }
            .alert("Rename song", isPresented: $showRename) {
                TextField("Title", text: $renameText)
                Button("Save") { coordinator.renameSong(song, to: renameText) }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Delete this chord?", isPresented: $showDelete) {
                Button("Delete", role: .destructive) {
                    coordinator.deleteChordSong(id: song.id)
                    close()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes this chord song from Meowsic. This can't be undone.")
            }
        }
        .offset(y: dragOffset)
        // Vertical swipe (either direction) dismisses back to the song list.
        // Horizontal swipes pass through to the TabView's page-flip gesture.
        .simultaneousGesture(verticalDismissGesture)
        .onAppear {
            transposeOffset = UserDefaults.standard.integer(forKey: transposeKey)
            openedAt = Date()
            openedSongID = song.id
        }
        .onDisappear { recordOpenIfQualified() }
        .onChange(of: transposeOffset) { _, new in
            UserDefaults.standard.set(new, forKey: transposeKey)
        }
    }

    private func recordOpenIfQualified() {
        guard let openedAt, let openedSongID else { return }
        self.openedAt = nil
        self.openedSongID = nil
        let closedAt = Date()
        guard closedAt.timeIntervalSince(openedAt) >= 10 else { return }
        modelContext.insert(SongOpen(songID: openedSongID, openedAt: openedAt, closedAt: closedAt))
        try? modelContext.save()
    }

    private var verticalDismissGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let h = value.translation.height
                let isVertical = abs(h) > abs(value.translation.width)
                if isVertical { dragOffset = h }
            }
            .onEnded { value in
                let h = value.predictedEndTranslation.height
                let isVertical = abs(h) > abs(value.predictedEndTranslation.width)
                if isVertical, abs(h) > 70 {
                    onClose()
                } else {
                    dragOffset = 0
                }
            }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { close() } label: { Image(systemName: "chevron.down") }
                .accessibilityLabel("Close")
        }
        // Top-right cluster, declared right-to-left so it reads left→right:
        // transpose group · A-/A+ · star · overflow menu.
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { renameText = song.title; showRename = true } label: { Label("Rename…", systemImage: "pencil") }
                Button { showTags = true } label: { Label("Tags…", systemImage: "tag") }
                Button {
                    draftTitle = song.title
                    draftArtist = song.artist ?? ""
                    draftText = song.chordText ?? ""
                    isEditing = true
                } label: { Label("Edit chord text…", systemImage: "square.and.pencil") }
                Divider()
                if isHidden {
                    Button { coordinator.restore(song) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                }
                Button(role: .destructive) { showDelete = true } label: { Label("Delete", systemImage: "trash") }
            } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("More")
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 6) {
                Button { fontSize = max(11, fontSize - 1) } label: {
                    Image(systemName: "textformat.size.smaller")
                }
                .accessibilityLabel("Smaller text")
                .disabled(fontSize <= 11)
                Button { fontSize = min(28, fontSize + 1) } label: {
                    Image(systemName: "textformat.size.larger")
                }
                .accessibilityLabel("Larger text")
                .disabled(fontSize >= 28)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showTransposePopover.toggle() } label: {
                HStack(spacing: 4) {
                    Text("Transpose")
                    if transposeOffset != 0 {
                        Text(transposeLabel)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .popover(isPresented: $showTransposePopover,
                     attachmentAnchor: .point(.bottom), arrowEdge: .top) {
                transposePopoverContent
            }
        }
    }

    /// Popover contents: a stepper (− / offset / +) on top, Reset button below.
    /// Stays open while the user steps, so multi-semitone shifts don't need
    /// repeated taps to reopen the menu.
    private var transposePopoverContent: some View {
        VStack(spacing: 12) {
            HStack(spacing: 16) {
                Button { adjustTranspose(-1) } label: {
                    Image(systemName: "minus.circle.fill").font(.title2)
                }
                .accessibilityLabel("Transpose down")
                .disabled(transposeOffset <= ChordTransposer.minOffset)
                Text(transposeLabel)
                    .font(.title3.bold())
                    .monospacedDigit()
                    .frame(minWidth: 44)
                Button { adjustTranspose(+1) } label: {
                    Image(systemName: "plus.circle.fill").font(.title2)
                }
                .accessibilityLabel("Transpose up")
                .disabled(transposeOffset >= ChordTransposer.maxOffset)
            }
            Button {
                transposeOffset = 0
            } label: {
                Text("Reset").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(transposeOffset == 0)
        }
        .padding(16)
        .frame(width: 220)
        .presentationCompactAdaptation(.popover)
    }

    private var transposeLabel: String {
        if transposeOffset == 0 { return "0" }
        return transposeOffset > 0 ? "+\(transposeOffset)" : "\(transposeOffset)"
    }

    private func adjustTranspose(_ delta: Int) {
        let next = transposeOffset + delta
        transposeOffset = min(ChordTransposer.maxOffset, max(ChordTransposer.minOffset, next))
    }

    private func close() { onClose() }
}

private struct ChordEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var title: String
    @Binding var artist: String
    @Binding var text: String
    var onSave: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") { TextField("Title", text: $title).autocorrectionDisabled() }
                Section("Artist (optional)") { TextField("Artist", text: $artist).autocorrectionDisabled() }
                Section("Chord text") {
                    TextEditor(text: $text)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 280)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            }
            .navigationTitle("Edit chord")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(); dismiss() }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
