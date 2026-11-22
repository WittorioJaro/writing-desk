
import Foundation
import CoreGraphics
import ImageIO
import WritingDeskCore
import WritingDeskServerKit

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
        s.accountability.byDevice["mac-a"] = ["2026-11-21": 321]
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

// MARK: - Sync

func blocking<T>(_ f: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var result: Result<T, Error>!
    Task.detached { do { result = .success(try await f()) } catch { result = .failure(error) }; done.signal() }
    done.wait()
    return try result.get()
}

@discardableResult
func sync(_ ws: Workspace, _ url: URL) throws -> Workspace.SyncOutcome {
    let sent = ws.makeSyncRequest()
    let response = try blocking { try await SyncClient.exchange(sent, server: url) }
    return try ws.applySync(sent: sent, response: response)
}

func article(_ ws: Workspace, _ id: UUID) -> Article? { ws.state.articles.first { $0.id == id } }

struct SyncTests {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func v1FilesStillLoadAndMigrate() throws {
        let store = try tempStore()
        let v1 = """
        {"accountability":{"dailyGoal":300,"history":{"2026-11-20":120}},
         "articles":[{"body":"Victor's words","created":"2026-11-21T22:38:27Z","id":"BC6ABB10-BF78-4598-86E0-4DFD648B664D","title":"Draft","updated":"2026-11-21T22:38:27Z"}],
         "ideas":[{"added":"2026-11-21T22:38:27Z","done":false,"id":"B6769E3E-4F9F-47B6-A49B-269D13C27151","source":"elon.md","text":"An idea"}]}
        """
        try v1.write(to: store.stateURL, atomically: true, encoding: .utf8)
        let ws = Workspace(store: store)
        expect(ws.isWritable, ws.loadError ?? "")
        expect(ws.state.articles.first?.body == "Victor's words" && ws.state.ideas.count == 1)
        expect(ws.state.accountability.byDevice[ws.deviceID]?["2026-11-20"] == 120, "legacy history moved to this Mac")
        expect(ws.state.accountability.history["2026-11-20"] == 120)
        expect(ws.state.accountability.dailyGoal == 300 && ws.state.accountability.goalUpdated != nil)
        try ws.mutate { _ in }
        let again = Workspace(store: store)
        expect(again.state == ws.state && again.deviceID == ws.deviceID, "re-saved file round-trips")
    }

    func datesRoundTripExactly() throws {
        var s = AppState()
        s.articles.append(Article(title: "t", body: "b", created: Date()))
        s.ideas.append(Idea(text: "i", source: "x", added: Date()))
        let back = try JSONCoding.decoder().decode(AppState.self, from: JSONCoding.encoder().encode(s))
        expect(back == s)
    }

    func mergeRules() {
        var a = AppState(), b = AppState()
        var x = Article(title: "X", body: "old", created: t0); x.updated = t0
        var x2 = x; x2.body = "new"; x2.updated = t0 + 60
        let y = Article(title: "Y", body: "deleted later", created: t0)
        a.articles = [x, y]; b.articles = [x2, y]
        b.tombstones[y.id.uuidString] = t0 + 10
        a.accountability.byDevice = ["A": ["2026-11-21": 100]]
        b.accountability.byDevice = ["A": ["2026-11-21": 80], "B": ["2026-11-21": 50]]
        b.accountability.setGoal(700, at: t0)
        let m = Sync.merge(a, b)
        expect(m == Sync.merge(b, a), "commutative")
        expect(Sync.merge(m, a) == m && Sync.merge(m, m) == m, "idempotent")
        expect(m.articles.map(\.body) == ["new"], "newest edit wins; tombstone removes Y")
        expect(m.accountability.words(on: Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 21, hour: 12))!) == 150, "per-Mac counts sum without double counting")
        expect(m.accountability.dailyGoal == 700, "explicitly set goal beats default")
    }

    func reconcileKeepsInFlightEdits() {
        var s = Article(title: "T", body: "sent", created: t0); s.updated = t0
        var sent = AppState(); sent.articles = [s]
        var local = sent; local.articles[0].body = "sent plus typing"; local.articles[0].updated = t0 + 5
        let newLocal = Article(title: "New", body: "made during sync", created: t0 + 6)
        local.articles.append(newLocal)
        let r = Sync.reconcile(local: local, sent: sent, response: sent, base: [:])
        expect(r.state.articles.first { $0.id == s.id }?.body == "sent plus typing")
        expect(r.state.articles.contains { $0.id == newLocal.id })
        expect(r.base[s.id.uuidString] == Sync.fingerprint(s), "base is what the server confirmed")
        // Unchanged local copy takes the server's version.
        var remote = sent; remote.articles[0].body = "edited on other Mac"; remote.articles[0].updated = t0 + 9
        let r2 = Sync.reconcile(local: sent, sent: sent, response: remote, base: [:])
        expect(r2.state.articles.map(\.body) == ["edited on other Mac"])
    }

    func serverConflictKeepsBothVersionsIdempotently() {
        var base = Article(title: "T", body: "v1", created: t0); base.updated = t0
        var stored = AppState(); stored.articles = [base]
        var mine = base; mine.body = "A's version"; mine.updated = t0 + 10
        stored.articles = [mine]   // A already pushed its edit
        var theirs = base; theirs.body = "B's version"; theirs.updated = t0 + 20
        var incoming = AppState(); incoming.articles = [theirs]
        let bases = [base.id.uuidString: Sync.fingerprint(base)]
        let (m, n) = Sync.serverMerge(stored: stored, incoming: incoming, bases: bases)
        expect(n == 1)
        expect(Set(m.articles.map(\.body)) == ["A's version", "B's version"], "no writing lost")
        expect(m.articles.first { $0.id == base.id }?.body == "B's version")
        expect(m.articles.contains { $0.title == "T (conflict copy)" && $0.body == "A's version" })
        let (m2, n2) = Sync.serverMerge(stored: m, incoming: incoming, bases: bases)
        expect(n2 == 0 && m2 == m, "retrying the same sync adds no duplicate copies")
        // Fast-forward: client edited the server's version -> no conflict, even with an older clock.
        var ff = mine; ff.body = "A then more"; ff.updated = t0 + 1
        var inc2 = AppState(); inc2.articles = [ff]
        let (m3, n3) = Sync.serverMerge(stored: stored, incoming: inc2, bases: [base.id.uuidString: Sync.fingerprint(mine)])
        expect(n3 == 0 && m3.articles.map(\.body) == ["A then more"])
    }

    func databaseRoundTripAndBackup() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wd-db-\(UUID().uuidString)")
        let db = try SyncDatabase(url: dir.appendingPathComponent("writing-desk.sqlite"))
        expect(try db.load() == AppState())
        var s = AppState()
        s.articles = [Article(title: "a", body: "b", created: t0)]
        s.ideas = [Idea(text: "i", source: "elon.md", added: t0)]
        s.accountability.byDevice = ["A": ["2026-11-21": 3]]
        s.accountability.setGoal(250, at: t0)
        s.tombstones = ["X": t0]
        try db.save(s)
        expect(try SyncDatabase(url: db.url).load() == Sync.normalized(s))
        try db.backupIfNeeded(into: dir.appendingPathComponent("backups"), now: t0)
        let snapshot = dir.appendingPathComponent("backups/\(Accountability.dayKey(t0)).sqlite")
        expect(try SyncDatabase(url: snapshot).load() == Sync.normalized(s))
    }

    func twoMacsSyncThroughServer() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wd-srv-\(UUID().uuidString)")
        let server = SyncServer(db: try SyncDatabase(url: dir.appendingPathComponent("db.sqlite")),
                                allow: [IPv4Range("127.0.0.1")!], backupDir: dir.appendingPathComponent("backups"))
        let port = try server.start(host: "127.0.0.1", port: 0)
        defer { server.stop() }
        let url = URL(string: "http://127.0.0.1:\(port)")!
        let a = Workspace(store: try tempStore()), b = Workspace(store: try tempStore())
        expect(a.deviceID != b.deviceID)

        let x = Article(title: "Habits", body: "one two three")
        try a.mutate { $0.articles.append(x); $0.accountability.recordEdit(oldWordCount: 0, newWordCount: 3, device: a.deviceID) }
        try sync(a, url); try sync(b, url)
        expect(article(b, x.id)?.body == "one two three", "B received A's article")

        try b.mutate { $0.articles[0].body = "one two three four five"; $0.articles[0].updated = Date()
                       $0.accountability.recordEdit(oldWordCount: 3, newWordCount: 5, device: b.deviceID) }
        try sync(b, url); try sync(a, url)
        expect(article(a, x.id)?.body == "one two three four five", "A received B's edit")
        expect(a.state.accountability.words() == 5 && b.state.accountability.words() == 5, "words: A 3 + B 2")

        // Both edit the same article before syncing.
        try a.mutate { $0.articles[0].body = "A's offline rewrite"; $0.articles[0].updated = Date() }
        try b.mutate { $0.articles[0].body = "B's offline rewrite"; $0.articles[0].updated = Date().addingTimeInterval(1) }
        try sync(a, url)
        let outcome = try sync(b, url)
        try sync(a, url)
        expect(outcome.conflicts == 1)
        for ws in [a, b] {
            expect(Set(ws.state.articles.map(\.body)) == ["A's offline rewrite", "B's offline rewrite"], "both versions on both Macs")
        }
        expect(a.state == b.state, "converged")

        // Deleted on A while B keeps writing in it: B's writing survives.
        try a.mutate { $0.articles.removeAll { $0.id == x.id }; $0.tombstones[x.id.uuidString] = Date() }
        try sync(a, url)
        try b.mutate { s in if let i = s.articles.firstIndex(where: { $0.id == x.id }) { s.articles[i].body += " more"; s.articles[i].updated = Date().addingTimeInterval(-60) } }
        try sync(b, url); try sync(a, url)
        expect(article(a, x.id)?.body == "B's offline rewrite more", "edited-after-sync article is kept")

        // Plain deletion (no edits elsewhere) propagates.
        let y = Article(title: "Scratch")
        try a.mutate { $0.articles.append(y) }
        try sync(a, url); try sync(b, url)
        try b.mutate { $0.articles.removeAll { $0.id == y.id }; $0.tombstones[y.id.uuidString] = Date() }
        try sync(b, url); try sync(a, url)
        expect(article(a, y.id) == nil, "deletion synced")

        // Ideas and goal sync too; read-only workspaces never sync.
        try a.mutate { $0.ideas.append(Idea(text: "From Elon", source: "elon.md")); $0.accountability.setGoal(800) }
        try sync(a, url); try sync(b, url)
        expect(b.state.ideas.map(\.text) == ["From Elon"] && b.state.accountability.dailyGoal == 800)
        let broken = try tempStore()
        try Data("{oops".utf8).write(to: broken.stateURL)
        var threw = false
        do { try sync(Workspace(store: broken), url) } catch WorkspaceError.readOnly { threw = true }
        expect(threw, "read-only workspace refuses to sync")
    }

    func serverRejectsAddressesOutsideAllowlist() throws {
        expect(IPv4Range("100.64.0.0/10")!.contains("100.100.1.2") && !IPv4Range("100.64.0.0/10")!.contains("192.168.1.5"))
        expect(IPv4Range("127.0.0.1")!.contains("127.0.0.1%lo0") && IPv4Range("nope") == nil)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wd-srv-\(UUID().uuidString)")
        let server = SyncServer(db: try SyncDatabase(url: dir.appendingPathComponent("db.sqlite")), allow: [IPv4Range("100.64.0.0/10")!], backupDir: nil)
        let port = try server.start(host: "127.0.0.1", port: 0)
        defer { server.stop() }
        var code = 0
        do { _ = try blocking { try await SyncClient.exchange(SyncRequest(state: AppState(), bases: [:]), server: URL(string: "http://127.0.0.1:\(port)")!) } }
        catch SyncError.server(let c, _) { code = c }
        expect(code == 403, "got \(code)")
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
let c = CoverTests(), a = AccountabilityTests(), p = PersistenceAndIdeasTests(), sy = SyncTests()
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
    ("sync: v1 state.json loads and migrates", sy.v1FilesStillLoadAndMigrate),
    ("sync: dates round-trip exactly", sy.datesRoundTripExactly),
    ("sync: merge rules (LWW, tombstones, per-Mac words, goal)", sy.mergeRules),
    ("sync: in-flight local edits survive a sync", sy.reconcileKeepsInFlightEdits),
    ("sync: server keeps both sides of a conflict, idempotently", sy.serverConflictKeepsBothVersionsIdempotently),
    ("sync: SQLite round-trip + daily backup", sy.databaseRoundTripAndBackup),
    ("sync: two Macs through a real server (edits, conflicts, deletes, words)", sy.twoMacsSyncThroughServer),
    ("sync: server rejects addresses outside the allowlist", sy.serverRejectsAddressesOutsideAllowlist),
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
