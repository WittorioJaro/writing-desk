import Foundation
import Network
import WritingDeskCore

/// An IPv4 range like `100.64.0.0/10` (the Tailscale address space) or a single address.
public struct IPv4Range: Equatable {
    let network: UInt32, mask: UInt32

    public init?(_ text: String) {
        let parts = text.split(separator: "/", maxSplits: 1)
        guard let addr = IPv4Range.parse(String(parts[0])) else { return nil }
        let bits = parts.count == 2 ? Int(parts[1]) : 32
        guard let bits, (0...32).contains(bits) else { return nil }
        mask = bits == 0 ? 0 : UInt32.max << (32 - UInt32(bits))
        network = addr & mask
    }

    static func parse(_ s: String) -> UInt32? {
        let octets = s.split(separator: ".").compactMap { UInt32($0) }
        guard octets.count == 4, octets.allSatisfy({ $0 < 256 }) else { return nil }
        return octets.reduce(0) { $0 << 8 | $1 }
    }

    public func contains(_ address: String) -> Bool {
        let bare = address.split(separator: "%").first.map(String.init) ?? address
        guard let a = IPv4Range.parse(bare) else { return false }
        return a & mask == network
    }
}

/// Minimal HTTP/1.1 server for syncing Writing Desk between Macs.
///
///     GET  /v1/health  -> {"ok":true}
///     POST /v1/sync    body: the client's full state -> merged state (stored in SQLite)
///
/// Binds to one address (the Mac's Tailscale IP in production) and only answers clients whose
/// address is in `allow`. Tailscale authenticates source addresses with WireGuard keys, so this
/// limits access to your own tailnet. Requests are handled one at a time.
public final class SyncServer {
    let db: SyncDatabase
    let allow: [IPv4Range]
    let backupDir: URL?
    let queue = DispatchQueue(label: "writing-desk.sync-server")
    var listener: NWListener?
    static let maxBody = 64 << 20
    public var log: (String) -> Void = { _ in }

    public init(db: SyncDatabase, allow: [IPv4Range], backupDir: URL?) {
        self.db = db
        self.allow = allow
        self.backupDir = backupDir
    }

    /// Starts listening and returns the bound port (pass 0 to pick a free port).
    @discardableResult
    public func start(host: String, port: UInt16) throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any)
        let l = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: ready.signal()
            case .failed(let e):
                failure = e
                self?.log("listener failed: \(e)")
                ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        if ready.wait(timeout: .now() + 10) == .timedOut { l.cancel(); throw DatabaseError(message: "Timed out binding \(host):\(port)") }
        if let failure { l.cancel(); throw failure }
        listener = l
        return l.port?.rawValue ?? port
    }

    public func stop() { listener?.cancel(); listener = nil }

    func remoteAddress(_ c: NWConnection) -> String? {
        if case let .hostPort(host, _) = c.endpoint, case let .ipv4(a) = host { return "\(a)" }
        return nil
    }

    func accept(_ c: NWConnection) {
        c.start(queue: queue)
        guard let ip = remoteAddress(c), allow.contains(where: { $0.contains(ip) }) else {
            log("rejected \(c.endpoint)")
            respond(c, 403, ["error": "not allowed"])
            return
        }
        receive(c, buffer: Data())
    }

    func receive(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                let request = lines.first?.split(separator: " ").map(String.init) ?? []
                var length = 0
                for line in lines.dropFirst() {
                    let kv = line.split(separator: ":", maxSplits: 1)
                    if kv.count == 2, kv[0].lowercased() == "content-length" {
                        length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? -1
                    }
                }
                guard request.count >= 2, length >= 0, length <= Self.maxBody else {
                    return self.respond(c, length > Self.maxBody ? 413 : 400, ["error": "bad request"])
                }
                let body = buf[headerEnd.upperBound...]
                if body.count >= length {
                    let (code, payload) = self.handle(method: request[0], path: request[1], body: Data(body.prefix(length)))
                    return self.send(c, code, payload)
                }
            }
            if complete || error != nil { c.cancel(); return }
            self.receive(c, buffer: buf)
        }
    }

    func handle(method: String, path: String, body: Data) -> (Int, Data) {
        let enc = JSONCoding.encoder(pretty: false)
        switch (method, path) {
        case ("GET", "/v1/health"):
            return (200, Data(#"{"ok":true,"service":"writing-desk"}"#.utf8))
        case ("POST", "/v1/sync"):
            let request: SyncRequest
            do { request = try JSONCoding.decoder().decode(SyncRequest.self, from: body) } catch {
                return (400, Data(#"{"error":"invalid sync request"}"#.utf8))
            }
            do {
                let stored = try db.load()
                let (merged, conflicts) = Sync.serverMerge(stored: stored, incoming: request.state, bases: request.bases)
                if merged != stored {
                    if let backupDir { try? db.backupIfNeeded(into: backupDir) }   // snapshot before the day's first change
                    try db.save(merged)
                }
                log("sync: \(merged.articles.count) articles, \(merged.ideas.count) ideas, \(conflicts) conflicts")
                return (200, try enc.encode(SyncResponse(state: merged, conflicts: conflicts)))
            } catch {
                log("sync error: \(error)")
                return (500, (try? enc.encode(["error": error.localizedDescription])) ?? Data())
            }
        default:
            return (404, Data(#"{"error":"not found"}"#.utf8))
        }
    }

    func respond(_ c: NWConnection, _ code: Int, _ obj: [String: String]) {
        send(c, code, (try? JSONEncoder().encode(obj)) ?? Data())
    }

    func send(_ c: NWConnection, _ code: Int, _ body: Data) {
        let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 500: "Internal Server Error"][code] ?? "Error"
        var out = Data("HTTP/1.1 \(code) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        out.append(body)
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }
}
