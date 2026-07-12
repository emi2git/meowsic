import SwiftUI
import SwiftData
import Photos

struct SongListView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.modelContext) private var modelContext
    /// All non-deleted Song rows, sorted by capture date desc. Per-row mutations
    /// (tag toggle, rename) invalidate only the affected ForEach row instead of
    /// the whole tree.
    @Query(filter: #Predicate<Song> { !$0.isHidden },
           sort: \Song.firstPageDate, order: .reverse)
    private var activeSongs: [Song]
    /// All deleted Song rows, fetched separately so the "Deleted" tag filter can
    /// expose them on demand without widening the main query.
    @Query(filter: #Predicate<Song> { $0.isHidden },
           sort: \Song.firstPageDate, order: .reverse)
    private var deletedSongs: [Song]

    @State private var showSettings = false
    @State private var showPrint = false
    @State private var showTags = false
    @State private var showAddChord = false

    @State private var searchText = ""
    @State private var sortKey: SortKey = SortKey(column: .date, ascending: false)
    @State private var filterTags: Set<String> = []
    @State private var currentPage = 0

    @State private var selecting = false              // multi-select mode
    @State private var selectedSongIDs: Set<String> = []
    @State private var showAddTags = false
    @State private var showRemoveTags = false
    @State private var tagPickerSelection: Set<String> = []
    @State private var showDeleteKeepConfirm = false
    @State private var showDeletePhotosConfirm = false
    @State private var deleteConfirmText = ""
    @State private var addTask: Task<Void, Never>?
    @State private var autoScanTask: Task<Void, Never>?
    @State private var autoScanResult: [PHAsset]?     // non-nil → show the confirm alert
    @State private var showPicker = false
    @State private var openSong: Song?                // non-nil → song viewer overlay

    private let dateWidth: CGFloat = 92
    private let pagesWidth: CGFloat = 52
    private let typeWidth: CGFloat = 60
    private let tagsWidth: CGFloat = 200
    private let pagerHeight: CGFloat = 44
    private let maxVisibleTags = 2

    // Taller two-line rows on the iPhone; compact single-line columns on the iPad.
    private var rowHeight: CGFloat { hSize == .compact ? 60 : 44 }

    private var displayedSongs: [Song] {
        let base = filterTags.contains(AnalysisCoordinator.deletedTag)
            ? (activeSongs + deletedSongs) : activeSongs
        return SongQuery.run(base, search: searchText, tags: filterTags,
                             sortKeys: [sortKey])
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if coordinator.isScanning { scanningBar }
                else if coordinator.isAutoScanning { autoScanBar }
                // On iPhone (compact) the search field lives inline above the list
                // because the toolbar can't fit it alongside the trailing menus.
                // On iPad it sits in the toolbar's principal slot (see toolbarContent).
                if !selecting, hSize == .compact {
                    searchField
                        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
                }
                headerRow
                Divider()

                GeometryReader { geo in
                    let songs = displayedSongs
                    if songs.isEmpty {
                        emptyState.frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        let pageSize = max(1, Int((geo.size.height - pagerHeight) / rowHeight))
                        let totalPages = max(1, Int(ceil(Double(songs.count) / Double(pageSize))))
                        let page = min(currentPage, totalPages - 1)
                        let start = page * pageSize
                        let slice = Array(songs[start ..< min(start + pageSize, songs.count)])

                        VStack(spacing: 0) {
                            ForEach(slice) { song in
                                rowItem(song)
                                Divider()
                            }
                            Spacer(minLength: 0)
                            if totalPages > 1 { Divider(); pager(total: totalPages, current: page) }
                        }
                        .contentShape(Rectangle())
                        .highPriorityGesture(
                            DragGesture(minimumDistance: 20)
                                .onEnded { value in
                                    let dx = value.predictedEndTranslation.width
                                    let dy = value.predictedEndTranslation.height
                                    guard abs(dx) > abs(dy), abs(dx) > 25 else { return }
                                    if dx < 0 { currentPage = min(totalPages - 1, page + 1) }
                                    else { currentPage = max(0, page - 1) }
                                }
                        )
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.immediately)
            .onChange(of: searchText) { currentPage = 0 }
            .onChange(of: filterTags) { currentPage = 0 }
            .onChange(of: sortKey) { currentPage = 0 }
            .toolbar { toolbarContent }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showPrint) {
                PrintView(songs: (activeSongs + deletedSongs).filter { selectedSongIDs.contains($0.id) })
            }
            .popover(isPresented: $showTags, attachmentAnchor: .point(.topLeading), arrowEdge: .top) {
                TagsView(filter: $filterTags)
                    .frame(minWidth: 360, idealWidth: 420, minHeight: 520, idealHeight: 640)
                    .presentationCompactAdaptation(.popover)
            }
            .sheet(isPresented: $showAddChord) {
                ChordAddView(onOpenExisting: { chord in
                    // Find the grouped Song wrapping this chord (Song.id ==
                    // ChordSong.id for chord-kind rows) and present its reader.
                    if let song = coordinator.songs.first(where: { $0.kind == .chord && $0.id == chord.id }) {
                        openSong = song
                    }
                })
                .environment(coordinator)
            }
            .modifier(SelectionActionsModifier(
                count: selectedSongIDs.count,
                addableTags: addableTags, removableTags: removableTags,
                tagPickerSelection: $tagPickerSelection,
                showAddTags: $showAddTags, showRemoveTags: $showRemoveTags,
                showDeleteKeepConfirm: $showDeleteKeepConfirm,
                showDeletePhotosConfirm: $showDeletePhotosConfirm,
                deleteConfirmText: $deleteConfirmText,
                onAddTags: applyAddTags, onRemoveTags: applyRemoveTags,
                onDeleteKeep: { performDelete(deletePhotos: false) },
                onDeletePhotos: { performDelete(deletePhotos: true) }))
            .sheet(isPresented: $showPicker) {
                PhotoPicker { assets in
                    showPicker = false
                    runAddSongs(assets)
                }
                .ignoresSafeArea()
            }
            .sheet(isPresented: Binding(
                get: { coordinator.lastReport != nil },
                set: { if !$0 { coordinator.lastReport = nil } }
            )) {
                if let report = coordinator.lastReport { AddSongsReportView(report: report) }
            }
            .alert("Auto Scan", isPresented: Binding(
                get: { autoScanResult != nil },
                set: { if !$0 { autoScanResult = nil } }
            )) {
                let count = autoScanResult?.count ?? 0
                if count > 0 {
                    Button("Cancel", role: .cancel) { autoScanResult = nil }
                    Button("Continue") {
                        let assets = autoScanResult ?? []
                        autoScanResult = nil
                        runAddSongs(assets)
                    }
                } else {
                    Button("OK", role: .cancel) { autoScanResult = nil }
                }
            } message: {
                let count = autoScanResult?.count ?? 0
                if count > 0 {
                    Text("Found \(count) new photo\(count == 1 ? "" : "s") (newest first, stopping at the first photo already in your library). Add them?")
                } else {
                    Text("No new photos found — the newest photo in your library is already added.")
                }
            }
        }
        .overlay {
            if let openSong {
                if openSong.kind == .chord {
                    ChordReaderView(song: openSong) { self.openSong = nil }
                        .ignoresSafeArea()
                } else {
                    SongPagerView(
                        song: openSong,
                        onClose: { self.openSong = nil },
                        onOpenSong: { newID in loadAndOpenSong(byID: newID) }
                    )
                    .id(openSong.id)
                    .ignoresSafeArea()
                }
            }
        }
    }

    /// Swap the pager to the song whose key is `id`. Used right after
    /// `startNewSong` to land the user inside the freshly-split song.
    /// Fetches via modelContext directly so the lookup doesn't depend on @Query
    /// having refreshed yet.
    private func loadAndOpenSong(byID id: String) {
        var descriptor = FetchDescriptor<Song>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        openSong = try? modelContext.fetch(descriptor).first
    }

    // MARK: - Toolbar

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search song name", text: $searchText)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(minWidth: 180, idealWidth: 280, maxWidth: 360)
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color(.tertiarySystemFill), in: Capsule())
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 14) {
                    Button("Cancel") { exitSelection() }
                    Button("Select all") { selectedSongIDs = Set(displayedSongs.map(\.id)) }
                }
            }
            ToolbarItem(placement: .principal) {
                Text(selectedSongIDs.isEmpty ? "Select songs" : "\(selectedSongIDs.count) selected")
                    .font(.headline)
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 14) {
                    Menu {
                        Button { tagPickerSelection = []; showAddTags = true } label: { Label("Add tags…", systemImage: "tag") }
                        Button { tagPickerSelection = []; showRemoveTags = true } label: { Label("Delete tags…", systemImage: "tag.slash") }
                    } label: {
                        Text("Tags…")
                    }
                    .disabled(selectedSongIDs.isEmpty)

                    Button { showPrint = true } label: { Image(systemName: "printer") }
                        .disabled(selectedSongIDs.isEmpty)

                    Menu {
                        Button(role: .destructive) {
                            coordinator.softDeleteMany(ids: selectedSongIDs)
                            exitSelection()
                        } label: { Label("Move to Deleted", systemImage: "trash") }
                        Divider()
                        Button(role: .destructive) { showDeleteKeepConfirm = true } label: {
                            Label("Permanently delete (keep photos)", systemImage: "trash.slash")
                        }
                        Button(role: .destructive) { deleteConfirmText = ""; showDeletePhotosConfirm = true } label: {
                            Label("Permanently delete and remove photos", systemImage: "trash.fill")
                        }
                    } label: {
                        Text("Actions").fontWeight(.semibold)
                    }
                    .disabled(selectedSongIDs.isEmpty)
                }
            }
        } else {
            // Force order: select (leftmost) → tag → reset.
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 14) {
                    Button { startSelection() } label: { Image(systemName: "checkmark.circle") }
                    Button {
                        var t = Transaction(); t.disablesAnimations = true
                        withTransaction(t) { showTags = true }
                    } label: {
                        Image(systemName: filterTags.isEmpty ? "tag" : "tag.fill")
                    }
                    Button { resetView() } label: { Image(systemName: "arrow.counterclockwise") }
                        .disabled(!viewModified)
                }
            }
            if hSize == .regular {
                ToolbarItem(placement: .principal) { searchField }
            }
            // Two top-level actions: Add Sheet (menu) and Add Chord (direct).
            // On iPhone (compact) we drop the labels so the trailing menus fit.
            ToolbarItem(placement: .topBarTrailing) {
                if coordinator.isScanning {
                    Button("Stop", role: .destructive) { addTask?.cancel() }
                } else if coordinator.isAutoScanning {
                    Button("Stop", role: .destructive) { autoScanTask?.cancel() }
                } else {
                    Menu {
                        Button { startAddSongs() } label: { Label("Pick photos…", systemImage: "photo.on.rectangle") }
                        Button { startAutoScan() } label: { Label("Auto Scan", systemImage: "sparkles") }
                    } label: {
                        // Explicit HStack — `Label(...).labelStyle(.titleAndIcon)`
                        // collapses to icon-only inside a toolbar Menu on iPad.
                        HStack(spacing: 4) {
                            Image(systemName: "photo.badge.plus")
                            if hSize != .compact { Text("Add Sheet") }
                        }
                    }
                }
            }
            if !coordinator.isScanning && !coordinator.isAutoScanning {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAddChord = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "music.note")
                            if hSize != .compact { Text("Add Chord") }
                        }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
        }
    }

    /// Tags offered when adding: the whole vocabulary except special tags.
    private var addableTags: [String] {
        coordinator.tagNames.filter { !AnalysisCoordinator.specialTags.contains($0) }
    }

    /// Tags offered when removing: only those actually present on the selection.
    private var removableTags: [String] {
        let present = coordinator.songs
            .filter { selectedSongIDs.contains($0.id) }
            .flatMap { $0.tags }
        return Array(Set(present).subtracting(AnalysisCoordinator.specialTags)).sorted()
    }

    private var viewModified: Bool {
        !filterTags.isEmpty || !searchText.isEmpty || sortKey != SortKey(column: .date, ascending: false)
    }

    private func resetView() {
        withoutAnimation {
            filterTags.removeAll()
            searchText = ""
            sortKey = SortKey(column: .date, ascending: false)
            currentPage = 0
        }
    }

    // MARK: - Sections

    private var scanningBar: some View {
        let total = max(coordinator.progressTotal, 1)
        let pct = Int(Double(coordinator.progressDone) / Double(total) * 100)
        return VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: Double(coordinator.progressDone), total: Double(total)) {
                Text("Adding songs \(coordinator.progressDone)/\(coordinator.progressTotal) (\(pct)%)")
            }
            if let status = coordinator.scanStatus {
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text("\(coordinator.sheetsFound) sheet\(coordinator.sheetsFound == 1 ? "" : "s") detected")
                if let date = coordinator.lastItemDate {
                    Text("· last: \(date.formatted(date: .abbreviated, time: .shortened))")
                }
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private var autoScanBar: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(coordinator.scanStatus ?? "Scanning library…")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    @ViewBuilder private var emptyState: some View {
        if coordinator.songs.isEmpty {
            ContentUnavailableView("No songs yet", systemImage: "music.note.list",
                                   description: Text("Tap Add Songs to pick sheet-music photos."))
        } else {
            ContentUnavailableView("No matches", systemImage: "magnifyingglass",
                                   description: Text("No songs match your search or tag filter."))
        }
    }

    @ViewBuilder private var headerRow: some View {
        if hSize == .compact { compactSortBar } else { regularHeaderRow }
    }

    private var regularHeaderRow: some View {
        HStack(spacing: 8) {
            Spacer().frame(width: 28)   // matches the leading control slot in each row
            sortHeader("Title", .title).frame(maxWidth: .infinity, alignment: .leading)
            sortHeader("Type", .type).frame(width: typeWidth, alignment: .leading)
            Text("Tags").frame(width: tagsWidth, alignment: .leading)
            sortHeader("Date", .date).frame(width: dateWidth, alignment: .leading)
            sortHeader("Pages", .pages).frame(width: pagesWidth, alignment: .trailing)
        }
        .font(.caption.bold())
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    // iPhone: there's no room for column headers — show a count + a sort menu.
    private var compactSortBar: some View {
        let count = displayedSongs.count
        return HStack {
            Text("\(count) song\(count == 1 ? "" : "s")")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Menu {
                Picker("Sort by", selection: $sortKey.column) {
                    ForEach(SongSort.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Order", selection: $sortKey.ascending) {
                    Text("Ascending").tag(true)
                    Text("Descending").tag(false)
                }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.up.arrow.down")
                    Text(sortKey.column.label)
                    Image(systemName: sortKey.ascending ? "chevron.up" : "chevron.down").font(.caption2)
                }
                .font(.caption.bold())
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    /// Single-column sort: tap a header to make it active; tap again toggles
    /// the direction. Only one column sorts the list at a time.
    private func sortHeader(_ label: String, _ column: SongSort) -> some View {
        let active = sortKey.column == column
        return Button {
            applySort(column, defaultAscending: defaultAscending(for: column))
        } label: {
            HStack(spacing: 2) {
                Text(label)
                if active {
                    Image(systemName: sortKey.ascending ? "chevron.up" : "chevron.down").font(.caption2)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func defaultAscending(for column: SongSort) -> Bool {
        switch column {
        case .title, .type: return true
        case .date, .pages: return false
        }
    }

    private func applySort(_ column: SongSort, defaultAscending: Bool) {
        withoutAnimation {
            if sortKey.column == column {
                sortKey.ascending.toggle()
            } else {
                sortKey = SortKey(column: column, ascending: defaultAscending)
            }
        }
    }

    // MARK: - Rows

    @ViewBuilder private func rowItem(_ song: Song) -> some View {
        if selecting {
            rowContent(song, selecting: true)
                .contentShape(Rectangle())
                .onTapGesture { toggleSelect(song) }
        } else if song.kind == .chord {
            // Chord songs are single-page text — no drag-to-merge.
            rowContent(song, selecting: false)
        } else {
            rowContent(song, selecting: false)
                .draggable(song.id)
                .dropDestination(for: String.self) { items, _ in
                    guard let draggedID = items.first, draggedID != song.id,
                          let dragged = coordinator.songs.first(where: { $0.id == draggedID }),
                          dragged.kind == .sheet, song.kind == .sheet
                    else { return false }
                    coordinator.merge(dragged, into: song)
                    return true
                }
        }
    }

    @ViewBuilder private func rowContent(_ song: Song, selecting: Bool) -> some View {
        if hSize == .compact { compactRow(song, selecting: selecting) }
        else { regularRow(song, selecting: selecting) }
    }

    private func regularRow(_ song: Song, selecting: Bool) -> some View {
        HStack(spacing: 8) {
            leadingControl(song, selecting: selecting)
            titleCell(song, selecting: selecting)
            typeCell(song).frame(width: typeWidth, alignment: .leading)
            tagsCell(song, interactive: !selecting).frame(width: tagsWidth, alignment: .leading)
            Text(song.firstPageDate.formatted(date: .abbreviated, time: .omitted))
                .font(.caption).foregroundStyle(.secondary)
                .frame(width: dateWidth, alignment: .leading)
            Text(song.kind == .chord ? "—" : "\(song.pageAssetIDs.count)")
                .foregroundStyle(.secondary)
                .frame(width: pagesWidth, alignment: .trailing)
        }
        .frame(height: rowHeight)
        .padding(.horizontal, 16)
    }

    /// Type column — plain text label, same styling as other column body text.
    private func typeCell(_ song: Song) -> some View {
        Text(song.kind == .chord ? "Chord" : "Sheet")
            .foregroundStyle(.secondary)
    }

    // iPhone: a native two-line row — title on top, date · pages · tags beneath.
    private func compactRow(_ song: Song, selecting: Bool) -> some View {
        let info = VStack(alignment: .leading, spacing: 3) {
            Text(song.title).lineLimit(1)
            compactSubtitle(song)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        return HStack(spacing: 12) {
            leadingControl(song, selecting: selecting)
            if selecting {
                info
            } else {
                Button { openSong = song } label: { info.contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                Image(systemName: "chevron.right")
                    .font(.caption.bold()).foregroundStyle(.tertiary)
            }
        }
        .frame(height: rowHeight)
        .padding(.horizontal, 16)
    }

    private func compactSubtitle(_ song: Song) -> some View {
        let visible = song.tags.filter { !AnalysisCoordinator.specialTags.contains($0) }
        return HStack(spacing: 6) {
            Text(song.firstPageDate.formatted(date: .abbreviated, time: .omitted))
            Text("·")
            if song.kind == .chord {
                Text("Chord")
            } else {
                Text("\(song.pageAssetIDs.count) pg")
            }
            ForEach(visible.prefix(maxVisibleTags), id: \.self) { tag in
                tagCapsule(tag, active: filterTags.contains(tag))
            }
            if visible.count > maxVisibleTags { Text("+\(visible.count - maxVisibleTags)") }
        }
        .font(.caption).foregroundStyle(.secondary)
        .lineLimit(1)
    }

    /// The leading slot — selection checkmark in select mode, otherwise empty
    /// so the row's title column lines up with the header.
    @ViewBuilder private func leadingControl(_ song: Song, selecting: Bool) -> some View {
        if selecting {
            Image(systemName: selectedSongIDs.contains(song.id) ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selectedSongIDs.contains(song.id) ? Color.accentColor : Color.secondary)
                .frame(width: 28)
        } else {
            Spacer().frame(width: 28)
        }
    }

    @ViewBuilder private func titleCell(_ song: Song, selecting: Bool) -> some View {
        let content = Text(song.title).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)

        if selecting {
            content
        } else {
            Button { openSong = song } label: { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func tagsCell(_ song: Song, interactive: Bool) -> some View {
        // Type now lives in its own column; tags cell shows only user-facing tags.
        let visible = song.tags.filter { !AnalysisCoordinator.specialTags.contains($0) }
        HStack(spacing: 6) {
            ForEach(visible.prefix(maxVisibleTags), id: \.self) { tag in
                if interactive {
                    Button { toggleFilter(tag) } label: { tagCapsule(tag, active: filterTags.contains(tag)) }
                        .buttonStyle(.plain)
                } else {
                    tagCapsule(tag, active: false)
                }
            }
            if visible.count > maxVisibleTags {
                Text("…").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .clipped()
    }

    private func tagCapsule(_ tag: String, active: Bool) -> some View {
        Text(tag)
            .font(.caption2)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(active ? Color.accentColor : Color(.secondarySystemBackground))
            .foregroundStyle(active ? Color.white : Color.accentColor)
            .clipShape(Capsule())
    }

    // MARK: - Pager

    private func pager(total: Int, current: Int) -> some View {
        HStack(spacing: 10) {
            Button { currentPage = max(0, current - 1) } label: { Image(systemName: "chevron.left") }
                .disabled(current <= 0)
            ForEach(Array(pageItems(current: current, total: total).enumerated()), id: \.offset) { _, item in
                if let p = item {
                    Button { currentPage = p - 1 } label: {
                        Text("\(p)").fontWeight(p - 1 == current ? .bold : .regular)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(p - 1 == current ? Color.accentColor : Color.primary)
                } else {
                    Text("…").foregroundStyle(.secondary)
                }
            }
            Button { currentPage = min(total - 1, current + 1) } label: { Image(systemName: "chevron.right") }
                .disabled(current >= total - 1)
        }
        .frame(maxWidth: .infinity)
        .frame(height: pagerHeight)
    }

    private func pageItems(current: Int, total: Int) -> [Int?] {
        if total <= 7 { return (1...total).map { $0 } }
        let c = current + 1
        var result: [Int?] = [1]
        if c > 4 { result.append(nil) }
        let lower = max(2, c - 1), upper = min(total - 1, c + 1)
        if lower <= upper { for p in lower...upper { result.append(p) } }
        if c < total - 3 { result.append(nil) }
        result.append(total)
        return result
    }

    // MARK: - Actions

    private func toggleFilter(_ tag: String) {
        withoutAnimation {
            if filterTags.contains(tag) { filterTags.remove(tag) } else { filterTags.insert(tag) }
        }
    }

    private func toggleSelect(_ song: Song) {
        if selectedSongIDs.contains(song.id) { selectedSongIDs.remove(song.id) }
        else { selectedSongIDs.insert(song.id) }
    }

    private func startSelection() {
        selectedSongIDs = []
        selecting = true
    }

    private func exitSelection() {
        selecting = false
        selectedSongIDs = []
    }

    private func applyAddTags() {
        withoutAnimation { coordinator.addTags(tagPickerSelection, toSongIDs: selectedSongIDs) }
        exitSelection()
    }

    private func applyRemoveTags() {
        withoutAnimation { coordinator.removeTags(tagPickerSelection, fromSongIDs: selectedSongIDs) }
        exitSelection()
    }

    private func performDelete(deletePhotos: Bool) {
        let targets = coordinator.songs.filter { selectedSongIDs.contains($0.id) }
        Task {
            let ok = await coordinator.deleteSongs(targets, deletePhotos: deletePhotos)
            if ok { exitSelection() }
        }
    }

    private func startAddSongs() {
        showPicker = true
    }

    private func startAutoScan() {
        autoScanTask = Task {
            let candidates = await coordinator.autoScanCandidates()
            if !Task.isCancelled { autoScanResult = candidates }
        }
    }

    private func runAddSongs(_ assets: [PHAsset]) {
        guard !assets.isEmpty else { return }
        addTask = Task { await coordinator.addSongs(from: assets) }
    }
}

/// Hosts the multi-select action sheets/alerts. Extracted from SongListView so the
/// main body stays small enough for the Swift type-checker.
private struct SelectionActionsModifier: ViewModifier {
    let count: Int
    let addableTags: [String]
    let removableTags: [String]
    @Binding var tagPickerSelection: Set<String>
    @Binding var showAddTags: Bool
    @Binding var showRemoveTags: Bool
    @Binding var showDeleteKeepConfirm: Bool
    @Binding var showDeletePhotosConfirm: Bool
    @Binding var deleteConfirmText: String
    var onAddTags: () -> Void
    var onRemoveTags: () -> Void
    var onDeleteKeep: () -> Void
    var onDeletePhotos: () -> Void

    private var plural: String { count == 1 ? "" : "s" }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showAddTags) {
                TagPickerSheet(title: "Add tags", actionLabel: "Add",
                               tags: addableTags, selection: $tagPickerSelection, onApply: onAddTags)
            }
            .sheet(isPresented: $showRemoveTags) {
                TagPickerSheet(title: "Delete tags", actionLabel: "Remove",
                               tags: removableTags, selection: $tagPickerSelection, onApply: onRemoveTags)
            }
            .alert("Delete \(count) song\(plural) from the app?", isPresented: $showDeleteKeepConfirm) {
                Button("Delete", role: .destructive, action: onDeleteKeep)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes them from Meowsic. Your photos stay in Apple Photos.")
            }
            .alert("Permanently delete \(count) song\(plural) and their photos?", isPresented: $showDeletePhotosConfirm) {
                TextField("Type I'm Ly to confirm", text: $deleteConfirmText)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Delete", role: .destructive) {
                    if deleteConfirmText == "I'm Ly" { onDeletePhotos() }
                    deleteConfirmText = ""
                }
                Button("Cancel", role: .cancel) { deleteConfirmText = "" }
            } message: {
                Text("This deletes the songs from Meowsic AND deletes their page photos from Apple Photos. Type “I'm Ly” exactly to confirm.")
            }
    }
}

/// A simple multi-select tag list used by the "Add tags" / "Delete tags" actions.
private struct TagPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let actionLabel: String
    let tags: [String]
    @Binding var selection: Set<String>
    var onApply: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if tags.isEmpty {
                    ContentUnavailableView("No tags", systemImage: "tag",
                                           description: Text("There are no tags to choose from."))
                } else {
                    List(tags, id: \.self) { tag in
                        Button {
                            if selection.contains(tag) { selection.remove(tag) } else { selection.insert(tag) }
                        } label: {
                            HStack {
                                Text(tag).foregroundStyle(.primary)
                                Spacer()
                                if selection.contains(tag) {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionLabel) { onApply(); dismiss() }
                        .disabled(selection.isEmpty)
                }
            }
        }
    }
}
