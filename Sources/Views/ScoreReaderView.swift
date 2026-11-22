import SwiftUI
import SwiftData
import WebKit
import AVFoundation

/// Full-screen reader for a score imported from Emi Music Note: the MusicXML
/// drawn as notation (scrolls vertically, reflows to the window width), with
/// MIDI playback when the song has one — a sampled piano, with a red bar that
/// follows the music and scrolls the page along. Shown as an overlay over the song list
/// like the other readers; because the page scrolls, it closes with the button
/// rather than a vertical swipe.
struct ScoreReaderView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.modelContext) private var modelContext
    let song: Song
    var onClose: () -> Void

    @AppStorage("meowsic.score.zoom") private var zoom: Double = 0.75
    @State private var web = ScoreWebController()
    @State private var missing = false
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showTags = false
    @State private var showDelete = false
    /// Semitones up or down, remembered per song (same key the chord reader uses).
    @State private var transposeOffset = 0
    @State private var showTransposePopover = false
    /// Captured at appear so the SongOpen row can be recorded after the song is deleted.
    @State private var openedAt: Date?
    @State private var openedSongID: String?

    private static let zoomRange = 0.4...1.6
    private var transposeKey: String { "meowsic.transpose.\(song.id)" }
    private var transposeLabel: String {
        transposeOffset > 0 ? "+\(transposeOffset)" : "\(transposeOffset)"
    }

    var body: some View {
        NavigationStack {
            Group {
                if missing {
                    ContentUnavailableView("Score not found", systemImage: "music.quarternote.3",
                                           description: Text("This song's notation is missing. Import its MusicXML file again."))
                } else if let problem = web.problem {
                    ContentUnavailableView("Can't draw this score", systemImage: "exclamationmark.triangle",
                                           description: Text(problem))
                } else {
                    ScoreWebView(controller: web)
                        .overlay { if !web.drawn { ProgressView().controlSize(.large) } }
                }
            }
            .background(Color.white)
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle(song.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $showTags) { TagEditorView(song: song) }
            .alert("Rename song", isPresented: $showRename) {
                TextField("Title", text: $renameText)
                Button("Save") { coordinator.renameSong(song, to: renameText) }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(song.isHidden ? "Permanently delete “\(song.title)”?" : "Move “\(song.title)” to Deleted?",
                                isPresented: $showDelete, titleVisibility: .visible) {
                if song.isHidden {
                    Button("Restore") { coordinator.restore(song); onClose() }
                    Button("Delete song", role: .destructive) {
                        Task { if await coordinator.deleteSong(song, deletePhotos: false) { onClose() } }
                    }
                } else {
                    Button("Move to Deleted", role: .destructive) { coordinator.softDelete(song); onClose() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .onAppear {
            openedAt = Date()
            openedSongID = song.id
            transposeOffset = UserDefaults.standard.integer(forKey: transposeKey)
            if let content = coordinator.scoreContent(id: song.id) {
                web.show(musicXML: content.musicXML, midi: content.midi, zoom: zoom, transpose: transposeOffset)
            } else {
                missing = true
            }
        }
        .onDisappear {
            web.close()
            recordOpenIfQualified()
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { Button("Close") { onClose() } }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { renameText = song.title; showRename = true } label: { Label("Rename…", systemImage: "pencil") }
                Button { showTags = true } label: { Label("Tags…", systemImage: "tag") }
                Divider()
                Button(role: .destructive) { showDelete = true } label: { Label("Delete", systemImage: "trash") }
            } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("More")
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 6) {
                Button { setZoom(zoom - 0.1) } label: { Image(systemName: "minus.magnifyingglass") }
                    .disabled(zoom <= Self.zoomRange.lowerBound + 0.001)
                    .accessibilityLabel("Smaller notes")
                Button { setZoom(zoom + 0.1) } label: { Image(systemName: "plus.magnifyingglass") }
                    .disabled(zoom >= Self.zoomRange.upperBound - 0.001)
                    .accessibilityLabel("Larger notes")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showTransposePopover.toggle() } label: {
                HStack(spacing: 4) {
                    Text("Transpose")
                    if transposeOffset != 0 {
                        Text(transposeLabel).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            }
            .popover(isPresented: $showTransposePopover, attachmentAnchor: .point(.bottom), arrowEdge: .top) {
                transposePopover
            }
        }
        if web.canPlay {
            ToolbarItem(placement: .topBarTrailing) {
                Button { web.togglePlay() } label: {
                    Image(systemName: web.playing ? "pause.fill" : "play.fill")
                }
                .accessibilityLabel(web.playing ? "Pause" : "Play")
            }
        }
    }

    /// − / offset / + on top, Reset below; stays open while stepping.
    private var transposePopover: some View {
        VStack(spacing: 12) {
            HStack(spacing: 16) {
                Button { setTranspose(transposeOffset - 1) } label: {
                    Image(systemName: "minus.circle.fill").font(.title2)
                }
                .disabled(transposeOffset <= ChordTransposer.minOffset)
                .accessibilityLabel("Transpose down")
                Text(transposeLabel).font(.title3.bold()).monospacedDigit().frame(minWidth: 44)
                    .accessibilityIdentifier("transposeValue")
                Button { setTranspose(transposeOffset + 1) } label: {
                    Image(systemName: "plus.circle.fill").font(.title2)
                }
                .disabled(transposeOffset >= ChordTransposer.maxOffset)
                .accessibilityLabel("Transpose up")
            }
            Button { setTranspose(0) } label: { Text("Reset").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered)
                .disabled(transposeOffset == 0)
        }
        .padding(16)
        .frame(width: 220)
        .presentationCompactAdaptation(.popover)
    }

    private func setTranspose(_ value: Int) {
        transposeOffset = min(ChordTransposer.maxOffset, max(ChordTransposer.minOffset, value))
        UserDefaults.standard.set(transposeOffset, forKey: transposeKey)
        web.setTranspose(transposeOffset)
    }

    private func setZoom(_ value: Double) {
        zoom = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, value))
        web.setZoom(zoom)
    }

    /// Same rule as the other readers: a visit counts once it lasted 10 seconds.
    private func recordOpenIfQualified() {
        guard let openedAt, let openedSongID else { return }
        self.openedAt = nil
        self.openedSongID = nil
        let closedAt = Date()
        guard closedAt.timeIntervalSince(openedAt) >= 10 else { return }
        modelContext.insert(SongOpen(songID: openedSongID, openedAt: openedAt, closedAt: closedAt))
        try? modelContext.save()
    }
}

/// Owns the web view that draws the notation (bundled `score.html` +
/// OpenSheetMusicDisplay) and plays the MIDI. Everything is local: the page
/// and its script ship inside the app.
@Observable
final class ScoreWebController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private(set) var drawn = false
    private(set) var canPlay = false
    private(set) var playing = false
    private(set) var problem: String?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private var pending: (xml: String, midi: Data?, zoom: Double, transpose: Int)?
    @ObservationIgnored private var pageLoaded = false

    override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []   // Play is a toolbar button, not a tap in the page
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.isOpaque = false
        webView.backgroundColor = .white
        webView.scrollView.backgroundColor = .white
        webView.navigationDelegate = self
        config.userContentController.add(WeakHandler(self), name: "score")
        if let page = Bundle.main.url(forResource: "score", withExtension: "html") {
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            problem = "The score viewer is missing from this build."
        }
    }

    func show(musicXML: String, midi: Data?, zoom: Double, transpose: Int) {
        pending = (musicXML, midi, zoom, transpose)
        drawIfReady()
    }

    func setTranspose(_ semitones: Int) {
        webView.evaluateJavaScript("setTranspose(\(semitones))")
    }

    func setZoom(_ zoom: Double) {
        webView.evaluateJavaScript("setZoom(\(zoom))")
    }

    func togglePlay() {
        if !playing {
            // Play even with the ring/silent switch off, like any music app.
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        webView.evaluateJavaScript("player.toggle()")
    }

    func close() {
        webView.evaluateJavaScript("player.pause()")
    }

    private func drawIfReady() {
        guard pageLoaded, let job = pending else { return }
        pending = nil
        let args: [String: Any] = ["xml": job.xml, "zoom": job.zoom, "transpose": job.transpose,
                                   "midi": job.midi?.base64EncodedString() ?? ""]
        webView.callAsyncJavaScript("return await show(xml, zoom, midi, transpose)", arguments: args,
                                    in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                let info = value as? [String: Any]
                if info?["ok"] as? Bool == true {
                    self.drawn = true
                    self.canPlay = (info?["notes"] as? Int ?? 0) > 0
                    if self.canPlay { self.loadPiano() }
                } else {
                    self.problem = info?["error"] as? String ?? "Unknown error."
                }
            case .failure(let error):
                self.problem = error.localizedDescription
            }
        }
    }

    /// Hand the bundled piano recordings (`piano-<MIDI note>.mp3`) to the page's player.
    private func loadPiano() {
        let files = Bundle.main.urls(forResourcesWithExtension: "mp3", subdirectory: nil) ?? []
        var samples: [String: String] = [:]
        for file in files {
            let name = file.deletingPathExtension().lastPathComponent
            guard name.hasPrefix("piano-"), let note = Int(name.dropFirst(6)),
                  let data = try? Data(contentsOf: file) else { continue }
            samples[String(note)] = data.base64EncodedString()
        }
        guard !samples.isEmpty else { return }
        webView.callAsyncJavaScript("return await player.loadPiano(samples)", arguments: ["samples": samples],
                                    in: nil, in: .page) { _ in }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        drawIfReady()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        problem = error.localizedDescription
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], let playing = body["playing"] as? Bool {
            self.playing = playing
        }
    }

    /// The content controller holds its handler strongly; going through this
    /// keeps the web view from retaining its own controller forever.
    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: ScoreWebController?
        init(_ target: ScoreWebController) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }
}

private struct ScoreWebView: UIViewRepresentable {
    let controller: ScoreWebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
