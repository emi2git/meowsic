import Foundation

/// UserDefaults-backed Supabase connection details, shared by the Settings UI and
/// the sync service. The sync code is the secret that links two devices.
enum SyncStore {
    private static let d = UserDefaults.standard
    enum Key {
        static let url = "meowsic.sync.url", anonKey = "meowsic.sync.key", code = "meowsic.sync.code"
        static let version = "meowsic.sync.version"
    }

    static var url: String { d.string(forKey: Key.url) ?? "" }
    static var anonKey: String { d.string(forKey: Key.anonKey) ?? "" }
    static var code: String { d.string(forKey: Key.code) ?? "" }
    static var isConfigured: Bool { !url.isEmpty && !anonKey.isEmpty && !code.isEmpty }

    /// The `updated_at` of the cloud row as of our last successful push or pull.
    /// Auto-sync uses it as a whole-blob version token: pull only imports when the
    /// remote row is newer than this, so we never re-import our own upload or
    /// overwrite newer local state with a stale snapshot.
    static var lastVersion: String {
        get { d.string(forKey: Key.version) ?? "" }
        set { d.set(newValue, forKey: Key.version) }
    }
}

/// One-tap cloud sync via Supabase's REST API (PostGREST). No SDK, no iCloud
/// entitlement — plain HTTPS, so it works on a free signing team. The whole song
/// database travels as one JSON document (the same payload as file export) in a
/// single row keyed by the sync code. Last-write-wins.
///
/// Table (run once in the Supabase SQL editor — can be the SAME project as meowzi;
/// the row key is namespaced so the two apps never collide):
///   create table if not exists backups (
///     code text primary key,
///     payload text not null,
///     updated_at timestamptz not null default now()
///   );
///   alter table backups enable row level security;
///   create policy "anon access" on backups for all to anon using (true) with check (true);
struct CloudSync {
    enum SyncError: LocalizedError {
        case notConfigured, badURL, server(Int, String), empty
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Add your Supabase URL, key and sync code first."
            case .badURL: return "The Supabase URL looks invalid."
            case .server(let c, let m): return "Cloud error \(c): \(m)"
            case .empty: return "No backup found for this sync code yet."
            }
        }
    }

    /// Namespacing keeps meowsic's row distinct from meowzi's in a shared table.
    private var rowCode: String { "meowsic:" + SyncStore.code }

    /// A cloud row plus its server-assigned version token (`updated_at`).
    struct Remote { let payload: Data; let version: String }

    // MARK: Push

    /// Upsert the payload and return the row's new `updated_at` version token so
    /// callers (auto-sync) can record it and avoid re-importing their own upload.
    @discardableResult
    func upload(_ payload: Data) async throws -> String {
        guard SyncStore.isConfigured else { throw SyncError.notConfigured }
        var request = try makeRequest(query: "on_conflict=code")
        request.httpMethod = "POST"
        // return=representation so the response carries the upserted row (with its
        // freshly-bumped updated_at).
        request.setValue("resolution=merge-duplicates,return=representation", forHTTPHeaderField: "Prefer")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": rowCode,
            "payload": String(decoding: payload, as: UTF8.self),
        ])
        let data = try await send(request)
        let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        return (rows?.first?["updated_at"] as? String) ?? ""
    }

    // MARK: Pull

    /// Fetch the cloud row's payload and version token in one round trip.
    func fetchRemote() async throws -> Remote {
        guard SyncStore.isConfigured else { throw SyncError.notConfigured }
        let escaped = rowCode.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? rowCode
        let request = try makeRequest(query: "code=eq.\(escaped)&select=payload,updated_at")
        let data = try await send(request)
        guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let payload = (rows.first?["payload"] as? String)?.data(using: .utf8) else {
            throw SyncError.empty
        }
        return Remote(payload: payload, version: (rows.first?["updated_at"] as? String) ?? "")
    }

    func download() async throws -> Data { try await fetchRemote().payload }

    // MARK: Plumbing

    private func makeRequest(query: String) throws -> URLRequest {
        guard let base = URL(string: SyncStore.url),
              var comps = URLComponents(url: base.appendingPathComponent("rest/v1/backups"),
                                        resolvingAgainstBaseURL: false) else {
            throw SyncError.badURL
        }
        comps.percentEncodedQuery = query
        guard let url = comps.url else { throw SyncError.badURL }
        var request = URLRequest(url: url)
        request.setValue(SyncStore.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(SyncStore.anonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    @discardableResult
    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SyncError.server(0, "no response") }
        guard (200...299).contains(http.statusCode) else {
            throw SyncError.server(http.statusCode, String(decoding: data, as: UTF8.self))
        }
        return data
    }
}

private extension CharacterSet {
    static let urlQueryValueAllowed: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.remove(charactersIn: "&=+")
        return set
    }()
}
