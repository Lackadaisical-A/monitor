import Foundation
import SwiftData

struct AcademyCheckpoint: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var practice: String
    var criteria: String
}
struct AcademySkillLesson: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var pathway: String
    var tier: String
    var kind: String
    var objective: String
    var prerequisites: [String]
    var checkpoints: [AcademyCheckpoint]
    var preparation: String
    var reflection: String
    var guidance: String
    var status: String
    var sourceURL: String
    var revision: Int
    var unlocks: String
    var referenceURL: String
}
struct AcademyTeachingLibrary: Codable {
    var version: Int
    var source: String
    var skills: [AcademySkillLesson]
    static func load() throws -> Self {
        guard let url = Bundle.main.url(forResource: "academy-lessons", withExtension: "json") else { throw AcademyError.invalidCurriculum }
        let library = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        try library.validate()
        return library
    }
    func validate() throws {
        let ids = Set(skills.map(\.id))
        guard ids.count == skills.count, !skills.isEmpty else { throw AcademyError.invalidCurriculum }
        var visiting = Set<String>(), visited = Set<String>()
        func visit(_ id: String) throws {
            guard !visiting.contains(id) else { throw AcademyError.circularPrerequisite }
            if visited.contains(id) { return }
            visiting.insert(id)
            guard let skill = skills.first(where: { $0.id == id }), !skill.title.isEmpty,
                  !skill.checkpoints.isEmpty, Set(skill.checkpoints.map(\.id)).count == skill.checkpoints.count,
                  skill.prerequisites.allSatisfy(ids.contains) else { throw AcademyError.invalidCurriculum }
            for prerequisite in skill.prerequisites { try visit(prerequisite) }
            visiting.remove(id); visited.insert(id)
        }
        for id in ids { try visit(id) }
    }
}
struct TeachingProject: Codable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var studentIDs: [UUID]
    var semester = "Fall 2026"
    var stage = "Plan"
    var nextTask = ""
    var blocker = ""
    var materials = ""
    var cadURL = ""
    var partsURL = ""
    var notes = ""
}
struct TeachingHomework: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var title: String
    var due: Date
    var status = "Assigned"
    var evidence = ""
}
struct TeachingGoal: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var title: String
    var semester = "Fall 2026"
    var completed = false
}
struct TeachingEvidence: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var skillID: String
    var checkpointID: String
    var note: String
    var instructor: String
    var date = Date()
    var revision: Int
    var criteria: String
}
struct TeachingAward: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var skillID: String
    var instructor: String
    var date = Date()
    var revision: Int
    var evidenceIDs: [UUID]
    var paused = false
    var statusNotes: [String]? = nil
}
struct TeachingSession: Codable, Identifiable, Equatable {
    var id: String
    var day: String
    var slot: String
    var course: String
    var instructor: String
    var studentIDs: [UUID]
    var sourceLabel: String
}
struct TeachingDuty: Codable, Identifiable, Equatable {
    var id: String
    var day: String
    var studio: String
    var instructors: [String]
    var sourceLabel: String
}
struct TeachingRoster: Codable {
    var source: String
    var students: [AcademyStudent]
    var sessions: [TeachingSession]
    var instructors: [String]
    var projects: [TeachingProject]?
    var duties: [TeachingDuty]?
}
struct TeachingState: Codable, Equatable {
    var projects: [TeachingProject] = []
    var homework: [TeachingHomework] = []
    var goals: [TeachingGoal] = []
    var evidence: [TeachingEvidence] = []
    var awards: [TeachingAward] = []
    var sessions: [TeachingSession] = []
    var instructors: [String] = []
    var lessonEdits: [String: AcademySkillLesson] = [:]
    var courseEdits: [String: [AcademyWeek]]? = nil
    var duties: [TeachingDuty]? = nil
}

@Model final class TeachingSnapshot {
    @Attribute(.unique) var key: String
    var payload: Data
    var updatedAt: Date
    init(key: String, payload: Data) { self.key = key; self.payload = payload; updatedAt = Date() }
}

@MainActor final class AcademyTeachingStore: ObservableObject {
    @Published private(set) var state = TeachingState()
    @Published private(set) var library: AcademyTeachingLibrary?
    @Published var error: String?
    private var container: ModelContainer?
    private var key = "live"
    private var loaded = false
    private(set) var healthy = true
    var skills: [AcademySkillLesson] { (library?.skills ?? []).map { state.lessonEdits[$0.id] ?? $0 } }
    init(inMemory: Bool = false) {
        do {
            library = try .load()
            let configuration = ModelConfiguration("AcademyTeaching", isStoredInMemoryOnly: inMemory, cloudKitDatabase: .none)
            container = try ModelContainer(for: TeachingSnapshot.self, configurations: configuration)
        } catch { healthy = false; self.error = "Teaching records could not be opened: \(error.localizedDescription)" }
    }
    func load(demo: Bool, students: [AcademyStudent]) {
        let newKey = demo ? "demo" : "live"
        if loaded && newKey == key { return }
        loaded = true
        key = demo ? "demo" : "live"
        do {
            guard let context = container?.mainContext else { throw AcademyError.storageUnavailable }
            let rows = try context.fetch(FetchDescriptor<TeachingSnapshot>())
            if let row = rows.first(where: { $0.key == key }) {
                state = try JSONDecoder().decode(TeachingState.self, from: row.payload)
            } else {
                state = TeachingState()
                if demo, let student = students.first {
                    state.projects = [TeachingProject(title: "Flight-ready glider", studentIDs: [student.id], stage: "Build", nextTask: "Check wing alignment and measure the center of gravity", materials: "Foam board, tape, ruler, balance stand")]
                    state.goals = [TeachingGoal(studentID: student.id, title: "Design, test, and explain a stable aircraft")]
                    state.homework = [TeachingHomework(studentID: student.id, title: "Sketch two wing shapes and predict how each will fly", due: Date().addingTimeInterval(86400 * 3))]
                }
            }
            healthy = true
        } catch { healthy = false; state = TeachingState(); self.error = error.localizedDescription }
    }
    @discardableResult func change(_ mutation: (inout TeachingState) throws -> Void) -> Bool {
        error = nil
        do {
            guard healthy, let context = container?.mainContext else { throw AcademyError.storageUnavailable }
            var next = state
            try mutation(&next)
            let payload = try JSONEncoder().encode(next)
            let rows = try context.fetch(FetchDescriptor<TeachingSnapshot>())
            if let row = rows.first(where: { $0.key == key }) { row.payload = payload; row.updatedAt = Date() }
            else { context.insert(TeachingSnapshot(key: key, payload: payload)) }
            do { try context.save() } catch { context.rollback(); throw error }
            state = next
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func missing(_ skill: AcademySkillLesson, studentID: UUID) -> [String] {
        let earned = Set(state.awards.filter { $0.studentID == studentID && !$0.paused }.map(\.skillID))
        var result = Set<String>(), seen = Set<String>()
        func walk(_ id: String) {
            guard seen.insert(id).inserted else { return }
            if !earned.contains(id) { result.insert(id) }
            for next in skills.first(where: { $0.id == id })?.prerequisites ?? [] { walk(next) }
        }
        for id in skill.prerequisites { walk(id) }
        return result.sorted()
    }
    func canAward(_ skill: AcademySkillLesson, studentID: UUID) -> Bool {
        guard missing(skill, studentID: studentID).isEmpty,
              !state.awards.contains(where: { $0.studentID == studentID && $0.skillID == skill.id }) else { return false }
        if skill.id == "LA-02" {
            let capstones = Set(skills.filter { $0.kind == "Capstone" }.map(\.id))
            guard state.awards.contains(where: { $0.studentID == studentID && !$0.paused && capstones.contains($0.skillID) }) else { return false }
        }
        return skill.checkpoints.allSatisfy { checkpoint in state.evidence.contains { $0.studentID == studentID && $0.skillID == skill.id && $0.checkpointID == checkpoint.id && $0.revision == skill.revision && !$0.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
    }
    func award(_ skill: AcademySkillLesson, studentID: UUID, instructor: String) throws {
        guard !instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.instructorRequired }
        guard canAward(skill, studentID: studentID) else { throw AcademyError.incompleteCheckride }
        if skill.id == "LA-02" {
            let capstones = Set(skills.filter { $0.kind == "Capstone" }.map(\.id))
            guard state.awards.contains(where: { $0.studentID == studentID && !$0.paused && capstones.contains($0.skillID) }) else { throw AcademyError.prerequisites }
        }
        let ids = state.evidence.filter { $0.studentID == studentID && $0.skillID == skill.id && $0.revision == skill.revision }.map(\.id)
        guard change({ $0.awards.append(TeachingAward(studentID: studentID, skillID: skill.id, instructor: instructor, revision: skill.revision, evidenceIDs: ids)) }) else { throw AcademyError.storageUnavailable }
    }
    func report(for student: AcademyStudent, legacy: AcademyWorkspace) -> String {
        let earned = state.awards.filter { $0.studentID == student.id && !$0.paused }.compactMap { award in skills.first { $0.id == award.skillID }?.title }
        let projects = state.projects.filter { $0.studentIDs.contains(student.id) }.map { "\($0.title): \($0.stage). Next: \($0.nextTask)" }
        let goals = state.goals.filter { $0.studentID == student.id }.map { "\($0.completed ? "Achieved" : "Working toward"): \($0.title)" }
        let work = state.homework.filter { $0.studentID == student.id }.map { "\($0.title) — \($0.status), due \($0.due.formatted(date: .abbreviated, time: .omitted))" }
        var lines = ["Flight & Aerospace Academy", "Progress report · \(Date().formatted(date: .abbreviated, time: .omitted))", student.name, student.track.name]
        lines.append("Semester goals"); lines.append(contentsOf: goals)
        lines.append("Projects"); lines.append(contentsOf: projects)
        lines.append("Skills earned"); lines.append(contentsOf: earned)
        lines.append("Earlier skill sign-offs: \(legacy.signedIDs(for: student.id).count)")
        lines.append("Homework"); lines.append(contentsOf: work)
        return lines.joined(separator: "\n\n")
    }
    func weeks(for course: AcademyCourse) -> [AcademyWeek] {
        if let edited = state.courseEdits?[course.id] { return edited }
        guard let url = Bundle.main.url(forResource: "academy-course-plans", withExtension: "json"), let data = try? Data(contentsOf: url), let plans = try? JSONDecoder().decode([String: [AcademyWeek]].self, from: data) else { return course.weeks }
        return plans[course.id] ?? course.weeks
    }
}
