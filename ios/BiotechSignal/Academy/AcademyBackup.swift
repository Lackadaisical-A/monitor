import Foundation

struct AcademyBackup: Codable, Equatable {
    var workspace: AcademyWorkspace
    var teaching: TeachingState

    init(workspace: AcademyWorkspace, teaching: TeachingState) {
        self.workspace = workspace; self.teaching = teaching
        for i in self.workspace.students.indices { self.workspace.students[i].passportFingerprint = nil }
    }
    func validate() throws {
        try workspace.validate()
        let ids = Set(workspace.students.map(\.id))
        let references = teaching.homework.map(\.studentID) + teaching.goals.map(\.studentID) + teaching.evidence.map(\.studentID) + teaching.awards.map(\.studentID) + teaching.projects.flatMap(\.studentIDs) + teaching.sessions.flatMap(\.studentIDs)
        guard references.allSatisfy(ids.contains) else { throw AcademyError.invalidBackup }
        func unique<T: Identifiable>(_ rows: [T]) -> Bool where T.ID: Hashable { Set(rows.map(\.id)).count == rows.count }
        guard unique(teaching.projects), unique(teaching.homework), unique(teaching.goals), unique(teaching.evidence), unique(teaching.awards), unique(teaching.sessions) else { throw AcademyError.invalidBackup }
        guard unique(teaching.classLogs ?? []) else { throw AcademyError.invalidBackup }
        for entry in teaching.classLogs ?? [] {
            try entry.validate()
            guard ids.contains(entry.studentID), teaching.sessions.contains(where: { $0.id == entry.sessionID && $0.studentIDs.contains(entry.studentID) }) else { throw AcademyError.invalidBackup }
        }
    }
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 20_000_000 else { throw AcademyError.invalidBackup }
        if let value = try? JSONDecoder().decode(Self.self, from: data) { try value.validate(); return value }
        return try Self(workspace: AcademyStore.decode(data), teaching: TeachingState())
    }
    @MainActor func apply(store: AcademyStore, teaching storeTeaching: AcademyTeachingStore, retainBindings: Bool) throws {
        try validate()
        guard store.storageHealthy, storeTeaching.healthy else { throw AcademyError.storageUnavailable }
        let previous = AcademyBackup(workspace: store.workspace, teaching: storeTeaching.state)
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FlightAcademy")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let recovery = directory.appendingPathComponent(store.isDemo ? "demo-full-before-restore.json" : "academy-full-before-restore.json")
        try JSONEncoder().encode(previous).write(to: recovery, options: [.atomic, .completeFileProtection])
        var next = workspace
        if retainBindings {
            next.instructor = store.workspace.instructor
            for i in next.students.indices { next.students[i].passportFingerprint = store.workspace.students.first { $0.id == next.students[i].id }?.passportFingerprint }
        }
        // Save teaching first and roll it back if the legacy file cannot be saved.
        // The complete recovery file is durable before either store changes.
        guard storeTeaching.change({ $0 = teaching }) else { throw AcademyError.storageUnavailable }
        do { try store.update { $0 = next } }
        catch { storeTeaching.change { $0 = previous.teaching }; throw error }
    }
}

enum AcademyMerge {
    struct Conflict: Error, LocalizedError { var path: String; var errorDescription: String? { "Both instructors changed \(path). Your edits are kept locally. Review the shared and local backups before choosing a version." } }
    static func combine(base: Data?, local: Data, remote: Data) throws -> Data {
        let old = try base.map { try JSONSerialization.jsonObject(with: $0) } ?? [:]
        let result = try merge(old, JSONSerialization.jsonObject(with: local), JSONSerialization.jsonObject(with: remote), path: "workspace")
        return try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    }
    private static func equal(_ a: Any, _ b: Any) -> Bool { (a as? NSObject)?.isEqual(b) == true }
    private static func merge(_ base: Any, _ local: Any, _ remote: Any, path: String) throws -> Any {
        if equal(local, remote) || equal(remote, base) { return local }
        if equal(local, base) { return remote }
        if let l = local as? [String: Any], let r = remote as? [String: Any] {
            let b = base as? [String: Any] ?? [:]
            var output: [String: Any] = [:]
            for key in Set(b.keys).union(l.keys).union(r.keys) {
                let value = try merge(b[key] ?? NSNull(), l[key] ?? NSNull(), r[key] ?? NSNull(), path: "\(path).\(key)")
                if !(value is NSNull) { output[key] = value }
            }
            return output
        }
        if let l = local as? [[String: Any]], let r = remote as? [[String: Any]], (l + r).allSatisfy({ $0["id"] is String }) {
            let b = base as? [[String: Any]] ?? []
            func index(_ values: [[String: Any]]) throws -> [String: Any] {
                var result: [String: Any] = [:]
                for value in values { guard let id = value["id"] as? String, result[id] == nil else { throw AcademyError.invalidBackup }; result[id] = value }
                return result
            }
            let result = try merge(index(b), index(l), index(r), path: path) as! [String: Any]
            let order = (l + r).compactMap { $0["id"] as? String }
            var seen = Set<String>()
            return order.filter { seen.insert($0).inserted }.compactMap { result[$0] }
        }
        throw Conflict(path: path)
    }
}
