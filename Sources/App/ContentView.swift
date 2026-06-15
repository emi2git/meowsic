import SwiftUI
import Photos

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(PhotoLibraryService.self) private var library
    @State private var coordinator: AnalysisCoordinator?

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
        .task {
            if coordinator == nil {
                coordinator = AnalysisCoordinator(context: modelContext, library: library)
            }
            await library.requestAccess()
        }
    }
}
