import CoreImage
import UIKit

/// Cheap on-device gate: a photo is treated as a music sheet only if its four
/// corners share (near-)the same color — a uniform paper background filling the
/// frame. Anything else is ignored during Add Songs.
struct CornerColorPrefilter {
    /// Max allowed per-channel difference (0–255) between any two corner colors.
    var tolerance: Double = 22
    /// Corner patch size as a fraction of the shorter edge.
    var patchFraction: CGFloat = 0.06

    private static let context = CIContext(options: [.workingColorSpace: NSNull()])

    func looksLikeSheet(_ image: UIImage) -> Bool {
        guard let cg = image.cgImage else { return true }   // can't tell → accept
        let w = CGFloat(cg.width), h = CGFloat(cg.height)
        guard w > 0, h > 0 else { return true }

        let ci = CIImage(cgImage: cg)
        let p = max(2, min(w, h) * patchFraction)
        let rects = [
            CGRect(x: 0, y: 0, width: p, height: p),           // bottom-left
            CGRect(x: w - p, y: 0, width: p, height: p),       // bottom-right
            CGRect(x: 0, y: h - p, width: p, height: p),       // top-left
            CGRect(x: w - p, y: h - p, width: p, height: p),   // top-right
        ]

        var colors: [SIMD3<Double>] = []
        for rect in rects {
            guard let c = averageColor(of: ci, in: rect) else { return true }
            colors.append(c)
        }

        // All four corners within tolerance of each other on every channel?
        for i in colors.indices {
            for j in (i + 1)..<colors.count {
                let a = colors[i], b = colors[j]
                if abs(a.x - b.x) > tolerance || abs(a.y - b.y) > tolerance || abs(a.z - b.z) > tolerance {
                    return false
                }
            }
        }
        return true
    }

    private func averageColor(of image: CIImage, in rect: CGRect) -> SIMD3<Double>? {
        guard let filter = CIFilter(name: "CIAreaAverage", parameters: [
            kCIInputImageKey: image,
            kCIInputExtentKey: CIVector(cgRect: rect),
        ]), let output = filter.outputImage else { return nil }

        var bitmap = [UInt8](repeating: 0, count: 4)
        Self.context.render(output, toBitmap: &bitmap, rowBytes: 4,
                            bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                            format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return SIMD3(Double(bitmap[0]), Double(bitmap[1]), Double(bitmap[2]))
    }
}
