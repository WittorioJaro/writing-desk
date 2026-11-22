import Foundation
import SQLite3
import WritingDeskCore

public struct DatabaseError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

/// The sync server's database: a single SQLite file.
///
///     docs(kind, id, json)   kind = article | idea | meta
///
/// Articles and ideas are one row each, so the file is easy to inspect: `sqlite3 writing-desk.sqlite "select ..."`.
/// `meta` holds the goal + per-Mac word history (`accountability`) and deletion markers (`tombstones`).
public final class SyncDatabase {
    private var db: OpaquePointer?
    public let url: URL
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(url: URL) throws {
        self.url = url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open(url.path, &db) == SQLITE_OK else {
            defer { sqlite3_close(db) }
            throw DatabaseError(message: "Can't open \(url.path): \(String(cString: sqlite3_errmsg(db)))")
        }
        try exec("PRAGMA journal_mode=WAL")
        try exec("CREATE TABLE IF NOT EXISTS docs(kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind, id))")
    }

    deinit { sqlite3_close(db) }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(err)
            throw DatabaseError(message: msg)
        }
    }

    public func load() throws -> AppState {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT kind, id, json FROM docs", -1, &stmt, nil) == SQLITE_OK else {
            throw DatabaseError(message: String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        let dec = JSONCoding.decoder()
        var s = AppState()
        while sqlite3_step(stmt) == SQLITE_ROW {
            let kind = String(cString: sqlite3_column_text(stmt, 0))
            let id = String(cString: sqlite3_column_text(stmt, 1))
            let json = Data(String(cString: sqlite3_column_text(stmt, 2)).utf8)
            switch (kind, id) {
            case ("article", _): s.articles.append(try dec.decode(Article.self, from: json))
            case ("idea", _): s.ideas.append(try dec.decode(Idea.self, from: json))
            case ("meta", "accountability"): s.accountability = try dec.decode(Accountability.self, from: json)
            case ("meta", "tombstones"): s.tombstones = try dec.decode([String: Date].self, from: json)
            default: break
            }
        }
        return Sync.normalized(s)
    }

    /// Replaces the stored state in one transaction.
    public func save(_ s: AppState) throws {
        let enc = JSONCoding.encoder(pretty: false)
        var rows: [(String, String, String)] = []
        for a in s.articles { rows.append(("article", a.id.uuidString, String(decoding: try enc.encode(a), as: UTF8.self))) }
        for i in s.ideas { rows.append(("idea", i.id.uuidString, String(decoding: try enc.encode(i), as: UTF8.self))) }
        rows.append(("meta", "accountability", String(decoding: try enc.encode(s.accountability), as: UTF8.self)))
        rows.append(("meta", "tombstones", String(decoding: try enc.encode(s.tombstones), as: UTF8.self)))

        try exec("BEGIN IMMEDIATE")
        do {
            try exec("DELETE FROM docs")
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO docs(kind, id, json) VALUES (?, ?, ?)", -1, &stmt, nil) == SQLITE_OK else {
                throw DatabaseError(message: String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            for (kind, id, json) in rows {
                sqlite3_reset(stmt)
                sqlite3_bind_text(stmt, 1, kind, -1, Self.transient)
                sqlite3_bind_text(stmt, 2, id, -1, Self.transient)
                sqlite3_bind_text(stmt, 3, json, -1, Self.transient)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw DatabaseError(message: String(cString: sqlite3_errmsg(db))) }
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    /// Writes one snapshot per day into `dir` (`yyyy-MM-dd.sqlite`) and keeps the newest `keep`.
    public func backupIfNeeded(into dir: URL, now: Date = Date(), keep: Int = 14) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(Accountability.dayKey(now) + ".sqlite")
        guard !fm.fileExists(atPath: target.path) else { return }
        try exec("VACUUM INTO '\(target.path.replacingOccurrences(of: "'", with: "''"))'")
        let snapshots = try fm.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".sqlite") }.sorted()
        for old in snapshots.dropLast(keep) { try? fm.removeItem(at: dir.appendingPathComponent(old)) }
    }
}
