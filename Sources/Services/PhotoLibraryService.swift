import Photos
import UIKit

/// Reads photos from the library, including iCloud-only originals
/// (downloaded on demand via `isNetworkAccessAllowed`).
@MainActor
@Observable
final class PhotoLibraryService {
    var status: PHAuthorizationStatus = .notDetermined
    private var byID: [String: PHAsset] = [:]
    private let manager = PHCachingImageManager()

    func requestAccess() async {
        status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    /// Map local asset ids → stable iCloud cloud-identifier strings (for cross-device backup).
    func cloudIDs(for localIDs: [String]) -> [String: String] {
        guard !localIDs.isEmpty else { return [:] }
        let mappings = PHPhotoLibrary.shared().cloudIdentifierMappings(forLocalIdentifiers: localIDs)
        var out: [String: String] = [:]
        for (local, result) in mappings {
            if case let .success(cloud) = result { out[local] = cloud.stringValue }
        }
        return out
    }

    /// Map iCloud cloud-identifier strings → this device's local asset ids.
    func localIDs(forCloud cloudStrings: [String]) -> [String: String] {
        guard !cloudStrings.isEmpty else { return [:] }
        let cloudIDs = cloudStrings.map { PHCloudIdentifier(stringValue: $0) }
        let mappings = PHPhotoLibrary.shared().localIdentifierMappings(for: cloudIDs)
        var out: [String: String] = [:]
        for (cloud, result) in mappings {
            if case let .success(local) = result { out[cloud.stringValue] = local }
        }
        return out
    }

    func asset(for id: String) -> PHAsset? {
        if let a = byID[id] { return a }
        let a = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
        if let a { byID[id] = a }
        return a
    }

    /// Photos to scan next:
    /// - first ever scan (`after == nil`) → all photos in the library
    /// - otherwise → only photos newer than the last one scanned
    func assetsToScan(after date: Date?) -> [PHAsset] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        if let date {
            options.predicate = NSPredicate(format: "creationDate > %@", date as NSDate)
        }
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var arr: [PHAsset] = []
        result.enumerateObjects { a, _, _ in arr.append(a) }
        for a in arr { byID[a.localIdentifier] = a }
        return arr
    }

    func thumbnail(for asset: PHAsset, size: CGSize) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        return await requestImage(asset, targetSize: size, contentMode: .aspectFill, options: options)
    }

    func fullImage(for asset: PHAsset) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        return await requestImage(asset, targetSize: PHImageManagerMaximumSize, contentMode: .aspectFit, options: options)
    }

    /// Cheap, on-device-only thumbnail for the corner-color pre-filter — does NOT
    /// download from iCloud, so non-sheet photos are rejected without a download.
    /// Returns nil if no cached thumbnail exists (then we fall back to the full image).
    func prefilterThumbnail(for asset: PHAsset) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = false
        options.deliveryMode = .fastFormat
        options.resizeMode = .fast
        return await withCheckedContinuation { continuation in
            var resumed = false
            manager.requestImage(for: asset, targetSize: CGSize(width: 256, height: 256),
                                 contentMode: .aspectFit, options: options) { image, _ in
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: image)
            }
        }
    }

    /// Downscaled image (downloads from iCloud if needed) for the Claude call.
    func analysisImage(for asset: PHAsset) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        return await requestImage(asset, targetSize: CGSize(width: 640, height: 640),
                                  contentMode: .aspectFit, options: options)
    }

    private func requestImage(_ asset: PHAsset, targetSize: CGSize,
                              contentMode: PHImageContentMode,
                              options: PHImageRequestOptions) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var resumed = false
            manager.requestImage(for: asset, targetSize: targetSize,
                                 contentMode: contentMode, options: options) { image, info in
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                if degraded { return }                 // wait for the final, full-res image
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: image)
            }
        }
    }
}
