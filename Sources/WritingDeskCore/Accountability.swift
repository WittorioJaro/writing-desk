import Foundation

/// Daily word goal plus a per-day history of words written.
/// Only net *new* words count: deleting text never reduces a day's total.
public struct Accountability: Codable, Equatable {
    public var dailyGoal: Int = 500
    /// "yyyy-MM-dd" -> words written that day.
    public var history: [String: Int] = [:]

    public init(dailyGoal: Int = 500, history: [String: Int] = [:]) {
        self.dailyGoal = dailyGoal
        self.history = history
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    public mutating func recordEdit(oldWordCount: Int, newWordCount: Int, on date: Date = Date()) {
        let delta = newWordCount - oldWordCount
        guard delta > 0 else { return }
        history[Self.dayKey(date), default: 0] += delta
    }

    public func words(on date: Date = Date()) -> Int { history[Self.dayKey(date)] ?? 0 }

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
