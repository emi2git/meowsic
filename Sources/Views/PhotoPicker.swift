import SwiftUI
import PhotosUI
import Photos

/// Multi-select photo picker. Returns the chosen items as `PHAsset`s (backed by
/// `PHPhotoLibrary.shared()`) so they can be deduped and stored by stable local
/// identifier, in the order the user picked them.
struct PhotoPicker: UIViewControllerRepresentable {
    var onPicked: ([PHAsset]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 0                     // unlimited
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPicked: ([PHAsset]) -> Void
        init(onPicked: @escaping ([PHAsset]) -> Void) { self.onPicked = onPicked }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let ids = results.compactMap(\.assetIdentifier)
            guard !ids.isEmpty else { onPicked([]); return }

            let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            var assets: [PHAsset] = []
            fetched.enumerateObjects { a, _, _ in assets.append(a) }

            // PHAsset fetch order isn't the pick order — restore the user's order.
            let rank = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
            assets.sort { (rank[$0.localIdentifier] ?? 0) < (rank[$1.localIdentifier] ?? 0) }
            onPicked(assets)
        }
    }
}
