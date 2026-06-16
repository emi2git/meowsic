import NaturalLanguage

/// Suggests tags for a sheet entirely on-device — no network. Three layers, all
/// constrained to the user's existing vocabulary:
///  1. **Language/region** via `NLLanguageRecognizer` (Vietnamese, Chinese, …).
///  2. **Source/theme** via an alias lexicon (Christmas → "noel", "jingle", …).
///  3. **Literal** tag-name matches (covers custom tags the user invented).
struct LocalTagger {
    /// Map a detected language to the closest vocabulary tag.
    private static let languageTags: [NLLanguage: String] = [
        .vietnamese: "Vietnamese",
        .english: "English",
        .simplifiedChinese: "Chinese",
        .traditionalChinese: "Chinese",
        .japanese: "J-pop",
        .korean: "K-pop",
        .spanish: "Latin",
        .portuguese: "Latin",
        .italian: "Latin",
    ]

    /// Keyword aliases for source/theme/genre tags. Matched as substrings of the
    /// lowercased page text. Only applied when the tag is in the user's vocabulary.
    private static let aliases: [String: [String]] = [
        "Christmas/Holiday": ["christmas", "noel", "jingle", "silent night", "santa", "holy night", "winter wonderland", "feliz navidad"],
        "Religious/Worship": ["worship", "hymn", "praise", "hallelujah", "amazing grace", "lord", "jesus", "gospel", "psalm"],
        "Wedding": ["wedding", "bridal", "here comes the bride", "ave maria", "canon in d"],
        "Children's": ["nursery", "lullaby", "twinkle", "baby shark", "abc song"],
        "Disney": ["disney", "let it go", "frozen", "moana", "encanto", "lion king", "aladdin", "mermaid", "hakuna matata"],
        "Musical": ["musical", "broadway", "phantom of the opera", "les misérables", "les miserables", "hamilton", "wicked", "dear evan hansen"],
        "Movie/Soundtrack": ["soundtrack", "original motion picture", "theme from", "main theme", "film score"],
        "Anime": ["anime", "naruto", "one piece", "demon slayer", "your name", "ghibli", "totoro"],
        "Video Game": ["video game", "final fantasy", "zelda", "undertale", "minecraft", "soundtrack ost", "ost"],
        "Jazz": ["jazz", "swing", "bossa nova", "blues"],
        "Classical": ["sonata", "concerto", "symphony", "nocturne", "prelude", "etude", "op.", "bwv", "k."],
    ]

    /// All tags worth assigning for `text`, intersected with `vocabulary`.
    func tags(forText text: String, vocabulary: [String]) -> [String] {
        let vocab = Set(vocabulary)
        let lower = text.lowercased()
        var found: Set<String> = []

        // 1. Language/region.
        if let languageTag = detectLanguageTag(text), vocab.contains(languageTag) {
            found.insert(languageTag)
        }

        // 2. Alias lexicon.
        for (tag, keywords) in Self.aliases where vocab.contains(tag) {
            if keywords.contains(where: { lower.contains($0) }) { found.insert(tag) }
        }

        // 3. Literal tag-name match (custom tags etc.).
        for tag in vocabulary where !tag.isEmpty && lower.contains(tag.lowercased()) {
            found.insert(tag)
        }

        return found.sorted()
    }

    private func detectLanguageTag(_ text: String) -> String? {
        // Need a little text to be confident — single short titles are unreliable.
        guard text.filter(\.isLetter).count >= 12 else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let hypotheses = recognizer.languageHypotheses(withMaximum: 1)
        guard let (language, probability) = hypotheses.first, probability >= 0.6 else { return nil }
        return Self.languageTags[language]
    }
}
