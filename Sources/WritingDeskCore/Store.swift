import Foundation

/// Local-only JSON persistence. Nothing here touches the network.
///
/// Layout (default root `~/Library/Application Support/WritingDesk`, override with `WRITING_DESK_HOME`):
///   state.json           articles, ideas, goal + history
///   inbox/               drop .txt / .md files with ideas from Elon here
///   inbox/imported/      processed inbox files are moved here
///   covers/              default PNG export location
public final class Store {
    public let root: URL
    public var stateURL: URL { root.appendingPathComponent("state.json") }
    public var inboxURL: URL { root.appendingPathComponent("inbox", isDirectory: true) }
    public var coversURL: URL { root.appendingPathComponent("covers", isDirectory: true) }

    public static var defaultRoot: URL {
        if let env = ProcessInfo.processInfo.environment["WRITING_DESK_HOME"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WritingDesk", isDirectory: true)
    }

    public init(root: URL = Store.defaultRoot) throws {
        self.root = root
        let fm = FileManager.default
        for dir in [root, inboxURL, inboxURL.appendingPathComponent("imported"), coversURL] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    public func load() throws -> AppState {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return AppState() }
        let data = try Data(contentsOf: stateURL)
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try dec.decode(AppState.self, from: data)
    }

    public func save(_ state: AppState) throws {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(state).write(to: stateURL, options: .atomic)
    }
}
