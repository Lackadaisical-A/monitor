import SwiftUI

struct AcademyLogbookView: View {
    @EnvironmentObject private var store: AcademyStore
    @State private var showPicker = false
    @State private var showEntry = false
    @State private var query = ""
    private var entries: [AcademyLogEntry] { store.studentLog.filter { query.isEmpty || "\($0.abilityName) \($0.note) \($0.instructor)".localizedCaseInsensitiveContains(query) } }
    private var report: String {
        let rows = entries.map { "\($0.date.formatted(date: .abbreviated, time: .shortened)) — \($0.action): \($0.abilityName)\nInstructor: \($0.instructor) · \($0.verification)\n\($0.note)\n\($0.skillEvidence.map { "✓ \($0)" }.joined(separator: "\n"))" }
        return "Flight & Aerospace Academy\n\(store.isDemo ? "DEMO — " : "")Student logbook: \(store.student?.name ?? "No student")\n\n" + rows.joined(separator: "\n\n")
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack { VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Proof of the journey"); Text("Logbook").font(AcademyTheme.display(32)).foregroundStyle(AcademyTheme.navy) }; Spacer(); Button { showEntry = true } label: { Image(systemName: "square.and.pencil").frame(width: 44, height: 44).background(.white, in: Circle()) }.disabled(store.student == nil).accessibilityLabel("Add logbook entry") }
                if let student = store.student {
                    Button { showPicker = true } label: { HStack(spacing: 12) { AcademyAvatar(student: student, size: 38); Text(student.name).font(.subheadline.weight(.semibold)); Image(systemName: "chevron.down").font(.caption); Spacer(); Text("\(store.studentLog.count) entries").font(.caption).foregroundStyle(AcademyTheme.muted) } }.buttonStyle(.plain)
                    HStack { Image(systemName: "magnifyingglass"); TextField("Search the logbook", text: $query).font(.subheadline) }.padding(14).foregroundStyle(AcademyTheme.muted).background(.white, in: RoundedRectangle(cornerRadius: 12))
                    HStack { AcademyEyebrow(text: "Latest entries"); Spacer(); ShareLink(item: report) { Label("Export", systemImage: "square.and.arrow.up").font(.caption.weight(.semibold)) } }
                    if entries.isEmpty { AcademyEmpty(symbol: "book.closed", title: "A story in the making.", message: "Checkride sign-offs appear here automatically. Add a reflection to record today's work.") }
                    ForEach(entries) { entry in
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack { AcademyPill(text: entry.action, color: entry.action == "Signed off" ? AcademyTheme.green : AcademyTheme.blue); Spacer(); Text(entry.date.formatted(.dateTime.month(.abbreviated).day())).font(.caption).foregroundStyle(AcademyTheme.muted) }
                                Text(entry.abilityName).font(AcademyTheme.display(19)).foregroundStyle(AcademyTheme.navy)
                                if !entry.note.isEmpty { Text(entry.note).font(.subheadline).foregroundStyle(AcademyTheme.muted).lineSpacing(4) }
                                if !entry.skillEvidence.isEmpty { DisclosureGroup("\(entry.skillEvidence.count) skills demonstrated") { VStack(alignment: .leading, spacing: 8) { ForEach(Array(entry.skillEvidence.enumerated()), id: \.offset) { _, skill in Label(skill, systemImage: "checkmark").font(.caption).foregroundStyle(AcademyTheme.muted) } }.padding(.top, 8) }.font(.caption.weight(.medium)) }
                                Divider()
                                HStack { Image(systemName: "signature"); Text(entry.instructor); Spacer(); Text(entry.verification.hasPrefix("NFC") ? "Passport verified" : entry.verification == "Demo" ? "Demo" : "Instructor entry") }.font(.system(size: 10)).foregroundStyle(AcademyTheme.muted)
                            }
                        }
                    }
                } else { AcademyEmpty(symbol: "book.closed", title: "Start with a student.", message: "Add a student from the Students tab to begin a logbook.") }
            }.padding(22)
        }.sheet(isPresented: $showPicker) { AcademyStudentPicker() }.sheet(isPresented: $showEntry) { AcademyLogEntryEditor() }
    }
}

struct AcademyLogEntryEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var goal = ""
    @State private var result = ""
    @State private var next = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section { LabeledContent("Student", value: store.student?.name ?? "None"); TextField("Entry title", text: $title) }
                Section("The mission") { TextField("What did you set out to do?", text: $goal, axis: .vertical).lineLimit(3...6) }
                Section("What happened") { TextField("What worked? What did you learn?", text: $result, axis: .vertical).lineLimit(3...6) }
                Section("Next time") { TextField("What will you try next?", text: $next, axis: .vertical).lineLimit(3...6) }
                Section { Text("A reflection records learning. Signing an ability card requires its checkride.").font(.caption).foregroundStyle(AcademyTheme.muted) }
            }.navigationTitle("New logbook entry").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") {
                        do {
                            guard let student = store.student else { throw AcademyError.missingStudent }
                            guard !store.workspace.instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.instructorRequired }
                            try store.update { value in value.log.insert(AcademyLogEntry(studentID: student.id, abilityName: title.trimmingCharacters(in: .whitespacesAndNewlines), action: "Reflection", note: "Goal: \(goal)\nResult: \(result)\nNext: \(next)", instructor: value.instructor, verification: store.isDemo ? "Demo" : "Instructor entry"), at: 0) }
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }.bold().disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }.alert("Could not save entry", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
}
