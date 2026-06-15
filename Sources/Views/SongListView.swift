import SwiftUI

struct SongListView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library

    @State private var showSettings = false
    @State private var showPrint = false
    @State private var showTags = false

    @State private var searchText = ""
    @State private var sortColumn: SortColumn = .date
    @State private var sortAscending = false
    @State private var filterTags: Set<String> = []
    @State private var currentPage = 0

    @State private var taggingTag: String?            // non-nil → selection mode for this tag
    @State private var selectedSongIDs: Set<String> = []
    @State private var scanTask: Task<Void, Never>?

    private let dateWidth: CGFloat = 92
    private let pagesWidth: CGFloat = 52
    private let tagsWidth: CGFloat = 200
    private let rowHeight: CGFloat = 44
    private let pagerHeight: CGFloat = 44
    private let maxVisibleTags = 2

    enum SortColumn { case title, date, pages }

    private var displayedSongs: [Song] {
        var list = coordinator.songs
        // Hide soft-deleted songs unless the Deleted tag is being filtered on.
        if !filterTags.contains(AnalysisCoordinator.deletedTag) {
            list = list.filter { !$0.tags.contains(AnalysisCoordinator.deletedTag) }
        }
        if !searchText.isEmpty {
            list = list.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
        }
        if !filterTags.isEmpty {
            list = list.filter { !filterTags.isDisjoint(with: Set($0.tags)) }
        }
        switch sortColumn {
        case .title: list.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .date:  list.sort { $0.firstPageDate < $1.firstPageDate }
        case .pages: list.sort { $0.pageAssetIDs.count < $1.pageAssetIDs.count }
        }
        if !sortAscending { list.reverse() }
        return list
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if coordinator.isScanning { scanningBar }
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
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 50)
                                .onEnded { value in
                                    guard abs(value.translation.width) > abs(value.translation.height),
                                          abs(value.translation.width) > 60 else { return }
                                    if value.translation.width < 0 { currentPage = min(totalPages - 1, page + 1) }
                                    else { currentPage = max(0, page - 1) }
                                }
                        )
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Song.self) { SongPagerView(song: $0) }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search song name")
            .onChange(of: searchText) { currentPage = 0 }
            .onChange(of: filterTags) { currentPage = 0 }
            .onChange(of: sortColumn) { currentPage = 0 }
            .onChange(of: sortAscending) { currentPage = 0 }
            .toolbar { toolbarContent }
            .safeAreaInset(edge: .bottom) {
                if let tag = taggingTag { taggingBar(tag) }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showPrint) { PrintView() }
            .sheet(isPresented: $showTags) {
                TagsView(filter: $filterTags) { tag in
                    taggingTag = tag
                    selectedSongIDs = []
                    showTags = false
                }
            }
            .alert("Scan complete", isPresented: Binding(
                get: { coordinator.lastScanMessage != nil },
                set: { if !$0 { coordinator.lastScanMessage = nil } }
            )) {
                Button("OK") { coordinator.lastScanMessage = nil }
            } message: {
                Text(coordinator.lastScanMessage ?? "")
            }
            .task { coordinator.rebuildSongs() }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        if taggingTag != nil {
            ToolbarItem(placement: .topBarLeading) { Button("Cancel") { exitSelection() } }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select all") { selectedSongIDs = Set(displayedSongs.map(\.id)) }
            }
        } else {
            ToolbarItem(placement: .topBarLeading) {
                Button { showTags = true } label: {
                    Image(systemName: filterTags.isEmpty ? "tag" : "tag.fill")
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { resetView() } label: { Image(systemName: "arrow.counterclockwise") }
                    .disabled(!viewModified)
            }
            ToolbarItem(placement: .topBarTrailing) {
                if coordinator.isScanning {
                    Button("Stop", role: .destructive) { scanTask?.cancel() }
                } else {
                    Button("Scan New") { scan() }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showPrint = true } label: { Image(systemName: "printer") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
        }
    }

    private func taggingBar(_ tag: String) -> some View {
        HStack {
            Text("\(selectedSongIDs.count) selected").foregroundStyle(.secondary)
            Spacer()
            Button("Tag as “\(tag)”") { applyTag(tag) }
                .buttonStyle(.borderedProminent)
                .disabled(selectedSongIDs.isEmpty)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
    }

    private var viewModified: Bool {
        !filterTags.isEmpty || !searchText.isEmpty || sortColumn != .date || sortAscending
    }

    private func resetView() {
        filterTags.removeAll()
        searchText = ""
        sortColumn = .date
        sortAscending = false
        currentPage = 0
    }

    // MARK: - Sections

    private var scanningBar: some View {
        let total = max(coordinator.progressTotal, 1)
        let pct = Int(Double(coordinator.progressDone) / Double(total) * 100)
        return VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: Double(coordinator.progressDone), total: Double(total)) {
                Text("Scanning photos \(coordinator.progressDone)/\(coordinator.progressTotal) (\(pct)%)")
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

    @ViewBuilder private var emptyState: some View {
        if coordinator.songs.isEmpty {
            ContentUnavailableView("No songs yet", systemImage: "music.note.list",
                                   description: Text("Tap Scan New to analyze your photos."))
        } else {
            ContentUnavailableView("No matches", systemImage: "magnifyingglass",
                                   description: Text("No songs match your search or tag filter."))
        }
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            sortHeader("Title", .title).frame(maxWidth: .infinity, alignment: .leading)
            Text("Tags").frame(width: tagsWidth, alignment: .leading)
            sortHeader("Date", .date).frame(width: dateWidth, alignment: .leading)
            sortHeader("Pages", .pages).frame(width: pagesWidth, alignment: .trailing)
        }
        .font(.caption.bold())
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private func sortHeader(_ label: String, _ column: SortColumn) -> some View {
        Button {
            if sortColumn == column { sortAscending.toggle() }
            else { sortColumn = column; sortAscending = (column == .title) }
        } label: {
            HStack(spacing: 2) {
                Text(label)
                if sortColumn == column {
                    Image(systemName: sortAscending ? "chevron.up" : "chevron.down").font(.caption2)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Rows

    @ViewBuilder private func rowItem(_ song: Song) -> some View {
        if taggingTag != nil {
            rowContent(song, selecting: true)
                .contentShape(Rectangle())
                .onTapGesture { toggleSelect(song) }
        } else {
            rowContent(song, selecting: false)
                .draggable(song.id)
                .dropDestination(for: String.self) { items, _ in
                    guard let draggedID = items.first, draggedID != song.id,
                          let dragged = coordinator.songs.first(where: { $0.id == draggedID })
                    else { return false }
                    coordinator.merge(dragged, into: song)
                    return true
                }
        }
    }

    private func rowContent(_ song: Song, selecting: Bool) -> some View {
        HStack(spacing: 8) {
            if selecting {
                Image(systemName: selectedSongIDs.contains(song.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedSongIDs.contains(song.id) ? Color.accentColor : Color.secondary)
                    .frame(width: 28)
            } else {
                let starred = song.tags.contains(AnalysisCoordinator.starTag)
                Button { coordinator.toggleStar(song) } label: {
                    Image(systemName: starred ? "star.fill" : "star")
                        .foregroundStyle(starred ? Color.yellow : Color.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 28)
            }
            titleCell(song, selecting: selecting)
            tagsCell(song, interactive: !selecting).frame(width: tagsWidth, alignment: .leading)
            Text(song.firstPageDate.formatted(date: .abbreviated, time: .omitted))
                .font(.caption).foregroundStyle(.secondary)
                .frame(width: dateWidth, alignment: .leading)
            Text("\(song.pageAssetIDs.count)")
                .foregroundStyle(.secondary)
                .frame(width: pagesWidth, alignment: .trailing)
        }
        .frame(height: rowHeight)
        .padding(.horizontal, 16)
    }

    @ViewBuilder private func titleCell(_ song: Song, selecting: Bool) -> some View {
        let content = Text(song.title).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)

        if selecting {
            content
        } else {
            NavigationLink(value: song) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func tagsCell(_ song: Song, interactive: Bool) -> some View {
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
        if filterTags.contains(tag) { filterTags.remove(tag) } else { filterTags.insert(tag) }
    }

    private func toggleSelect(_ song: Song) {
        if selectedSongIDs.contains(song.id) { selectedSongIDs.remove(song.id) }
        else { selectedSongIDs.insert(song.id) }
    }

    private func exitSelection() {
        taggingTag = nil
        selectedSongIDs = []
    }

    private func applyTag(_ tag: String) {
        coordinator.addTag(tag, toSongIDs: selectedSongIDs)
        exitSelection()
    }

    private func scan() {
        guard let key = apiKeyOrPromptSettings() else { return }
        scanTask = Task { await coordinator.scanNew(apiKey: key) }
    }

    private func apiKeyOrPromptSettings() -> String? {
        guard let key = KeychainStore.load(), !key.isEmpty else {
            showSettings = true
            return nil
        }
        return key
    }
}
