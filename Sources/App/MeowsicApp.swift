import SwiftUI
import SwiftData

@main
struct MeowsicApp: App {
    @State private var library = PhotoLibraryService()
    @AppStorage("meowsic.appearance") private var appearanceRaw = AppAppearance.system.rawValue

    init() {
        // Pre-filled cloud-sync defaults so both devices work with no typing.
        // Registered (not set), so anything entered in Settings still overrides.
        UserDefaults.standard.register(defaults: [
            "meowsic.sync.url": "https://hafkhktodmehpjzdcknr.supabase.co",
            "meowsic.sync.key": "sb_publishable_0RZyvDx654ih0kZAQwbmhA_1Ao9SRnt",
            "meowsic.sync.code": "meowsic-emi-2026",
        ])
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(library)
                .preferredColorScheme(AppAppearance(rawValue: appearanceRaw)?.colorScheme)
        }
        .modelContainer(for: [
            Song.self, SongOpen.self,
            PhotoAnalysis.self, SongRename.self, Tag.self, SongTagSet.self, SongMeta.self,
            PageGroup.self, PageBoundary.self, ChordSong.self,
        ])
    }
}
