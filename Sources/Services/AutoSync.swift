// AutoSync.swift
// Glue between meowsic's existing CloudSync blob-sync and the app lifecycle so
// two devices stay in step without the user touching Settings → Cloud sync.
// Mirrors meowzi's AutoSync.
//
// Triggers:
//   * `start()`        — call once on first appear. Pulls the latest snapshot
//                        (if the cloud is newer than what we last synced) and
//                        THEN enables pushing. Gating push behind the first pull
//                        stops a fresh install — which seeds default tags on
//                        launch — from clobbering the real cloud backup with a
//                        near-empty database before it has pulled.
//   * `pullIfNeeded()` — call on scene .active. Debounced against rapid
//                        foreground/background bouncing (10 s minimum).
//   * `pushSoon()`     — call after any user-data write. Debounces to a single
//                        push 3 s after the last write.
//   * `flush()`        — call on scene .background. Cancels the debounce timer
//                        and pushes immediately if anything is pending, under a
//                        background-task assertion so the upload can finish.
//
// Push coverage rides on `ModelContext.didSave`, which fires for every SwiftData
// mutation (photos, tags, renames, groups, boundaries, chords, hide/restore).
//
// Conflict handling is whole-blob last-write-wins, gated by a version token:
// `SyncStore.lastVersion` records the cloud row's `updated_at` as of our last
// push/pull, and a pull only imports when the remote row is strictly newer. That
// keeps a device from re-importing its own upload or overwriting newer local
// state with a stale snapshot. (meowsic's models carry no per-row timestamps, so
// per-row LWW merge like meowzi's isn't possible — the granularity is the blob.)

import Foundation
import SwiftData
import UIKit

@MainActor
final class AutoSync {
    private weak var coordinator: AnalysisCoordinator?

    private var pushTask: Task<Void, Never>?
    private var pendingPush = false
    private var pushEnabled = false
    private var isApplyingRemote = false
    private var isPulling = false
    private var lastPullAt: Date = .distantPast

    /// Minimum interval between successive foreground pulls. Prevents thrash when
    /// the user briefly swipes to the App Switcher and back.
    private let pullCooldown: TimeInterval = 10
    /// Debounce window after a write before we actually push. Coalesces bursts
    /// (bulk re-tag, rapid edits) into one round trip.
    private let pushDebounce: UInt64 = 3_000_000_000 // 3 s

    nonisolated(unsafe) private var saveObserver: NSObjectProtocol?

    init(coordinator: AnalysisCoordinator) {
        self.coordinator = coordinator
        // Every SwiftData write → schedule a push.
        self.saveObserver = NotificationCenter.default.addObserver(
            forName: ModelContext.didSave, object: nil, queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.pushSoon() }
        }
    }

    deinit {
        if let o = saveObserver { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: - Lifecycle hooks

    /// First-appear entry point: pull once, then allow pushes. Safe to call when
    /// sync isn't configured (both steps no-op).
    func start() async {
        await performPull(force: true)
        pushEnabled = true
    }

    /// Pull the latest snapshot and import it if the cloud is newer than our last
    /// sync. Bounces if called more often than `pullCooldown` apart.
    func pullIfNeeded() async {
        let now = Date()
        guard now.timeIntervalSince(lastPullAt) >= pullCooldown else { return }
        await performPull(force: false)
    }

    /// Schedule a push 3 s after the most recent write. Subsequent calls within
    /// the window reset the timer.
    func pushSoon() {
        guard pushEnabled, !isApplyingRemote, SyncStore.isConfigured else { return }
        pendingPush = true
        pushTask?.cancel()
        pushTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.pushDebounce)
            if Task.isCancelled { return }
            await self.performPush()
        }
    }

    /// Immediate push — used on backgrounding so any pending edits land before
    /// the OS suspends us. Cancels any in-flight debounce and holds a background
    /// assertion for the duration of the upload.
    func flush() async {
        pushTask?.cancel()
        pushTask = nil
        guard pushEnabled, pendingPush, SyncStore.isConfigured else { return }
        let app = UIApplication.shared
        var bg = app.beginBackgroundTask(withName: "MeowsicSyncUpload")
        defer { if bg != .invalid { app.endBackgroundTask(bg); bg = .invalid } }
        await performPush()
    }

    // MARK: - Internals

    private func performPush() async {
        guard SyncStore.isConfigured, let coordinator else { return }
        pendingPush = false
        do {
            let version = try await CloudSync().upload(coordinator.exportData())
            if !version.isEmpty { SyncStore.lastVersion = version }
        } catch {
            // Re-arm so the next write / background flush retries.
            pendingPush = true
            #if DEBUG
            print("[AutoSync] push failed: \(error.localizedDescription)")
            #endif
        }
    }

    private func performPull(force: Bool) async {
        guard SyncStore.isConfigured, let coordinator, !isPulling else { return }
        isPulling = true
        defer { isPulling = false }
        lastPullAt = Date()
        do {
            let remote = try await CloudSync().fetchRemote()
            // Nothing newer than what we last synced → skip the destructive import.
            guard remote.version != SyncStore.lastVersion else { return }
            isApplyingRemote = true
            defer { isApplyingRemote = false }
            _ = await coordinator.importData(remote.payload)
            SyncStore.lastVersion = remote.version
        } catch CloudSync.SyncError.empty {
            // No backup for this code yet — nothing to pull.
        } catch CloudSync.SyncError.notConfigured {
            // Settings half-filled — silent.
        } catch {
            #if DEBUG
            print("[AutoSync] pull failed: \(error.localizedDescription)")
            #endif
        }
    }
}
