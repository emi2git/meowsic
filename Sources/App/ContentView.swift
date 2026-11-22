import SwiftUI
import Photos
import UIKit

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(PhotoLibraryService.self) private var library
    @Environment(\.scenePhase) private var scenePhase
    @State private var coordinator: AnalysisCoordinator?
    @State private var autoSync: AutoSync?

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
                let c = AnalysisCoordinator(context: modelContext, library: library)
                let sync = AutoSync(coordinator: c)
                c.onMutate = { [weak sync] in sync?.pushSoon() }
                #if DEBUG
                if UITestSupport.isActive {
                    await library.requestAccess()
                    UITestSupport.seed(coordinator: c, context: modelContext)
                }
                #endif
                coordinator = c
                autoSync = sync
                // Pull the newest snapshot before enabling pushes, then keep in
                // step automatically (write → debounced push, foreground → pull,
                // background → flush).
                await sync.start()
            }
            await library.requestAccess()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await autoSync?.pullIfNeeded() }
            case .background: Task { await autoSync?.flush() }
            default: break
            }
        }
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
