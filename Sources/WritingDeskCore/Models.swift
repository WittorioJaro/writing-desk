import Foundation

/// An article written by Victor. Article text is only ever typed by the user.
public struct Article: Codable, Identifiable, Equatable {
    public var id: UUID
    public var title: String
    public var body: String
    public var created: Date
    public var updated: Date

    public init(id: UUID = UUID(), title: String = "Untitled", body: String = "", created: Date = Date()) {
        self.id = id
        self.title = title
        self.body = body
        self.created = created
        self.updated = created
    }

    public var wordCount: Int { WordCounter.count(body) }
}

/// A prompt / idea / thing to think about supplied by Elon. Kept separate from articles.
public struct Idea: Codable, Identifiable, Equatable {
    public var id: UUID
    public var text: String
    public var source: String
    public var added: Date
    public var done: Bool
    /// Last change (e.g. ticking it done). Used to pick the newest version when syncing.
    public var updated: Date?

    public init(id: UUID = UUID(), text: String, source: String, added: Date = Date(), done: Bool = false) {
        self.id = id
        self.text = text
        self.source = source
        self.added = added
        self.done = done
    }

    var lastChange: Date { updated ?? added }
}

public struct AppState: Codable, Equatable {
    public var articles: [Article] = []
    public var ideas: [Idea] = []
    public var accountability = Accountability()
    /// Deleted article id -> deletion time, so deletions sync between Macs.
    public var tombstones: [String: Date] = [:]
    public init() {}

    enum CodingKeys: String, CodingKey { case articles, ideas, accountability, tombstones }

    // Every field is optional on decode so files written by older versions still load.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        articles = try c.decodeIfPresent([Article].self, forKey: .articles) ?? []
        ideas = try c.decodeIfPresent([Idea].self, forKey: .ideas) ?? []
        accountability = try c.decodeIfPresent(Accountability.self, forKey: .accountability) ?? Accountability()
        tombstones = try c.decodeIfPresent([String: Date].self, forKey: .tombstones) ?? [:]
    }
}

/// Shared JSON settings for disk and network. Dates are written as exact seconds since 2001-01-01 (so they
/// round-trip without precision loss between Macs); ISO-8601 strings from v1 files still decode.
public enum JSONCoding {
    public static func encoder(pretty: Bool = true) -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer()
            try c.encode(date.timeIntervalSinceReferenceDate)
        }
        if pretty { e.outputFormatting = [.prettyPrinted, .sortedKeys] }
        return e
    }

    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let c = try dec.singleValueContainer()
            if let t = try? c.decode(Double.self) { return Date(timeIntervalSinceReferenceDate: t) }
            let s = try c.decode(String.self)
            let f = ISO8601DateFormatter()
            if let date = f.date(from: s) { return date }
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date: \(s)")
        }
        return d
    }
}

public enum WordCounter {
    public static func count(_ text: String) -> Int {
        var n = 0
        text.enumerateSubstrings(in: text.startIndex..., options: [.byWords, .substringNotRequired]) { _, _, _, _ in n += 1 }
        return n
    }
}
