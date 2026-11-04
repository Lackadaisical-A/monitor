import SwiftUI

struct AcademyStudentsView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @State private var query = ""
    @State private var adding = false
    @State private var passport = false
    private var students: [AcademyStudent] { store.workspace.students.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.passportNumber.localizedCaseInsensitiveContains(query) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Every student has a flight path"); Text("Your students").font(AcademyTheme.display(32)).foregroundStyle(AcademyTheme.navy) }
                    Spacer(); Button { adding = true } label: { Image(systemName: "plus").frame(width: 44, height: 44).background(.white, in: Circle()) }.accessibilityLabel("Add student")
                }
                Button { Task { await store.scanPassport() } } label: { HStack { Image(systemName: "wave.3.right"); Text("Open a student with a tap"); Spacer(); Image(systemName: "arrow.up.right") } }.buttonStyle(AcademyPrimaryButton())
                HStack { Image(systemName: "magnifyingglass"); TextField("Search students or passport number", text: $query).font(.subheadline).accessibilityLabel("Search students") }.padding(14).foregroundStyle(AcademyTheme.muted).background(.white, in: RoundedRectangle(cornerRadius: 12))
                Text("\(students.count) \(students.count == 1 ? "student" : "students")\(store.isDemo ? " · demo records" : "")").font(.caption).foregroundStyle(AcademyTheme.muted)
                if students.isEmpty { AcademyEmpty(symbol: "person.2", title: query.isEmpty ? "Meet your next generation." : "No matching students.", message: query.isEmpty ? "Add a student to start their passport and record the skills they earn." : "Try a different name or passport number.") }
                ForEach(students) { student in
                    NavigationLink { AcademyStudentDetail(studentID: student.id) } label: {
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 17) {
                                HStack(spacing: 12) { AcademyAvatar(student: student, size: 48); VStack(alignment: .leading, spacing: 5) { Text(student.name).font(AcademyTheme.display(18)); Text("\(student.track.name) · \(store.workspace.rank(for: student))").font(.caption).foregroundStyle(AcademyTheme.muted) }; Spacer(); Image(systemName: "arrow.up.right").font(.subheadline) }
                                HStack { Text(student.passportNumber).font(.system(size: 10, design: .monospaced)).foregroundStyle(AcademyTheme.muted); Spacer(); Text("\(store.workspace.signedIDs(for: student.id).count + teaching.state.awards.filter { $0.studentID == student.id && !$0.paused }.count) skills earned").font(.caption.weight(.medium)); Image(systemName: student.passportFingerprint == nil ? "wave.3.right" : "wave.3.right.circle.fill").foregroundStyle(student.passportFingerprint == nil ? AcademyTheme.muted : AcademyTheme.green) }
                            }
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(22)
        }.sheet(isPresented: $adding) { AcademyStudentEditor() }.sheet(isPresented: $passport) { AcademyPassportView() }
    }
}

struct AcademyStudentPicker: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    var body: some View {
        NavigationStack {
            List(store.workspace.students) { student in
                Button { store.selectedStudentID = student.id; dismiss() } label: {
                    HStack(spacing: 13) { AcademyAvatar(student: student); VStack(alignment: .leading, spacing: 4) { Text(student.name).foregroundStyle(AcademyTheme.navy); Text(student.track.name).font(.caption).foregroundStyle(AcademyTheme.muted) }; Spacer(); if student.id == store.selectedStudentID { Image(systemName: "checkmark.circle.fill").foregroundStyle(AcademyTheme.green) } }.padding(.vertical, 5)
                }
            }.navigationTitle("Choose a student").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }; ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add student") } }
                .sheet(isPresented: $adding) { AcademyStudentEditor() }
        }.tint(AcademyTheme.navy).presentationDetents([.medium, .large])
    }
}

struct AcademyStudentEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    var existing: AcademyStudent? = nil
    @State private var name = ""
    @State private var track = AcademyTrack.aerospace
    @State private var courseID = "uas-101"
    @State private var error: String?
    private var courses: [AcademyCourse] { store.workspace.curriculum.courses.filter { $0.track == track }.sorted { $0.order < $1.order } }
    var body: some View {
        NavigationStack {
            Form {
                Section("Student passport") {
                    TextField("Student name", text: $name).textContentType(.name)
                    Picker("Track", selection: $track) { ForEach(AcademyTrack.allCases) { Text($0.name).tag($0) } }
                    Picker("Course", selection: $courseID) {
                        Text("No course yet").tag("")
                        ForEach(courses) { Text("\($0.code) · \($0.name)").tag($0.id) }
                    }
                }
                Section { Label("Link their NFC passport after saving.", systemImage: "wave.3.right").font(.subheadline) } footer: { Text("Only a name and learning track are needed. Records stay in this workspace on your iPhone.") }
            }.navigationTitle(existing == nil ? "New student" : "Edit student").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") {
                        do {
                            if let existing {
                                try store.update { value in
                                    guard let index = value.students.firstIndex(where: { $0.id == existing.id }) else { throw AcademyError.missingStudent }
                                    if track != existing.track && value.progress.contains(where: { $0.studentID == existing.id && $0.state == .inProgress }) { throw AcademyError.oneCardAtATime }
                                    value.students[index].name = name.trimmingCharacters(in: .whitespacesAndNewlines); value.students[index].track = track; value.students[index].courseID = courseID
                                }
                            } else { try store.addStudent(name: name, track: track, courseID: courseID) }
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }.bold().disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100) }
                }
                .onChange(of: track) { _, _ in if !courses.contains(where: { $0.id == courseID }) { courseID = courses.first?.id ?? "" } }
                .onAppear { if let existing { name = existing.name; track = existing.track; courseID = existing.courseID } }
                .alert("Could not save student", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
}

struct AcademyPassportView: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?
    @State private var editing = false
    @State private var confirmingRelink = false
    var body: some View {
        NavigationStack {
            ScrollView {
                if let student = store.student {
                    VStack(alignment: .leading, spacing: 23) {
                        VStack(alignment: .leading, spacing: 26) {
                            HStack { AcademyEyebrow(text: "Flight & Aerospace Academy", color: .white.opacity(0.7)); Spacer(); Image(systemName: "wave.3.right").foregroundStyle(AcademyTheme.gold) }
                            AcademyAvatar(student: student, size: 67, dark: true)
                            VStack(alignment: .leading, spacing: 9) { Text(student.name).font(AcademyTheme.display(29)); Text("\(store.workspace.rank(for: student))  ·  \(student.track.name)").font(.subheadline).foregroundStyle(AcademyTheme.gold) }
                            Divider().overlay(.white.opacity(0.2))
                            HStack { Text(student.passportNumber).font(.system(size: 12, design: .monospaced)).tracking(2); Spacer(); Text("STUDENT PASSPORT").font(.system(size: 8, design: .monospaced)) }
                        }.foregroundStyle(.white).padding(25).background { ZStack { AcademyTheme.navy; AcademyFlightDrawing() } }.clipShape(RoundedRectangle(cornerRadius: 22))
                        HStack(spacing: 13) {
                            stat("\(store.signedCount)", "Cards earned")
                            stat("\(store.workspace.progress.filter { $0.studentID == student.id && $0.state == .signed && store.workspace.curriculum.ability($0.abilityID)?.kind == .clearance }.count)", "Clearances")
                            stat(store.currentCard == nil ? "0" : "1", "In progress")
                        }
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Label(student.passportFingerprint == nil ? "Give their progress a passport." : "Passport connected", systemImage: student.passportFingerprint == nil ? "wave.3.right" : "checkmark.circle.fill").font(AcademyTheme.display(17)).foregroundStyle(AcademyTheme.navy)
                                Text(student.passportFingerprint == nil ? "Link an NFC tag. A tap opens this student's journey and verifies their next checkride." : "This tag identifies the student on this iPhone. Instructor authorization is still required to sign a card.").font(.subheadline).foregroundStyle(AcademyTheme.muted).lineSpacing(4)
                                Button {
                                    if student.passportFingerprint != nil { confirmingRelink = true } else { link(student) }
                                } label: { HStack { if busy { ProgressView().tint(.white) }; Text(student.passportFingerprint == nil ? "Link NFC passport" : "Replace passport tag"); Image(systemName: "wave.3.right") } }.buttonStyle(AcademyPrimaryButton()).disabled(busy)
                            }
                        }
                        Button { store.selectedTab = "map"; dismiss() } label: { Label("Explore their skill map", systemImage: "point.topleft.down.to.point.bottomright.curvepath").frame(maxWidth: .infinity) }.font(.subheadline.weight(.semibold))
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 14) {
                                AcademyEyebrow(text: "Ranks are earned")
                                Text("Cadet → Mission Specialist / Pilot").font(AcademyTheme.display(16))
                                Text(student.track == .flight ? "Ground School and a logbook entry earn Cadet. The simulator checkride and a build presentation earn Pilot." : "Ground School clearances and a logbook entry earn Cadet. Complete a specialty through Phase 3, a capstone, and a presentation to earn Mission Specialist.").font(.caption).foregroundStyle(AcademyTheme.muted).lineSpacing(4)
                                Text("Flight Commander and Commander require a mentor's review of leadership and portfolio evidence; they are not awarded automatically.").font(.caption2).foregroundStyle(AcademyTheme.muted)
                            }
                        }
                    }.padding(22)
                }
            }.background(AcademyTheme.paper).navigationTitle("Student passport").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }; ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } } }
                .sheet(isPresented: $editing) { AcademyStudentEditor(existing: store.student) }
                .confirmationDialog("Replace this student's passport tag?", isPresented: $confirmingRelink, titleVisibility: .visible) { Button("Scan replacement tag") { if let student = store.student { link(student) } }; Button("Cancel", role: .cancel) {} } message: { Text("The previous tag will stop opening this passport. Student progress will be kept.") }
                .alert("Passport", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
    private func stat(_ value: String, _ label: String) -> some View { VStack(spacing: 6) { Text(value).font(AcademyTheme.display(26)).foregroundStyle(AcademyTheme.navy); Text(label).font(.system(size: 10)).foregroundStyle(AcademyTheme.muted) }.frame(maxWidth: .infinity).padding(.vertical, 16).background(.white, in: RoundedRectangle(cornerRadius: 14)) }
    private func link(_ student: AcademyStudent) {
        Task {
            busy = true; defer { busy = false }
            do { try await store.authorizeInstructor(); let scan = try await ClubCardReader.shared.scan(); if !store.isDemo, let cloud = store.cloud, cloud.connected { try await cloud.link(scan, studentID: student.id) }; try store.linkPassport(scan, studentID: student.id) }
            catch ClubCardReaderError.cancelled {} catch { self.error = error.localizedDescription }
        }
    }
}
