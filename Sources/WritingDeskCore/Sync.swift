import Foundation

/// Merge rules shared by the server and the app. `merge` is commutative and idempotent, so any
/// number of Macs can sync in any order and converge on the same state.
public enum Sync {
    /// Stable content fingerprint (title + body) used to tell whether an article changed.
    public static func fingerprint(_ a: Article) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for b in a.title.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        h = (h ^ 0xff) &* 0x100000001b3
        for b in a.body.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return h
    }

    static func newer(_ a: Article, _ b: Article) -> Article {
        if a.updated != b.updated { return a.updated > b.updated ? a : b }
        return fingerprint(a) >= fingerprint(b) ? a : b   // deterministic tie-break
    }

    static func newer(_ a: Idea, _ b: Idea) -> Idea {
        if a.lastChange != b.lastChange { return a.lastChange > b.lastChange ? a : b }
        if a.done != b.done { return a.done ? a : b }
        return a.text >= b.text ? a : b
    }

    public static func merge(_ x: AppState, _ y: AppState) -> AppState {
        var out = AppState()
        out.tombstones = x.tombstones.merging(y.tombstones, uniquingKeysWith: max)

        var articles: [UUID: Article] = [:]
        for a in x.articles + y.articles { articles[a.id] = articles[a.id].map { newer($0, a) } ?? a }
        out.articles = articles.values.filter { a in
            guard let deleted = out.tombstones[a.id.uuidString] else { return true }
            return a.updated > deleted   // edited after deletion -> keep
        }

        var ideas: [UUID: Idea] = [:]
        for i in x.ideas + y.ideas { ideas[i.id] = ideas[i.id].map { newer($0, i) } ?? i }
        out.ideas = Array(ideas.values)

        var acc = Accountability()
        for (device, days) in x.accountability.byDevice.merging(y.accountability.byDevice, uniquingKeysWith: { $0.merging($1, uniquingKeysWith: max) }) {
            acc.byDevice[device] = days
        }
        let gx = x.accountability, gy = y.accountability
        switch (gx.goalUpdated, gy.goalUpdated) {
        case let (a?, b?) where a != b: (acc.dailyGoal, acc.goalUpdated) = a > b ? (gx.dailyGoal, a) : (gy.dailyGoal, b)
        case (_?, nil): (acc.dailyGoal, acc.goalUpdated) = (gx.dailyGoal, gx.goalUpdated)
        case (nil, _?): (acc.dailyGoal, acc.goalUpdated) = (gy.dailyGoal, gy.goalUpdated)
        default: (acc.dailyGoal, acc.goalUpdated) = (max(gx.dailyGoal, gy.dailyGoal), gx.goalUpdated)
        }
        out.accountability = acc
        return normalized(out)
    }

    /// Canonical ordering: newest articles first, ideas in the order they arrived.
    public static func normalized(_ s: AppState) -> AppState {
        var s = s
        s.articles.sort { $0.created != $1.created ? $0.created > $1.created : $0.id.uuidString < $1.id.uuidString }
        s.ideas.sort { $0.added != $1.added ? $0.added < $1.added : $0.id.uuidString < $1.id.uuidString }
        return s
    }

    /// Deterministic id for a conflict copy, so retrying the same sync never creates duplicates.
    static func conflictID(_ a: Article) -> UUID {
        var h1: UInt64 = 0xcbf29ce484222325
        for b in a.id.uuidString.utf8 { h1 = (h1 ^ UInt64(b)) &* 0x100000001b3 }
        let h2 = fingerprint(a) ^ 0x9E3779B97F4A7C15
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<8 { bytes[i] = UInt8(truncatingIfNeeded: h1 >> (8 * UInt64(i))); bytes[8 + i] = UInt8(truncatingIfNeeded: h2 >> (8 * UInt64(i))) }
        bytes[6] = (bytes[6] & 0x0F) | 0x40; bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// The server's merge. `bases` are the fingerprints the client last got from the server, which tells
    /// "I edited your version" (fast-forward) apart from "we both edited it" (conflict).
    ///
    /// On a conflict nothing is dropped: the newer edit stays as the article and the other one is
    /// kept as a separate "(conflict copy)" article. An article deleted elsewhere but edited by
    /// this client since its last sync is kept.
    public static func serverMerge(stored: AppState, incoming: AppState, bases: [String: UInt64]) -> (state: AppState, conflicts: Int) {
        var out = merge(stored, incoming)
        var byID = Dictionary(out.articles.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let storedByID = Dictionary(stored.articles.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var conflicts = 0
        for inc in incoming.articles {
            let key = inc.id.uuidString, fi = fingerprint(inc), base = bases[key]
            if let st = storedByID[inc.id] {
                let fs = fingerprint(st)
                if fi == fs { continue }
                if base == fs {                       // client edited the server's version
                    var ff = inc; ff.updated = max(inc.updated, st.updated); byID[inc.id] = ff
                } else if base == fi {                // client is just behind
                    byID[inc.id] = st
                } else {                              // both changed since the client's base
                    let winner = newer(st, inc), loser = winner.id == st.id && fingerprint(winner) == fs ? inc : st
                    byID[inc.id] = winner
                    let copyID = conflictID(loser)
                    if byID[copyID] == nil {
                        var copy = Article(id: copyID, title: loser.title + " (conflict copy)", body: loser.body, created: winner.updated)
                        copy.updated = loser.updated
                        byID[copyID] = copy
                        conflicts += 1
                    }
                }
            } else if let deleted = out.tombstones[key], base == nil || fi != base {
                var keep = inc                        // deleted elsewhere, edited here: keep the writing
                keep.updated = max(inc.updated, deleted.addingTimeInterval(1))
                byID[inc.id] = keep
            }
        }
        out.articles = Array(byID.values)
        return (normalized(out), conflicts)
    }

    public struct Reconciled {
        public var state: AppState
        /// Per article: the server version this Mac's copy is based on.
        public var base: [String: UInt64]
    }

    /// Applies the server's response locally. The server's version wins, except for edits made
    /// on this Mac while the request was in flight: those are kept and pushed next time.
    public static func reconcile(local: AppState, sent: AppState, response: AppState, base oldBase: [String: UInt64]) -> Reconciled {
        var out = merge(response, local)   // ideas, word counts, goal, tombstones
        let sentByID = Dictionary(sent.articles.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var byID = Dictionary(response.articles.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for l in local.articles {
            if let s = sentByID[l.id], fingerprint(s) == fingerprint(l) { continue }   // unchanged: server decides
            var keep = l                                                               // new or edited in flight
            if let r = byID[l.id] { keep.updated = max(l.updated, r.updated) }
            if let deleted = out.tombstones[l.id.uuidString], keep.updated <= deleted {
                keep.updated = deleted.addingTimeInterval(1)
            }
            byID[l.id] = keep
        }
        // Drop articles deleted locally while the request was in flight.
        out.articles = byID.values.filter { a in out.tombstones[a.id.uuidString].map { a.updated > $0 } ?? true }
        var base: [String: UInt64] = [:]
        for r in response.articles {
            let key = r.id.uuidString, fr = fingerprint(r)
            if let final = byID[r.id], fingerprint(final) == fr { base[key] = fr }
            else if let s = sentByID[r.id] { base[key] = fingerprint(s) }
            else if let old = oldBase[key] { base[key] = old }
        }
        return Reconciled(state: normalized(out), base: base)
    }
}

/// Wire format for `POST /v1/sync`.
public struct SyncRequest: Codable {
    public var state: AppState
    public var bases: [String: UInt64]
    public init(state: AppState, bases: [String: UInt64]) { self.state = state; self.bases = bases }
}

public struct SyncResponse: Codable {
    public var state: AppState
    public var conflicts: Int
    public init(state: AppState, conflicts: Int) { self.state = state; self.conflicts = conflicts }
}

/// Where this Mac syncs to. Stored in `sync.json` next to `state.json`.
public struct SyncConfig: Codable, Equatable {
    public var serverURL: String = ""
    public var enabled: Bool = false
    public init(serverURL: String = "", enabled: Bool = false) {
        self.serverURL = serverURL
        self.enabled = enabled
    }

    public var url: URL? {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: trimmed), let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != nil else { return nil }
        return u
    }
}

public struct SyncState: Codable, Equatable {
    public var base: [String: UInt64] = [:]
    public var lastSync: Date?
    public init() {}
}

public enum SyncError: Error, LocalizedError {
    case badURL
    case server(Int, String)
    public var errorDescription: String? {
        switch self {
        case .badURL: "Sync server URL isn't valid (expected http://host:port)"
        case let .server(code, msg): "Server returned \(code): \(msg)"
        }
    }
}

/// Talks to the Writing Desk sync server (see `WritingDeskServer`). Only ever contacts the URL you configure.
public enum SyncClient {
    public static func exchange(_ request: SyncRequest, server: URL, timeout: TimeInterval = 20) async throws -> SyncResponse {
        var req = URLRequest(url: server.appendingPathComponent("v1/sync"), timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONCoding.encoder(pretty: false).encode(request)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw SyncError.server(code, String(decoding: data.prefix(300), as: UTF8.self)) }
        return try JSONCoding.decoder().decode(SyncResponse.self, from: data)
    }
}
