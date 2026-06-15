import SwiftUI

/// Shown after an "Add Songs" run: counts plus a thumbnail grid of every ignored
/// photo, grouped by why it was skipped.
struct AddSongsReportView: View {
    let report: AddSongsReport
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 84), spacing: 8)]

    private var groups: [(reason: AddSongsReport.IgnoreReason, items: [AddSongsReport.Ignored])] {
        AddSongsReport.IgnoreReason.allCases.compactMap { reason in
            let items = report.ignored.filter { $0.reason == reason }
            return items.isEmpty ? nil : (reason, items)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    summary
                    ForEach(groups, id: \.reason) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(group.items.count) ignored · \(group.reason.rawValue)")
                                .font(.subheadline.bold())
                            LazyVGrid(columns: columns, spacing: 8) {
                                ForEach(group.items) { item in
                                    AssetImageView(assetID: item.assetID,
                                                   targetSize: CGSize(width: 168, height: 168))
                                        .frame(width: 84, height: 84)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle(report.stopped ? "Stopped" : "Added Songs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            stat("Photos selected", report.selected)
            stat("Songs created", report.songsCreated)
            stat("Pages added", report.sheetsAdded)
            stat("Photos ignored", report.ignored.count)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private func stat(_ label: String, _ value: Int) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text("\(value)").bold().monospacedDigit()
        }
    }
}
