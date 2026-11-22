import Foundation

/// Builds songs from analyzed sheets using capture timestamps + the AI's
/// start-page flag, with a time-gap heuristic and manual boundary overrides,
/// then applies user merges (pages sharing a `groupKey` form one song).
enum GroupingEngine {
    /// Photos taken within this gap are treated as the same song (continuation),
    /// even if the AI flagged a start (fixes pages mis-split into new songs).
    static let sameSongGap: TimeInterval = 30
    /// Photos taken more than this far apart start a new song, even if the AI
    /// didn't flag a start (fixes separate songs fused together).
    static let newSongGap: TimeInterval = 120

    static func group(analyses: [PhotoAnalysis],
                      chordSongs: [ChordSong] = [],
                      scoreSongs: [ScoreSong] = [],
                      renames: [String: String],
                      tagOverrides: [String: [String]],
                      pageGroups: [String: String],
                      boundaries: [String: Bool],
                      deletedKeys: Set<String> = [],
                      deletedTag: String = "Deleted") -> [SongDerivation] {
        let dateByID = Dictionary(analyses.map { ($0.assetLocalIdentifier, $0.creationDate) },
                                  uniquingKeysWith: { a, _ in a })
        let byID = Dictionary(analyses.map { ($0.assetLocalIdentifier, $0) },
                              uniquingKeysWith: { a, _ in a })

        // 1. Base songs, ascending by capture time. A page starts a new song when:
        //    manual override says so, else gap is large, else (AI start AND gap not tiny).
        let sheets = analyses.filter { $0.isMusicSheet }.sorted { $0.creationDate < $1.creationDate }
        var bases: [(start: String, pages: [String])] = []
        var current: (start: String, pages: [String])?
        var prevDate: Date?
        for page in sheets {
            let id = page.assetLocalIdentifier
            let gap = prevDate.map { page.creationDate.timeIntervalSince($0) } ?? .greatestFiniteMagnitude
            prevDate = page.creationDate

            let startsNewSong: Bool
            if let manual = boundaries[id] {
                startsNewSong = manual
            } else if current == nil {
                startsNewSong = true
            } else if gap > newSongGap {
                startsNewSong = true
            } else if gap < sameSongGap {
                startsNewSong = false
            } else {
                startsNewSong = page.isSongStart
            }

            if startsNewSong || current == nil {
                if let c = current { bases.append(c) }
                current = (start: id, pages: [id])
            } else {
                current!.pages.append(id)
            }
        }
        if let c = current { bases.append(c) }

        // 2. Merge base songs that share a group key (default key = own start page).
        var grouped: [String: [String]] = [:]
        for base in bases {
            let key = pageGroups[base.start] ?? base.start
            grouped[key, default: []].append(contentsOf: base.pages)
        }

        // 3. Build songs; root = earliest page id (== the group key by construction).
        var songs: [SongDerivation] = []
        for (root, pages) in grouped {
            let ordered = pages.sorted { (dateByID[$0] ?? .distantPast) < (dateByID[$1] ?? .distantPast) }
            let detected = (byID[root]?.title?.isEmpty == false) ? byID[root]!.title! : "Untitled"
            let renamed = renames[root]
            let title = (renamed ?? detected).titleCased
            let baseTags = tagOverrides[root] ?? (byID[root]?.tags ?? [])
            let isDel = deletedKeys.contains(root)
            let tags = decoratedTags(baseTags, kind: .sheet,
                                     deleted: isDel, deletedTag: deletedTag)
            let firstDate = dateByID[ordered.first ?? root] ?? .distantPast
            songs.append(SongDerivation(id: root, title: title, titleIsCustom: renamed != nil,
                                        pageAssetIDs: ordered,
                                        firstPageDate: firstDate, tags: tags, kind: .sheet,
                                        chordText: nil, artist: nil, isHidden: isDel))
        }

        // 4. Append chord songs (single-page, text-based).
        for chord in chordSongs {
            let renamed = renames[chord.id]
            let title = (renamed ?? chord.title).titleCased
            let baseTags = tagOverrides[chord.id] ?? []
            let isDel = deletedKeys.contains(chord.id)
            let tags = decoratedTags(baseTags, kind: .chord,
                                     deleted: isDel, deletedTag: deletedTag)
            songs.append(SongDerivation(id: chord.id, title: title, titleIsCustom: renamed != nil,
                                        pageAssetIDs: [],
                                        firstPageDate: chord.createdAt, tags: tags, kind: .chord,
                                        chordText: chord.chordText, artist: chord.artist,
                                        isHidden: isDel))
        }

        // 5. Append imported scores (MusicXML notation, drawn by the score reader).
        for score in scoreSongs {
            let renamed = renames[score.id]
            let isDel = deletedKeys.contains(score.id)
            let tags = decoratedTags(tagOverrides[score.id] ?? [], kind: .score,
                                     deleted: isDel, deletedTag: deletedTag)
            songs.append(SongDerivation(id: score.id, title: (renamed ?? score.title).titleCased,
                                        titleIsCustom: renamed != nil, pageAssetIDs: [],
                                        firstPageDate: score.createdAt, tags: tags, kind: .score,
                                        chordText: nil, artist: nil, isHidden: isDel))
        }

        return songs.sorted { $0.firstPageDate > $1.firstPageDate }
    }

    /// Builds the display tag list: drops stale Deleted/wrong-kind strings from
    /// `base`, then prepends synthesized markers (Deleted from SongMeta; Sheet/Chord/Score
    /// from kind). Order: Deleted first, then the kind tag.
    private static func decoratedTags(_ base: [String], kind: SongKind,
                                      deleted: Bool, deletedTag: String) -> [String] {
        var out = base.filter { !SongKind.tagNames.contains($0) && $0 != deletedTag }
        out.insert(kind.tagName, at: 0)
        if deleted { out.insert(deletedTag, at: 0) }
        return out
    }
}
