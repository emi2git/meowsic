import SwiftUI
import UniformTypeIdentifiers

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
    @State private var apiKey = KeychainStore.load() ?? ""
    @State private var showWipeConfirm = false

    @State private var exportDoc: BackupDocument?
    @State private var showExporter = false
    @State private var showImporter = false
    @State private var backupMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-ant-...", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save key") {
                        KeychainStore.save(apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                } header: {
                    Text("Anthropic API Key")
                } footer: {
                    Text("Each candidate photo is sent to Claude (Haiku) for analysis, billed to this key. Stored in the device Keychain.")
                }

                Section("Last scan") {
                    if let date = coordinator.lastScanDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                    } else {
                        Text("Never").foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button("Export database") {
                        exportDoc = BackupDocument(data: coordinator.exportData())
                        showExporter = true
                    }
                    Button("Import database") { showImporter = true }
                } header: {
                    Text("Backup")
                } footer: {
                    Text("Export saves all song data, tags, and merges to a JSON file. Import replaces your current database with a backup. Photos are relinked via iCloud identifiers, so a backup restores on another device that shares the same iCloud Photos library (photos not in iCloud restore only on the original device).")
                }

                Section {
                    Button("Wipe database", role: .destructive) {
                        showWipeConfirm = true
                    }
                } footer: {
                    Text("Deletes all detected songs, titles, tag assignments, and merges, and resets the last-scan time so the next Scan New re-analyzes every photo from the beginning. Your tag list and your photos are not affected.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .alert("Wipe database?", isPresented: $showWipeConfirm) {
                Button("Wipe", role: .destructive) {
                    coordinator.wipeDatabase()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes all Meowsic song data and the last-scan timestamp. Your photos and your tag list are not affected. The next Scan New will scan every photo from the beginning.")
            }
            .fileExporter(isPresented: $showExporter, document: exportDoc,
                          contentType: .json, defaultFilename: "meowsic-backup") { result in
                if case .failure(let error) = result {
                    backupMessage = "Export failed: \(error.localizedDescription)"
                }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
                switch result {
                case .success(let url):
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    do {
                        let data = try Data(contentsOf: url)
                        if let s = coordinator.importData(data) {
                            var msg = "Imported \(s.songs) song\(s.songs == 1 ? "" : "s"). "
                                + "Photos relinked: \(s.relinked)/\(s.photos)."
                            if s.fallback > 0 { msg += " \(s.fallback) not found in this iCloud library." }
                            backupMessage = msg
                        } else {
                            backupMessage = "Import failed: invalid backup file."
                        }
                    } catch {
                        backupMessage = "Import failed: \(error.localizedDescription)"
                    }
                case .failure(let error):
                    backupMessage = "Import failed: \(error.localizedDescription)"
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
        }
    }
}
