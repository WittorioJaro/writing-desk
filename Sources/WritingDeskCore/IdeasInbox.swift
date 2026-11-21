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

    /// Returns the number of new ideas added.
    @discardableResult
    public static func importInbox(store: Store, into state: inout AppState, now: Date = Date()) throws -> Int {
        let fm = FileManager.default
        let files = try fm.contentsOfDirectory(at: store.inboxURL, includingPropertiesForKeys: nil)
            .filter { ["txt", "md"].contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        var seen = Set(state.ideas.map { $0.text.lowercased() })
        var added = 0
        let importedDir = store.inboxURL.appendingPathComponent("imported", isDirectory: true)
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in parse(text) where !seen.contains(line.lowercased()) {
                seen.insert(line.lowercased())
                state.ideas.append(Idea(text: line, source: file.lastPathComponent, added: now))
                added += 1
            }
            var dest = importedDir.appendingPathComponent(file.lastPathComponent)
            if fm.fileExists(atPath: dest.path) {
                dest = importedDir.appendingPathComponent("\(Int(now.timeIntervalSince1970))-\(file.lastPathComponent)")
            }
            try fm.moveItem(at: file, to: dest)
        }
        return added
    }
}
