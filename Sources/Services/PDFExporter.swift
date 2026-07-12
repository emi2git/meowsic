import UIKit

/// Builds a print-ready PDF from a page plan. Entries are image pages (asset id,
/// loaded full-res from Photos), chord-text pages (monospaced text), or blanks.
/// US Letter portrait; images scaled-to-fit and centered, chord text laid out
/// inside the margins.
@MainActor
struct PDFExporter {
    let library: PhotoLibraryService

    private static let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792)   // US Letter @72dpi
    private static let chordMargin: CGFloat = 36

    func pdf(plan: [PrintPlanner.Entry]) async -> Data {
        var images: [String: UIImage] = [:]
        for id in Set(plan.compactMap(\.assetID)) {
            if let asset = library.asset(for: id), let image = await library.fullImage(for: asset) {
                images[id] = image
            }
        }
        let hasChord = plan.contains { $0.chordText != nil }
        let hasImage = plan.contains { $0.assetID != nil }
        // Bail only if there's nothing to draw. An image-only plan whose photos
        // all failed to load = useless PDF; a chord-only plan = always renderable.
        guard hasChord || (hasImage && !images.isEmpty) else { return Data() }

        let page = Self.pageRect
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        return renderer.pdfData { ctx in
            for entry in plan {
                ctx.beginPage()
                if let id = entry.assetID, let image = images[id] {
                    drawImage(image, in: page)
                } else if let text = entry.chordText {
                    drawChord(text, in: page)
                }
                // blank entry or unavailable image → empty page
            }
        }
    }

    private func drawImage(_ image: UIImage, in page: CGRect) {
        let s = image.size
        guard s.width > 0, s.height > 0 else { return }
        let scale = min(page.width / s.width, page.height / s.height)
        let w = s.width * scale, h = s.height * scale
        image.draw(in: CGRect(x: (page.width - w) / 2, y: (page.height - h) / 2, width: w, height: h))
    }

    private func drawChord(_ text: String, in page: CGRect) {
        let rect = page.insetBy(dx: Self.chordMargin, dy: Self.chordMargin)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byClipping
        let attrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .paragraphStyle: style,
        ]
        (text as NSString).draw(in: rect, withAttributes: attrs)
    }
}
