import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Offline, deterministic, text-free cover art derived from article content.
/// All covers are exactly 5:2. No network, no AI, no article text is rendered or sent anywhere.
public enum CoverStyle: String, CaseIterable, Identifiable {
    case orbit, grid, waves, monolith, rhythm
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .orbit: "Orbit"; case .grid: "Grid"; case .waves: "Waves"
        case .monolith: "Monolith"; case .rhythm: "Rhythm"
        }
    }
}

/// Topic signal extracted from the article.
public struct CoverSeed: Equatable {
    public let keywords: [String]
    public let sentenceLengths: [Int]
    public let hash: UInt64

    public init(title: String, body: String) {
        let text = title + "\n" + body
        keywords = Self.keywords(text, limit: 6)
        let sentences = body.components(separatedBy: CharacterSet(charactersIn: ".!?\n")).map(WordCounter.count).filter { $0 > 0 }
        sentenceLengths = sentences.isEmpty ? [3, 5, 2] : Array(sentences.prefix(48))
        var h: UInt64 = 0xcbf29ce484222325
        for b in (keywords.joined(separator: " ") + "|" + text).utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        hash = h
    }

    static let stop: Set<String> = Set("""
    the a an and or but if then of to in on at for with by from as is are was were be been being it its this that these those \
    i you he she we they me my your our their not no so do does did have has had will would can could should just than too very \
    about into over also more most some such what which who whom when where why how all any each there here out up down only own \
    same other again further once while because until both few nor off under above below between through during before after
    """.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))

    static func keywords(_ text: String, limit: Int) -> [String] {
        var freq: [String: Int] = [:]
        text.lowercased().enumerateSubstrings(in: text.lowercased().startIndex..., options: .byWords) { w, _, _, _ in
            guard let w, w.count > 2, !stop.contains(w), !w.allSatisfy(\.isNumber) else { return }
            freq[w, default: 0] += 1
        }
        return freq.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(limit).map(\.key)
    }
}

struct SplitMix64 {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func range(_ a: Double, _ b: Double) -> Double { a + (b - a) * unit() }
}

struct Palette {
    let bg: CGColor, ink: CGColor, accent: CGColor, soft: CGColor

    static func hsb(_ h: Double, _ s: Double, _ b: Double, _ a: Double = 1) -> CGColor {
        let h6 = (h - floor(h)) * 6, i = Int(h6) % 6, f = h6 - floor(h6)
        let p = b * (1 - s), q = b * (1 - s * f), t = b * (1 - s * (1 - f))
        let (r, g, bl): (Double, Double, Double) = [(b, t, p), (q, b, p), (p, b, t), (p, q, b), (t, p, b), (b, p, q)][i]
        return CGColor(srgbRed: r, green: g, blue: bl, alpha: a)
    }

    init(seed: CoverSeed, style: CoverStyle) {
        var rng = SplitMix64(state: seed.hash)
        let hue = rng.unit()
        let dark = (seed.hash >> 7 & 1 == 0) != (style.hashValueStable % 2 == 0)
        if dark {
            bg = Self.hsb(hue, 0.35, 0.12); ink = Self.hsb(hue, 0.08, 0.92)
            soft = Self.hsb(hue, 0.25, 0.30)
        } else {
            bg = Self.hsb(hue, 0.06, 0.96); ink = Self.hsb(hue, 0.45, 0.16)
            soft = Self.hsb(hue, 0.12, 0.84)
        }
        accent = Self.hsb(hue + 0.5 + rng.range(-0.08, 0.08), 0.78, 0.95)
    }
}

extension CoverStyle {
    var hashValueStable: Int { CoverStyle.allCases.firstIndex(of: self)! }
}

public enum CoverGenerator {
    public static let width = 1500
    public static let height = 600   // 1500:600 == 5:2

    public static func render(title: String, body: String, style: CoverStyle, width: Int = width) -> CGImage {
        render(seed: CoverSeed(title: title, body: body), style: style, width: width)
    }

    public static func render(seed: CoverSeed, style: CoverStyle, width: Int = width) -> CGImage {
        let height = width * 2 / 5
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let W = Double(width), H = Double(height)
        let pal = Palette(seed: seed, style: style)
        var rng = SplitMix64(state: seed.hash ^ UInt64(style.hashValueStable + 1) &* 0x9E3779B97F4A7C15)
        // Per-keyword values give each topic its own geometry.
        let kw = seed.keywords.isEmpty ? ["blank"] : seed.keywords
        let kv = kw.map { w in Double(w.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 9973 }) / 9973 }

        ctx.setFillColor(pal.bg); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.setLineCap(.round)

        switch style {
        case .orbit:
            let c = CGPoint(x: W * (0.55 + 0.3 * kv[0]), y: H * rng.range(0.3, 0.7))
            ctx.setStrokeColor(pal.ink.copy(alpha: 0.55)!)
            ctx.setLineWidth(H * 0.006)
            for (i, v) in kv.enumerated() {
                let r = H * (0.18 + 0.16 * Double(i) + 0.08 * v)
                ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
            }
            let r = H * (0.06 + 0.06 * kv[kv.count - 1])
            let ring = min(1, kv.count - 1), rr = H * (0.18 + 0.16 * Double(ring) + 0.08 * kv[ring])
            // Pick the angle so the accent dot stays fully inside the canvas.
            var ang = rng.range(0, 2 * .pi), p = CGPoint.zero
            for _ in 0..<24 {
                p = CGPoint(x: c.x + rr * cos(ang), y: c.y + rr * sin(ang))
                if p.x - r > 0, p.x + r < W, p.y - r > 0, p.y + r < H { break }
                ang += .pi / 12
            }
            ctx.setFillColor(pal.accent)
            ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))

        case .grid:
            let cols = 25, rows = 10, cell = W / Double(cols), pad = cell * 0.18
            let bits = Array(kw.joined().utf8)
            for row in 0..<rows {
                for col in 0..<cols {
                    let b = bits[(row * cols + col) % bits.count]
                    let on = (Int(b) >> ((row + col) % 7)) & 1 == 1 && rng.unit() < 0.55
                    guard on else { continue }
                    let rect = CGRect(x: Double(col) * cell + pad, y: Double(row) * cell * (H / (cell * Double(rows))) + pad,
                                      width: cell - 2 * pad, height: H / Double(rows) - 2 * pad)
                    ctx.setFillColor(rng.unit() < 0.06 ? pal.accent : pal.soft)
                    ctx.fill(rect)
                }
            }

        case .waves:
            let lines = 6 + seed.keywords.count * 2
            for i in 0..<lines {
                let base = H * (0.15 + 0.7 * Double(i) / Double(max(1, lines - 1)))
                let amp = H * 0.06 * Double(seed.sentenceLengths[i % seed.sentenceLengths.count] % 9 + 1) / 9
                let freq = 1.5 + 4 * kv[i % kv.count], phase = rng.range(0, 2 * .pi)
                let path = CGMutablePath()
                for x in stride(from: 0.0, through: W, by: 6) {
                    let y = base + amp * sin(phase + freq * 2 * .pi * x / W)
                    x == 0 ? path.move(to: CGPoint(x: x, y: y)) : path.addLine(to: CGPoint(x: x, y: y))
                }
                ctx.addPath(path)
                ctx.setStrokeColor(i == lines / 2 ? pal.accent : pal.ink.copy(alpha: 0.35)!)
                ctx.setLineWidth(i == lines / 2 ? H * 0.012 : H * 0.004)
                ctx.strokePath()
            }

        case .monolith:
            let split = W * (0.3 + 0.4 * kv[0]), tilt = W * (kv[kv.count > 1 ? 1 : 0] - 0.5) * 0.4
            ctx.setFillColor(pal.soft)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: split - tilt, y: 0)); ctx.addLine(to: CGPoint(x: W, y: 0))
            ctx.addLine(to: CGPoint(x: W, y: H)); ctx.addLine(to: CGPoint(x: split + tilt, y: H))
            ctx.closePath(); ctx.fillPath()
            let bw = W * 0.05, bh = H * (0.35 + 0.4 * rng.unit())
            ctx.setFillColor(pal.ink)
            ctx.fill(CGRect(x: split + W * 0.12, y: (H - bh) / 2, width: bw, height: bh))
            let r = H * 0.09
            ctx.setFillColor(pal.accent)
            ctx.fillEllipse(in: CGRect(x: W * (0.08 + 0.15 * rng.unit()), y: H * rng.range(0.25, 0.6), width: 2 * r, height: 2 * r))

        case .rhythm:
            let n = seed.sentenceLengths.count
            let gap = W * 0.6 / Double(max(n, 1)), x0 = W * 0.2
            let maxLen = Double(seed.sentenceLengths.max() ?? 1)
            let hi = seed.sentenceLengths.firstIndex(of: seed.sentenceLengths.max() ?? 0) ?? 0
            for (i, len) in seed.sentenceLengths.enumerated() {
                let h = H * 0.08 + H * 0.6 * Double(len) / maxLen
                ctx.setFillColor(i == hi ? pal.accent : pal.ink.copy(alpha: 0.8)!)
                ctx.fill(CGRect(x: x0 + Double(i) * gap, y: (H - h) / 2, width: max(2, gap * 0.45), height: h))
            }
        }
        return ctx.makeImage()!
    }

    public static func pngData(_ image: CGImage) -> Data {
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
    }

    public static func exportPNG(_ image: CGImage, to url: URL) throws {
        try pngData(image).write(to: url, options: .atomic)
    }
}
