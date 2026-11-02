import XCTest
@testable import BiotechSignal

final class AcademyTests: XCTestCase {
    private func curriculum() throws -> AcademyCurriculum {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "academy-curriculum", withExtension: "json"))
        return try JSONDecoder().decode(AcademyCurriculum.self, from: Data(contentsOf: url))
    }

    private func workspace() throws -> AcademyWorkspace {
        var workspace = AcademyWorkspace(curriculum: try curriculum())
        workspace.students = [AcademyStudent(name: "Test Student", track: .aerospace, courseID: "uas-101")]
        workspace.instructor = "Test Instructor"
        return workspace
    }

    private func earn(_ id: String, in workspace: inout AcademyWorkspace) throws {
        let student = try XCTUnwrap(workspace.students.first)
        let card = try XCTUnwrap(workspace.curriculum.ability(id))
        try workspace.start(id, studentID: student.id)
        try workspace.sign(id, studentID: student.id, checked: Set(card.skills), note: "Observed", verification: "Test")
    }

    func testImportedCurriculumHasValidReferencesAndNoCycles() throws {
        let curriculum = try curriculum()
        try curriculum.validate()
        XCTAssertEqual(curriculum.abilities.count, 74)
        XCTAssertEqual(curriculum.courses.count, 15)
        XCTAssertEqual(curriculum.abilities.reduce(0) { $0 + $1.skills.count }, 250)
    }

    func testPrerequisitesAndOneCardInProgressAreEnforced() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        XCTAssertThrowsError(try workspace.start("motor-esc", studentID: student.id))
        try workspace.start("shop-safety", studentID: student.id)
        XCTAssertThrowsError(try workspace.start("logbook", studentID: student.id))
        try workspace.start("shop-safety", studentID: student.id)
        XCTAssertEqual(workspace.progress.count, 1)
    }

    func testSignOffRequiresEverySkillAndInstructorAndCannotDuplicate() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        let card = try XCTUnwrap(workspace.curriculum.ability("shop-safety"))
        try workspace.start(card.id, studentID: student.id)
        XCTAssertThrowsError(try workspace.sign(card.id, studentID: student.id, checked: Set(card.skills.dropLast()), note: "", verification: "Test"))
        workspace.instructor = " "
        XCTAssertThrowsError(try workspace.sign(card.id, studentID: student.id, checked: Set(card.skills), note: "", verification: "Test"))
        workspace.instructor = "Test Instructor"
        try workspace.sign(card.id, studentID: student.id, checked: Set(card.skills), note: "Observed every skill", verification: "NFC")
        XCTAssertEqual(workspace.log.count, 1)
        XCTAssertEqual(workspace.log.first?.skillEvidence, card.skills)
        XCTAssertEqual(workspace.log.first?.verification, "NFC")
        XCTAssertThrowsError(try workspace.sign(card.id, studentID: student.id, checked: Set(card.skills), note: "", verification: "Test"))
        XCTAssertEqual(workspace.log.count, 1)
    }

    func testPausingClearanceBlocksTransitiveDependentsAndCanBeRestored() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        for id in ["shop-safety", "soldering", "meter-basics", "lipo"] { try earn(id, in: &workspace) }
        let motor = try XCTUnwrap(workspace.curriculum.ability("motor-esc"))
        XCTAssertTrue(workspace.missingRequirements(for: motor, studentID: student.id).isEmpty)
        try workspace.setClearance("shop-safety", studentID: student.id, paused: true, reason: "Safety refresher needed")
        XCTAssertTrue(workspace.missingRequirements(for: motor, studentID: student.id).contains { $0.id == "shop-safety" })
        XCTAssertThrowsError(try workspace.start("motor-esc", studentID: student.id))
        try workspace.setClearance("shop-safety", studentID: student.id, paused: false, reason: "Refresher demonstrated")
        try workspace.start("motor-esc", studentID: student.id)
        XCTAssertEqual(workspace.progress(for: student.id, abilityID: "motor-esc")?.state, .inProgress)
    }

    func testClearancePausedAfterCardStartedAlsoBlocksSignOff() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        try earn("shop-safety", in: &workspace)
        try workspace.start("cad-part", studentID: student.id)
        try workspace.setClearance("shop-safety", studentID: student.id, paused: true, reason: "Refresher")
        let card = try XCTUnwrap(workspace.curriculum.ability("cad-part"))
        XCTAssertThrowsError(try workspace.sign(card.id, studentID: student.id, checked: Set(card.skills), note: "", verification: "Test"))
    }

    func testOnlyClearancesCanBePausedAndReasonIsRequired() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        try earn("logbook", in: &workspace)
        XCTAssertThrowsError(try workspace.setClearance("logbook", studentID: student.id, paused: true, reason: "Reason"))
        try earn("shop-safety", in: &workspace)
        XCTAssertThrowsError(try workspace.setClearance("shop-safety", studentID: student.id, paused: true, reason: " "))
    }

    func testCurriculumEditsRejectCircularDependenciesAndDanglingCards() throws {
        var curriculum = try curriculum()
        let index = try XCTUnwrap(curriculum.abilities.firstIndex { $0.id == "shop-safety" })
        curriculum.abilities[index].requires = ["soldering"]
        XCTAssertThrowsError(try curriculum.validate())
        curriculum.abilities[index].requires = ["does-not-exist"]
        XCTAssertThrowsError(try curriculum.validate())
    }

    func testCadetRankRequiresActualGroundSchoolAndLogbook() throws {
        var workspace = try workspace()
        let student = try XCTUnwrap(workspace.students.first)
        XCTAssertEqual(workspace.rank(for: student), "Explorer")
        for id in ["shop-safety", "hand-tool"] { try earn(id, in: &workspace) }
        XCTAssertEqual(workspace.rank(for: student), "Explorer")
        try earn("logbook", in: &workspace)
        XCTAssertEqual(workspace.rank(for: student), "Cadet")
    }

    func testRoundTripPreservesSignedEvidenceAndRejectsOrphanProgress() throws {
        var workspace = try workspace()
        try earn("shop-safety", in: &workspace)
        let restored = try JSONDecoder().decode(AcademyWorkspace.self, from: JSONEncoder().encode(workspace))
        try restored.validate()
        XCTAssertEqual(restored, workspace)
        workspace.students = []
        XCTAssertThrowsError(try workspace.validate())
    }

    func testCannotStartCardOutsideStudentsTrack() throws {
        var workspace = try workspace()
        let id = try XCTUnwrap(workspace.students.first?.id)
        XCTAssertThrowsError(try workspace.start("flight-deck", studentID: id))
    }

    @MainActor
    func testLocalWorkspaceCanSaveAndReloadWithoutNFCKeychainAccess() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AcademyStore(directoryOverride: directory, demoMode: true)
        XCTAssertTrue(store.storageHealthy)
        try store.addStudent(name: "Persistence Test", track: .flight, courseID: "flt-101")
        let reopened = AcademyStore(directoryOverride: directory, demoMode: true)
        XCTAssertTrue(reopened.storageHealthy)
        XCTAssertEqual(reopened.workspace.students.last?.name, "Persistence Test")
        XCTAssertEqual(store.workspace, reopened.workspace)
    }

    @MainActor
    func testBackupOmitsPassportBindingsAndFailedRestoreLeavesWorkspaceIntact() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AcademyStore(directoryOverride: directory, demoMode: true)
        try store.update { $0.students[0].passportFingerprint = "test-fingerprint" }
        let backup = try AcademyStore.decode(store.backup().data)
        XCTAssertNil(backup.students[0].passportFingerprint)
        let original = store.workspace
        XCTAssertThrowsError(try store.restore(Data("invalid".utf8)))
        XCTAssertEqual(store.workspace, original)
        try store.restore(try store.backup().data)
        XCTAssertNil(store.workspace.students[0].passportFingerprint)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("demo-before-restore.json").path))
    }
}
