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

    public init(store: Store) {
        self.store = store
        do {
            state = try store.load()
            loadError = nil
        } catch {
            state = AppState()
            loadError = "Couldn't read \(store.stateURL.path) (\(error.localizedDescription)). The file was left untouched."
        }
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
