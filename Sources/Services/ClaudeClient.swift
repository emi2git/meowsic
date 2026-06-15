import Foundation

/// Calls the Claude Messages API (raw HTTPS — no official Swift SDK) to classify
/// one photo in real time. Uses structured outputs so the reply is guaranteed JSON.
struct ClaudeClient {
    struct Classification: Decodable, Sendable {
        let is_music_sheet: Bool
        let is_song_start: Bool
        let title: String?
        let tags: [String]?
    }

    enum ClaudeError: LocalizedError {
        case http(Int, String)
        case badResponse
        case noContent

        var errorDescription: String? {
            switch self {
            case .http(let code, let body): return "HTTP \(code): \(body.prefix(200))"
            case .badResponse: return "Bad response"
            case .noContent: return "No content in response"
            }
        }
    }

    private let model = "claude-sonnet-4-6"
    private let version = "2023-06-01"
    private let endpoint = "https://api.anthropic.com/v1/messages"

    private let basePrompt = """
    Look at this image. Answer as JSON only.
    - is_music_sheet: true if it is a page of printed or handwritten musical notation (staves with notes); false otherwise.
    - is_song_start: true only if this is the FIRST page of a piece, i.e. it has a song/piece title or heading near the top. false for continuation pages.
    - title: if is_song_start is true, the title of the piece. The title is the LARGEST text that appears above the first musical staff/bar. Other text may also appear there (composer, arranger, author, tempo, key, opus number) — ignore those; return only the largest, most prominent heading text. Otherwise an empty string.
    """

    /// Classify one image. `vocabulary` is the user's tag list — the model may only
    /// assign tags from it.
    func classify(jpeg: Data, vocabulary: [String], apiKey: String) async throws -> Classification {
        let data = try await send(request(body: params(jpeg: jpeg, vocabulary: vocabulary), apiKey: apiKey))
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = obj["content"] as? [[String: Any]],
              let text = content.first(where: { ($0["type"] as? String) == "text" })?["text"] as? String,
              let textData = text.data(using: .utf8) else {
            throw ClaudeError.noContent
        }
        return try JSONDecoder().decode(Classification.self, from: textData)
    }

    // MARK: - Request building

    private func prompt(vocabulary: [String]) -> String {
        guard !vocabulary.isEmpty else { return basePrompt }
        return basePrompt + """

        - tags: choose ONLY tags from this exact list that you are CONFIDENT clearly apply, based on visible evidence (the title text, any printed lyrics, the language/script used, composer/source credits, and musical style). Be conservative and precise — do NOT guess.
          • For language/region tags (e.g. Vietnamese, Chinese, K-pop, J-pop, Latin): assign one ONLY if the title or lyrics are actually written in that language or script. Do not infer language from melody, mood, or assumption. English titles are not Vietnamese.
          • For source/theme tags (e.g. Disney, Musical, Movie/Soundtrack, Anime, Video Game): assign only if the title is a recognizable piece from that source.
          It is much better to return [] than to add a wrong tag.
          Allowed tags: \(vocabulary.joined(separator: ", ")).
        """
    }

    private func schema(vocabulary: [String]) -> [String: Any] {
        var properties: [String: Any] = [
            "is_music_sheet": ["type": "boolean"],
            "is_song_start": ["type": "boolean"],
            "title": ["type": "string"],
        ]
        var required = ["is_music_sheet", "is_song_start", "title"]
        if !vocabulary.isEmpty {
            properties["tags"] = ["type": "array", "items": ["type": "string", "enum": vocabulary]]
            required.append("tags")
        }
        return ["type": "object", "properties": properties,
                "required": required, "additionalProperties": false]
    }

    private func params(jpeg: Data, vocabulary: [String]) -> [String: Any] {
        [
            "model": model,
            "max_tokens": 256,
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "image",
                     "source": ["type": "base64", "media_type": "image/jpeg",
                                "data": jpeg.base64EncodedString()]],
                    ["type": "text", "text": prompt(vocabulary: vocabulary)],
                ],
            ]],
            "output_config": ["format": ["type": "json_schema", "schema": schema(vocabulary: vocabulary)]],
        ]
    }

    private func request(body: [String: Any], apiKey: String) throws -> URLRequest {
        var req = URLRequest(url: URL(string: endpoint)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue(version, forHTTPHeaderField: "anthropic-version")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return req
    }

    private func send(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw ClaudeError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ClaudeError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}
