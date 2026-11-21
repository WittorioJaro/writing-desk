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

    public init(id: UUID = UUID(), text: String, source: String, added: Date = Date(), done: Bool = false) {
        self.id = id
        self.text = text
        self.source = source
        self.added = added
        self.done = done
    }
}

public struct AppState: Codable, Equatable {
    public var articles: [Article] = []
    public var ideas: [Idea] = []
    public var accountability = Accountability()
    public init() {}
}

public enum WordCounter {
    public static func count(_ text: String) -> Int {
        var n = 0
        text.enumerateSubstrings(in: text.startIndex..., options: [.byWords, .substringNotRequired]) { _, _, _, _ in n += 1 }
        return n
    }
}
