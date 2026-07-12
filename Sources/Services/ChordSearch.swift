import Foundation

/// Fetches a chord chart from the web given a free-text query (song name, artist,
/// anything relevant). Vietnamese queries (detected by diacritics) route to
/// **hopamchuan.com**; English queries route to **ukulele-tabs.com**, which serves
/// chord-over-lyrics text without Cloudflare blocking (unlike ultimate-guitar /
/// tabs4acoustic / e-chords). On parse failure the caller can fall back to
/// `webSearchURL(for:)` so the user can paste manually.
@MainActor
final class ChordSearch {
    enum Source: String { case hopamchuan, ukuleletabs, chordsandtabs, web }

    struct Result {
        let title: String
        let artist: String?
        let chordText: String
        let sourceURL: URL
        let source: Source
    }

    enum SearchError: Error, LocalizedError {
        case noResults
        case invalidResponse(Int)
        case network(Error)
        case parseFailed
        case unsupportedEnglish

        var errorDescription: String? {
            switch self {
            case .noResults: return "No chord found. Try different terms."
            case .invalidResponse(let code): return "Server returned an unexpected response (HTTP \(code))."
            case .network(let e): return "Network error: \(e.localizedDescription)"
            case .parseFailed: return "Couldn't parse the chord page. Site layout may have changed."
            case .unsupportedEnglish:
                return "English chord sites block direct fetch. Tap 'Search Web' to open a browser, then copy and paste the chord into the editor below."
            }
        }
    }

    private let session: URLSession

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 12
        cfg.timeoutIntervalForResource = 18
        cfg.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        ]
        self.session = URLSession(configuration: cfg)
    }

    /// Auto-routes by language detection. VI diacritics → hopamchuan,
    /// otherwise → ukulele-tabs (top-ranked candidate). For the EN flow with
    /// iterate-through-results, the View calls `searchEnglishCandidates` +
    /// `fetchEnglish(candidate:)` directly so it can advance the index.
    func search(query: String) async throws -> Result {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SearchError.noResults }
        if Self.looksVietnamese(trimmed) {
            return try await fetchHopAmChuan(query: trimmed)
        }
        let candidates = try await searchEnglishCandidates(query: trimmed)
        guard let first = candidates.first else { throw SearchError.noResults }
        return try await fetchEnglish(candidate: first)
    }

    /// Search hopamchuan regardless of whether the query has Vietnamese
    /// diacritics. Used when the user explicitly picks VI in the toggle —
    /// e.g. they typed "diem xua" without the accents and still expect the
    /// Vietnamese flow.
    func searchVietnamese(query: String) async throws -> Result {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SearchError.noResults }
        return try await fetchHopAmChuan(query: trimmed)
    }

    /// One match in an English chord-source result list. Tagged with its source
    /// so the View can dispatch the per-page fetch back to the right parser.
    struct EnglishCandidate: Equatable, Sendable {
        let title: String
        let url: URL
        let source: Source
    }

    /// Aggregates ranked candidates from every English source we can scrape.
    /// Order: ukulele-tabs first (best chord-over-lyrics text), then
    /// chords-and-tabs (different catalog, inline-chord format). The View pulls
    /// one entry at a time via `fetchEnglish` and rolls over sources naturally.
    ///
    /// Query relaxation: if both sources return zero candidates for the user's
    /// typed string, retry with progressively shorter slices ("frozen let it
    /// go" → "let it go" → "go"). The site searches are artist-name-first so
    /// extra context words cause zero-result misses. Final empty → caller
    /// falls back to Safari Google.
    func searchEnglishCandidates(query: String) async throws -> [EnglishCandidate] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SearchError.noResults }
        let attempts = Self.relaxedQueries(trimmed)
        for q in attempts {
            let all = await collectEnglishCandidates(q)
            if !all.isEmpty { return all }
        }
        throw SearchError.noResults
    }

    /// Run BOTH English sources for one query and return the unranked union.
    /// Per-source ranking already happens inside each `fetchXxxCandidates`.
    /// Errors from a single source are swallowed (the other source may still
    /// have results) — only an empty union triggers relaxation.
    private func collectEnglishCandidates(_ q: String) async -> [EnglishCandidate] {
        var all: [EnglishCandidate] = []
        if let a = try? await fetchUkuleleTabsCandidates(query: q) { all.append(contentsOf: a) }
        if let b = try? await fetchChordsAndTabsCandidates(query: q) { all.append(contentsOf: b) }
        return all
    }

    /// Produces query slices for relaxation:
    ///   "frozen let it go"  →  ["frozen let it go", "let it go", "go"]
    ///   "wonderwall oasis"  →  ["wonderwall oasis", "wonderwall", "oasis"]
    ///   "wonderwall"        →  ["wonderwall"]
    /// The original query goes first (best chance of an exact catalog match).
    /// Then drop the leading word(s) (often a musical/movie qualifier — "frozen
    /// let it go" — that the catalog doesn't index). Last fallback: the final
    /// word alone (often the song's most distinctive token).
    static func relaxedQueries(_ query: String) -> [String] {
        let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard words.count > 1 else { return [query] }
        var out: [String] = [query]
        for drop in 1..<words.count {
            let slice = words.dropFirst(drop).joined(separator: " ")
            if !slice.isEmpty, !out.contains(slice) { out.append(slice) }
        }
        return out
    }

    /// Fetch + parse a single chosen result, dispatched by `candidate.source`.
    func fetchEnglish(candidate: EnglishCandidate) async throws -> Result {
        switch candidate.source {
        case .ukuleletabs:    return try await fetchUkuleleTabsSong(at: candidate.url)
        case .chordsandtabs:  return try await fetchChordsAndTabsSong(at: candidate.url)
        default:              throw SearchError.parseFailed
        }
    }

    /// A Google search URL the UI can open externally to let the user find a
    /// chord page manually (used as a fallback when `.unsupportedEnglish`).
    static func webSearchURL(for query: String) -> URL? {
        let q = "\(query) chords lyrics"
        guard let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        return URL(string: "https://www.google.com/search?q=\(encoded)")
    }

    /// Best-effort artist lookup via the public iTunes Search API. Free, no key.
    /// Returns nil on any failure or empty result — caller should treat it as
    /// "couldn't find" and leave the field as-is.
    func lookupArtist(query: String) async -> String? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty,
              let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://itunes.apple.com/search?term=\(encoded)&media=music&limit=1")
        else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let results = json["results"] as? [[String: Any]],
                  let first = results.first,
                  let artist = first["artistName"] as? String,
                  !artist.isEmpty
            else { return nil }
            return artist
        } catch {
            return nil
        }
    }

    /// True if the text contains a Vietnamese-specific letter or any tone mark.
    static func looksVietnamese(_ text: String) -> Bool {
        if text.contains("đ") || text.contains("Đ") { return true }
        let vnExtras: Set<Character> = ["ă","â","ê","ô","ơ","ư","Ă","Â","Ê","Ô","Ơ","Ư"]
        if text.contains(where: { vnExtras.contains($0) }) { return true }
        // Combining tone marks
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x0300, 0x0301, 0x0303, 0x0309, 0x0323: return true
            default: continue
            }
        }
        // Precomposed accented vowels (fold drops diacritics → equal means none)
        let folded = text.folding(options: .diacriticInsensitive, locale: .current)
        return folded != text
    }

    // MARK: - hopamchuan.com (Vietnamese)

    /// hopamchuan search HTML uses `<a href="…" class="song-title">…</a>` — the
    /// attribute order can vary, so we extract the first anchor with the class
    /// and then read its `href` independently.
    private func fetchHopAmChuan(query: String) async throws -> Result {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        // `?q=<query>` is the real search endpoint. `/search/all/<query>` returns
        // the same featured-songs page regardless of the query, which is why
        // every search used to come back with the same wrong top hit.
        guard let searchURL = URL(string: "https://hopamchuan.com/search?q=\(encoded)") else {
            throw SearchError.invalidResponse(0)
        }
        let html = try await fetchHTML(searchURL)

        let anchorPattern = #"<a\b[^>]*\bclass="[^"]*song-title[^"]*"[^>]*>"#
        guard let anchor = Self.firstMatch(in: html, pattern: anchorPattern)?[0] else {
            throw SearchError.noResults
        }
        guard let hrefMatch = Self.firstMatch(in: anchor, pattern: #"href="([^"]+)""#) else {
            throw SearchError.noResults
        }
        let href = hrefMatch[1]
        guard let songURL = URL(string: href) ?? URL(string: href, relativeTo: URL(string: "https://hopamchuan.com")!)?.absoluteURL else {
            throw SearchError.parseFailed
        }

        let songHTML = try await fetchHTML(songURL)

        // Title is in <h1 id="song-title"><span>…</span></h1>; if that fails,
        // fall back to the page <title> tag and clean it up.
        let h1 = Self.extractText(from: songHTML, pattern: #"<h1[^>]*id="song-title"[^>]*>([\s\S]*?)</h1>"#)
        let titleRaw = h1 ?? Self.extractText(from: songHTML, pattern: #"<title>([\s\S]*?)</title>"#) ?? "Untitled"
        let title = Self.cleanHopAmChuanTitle(titleRaw)

        // Artist: first <a class="author-item">…</a>. Hopamchuan reused this class
        // in some sidebar songs too, so we constrain to anchors that link to /artist/.
        let artist = Self.extractText(from: songHTML,
                                      pattern: #"<a[^>]*href="[^"]*\/artist\/[^"]*"[^>]*class="[^"]*author-item[^"]*"[^>]*>([\s\S]*?)</a>"#)

        let chordText = try Self.extractHopAmChuanChordText(from: songHTML)
        guard !chordText.isEmpty else { throw SearchError.parseFailed }

        return Result(
            title: title,
            artist: (artist?.isEmpty == false) ? artist : nil,
            chordText: chordText,
            sourceURL: songURL,
            source: .hopamchuan
        )
    }

    /// Strip the "Hợp âm" / "Hop am" prefix and everything after the first
    /// " - " separator (which on hopamchuan's `<title>` is the singer name and
    /// the site name). `Hợp âm Diễm Xưa - Hồng Nhung - Hợp Âm Chuẩn` → `Diễm Xưa`.
    static func cleanHopAmChuanTitle(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Case- and diacritic-insensitive "hop am" / "hợp âm" prefix strip.
        let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
        for prefix in ["hop am ", "hopam "] where folded.hasPrefix(prefix) {
            s = String(s.dropFirst(prefix.count))
            break
        }
        if let dash = s.range(of: " - ") {
            s = String(s[..<dash.lowerBound])
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Walks the `<div id="song-lyric">…</div>` block; each `<div class="chord_lyric_line">`
    /// becomes one line in the output, with `<span class="hopamchuan_chord">G</span>`
    /// rewritten as the inline `[G]` token (canonical chord-text format for transpose).
    static func extractHopAmChuanChordText(from html: String) throws -> String {
        // Find the song-lyric div. We need balanced extraction — search for the
        // opening tag and then pull the substring up to the matching closing div.
        // Heuristic: hopamchuan's song-lyric block ends at "<!-- song-leftover" marker
        // or at the next `<div id="song-leftover-space"`. We grab everything between
        // `id="song-lyric"` and that sentinel and parse from there.
        guard let lyricStart = html.range(of: #"id="song-lyric""#)
        else { throw SearchError.parseFailed }
        let after = html[lyricStart.upperBound...]
        let endMarker = after.range(of: #"id="song-leftover"#)
            ?? after.range(of: #"id="song-main-content"#)
            ?? after.range(of: "</body")
        let block: Substring = endMarker.map { after[..<$0.lowerBound] } ?? after

        var lines: [String] = []
        let re = try NSRegularExpression(pattern: #"<div[^>]*class="[^"]*chord_lyric_line[^"]*"[^>]*>([\s\S]*?)</div>"#, options: [.caseInsensitive])
        let ns = block as NSString
        re.enumerateMatches(in: String(block), range: NSRange(location: 0, length: ns.length)) { m, _, _ in
            guard let m, m.numberOfRanges >= 2 else { return }
            let inner = ns.substring(with: m.range(at: 1))
            // Replace chord spans with [CHORD] tokens. The wrapping <span class="hopamchuan_chord_inline">
            // also contains `<i>[</i>` and `<i>]</i>` brackets — we drop those and rebuild.
            var converted = inner
            let chordRe = try? NSRegularExpression(pattern: #"<span[^>]*class="[^"]*hopamchuan_chord_inline[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*hopamchuan_chord[^"]*"[^>]*>([\s\S]*?)</span>[\s\S]*?</span>"#, options: [.caseInsensitive])
            if let chordRe {
                let convNS = converted as NSString
                let matches = chordRe.matches(in: converted, range: NSRange(location: 0, length: convNS.length))
                var pieces: [String] = []
                var cursor = 0
                for m in matches {
                    pieces.append(convNS.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))
                    let chord = convNS.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
                    pieces.append("[\(chord)]")
                    cursor = m.range.location + m.range.length
                }
                pieces.append(convNS.substring(with: NSRange(location: cursor, length: convNS.length - cursor)))
                converted = pieces.joined()
            }
            let stripped = decodeHTMLEntities(stripTags(converted))
            lines.append(stripped.trimmingCharacters(in: .whitespaces))
        }
        return normalizeChordText(lines.joined(separator: "\n"))
    }

    // MARK: - ukulele-tabs.com (English)

    /// Builds the search URL. The site's form posts `find=` to
    /// `/search-uke-chords.html`; that endpoint returns artists, songs, and
    /// albums on one page. We parse the songs list and filter to chord-format
    /// entries (`<span class="tabtype chrd">`) — fretboard-tab entries (`tab`)
    /// have no lyrics and aren't useful to display in the reader.
    static func ukuleleTabsSearchURL(for query: String) -> URL? {
        guard let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        return URL(string: "https://www.ukulele-tabs.com/search-uke-chords.html?find=\(encoded)")
    }

    /// One request to search. Returns ALL chord-format candidates ranked by
    /// title-match to the query (the site's own ordering is by song ID = date,
    /// which is irrelevant — e.g. `let it go` first-result is Elvis's "I'll
    /// Never Let You Go" because it's old and matches "let / you / go").
    /// Throws `.noResults` if the page has zero chord-format rows.
    private func fetchUkuleleTabsCandidates(query: String) async throws -> [EnglishCandidate] {
        guard let searchURL = Self.ukuleleTabsSearchURL(for: query) else {
            throw SearchError.invalidResponse(0)
        }
        let html = try await fetchHTML(searchURL)

        // Each chord-format result row starts with `<span class="tabtype chrd">chords</span>`
        // followed (after `&nbsp;` and whitespace) by the song-page anchor.
        // The site emits malformed markup (an extra `</span>` before `</a>`) so the
        // regex stays permissive on what's between `>` and `</a>`.
        let rowPattern = #"tabtype\s+chrd[^>]*>\s*chords\s*</span>[\s\S]{0,40}?<a\s+href="(/uke-songs/[^"]+\.html)"[^>]*>([\s\S]*?)</a>"#
        let base = URL(string: "https://www.ukulele-tabs.com")!
        var rows: [(siteIndex: Int, candidate: EnglishCandidate)] = []
        if let re = try? NSRegularExpression(pattern: rowPattern, options: [.caseInsensitive]) {
            let ns = html as NSString
            re.enumerateMatches(in: html, range: NSRange(location: 0, length: ns.length)) { m, _, _ in
                guard let m, m.numberOfRanges >= 3 else { return }
                let href = ns.substring(with: m.range(at: 1))
                let inner = ns.substring(with: m.range(at: 2))
                // Inner can contain stray tags from the malformed-markup case
                // (`Wonderwall</span>`). Strip + decode for a clean title.
                let title = Self.decodeHTMLEntities(Self.stripTags(inner))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty,
                      let url = URL(string: href, relativeTo: base)?.absoluteURL
                else { return }
                rows.append((rows.count, EnglishCandidate(title: title, url: url, source: .ukuleletabs)))
            }
        }
        guard !rows.isEmpty else { throw SearchError.noResults }

        // Score by title-match, then sort stable on site order for ties.
        return rows
            .map { (Self.titleMatchScore(title: $0.candidate.title, query: query), $0.siteIndex, $0.candidate) }
            .sorted { lhs, rhs in
                if lhs.0 != rhs.0 { return lhs.0 > rhs.0 }
                return lhs.1 < rhs.1
            }
            .map { $0.2 }
    }

    /// Fetch + parse the chosen song page. Split from the candidate listing so
    /// "Search again" can advance the candidate index without re-issuing the
    /// search query.
    private func fetchUkuleleTabsSong(at songURL: URL) async throws -> Result {
        let songHTML = try await fetchHTML(songURL)

        // Title: `<span class="uppcase" itemprop="name">Wonderwall</span>` inside the H1.
        // The same `itemprop="name"` is also used for the artist span elsewhere on the
        // page, so we require the `uppcase` class to disambiguate (the title is the only
        // span with both `uppcase` AND `itemprop="name"`).
        let titlePattern = #"<span\s+class="[^"]*\buppcase\b[^"]*"\s+itemprop="name"[^>]*>([\s\S]*?)</span>"#
        let title = (Self.extractText(from: songHTML, pattern: titlePattern)
                     ?? Self.extractText(from: songHTML, pattern: #"<title>([\s\S]*?)</title>"#)
                     ?? "Untitled")

        // Artist: the schema.org byArtist block — `<a href="/uke-songs/Slug-uke-tabs.html" itemprop="url"><span itemprop="name">Artist</span></a>`.
        // The slug-based anchor without itemprop appears in the page H1 too, so we anchor
        // on the inner span's `itemprop="name"` for precision.
        let artistPattern = #"<a\s+[^>]*href="/uke-songs/[^"]+-uke-tabs\.html"[^>]*itemprop="url"[^>]*>\s*<span[^>]*itemprop="name"[^>]*>([\s\S]*?)</span>"#
        let artist = Self.extractText(from: songHTML, pattern: artistPattern)

        let chordText = try Self.extractUkuleleTabsChordText(from: songHTML)
        guard !chordText.isEmpty else { throw SearchError.parseFailed }

        return Result(
            title: title,
            artist: (artist?.isEmpty == false) ? artist : nil,
            chordText: chordText,
            sourceURL: songURL,
            source: .ukuleletabs
        )
    }

    /// Higher = better match. Tiers (raw):
    /// 1000 exact, 800 prefix, 600 contiguous substring,
    /// then a STEMMED pass (drops -ing/-ed/-es/-s) so "I dream a dream" matches
    /// "I Dreamed a Dream":
    ///   950 stemmed-exact, 700 stemmed-contiguous,
    ///   else word-overlap fraction × 100 (with stemmed overlap as a tie-breaker).
    /// Punctuation in the title is folded out before matching so it doesn't
    /// sabotage short queries.
    static func titleMatchScore(title: String, query: String) -> Int {
        let normalize: (String) -> String = { s in
            s.lowercased()
                .folding(options: .diacriticInsensitive, locale: .current)
                .components(separatedBy: CharacterSet.alphanumerics.union(.whitespaces).inverted)
                .joined(separator: " ")
                .components(separatedBy: .whitespaces)
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }
        let t = normalize(title)
        let q = normalize(query)
        guard !t.isEmpty, !q.isEmpty else { return 0 }
        if t == q { return 1000 }
        if t.hasPrefix(q + " ") || t == q { return 800 }
        if t.contains(" " + q + " ") || t.hasPrefix(q + " ") || t.hasSuffix(" " + q) { return 600 }

        let qWords = q.split(separator: " ").map(String.init)
        let tWords = t.split(separator: " ").map(String.init)
        let qStems = qWords.map(Self.stem)
        let tStems = tWords.map(Self.stem)

        if qStems == tStems { return 950 }
        if qStems.count <= tStems.count {
            for start in 0...(tStems.count - qStems.count) {
                if Array(tStems[start..<start + qStems.count]) == qStems { return 700 }
            }
        }
        let tStemSet = Set(tStems)
        let matched = qStems.filter { tStemSet.contains($0) }.count
        return qStems.isEmpty ? 0 : (matched * 100) / qStems.count
    }

    /// Crude English suffix stripper. Conservative on length to avoid clobbering
    /// short words ("yes" stays "yes"; "dreaming" → "dream"; "dreamed" → "dream";
    /// "songs" → "song"). Not a full Porter stemmer — good enough to fuzz
    /// tense/plural mismatches in song titles.
    static func stem(_ word: String) -> String {
        var w = word
        if w.count > 4, w.hasSuffix("ing") { w = String(w.dropLast(3)) }
        else if w.count > 3, w.hasSuffix("ed") { w = String(w.dropLast(2)) }
        else if w.count > 3, w.hasSuffix("es") { w = String(w.dropLast(2)) }
        else if w.count > 3, w.hasSuffix("s")  { w = String(w.dropLast(1)) }
        return w
    }

    /// The chord-over-lyrics body sits in a single `<pre style="color:#454545;">…</pre>`
    /// element. Each chord is wrapped as
    /// `<a class="...chord"><span><img.../></span>CHORDNAME</a>` and lines use `<br>`.
    /// We rewrite chord anchors to their NAME (which is the text node after `</span>`,
    /// *not* the `alt` attribute — the alt is `"X chord"` with a trailing word), then
    /// strip the rest. Leading whitespace on each line is **preserved** because chord
    /// alignment above lyrics depends on it.
    static func extractUkuleleTabsChordText(from html: String) throws -> String {
        guard let preMatch = firstMatch(in: html, pattern: #"<pre[^>]*>([\s\S]*?)</pre>"#),
              preMatch.count >= 2
        else { throw SearchError.parseFailed }
        var inner = preMatch[1]

        // Rewrite each chord anchor to its inner chord name (the text between
        // `</span>` and `</a>`). The leading `<span>` may contain an `<img>` or
        // nothing — `[\s\S]*?` covers either.
        let chordPattern = #"<a\b[^>]*\bclass="[^"]*\bchord\b[^"]*"[^>]*>[\s\S]*?</span>\s*([^<\s]+)\s*</a>"#
        if let re = try? NSRegularExpression(pattern: chordPattern, options: [.caseInsensitive]) {
            let ns = inner as NSString
            let matches = re.matches(in: inner, range: NSRange(location: 0, length: ns.length))
            var pieces: [String] = []
            var cursor = 0
            for m in matches {
                pieces.append(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))
                pieces.append(ns.substring(with: m.range(at: 1)))
                cursor = m.range.location + m.range.length
            }
            pieces.append(ns.substring(with: NSRange(location: cursor, length: ns.length - cursor)))
            inner = pieces.joined()
        }

        // `<br>` → newline, then strip any residual tags (no further alignment-relevant
        // content remains in the chord block).
        inner = inner.replacingOccurrences(of: #"<br\s*/?>"#, with: "\n", options: .regularExpression)
        inner = inner.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        inner = decodeHTMLEntities(inner)
        return normalizeTwoLineChordText(inner)
    }

    /// Like `normalizeChordText` but preserves leading whitespace on each line
    /// (only trims trailing whitespace) — required for two-line chord-over-lyrics
    /// formats where chord columns must stay vertically aligned with the syllables
    /// below them.
    static func normalizeTwoLineChordText(_ s: String) -> String {
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var line = String(line).replacingOccurrences(of: "\r", with: "")
            while let last = line.last, last.isWhitespace { line.removeLast() }
            return line
        }
        var out: [String] = []
        var blanks = 0
        for line in lines {
            if line.isEmpty {
                blanks += 1
                if blanks <= 1 { out.append("") }
            } else {
                blanks = 0
                out.append(line)
            }
        }
        // Trim leading/trailing blank lines without touching interior leading space.
        while out.first?.isEmpty == true { out.removeFirst() }
        while out.last?.isEmpty == true { out.removeLast() }
        return out.joined(separator: "\n")
    }

    // MARK: - chords-and-tabs.net (English, fallback)

    /// Search uses `POST /songs/search/` with form field `search=<query>`. No
    /// reCAPTCHA enforcement server-side at time of writing — the widget on the
    /// homepage uses Google's reCAPTCHA only for spam analytics. Returns the
    /// same `EnglishCandidate` shape as ukulele-tabs (tagged with
    /// `.chordsandtabs` so `fetchEnglish` dispatches to the right parser).
    private func fetchChordsAndTabsCandidates(query: String) async throws -> [EnglishCandidate] {
        guard let searchURL = URL(string: "https://www.chords-and-tabs.net/songs/search/") else {
            throw SearchError.invalidResponse(0)
        }
        var req = URLRequest(url: searchURL)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let bodyQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        req.httpBody = "search=\(bodyQuery)".data(using: .utf8)
        let html = try await fetchHTML(request: req)

        // Each chord-format row:
        // `<li><a href="/song/name/eagles-hotel-california-11"><span class="songtype typechords">chords</span><b>Eagles - Hotel california</b>…</a></li>`
        // We accept either order of children (defensive against template tweaks).
        let rowPattern = #"<a\s+href="(/song/name/[^"]+)"[^>]*>[\s\S]*?<span[^>]*class="[^"]*typechords[^"]*"[^>]*>[\s\S]*?<b>([\s\S]*?)</b>"#
        let base = URL(string: "https://www.chords-and-tabs.net")!
        var rows: [(siteIndex: Int, candidate: EnglishCandidate)] = []
        if let re = try? NSRegularExpression(pattern: rowPattern, options: [.caseInsensitive]) {
            let ns = html as NSString
            re.enumerateMatches(in: html, range: NSRange(location: 0, length: ns.length)) { m, _, _ in
                guard let m, m.numberOfRanges >= 3 else { return }
                let href = ns.substring(with: m.range(at: 1))
                let inner = ns.substring(with: m.range(at: 2))
                let title = Self.decodeHTMLEntities(Self.stripTags(inner))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty,
                      let url = URL(string: href, relativeTo: base)?.absoluteURL
                else { return }
                rows.append((rows.count, EnglishCandidate(title: title, url: url, source: .chordsandtabs)))
            }
        }
        guard !rows.isEmpty else { return [] }
        return rows
            .map { (Self.titleMatchScore(title: $0.candidate.title, query: query), $0.siteIndex, $0.candidate) }
            .sorted { lhs, rhs in if lhs.0 != rhs.0 { return lhs.0 > rhs.0 }; return lhs.1 < rhs.1 }
            .map { $0.2 }
    }

    /// Fetch + parse a chords-and-tabs song page. The chord body uses one
    /// `<div class="song">` per line, with each chord wrapped in `<sup>NAME</sup>`
    /// inline with the lyric character it sits above. Conversion: `<sup>C</sup>`
    /// → `[C]` — drops cleanly into the existing transposer's bracketed pass.
    private func fetchChordsAndTabsSong(at songURL: URL) async throws -> Result {
        let songHTML = try await fetchHTML(songURL)

        // Title: `<span itemprop='name'>Hotel california </span>` inside the H1.
        // The H1 also contains an artist anchor with its own `itemprop='name'` span,
        // so we anchor on the OUTER H1 and pick the second `itemprop='name'` span
        // (the first one is inside the artist anchor).
        let h1Pattern = #"<h1[^>]*>([\s\S]*?)</h1>"#
        let h1 = Self.firstMatch(in: songHTML, pattern: h1Pattern).flatMap { $0.count >= 2 ? $0[1] : nil } ?? ""
        let nameMatches = Self.allMatches(in: h1, pattern: #"itemprop=['"]name['"][^>]*>([\s\S]*?)</span>"#)
        let title: String
        let artist: String?
        if nameMatches.count >= 2 {
            artist = Self.decodeHTMLEntities(Self.stripTags(nameMatches[0])).trimmingCharacters(in: .whitespacesAndNewlines)
            title  = Self.decodeHTMLEntities(Self.stripTags(nameMatches[1])).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if nameMatches.count == 1 {
            artist = nil
            title  = Self.decodeHTMLEntities(Self.stripTags(nameMatches[0])).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            artist = nil
            title  = Self.extractText(from: songHTML, pattern: #"<title>([\s\S]*?)</title>"#) ?? "Untitled"
        }

        let chordText = try Self.extractChordsAndTabsChordText(from: songHTML)
        guard !chordText.isEmpty else { throw SearchError.parseFailed }

        return Result(
            title: title.isEmpty ? "Untitled" : title,
            artist: (artist?.isEmpty == false) ? artist : nil,
            chordText: chordText,
            sourceURL: songURL,
            source: .chordsandtabs
        )
    }

    /// Each lyric line is wrapped in `<div class="song">…</div>` (exact class —
    /// the page also has `song-menu`, `song-tool`, `song-versions` which we must
    /// not match). Pages are also malformed (no closing `</div>` between rows),
    /// so we split at each `<div class="song">` and take everything up to the
    /// next sibling div opening. Inline `<sup>CHORD</sup>` markers convert to
    /// `[CHORD]` so the existing inline-bracket transposer handles them.
    static func extractChordsAndTabsChordText(from html: String) throws -> String {
        // Find positions of each row-opening div. Use the literal class string;
        // `\bsong\b` would falsely match `song-menu`, `song-tool`, etc.
        let openPattern = #"<div class="song">"#
        guard let re = try? NSRegularExpression(pattern: openPattern, options: [.caseInsensitive]) else {
            throw SearchError.parseFailed
        }
        let ns = html as NSString
        let opens = re.matches(in: html, range: NSRange(location: 0, length: ns.length))
            .map { NSMaxRange($0.range) }
        guard !opens.isEmpty else { throw SearchError.parseFailed }

        // Each row ends at the next opening div or at the first `</div>` —
        // whichever comes first. (Some pages do close the row; others let it
        // run until the next sibling.)
        var lines: [String] = []
        for (i, start) in opens.enumerated() {
            let endLimit = i + 1 < opens.count ? opens[i + 1] : ns.length
            // The next `<div` of any kind also terminates the row content.
            let chunk = ns.substring(with: NSRange(location: start, length: endLimit - start))
            let beforeNextDiv: String = {
                if let r = chunk.range(of: "<div", options: .caseInsensitive) {
                    return String(chunk[..<r.lowerBound])
                }
                return chunk
            }()
            let beforeCloseDiv: String = {
                if let r = beforeNextDiv.range(of: "</div>", options: .caseInsensitive) {
                    return String(beforeNextDiv[..<r.lowerBound])
                }
                return beforeNextDiv
            }()

            var s = beforeCloseDiv
            s = s.replacingOccurrences(of: #"<sup[^>]*>\s*([\s\S]*?)\s*</sup>"#,
                                        with: "[$1]", options: .regularExpression)
            s = s.replacingOccurrences(of: #"<br\s*/?>"#, with: " ", options: .regularExpression)
            s = s.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            s = decodeHTMLEntities(s)
                .replacingOccurrences(of: "\r", with: "")
                .trimmingCharacters(in: .whitespaces)
            if !s.isEmpty { lines.append(s) }
        }
        return normalizeChordText(lines.joined(separator: "\n"))
    }

    // MARK: - HTTP

    /// Iterate ALL captures of the first group across `text`. Helper used by
    /// parsers that need every matching block (chord rows, lyric divs, etc.).
    private static func allMatches(in text: String, pattern: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            guard m.numberOfRanges >= 2 else { return nil }
            let r = m.range(at: 1)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }

    private func fetchHTML(_ url: URL) async throws -> String {
        try await fetchHTML(request: URLRequest(url: url))
    }

    /// Request variant used for POST-search sites like chords-and-tabs. The
    /// shared `session` carries the default Safari UA + accept headers; the
    /// caller still sets `httpMethod` / `httpBody` / `Content-Type`.
    private func fetchHTML(request: URLRequest) async throws -> String {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw SearchError.invalidResponse(0) }
            guard (200..<300).contains(http.statusCode) else {
                throw SearchError.invalidResponse(http.statusCode)
            }
            return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
        } catch let err as SearchError {
            throw err
        } catch {
            throw SearchError.network(error)
        }
    }

    // MARK: - HTML helpers

    /// Returns the capture groups for the first regex match in `text`, or nil.
    private static func firstMatch(in text: String, pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? "" : ns.substring(with: r)
        }
    }

    /// Convenience: first regex group, HTML-stripped + decoded + trimmed, or nil.
    private static func extractText(from html: String, pattern: String) -> String? {
        guard let m = firstMatch(in: html, pattern: pattern), m.count >= 2 else { return nil }
        return decodeHTMLEntities(stripTags(m[1])).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Drop HTML tags but keep newlines so chord/lyric line layout survives.
    static func stripTags(_ html: String) -> String {
        var s = html.replacingOccurrences(of: #"<br\s*/?>"#, with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        return s
    }

    static func decodeHTMLEntities(_ s: String) -> String {
        var out = s
        let map: [(String, String)] = [
            ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
            ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"),
            ("&nbsp;", " "),
        ]
        for (k, v) in map { out = out.replacingOccurrences(of: k, with: v) }
        let re = try? NSRegularExpression(pattern: #"&#(x[0-9a-f]+|\d+);"#, options: [.caseInsensitive])
        if let re {
            let ns = out as NSString
            var pieces: [String] = []
            var cursor = 0
            re.enumerateMatches(in: out, range: NSRange(location: 0, length: ns.length)) { m, _, _ in
                guard let m, let r = Range(m.range, in: out), let g = Range(m.range(at: 1), in: out) else { return }
                pieces.append(String(out[out.index(out.startIndex, offsetBy: cursor)..<r.lowerBound]))
                let token = String(out[g])
                let value: UInt32?
                if token.hasPrefix("x") || token.hasPrefix("X") {
                    value = UInt32(token.dropFirst(), radix: 16)
                } else {
                    value = UInt32(token, radix: 10)
                }
                if let v = value, let scalar = Unicode.Scalar(v) {
                    pieces.append(String(Character(scalar)))
                }
                cursor = out.distance(from: out.startIndex, to: r.upperBound)
            }
            pieces.append(String(out[out.index(out.startIndex, offsetBy: cursor)..<out.endIndex]))
            out = pieces.joined()
        }
        return out
    }

    /// Trim trailing spaces, clamp excessive blank lines.
    static func normalizeChordText(_ s: String) -> String {
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false).map {
            String($0).replacingOccurrences(of: "\r", with: "").trimmingCharacters(in: .whitespaces)
        }
        var out: [String] = []
        var blanks = 0
        for line in lines {
            if line.isEmpty {
                blanks += 1
                if blanks <= 1 { out.append("") }
            } else {
                blanks = 0
                out.append(line)
            }
        }
        return out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
