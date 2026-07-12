import Foundation

/// Transpose `[CHORD]`-tokenized chord text up or down by N semitones.
/// Recognizes standard root letters (A–G), accidentals (#, b), qualities
/// (m, maj7, sus4, dim, aug, add9, …) and slash-chords (`C/G`). The body
/// (lyrics) is preserved verbatim.
enum ChordTransposer {
    /// Range Emi can practically reach on guitar/ukulele.
    static let minOffset = -11
    static let maxOffset = 11

    /// Shift every chord in `text` by `semitones`. Handles two formats:
    /// 1. **Bracketed** (hopamchuan): `[C]Hello [G]world` — only the bracketed
    ///    token is shifted.
    /// 2. **Chord-line** (paste from English guitar sites): a whole line whose
    ///    non-whitespace tokens are all chords (e.g. `C  Em  Am  G`) — every
    ///    chord on that line is shifted; lyric lines are untouched. Lines like
    ///    `[Verse 1]` or `Chorus:` are kept as-is.
    static func transpose(_ text: String, by semitones: Int) -> String {
        guard semitones != 0 else { return text }
        let normalized = ((semitones % 12) + 12) % 12   // 0..11
        guard normalized != 0 else { return text }

        let withBracketsShifted = shiftBracketedChords(in: text, by: normalized)
        return shiftChordLines(in: withBracketsShifted, by: normalized)
    }

    /// Pass 1: shift `[CHORD]` tokens. Non-chord bracket tokens (`[Chorus]`,
    /// `[Verse 1]`, `[Intro]`) are passed through untouched.
    private static func shiftBracketedChords(in text: String, by n: Int) -> String {
        let pattern = #"\[([^\]\n]+)\]"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
        let ns = text as NSString
        let matches = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var pieces: [String] = []
        var cursor = 0
        for m in matches {
            pieces.append(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))
            let token = ns.substring(with: m.range(at: 1))
            let full = ns.substring(with: m.range)
            pieces.append(isChord(token) ? "[\(shiftChord(token, by: n))]" : full)
            cursor = m.range.location + m.range.length
        }
        pieces.append(ns.substring(with: NSRange(location: cursor, length: ns.length - cursor)))
        return pieces.joined()
    }

    /// Pass 2: for each line, if every whitespace-separated token is a chord
    /// (or one of a small set of progression separators `| - :`), shift each
    /// chord token in place. Other lines (lyrics, section labels) pass through.
    private static func shiftChordLines(in text: String, by n: Int) -> String {
        let separators: Set<String> = ["|", "-", ":", "(", ")"]
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let processed: [String] = lines.map { line in
            let tokens = line
                .split(whereSeparator: { $0.isWhitespace })
                .map { String($0) }
                .filter { !$0.isEmpty }
            guard !tokens.isEmpty else { return line }
            // Need at least one real chord — separators alone shouldn't qualify.
            let chordCount = tokens.filter { isChord($0) }.count
            guard chordCount > 0 else { return line }
            // Every non-chord token must be a benign separator.
            for tok in tokens where !isChord(tok) && !separators.contains(tok) { return line }
            return rewriteChordsPreservingSpacing(line, by: n)
        }
        return processed.joined(separator: "\n")
    }

    /// Walk the line; runs of non-whitespace become tokens. Replace each token
    /// that is a chord; emit the rest (incl. spacing) verbatim.
    private static func rewriteChordsPreservingSpacing(_ line: String, by n: Int) -> String {
        var result = ""
        var current = ""
        func flush() {
            if !current.isEmpty {
                result += isChord(current) ? shiftChord(current, by: n) : current
                current = ""
            }
        }
        for c in line {
            if c.isWhitespace { flush(); result.append(c) }
            else { current.append(c) }
        }
        flush()
        return result
    }

    /// Tight whitelist: a chord starts with A–G, optionally `#` or `b`, then only
    /// chord-quality characters (m, aj, sus, dim, aug, add, digits, accidentals,
    /// `+`, `°`, `ø`, parens). Slash chords allowed via `/`. Max 8 chars per side.
    /// Anything else (words like "Chorus", "Verse 1", "Bridge") is rejected.
    static func isChord(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        let parts = trimmed.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let qualityChars: Set<Character> = [
            "a","A","b","B","d","D","g","G","i","I","j","J","m","M","n","N","s","S","u","U",
            "0","1","2","3","4","5","6","7","8","9",
            "#","°","ø","+","-","(",")","Δ",
        ]
        for part in parts {
            let s = part.trimmingCharacters(in: .whitespaces)
            guard s.count >= 1, s.count <= 8 else { return false }
            guard let first = s.first, "ABCDEFG".contains(first) else { return false }
            var rest = s.dropFirst()
            if let n = rest.first, n == "#" || n == "b" { rest = rest.dropFirst() }
            for c in rest where !qualityChars.contains(c) { return false }
        }
        return true
    }

    private static let sharpScale = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    private static let flatScale  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
    private static let rootIndex: [String: Int] = [
        "C":0,"C#":1,"Db":1,"D":2,"D#":3,"Eb":3,"E":4,"F":5,"F#":6,"Gb":6,
        "G":7,"G#":8,"Ab":8,"A":9,"A#":10,"Bb":10,"B":11,
    ]

    /// Shift a single chord token (possibly slash-chord like "C/G"). The original
    /// accidental flavor (sharp vs. flat) is preserved per side of the slash.
    static func shiftChord(_ chord: String, by semitones: Int) -> String {
        let parts = chord.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let shifted = parts.map { shiftSingleChord($0, by: semitones) }
        return shifted.joined(separator: "/")
    }

    private static func shiftSingleChord(_ chord: String, by semitones: Int) -> String {
        let (root, quality) = splitRoot(chord)
        guard !root.isEmpty, let idx = rootIndex[root] else { return chord }
        let useFlat = root.contains("b")
        let newIdx = (idx + semitones + 12) % 12
        let newRoot = useFlat ? flatScale[newIdx] : sharpScale[newIdx]
        return newRoot + quality
    }

    /// Split a chord into (root, quality). "C#m7" → ("C#", "m7"). Trims surrounding
    /// whitespace so `[ C ]` and `[C]` both transpose. Falls back to ("", chord)
    /// if the first char isn't A–G — leaves non-chord tokens untouched.
    private static func splitRoot(_ chord: String) -> (root: String, quality: String) {
        let trimmed = chord.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, "ABCDEFG".contains(first) else { return ("", chord) }
        var root = String(first)
        var rest = trimmed.dropFirst()
        if let next = rest.first, next == "#" || next == "b" {
            root.append(next)
            rest = rest.dropFirst()
        }
        return (root, String(rest))
    }
}
