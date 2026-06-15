import SwiftUI

/// Loads a photo by asset id (downloading from iCloud if needed).
struct AssetImageView: View {
    @Environment(PhotoLibraryService.self) private var library
    let assetID: String
    var targetSize = CGSize(width: 200, height: 200)
    var full = false

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(.secondarySystemBackground)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                ProgressView()
            }
        }
        .task(id: assetID) {
            guard let asset = library.asset(for: assetID) else { return }
            image = full ? await library.fullImage(for: asset)
                         : await library.thumbnail(for: asset, size: targetSize)
        }
    }
}
