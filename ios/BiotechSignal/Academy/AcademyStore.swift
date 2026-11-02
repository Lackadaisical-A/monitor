import SwiftUI
import CryptoKit
import LocalAuthentication
import UniformTypeIdentifiers

@MainActor
final class AcademyStore: ObservableObject {
    @Published private(set) var workspace: AcademyWorkspace
    @Published private(set) var isDemo: Bool
    @Published var selectedStudentID: UUID?
    @Published var selectedTab = "deck"
    @Published var errorMessage: String?
    @Published var notice: String?
    @Published private(set) var storageHealthy = true
    private let directory: URL
    private let bundledCurriculum: AcademyCurriculum
    private var fingerprintKey: SymmetricKey?

    var student: AcademyStudent? { workspace.students.first { $0.id == selectedStudentID } }
    var cards: [AcademyAbility] { workspace.curriculum.abilities.sorted { $0.order < $1.order } }
    var currentCard: AcademyAbility? {
        guard let id = selectedStudentID, let progress = workspace.progress.first(where: { $0.studentID == id && $0.state == .inProgress }) else { return nil }
        return workspace.curriculum.ability(progress.abilityID)
    }
    var studentLog: [AcademyLogEntry] { workspace.log.filter { $0.studentID == selectedStudentID }.sorted { $0.date > $1.date } }
    var signedCount: Int { selectedStudentID.map { workspace.signedIDs(for: $0).count } ?? 0 }
    var availableCards: [AcademyAbility] {
        guard let student else { return [] }
        let courseSequence = workspace.curriculum.courses.first { $0.id == student.courseID }?.weeks.flatMap(\.abilities) ?? []
        return workspace.curriculum.cards(for: student.track).filter {
            workspace.progress(for: student.id, abilityID: $0.id) == nil && workspace.missingRequirements(for: $0, studentID: student.id).isEmpty
        }.sorted {
            let left = courseSequence.firstIndex(of: $0.id) ?? Int.max
            let right = courseSequence.firstIndex(of: $1.id) ?? Int.max
            return left == right ? $0.order < $1.order : left < right
        }
    }

    init(directoryOverride: URL? = nil, demoMode: Bool? = nil) {
        directory = directoryOverride ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FlightAcademy", isDirectory: true)
        let empty = AcademyCurriculum(version: 1, source: "", abilities: [], courses: [])
        var curriculum = empty
        var loadingError: Error?
        do {
            guard let url = Bundle.main.url(forResource: "academy-curriculum", withExtension: "json") else { throw AcademyError.invalidCurriculum }
            curriculum = try JSONDecoder().decode(AcademyCurriculum.self, from: Data(contentsOf: url))
            try curriculum.validate()
        } catch { loadingError = error }
        bundledCurriculum = curriculum
        let liveFile = directory.appendingPathComponent("academy.json")
        let savedMode = UserDefaults.standard.object(forKey: "academy-demo-mode") as? Bool
        isDemo = demoMode ?? savedMode ?? !FileManager.default.fileExists(atPath: liveFile.path)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--academy-demo") { isDemo = true }
        #endif
        workspace = AcademyWorkspace(curriculum: curriculum)
        do {
            if let loadingError { throw loadingError }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            let file = directory.appendingPathComponent(isDemo ? "demo.json" : "academy.json")
            if FileManager.default.fileExists(atPath: file.path) {
                workspace = try Self.decode(Data(contentsOf: file))
            } else if isDemo {
                workspace = Self.demo(curriculum)
            }
        } catch {
            storageHealthy = false
            errorMessage = "Records could not be loaded. No files were overwritten. \(error.localizedDescription)"
        }
        selectedStudentID = workspace.students.first?.id
    }

    static func decode(_ data: Data) throws -> AcademyWorkspace {
        guard data.count <= 20_000_000 else { throw AcademyError.invalidBackup }
        let value = try JSONDecoder().decode(AcademyWorkspace.self, from: data)
        try value.validate()
        return value
    }

    private func persist(_ value: AcademyWorkspace, demo: Bool? = nil) throws {
        let file = directory.appendingPathComponent((demo ?? isDemo) ? "demo.json" : "academy.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: file, options: [.atomic, .completeFileProtection])
    }

    func update(_ mutation: (inout AcademyWorkspace) throws -> Void) throws {
        guard storageHealthy else { throw AcademyError.storageUnavailable }
        var updated = workspace
        try mutation(&updated)
        try updated.validate()
        try persist(updated)
        workspace = updated
    }

    func attempt(_ work: () throws -> Void) {
        do { try work() } catch { errorMessage = error.localizedDescription }
    }

    func switchWorkspace() throws {
        guard storageHealthy else { throw AcademyError.storageUnavailable }
        let nextMode = !isDemo
        let file = directory.appendingPathComponent(nextMode ? "demo.json" : "academy.json")
        let next = FileManager.default.fileExists(atPath: file.path)
            ? try Self.decode(Data(contentsOf: file))
            : nextMode ? Self.demo(bundledCurriculum) : AcademyWorkspace(curriculum: bundledCurriculum)
        try persist(next, demo: nextMode)
        isDemo = nextMode
        workspace = next
        selectedStudentID = next.students.first?.id
        selectedTab = "deck"
        UserDefaults.standard.set(nextMode, forKey: "academy-demo-mode")
    }

    func addStudent(name: String, track: AcademyTrack, courseID: String) throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 100 else { throw AcademyError.missingStudent }
        let student = AcademyStudent(name: name, track: track, courseID: courseID)
        try update { $0.students.append(student) }
        selectedStudentID = student.id
    }

    func saveAbility(_ ability: AcademyAbility) throws {
        var edited = ability
        edited.name = edited.name.trimmingCharacters(in: .whitespacesAndNewlines)
        edited.skills = edited.skills.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        edited.revision = (workspace.curriculum.ability(ability.id)?.revision ?? 0) + 1
        try update { value in
            if let index = value.curriculum.abilities.firstIndex(where: { $0.id == edited.id }) { value.curriculum.abilities[index] = edited }
            else { value.curriculum.abilities.append(edited) }
            // A changed checklist must be demonstrated again for unfinished cards.
            for index in value.progress.indices where value.progress[index].abilityID == edited.id && value.progress[index].state == .inProgress {
                value.progress[index].checkedSkills = []
                value.progress[index].revision = edited.revision ?? 1
            }
        }
    }

    func saveChecklist(cardID: String, checked: Set<String>) throws {
        guard let studentID = selectedStudentID else { throw AcademyError.missingStudent }
        try update { value in
            guard let index = value.progress.firstIndex(where: { $0.studentID == studentID && $0.abilityID == cardID && $0.state == .inProgress }),
                  let card = value.curriculum.ability(cardID), checked.isSubset(of: Set(card.skills)) else { throw AcademyError.startFirst }
            value.progress[index].checkedSkills = card.skills.filter(checked.contains)
        }
    }

    func putAside(_ cardID: String) throws {
        guard let studentID = selectedStudentID else { throw AcademyError.missingStudent }
        try update { value in
            value.progress.removeAll { $0.studentID == studentID && $0.abilityID == cardID && $0.state == .inProgress }
        }
    }

    func authorizeInstructor() async throws {
        guard !workspace.instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.instructorRequired }
        if isDemo { return }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw error ?? NSError(domain: "Academy", code: 1, userInfo: [NSLocalizedDescriptionKey: "Set an iPhone passcode to authorize instructor sign-offs."])
        }
        try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Authorize this Academy instructor action.")
    }

    private func fingerprint(_ scan: ClubCardScan) throws -> String {
        // Load Keychain only for NFC. An unsigned simulator must still be able to
        // use the curriculum and local records without pretending to support NFC.
        if fingerprintKey == nil {
            let storedKey = KeychainStore.read(account: "academy-passport-key-v1")
            let keyHex: String
            if storedKey.isEmpty {
                guard workspace.students.allSatisfy({ $0.passportFingerprint == nil }) else { throw AcademyError.storageUnavailable }
                keyHex = try KeychainStore.randomHex()
                try KeychainStore.save(keyHex, account: "academy-passport-key-v1")
            } else { keyHex = storedKey }
            fingerprintKey = SymmetricKey(data: Data(keyHex.utf8))
        }
        guard let fingerprintKey else { throw AcademyError.storageUnavailable }
        // A keyed digest is stored; the raw tag identifier never leaves this method.
        let bytes = Data("\(scan.technology.lowercased()):\(scan.identifier.lowercased())".utf8)
        return HMAC<SHA256>.authenticationCode(for: bytes, using: fingerprintKey).map { String(format: "%02x", $0) }.joined()
    }

    func linkPassport(_ scan: ClubCardScan, studentID: UUID) throws {
        let digest = try fingerprint(scan)
        guard !workspace.students.contains(where: { $0.id != studentID && $0.passportFingerprint == digest }) else { throw AcademyError.passportInUse }
        try update { value in
            guard let index = value.students.firstIndex(where: { $0.id == studentID }) else { throw AcademyError.missingStudent }
            value.students[index].passportFingerprint = digest
        }
    }

    func identify(_ scan: ClubCardScan) throws -> AcademyStudent {
        let digest = try fingerprint(scan)
        guard let student = workspace.students.first(where: { $0.passportFingerprint == digest }) else { throw AcademyError.unknownPassport }
        return student
    }

    func scanPassport() async {
        do {
            let scan = try await ClubCardReader.shared.scan()
            let student = try identify(scan)
            selectedStudentID = student.id
            selectedTab = "deck"
            notice = "\(student.firstName)'s passport is open."
        } catch ClubCardReaderError.cancelled {} catch { errorMessage = error.localizedDescription }
    }

    func sign(cardID: String, checked: Set<String>, note: String, useNFC: Bool) async throws {
        guard let studentID = selectedStudentID else { throw AcademyError.missingStudent }
        try await authorizeInstructor()
        if useNFC {
            let scan = try await ClubCardReader.shared.scan()
            guard try identify(scan).id == studentID else { throw AcademyError.wrongPassport }
        }
        try update { try $0.sign(cardID, studentID: studentID, checked: checked, note: note, verification: useNFC ? "NFC passport + device authorization" : isDemo ? "Demo" : "Manual + device authorization") }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        notice = "Card signed. On to the next mission."
    }

    func backup() throws -> AcademyDocument {
        var exported = workspace
        // Bindings are device-specific. Portable backups never include tag fingerprints.
        for index in exported.students.indices { exported.students[index].passportFingerprint = nil }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return AcademyDocument(data: try encoder.encode(exported))
    }

    func restore(_ data: Data) throws {
        var restored = try Self.decode(data)
        for index in restored.students.indices { restored.students[index].passportFingerprint = nil }
        // Keep a recovery copy of the workspace before the user-requested replacement.
        if storageHealthy {
            let prior = try JSONEncoder().encode(workspace)
            try prior.write(to: directory.appendingPathComponent(isDemo ? "demo-before-restore.json" : "academy-before-restore.json"), options: [.atomic, .completeFileProtection])
        }
        try persist(restored)
        workspace = restored
        storageHealthy = true
        selectedStudentID = restored.students.first?.id
        notice = "Backup restored. Re-link passports on this iPhone."
    }

    static func demo(_ curriculum: AcademyCurriculum) -> AcademyWorkspace {
        let student = AcademyStudent(id: UUID(uuidString: "A17E2027-0000-4000-8000-000000000001")!, name: "Alex Morgan", track: .aerospace, courseID: "uas-101")
        let other = AcademyStudent(name: "Jordan Lee", track: .flight, courseID: "flt-101")
        let third = AcademyStudent(name: "Sam Rivera", track: .robotics, courseID: "eng-100")
        var value = AcademyWorkspace(curriculum: curriculum, students: [student, other, third], instructor: "Demo instructor")
        let earned = ["shop-safety", "hand-tool", "logbook", "flight-line", "meter-basics", "lipo", "soldering", "cad-part"]
        for (offset, id) in earned.enumerated() {
            guard let card = curriculum.ability(id) else { continue }
            let date = Calendar.current.date(byAdding: .day, value: -(earned.count - offset), to: Date()) ?? Date()
            value.progress.append(AcademyProgress(studentID: student.id, abilityID: id, state: .signed, checkedSkills: card.skills, updatedAt: date, instructor: "Demo instructor"))
            value.log.insert(AcademyLogEntry(studentID: student.id, abilityID: id, abilityName: card.name, action: "Signed off", note: "Sample record for exploring the Academy app.", instructor: "Demo instructor", date: date, skillEvidence: card.skills, verification: "Demo"), at: 0)
        }
        if let card = curriculum.ability("motor-esc") {
            value.progress.append(AcademyProgress(studentID: student.id, abilityID: card.id, state: .inProgress, checkedSkills: Array(card.skills.prefix(2))))
        }
        return value
    }
}

struct AcademyDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
