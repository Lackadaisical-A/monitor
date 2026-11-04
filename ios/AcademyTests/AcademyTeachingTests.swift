import XCTest
import CoreNFC
import ImageIO
@testable import BiotechSignal

final class AcademyTeachingTests: XCTestCase {
    func testClassLogBackupCompatibilityAndStudentMembership() throws {
        let resource = try XCTUnwrap(Bundle.main.url(forResource: "academy-curriculum", withExtension: "json"))
        var workspace = AcademyWorkspace(curriculum: try JSONDecoder().decode(AcademyCurriculum.self, from: Data(contentsOf: resource)))
        let student = AcademyStudent(name: "Journal Student", track: .aerospace, courseID: "uas-101")
        workspace.students = [student]
        let old = try JSONEncoder().encode(AcademyBackup(workspace: workspace, teaching: TeachingState()))
        XCTAssertNil(try AcademyBackup.decode(old).teaching.classLogs)
        var teaching = TeachingState()
        teaching.sessions = [TeachingSession(id: "class", day: "Wednesday", slot: "4 PM", course: "Design", instructor: "Teacher", studentIDs: [student.id], sourceLabel: "Test")]
        var entry = AcademyClassLog(studentID: student.id, sessionID: "class", classDate: "2026-11-04", instructor: "Teacher")
        entry.accomplishments = "Tested a wing"; entry.privateNotes = "Teacher only"; entry.published = true; entry.photoIDs = [UUID()]
        teaching.classLogs = [entry]
        let backup = AcademyBackup(workspace: workspace, teaching: teaching)
        XCTAssertEqual(try AcademyBackup.decode(JSONEncoder().encode(backup)), backup)
        teaching.classLogs?[0].studentID = UUID()
        XCTAssertThrowsError(try AcademyBackup(workspace: workspace, teaching: teaching).validate())
        teaching.classLogs = [entry, entry]
        XCTAssertThrowsError(try AcademyBackup(workspace: workspace, teaching: teaching).validate())
        entry.classDate = "2026-02-30"; XCTAssertThrowsError(try entry.validate())
        entry.classDate = "2026-11-04"; entry.accomplishments = " "; XCTAssertThrowsError(try entry.validate())
    }
    @MainActor func testClassDraftPersistsSeparatelyFromDemoAndMergesIndependentUpdates() throws {
        let store = AcademyTeachingStore(inMemory: true), student = UUID()
        store.load(demo: false, students: [])
        let entry = AcademyClassLog(studentID: student, sessionID: "class", classDate: "2026-11-04", instructor: "Teacher")
        XCTAssertTrue(store.change { $0.classLogs = [entry] })
        store.load(demo: true, students: []); XCTAssertNil(store.state.classLogs)
        store.load(demo: false, students: []); XCTAssertEqual(store.state.classLogs, [entry])
        var local = TeachingState(), remote = TeachingState()
        local.classLogs = [entry]
        var other = entry; other.id = UUID(); other.accomplishments = "A different update"; remote.classLogs = [other]
        let merged = try AcademyMerge.combine(base: JSONEncoder().encode(TeachingState()), local: JSONEncoder().encode(local), remote: JSONEncoder().encode(remote))
        XCTAssertEqual(try JSONDecoder().decode(TeachingState.self, from: merged).classLogs?.count, 2)
    }
    @MainActor func testClassPhotoResizesAndRemovesLocationMetadata() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000)).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        let sourceData = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(sourceData, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(image.cgImage), [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 40.7, kCGImagePropertyGPSLongitude: 74.0]] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let data = try AcademyPhotos.prepare(sourceData as Data)
        XCTAssertLessThanOrEqual(data.count, 950_000)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 1600)
        XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 800)
    }
    func testInstructorCardAcceptsOnlyVersionedCredentialAndRejectsStudentTags() throws {
        let token = String(repeating: "A", count: 43)
        let message = try AcademyInstructorCardPayload.message(token)
        XCTAssertEqual(try AcademyInstructorCardPayload.token(message), token)
        XCTAssertLessThanOrEqual(message.length, 144)
        XCTAssertThrowsError(try AcademyInstructorCardPayload.message("aabbccdd"))
        let studentTag = NFCNDEFMessage(records: [NFCNDEFPayload.wellKnownTypeTextPayload(string: "Student passport", locale: Locale(identifier: "en"))!])
        XCTAssertThrowsError(try AcademyInstructorCardPayload.token(studentTag))
        XCTAssertThrowsError(try AcademyInstructorCardPayload.token(NFCNDEFMessage(records: message.records + message.records)))
    }
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
