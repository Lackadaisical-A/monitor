import Foundation

enum AcademyTrack: String, Codable, CaseIterable, Identifiable {
    case flight, aerospace, robotics
    var id: String { rawValue }
    var name: String { switch self { case .flight: "Flight"; case .aerospace: "Aerospace"; case .robotics: "Engineering" } }
    var code: String { switch self { case .flight: "FLT"; case .aerospace: "UAS"; case .robotics: "ENG" } }
    var symbol: String { switch self { case .flight: "airplane"; case .aerospace: "paperplane"; case .robotics: "cpu" } }
    var subtitle: String { switch self { case .flight: "Take the controls."; case .aerospace: "Build something that flies."; case .robotics: "Design. Make. Iterate." } }
}

enum AcademyKind: String, Codable, CaseIterable, Identifiable {
    case clearance, ability, subproject, capstone, mission
    var id: String { rawValue }
    var name: String { rawValue.capitalized }
    var symbol: String { switch self { case .clearance: "checkmark.shield"; case .ability: "bolt"; case .subproject: "square.stack.3d.up"; case .capstone: "star"; case .mission: "flag" } }
}

struct AcademyAbility: Codable, Identifiable, Equatable {
    var id: String
    var course: String
    var kind: AcademyKind
    var lane: String
    var mission: String
    var name: String
    var order: Int
    var phase: Int
    var programs: [AcademyTrack]
    var requires: [String]
    var skills: [String]
    var status: String
    var unlocks: String
    var revision: Int? = 1
    var launch: String { switch status { case "spring": "Spring 2027"; case "later": "Future"; default: "Winter 2027" } }
    var laneName: String { AcademyCurriculum.lanes[lane] ?? lane.capitalized }
}

struct AcademyWeek: Codable, Equatable {
    var abilities: [String]
    var plan: String
    var title: String
}

struct AcademyCourse: Codable, Identifiable, Equatable {
    var id: String
    var ages: String
    var build: String
    var capstones: [String]
    var code: String
    var instructor: String
    var level: Int
    var name: String
    var notes: String
    var order: Int
    var prereq: String
    var status: String
    var summary: String
    var track: AcademyTrack
    var weeks: [AcademyWeek]
}

struct AcademyCurriculum: Codable, Equatable {
    var version: Int
    var source: String
    var abilities: [AcademyAbility]
    var courses: [AcademyCourse]
    static let phases = ["Ground School", "Fundamentals", "Subprojects", "Capstone", "Missions"]
    static let lanes = ["proj": "Capstones & missions", "des": "Design", "mec": "Mechanical", "ele": "Electrical", "sw": "Software", "aero": "Aerodynamics", "rkt": "Rocketry", "rp": "Remote Pilot", "air": "Airmanship", "nav": "Navigation & Weather", "atc": "Radio & ATC", "sys": "Aircraft Systems", "ops": "Operations", "doc": "Documentation"]

    func ability(_ id: String) -> AcademyAbility? { abilities.first { $0.id == id } }
    func cards(for track: AcademyTrack) -> [AcademyAbility] { abilities.filter { $0.programs.contains(track) }.sorted { $0.order < $1.order } }

    func validate() throws {
        guard version == 1, !abilities.isEmpty, abilities.count <= 500,
              Set(abilities.map(\.id)).count == abilities.count,
              Set(courses.map(\.id)).count == courses.count else { throw AcademyError.invalidCurriculum }
        let ids = Set(abilities.map(\.id))
        for card in abilities {
            guard !card.id.isEmpty, !card.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  card.name.count <= 120, card.mission.count <= 5000, !card.programs.isEmpty,
                  (1...5).contains(card.phase), (1...20).contains(card.skills.count),
                  card.skills.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 1000 }),
                  card.requires.allSatisfy({ ids.contains($0) && $0 != card.id }) else { throw AcademyError.invalidCurriculum }
        }
        var visited = Set<String>(), visiting = Set<String>()
        func visit(_ id: String) throws {
            if visiting.contains(id) { throw AcademyError.circularPrerequisite }
            guard !visited.contains(id) else { return }
            visiting.insert(id)
            for requirement in ability(id)?.requires ?? [] { try visit(requirement) }
            visiting.remove(id)
            visited.insert(id)
        }
        for card in abilities { try visit(card.id) }
        for course in courses {
            guard !course.name.isEmpty, !course.code.isEmpty,
                  course.capstones.allSatisfy(ids.contains),
                  course.weeks.flatMap(\.abilities).allSatisfy(ids.contains) else { throw AcademyError.invalidCurriculum }
        }
    }
}

struct AcademyStudent: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var track: AcademyTrack
    var courseID: String
    var createdAt = Date()
    var passportFingerprint: String?
    var initials: String { name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased() }
    var firstName: String { name.split(separator: " ").first.map(String.init) ?? name }
    var passportNumber: String { "FAA-" + id.uuidString.prefix(6).uppercased() }
}

enum AcademyProgressState: String, Codable { case inProgress, signed, paused }
struct AcademyProgress: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var abilityID: String
    var state: AcademyProgressState
    var checkedSkills: [String] = []
    var updatedAt = Date()
    var instructor = ""
    var revision = 1
}

struct AcademyLogEntry: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var abilityID: String?
    var abilityName: String
    var action: String
    var note: String
    var instructor: String
    var date = Date()
    var skillEvidence: [String] = []
    var revision: Int = 1
    var verification: String = "manual"
}

struct AcademyWorkspace: Codable, Equatable {
    var version = 1
    var curriculum: AcademyCurriculum
    var students: [AcademyStudent] = []
    var progress: [AcademyProgress] = []
    var log: [AcademyLogEntry] = []
    var instructor = ""

    func progress(for studentID: UUID, abilityID: String) -> AcademyProgress? {
        progress.first { $0.studentID == studentID && $0.abilityID == abilityID }
    }
    func signedIDs(for studentID: UUID) -> Set<String> {
        Set(progress.filter { $0.studentID == studentID && $0.state == .signed }.map(\.abilityID))
    }
    // Check the complete chain: pausing a safety clearance blocks dependent work,
    // even if an intermediate prerequisite was previously signed.
    func missingRequirements(for card: AcademyAbility, studentID: UUID) -> [AcademyAbility] {
        let signed = signedIDs(for: studentID)
        var missing = Set<String>(), seen = Set<String>()
        func check(_ id: String) {
            guard seen.insert(id).inserted, let requirement = curriculum.ability(id) else { return }
            if !signed.contains(id) { missing.insert(id) }
            for parent in requirement.requires { check(parent) }
        }
        for id in card.requires { check(id) }
        return curriculum.abilities.filter { missing.contains($0.id) }.sorted { $0.order < $1.order }
    }

    func rank(for student: AcademyStudent) -> String {
        let signed = signedIDs(for: student.id)
        if student.track == .flight {
            if signed.isSuperset(of: ["sim-checkride", "present-build"]) { return "Pilot" }
            if signed.isSuperset(of: ["flight-deck", "logbook"]) { return "Cadet" }
        } else {
            let cards = curriculum.cards(for: student.track)
            let hasLane = Set(cards.map(\.lane)).filter { !["proj", "ops", "doc"].contains($0) }.contains { lane in
                let laneCards = cards.filter { $0.lane == lane && $0.phase <= 3 }
                return !laneCards.isEmpty && laneCards.allSatisfy { signed.contains($0.id) }
            }
            if hasLane && cards.contains(where: { $0.kind == .capstone && signed.contains($0.id) }) && signed.contains("present-build") { return "Mission Specialist" }
            if signed.isSuperset(of: ["shop-safety", "hand-tool", "logbook"]) { return "Cadet" }
        }
        return "Explorer"
    }

    mutating func start(_ cardID: String, studentID: UUID) throws {
        guard let student = students.first(where: { $0.id == studentID }), let card = curriculum.ability(cardID),
              card.programs.contains(student.track) else { throw AcademyError.missingStudent }
        guard missingRequirements(for: card, studentID: studentID).isEmpty else { throw AcademyError.prerequisites }
        if let existing = progress(for: studentID, abilityID: cardID) {
            if existing.state == .inProgress { return }
            throw AcademyError.alreadySigned
        }
        guard !progress.contains(where: { $0.studentID == studentID && $0.state == .inProgress }) else { throw AcademyError.oneCardAtATime }
        progress.append(AcademyProgress(studentID: studentID, abilityID: cardID, state: .inProgress, revision: card.revision ?? 1))
    }

    mutating func sign(_ cardID: String, studentID: UUID, checked: Set<String>, note: String, verification: String) throws {
        guard !instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.instructorRequired }
        guard students.contains(where: { $0.id == studentID }), let card = curriculum.ability(cardID) else { throw AcademyError.missingStudent }
        guard let index = progress.firstIndex(where: { $0.studentID == studentID && $0.abilityID == cardID }), progress[index].state == .inProgress else { throw AcademyError.startFirst }
        guard missingRequirements(for: card, studentID: studentID).isEmpty else { throw AcademyError.prerequisites }
        guard Set(card.skills) == checked else { throw AcademyError.incompleteCheckride }
        progress[index].state = .signed
        progress[index].checkedSkills = card.skills
        progress[index].updatedAt = Date()
        progress[index].instructor = instructor
        progress[index].revision = card.revision ?? 1
        log.insert(AcademyLogEntry(studentID: studentID, abilityID: cardID, abilityName: card.name, action: "Signed off", note: note, instructor: instructor, skillEvidence: card.skills, revision: card.revision ?? 1, verification: verification), at: 0)
    }

    mutating func setClearance(_ cardID: String, studentID: UUID, paused: Bool, reason: String) throws {
        guard !instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.instructorRequired }
        guard let card = curriculum.ability(cardID), card.kind == .clearance,
              let index = progress.firstIndex(where: { $0.studentID == studentID && $0.abilityID == cardID }),
              progress[index].state == (paused ? .signed : .paused),
              !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.clearanceReason }
        if !paused && !missingRequirements(for: card, studentID: studentID).isEmpty { throw AcademyError.prerequisites }
        progress[index].state = paused ? .paused : .signed
        progress[index].updatedAt = Date()
        progress[index].instructor = instructor
        log.insert(AcademyLogEntry(studentID: studentID, abilityID: cardID, abilityName: card.name, action: paused ? "Clearance paused" : "Clearance restored", note: reason, instructor: instructor), at: 0)
    }

    func validate() throws {
        try curriculum.validate()
        guard version == 1, students.count <= 2000, log.count <= 100_000,
              Set(students.map(\.id)).count == students.count,
              Set(progress.map { "\($0.studentID):\($0.abilityID)" }).count == progress.count,
              students.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.name.count <= 100 }),
              progress.allSatisfy({ entry in students.contains { $0.id == entry.studentID } && curriculum.ability(entry.abilityID) != nil }),
              log.allSatisfy({ entry in students.contains { $0.id == entry.studentID } }) else { throw AcademyError.invalidBackup }
        for student in students {
            guard progress.filter({ $0.studentID == student.id && $0.state == .inProgress }).count <= 1 else { throw AcademyError.oneCardAtATime }
        }
    }
}

enum AcademyError: LocalizedError {
    case invalidCurriculum, circularPrerequisite, invalidBackup, missingStudent, prerequisites, oneCardAtATime, alreadySigned, startFirst, instructorRequired, incompleteCheckride, clearanceReason, passportInUse, wrongPassport, unknownPassport, storageUnavailable
    var errorDescription: String? {
        switch self {
        case .invalidCurriculum: "Check the curriculum: cards need a title, track, phase, skills, and valid prerequisites."
        case .circularPrerequisite: "These prerequisites form a loop. A card cannot depend on itself, even through another card."
        case .invalidBackup: "This file is not a valid Academy backup. Your current records have not changed."
        case .missingStudent: "Select a student and a card in their track first."
        case .prerequisites: "Complete the required cards and restore any paused clearances first."
        case .oneCardAtATime: "One card at a time. Finish or put aside the current card before starting another."
        case .alreadySigned: "This card is already signed or its clearance is paused."
        case .startFirst: "Start this card before signing it off."
        case .instructorRequired: "Add your instructor name in Workspace before signing a card."
        case .incompleteCheckride: "The student must demonstrate every skill before this card can be signed."
        case .clearanceReason: "Choose a signed clearance and add a reason for the change."
        case .passportInUse: "This passport belongs to another student. Scan a different tag."
        case .wrongPassport: "This passport does not match the selected student. Nothing was signed."
        case .unknownPassport: "This passport is not linked yet. Open a student's passport to link it."
        case .storageUnavailable: "Academy records could not be opened. Restore a backup or free up space, then reopen the app."
        }
    }
}
