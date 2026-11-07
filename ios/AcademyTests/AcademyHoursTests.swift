import XCTest
import CoreLocation
@testable import BiotechSignal

final class AcademyHoursTests: XCTestCase {
    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
    private func shift(start: String, end: String?, account: String = "teacher") -> AcademyHoursShift {
        .init(id: UUID().uuidString, account: account, startedAt: date(start).timeIntervalSince1970 * 1000, endedAt: end.map { date($0).timeIntervalSince1970 * 1000 }, version: 1, check: nil, adjustments: [], manualReason: "Test fixture")
    }
    func testWeekUsesNewYorkMondayAndAccountsForDaylightSavingTime() {
        let week = AcademyHoursTime.week(containing: date("2026-10-29T18:00:00Z"))
        XCTAssertEqual(week.start, date("2026-10-26T04:00:00Z"))
        XCTAssertEqual(week.end, date("2026-11-02T05:00:00Z"))
        XCTAssertEqual(week.duration, 169 * 3600)
        let next = AcademyHoursTime.week(containing: date("2026-10-29T18:00:00Z"), offset: 1)
        XCTAssertEqual(next.start, week.end)
        XCTAssertEqual(next.end, date("2026-11-09T05:00:00Z"))
    }
    func testHoursAreClippedToTheSelectedWeekWithoutRoundingAwayTime() {
        let period = AcademyHoursTime.week(containing: date("2026-11-07T18:00:00Z"))
        let crossing = shift(start: "2026-11-02T04:00:00Z", end: "2026-11-02T06:00:00Z")
        XCTAssertEqual(crossing.completedSeconds(in: period), 3600)
        let nextWeek = shift(start: "2026-11-09T04:00:00Z", end: "2026-11-09T06:00:00Z")
        XCTAssertEqual(nextWeek.completedSeconds(in: period), 3600)
        let outside = shift(start: "2026-11-01T12:00:00Z", end: "2026-11-01T13:00:00Z")
        XCTAssertEqual(outside.completedSeconds(in: period), 0)
        XCTAssertEqual(shift(start: "2026-11-07T12:00:00Z", end: nil).completedSeconds(in: period), 0)
    }
    func testRepeatedHourCountsRealElapsedTime() {
        let period = AcademyHoursTime.week(containing: date("2026-11-01T18:00:00Z"))
        let value = shift(start: "2026-11-01T05:30:00Z", end: "2026-11-01T06:30:00Z")
        XCTAssertEqual(value.completedSeconds(in: period), 3600)
    }
    func testLocationReadinessRejectsOldInaccurateAndInvalidFixes() {
        let now = date("2026-11-07T18:00:00Z")
        func fix(accuracy: Double = 5, age: TimeInterval = 0, latitude: Double = 40.741872) -> CLLocation { .init(coordinate: .init(latitude: latitude, longitude: -74.051033), altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: 0, timestamp: now.addingTimeInterval(-age)) }
        XCTAssertTrue(AcademyHoursLocationProof.isUsable(fix(), now: now))
        XCTAssertTrue(AcademyHoursLocationProof.isUsable(fix(accuracy: 20, age: 20), now: now))
        for value in [fix(accuracy: 21), fix(accuracy: -1), fix(accuracy: 0), fix(age: 21), fix(age: -11), fix(latitude: 91)] { XCTAssertFalse(AcademyHoursLocationProof.isUsable(value, now: now)) }
    }
    func testCSVIncludesCompletedTimeAndNeutralizesSpreadsheetFormulas() {
        let period = AcademyHoursTime.week(containing: date("2026-11-07T18:00:00Z"))
        let value = shift(start: "2026-11-02T04:00:00Z", end: "2026-11-02T06:00:00Z", account: "+test")
        let site = AcademyHoursSite(latitude: 40.741872, longitude: -74.051033, address: "118 Ferry Street", radiusFeet: 100, revision: 0)
        let report = AcademyHoursReport(serverNow: 0, account: "director", role: "admin", team: true, site: site, from: period.start.timeIntervalSince1970 * 1000, to: period.end.timeIntervalSince1970 * 1000, activeShift: nil, shifts: [value], staff: ["+test"])
        let csv = AcademyHoursTime.csv(report)
        XCTAssertTrue(csv.contains("\"'+test\""))
        XCTAssertTrue(csv.contains("\"1.0000\""))
        XCTAssertTrue(csv.contains("Administrator entry"))
        XCTAssertFalse(csv.contains("Test fixture"))
    }
}
