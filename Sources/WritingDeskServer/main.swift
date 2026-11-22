import Foundation
import WritingDeskServerKit

// writing-desk-server --host 100.x.y.z --port 8765 --db <path> [--allow 100.64.0.0/10,127.0.0.1] [--backups <dir>]
let usage = "usage: WritingDeskServer --host <ip> [--port 8765] --db <file.sqlite> [--allow cidr,cidr] [--backups <dir>]"
var opts: [String: String] = [:]
var args = CommandLine.arguments.dropFirst()
while let key = args.popFirst() {
    guard key.hasPrefix("--"), let value = args.popFirst() else { print(usage); exit(2) }
    opts[String(key.dropFirst(2))] = value
}
guard let host = opts["host"], let dbPath = opts["db"] else { print(usage); exit(2) }
let port = UInt16(opts["port"] ?? "8765") ?? 8765
let allowText = opts["allow"] ?? "100.64.0.0/10,127.0.0.1"
let allow = allowText.split(separator: ",").compactMap { IPv4Range(String($0).trimmingCharacters(in: .whitespaces)) }
guard !allow.isEmpty else { print("no valid --allow ranges"); exit(2) }

func log(_ s: String) {
    print("\(ISO8601DateFormatter().string(from: Date())) \(s)")
    fflush(stdout)
}

do {
    let db = try SyncDatabase(url: URL(fileURLWithPath: dbPath))
    let server = SyncServer(db: db, allow: allow, backupDir: opts["backups"].map { URL(fileURLWithPath: $0) })
    server.log = log
    let bound = try server.start(host: host, port: port)
    log("Writing Desk sync server listening on \(host):\(bound), db \(dbPath), allow \(allowText)")
    dispatchMain()
} catch {
    log("failed to start: \(error)")
    exit(1)
}
