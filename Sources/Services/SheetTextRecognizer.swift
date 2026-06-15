import Vision
import UIKit

/// Fully on-device replacement for the old cloud classifier. Uses Apple's Vision
/// text recognition to read a page and infer, with simple heuristics:
///  - `isSongStart`: the page has a prominent heading near the top,
///  - `title`: that heading's text,
///  - `tags`: any vocabulary tag whose name literally appears in the page text.
/// No network, no API key.
struct SheetTextRecognizer {
    struct Result: Sendable {
        let isSongStart: Bool
        let title: String?
        let tags: [String]
    }

    /// A title heading must sit in the top fraction of the page…
    private let titleTopFraction: CGFloat = 0.6      // Vision y is bottom-up, so > 0.6 = top 40%
    /// …and be at least this much taller than the page's median line.
    private let titleHeightRatio: CGFloat = 1.3

    func analyze(_ image: UIImage, vocabulary: [String]) async -> Result {
        guard let cg = image.cgImage else { return Result(isSongStart: false, title: nil, tags: []) }
        let lines = await recognizeLines(cg, orientation: image.cgOrientation)
        guard !lines.isEmpty else { return Result(isSongStart: false, title: nil, tags: []) }

        let tags = matchedTags(in: lines, vocabulary: vocabulary)

        // Largest line in the top band is the title candidate.
        let topBand = lines.filter { $0.box.midY > titleTopFraction }
        let candidates = topBand.isEmpty ? lines : topBand
        guard let biggest = candidates.max(by: { $0.box.height < $1.box.height }) else {
            return Result(isSongStart: false, title: nil, tags: tags)
        }
        let heights = lines.map { $0.box.height }.sorted()
        let median = heights[heights.count / 2]
        let isTitle = biggest.box.midY > titleTopFraction && biggest.box.height >= median * titleHeightRatio
        let title = isTitle ? clean(biggest.text) : nil
        return Result(isSongStart: isTitle && title?.isEmpty == false, title: title, tags: tags)
    }

    // MARK: - Helpers

    private struct Line { let text: String; let box: CGRect }   // box in Vision normalized coords (origin bottom-left)

    private func recognizeLines(_ cg: CGImage, orientation: CGImagePropertyOrientation) async -> [Line] {
        await withCheckedContinuation { continuation in
            let request = VNRecognizeTextRequest { req, _ in
                let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { o -> Line? in
                    guard let best = o.topCandidates(1).first else { return nil }
                    return Line(text: best.string, box: o.boundingBox)
                }
                continuation.resume(returning: lines)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:])
            do { try handler.perform([request]) } catch { continuation.resume(returning: []) }
        }
    }

    private func matchedTags(in lines: [Line], vocabulary: [String]) -> [String] {
        let haystack = lines.map { $0.text.lowercased() }.joined(separator: " ")
        return vocabulary.filter { tag in
            let needle = tag.lowercased()
            return !needle.isEmpty && haystack.contains(needle)
        }
    }

    private func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension UIImage {
    /// Map the image's display orientation to the CG orientation Vision expects.
    var cgOrientation: CGImagePropertyOrientation {
        switch imageOrientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
