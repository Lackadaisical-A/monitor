import XCTest
@testable import BiotechSignal

final class AcademyTeachingTests: XCTestCase {
    func testLibraryRetainsAllStableCheckpointsAndValidDependencies() throws {
        let library = try AcademyTeachingLibrary.load()
        try library.validate()
        XCTAssertEqual(library.skills.count, 154)
        XCTAssertEqual(library.skills.flatMap(\.checkpoints).count, 608)
        XCTAssertEqual(Set(library.skills.flatMap(\.checkpoints).map(\.id)).count, 608)
        XCTAssertFalse(library.skills.flatMap(\.checkpoints).contains { $0.practice.isEmpty || $0.criteria.isEmpty })
        XCTAssertNotNil(UIImage(named: "AcademyBrand"))
        XCTAssertFalse(String(data: try JSONEncoder().encode(library), encoding: .utf8)!.localizedCaseInsensitiveContains("tinkercad"))
        var cycle = library
        cycle.skills[0].prerequisites = [cycle.skills[0].id]
        XCTAssertThrowsError(try cycle.validate())
    }
    @MainActor func testAwardRequiresEveryCurrentObservationAndCannotDuplicate() throws {
        let store = AcademyTeachingStore(inMemory: true)
        store.load(demo: false, students: [])
        let skill = try XCTUnwrap(store.skills.first { $0.id == "SH-01" })
        let student = UUID()
        XCTAssertFalse(store.canAward(skill, studentID: student))
        store.change { state in
            state.evidence = skill.checkpoints.map { TeachingEvidence(studentID: student, skillID: skill.id, checkpointID: $0.id, note: "Observed", instructor: "Teacher", revision: skill.revision + 1, criteria: $0.criteria) }
        }
        XCTAssertFalse(store.canAward(skill, studentID: student))
        store.change { state in for i in state.evidence.indices { state.evidence[i].revision = skill.revision } }
        XCTAssertTrue(store.canAward(skill, studentID: student))
        XCTAssertThrowsError(try store.award(skill, studentID: student, instructor: " "))
        try store.award(skill, studentID: student, instructor: "Teacher")
        XCTAssertEqual(store.state.awards.first?.evidenceIDs.count, skill.checkpoints.count)
        XCTAssertFalse(store.canAward(skill, studentID: student))
        XCTAssertThrowsError(try store.award(skill, studentID: student, instructor: "Teacher"))
    }
    @MainActor func testPausedPrerequisiteBlocksItsDependentsAndDemoIsSeparate() throws {
        let store = AcademyTeachingStore(inMemory: true), id = UUID()
        store.load(demo: false, students: [])
        let skill = try XCTUnwrap(store.skills.first { $0.prerequisites.contains("SH-01") })
        store.change { $0.awards.append(TeachingAward(studentID: id, skillID: "SH-01", instructor: "Teacher", revision: 1, evidenceIDs: [])) }
        XCTAssertFalse(store.missing(skill, studentID: id).contains("SH-01"))
        store.change { $0.awards[0].paused = true }
        XCTAssertTrue(store.missing(skill, studentID: id).contains("SH-01"))
        store.load(demo: true, students: [])
        XCTAssertTrue(store.state.awards.isEmpty)
        store.load(demo: false, students: [])
        XCTAssertEqual(store.state.awards.count, 1)
        XCTAssertTrue(store.state.awards[0].paused)
    }
    @MainActor func testCompleteBackupContainsTeachingEditsAndRejectsDanglingStudents() throws {
        let legacy = AcademyStore.demo(try JSONDecoder().decode(AcademyCurriculum.self, from: Data(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "academy-curriculum", withExtension: "json")))))
        let id = try XCTUnwrap(legacy.students.first?.id)
        var teaching = TeachingState()
        teaching.projects = [TeachingProject(title: "Test build", studentIDs: [id])]
        teaching.homework = [TeachingHomework(studentID: id, title: "Test", due: Date(), status: "Verified", evidence: "Measured prototype")]
        teaching.courseEdits = ["flt-100": [AcademyWeek(abilities: [], plan: "Edited plan", title: "Test")]]
        let backup = AcademyBackup(workspace: legacy, teaching: teaching)
        let restored = try AcademyBackup.decode(JSONEncoder().encode(backup))
        XCTAssertEqual(restored, backup)
        XCTAssertEqual(restored.workspace.log, legacy.log)
        var broken = backup
        broken.teaching.projects[0].studentIDs.append(UUID())
        XCTAssertThrowsError(try broken.validate())
        let old = try AcademyBackup.decode(JSONEncoder().encode(legacy))
        XCTAssertEqual(old.workspace, legacy)
        XCTAssertTrue(old.teaching.projects.isEmpty)
    }
    func testSyncMergesSeparateRecordsAndFieldsButStopsConflictingEdits() throws {
        func data(_ value: String) -> Data { Data(value.utf8) }
        let base = data(#"{"students":[{"id":"a","name":"Alex","goal":"Fly"}]}"#)
        let local = data(#"{"students":[{"id":"a","name":"Alex M","goal":"Fly"},{"id":"b","name":"B"}]}"#)
        let remote = data(#"{"students":[{"id":"a","name":"Alex","goal":"Build"},{"id":"c","name":"C"}]}"#)
        let result = try AcademyMerge.combine(base: base, local: local, remote: remote)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: result) as? [String: [[String: String]]])
        XCTAssertEqual(object["students"]?.count, 3)
        XCTAssertEqual(object["students"]?.first?["name"], "Alex M")
        XCTAssertEqual(object["students"]?.first?["goal"], "Build")
        let collision = data(#"{"students":[{"id":"a","name":"Alex S","goal":"Fly"}]}"#)
        XCTAssertThrowsError(try AcademyMerge.combine(base: base, local: local, remote: collision))
        let deleted = data(#"{"students":[]}"#)
        XCTAssertThrowsError(try AcademyMerge.combine(base: base, local: deleted, remote: remote))
    }
    @MainActor func testAssignedCoursePlansLoadBeforeLegacyCatalogOutlines() throws {
        let store = AcademyTeachingStore(inMemory: true)
        let url = try XCTUnwrap(Bundle.main.url(forResource: "academy-curriculum", withExtension: "json"))
        let courses = try JSONDecoder().decode(AcademyCurriculum.self, from: Data(contentsOf: url)).courses
        let aviation = try XCTUnwrap(courses.first { $0.id == "flt-100" })
        XCTAssertEqual(store.weeks(for: aviation).count, 13)
        XCTAssertTrue(store.weeks(for: aviation).allSatisfy { $0.plan.contains("90") })
    }
}
