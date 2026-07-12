import SwiftUI
import SwiftData

/// Practice stats and fun facts derived from SongOpen rows (one per viewer
/// session that lasted at least 10 seconds in either the sheet pager or the
/// chord reader). Pure-read view — no mutations.
struct StatsView: View {
    @Query(sort: \SongOpen.openedAt, order: .reverse) private var opens: [SongOpen]
    @Query(filter: #Predicate<Song> { !$0.isHidden }) private var allSongs: [Song]

    var body: some View {
        List {
            Section { headerCard }
            if !opens.isEmpty {
                topPlayedSection
                funFactsSection
                if !unplayed.isEmpty { untouchedSection }
            } else {
                Section {
                    Text("No practice sessions yet. Open a song for at least 10 seconds and it'll show up here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Stats")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Header

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                bigStat(value: formatDuration(totalSeconds), label: "total practice")
                bigStat(value: "\(opens.count)", label: opens.count == 1 ? "session" : "sessions")
                bigStat(value: "\(daysActive)", label: daysActive == 1 ? "day" : "days")
            }
            if let last = opens.first {
                Text("Last played: \(last.openedAt.formatted(.relative(presentation: .named)))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }

    private func bigStat(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2.bold()).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Top Played

    private var topPlayedSection: some View {
        Section("Top Played") {
            ForEach(Array(topPlayed.prefix(5).enumerated()), id: \.element.songID) { idx, item in
                HStack {
                    Text("\(idx + 1).").foregroundStyle(.secondary).frame(width: 22, alignment: .leading)
                    VStack(alignment: .leading) {
                        Text(item.title).lineLimit(1)
                        Text("\(item.count) \(item.count == 1 ? "session" : "sessions") · \(formatDuration(item.totalSeconds))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
            }
        }
    }

    // MARK: - Fun Facts

    private var funFactsSection: some View {
        Section("Fun Facts") {
            ForEach(funFacts, id: \.self) { fact in
                Text(fact).font(.callout)
            }
        }
    }

    private var funFacts: [String] {
        var out: [String] = []

        // Longest single session
        if let longest = opens.max(by: { $0.duration < $1.duration }) {
            let title = songTitle(forID: longest.songID) ?? "a song"
            out.append("Your longest sit-down was \(formatDuration(longest.duration)) on “\(title)”.")
        }

        // Average session
        if !opens.isEmpty {
            let avg = totalSeconds / Double(opens.count)
            out.append("Average session length: \(formatDuration(avg)).")
        }

        // Best hour of day
        if let hour = mostActiveHour {
            let label = hour == 0 ? "midnight" : hour == 12 ? "noon" : hour < 12 ? "\(hour) AM" : "\(hour - 12) PM"
            out.append("You play most often around \(label).")
        }

        // Streak (consecutive days ending today/yesterday)
        if let streak = currentStreak(), streak >= 2 {
            out.append("You're on a \(streak)-day practice streak. Don't break the chain.")
        }

        // Songs vs sessions ratio
        let touched = Set(opens.map(\.songID)).count
        if !allSongs.isEmpty {
            let pct = Int(Double(touched) / Double(allSongs.count) * 100)
            out.append("You've opened \(touched) of \(allSongs.count) songs in your library (\(pct)%).")
        }

        // "Would have purred" — at one cat purr/sec while playing
        let purrs = Int(totalSeconds)
        if purrs > 60 {
            let fmt = NumberFormatter()
            fmt.numberStyle = .decimal
            let str = fmt.string(from: NSNumber(value: purrs)) ?? "\(purrs)"
            out.append("A cat would have purred about \(str) times while you practiced.")
        }

        // % of a day
        let day: TimeInterval = 24 * 60 * 60
        let pctOfDay = totalSeconds / day * 100
        if pctOfDay >= 0.1 {
            out.append(String(format: "Total practice = %.1f%% of a full day.", pctOfDay))
        }

        return out
    }

    // MARK: - Untouched

    private var untouchedSection: some View {
        Section {
            ForEach(unplayed.prefix(5)) { song in
                Text(song.title).foregroundStyle(.secondary).lineLimit(1)
            }
            if unplayed.count > 5 {
                Text("…and \(unplayed.count - 5) more").font(.caption).foregroundStyle(.tertiary)
            }
        } header: {
            Text("Never Opened (\(unplayed.count))")
        } footer: {
            Text("These have been added to your library but never opened for 10+ seconds.")
                .font(.caption)
        }
    }

    // MARK: - Derived

    private var totalSeconds: TimeInterval {
        opens.reduce(0) { $0 + $1.duration }
    }

    private var daysActive: Int {
        Set(opens.map { Calendar.current.startOfDay(for: $0.openedAt) }).count
    }

    private var topPlayed: [(songID: String, title: String, count: Int, totalSeconds: TimeInterval)] {
        let titleByID = Dictionary(uniqueKeysWithValues: allSongs.map { ($0.id, $0.title) })
        let grouped = Dictionary(grouping: opens, by: \.songID)
        return grouped.map { (id, sessions) in
            (id,
             titleByID[id] ?? "Unknown",
             sessions.count,
             sessions.reduce(0) { $0 + $1.duration })
        }
        .sorted { ($0.count, $0.totalSeconds) > ($1.count, $1.totalSeconds) }
    }

    private var unplayed: [Song] {
        let opened = Set(opens.map(\.songID))
        return allSongs.filter { !opened.contains($0.id) }
    }

    private var mostActiveHour: Int? {
        let buckets = Dictionary(grouping: opens) { Calendar.current.component(.hour, from: $0.openedAt) }
            .mapValues(\.count)
        return buckets.max(by: { $0.value < $1.value })?.key
    }

    /// Number of consecutive calendar days with at least one open, ending today
    /// or yesterday (a one-day grace so missing today doesn't reset the count).
    private func currentStreak() -> Int? {
        let cal = Calendar.current
        let days = Set(opens.map { cal.startOfDay(for: $0.openedAt) })
        guard !days.isEmpty else { return nil }
        let today = cal.startOfDay(for: Date())
        var probe = days.contains(today) ? today
            : (days.contains(cal.date(byAdding: .day, value: -1, to: today)!) ? cal.date(byAdding: .day, value: -1, to: today)! : nil)
        guard var day = probe else { return nil }
        _ = probe
        var count = 0
        while days.contains(day) {
            count += 1
            day = cal.date(byAdding: .day, value: -1, to: day)!
        }
        return count
    }

    private func songTitle(forID id: String) -> String? {
        allSongs.first { $0.id == id }?.title
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        let mins = m % 60
        return mins == 0 ? "\(h)h" : "\(h)h \(mins)m"
    }
}

private extension SongOpen {
    var duration: TimeInterval { closedAt.timeIntervalSince(openedAt) }
}
