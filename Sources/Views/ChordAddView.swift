import SwiftUI
import UIKit

/// Add Chord flow. A VI/EN toggle next to the Search button picks the route:
/// VI runs the in-app hopamchuan fetch and auto-tags **Vietnamese**;
/// EN runs the in-app ukulele-tabs fetch and auto-tags **English**. On any EN
/// fetch failure the view falls back to opening a Google search in Safari so the
/// user can still copy/paste chord text from another site.
struct ChordAddView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss

    /// Optional: invoked by the duplicate-confirmation alert's "Open existing"
    /// action. SongListView wires this to its `openSong` state so the existing
    /// chord opens in ChordReaderView after this sheet dismisses.
    var onOpenExisting: ((ChordSong) -> Void)? = nil

    @State private var query = ""
    @State private var title = ""
    @State private var artist = ""
    @State private var chordText = ""
    @State private var sourceURL: URL?
    @State private var language: Lang = .vi
    @State private var languageManuallySet = false
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var hasFetched = false
    @State private var didAutoPaste = false
    @FocusState private var chordEditorFocused: Bool

    // EN iterate-through-results state. When the user re-presses Search with
    // the same query, advance to the next candidate; if the query text
    // changes, reset the list and pull fresh candidates.
    @State private var englishCandidates: [ChordSearch.EnglishCandidate] = []
    @State private var englishAttempt = 0
    @State private var englishLastQuery = ""


    // Duplicate-on-save confirm. When `coordinator.findChordSong(title:artist:)`
    // returns a match, we show an alert before inserting so the user can
    // choose between opening the existing entry or saving this as another
    // version.
    @State private var duplicateExisting: ChordSong?

    enum Lang: String, CaseIterable { case vi = "VI", en = "EN" }

    private let search = ChordSearch()

    var body: some View {
        NavigationStack {
            Form {
                Section("Search") {
                    TextField("Song name, artist, anything relevant", text: $query)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                        .submitLabel(.search)
                        .onChange(of: query) { _, _ in autoDetectLanguage() }
                        .onSubmit(triggerSearch)
                    HStack(spacing: 12) {
                        Button { triggerSearch() } label: {
                            if isSearching {
                                HStack(spacing: 8) { ProgressView(); Text("Searching…") }
                                    .frame(maxWidth: .infinity)
                            } else {
                                Label(searchButtonLabel, systemImage: searchButtonIcon)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.regular)
                        .disabled(isSearching || query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button {
                            languageManuallySet = true
                            language = (language == .vi) ? .en : .vi
                        } label: {
                            Text(language.rawValue)
                                .font(.callout.bold())
                                .frame(width: 44, height: 30)
                                .background(Color.accentColor.opacity(0.18))
                                .foregroundStyle(Color.accentColor)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Language: \(language == .vi ? "Vietnamese" : "English"). Tap to switch.")
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.caption).foregroundStyle(.orange)
                    }
                }

                if hasFetched || !chordText.isEmpty || language == .en {
                    Section("Title") {
                        TextField("Song title", text: $title).autocorrectionDisabled()
                    }
                    Section("Artist (optional)") {
                        TextField("Artist", text: $artist).autocorrectionDisabled()
                    }
                    Section {
                        TextEditor(text: $chordText)
                            .font(.system(.body, design: .monospaced))
                            .frame(minHeight: 280)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .focused($chordEditorFocused)
                            .onChange(of: chordEditorFocused) { _, focused in
                                if focused { autoPasteIfHelpful() }
                            }
                    } header: {
                        HStack {
                            Text("Chord text")
                            Spacer()
                            if !chordText.isEmpty {
                                Button("Clear") { chordText = "" }
                                    .font(.caption)
                                    .textCase(nil)
                            }
                        }
                    }
                    if let sourceURL {
                        Section("Source") {
                            Link(sourceURL.absoluteString, destination: sourceURL)
                                .font(.caption)
                        }
                    }
                }
            }
            .navigationTitle("Add Chord")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(true)   // only Cancel/Save closes the sheet
            .alert("Song already exists",
                   isPresented: Binding(
                       get: { duplicateExisting != nil },
                       set: { if !$0 { duplicateExisting = nil } }
                   ),
                   presenting: duplicateExisting) { existing in
                Button("Open existing") {
                    let target = existing
                    duplicateExisting = nil
                    dismiss()
                    // Fire the callback after dismiss so SongListView's openSong
                    // state transitions on a clean cycle (no overlay/sheet race).
                    DispatchQueue.main.async { onOpenExisting?(target) }
                }
                Button("Add another version") {
                    duplicateExisting = nil
                    performAddAsNewVersionAndDismiss()
                }
                Button("Cancel", role: .cancel) { duplicateExisting = nil }
            } message: { existing in
                let detail = existing.artist.map { " by \($0)" } ?? ""
                Text("\"\(existing.title)\"\(detail) is already in your library. Open the existing one, or save this as another version?")
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveAndDismiss() }
                        .disabled(!canSave)
                }
            }
        }
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !chordText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var searchButtonLabel: String {
        hasFetched ? "Search again" : "Search"
    }

    private var searchButtonIcon: String { "magnifyingglass" }

    /// While the user hasn't explicitly flipped the toggle, keep it in sync with
    /// what they're typing — Vietnamese diacritics → VI, otherwise EN.
    private func autoDetectLanguage() {
        guard !languageManuallySet else { return }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        language = ChordSearch.looksVietnamese(q) ? .vi : .en
    }

    private func triggerSearch() {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        switch language {
        case .vi: runVietnameseSearch(q)
        case .en: runEnglishSearch(q)
        }
    }

    private func runVietnameseSearch(_ q: String) {
        isSearching = true
        errorMessage = nil
        Task {
            defer { isSearching = false; hasFetched = true }
            do {
                // VI toggle forces hopamchuan even when the query has no
                // diacritics ("diem xua"). The general `search(query:)` would
                // route those to the English flow and throw.
                let r = try await search.searchVietnamese(query: q)
                title = r.title
                artist = r.artist ?? ""
                chordText = r.chordText
                sourceURL = r.sourceURL
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn't fetch chord. Paste it manually below."
                if title.isEmpty { title = q }
            }
            if artist.isEmpty {
                let lookupQuery = title.isEmpty ? q : title
                if let found = await search.lookupArtist(query: lookupQuery) {
                    artist = found
                }
            }
        }
    }

    /// EN path: in-app fetch from ukulele-tabs. First press picks the
    /// top-ranked candidate for `q`; subsequent presses with the same query
    /// advance through the ranked list ("Search again" = next song match).
    /// When the list is exhausted (or any fetch fails), fall back to a Google
    /// search in Safari so the user can find one elsewhere and paste it back.
    private func runEnglishSearch(_ q: String) {
        isSearching = true
        errorMessage = nil
        Task {
            defer { isSearching = false; hasFetched = true }
            // New query → reset the candidate list and the attempt index.
            if q != englishLastQuery {
                englishCandidates = []
                englishAttempt = 0
                englishLastQuery = q
            }
            do {
                if englishCandidates.isEmpty {
                    englishCandidates = try await search.searchEnglishCandidates(query: q)
                }
                guard englishAttempt < englishCandidates.count else {
                    // Exhausted the ranked list — Safari fallback.
                    errorMessage = englishCandidates.isEmpty
                        ? "No chord found for \"\(q)\". Opening web search."
                        : "No more results for \"\(q)\". Opening web search."
                    if let url = ChordSearch.webSearchURL(for: q) {
                        await UIApplication.shared.open(url)
                    }
                    return
                }
                let pick = englishCandidates[englishAttempt]
                englishAttempt += 1
                let r = try await search.fetchEnglish(candidate: pick)
                title = r.title
                artist = r.artist ?? ""
                chordText = r.chordText
                sourceURL = r.sourceURL
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription
                    ?? "Couldn't fetch chord. Opening web search — paste the chord text below."
                if title.isEmpty { title = q }
                if let url = ChordSearch.webSearchURL(for: q) {
                    await UIApplication.shared.open(url)
                }
            }
            if artist.isEmpty {
                let lookupQuery = title.isEmpty ? q : title
                if let found = await search.lookupArtist(query: lookupQuery) {
                    artist = found
                }
            }
        }
    }

    /// On first focus, if the chord editor is empty and the clipboard holds a
    /// long-enough text, drop it in. iOS shows the system "Paste" affordance.
    private func autoPasteIfHelpful() {
        guard !didAutoPaste, chordText.isEmpty else { return }
        didAutoPaste = true
        guard UIPasteboard.general.hasStrings,
              let s = UIPasteboard.general.string,
              s.count >= 20
        else { return }
        chordText = s
    }

    private func saveAndDismiss() {
        if let dup = coordinator.findChordSong(title: title, artist: artist.isEmpty ? nil : artist) {
            duplicateExisting = dup
            return
        }
        performAddAndDismiss()
    }

    /// Skip the duplicate check (caller already confirmed) and insert.
    private func performAddAndDismiss() {
        let langTag = language == .vi ? "Vietnamese" : "English"
        coordinator.addChordSong(
            title: title,
            artist: artist.isEmpty ? nil : artist,
            chordText: chordText,
            sourceURL: sourceURL?.absoluteString,
            initialTags: [langTag]
        )
        dismiss()
    }

    /// User confirmed "Add another version" — suffix the title with the next
    /// free " (vN)" so the new row is distinguishable in the song list.
    /// Bails after 99 attempts (should never happen in practice).
    private func performAddAsNewVersionAndDismiss() {
        let base = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanArtist = artist.isEmpty ? nil : artist
        var candidate = base
        var n = 2
        while coordinator.findChordSong(title: candidate, artist: cleanArtist) != nil, n < 100 {
            candidate = "\(base) (v\(n))"
            n += 1
        }
        title = candidate
        performAddAndDismiss()
    }
}
