import SwiftUI

/// Pick a tag + order, preview the page plan, then export to PDF.
/// Read as a book (two facing pages per spread, first page alone on the right):
/// a blank is inserted only before a MULTI-page song that would otherwise start on a
/// right-hand page, so its pages face each other (no mid-song flip). Single-page songs
/// never need a blank — they can share a sheet (one song per side).
struct PrintView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.dismiss) private var dismiss

    @State private var selectedTag = ""
    @State private var order: PrintOrder = .alphabetical
    @State private var exporting = false
    @State private var pdfURL: URL?
    @State private var showShare = false
    @State private var message: String?

    enum PrintOrder: String, CaseIterable, Identifiable {
        case alphabetical = "Alphabetical"
        case byDate = "By date taken"
        var id: String { rawValue }
    }

    private var taggedSongs: [Song] {
        guard !selectedTag.isEmpty else { return [] }
        return coordinator.songs.filter { $0.tags.contains(selectedTag) }
    }

    private var orderedSongs: [Song] {
        let songs = taggedSongs
        switch order {
        case .alphabetical:
            return songs.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .byDate:
            return songs.sorted { $0.firstPageDate < $1.firstPageDate }
        }
    }

    /// PDF page plan, minimizing blanks (single-page songs fill parity gaps so
    /// multi-page songs still start on a facing left page). See `PrintPlanner`.
    private var plan: (pages: [String?], lines: [(text: String, blank: Bool)]) {
        let entries = PrintPlanner.plan(orderedSongs)
        return (entries.map(\.assetID), entries.map { ($0.text, $0.blank) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Tag") {
                    Picker("Tag", selection: $selectedTag) {
                        Text("Select a tag").tag("")
                        ForEach(coordinator.tagNames, id: \.self) { Text($0).tag($0) }
                    }
                }
                Section("Order") {
                    Picker("Order", selection: $order) {
                        ForEach(PrintOrder.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                if !selectedTag.isEmpty {
                    let p = plan
                    if orderedSongs.isEmpty {
                        Section { Text("No songs have this tag.").foregroundStyle(.secondary) }
                    } else {
                        let blanks = p.pages.filter { $0 == nil }.count
                        let musicPages = p.pages.count - blanks
                        let total = p.pages.count
                        let sheets = (total + 1) / 2

                        Section("Summary") {
                            summaryRow("Songs", orderedSongs.count)
                            summaryRow("Music pages", musicPages)
                            summaryRow("Blank pages", blanks)
                            summaryRow("Total pages", total)
                            summaryRow("Sheets (double-sided)", sheets)
                        }

                        Section("Pages") {
                            ForEach(Array(p.lines.enumerated()), id: \.offset) { _, line in
                                Text(line.text)
                                    .font(.callout)
                                    .foregroundStyle(line.blank ? .secondary : .primary)
                                    .italic(line.blank)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Print")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await export() } } label: {
                        if exporting { ProgressView() } else { Text("Export PDF") }
                    }
                    .disabled(orderedSongs.isEmpty || exporting)
                }
            }
            .sheet(isPresented: $showShare) { if let pdfURL { ActivityView(items: [pdfURL]) } }
            .alert("Print", isPresented: Binding(
                get: { message != nil }, set: { if !$0 { message = nil } }
            )) {
                Button("OK") { message = nil }
            } message: {
                Text(message ?? "")
            }
        }
    }

    private func summaryRow(_ label: String, _ value: Int) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text("\(value)").foregroundStyle(.secondary)
        }
    }

    private func export() async {
        exporting = true
        defer { exporting = false }
        let data = await PDFExporter(library: library).pdf(plan: plan.pages)
        guard !data.isEmpty else { message = "Could not load any page images."; return }
        let safeTag = selectedTag.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("meowsic-\(safeTag).pdf")
        do {
            try data.write(to: url)
            pdfURL = url
            showShare = true
        } catch {
            message = "Failed to write PDF: \(error.localizedDescription)"
        }
    }
}
