import SwiftUI
import SwiftData

@main
struct MeowsicApp: App {
    @State private var library = PhotoLibraryService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(library)
        }
        .modelContainer(for: [
            PhotoAnalysis.self, SongRename.self, Tag.self, SongTagSet.self, PageGroup.self, PageBoundary.self,
        ])
    }
}
