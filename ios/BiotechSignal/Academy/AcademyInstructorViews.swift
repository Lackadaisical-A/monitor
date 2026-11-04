import SwiftUI
import UniformTypeIdentifiers

struct AcademyTodayView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @EnvironmentObject private var cloud: AcademyCloud
    @State private var classDate = Date()
    private var day: String { ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Calendar.current.component(.weekday, from: classDate) - 1] }
    @State private var importing = false
    @State private var importRoster: TeachingRoster?
    @State private var course: AcademyCourse?
    private let days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        AcademyEyebrow(text: Date().formatted(.dateTime.month(.wide).day()))
                        Text("Ready for takeoff.").font(AcademyTheme.display(30))
                        Text("A clear next step for every student.").foregroundStyle(AcademyTheme.muted)
                    }
                    Spacer()
                    Image(systemName: "sun.max").font(.system(size: 28, weight: .light)).foregroundStyle(AcademyTheme.goldInk)
                }
                VStack(alignment: .leading, spacing: 20) {
                    HStack { Text("INSTRUCTOR DESK").font(.caption.monospaced().weight(.semibold)).tracking(2); Spacer(); Image(systemName: "airplane") }
                    HStack(alignment: .firstTextBaseline, spacing: 28) {
                        metric(store.workspace.students.count, "Students")
                        metric(teaching.state.projects.filter { $0.stage != "Complete" }.count, "Active projects")
                        metric(teaching.state.homework.filter { $0.status == "Reported complete" }.count, "To review")
                    }
                    Text(store.isDemo ? "Demo workspace · explore with sample records" : cloud.connected ? "Shared academy workspace · \(cloud.status)" : "On this iPhone · sign in to share progress").font(.caption).foregroundStyle(.white.opacity(0.8))
                }.padding(24).foregroundStyle(.white).background { ZStack { AcademyTheme.navy; AcademyFlightDrawing().opacity(0.25) } }.clipShape(RoundedRectangle(cornerRadius: 24))
                HStack {
                    Text("Class roster").font(AcademyTheme.display(21))
                    Spacer()
                    Button { importing = true } label: { Label("Import", systemImage: "square.and.arrow.down") }.font(.subheadline.weight(.semibold))
                }
                DatePicker("Class date", selection: $classDate, displayedComponents: .date).font(.subheadline.weight(.semibold))
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack { ForEach(days, id: \.self) { item in Button { let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; let offset = (weekdays.firstIndex(of: item) ?? 0) - (weekdays.firstIndex(of: day) ?? 0); classDate = Calendar.current.date(byAdding: .day, value: offset, to: classDate) ?? classDate } label: { Text(String(item.prefix(3))).font(.subheadline.weight(.semibold)).padding(.horizontal, 17).padding(.vertical, 12).foregroundStyle(day == item ? .white : AcademyTheme.navy).background(day == item ? AcademyTheme.navy : .white, in: Capsule()) } } }
                }
                let sessions = teaching.state.sessions.filter { $0.day == day }
                let duties = (teaching.state.duties ?? []).filter { $0.day == day }
                if !duties.isEmpty {
                    AcademyPanel { VStack(alignment: .leading, spacing: 12) {
                        Text("Teaching team").font(AcademyTheme.display(19))
                        ForEach(duties) { duty in HStack(alignment: .top) { Text(duty.studio).font(.subheadline.weight(.semibold)); Spacer(); Text(duty.instructors.joined(separator: ", ")).font(.subheadline).multilineTextAlignment(.trailing) } }
                        Text(duties.first?.sourceLabel ?? "").font(.caption).foregroundStyle(AcademyTheme.muted)
                    } }
                }
                if sessions.isEmpty {
                    AcademyPanel { VStack(alignment: .leading, spacing: 12) { Label("Your class, at a glance", systemImage: "calendar").font(.headline); Text("Bring your class groups and teaching assignments together. Import the academy roster to get started.").font(.subheadline).foregroundStyle(AcademyTheme.muted) } }
                }
                ForEach(sessions) { session in
                    AcademyPanel { VStack(alignment: .leading, spacing: 14) {
                        HStack { Text(session.course).font(AcademyTheme.display(19)); Spacer(); AcademyPill(text: session.slot) }
                        Label(session.instructor.isEmpty ? "Instructor unassigned" : session.instructor, systemImage: "person.crop.circle").font(.subheadline)
                        Text(session.sourceLabel).font(.caption).foregroundStyle(AcademyTheme.goldInk)
                        NavigationLink { AcademyClassLogbookView(session: session, date: classDate) } label: {
                            HStack { Label("Class logbook", systemImage: "book.closed"); Spacer(); Text("\((teaching.state.classLogs ?? []).filter { $0.sessionID == session.id && $0.classDate == AcademyClassLog.dayKey(classDate) }.count) updates").font(.caption); Image(systemName: "chevron.right").font(.caption) }.font(.subheadline.weight(.semibold)).padding(14).background(AcademyTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                        }
                        ForEach(store.workspace.students.filter { session.studentIDs.contains($0.id) }) { student in
                            NavigationLink { AcademyStudentDetail(studentID: student.id) } label: { HStack { AcademyAvatar(student: student, size: 34); Text(student.name); Spacer(); Image(systemName: "chevron.right").font(.caption) } }
                        }
                    } }
                }
                Text("Prepare the next session").font(AcademyTheme.display(21))
                ForEach(teaching.state.projects.filter { $0.stage != "Complete" }) { project in
                    NavigationLink { AcademyProjectEditor(project: project) } label: { AcademyPanel { VStack(alignment: .leading, spacing: 12) {
                        HStack { Label(project.title, systemImage: "shippingbox").font(.headline); Spacer(); AcademyPill(text: project.stage) }
                        Text(project.nextTask.isEmpty ? "Add a next task" : project.nextTask).font(.subheadline)
                        if !project.materials.isEmpty { Label(project.materials, systemImage: "checklist").font(.caption).foregroundStyle(AcademyTheme.muted) }
                        if !project.blocker.isEmpty { Label(project.blocker, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(AcademyTheme.goldInk) }
                    } } }.buttonStyle(.plain)
                }
                if teaching.state.projects.isEmpty { Text("Create a project to collect its next steps and materials here.").font(.subheadline).foregroundStyle(AcademyTheme.muted) }
            }.padding(22)
        }.fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                guard data.count < 10_000_000 else { throw AcademyError.invalidBackup }
                let roster = try JSONDecoder().decode(TeachingRoster.self, from: data)
                guard Set(roster.students.map(\.id)).count == roster.students.count, roster.students.allSatisfy({ !$0.name.isEmpty }) else { throw AcademyError.invalidBackup }
                importRoster = roster
            } catch { store.errorMessage = error.localizedDescription }
        }.sheet(isPresented: Binding(get: { importRoster != nil }, set: { if !$0 { importRoster = nil } })) {
            if let roster = importRoster {
                NavigationStack { List {
                    Section("Import preview") { Text("\(roster.students.count) students · \(roster.sessions.count) class groups"); Text(roster.source).font(.caption); Text("Existing records keep their history. Names that match a different record are left for reconciliation.") }
                    ForEach(roster.students) { student in Text(student.name) }
                }.navigationTitle("Review roster").toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { importRoster = nil } }
                    ToolbarItem(placement: .confirmationAction) { Button("Import") { apply(roster) } }
                } }
            }
        }
    }
    private func metric(_ count: Int, _ label: String) -> some View { VStack(alignment: .leading, spacing: 6) { Text("\(count)").font(AcademyTheme.display(32)); Text(label).font(.caption) } }
    private func apply(_ roster: TeachingRoster) {
        do {
            guard !store.isDemo else { store.errorMessage = "Switch to your private workspace before importing real students."; return }
            let ambiguous = roster.students.filter { incoming in store.workspace.students.contains { $0.id != incoming.id && $0.name.caseInsensitiveCompare(incoming.name) == .orderedSame } }
            guard ambiguous.isEmpty else { store.errorMessage = "Reconcile matching names before importing: \(ambiguous.map(\.name).joined(separator: ", ")). No records were changed."; return }
            let studentIDs = Set(roster.students.map(\.id)).union(store.workspace.students.map(\.id))
            guard (roster.sessions.flatMap(\.studentIDs) + (roster.projects ?? []).flatMap(\.studentIDs)).allSatisfy(studentIDs.contains) else { throw AcademyError.invalidBackup }
            try store.update { value in for student in roster.students where !value.students.contains(where: { $0.id == student.id }) { value.students.append(student) } }
            guard teaching.change({ value in
                for session in roster.sessions { if let i = value.sessions.firstIndex(where: { $0.id == session.id }) { value.sessions[i] = session } else { value.sessions.append(session) } }
                value.instructors = Array(Set(value.instructors + roster.instructors)).sorted()
                for project in roster.projects ?? [] where !value.projects.contains(where: { $0.id == project.id }) { value.projects.append(project) }
                if let duties = roster.duties { value.duties = duties }
            }) else { throw AcademyError.storageUnavailable }
            importRoster = nil; store.notice = "Roster imported. Student history preserved."
        } catch { store.errorMessage = error.localizedDescription }
    }
}

struct AcademyLibraryView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @State private var query = ""
    @State private var pathway = "All"
    @State private var section = "Skills"
    @State private var legacy = false
    var filtered: [AcademySkillLesson] { teaching.skills.filter { (pathway == "All" || $0.pathway == pathway) && (query.isEmpty || "\($0.id) \($0.title) \($0.objective)".localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 19) {
                VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Learn. Demonstrate. Earn."); Text("The learning library").font(AcademyTheme.display(30)); Text("\(teaching.skills.count) skills and ranks. One connected journey.").foregroundStyle(AcademyTheme.muted).font(.subheadline) }
                Picker("Library", selection: $section) { Text("Skills").tag("Skills"); Text("Courses").tag("Courses") }.pickerStyle(.segmented)
                if section == "Skills" {
                    HStack { Image(systemName: "magnifyingglass"); TextField("Search skills, tools, or codes", text: $query) }.padding(14).background(.white, in: RoundedRectangle(cornerRadius: 13))
                    ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(["All"] + Array(Set(teaching.skills.map(\.pathway))).sorted(), id: \.self) { item in Button { pathway = item } label: { Text(item).font(.subheadline.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 10).foregroundStyle(pathway == item ? .white : AcademyTheme.navy).background(pathway == item ? AcademyTheme.navy : .white, in: Capsule()) } } } }
                    HStack { Text("\(filtered.count) learning cards").font(.caption).foregroundStyle(AcademyTheme.muted); Spacer(); Button("Earlier skill map") { legacy = true }.font(.caption) }
                    ForEach(filtered) { skill in NavigationLink { AcademySkillLessonView(skillID: skill.id) } label: {
                        AcademyPanel { HStack(alignment: .top, spacing: 14) {
                            Image(systemName: skill.kind == "Rank" ? "star.circle" : skill.kind == "Licence" ? "checkmark.shield" : skill.kind == "Capstone" ? "flag.checkered" : "square.stack.3d.up").font(.system(size: 23, weight: .light)).frame(width: 42, height: 44).background(AcademyTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                            VStack(alignment: .leading, spacing: 8) { Text(skill.title).font(AcademyTheme.display(17)); Text(skill.objective).font(.subheadline).foregroundStyle(AcademyTheme.muted).lineLimit(3); Text("\(skill.id)  ·  \(skill.checkpoints.count) checkpoints  ·  \(skill.tier)").font(.caption) }
                            Spacer(minLength: 0); Image(systemName: "chevron.right").font(.caption)
                        } }
                    }.buttonStyle(.plain) }
                } else {
                    ForEach(store.workspace.curriculum.courses.sorted { $0.order < $1.order }) { course in
                        NavigationLink { AcademyCourseLessonList(course: course) } label: { AcademyPanel { VStack(alignment: .leading, spacing: 12) { HStack { AcademyPill(text: course.code); Spacer(); Text(teaching.weeks(for: course).isEmpty ? "Catalog draft" : "\(teaching.weeks(for: course).count) lessons").font(.caption).foregroundStyle(AcademyTheme.muted) }; Text(course.name).font(AcademyTheme.display(20)); Text(course.summary).font(.subheadline).foregroundStyle(AcademyTheme.muted) } } }.buttonStyle(.plain)
                    }
                }
            }.padding(22)
        }.sheet(isPresented: $legacy) { NavigationStack { AcademyMapView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { legacy = false } } } } }
    }
}

struct AcademySkillLessonView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    let skillID: String
    @State private var studentID: UUID?
    @State private var evidenceCheckpoint: AcademyCheckpoint?
    @State private var note = ""
    @State private var editing = false
    @State private var confirmAward = false
    var skill: AcademySkillLesson? { teaching.skills.first { $0.id == skillID } }
    var body: some View {
        ScrollView { if let skill {
            VStack(alignment: .leading, spacing: 23) {
                HStack { AcademyPill(text: skill.pathway); Spacer(); Text(skill.id).font(.caption.monospaced()) }
                Text(skill.title).font(AcademyTheme.display(30))
                Text(skill.objective).font(.title3).foregroundStyle(AcademyTheme.muted)
                Picker("Student", selection: $studentID) { Text("Read lesson only").tag(nil as UUID?); ForEach(store.workspace.students) { Text($0.name).tag(Optional($0.id)) } }.pickerStyle(.menu)
                AcademyPanel { VStack(alignment: .leading, spacing: 12) { Label("Before you begin", systemImage: "checklist").font(.headline); Text(skill.preparation); Text(skill.guidance).font(.subheadline).foregroundStyle(AcademyTheme.muted) } }
                AcademySkillPath(skill: skill, studentID: studentID)
                ForEach(skill.checkpoints) { checkpoint in
                    AcademyPanel { VStack(alignment: .leading, spacing: 15) {
                        HStack { Text(checkpoint.id).font(.caption.monospaced()).foregroundStyle(AcademyTheme.blue); Spacer(); if let studentID { Text("\(teaching.state.evidence.filter { $0.studentID == studentID && $0.checkpointID == checkpoint.id }.count) observations").font(.caption) } }
                        Text(checkpoint.title).font(AcademyTheme.display(20))
                        Text(checkpoint.practice).font(.body).lineSpacing(5).textSelection(.enabled)
                        Divider()
                        Label("Demonstrate", systemImage: "checkmark.seal").font(.subheadline.weight(.semibold))
                        Text(checkpoint.criteria).font(.subheadline).foregroundStyle(AcademyTheme.muted)
                        if studentID != nil { Button("Record observation") { evidenceCheckpoint = checkpoint; note = "" }.buttonStyle(.bordered) }
                    } }
                }
                AcademyPanel { VStack(alignment: .leading, spacing: 10) { Text("Reflect and progress").font(AcademyTheme.display(19)); Text(skill.reflection); Text(skill.unlocks).font(.subheadline).foregroundStyle(AcademyTheme.muted) } }
                if let studentID {
                    let missing = teaching.missing(skill, studentID: studentID)
                    if !missing.isEmpty { Label("Prerequisites to complete: \(missing.joined(separator: ", "))", systemImage: "lock").font(.subheadline).foregroundStyle(AcademyTheme.goldInk) }
                    Button(skill.kind == "Rank" ? "Review staff appointment" : "Review skill award") { confirmAward = true }.buttonStyle(AcademyPrimaryButton()).disabled(!teaching.canAward(skill, studentID: studentID))
                }
                if let url = URL(string: skill.sourceURL) { Link("Original curriculum source", destination: url).font(.caption) }
                if let url = URL(string: skill.referenceURL) { Link("Reference documentation", destination: url).font(.caption) }
                Text("Adapted for Flight & Aerospace Academy · \(skill.status) · Revision \(skill.revision)").font(.caption).foregroundStyle(AcademyTheme.muted)
            }.padding(22)
        } }.background(AcademyTheme.paper).navigationTitle("Skill lesson").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
            .toolbar { Button("Edit") { editing = true } }
            .onAppear { if studentID == nil { studentID = store.selectedStudentID } }
            .sheet(isPresented: $editing) { if let skill { AcademySkillCopyEditor(skill: skill) } }
            .sheet(item: $evidenceCheckpoint) { checkpoint in NavigationStack { Form {
                Section(checkpoint.title) { Text(checkpoint.criteria); TextField("What did the student demonstrate? Include attempts, dates, and measurements.", text: $note, axis: .vertical).lineLimit(5...12) }
            }.navigationTitle("Record evidence").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { evidenceCheckpoint = nil } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task {
                    do { try await store.authorizeInstructor(); guard let studentID, let skill else { return }; if teaching.change({ $0.evidence.append(TeachingEvidence(studentID: studentID, skillID: skill.id, checkpointID: checkpoint.id, note: note, instructor: store.workspace.instructor, revision: skill.revision, criteria: checkpoint.criteria)) }) { evidenceCheckpoint = nil } } catch { store.errorMessage = error.localizedDescription }
                } }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            } } }
            .confirmationDialog("Confirm the complete assessment", isPresented: $confirmAward, titleVisibility: .visible) {
                Button("I verified every requirement") { Task { do { try await store.authorizeInstructor(); if let skill, let studentID { try teaching.award(skill, studentID: studentID, instructor: store.workspace.instructor); store.notice = "Skill awarded. Evidence saved." } } catch { store.errorMessage = error.localizedDescription } } }
            } message: { Text("Verify repeated-session requirements, supervision, and all evidence. Staff appointments require an explicit readiness decision; they never grant app access.") }
    }
}

struct AcademySkillCopyEditor: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @Environment(\.dismiss) private var dismiss
    @State var skill: AcademySkillLesson
    var body: some View { NavigationStack { Form {
        Section("Lesson wording") { TextField("Title", text: $skill.title); TextField("Objective", text: $skill.objective, axis: .vertical); TextField("Preparation", text: $skill.preparation, axis: .vertical); TextField("Instructor guidance", text: $skill.guidance, axis: .vertical) }
        ForEach($skill.checkpoints) { $checkpoint in Section(checkpoint.title) { TextField("Practice", text: $checkpoint.practice, axis: .vertical); Text(checkpoint.criteria).font(.caption) } }
        Section { Text("Copy edits preserve checkpoint IDs, assessment requirements, and previously earned progress.").font(.caption) }
    }.navigationTitle("Edit teaching notes").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { if teaching.change({ $0.lessonEdits[skill.id] = skill }) { dismiss() } }.disabled(skill.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } } } }
}

struct AcademyProjectsView: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @State private var adding = false
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 20) {
        HStack { VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Ideas into aircraft and machines"); Text("Projects in motion").font(AcademyTheme.display(30)) }; Spacer(); Button { adding = true } label: { Image(systemName: "plus.circle.fill").font(.title) } }
        if teaching.state.projects.isEmpty { AcademyEmpty(symbol: "shippingbox", title: "Give the next build a home.", message: "Keep the team, next task, CAD, and parts together.") }
        ForEach(teaching.state.projects) { project in NavigationLink { AcademyProjectEditor(project: project) } label: { AcademyPanel { VStack(alignment: .leading, spacing: 14) { HStack { AcademyPill(text: project.stage); Spacer(); Text(project.semester).font(.caption) }; Text(project.title).font(AcademyTheme.display(23)); Text(project.nextTask).font(.subheadline).foregroundStyle(AcademyTheme.muted); if !project.blocker.isEmpty { Label(project.blocker, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(AcademyTheme.goldInk) } } } }.buttonStyle(.plain) }
    }.padding(22) } .sheet(isPresented: $adding) { NavigationStack { AcademyProjectEditor(project: TeachingProject(title: "", studentIDs: [])) } } }
}

struct AcademyProjectEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @Environment(\.dismiss) private var dismiss
    @State var project: TeachingProject
    var body: some View { Form {
        Section("Project") { TextField("Project name", text: $project.title); TextField("Semester", text: $project.semester); Picker("Stage", selection: $project.stage) { ForEach(["Plan", "Design", "Build", "Test", "Iterate", "Complete"], id: \.self) { Text($0) } } }
        Section("Team") { ForEach(store.workspace.students) { student in Toggle(student.name, isOn: Binding(get: { project.studentIDs.contains(student.id) }, set: { yes in project.studentIDs.removeAll { $0 == student.id }; if yes { project.studentIDs.append(student.id) } })) } }
        Section("Next session") { TextField("Next task", text: $project.nextTask, axis: .vertical); TextField("Needs help or waiting for…", text: $project.blocker, axis: .vertical); TextField("Parts and materials", text: $project.materials, axis: .vertical) }
        Section("Build documents") { TextField("Onshape URL", text: $project.cadURL).keyboardType(.URL).textInputAutocapitalization(.never); if let url = safeURL(project.cadURL) { Link("Open CAD model", destination: url) }; TextField("Parts list URL", text: $project.partsURL).keyboardType(.URL).textInputAutocapitalization(.never); if let url = safeURL(project.partsURL) { Link("Open parts list", destination: url) }; TextField("Build notes", text: $project.notes, axis: .vertical) }
    }.navigationTitle(project.title.isEmpty ? "New project" : project.title).navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Save") { teaching.change { value in if let i = value.projects.firstIndex(where: { $0.id == project.id }) { value.projects[i] = project } else { value.projects.append(project) } }; if teaching.error == nil { dismiss() } }.disabled(project.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || project.studentIDs.isEmpty) } } }
    private func safeURL(_ value: String) -> URL? { guard let url = URL(string: value), url.scheme == "https", url.host != nil else { return nil }; return url }
}

struct AcademyStudentDetail: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    let studentID: UUID
    @State private var title = ""
    @State private var due = Date().addingTimeInterval(86400 * 7)
    @State private var goal = ""
    @State private var passport = false
    @State private var logbook = false
    @State private var homework: TeachingHomework?
    @State private var reviewingAward: TeachingAward?
    var student: AcademyStudent? { store.workspace.students.first { $0.id == studentID } }
    var body: some View { ScrollView { if let student { VStack(alignment: .leading, spacing: 22) {
        HStack(spacing: 15) { AcademyAvatar(student: student, size: 64); VStack(alignment: .leading, spacing: 6) { Text(student.name).font(AcademyTheme.display(27)); Text(student.track.name).foregroundStyle(AcademyTheme.muted) }; Spacer() }
        HStack { Button("Passport") { store.selectedStudentID = student.id; passport = true }; Spacer(); Button("Earlier logbook") { store.selectedStudentID = student.id; logbook = true } }.font(.subheadline)
        ShareLink(item: teaching.report(for: student, legacy: store.workspace)) { Label("Share progress report", systemImage: "square.and.arrow.up") }.buttonStyle(AcademyPrimaryButton())
        NavigationLink { AcademyFamilyLinkView(student: student) } label: { Label("Family access & shared updates", systemImage: "person.2.badge.key") }.font(.subheadline.weight(.semibold))
        if !(teaching.state.classLogs ?? []).filter({ $0.studentID == studentID }).isEmpty {
            Text("Class logbook").font(AcademyTheme.display(21))
            ForEach((teaching.state.classLogs ?? []).filter { $0.studentID == studentID }.sorted { $0.classDate > $1.classDate }) { entry in
                NavigationLink { AcademyStudentClassEntry(entry: entry) } label: { AcademyClassLogSummary(entry: entry) }.buttonStyle(.plain)
            }
        }
        AcademyPanel { VStack(alignment: .leading, spacing: 14) {
            Text("Semester goals").font(AcademyTheme.display(20))
            ForEach(teaching.state.goals.filter { $0.studentID == studentID }) { item in Toggle(item.title, isOn: Binding(get: { item.completed }, set: { yes in teaching.change { value in if let i = value.goals.firstIndex(where: { $0.id == item.id }) { value.goals[i].completed = yes } } })) }
            TextField("Add a measurable goal", text: $goal, axis: .vertical)
            Button("Add goal") { teaching.change { $0.goals.append(TeachingGoal(studentID: studentID, title: goal)) }; goal = "" }.disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } }
        Text("Projects").font(AcademyTheme.display(21))
        ForEach(teaching.state.projects.filter { $0.studentIDs.contains(studentID) }) { project in NavigationLink { AcademyProjectEditor(project: project) } label: { AcademyPanel { VStack(alignment: .leading, spacing: 8) { Text(project.title).font(.headline); Text(project.nextTask).font(.subheadline); AcademyPill(text: project.stage) } } } }
        AcademyPanel { VStack(alignment: .leading, spacing: 14) {
            Text("Homework").font(AcademyTheme.display(20))
            ForEach(teaching.state.homework.filter { $0.studentID == studentID }) { item in
                Button { homework = item } label: { VStack(alignment: .leading, spacing: 8) { Text(item.title).font(.headline); HStack { Text(item.due, style: .date); Spacer(); AcademyPill(text: item.status) }; if !item.evidence.isEmpty { Text(item.evidence).font(.subheadline).foregroundStyle(AcademyTheme.muted) }; Divider() } }.buttonStyle(.plain)
            }
            TextField("Next assignment", text: $title, axis: .vertical); DatePicker("Due", selection: $due, displayedComponents: .date)
            Button("Assign homework") { teaching.change { $0.homework.append(TeachingHomework(studentID: studentID, title: title, due: due)) }; title = "" }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } }
        Text("Skills earned").font(AcademyTheme.display(21))
        ForEach(teaching.state.awards.filter { $0.studentID == studentID }) { award in
            HStack { NavigationLink { AcademySkillLessonView(skillID: award.skillID) } label: { Label(teaching.skills.first { $0.id == award.skillID }?.title ?? award.skillID, systemImage: award.paused ? "pause.circle" : "checkmark.seal.fill") }; Spacer(); Button { reviewingAward = award } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }.accessibilityLabel("Review skill status") }.padding(14).background(.white, in: RoundedRectangle(cornerRadius: 13))
        }
        Text("Learning evidence").font(AcademyTheme.display(21))
        ForEach(teaching.state.evidence.filter { $0.studentID == studentID }.sorted { $0.date > $1.date }) { item in AcademyPanel { VStack(alignment: .leading, spacing: 9) { Text(item.checkpointID).font(.caption.monospaced()); Text(item.note); Text("\(item.instructor) · \(item.date.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(AcademyTheme.muted) } } }
    }.padding(22) } }.background(AcademyTheme.paper).navigationTitle("Student progress").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar).onAppear { store.selectedStudentID = studentID }.sheet(item: $reviewingAward) { AcademyAwardReview(award: $0) }.sheet(item: $homework) { AcademyHomeworkEditor(homework: $0) }.sheet(isPresented: $passport) { AcademyPassportView() }.sheet(isPresented: $logbook) { NavigationStack { AcademyLogbookView().toolbar { Button("Done") { logbook = false } } } } }
}

struct AcademyCourseLessonList: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    let course: AcademyCourse
    @State private var editing = false
    var body: some View { List {
        Section { Text(course.summary); Text(course.notes).font(.caption).foregroundStyle(.secondary) }
        ForEach(Array(teaching.weeks(for: course).enumerated()), id: \.offset) { index, week in NavigationLink { ScrollView { VStack(alignment: .leading, spacing: 22) { AcademyEyebrow(text: "\(course.code) · Lesson \(index + 1)"); Text(week.title).font(AcademyTheme.display(29)); Text(week.plan).font(.body).lineSpacing(6).textSelection(.enabled) }.padding(22) }.navigationTitle("Teaching plan").toolbar(.visible, for: .navigationBar) } label: { VStack(alignment: .leading, spacing: 6) { Text("LESSON \(index + 1)").font(.caption.monospaced()).foregroundStyle(AcademyTheme.blue); Text(week.title).font(.headline) }.padding(.vertical, 8) } }
        if teaching.weeks(for: course).isEmpty { Text("This course is a catalog draft. Add its teaching sequence with Edit plan.").foregroundStyle(.secondary) }
    }.navigationTitle(course.name).navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar).toolbar { Button("Edit plan") { editing = true } }.sheet(isPresented: $editing) { AcademyTeachingPlanEditor(courseID: course.id, weeks: teaching.weeks(for: course)) } }
}

struct AcademyTeachingPlanEditor: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @Environment(\.dismiss) private var dismiss
    let courseID: String
    @State var weeks: [AcademyWeek]
    var body: some View { NavigationStack { Form {
        ForEach(weeks.indices, id: \.self) { i in Section("Lesson \(i + 1)") { TextField("Title", text: $weeks[i].title); TextField("Teaching plan", text: $weeks[i].plan, axis: .vertical).lineLimit(6...18) } }
        Button("Add lesson") { weeks.append(AcademyWeek(abilities: [], plan: "", title: "New lesson")) }
    }.navigationTitle("Edit course plan").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { if teaching.change({ value in if value.courseEdits == nil { value.courseEdits = [:] }; value.courseEdits?[courseID] = weeks }) { dismiss() } } } } } }
}

struct AcademyHomeworkEditor: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    @State var homework: TeachingHomework
    var body: some View { NavigationStack { Form {
        Section("Assignment") { TextField("Title", text: $homework.title, axis: .vertical); DatePicker("Due", selection: $homework.due, displayedComponents: .date) }
        Section("Review") { Picker("Status", selection: $homework.status) { ForEach(["Assigned", "Reported complete", "Verified", "Needs revision"], id: \.self) { Text($0) } }; TextField("Evidence and feedback", text: $homework.evidence, axis: .vertical).lineLimit(4...12) }
    }.navigationTitle("Homework review").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { do { if homework.status == "Verified" { try await store.authorizeInstructor() }; if teaching.change({ value in if let i = value.homework.firstIndex(where: { $0.id == homework.id }) { value.homework[i] = homework } }) { dismiss() } } catch { store.errorMessage = error.localizedDescription } } }.disabled(homework.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (homework.status == "Verified" && homework.evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) } } } }
}

struct AcademyAwardReview: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @Environment(\.dismiss) private var dismiss
    let award: TeachingAward
    @State private var reason = ""
    var body: some View { NavigationStack { Form {
        Section("Skill status") {
            Text(teaching.skills.first { $0.id == award.skillID }?.title ?? award.skillID).font(.headline)
            Text(award.paused ? "Paused · dependent skills require a review before further awards." : "Active · supporting evidence is preserved.")
            TextField(award.paused ? "Evidence of readiness to resume" : "Reason for pausing", text: $reason, axis: .vertical).lineLimit(3...8)
            Button(award.paused ? "Restore skill" : "Pause skill") { Task { do {
                try await store.authorizeInstructor()
                if teaching.change({ value in
                    if let i = value.awards.firstIndex(where: { $0.id == award.id }) {
                        value.awards[i].paused.toggle()
                        let entry = "\(Date().formatted(date: .abbreviated, time: .shortened)) · \(store.workspace.instructor) · \(value.awards[i].paused ? "Paused" : "Restored"): \(reason)"
                        value.awards[i].statusNotes = (value.awards[i].statusNotes ?? []) + [entry]
                    }
                }) { dismiss() }
            } catch { store.errorMessage = error.localizedDescription } } }.disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        Section("Review history") { ForEach(award.statusNotes ?? [], id: \.self) { Text($0).font(.caption) } }
    }.navigationTitle("Review skill").toolbar { Button("Done") { dismiss() } } } }
}
