import Foundation

/// Daily word goal plus a per-day history of words written.
/// Only net *new* words count: deleting text never reduces a day's total.
///
/// Words are recorded per device (`byDevice[deviceID][day]`). Each device's counts only grow,
/// so two Macs can merge by taking the max per device/day and summing devices, with no double counting.
public struct Accountability: Codable, Equatable {
    public var dailyGoal: Int = 500
    /// When the goal was last changed (nil = never set, i.e. the default). Newest wins when syncing.
    public var goalUpdated: Date?
    /// device id -> "yyyy-MM-dd" -> words written on that device that day.
    public var byDevice: [String: [String: Int]] = [:]

    /// Device key used for history migrated from v1 files (renamed to the real device id on load).
    public static let legacyDevice = "legacy"
    public static let defaultDevice = "this-mac"

    public init(dailyGoal: Int = 500, byDevice: [String: [String: Int]] = [:]) {
        self.dailyGoal = dailyGoal
        self.byDevice = byDevice
    }

    enum CodingKeys: String, CodingKey { case dailyGoal, goalUpdated, byDevice, history }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dailyGoal = try c.decodeIfPresent(Int.self, forKey: .dailyGoal) ?? 500
        goalUpdated = try c.decodeIfPresent(Date.self, forKey: .goalUpdated)
        byDevice = try c.decodeIfPresent([String: [String: Int]].self, forKey: .byDevice) ?? [:]
        // v1 stored a single `history`; keep it under a legacy device key.
        if let legacy = try c.decodeIfPresent([String: Int].self, forKey: .history), !legacy.isEmpty {
            byDevice[Self.legacyDevice, default: [:]].merge(legacy, uniquingKeysWith: max)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(dailyGoal, forKey: .dailyGoal)
        try c.encodeIfPresent(goalUpdated, forKey: .goalUpdated)
        try c.encode(byDevice, forKey: .byDevice)
    }

    /// Combined words per day across all devices.
    public var history: [String: Int] {
        var total: [String: Int] = [:]
        for days in byDevice.values { total.merge(days, uniquingKeysWith: +) }
        return total
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    public mutating func recordEdit(oldWordCount: Int, newWordCount: Int, on date: Date = Date(), device: String = defaultDevice) {
        let delta = newWordCount - oldWordCount
        guard delta > 0 else { return }
        byDevice[device, default: [:]][Self.dayKey(date), default: 0] += delta
    }

    public mutating func setGoal(_ goal: Int, at date: Date = Date()) {
        dailyGoal = goal
        goalUpdated = date
    }

    /// Moves history from `from` into `to` (used to give migrated v1 history this Mac's id).
    public mutating func renameDevice(_ from: String, to: String) {
        guard from != to, let days = byDevice.removeValue(forKey: from) else { return }
        byDevice[to, default: [:]].merge(days, uniquingKeysWith: +)
    }

    public func words(on date: Date = Date()) -> Int {
        let key = Self.dayKey(date)
        return byDevice.values.reduce(0) { $0 + ($1[key] ?? 0) }
    }

    public func progress(on date: Date = Date()) -> Double {
        guard dailyGoal > 0 else { return 1 }
        return min(1, Double(words(on: date)) / Double(dailyGoal))
    }

    public func goalMet(on date: Date) -> Bool { dailyGoal > 0 && words(on: date) >= dailyGoal }

    /// Consecutive days meeting the goal, ending today (or yesterday if today isn't met yet).
    public func streak(asOf date: Date = Date(), calendar: Calendar = .current) -> Int {
        var day = calendar.startOfDay(for: date)
        if !goalMet(on: day) { day = calendar.date(byAdding: .day, value: -1, to: day)! }
        var n = 0
        while goalMet(on: day) {
            n += 1
            day = calendar.date(byAdding: .day, value: -1, to: day)!
        }
        return n
    }

    /// Last `days` days, oldest first.
    public func recent(days: Int, asOf date: Date = Date(), calendar: Calendar = .current) -> [(day: String, words: Int)] {
        (0..<days).reversed().map { offset in
            let d = calendar.date(byAdding: .day, value: -offset, to: date)!
            return (Self.dayKey(d), words(on: d))
        }
    }
}
