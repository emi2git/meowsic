import SwiftUI
import UniformTypeIdentifiers

/// Persisted appearance choice. Stored as a raw string in `@AppStorage`
/// (key: `meowsic.appearance`) so both the Settings picker and the root scene
/// in `MeowsicApp` can read it directly without an intermediate model.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: return "System"
        case .light:  return "Light"
        case .dark:   return "Dark"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light:  return .light
        case .dark:   return .dark
        }
    }
}

/// JSON document used by the system export/import sheets.
struct BackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

struct SettingsView: View {
    @Environment(AnalysisCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss
    @State private var exportDoc: BackupDocument?
    @State private var showExporter = false
    @State private var showImportConfirm = false
    @State private var showImporter = false
    @State private var importing = false
    @State private var backupMessage: String?
    /// Typed in the Import confirm alert; must match `confirmKeyword` to proceed.
    /// Guards against accidental "I tapped Import and it wiped everything".
    @State private var importConfirmText = ""

    @AppStorage("meowsic.appearance") private var appearanceRaw = AppAppearance.system.rawValue

    // Cloud sync (Supabase) — same config keys as SyncStore.
    @AppStorage("meowsic.sync.url") private var syncURL = ""
    @AppStorage("meowsic.sync.key") private var syncKey = ""
    @AppStorage("meowsic.sync.code") private var syncCode = ""
    @State private var syncing = false
    @State private var showRestoreConfirm = false
    /// Typed in the Restore-from-cloud confirm alert; must match `confirmKeyword`.
    @State private var restoreConfirmText = ""

    /// Type-to-confirm keyword for destructive replace actions (Import / Restore).
    private static let confirmKeyword = "meow"

    /// Broaden the import picker so a `.json` file with a missing/odd UTI tag
    /// (common after iCloud Drive / AirDrop hops) still shows up. The decoder
    /// validates the contents — if it isn't a backup, the user sees a clear error.
    private static let importTypes: [UTType] = [.json, .data]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Songs are detected entirely on your device — titles via on-device text recognition, tags by matching your tag list against the page text. No photos leave your iPad and no API key is needed.")
                        .font(.footnote).foregroundStyle(.secondary)
                } header: {
                    Text("How it works")
                }

                Section("Last added") {
                    if let date = coordinator.lastScanDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                    } else {
                        Text("Never").foregroundStyle(.secondary)
                    }
                }

                Section {
                    NavigationLink {
                        StatsView()
                    } label: {
                        Label("Practice stats & fun facts", systemImage: "chart.bar.fill")
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $appearanceRaw) {
                        ForEach(AppAppearance.allCases) { a in
                            Text(a.label).tag(a.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    TextField("Supabase URL (https://xxxx.supabase.co)", text: $syncURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Anon / public API key", text: $syncKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Sync code (same on both devices)", text: $syncCode)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button { runSync(.backup) } label: {
                        Label("Back up to cloud", systemImage: "icloud.and.arrow.up")
                    }
                    .disabled(syncing || !cloudConfigured)
                    Button { showRestoreConfirm = true } label: {
                        Label("Restore from cloud", systemImage: "icloud.and.arrow.down")
                    }
                    .disabled(syncing || !cloudConfigured)
                } header: {
                    Text("Cloud sync (iPad ↔ iPhone)")
                } footer: {
                    Text("One-tap sync via a free Supabase project. Use the same sync code on both devices. Back up from the device you just edited, then Restore on the other (last-write-wins). Restore replaces this device's data with the cloud copy.")
                }

                Section {
                    Button("Export database") { startExport() }
                    Button("Import database") { showImportConfirm = true }
                } header: {
                    Text("Backup (file)")
                } footer: {
                    Text("Export saves all song data, tags, and merges to a JSON file. Import replaces your current database with a backup. Photos are relinked via iCloud identifiers, so a backup restores on another device that shares the same iCloud Photos library (photos not in iCloud restore only on the original device). Export first if you want a safety copy.")
                }

            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fileExporter(isPresented: $showExporter, document: exportDoc,
                          contentType: .json, defaultFilename: "meowsic-backup") { result in
                switch result {
                case .success(let url):
                    backupMessage = "Backup saved as “\(url.lastPathComponent)”."
                case .failure(let error):
                    backupMessage = "Export failed: \(error.localizedDescription)."
                }
            }
            .alert("Import database?", isPresented: $showImportConfirm) {
                TextField("Type meow to confirm", text: $importConfirmText)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Continue") {
                    if importConfirmText.lowercased() == Self.confirmKeyword { showImporter = true }
                    importConfirmText = ""
                }
                Button("Cancel", role: .cancel) { importConfirmText = "" }
            } message: {
                Text("This replaces all current data on this device with the chosen backup. Export first if you want a safety copy. Type “meow” to confirm.")
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: Self.importTypes) { result in
                switch result {
                case .success(let url): runImport(from: url)
                case .failure(let error): backupMessage = "Import failed: \(error.localizedDescription)"
                }
            }
            .alert("Backup", isPresented: Binding(
                get: { backupMessage != nil },
                set: { if !$0 { backupMessage = nil } }
            )) {
                Button("OK") { backupMessage = nil }
            } message: {
                Text(backupMessage ?? "")
            }
            .alert("Restore from cloud?", isPresented: $showRestoreConfirm) {
                TextField("Type meow to confirm", text: $restoreConfirmText)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Restore", role: .destructive) {
                    if restoreConfirmText.lowercased() == Self.confirmKeyword { runSync(.restore) }
                    restoreConfirmText = ""
                }
                Button("Cancel", role: .cancel) { restoreConfirmText = "" }
            } message: {
                Text("This replaces all song data on this device with the cloud copy. Back up first if this device has newer changes. Type “meow” to confirm.")
            }
            .overlay {
                if syncing || importing {
                    ProgressView().scaleEffect(1.4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.ultraThinMaterial)
                }
            }
        }
    }

    private func startExport() {
        exportDoc = BackupDocument(data: coordinator.exportData())
        showExporter = true
    }

    private func runImport(from url: URL) {
        importing = true
        Task {
            defer { importing = false }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                if let s = await coordinator.importData(data) {
                    var msg = "Imported \(s.songs) song\(s.songs == 1 ? "" : "s"). "
                        + "Photos relinked: \(s.relinked)/\(s.photos)."
                    if s.fallback > 0 { msg += " \(s.fallback) not found in this iCloud library." }
                    backupMessage = msg
                } else {
                    backupMessage = "Import failed: that file isn't a valid Meowsic backup."
                }
            } catch {
                backupMessage = "Import failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Cloud sync

    private enum CloudAction { case backup, restore }
    private var cloudConfigured: Bool { !syncURL.isEmpty && !syncKey.isEmpty && !syncCode.isEmpty }

    private func runSync(_ action: CloudAction) {
        syncing = true
        Task {
            let sync = CloudSync()
            do {
                switch action {
                case .backup:
                    try await sync.upload(coordinator.exportData())
                    backupMessage = "Backed up to cloud ✓"
                case .restore:
                    let data = try await sync.download()
                    if let s = await coordinator.importData(data) {
                        var msg = "Restored \(s.songs) song\(s.songs == 1 ? "" : "s") from cloud. "
                            + "Photos relinked: \(s.relinked)/\(s.photos)."
                        if s.fallback > 0 { msg += " \(s.fallback) not found in this iCloud library." }
                        backupMessage = msg
                    } else {
                        backupMessage = "Restore failed: invalid cloud backup."
                    }
                }
            } catch {
                backupMessage = error.localizedDescription
            }
            syncing = false
        }
    }
}
