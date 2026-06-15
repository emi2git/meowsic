import UIKit

/// Builds a print-ready PDF from a page plan. Each plan entry is an asset id
/// (a page, loaded full-res from Photos) or nil (a blank page). US Letter
/// portrait, every image scaled to fit and centered.
@MainActor
struct PDFExporter {
    let library: PhotoLibraryService

    func pdf(plan: [String?]) async -> Data {
        var images: [String: UIImage] = [:]
        for id in Set(plan.compactMap { $0 }) {
            if let asset = library.asset(for: id), let image = await library.fullImage(for: asset) {
                images[id] = image
            }
        }
        guard !images.isEmpty else { return Data() }

        let page = CGRect(x: 0, y: 0, width: 612, height: 792)   // US Letter @72dpi
        let renderer = UIGraphicsPDFRenderer(bounds: page)
        return renderer.pdfData { ctx in
            for item in plan {
                ctx.beginPage()
                guard let id = item, let image = images[id] else { continue }   // nil → blank page
                let s = image.size
                guard s.width > 0, s.height > 0 else { continue }
                let scale = min(page.width / s.width, page.height / s.height)
                let w = s.width * scale, h = s.height * scale
                image.draw(in: CGRect(x: (page.width - w) / 2, y: (page.height - h) / 2, width: w, height: h))
            }
        }
    }
}
