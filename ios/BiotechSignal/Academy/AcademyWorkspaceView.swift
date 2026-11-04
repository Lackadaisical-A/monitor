import SwiftUI
import UniformTypeIdentifiers

struct AcademyWorkspaceView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @EnvironmentObject private var cloud: AcademyCloud
    @Environment(\.dismiss) private var dismiss
    @State private var instructor = ""
    @State private var document: AcademyDocument?
    @State private var exporting = false
    @State private var importing = false
    @State private var pendingRestore: Data?
    @State private var confirmRestore = false
    @State private var error: String?
    @State private var saved = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        AcademyEyebrow(text: "Flight & Aerospace Academy")
                        Text("Make room for\nwhat comes next.").font(AcademyTheme.display(26)).foregroundStyle(AcademyTheme.navy)
                        Text("An ability system for builders, thinkers, and future pilots.").font(.subheadline).foregroundStyle(AcademyTheme.muted)
                    }.padding(.vertical, 12)
                }
                Section { LabeledContent("Workspace", value: store.isDemo ? "Demo" : "Academy"); LabeledContent("Storage", value: cloud.connected && !store.isDemo ? "iPhone + Render" : "On this iPhone"); Button(store.isDemo ? "Start your academy workspace" : "Explore the demo workspace") { do { try store.switchWorkspace(); dismiss() } catch { self.error = error.localizedDescription } } } footer: { Text(store.isDemo ? "Demo students and sign-offs are sample data. Your academy workspace starts with an empty roster and the editable draft curriculum." : "Your records and the demo are saved separately. Switching workspaces keeps both.") }
                Section { TextField("Your instructor name", text: $instructor).textContentType(.name); Button(saved ? "Instructor name saved" : "Save instructor name") { do { try store.update { $0.instructor = instructor.trimmingCharacters(in: .whitespacesAndNewlines) }; saved = true } catch { self.error = error.localizedDescription } }.disabled(instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || instructor.count > 100) } header: { Text("Instructor") } footer: { Text("Your name is recorded on every sign-off. In the academy workspace, signing cards and linking passports also require Face ID, Touch ID, or your device passcode.") }
                Section("Your records") {
                    Button { do { document = AcademyDocument(data: try JSONEncoder().encode(AcademyBackup(workspace: store.workspace, teaching: teaching.state))); exporting = true } catch { self.error = error.localizedDescription } } label: { Label("Export workspace backup", systemImage: "square.and.arrow.up") }.disabled(!store.storageHealthy)
                    Button { importing = true } label: { Label("Restore a workspace backup", systemImage: "square.and.arrow.down") }
                    Text("Backups contain student names, curriculum, and learning records. Store them privately. Backups include projects, homework, goals, observations, and lesson edits. Local NFC tags must be linked again after restoring.").font(.caption).foregroundStyle(AcademyTheme.muted)
                }
                Section("How this version works") {
                    Label("Available offline", systemImage: "checkmark.circle").foregroundStyle(AcademyTheme.green)
                    Label("Device-protected student records", systemImage: "lock.shield")
                    NavigationLink { AcademyCloudView() } label: { Label("Shared workspace", systemImage: cloud.connected ? "icloud" : "icloud.slash") }
                    Text(cloud.status).font(.caption).foregroundStyle(AcademyTheme.muted)
                    Link("Academy app privacy", destination: URL(string: "https://catalyst-watch.onrender.com/academy-privacy.html")!)
                    Text("A passport identifies a student; it does not authorize a sign-off. This app does not issue FAA certificates or count simulator practice as certified flight time.").font(.caption).foregroundStyle(AcademyTheme.muted)
                }.font(.subheadline)
                Section("Curriculum source") { Text(store.workspace.curriculum.source).font(.caption); Text("\(store.cards.count) editable cards · \(store.workspace.curriculum.courses.count) courses").font(.caption).foregroundStyle(AcademyTheme.muted); Link("Academy website", destination: URL(string: "https://flightaerospace.academy/")!) }
                Section { Text("B612 typeface · SIL Open Font License\nAcademy app · Version 2.1").font(.caption2).foregroundStyle(AcademyTheme.muted) }
            }.navigationTitle("Workspace").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .onAppear { instructor = store.workspace.instructor }
                .onChange(of: instructor) { _, _ in saved = false }
                .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "Academy-\(store.isDemo ? "Demo-" : "")Backup-\(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash)))") { result in if case .failure(let failure) = result { error = failure.localizedDescription } }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                    do {
                        let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                        guard size <= 20_000_000 else { throw AcademyError.invalidBackup }
                        let data = try Data(contentsOf: url); _ = try AcademyBackup.decode(data); pendingRestore = data; confirmRestore = true
                    } catch { self.error = error.localizedDescription }
                }
                .confirmationDialog("Replace this workspace with the backup?", isPresented: $confirmRestore, titleVisibility: .visible) {
                    Button("Restore backup") { do { if let data = pendingRestore { try AcademyBackup.decode(data).apply(store: store, teaching: teaching, retainBindings: false); instructor = store.workspace.instructor; pendingRestore = nil } } catch { self.error = error.localizedDescription } }
                    Button("Cancel", role: .cancel) { pendingRestore = nil }
                } message: { Text("This replaces the current \(store.isDemo ? "demo" : "academy") records and clears NFC bindings. A recovery copy of the previous records is kept on this iPhone.") }
                .alert("Workspace", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
}

struct AcademyCoursesView: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    var initialTrack: AcademyTrack? = nil
    @State private var track = AcademyTrack.aerospace
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 9) { AcademyEyebrow(text: "Built around real work"); Text("Find your trajectory.").font(AcademyTheme.display(29)).foregroundStyle(AcademyTheme.navy); Text("Editable draft course plans. Every course leads to something a student can show.").font(.subheadline).foregroundStyle(AcademyTheme.muted).lineSpacing(4) }
                    Picker("Course track", selection: $track) { ForEach(AcademyTrack.allCases) { Text($0.name).tag($0) } }.pickerStyle(.segmented)
                    ForEach(store.workspace.curriculum.courses.filter { $0.track == track }.sorted { $0.order < $1.order }) { course in
                        NavigationLink { AcademyCourseDetail(courseID: course.id) } label: {
                            AcademyPanel { VStack(alignment: .leading, spacing: 13) { HStack { AcademyEyebrow(text: course.code, color: AcademyTheme.blue); Spacer(); AcademyPill(text: "Level \(course.level)") }; Text(course.name).font(AcademyTheme.display(22)); Text(course.summary).font(.subheadline).foregroundStyle(AcademyTheme.muted).lineSpacing(4); HStack { Text("\(course.weeks.count) planned sessions").font(.caption); Spacer(); Image(systemName: "arrow.up.right") } } }
                        }.buttonStyle(.plain)
                    }
                }.padding(22)
            }.background(AcademyTheme.paper).navigationTitle("Courses").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }.onAppear { track = initialTrack ?? store.student?.track ?? .aerospace }
        }.tint(AcademyTheme.navy)
    }
}

struct AcademyCourseDetail: View {
    @EnvironmentObject private var store: AcademyStore
    let courseID: String
    @State private var selectedCard: AcademyAbility?
    @State private var editing = false
    private var course: AcademyCourse? { store.workspace.curriculum.courses.first { $0.id == courseID } }
    var body: some View {
        ScrollView {
            if let course {
                VStack(alignment: .leading, spacing: 23) {
                    AcademyEyebrow(text: "\(course.code) · \(course.status == "spring" ? "Spring" : "Winter") 2027")
                    Text(course.name).font(AcademyTheme.display(30)).foregroundStyle(AcademyTheme.navy)
                    Text(course.summary).font(.body).foregroundStyle(AcademyTheme.muted).lineSpacing(5)
                    AcademyPanel { VStack(alignment: .leading, spacing: 10) { AcademyEyebrow(text: "The showcase build"); Text(course.build).font(AcademyTheme.display(18)); Divider(); LabeledContent("Entry", value: course.prereq).font(.caption); LabeledContent("Ages", value: course.ages).font(.caption) } }
                    if !course.notes.isEmpty { Text(course.notes).font(.caption).foregroundStyle(AcademyTheme.muted).lineSpacing(3) }
                    Text("The course plan").font(AcademyTheme.display(21))
                    if course.weeks.isEmpty { Text("This course is a draft outline. Use Edit plan to add sessions and link the cards students will work on.").font(.subheadline).foregroundStyle(AcademyTheme.muted) }
                    ForEach(Array(course.weeks.enumerated()), id: \.offset) { index, week in
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 13) {
                                AcademyEyebrow(text: String(format: "Session %02d", index + 1), color: AcademyTheme.blue)
                                Text(week.title).font(AcademyTheme.display(18))
                                Text(week.plan).font(.subheadline).foregroundStyle(AcademyTheme.muted).lineSpacing(4)
                                ForEach(week.abilities.compactMap { store.workspace.curriculum.ability($0) }) { card in Button { selectedCard = card } label: { HStack { Image(systemName: card.kind.symbol); Text(card.name); Spacer(); Image(systemName: "arrow.up.right") }.font(.caption.weight(.medium)).padding(.vertical, 4) } }
                            }
                        }
                    }
                }.padding(22)
            }
        }.background(AcademyTheme.paper).navigationTitle(course?.code ?? "Course").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Edit plan") { editing = true } } }
            .sheet(item: $selectedCard) { AcademyAbilityView(cardID: $0.id) }
            .sheet(isPresented: $editing) { if let course { AcademyCourseEditor(course: course) } }
    }
}

struct AcademyCourseEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    @State var course: AcademyCourse
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Course") { TextField("Name", text: $course.name); TextField("Code", text: $course.code); TextField("Summary", text: $course.summary, axis: .vertical); TextField("Showcase build", text: $course.build, axis: .vertical); TextField("Entry requirements", text: $course.prereq); TextField("Ages", text: $course.ages); TextField("Instructor", text: $course.instructor); TextField("Notes", text: $course.notes, axis: .vertical) }
                ForEach(course.weeks.indices, id: \.self) { index in
                    Section("Session \(index + 1)") {
                        TextField("Session title", text: $course.weeks[index].title)
                        TextField("Session plan", text: $course.weeks[index].plan, axis: .vertical).lineLimit(3...8)
                        NavigationLink("Linked cards (\(course.weeks[index].abilities.count))") {
                            List(store.workspace.curriculum.cards(for: course.track)) { card in
                                Toggle(card.name, isOn: Binding(get: { course.weeks[index].abilities.contains(card.id) }, set: { if $0 { if !course.weeks[index].abilities.contains(card.id) { course.weeks[index].abilities.append(card.id) } } else { course.weeks[index].abilities.removeAll { $0 == card.id } } }))
                            }.navigationTitle("Session cards")
                        }
                    }
                }
                Section { Button("Add a session") { course.weeks.append(AcademyWeek(abilities: [], plan: "", title: "New session")) } }
            }.navigationTitle("Edit course plan").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { do { try store.update { value in if let index = value.curriculum.courses.firstIndex(where: { $0.id == course.id }) { value.curriculum.courses[index] = course } }; dismiss() } catch { self.error = error.localizedDescription } }.bold() } }
                .alert("Could not save plan", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
}
