import Foundation
import CoreLocation

struct AcademyHoursSite: Codable, Equatable {
    var latitude: Double; var longitude: Double; var address: String; var radiusFeet: Int; var revision: Int
    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
}
struct AcademyHoursShift: Codable, Identifiable, Equatable {
    struct Check: Codable, Equatable { var distanceMeters: Double; var accuracyMeters: Double; var siteRevision: Int; var radiusFeet: Int }
    struct Adjustment: Codable, Equatable { var actor: String; var at: Double; var reason: String; var previousStart: Double; var previousEnd: Double? }
    var id: String; var account: String; var startedAt: Double; var endedAt: Double?; var version: Int
    var check: Check?; var adjustments: [Adjustment]; var manualReason: String?
    var start: Date { Date(timeIntervalSince1970: startedAt / 1000) }
    var end: Date? { endedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    func completedSeconds(in range: DateInterval) -> TimeInterval {
        guard let end else { return 0 }
        return max(0, min(end, range.end).timeIntervalSince(max(start, range.start)))
    }
}
struct AcademyHoursReport: Decodable {
    var serverNow: Double; var account: String; var role: String; var team: Bool; var site: AcademyHoursSite
    var from: Double; var to: Double; var activeShift: AcademyHoursShift?; var shifts: [AcademyHoursShift]; var staff: [String]
}
struct AcademyHoursSaved: Decodable { var shift: AcademyHoursShift; var serverNow: Double }
enum AcademyHoursTime {
    static var calendar: Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: "America/New_York")!; value.firstWeekday = 2; value.minimumDaysInFirstWeek = 4; return value }
    static func week(containing date: Date = Date(), offset: Int = 0) -> DateInterval {
        let calendar = calendar, shifted = calendar.date(byAdding: .weekOfYear, value: offset, to: date)!
        let start = calendar.dateInterval(of: .weekOfYear, for: shifted)!.start
        return DateInterval(start: start, end: calendar.date(byAdding: .day, value: 7, to: start)!)
    }
    static func milliseconds(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }
    static func date(_ value: Date) -> String { let f = DateFormatter(); f.timeZone = calendar.timeZone; f.dateFormat = "EEE, MMM d"; return f.string(from: value) }
    static func time(_ value: Date) -> String { let f = DateFormatter(); f.timeZone = calendar.timeZone; f.dateFormat = "h:mm a"; return f.string(from: value) }
    static func duration(_ seconds: TimeInterval) -> String { let minutes = max(0, Int(seconds / 60)); return "\(minutes / 60)h \(minutes % 60)m" }
    static func csv(_ report: AcademyHoursReport) -> String {
        func escaped(_ value: String) -> String { let safe = value.first.map { "=+-@\t\r".contains($0) } == true ? "'" + value : value; return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        let iso = ISO8601DateFormatter()
        let period = DateInterval(start: Date(timeIntervalSince1970: report.from / 1000), end: Date(timeIntervalSince1970: report.to / 1000))
        var rows = [["Instructor", "Start (UTC)", "End (UTC)", "Completed hours in selected week", "Status", "Verification", "Corrections"]]
        rows += report.shifts.map { shift in [shift.account, iso.string(from: shift.start), shift.end.map(iso.string) ?? "", String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), shift.completedSeconds(in: period) / 3600), shift.end == nil ? "Open" : "Completed", shift.check == nil ? "Administrator entry" : "Location checked", String(shift.adjustments.count)] }
        return rows.map { $0.map(escaped).joined(separator: ",") }.joined(separator: "\r\n")
    }
}

struct AcademyHoursLocationProof: Encodable {
    var latitude: Double; var longitude: Double; var accuracy: Double; var capturedAt: Int64; var simulated: Bool; var precise: Bool
    static func isUsable(_ location: CLLocation, now: Date = Date()) -> Bool {
        CLLocationCoordinate2DIsValid(location.coordinate) && location.horizontalAccuracy > 0 && location.horizontalAccuracy <= 20 && now.timeIntervalSince(location.timestamp) >= -10 && now.timeIntervalSince(location.timestamp) <= 20 && location.sourceInformation?.isSimulatedBySoftware != true
    }
}
