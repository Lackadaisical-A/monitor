import SwiftUI

struct AcademyAbilityView: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    let cardID: String
    @State private var checked = Set<String>()
    @State private var note = ""
    @State private var busy = false
    @State private var editing = false
    @State private var error: String?
    @State private var relatedCard: AcademyAbility?
    @State private var confirmSign = false
    @State private var success = false
    private var card: AcademyAbility? { store.workspace.curriculum.ability(cardID) }
    private var progress: AcademyProgress? { store.selectedStudentID.flatMap { store.workspace.progress(for: $0, abilityID: cardID) } }
    private var missing: [AcademyAbility] { guard let card, let id = store.selectedStudentID else { return [] }; return store.workspace.missingRequirements(for: card, studentID: id) }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let card {
                    VStack(alignment: .leading, spacing: 24) {
                        HStack { AcademyPill(text: card.kind.name, color: card.kind == .clearance ? AcademyTheme.goldInk : AcademyTheme.navy); Spacer(); AcademyEyebrow(text: "Phase \(card.phase) / 05") }
                        VStack(alignment: .leading, spacing: 10) {
                            Text(card.name).font(AcademyTheme.display(30)).foregroundStyle(AcademyTheme.navy)
                            Text("\(card.laneName) · \(card.launch)").font(.caption).foregroundStyle(AcademyTheme.muted)
                        }
                        if let student = store.student {
                            HStack(spacing: 10) { AcademyAvatar(student: student, size: 34); Text(student.name).font(.subheadline.weight(.medium)); Spacer(); AcademyPill(text: progress?.state == .signed ? "Signed off" : progress?.state == .paused ? "Paused" : progress?.state == .inProgress ? "In progress" : missing.isEmpty ? "Ready" : "Locked", color: progress?.state == .signed ? AcademyTheme.green : AcademyTheme.navy) }
                        }
                        AcademyPanel {
                            VStack(alignment: .leading, spacing: 10) { AcademyEyebrow(text: "The mission"); Text(card.mission).font(.body).foregroundStyle(AcademyTheme.ink).lineSpacing(5) }
                        }
                        if !card.requires.isEmpty {
                            VStack(alignment: .leading, spacing: 11) {
                                AcademyEyebrow(text: missing.isEmpty ? "Prerequisites cleared" : "Before you begin")
                                ForEach(card.requires.compactMap { store.workspace.curriculum.ability($0) }) { requirement in
                                    Button { relatedCard = requirement } label: {
                                        HStack { Image(systemName: store.selectedStudentID.map { store.workspace.signedIDs(for: $0).contains(requirement.id) } == true ? "checkmark.circle.fill" : "lock.circle").foregroundStyle(AcademyTheme.green); Text(requirement.name).font(.subheadline); Spacer(); Image(systemName: "arrow.up.right").font(.caption) }
                                    }.buttonStyle(.plain)
                                }
                                if !missing.isEmpty { Text("Needed: \(missing.map(\.name).joined(separator: ", ")).").font(.caption).foregroundStyle(AcademyTheme.goldInk).lineSpacing(3) }
                            }
                        }
                        VStack(alignment: .leading, spacing: 13) {
                            HStack { AcademyEyebrow(text: "The checkride"); Spacer(); Text("\(checked.count) / \(card.skills.count)").font(.caption.monospaced()).foregroundStyle(AcademyTheme.muted) }
                            Text("Show the skill. Explain the why.").font(AcademyTheme.display(18)).foregroundStyle(AcademyTheme.navy)
                            ForEach(Array(card.skills.enumerated()), id: \.offset) { index, skill in
                                Button {
                                    var updated = checked
                                    if updated.contains(skill) { updated.remove(skill) } else { updated.insert(skill) }
                                    do { try store.saveChecklist(cardID: cardID, checked: updated); checked = updated } catch { self.error = error.localizedDescription }
                                } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        Image(systemName: checked.contains(skill) ? "checkmark.circle.fill" : "circle").font(.system(size: 23, weight: .light)).foregroundStyle(checked.contains(skill) ? AcademyTheme.green : AcademyTheme.muted.opacity(0.5))
                                        Text(skill).font(.subheadline).lineSpacing(3).foregroundStyle(AcademyTheme.ink).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                                        Text(String(format: "%02d", index + 1)).font(.system(size: 9, design: .monospaced)).foregroundStyle(AcademyTheme.muted).padding(.top, 5)
                                    }.padding(15).background(.white, in: RoundedRectangle(cornerRadius: 13)).overlay(RoundedRectangle(cornerRadius: 13).stroke(AcademyTheme.line, lineWidth: 1))
                                }.buttonStyle(.plain).disabled(progress?.state != .inProgress || busy).accessibilityLabel("\(checked.contains(skill) ? "Demonstrated" : "Not yet demonstrated"): \(skill)")
                            }
                        }
                        if progress?.state == .inProgress {
                            VStack(alignment: .leading, spacing: 9) { AcademyEyebrow(text: "Instructor notes"); TextField("What went well? What comes next?", text: $note, axis: .vertical).lineLimit(3...6).padding(14).background(.white, in: RoundedRectangle(cornerRadius: 12)).font(.subheadline) }
                        }
                        if !card.unlocks.isEmpty {
                            AcademyPanel { HStack(alignment: .top, spacing: 12) { Image(systemName: "arrow.triangle.branch").foregroundStyle(AcademyTheme.blue); VStack(alignment: .leading, spacing: 7) { AcademyEyebrow(text: "A door to what's next"); Text(card.unlocks).font(.subheadline).foregroundStyle(AcademyTheme.navy) } } }
                        }
                        if let progress, progress.state == .signed || progress.state == .paused {
                            VStack(alignment: .leading, spacing: 8) {
                                Label("Signed by \(progress.instructor)", systemImage: "signature").font(.subheadline.weight(.medium))
                                Text(progress.updatedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(AcademyTheme.muted)
                                if card.kind == .clearance {
                                    TextField("Reason for pausing or restoring", text: $note, axis: .vertical).font(.subheadline).padding(13).background(.white, in: RoundedRectangle(cornerRadius: 10))
                                    Button(progress.state == .paused ? "Restore clearance" : "Pause clearance") {
                                        Task {
                                            busy = true; defer { busy = false }
                                            do {
                                                try await store.authorizeInstructor()
                                                guard let id = store.selectedStudentID else { throw AcademyError.missingStudent }
                                                try store.update { try $0.setClearance(cardID, studentID: id, paused: progress.state == .signed, reason: note) }
                                                note = ""
                                            } catch { self.error = error.localizedDescription }
                                        }
                                    }.font(.subheadline.weight(.semibold)).disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                                }
                            }
                        }
                        Text("Draft curriculum · Revision \(card.revision ?? 1)\n\(card.course)").font(.caption2).foregroundStyle(AcademyTheme.muted).lineSpacing(4)
                    }.padding(22)
                }
            }.background(AcademyTheme.paper)
                .navigationTitle("Ability card").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) { Button { editing = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("Edit ability card") }
                }
                .safeAreaInset(edge: .bottom) { actions }
                .sheet(isPresented: $editing, onDismiss: loadChecklist) { if let card { AcademyAbilityEditor(existing: card, track: card.programs.first ?? .aerospace) } }
                .sheet(item: $relatedCard, onDismiss: loadChecklist) { AcademyAbilityView(cardID: $0.id) }
                .alert("Checkride", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
                .confirmationDialog("Sign this card for \(store.student?.name ?? "the student")?", isPresented: $confirmSign, titleVisibility: .visible) {
                    if store.student?.passportFingerprint != nil { Button("Scan passport & sign") { sign(useNFC: true) } }
                    Button(store.isDemo ? "Sign demo checkride" : "Authorize & sign manually") { sign(useNFC: false) }
                    Button("Cancel", role: .cancel) {}
                } message: { Text("I observed every skill and the student explained their work. This adds an instructor-signed entry to their logbook.") }
                .onAppear(perform: loadChecklist)
                .sensoryFeedback(.success, trigger: success)
        }.tint(AcademyTheme.navy)
    }

    @ViewBuilder private var actions: some View {
        if let card, store.student != nil, progress?.state != .signed && progress?.state != .paused {
            VStack(spacing: 10) {
                if progress?.state == .inProgress {
                    Button { confirmSign = true } label: { HStack(spacing: 10) { if busy { ProgressView().tint(.white) } else { Image(systemName: "checkmark.seal") }; Text("Sign off checkride") } }.buttonStyle(AcademyPrimaryButton()).disabled(checked.count != card.skills.count || !missing.isEmpty || busy)
                    Button("Put this card aside") { do { try store.putAside(cardID); checked = [] } catch { self.error = error.localizedDescription } }.font(.caption).disabled(busy)
                } else {
                    Button {
                        do { guard let id = store.selectedStudentID else { return }; try store.update { try $0.start(cardID, studentID: id) } } catch { self.error = error.localizedDescription }
                    } label: { Label(missing.isEmpty ? "Start this card" : "Prerequisites needed", systemImage: missing.isEmpty ? "arrow.up.right" : "lock") }.buttonStyle(AcademyPrimaryButton()).disabled(!missing.isEmpty)
                }
            }.padding(.horizontal, 22).padding(.vertical, 12).background(.ultraThinMaterial)
        }
    }
    private func loadChecklist() { checked = Set(progress?.checkedSkills ?? []) }
    private func sign(useNFC: Bool) {
        Task {
            busy = true; defer { busy = false }
            do { try await store.sign(cardID: cardID, checked: checked, note: note, useNFC: useNFC); success.toggle(); dismiss() }
            catch ClubCardReaderError.cancelled {} catch { self.error = error.localizedDescription }
        }
    }
}

struct AcademyAbilityEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @Environment(\.dismiss) private var dismiss
    let existing: AcademyAbility?
    let track: AcademyTrack
    @State private var name = ""
    @State private var mission = ""
    @State private var skills = ""
    @State private var unlocks = ""
    @State private var course = ""
    @State private var kind = AcademyKind.ability
    @State private var phase = 2
    @State private var lane = "des"
    @State private var launch = "winter"
    @State private var programs = Set<AcademyTrack>()
    @State private var requires = Set<String>()
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("The card") {
                    TextField("Card title", text: $name)
                    Picker("Kind", selection: $kind) { ForEach(AcademyKind.allCases) { Text($0.name).tag($0) } }
                    Picker("Phase", selection: $phase) { ForEach(1...5, id: \.self) { Text("\($0) · \(AcademyCurriculum.phases[$0 - 1])").tag($0) } }
                    Picker("Specialty", selection: $lane) { ForEach(AcademyCurriculum.lanes.keys.sorted(), id: \.self) { Text(AcademyCurriculum.lanes[$0] ?? $0).tag($0) } }
                    Picker("Launch", selection: $launch) { Text("Winter 2027").tag("winter"); Text("Spring 2027").tag("spring"); Text("Future").tag("later") }
                    TextField("Course references", text: $course)
                }
                Section("Tracks") { ForEach(AcademyTrack.allCases) { item in Toggle(item.name, isOn: Binding(get: { programs.contains(item) }, set: { if $0 { programs.insert(item) } else { programs.remove(item) } })) } }
                Section("Mission") { TextField("What will the student accomplish?", text: $mission, axis: .vertical).lineLimit(3...7) }
                Section { TextEditor(text: $skills).frame(minHeight: 150).accessibilityLabel("Checkride skills, one per line") } header: { Text("Checkride skills") } footer: { Text("One observable skill per line. Editing resets unfinished checklists; signed evidence remains in the logbook.") }
                Section("Unlocks") { TextField("What does this card make possible?", text: $unlocks, axis: .vertical).lineLimit(2...4) }
                Section("Prerequisite cards") {
                    ForEach(store.cards.filter { $0.id != existing?.id }) { card in
                        Toggle(card.name, isOn: Binding(get: { requires.contains(card.id) }, set: { if $0 { requires.insert(card.id) } else { requires.remove(card.id) } })).font(.subheadline)
                    }
                }
            }.navigationTitle(existing == nil ? "New ability card" : "Edit card").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.bold().disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || programs.isEmpty || skills.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
                .onAppear {
                    programs = Set(existing?.programs ?? [track])
                    if let card = existing { name = card.name; mission = card.mission; skills = card.skills.joined(separator: "\n"); unlocks = card.unlocks; kind = card.kind; phase = card.phase; lane = card.lane; launch = card.status; course = card.course; requires = Set(card.requires) }
                }
                .alert("Could not save card", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
    private func save() {
        let card = AcademyAbility(id: existing?.id ?? "custom-\(UUID().uuidString.lowercased())", course: course, kind: kind, lane: lane, mission: mission, name: name, order: existing?.order ?? (store.cards.map(\.order).max() ?? 0) + 10, phase: phase, programs: AcademyTrack.allCases.filter(programs.contains), requires: requires.sorted(), skills: skills.components(separatedBy: .newlines), status: launch, unlocks: unlocks)
        do { try store.saveAbility(card); dismiss() } catch { self.error = error.localizedDescription }
    }
}
