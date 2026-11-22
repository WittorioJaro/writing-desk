import Foundation

public enum WorkspaceError: Error, LocalizedError, Equatable {
    case readOnly(String)
    public var errorDescription: String? {
        switch self { case .readOnly(let why): "Writing is disabled: \(why)" }
    }
}

/// Owns the in-memory state and is the only thing that writes `state.json`.
///
/// Safety rule: if an existing `state.json` can't be read or decoded, the workspace opens
/// **read-only**. It never writes (no edits, no inbox import), so the original file is left
/// exactly as it was for recovery. A missing file is fine: that's a fresh, writable workspace.
public final class Workspace {
    public let store: Store
    public private(set) var state: AppState
    /// Set when `state.json` exists but couldn't be loaded. Writes stay blocked until a relaunch loads cleanly.
    public let loadError: String?
    public var isWritable: Bool { loadError == nil }
    /// Random per-Mac id, so each Mac's word counts merge without double counting.
    public let deviceID: String
    public private(set) var syncConfig: SyncConfig
    public private(set) var syncState: SyncState

    public init(store: Store) {
        self.store = store
        do {
            state = try store.load()
            loadError = nil
        } catch {
            state = AppState()
            loadError = "Couldn't read \(store.stateURL.path) (\(error.localizedDescription)). The file was left untouched."
        }
        if let id = try? String(contentsOf: store.deviceIDURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty {
            deviceID = id
        } else {
            deviceID = UUID().uuidString
            try? deviceID.write(to: store.deviceIDURL, atomically: true, encoding: .utf8)
        }
        let dec = JSONCoding.decoder()
        syncConfig = (try? Data(contentsOf: store.syncConfigURL)).flatMap { try? dec.decode(SyncConfig.self, from: $0) } ?? SyncConfig()
        syncState = (try? Data(contentsOf: store.syncStateURL)).flatMap { try? dec.decode(SyncState.self, from: $0) } ?? SyncState()
        if isWritable {
            // v1 migration (in memory; saved with the next write): give old history this Mac's id,
            // and mark a goal changed from the default as set, so an empty server can't reset it.
            state.accountability.renameDevice(Accountability.legacyDevice, to: deviceID)
            if state.accountability.goalUpdated == nil && state.accountability.dailyGoal != 500 {
                state.accountability.goalUpdated = Date(timeIntervalSince1970: 1)
            }
        }
    }

    public func setSyncConfig(_ config: SyncConfig) throws {
        try JSONCoding.encoder().encode(config).write(to: store.syncConfigURL, options: .atomic)
        syncConfig = config
    }

    public struct SyncOutcome: Equatable {
        /// Conflict copies the server created in this sync.
        public var conflicts: Int
        /// Local state has changes the server doesn't have yet (sync again soon).
        public var needsPush: Bool
    }

    /// What to send to the server: the current state plus the server versions it's based on.
    public func makeSyncRequest() -> SyncRequest { SyncRequest(state: state, bases: syncState.base) }

    /// Folds a server response into local state (see `Sync.reconcile`) and saves it. Blocked when read-only.
    public func applySync(sent: SyncRequest, response: SyncResponse, now: Date = Date()) throws -> SyncOutcome {
        guard isWritable else { throw WorkspaceError.readOnly(loadError ?? "") }
        let r = Sync.reconcile(local: state, sent: sent.state, response: response.state, base: sent.bases)
        state = r.state
        try store.save(state)
        syncState.base = r.base
        syncState.lastSync = now
        try JSONCoding.encoder().encode(syncState).write(to: store.syncStateURL, options: .atomic)
        return SyncOutcome(conflicts: response.conflicts, needsPush: state != Sync.normalized(response.state))
    }

    /// Applies `change` and saves it. Throws `.readOnly` (and changes nothing) if the load failed.
    /// If only the save fails, the change stays in memory so the next successful save keeps it.
    public func mutate(_ change: (inout AppState) -> Void) throws {
        guard isWritable else { throw WorkspaceError.readOnly(loadError ?? "") }
        change(&state)
        try store.save(state)
    }

    /// Imports Elon's inbox, saving before any file is archived. Blocked when read-only.
    public func importInbox(now: Date = Date()) throws -> IdeasInbox.ImportResult {
        guard isWritable else { throw WorkspaceError.readOnly(loadError ?? "") }
        return IdeasInbox.importInbox(store: store, into: &state, now: now, persist: store.save)
    }
}
