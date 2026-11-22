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
        .modelContainer(Self.container)
    }

    private static let container: ModelContainer = {
        let schema = Schema([
            Song.self, SongOpen.self,
            PhotoAnalysis.self, SongRename.self, Tag.self, SongTagSet.self, SongMeta.self,
            PageGroup.self, PageBoundary.self, ChordSong.self, ScoreSong.self,
        ])
        do {
            return try ModelContainer(for: schema, configurations: [configuration(schema)])
        } catch {
            fatalError("Could not open the Meowsic database: \(error)")
        }
    }()

    /// On the Mac the database lives in `~/Documents/Meowsic` (apps go in
    /// `~/Applications`, their data in Documents); iPad and iPhone keep it in
    /// the app's own container.
    private static func configuration(_ schema: Schema) -> ModelConfiguration {
        #if DEBUG
        if UITestSupport.isActive { return ModelConfiguration(schema: schema, isStoredInMemoryOnly: true) }
        #endif
        #if targetEnvironment(macCatalyst)
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/Meowsic")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return ModelConfiguration(schema: schema, url: folder.appendingPathComponent("Meowsic.store"))
        #else
        return ModelConfiguration(schema: schema)
        #endif
    }
}
