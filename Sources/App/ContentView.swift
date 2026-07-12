import SwiftUI
import Photos
import UIKit

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.scenePhase) private var scenePhase
    @State private var coordinator: AnalysisCoordinator?
    @State private var pushing = false

    var body: some View {
        Group {
            switch library.status {
            case .denied, .restricted:
                ContentUnavailableView(
                    "Photo access denied",
                    systemImage: "lock",
                    description: Text("Enable Photos access in Settings → Privacy → Photos.")
                )
            default:
                if let coordinator {
                    SongListView()
                        .environment(coordinator)
                } else {
                    ProgressView()
                }
            }
        }
        .overlay { cloudSyncOverlay }
        .task {
            if coordinator == nil {
                coordinator = AnalysisCoordinator(context: modelContext, library: library)
            }
            await library.requestAccess()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { Task { await pushToCloud() } }
        }
    }

    /// Auto-push the current database to the cloud when the app leaves the
    /// foreground. Holds a background-task assertion so the upload can finish
    /// after backgrounding. No-op if cloud sync isn't configured.
    private func pushToCloud() async {
        guard SyncStore.isConfigured, !pushing, let coordinator else { return }
        pushing = true
        defer { pushing = false }
        let app = UIApplication.shared
        var bg = app.beginBackgroundTask(withName: "MeowsicSyncUpload")
        defer { if bg != .invalid { app.endBackgroundTask(bg); bg = .invalid } }
        try? await CloudSync().upload(coordinator.exportData())
    }

    /// "Loading from cloud" overlay shown while a restore import is in progress.
    /// Driven by `coordinator.importStatus` + `.importProgress`.
    @ViewBuilder private var cloudSyncOverlay: some View {
        if let status = coordinator?.importStatus {
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea()
                VStack(spacing: 16) {
                    Text(status).font(.headline)
                    if let p = coordinator?.importProgress {
                        ProgressView(value: p)
                            .progressViewStyle(.linear)
                            .frame(width: 240)
                        Text("\(Int(p * 100))%")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().scaleEffect(1.2)
                    }
                }
                .padding(28)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
    }
}
