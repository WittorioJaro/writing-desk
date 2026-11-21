import Foundation

/// Imports Elon's ideas from plain files dropped into the inbox folder.
///
/// Format: any `.txt` or `.md` file; one idea per non-empty line.
/// Leading bullets (`-`, `*`, `•`, `1.`) are stripped; lines starting with `#` are ignored.
/// Duplicates (case-insensitive) of existing ideas are skipped.
/// Processed files are moved to `inbox/imported/` so they are never imported twice.
public enum IdeasInbox {
    public static func parse(_ text: String) -> [String] {
        text.components(separatedBy: .newlines).compactMap { raw in
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { return nil }
            if let r = line.range(of: #"^([-*•]|\d+[.)])\s+"#, options: .regularExpression) {
                line.removeSubrange(r)
            }
            line = line.trimmingCharacters(in: .whitespaces)
            return line.isEmpty ? nil : line
        }
    }

    public struct ImportResult: Equatable {
        public var added = 0
        public var archived: [String] = []
        /// Files left in the inbox (or not archived), with the reason. Safe to retry.
        public var errors: [String] = []
    }

    /// Imports inbox files one at a time: read -> add ideas -> **persist** -> archive.
    ///
    /// - A file is archived only after its ideas were saved, so a failed read or save leaves the original in `inbox/`.
    /// - If a save fails, that file's ideas are rolled back and the import stops; files saved earlier stay saved and archived.
    /// - Retrying is idempotent: ideas already saved are skipped as duplicates, so a file whose archive step failed
    ///   adds nothing on retry and is simply archived then.
    /// - The save happens even when a file adds nothing new, so archiving always follows a successful save.
    public static func importInbox(store: Store, into state: inout AppState, now: Date = Date(),
                                   persist: (AppState) throws -> Void) -> ImportResult {
        let fm = FileManager.default
        var result = ImportResult()
        let files: [URL]
        do {
            files = try fm.contentsOfDirectory(at: store.inboxURL, includingPropertiesForKeys: nil)
                .filter { ["txt", "md"].contains($0.pathExtension.lowercased()) }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
        } catch {
            result.errors.append("Couldn't list inbox: \(error.localizedDescription)")
            return result
        }
        let importedDir = store.inboxURL.appendingPathComponent("imported", isDirectory: true)
        for file in files {
            let name = file.lastPathComponent
            let text: String
            do { text = try String(contentsOf: file, encoding: .utf8) } catch {
                result.errors.append("\(name): couldn't read (\(error.localizedDescription)); left in inbox")
                continue
            }
            var next = state
            var seen = Set(next.ideas.map { $0.text.lowercased() })
            var added = 0
            for line in parse(text) where !seen.contains(line.lowercased()) {
                seen.insert(line.lowercased())
                next.ideas.append(Idea(text: line, source: name, added: now))
                added += 1
            }
            // Always save before archiving, even when every line was a duplicate: the duplicate may
            // match an idea that is only in memory (an earlier save failed), and archiving would
            // then remove the only durable copy.
            do { try persist(next) } catch {
                result.errors.append("\(name): couldn't save ideas (\(error.localizedDescription)); left in inbox")
                break
            }
            state = next
            result.added += added
            var dest = importedDir.appendingPathComponent(name)
            if fm.fileExists(atPath: dest.path) {
                dest = importedDir.appendingPathComponent("\(Int(now.timeIntervalSince1970))-\(name)")
            }
            do {
                try fm.moveItem(at: file, to: dest)
                result.archived.append(name)
            } catch {
                result.errors.append("\(name): ideas saved but couldn't archive (\(error.localizedDescription)); a retry will skip duplicates")
            }
        }
        return result
    }
}
