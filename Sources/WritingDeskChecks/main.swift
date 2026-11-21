
import Foundation
import CoreGraphics
import ImageIO
import WritingDeskCore

func tempStore() throws -> Store {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wd-test-\(UUID().uuidString)")
    return try Store(root: dir)
}

func pixels(_ img: CGImage) -> [UInt8] {
    let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
    let p = ctx.data!.bindMemory(to: UInt8.self, capacity: img.width * img.height * 4)
    return Array(UnsafeBufferPointer(start: p, count: img.width * img.height * 4))
}

let articleA = ("Building habits", "Habits compound. Writing every morning builds a habit of clarity. Small habits, repeated daily, beat motivation. A habit tracker keeps the streak honest.")
let articleB = ("Rockets and reuse", "Reusable rockets change launch economics! Landing boosters means rockets fly again. Engines, fuel, and turnaround time decide the cost of orbit. Short.")

struct CoverTests {
    func everyStyleIsExactly5by2() throws {
        for style in CoverStyle.allCases {
            let img = CoverGenerator.render(title: articleA.0, body: articleA.1, style: style)
            expect(img.width * 2 == img.height * 5, "\(style) is \(img.width)x\(img.height)")
            expect(img.width == 1500 && img.height == 600)
        }
        let small = CoverGenerator.render(title: "x", body: "y", style: .orbit, width: 500)
        expect(small.width == 500 && small.height == 200)
    }

    func pngExportRoundTripsAt5by2() throws {
        let store = try tempStore()
        let url = store.coversURL.appendingPathComponent("test.png")
        try CoverGenerator.exportPNG(CoverGenerator.render(title: articleA.0, body: articleA.1, style: .waves), to: url)
        let src = CGImageSourceCreateWithURL(url as CFURL, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
        expect(props[kCGImagePropertyPixelWidth] as? Int == 1500)
        expect(props[kCGImagePropertyPixelHeight] as? Int == 600)
        let data = try Data(contentsOf: url)
        expect(data.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
    }

    func coversAreDeterministicAndContentDependent() {
        for style in CoverStyle.allCases {
            let a1 = pixels(CoverGenerator.render(title: articleA.0, body: articleA.1, style: style))
            let a2 = pixels(CoverGenerator.render(title: articleA.0, body: articleA.1, style: style))
            let b = pixels(CoverGenerator.render(title: articleB.0, body: articleB.1, style: style))
            expect(a1 == a2, "\(style) must be deterministic")
            expect(a1 != b, "\(style) must depend on content")
        }
    }

    func fiveDistinctOptionsPerArticle() {
        let imgs = CoverStyle.allCases.map { pixels(CoverGenerator.render(title: articleA.0, body: articleA.1, style: $0, width: 300)) }
        expect(imgs.count == 5)
        expect(Set(imgs.map { $0.hashValue }).count == 5)
    }

    func keywordsReflectTopic() {
        expect(CoverSeed(title: articleA.0, body: articleA.1).keywords.first == "habits")
        expect(CoverSeed(title: articleB.0, body: articleB.1).keywords.contains("rockets"))
        expect(!CoverSeed(title: "", body: "the and of it").keywords.contains("the"))
    }
}

struct AccountabilityTests {
    let cal = Calendar(identifier: .gregorian)
    func day(_ d: Int) -> Date { cal.date(from: DateComponents(year: 2026, month: 11, day: d, hour: 12))! }

    func onlyNewWordsCount() {
        var a = Accountability(dailyGoal: 100)
        a.recordEdit(oldWordCount: 0, newWordCount: 40, on: day(21))
        a.recordEdit(oldWordCount: 40, newWordCount: 10, on: day(21)) // deletion
        a.recordEdit(oldWordCount: 10, newWordCount: 30, on: day(21))
        expect(a.words(on: day(21)) == 60)
        expect(a.progress(on: day(21)) == 0.6)
        expect(!a.goalMet(on: day(21)))
        a.recordEdit(oldWordCount: 30, newWordCount: 100, on: day(21))
        expect(a.progress(on: day(21)) == 1)
        expect(a.words(on: day(20)) == 0)
    }

    func streakCountsConsecutiveGoalDays() {
        var a = Accountability(dailyGoal: 50)
        for d in [17, 19, 20] { a.recordEdit(oldWordCount: 0, newWordCount: 60, on: day(d)) }
        expect(a.streak(asOf: day(21), calendar: cal) == 2)   // today not yet met: counts 19-20
        a.recordEdit(oldWordCount: 0, newWordCount: 50, on: day(21))
        expect(a.streak(asOf: day(21), calendar: cal) == 3)
        expect(a.streak(asOf: day(23), calendar: cal) == 0)
        let recent = a.recent(days: 7, asOf: day(21), calendar: cal)
        expect(recent.count == 7 && recent.last!.words == 50 && recent.first!.day == "2026-11-15")
    }
}

struct PersistenceAndIdeasTests {
    func stateRoundTrips() throws {
        let store = try tempStore()
        var s = AppState()
        s.articles.append(Article(title: "Draft", body: "Victor's words."))
        s.ideas.append(Idea(text: "Think about incentives", source: "manual"))
        s.accountability.dailyGoal = 750
        s.accountability.history["2026-11-21"] = 321
        try store.save(s)
        let loaded = try Store(root: store.root).load()
        expect(loaded.articles.map(\.body) == ["Victor's words."])
        expect(loaded.ideas.map(\.text) == ["Think about incentives"])
        expect(loaded.accountability == s.accountability)
        expect(try tempStore().load() == AppState())
    }

    func parsesInboxFormat() {
        let text = "# Ideas from Elon\n- Why do habits fail?\n* First principles of editing\n\n1. Write about launch costs\nPlain line idea\n   \n"
        expect(IdeasInbox.parse(text) == ["Why do habits fail?", "First principles of editing", "Write about launch costs", "Plain line idea"])
    }

    func importsInboxOnceDedupesAndKeepsArticlesUntouched() throws {
        let store = try tempStore()
        var s = AppState()
        s.articles.append(Article(title: "A", body: "body"))
        s.ideas.append(Idea(text: "Existing idea", source: "manual"))
        try "- existing IDEA\n- New one\n- Another".write(to: store.inboxURL.appendingPathComponent("2026-11-21.md"), atomically: true, encoding: .utf8)
        try "ignored".write(to: store.inboxURL.appendingPathComponent("notes.json"), atomically: true, encoding: .utf8)
        expect(IdeasInbox.importInbox(store: store, into: &s, persist: store.save).added == 2)
        expect(s.ideas.map(\.text) == ["Existing idea", "New one", "Another"])
        expect(s.ideas.last?.source == "2026-11-21.md")
        expect(s.articles.map(\.body) == ["body"])
        expect(FileManager.default.fileExists(atPath: store.inboxURL.appendingPathComponent("imported/2026-11-21.md").path))
        expect(IdeasInbox.importInbox(store: store, into: &s, persist: store.save).added == 0) // file was moved; no reimport
        try "- New one\n- Third".write(to: store.inboxURL.appendingPathComponent("2026-11-21.md"), atomically: true, encoding: .utf8)
        expect(IdeasInbox.importInbox(store: store, into: &s, persist: store.save).added == 1)
    }

    func loadFailureIsReadOnlyAndPreservesFile() throws {
        let store = try tempStore()
        let corrupt = Data("{ \"articles\": [ {\"title\": \"Victor's draft\"".utf8)  // truncated JSON
        try corrupt.write(to: store.stateURL)
        let inboxFile = store.inboxURL.appendingPathComponent("elon.md")
        try "- An idea".write(to: inboxFile, atomically: true, encoding: .utf8)

        let ws = Workspace(store: store)
        expect(!ws.isWritable && ws.loadError != nil)
        var threw = false
        do { try ws.mutate { $0.articles.append(Article(title: "new")) } } catch WorkspaceError.readOnly { threw = true }
        expect(threw, "edit must be refused")
        threw = false
        do { _ = try ws.importInbox() } catch WorkspaceError.readOnly { threw = true }
        expect(threw, "inbox import must be refused")
        expect(ws.state.articles.isEmpty && ws.state.ideas.isEmpty, "refused writes must not change memory")
        expect(try Data(contentsOf: store.stateURL) == corrupt, "state.json must be byte-identical")
        expect(FileManager.default.fileExists(atPath: inboxFile.path), "inbox file must stay in inbox")

        // Recovery: once the file is valid again, a relaunch is writable and keeps the recovered data.
        var good = AppState(); good.articles.append(Article(title: "Victor's draft", body: "kept"))
        try store.save(good)
        let ws2 = Workspace(store: store)
        expect(ws2.isWritable && ws2.state.articles.first?.body == "kept")
        try ws2.mutate { $0.articles[0].body = "kept and edited" }
        expect(try store.load().articles.first?.body == "kept and edited")
        // A missing file is a fresh, writable workspace (first launch).
        expect(Workspace(store: try tempStore()).isWritable)
    }

    func importPersistsBeforeArchivingAndSurvivesFailures() throws {
        let store = try tempStore()
        let fm = FileManager.default
        let inbox = store.inboxURL, imported = inbox.appendingPathComponent("imported")
        try "- First idea".write(to: inbox.appendingPathComponent("1.md"), atomically: true, encoding: .utf8)
        try "- Second idea".write(to: inbox.appendingPathComponent("2.md"), atomically: true, encoding: .utf8)
        try Data([0xFF, 0xFE, 0x00, 0xC3]).write(to: inbox.appendingPathComponent("0-bad.txt")) // invalid UTF-8
        var s = AppState()
        try store.save(s)

        // Save fails for the second file: first file's import stays saved + archived; second stays in inbox.
        struct DiskFull: Error {}
        var calls = 0
        var r = IdeasInbox.importInbox(store: store, into: &s, persist: { st in
            calls += 1
            if calls == 2 { throw DiskFull() }
            try store.save(st)
        })
        expect(r.added == 1 && r.archived == ["1.md"], "\(r)")
        expect(r.errors.count == 2, "read error + save error: \(r.errors)")
        expect(s.ideas.map(\.text) == ["First idea"], "failed file rolled back in memory")
        expect(try store.load().ideas.map(\.text) == ["First idea"], "prior import saved on disk")
        expect(fm.fileExists(atPath: inbox.appendingPathComponent("2.md").path), "unsaved file retained")
        expect(fm.fileExists(atPath: inbox.appendingPathComponent("0-bad.txt").path), "unreadable file retained")
        expect(fm.fileExists(atPath: imported.appendingPathComponent("1.md").path))

        // Archive step fails after a successful save: ideas are on disk, original stays, retry is idempotent.
        try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: imported.path)
        r = IdeasInbox.importInbox(store: store, into: &s, persist: store.save)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: imported.path)
        expect(r.added == 1 && r.archived.isEmpty, "\(r)")
        expect(try store.load().ideas.map(\.text) == ["First idea", "Second idea"])
        expect(fm.fileExists(atPath: inbox.appendingPathComponent("2.md").path))

        r = IdeasInbox.importInbox(store: store, into: &s, persist: store.save)
        expect(r.added == 0 && r.archived == ["2.md"], "retry adds nothing, just archives: \(r)")
        expect(try store.load().ideas.map(\.text) == ["First idea", "Second idea"], "no duplicates")
        expect(fm.fileExists(atPath: inbox.appendingPathComponent("0-bad.txt").path), "bad file still retained")

        // Workspace path: real store save, ideas on disk before archive.
        try "- Third".write(to: inbox.appendingPathComponent("3.md"), atomically: true, encoding: .utf8)
        let ws = Workspace(store: store)
        let wr = try ws.importInbox()
        expect(wr.added == 1 && wr.archived == ["3.md"])
        expect(try store.load().ideas.count == 3)
    }

    func duplicateOnlyFileIsNotArchivedUntilSaved() throws {
        let store = try tempStore()
        let fm = FileManager.default
        let file = store.inboxURL.appendingPathComponent("dup.md")
        var s = AppState()
        try store.save(s)
        // An idea exists only in memory: it was added, but its save failed.
        s.ideas.append(Idea(text: "Unsaved idea", source: "added in app"))
        try "- unsaved IDEA".write(to: file, atomically: true, encoding: .utf8)
        struct DiskFull: Error {}

        var r = IdeasInbox.importInbox(store: store, into: &s, persist: { _ in throw DiskFull() })
        expect(r.added == 0 && r.archived.isEmpty && r.errors.count == 1, "\(r)")
        expect(fm.fileExists(atPath: file.path), "duplicate-only file must stay while the save fails")
        expect(try store.load().ideas.isEmpty)

        r = IdeasInbox.importInbox(store: store, into: &s, persist: store.save)
        expect(r.added == 0 && r.archived == ["dup.md"], "\(r)")
        expect(try store.load().ideas.map(\.text) == ["Unsaved idea"], "idea is durable before its source is archived")
    }

    func wordCount() {
        expect(WordCounter.count("") == 0)
        expect(WordCounter.count("One two,  three.\nFour") == 4)
    }
}

// MARK: - Minimal runner (Swift Testing macros are unavailable with Command Line Tools only)
nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var current = ""
func expect(_ cond: @autoclosure () throws -> Bool, _ msg: @autoclosure () -> String = "", file: StaticString = #fileID, line: UInt = #line) {
    let ok = (try? cond()) ?? false
    if !ok { failures += 1; print("  ✘ \(current): expectation failed at line \(line) \(msg())") }
}
func run(_ name: String, _ body: () throws -> Void) {
    current = name
    let before = failures
    do { try body() } catch { failures += 1; print("  ✘ \(name): threw \(error)") }
    print(failures == before ? "✔ \(name)" : "✘ \(name)")
}
let c = CoverTests(), a = AccountabilityTests(), p = PersistenceAndIdeasTests()
let checks: [(String, () throws -> Void)] = [
    ("cover: every style is exactly 5:2", c.everyStyleIsExactly5by2),
    ("cover: PNG export round-trips at 1500x600", c.pngExportRoundTripsAt5by2),
    ("cover: deterministic and content-dependent", c.coversAreDeterministicAndContentDependent),
    ("cover: five distinct options per article", c.fiveDistinctOptionsPerArticle),
    ("cover: keywords reflect topic", c.keywordsReflectTopic),
    ("accountability: only new words count", a.onlyNewWordsCount),
    ("accountability: streak + history", a.streakCountsConsecutiveGoalDays),
    ("persistence: state round-trips", p.stateRoundTrips),
    ("ideas: inbox format parsing", p.parsesInboxFormat),
    ("ideas: import once, dedupe, articles untouched", p.importsInboxOnceDedupesAndKeepsArticlesUntouched),
    ("words: counting", p.wordCount),
    ("safety: unreadable state.json -> read-only, file preserved, no import", p.loadFailureIsReadOnlyAndPreservesFile),
    ("safety: inbox saves before archiving; read/save/archive failures recover", p.importPersistsBeforeArchivingAndSurvivesFailures),
    ("safety: duplicate-only inbox file not archived until a save succeeds", p.duplicateOnlyFileIsNotArchivedUntilSaved),
]
for (name, fn) in checks { run(name, fn) }
// Optional: write sample covers for visual review: COVER_SAMPLES_DIR=/some/dir make test
if let dir = ProcessInfo.processInfo.environment["COVER_SAMPLES_DIR"] {
    for (tag, art) in [("habits", articleA), ("rockets", articleB)] {
        for style in CoverStyle.allCases {
            try? CoverGenerator.exportPNG(CoverGenerator.render(title: art.0, body: art.1, style: style),
                                          to: URL(fileURLWithPath: dir).appendingPathComponent("\(tag)-\(style.rawValue).png"))
        }
    }
    print("Sample covers written to \(dir)")
}
print(failures == 0 ? "\nAll \(checks.count) checks passed" : "\n\(failures) failure(s)")
exit(failures == 0 ? 0 : 1)
