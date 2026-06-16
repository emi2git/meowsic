import Vision
import UIKit

/// Fully on-device replacement for the old cloud classifier. Uses Apple's Vision
/// text recognition to read a page and infer, with simple heuristics:
///  - `isSongStart`: the page has a prominent heading near the top,
///  - `title`: that heading's text, re-read from a zoomed-in crop for accuracy,
///  - `tags`: suggested on-device by `LocalTagger`.
/// No network, no API key. Recognition is pinned to Latin-script languages so a
/// stylized glyph is never "guessed" into Arabic/Thai/CJK.
struct SheetTextRecognizer {
    struct Result: Sendable {
        let isSongStart: Bool
        let title: String?
        let tags: [String]
    }

    private let tagger = LocalTagger()

    /// Only the upper part of the page can hold a title (Vision y is bottom-up).
    private let titleTopFraction: CGFloat = 0.5
    /// The winning line must be at least this much taller than the median line.
    private let titleHeightRatio: Double = 1.15
    /// Latin-script languages only — never auto-detect (that's what lets Vision
    /// map a glyph to a non-Latin script).
    private static let languages = ["en-US", "vi-VN", "es-ES", "fr-FR"]
    /// Characters allowed in a title (Latin letters, digits, common punctuation).
    private static let titleWhitelist = "[^\\p{Latin}\\p{Nd}\\s&.,'’\"!?:()/\\-]"

    func analyze(_ image: UIImage, vocabulary: [String], customWords: [String]) async -> Result {
        guard let cg = image.uprightCGImage else { return Result(isSongStart: false, title: nil, tags: []) }

        // Pass 1: locate every line (correction off → stable boxes/splits).
        let lines = await recognizeLines(cg, correction: false, customWords: customWords)
        guard !lines.isEmpty else { return Result(isSongStart: false, title: nil, tags: []) }

        let pageText = lines.map(\.text).joined(separator: " ")
        let tags = tagger.tags(forText: pageText, vocabulary: vocabulary)

        let heights = lines.map { $0.box.height }.sorted()
        let bodyHeight = max(heights[heights.count / 2], 0.0001)   // median line height

        let candidates = lines.filter { $0.box.midY > titleTopFraction && isPlausibleTitle($0.text) }
        guard let best = candidates.max(by: { score($0, bodyHeight) < score($1, bodyHeight) }) else {
            return Result(isSongStart: false, title: nil, tags: tags)
        }
        guard Double(best.box.height) / Double(bodyHeight) >= titleHeightRatio else {
            return Result(isSongStart: false, title: nil, tags: tags)
        }

        // The title may span several same-size lines; treat them as one block.
        let block = titleBlock(best, in: candidates)
        let fallback = whitelisted(block.sorted { $0.box.midY > $1.box.midY }
                                        .map { $0.text }
                                        .joined(separator: " "))

        // Pass 2: zoom into just the title block and re-read it (correction on).
        let refined = await refineTitle(in: cg, region: unionBox(block), customWords: customWords)
        let title = (refined?.isEmpty == false) ? refined! : fallback
        return Result(isSongStart: !title.isEmpty, title: title.isEmpty ? nil : title, tags: tags)
    }

    // MARK: - Title selection

    /// Higher is more title-like: prefers larger text, nearer the top, centered,
    /// and short. Vertical weight lets the topmost heading beat a slightly bigger
    /// line lower on the page (e.g. a composer credit in a heavier font).
    private func score(_ line: Line, _ bodyHeight: CGFloat) -> Double {
        let relSize = Double(line.box.height / bodyHeight)
        let top = Double(line.box.midY)
        let center = 1 - Double(abs(line.box.midX - 0.5)) * 2
        let words = line.text.split(separator: " ").count
        let lengthPenalty = words > 8 ? Double(words - 8) * 0.15 : 0
        return relSize * 1.6 + top * 1.2 + center * 0.6 - lengthPenalty
    }

    /// Lines that are the same size as, aligned with, and adjacent to the winner.
    private func titleBlock(_ best: Line, in lines: [Line]) -> [Line] {
        let h = best.box.height
        return lines.filter { line in
            abs(line.box.height - h) <= h * 0.35 &&
            abs(line.box.midY - best.box.midY) <= h * 2.2 &&
            line.box.minX < best.box.maxX && best.box.minX < line.box.maxX   // horizontal overlap
        }
    }

    private func unionBox(_ lines: [Line]) -> CGRect {
        lines.dropFirst().reduce(lines.first?.box ?? .zero) { $0.union($1.box) }
    }

    private func isPlausibleTitle(_ raw: String) -> Bool {
        let t = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count >= 2, t.filter(\.isLetter).count >= 2 else { return false }   // skip "12", "♩=120"
        return !Self.creditPhrases.contains { t.contains($0) }
    }

    private static let creditPhrases = [
        "arr.", "arr ", "arranged", "music by", "words by", "lyrics by",
        "composed", "transcribed", "edited by", "words and music", "copyright",
        "©", "all rights reserved", "performed by", "as recorded",
    ]

    // MARK: - Focused re-read

    /// Crop the title region, upscale it, and OCR again so Vision puts its full
    /// recognition budget on the title's letters; pick the most-Latin candidate.
    private func refineTitle(in cg: CGImage, region: CGRect, customWords: [String]) async -> String? {
        let w = CGFloat(cg.width), h = CGFloat(cg.height)
        let pad: CGFloat = 0.04
        let minX = max(0, region.minX - pad), maxX = min(1, region.maxX + pad)
        let minY = max(0, region.minY - pad), maxY = min(1, region.maxY + pad)
        // Vision coords are bottom-left origin; CGImage cropping is top-left.
        let rect = CGRect(x: minX * w, y: (1 - maxY) * h,
                          width: (maxX - minX) * w, height: (maxY - minY) * h).integral
        guard rect.width > 1, rect.height > 1, let crop = cg.cropping(to: rect) else { return nil }

        let lines = await recognizeLines(upscaled(crop), correction: true, customWords: customWords)
        let text = lines.sorted { $0.box.midY > $1.box.midY }
                        .map { bestCandidate($0.candidates) }
                        .joined(separator: " ")
        return whitelisted(text)
    }

    /// Enlarge a small crop so glyphs have more pixels for the recognizer.
    private func upscaled(_ cg: CGImage, minHeight: CGFloat = 700) -> CGImage {
        let h = CGFloat(cg.height)
        guard h > 1, h < minHeight else { return cg }
        let scale = min(4, minHeight / h)
        let nw = Int(CGFloat(cg.width) * scale), nh = Int(h * scale)
        guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return cg }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: nw, height: nh))
        return ctx.makeImage() ?? cg
    }

    // MARK: - Latin filtering

    /// Of the recognizer's top candidates, pick the one with the highest share of
    /// Latin letters (a non-Latin misread scores low and is rejected).
    private func bestCandidate(_ candidates: [String]) -> String {
        candidates.max(by: { latinRatio($0) < latinRatio($1) }) ?? candidates.first ?? ""
    }

    private func latinRatio(_ text: String) -> Double {
        let letters = text.filter(\.isLetter)
        guard !letters.isEmpty else { return 0 }
        let latin = letters.filter { String($0).range(of: "\\p{Latin}", options: .regularExpression) != nil }.count
        return Double(latin) / Double(letters.count)
    }

    /// Strip any character outside the Latin whitelist; collapse whitespace.
    private func whitelisted(_ text: String) -> String {
        text.replacingOccurrences(of: Self.titleWhitelist, with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - OCR

    private struct Line {
        let candidates: [String]   // Vision top candidates, best first
        let box: CGRect            // normalized coords (origin bottom-left)
        var text: String { candidates.first ?? "" }
    }

    private func recognizeLines(_ cg: CGImage, correction: Bool, customWords: [String]) async -> [Line] {
        await withCheckedContinuation { continuation in
            let request = VNRecognizeTextRequest { req, _ in
                let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { o -> Line? in
                    let strings = o.topCandidates(3).map(\.string)
                    guard !strings.isEmpty else { return nil }
                    return Line(candidates: strings, box: o.boundingBox)
                }
                continuation.resume(returning: lines)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = correction
            request.automaticallyDetectsLanguage = false
            request.recognitionLanguages = Self.languages
            if !customWords.isEmpty { request.customWords = customWords }
            let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
            do { try handler.perform([request]) } catch { continuation.resume(returning: []) }
        }
    }
}

private extension UIImage {
    /// A CGImage with pixels in `.up` orientation, so Vision boxes and CGImage
    /// crops share one coordinate space.
    var uprightCGImage: CGImage? {
        if imageOrientation == .up { return cgImage }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format)
            .image { _ in draw(in: CGRect(origin: .zero, size: size)) }
            .cgImage
    }
}
