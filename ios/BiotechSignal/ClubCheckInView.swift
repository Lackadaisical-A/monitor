import SwiftUI

@MainActor
final class ClubCheckInModel: ObservableObject {
    @Published private(set) var dashboard: ClubDashboardResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var isScanning = false
    @Published private(set) var isSaving = false
    @Published var pendingCard: ClubCardScan?
    @Published var message: ClubOperatorMessage?

    func load(settings: ServerSettings) async {
        guard settings.isComplete, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            dashboard = try await APIClient(settings: settings).fetchClubDashboard()
        } catch {
            message = ClubOperatorMessage(title: "Could not load check-in", body: error.localizedDescription)
        }
    }

    func createEvent(title: String, settings: ServerSettings) async -> Bool {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await APIClient(settings: settings).createClubEvent(title: normalized)
            await reload(settings: settings)
            return true
        } catch {
            message = ClubOperatorMessage(title: "Could not start event", body: error.localizedDescription)
            return false
        }
    }

    func closeActiveEvent(settings: ServerSettings) async {
        guard let event = dashboard?.activeEvent, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await APIClient(settings: settings).closeClubEvent(id: event.id)
            await reload(settings: settings)
        } catch {
            message = ClubOperatorMessage(title: "Could not close event", body: error.localizedDescription)
        }
    }

    func scan(settings: ServerSettings) async {
        guard let event = dashboard?.activeEvent, !isScanning else { return }
        isScanning = true
        defer { isScanning = false }
        do {
            let card = try await ClubCardReader.shared.scan()
            pendingCard = card
            let result = try await APIClient(settings: settings).checkInClubMember(
                ClubCheckInRequest(
                    eventId: event.id,
                    card: ClubCardRequest(technology: card.technology, identifier: card.identifier),
                    registration: nil
                )
            )
            await handle(result, settings: settings)
        } catch ClubCardReaderError.cancelled {
            pendingCard = nil
        } catch {
            pendingCard = nil
            message = ClubOperatorMessage(title: "Card not read", body: error.localizedDescription)
        }
    }

    func register(
        card: ClubCardScan,
        registration: ClubMemberRegistrationRequest,
        settings: ServerSettings
    ) async {
        guard let event = dashboard?.activeEvent, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let result = try await APIClient(settings: settings).checkInClubMember(
                ClubCheckInRequest(
                    eventId: event.id,
                    card: ClubCardRequest(technology: card.technology, identifier: card.identifier),
                    registration: registration
                )
            )
            await handle(result, settings: settings)
        } catch {
            message = ClubOperatorMessage(title: "Could not register member", body: error.localizedDescription)
        }
    }

    func delete(member: ClubMember, settings: ServerSettings) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await APIClient(settings: settings).deleteClubMember(id: member.id)
            await reload(settings: settings)
            return true
        } catch {
            message = ClubOperatorMessage(title: "Could not delete profile", body: error.localizedDescription)
            return false
        }
    }

    private func handle(_ result: ClubCheckInResponse, settings: ServerSettings) async {
        switch result.status {
        case "registration_required":
            return
        case "checked_in":
            pendingCard = nil
            message = ClubOperatorMessage(
                title: "Checked in",
                body: result.member?.name ?? "Member"
            )
            await reload(settings: settings)
        case "already_checked_in":
            pendingCard = nil
            message = ClubOperatorMessage(
                title: "Already checked in",
                body: result.member?.name ?? "Member"
            )
            await reload(settings: settings)
        default:
            pendingCard = nil
            message = ClubOperatorMessage(title: "Event unavailable", body: "Start an active event and scan again.")
            await reload(settings: settings)
        }
    }

    private func reload(settings: ServerSettings) async {
        do {
            dashboard = try await APIClient(settings: settings).fetchClubDashboard()
        } catch {
            message = ClubOperatorMessage(title: "Could not refresh check-in", body: error.localizedDescription)
        }
    }
}

struct ClubOperatorMessage: Identifiable {
    let id = UUID()
    let title: String
    let body: String
}

struct ClubCheckInView: View {
    @EnvironmentObject private var store: MonitorStore
    @StateObject private var model = ClubCheckInModel()
    @State private var showingNewEvent = false
    @State private var showingCloseConfirmation = false

    var body: some View {
        Group {
            if store.access.level != "developer" {
                ContentUnavailableView("Developer access required", systemImage: "lock.shield")
            } else {
                List {
                    if model.dashboard == nil && model.isLoading {
                        Section { HStack { Spacer(); ProgressView(); Spacer() } }
                    } else if let event = model.dashboard?.activeEvent {
                        activeEventSection(event)
                        checkInSection(event)
                    } else {
                        Section {
                            Button {
                                showingNewEvent = true
                            } label: {
                                Label("Start club event", systemImage: "calendar.badge.plus")
                            }
                        }
                    }

                    if let recent = model.dashboard?.recentEvents, !recent.isEmpty {
                        Section("Recent events") {
                            ForEach(recent) { event in
                                NavigationLink {
                                    ClubPastEventView(event: event, model: model)
                                        .environmentObject(store)
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(event.title).font(.subheadline.weight(.semibold))
                                            Text(clubDate(event.startedAt)).font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Text("\(event.checkInCount)")
                                            .font(.system(.subheadline, design: .monospaced, weight: .bold))
                                    }
                                }
                            }
                        }
                    }

                    Section {
                        Label("Club attendance only", systemImage: "person.text.rectangle")
                    } footer: {
                        Text("A card scan does not verify Rutgers affiliation or grant university access.")
                    }
                }
                .refreshable { await model.load(settings: store.settings) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.catalystBackground)
        .navigationTitle("Club Check-in")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.access.level == "developer"
                && model.dashboard != nil
                && model.dashboard?.activeEvent == nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingNewEvent = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Start club event")
                }
            }
        }
        .task { await model.load(settings: store.settings) }
        .sheet(isPresented: $showingNewEvent) {
            NewClubEventView(model: model)
                .environmentObject(store)
        }
        .sheet(item: $model.pendingCard) { card in
            ClubMemberRegistrationView(card: card, model: model)
                .environmentObject(store)
        }
        .alert(item: $model.message) { message in
            Alert(
                title: Text(message.title),
                message: Text(message.body),
                dismissButton: .default(Text("OK"))
            )
        }
        .confirmationDialog("Close this event?", isPresented: $showingCloseConfirmation) {
            Button("Close event", role: .destructive) {
                Task { await model.closeActiveEvent(settings: store.settings) }
            }
        }
    }

    @ViewBuilder
    private func activeEventSection(_ event: ClubEventDetail) -> some View {
        Section("Active event") {
            LabeledContent("Event", value: event.title)
            LabeledContent("Started", value: clubTime(event.startedAt))
            LabeledContent("Attendance", value: "\(event.checkInCount)")
            Button {
                Task { await model.scan(settings: store.settings) }
            } label: {
                HStack {
                    Label("Scan member card", systemImage: "wave.3.right")
                    Spacer()
                    if model.isScanning { ProgressView().controlSize(.small) }
                }
            }
            .disabled(model.isScanning || model.isSaving)
            Button(role: .destructive) {
                showingCloseConfirmation = true
            } label: {
                Label("Close event", systemImage: "stop.circle")
            }
            .disabled(model.isSaving)
        }
    }

    @ViewBuilder
    private func checkInSection(_ event: ClubEventDetail) -> some View {
        Section("Checked in") {
            if event.checkIns.isEmpty {
                LabeledContent("Attendance", value: "No check-ins")
            } else {
                ForEach(event.checkIns) { checkIn in
                    NavigationLink {
                        ClubMemberDetailView(member: checkIn.member, model: model)
                            .environmentObject(store)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(checkIn.member.name).font(.subheadline.weight(.semibold))
                                Text(gradeLabel(checkIn.member.grade)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(clubTime(checkIn.checkedInAt)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}

private struct NewClubEventView: View {
    @EnvironmentObject private var store: MonitorStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: ClubCheckInModel
    @State private var title = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Event") {
                    TextField("Event name", text: $title)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                }
            }
            .navigationTitle("New Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        Task {
                            if await model.createEvent(title: title, settings: store.settings) { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSaving)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

private struct ClubMemberRegistrationView: View {
    @EnvironmentObject private var store: MonitorStore
    @Environment(\.dismiss) private var dismiss
    let card: ClubCardScan
    @ObservedObject var model: ClubCheckInModel
    @State private var name = ""
    @State private var age = ""
    @State private var contactType = "phone"
    @State private var contact = ""
    @State private var grade = "first_year"
    @State private var consent = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Member") {
                    TextField("Full name", text: $name)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                    TextField("Age", text: $age)
                        .keyboardType(.numberPad)
                    Picker("Grade", selection: $grade) {
                        ForEach(clubGrades, id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                }
                Section("Contact") {
                    Picker("Contact method", selection: $contactType) {
                        Text("Phone").tag("phone")
                        Text("Instagram").tag("instagram")
                    }
                    .pickerStyle(.segmented)
                    TextField(contactType == "phone" ? "Phone number" : "Instagram handle", text: $contact)
                        .keyboardType(contactType == "phone" ? .phonePad : .default)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Toggle("I consent to storing this profile and listing my name and attendance in the club's private Google Sheet.", isOn: $consent)
                } footer: {
                    Text("Age, contact information, and card data are not copied to Google Sheets. The card identifier is converted to a one-way service fingerprint and is not stored in raw form.")
                }
            }
            .navigationTitle("New Member")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Check In") {
                        guard let numericAge = Int(age) else { return }
                        Task {
                            await model.register(
                                card: card,
                                registration: ClubMemberRegistrationRequest(
                                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                    age: numericAge,
                                    contactType: contactType,
                                    contact: contact.trimmingCharacters(in: .whitespacesAndNewlines),
                                    grade: grade,
                                    consent: true
                                ),
                                settings: store.settings
                            )
                        }
                    }
                    .disabled(!registrationIsValid || model.isSaving)
                }
            }
        }
    }

    private var registrationIsValid: Bool {
        guard let numericAge = Int(age), (13...120).contains(numericAge) else { return false }
        return !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && contact.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
            && consent
    }
}

private struct ClubPastEventView: View {
    @EnvironmentObject private var store: MonitorStore
    let event: ClubEventSummary
    @ObservedObject var model: ClubCheckInModel
    @State private var detail: ClubEventDetail?
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        List {
            Section("Event") {
                LabeledContent("Date", value: clubDate(event.startedAt))
                LabeledContent("Attendance", value: "\(detail?.checkInCount ?? event.checkInCount)")
            }
            Section("Checked in") {
                if isLoading && detail == nil {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if let errorMessage {
                    ContentUnavailableView("Roster unavailable", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
                } else if let checkIns = detail?.checkIns, !checkIns.isEmpty {
                    ForEach(checkIns) { checkIn in
                        NavigationLink {
                            ClubMemberDetailView(member: checkIn.member, model: model) {
                                if let current = detail {
                                    let remaining = current.checkIns.filter { $0.memberId != checkIn.memberId }
                                    detail = ClubEventDetail(
                                        id: current.id,
                                        title: current.title,
                                        startedAt: current.startedAt,
                                        endedAt: current.endedAt,
                                        checkInCount: remaining.count,
                                        createdAt: current.createdAt,
                                        checkIns: remaining
                                    )
                                }
                            }
                                .environmentObject(store)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(checkIn.member.name).font(.subheadline.weight(.semibold))
                                    Text(gradeLabel(checkIn.member.grade)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(clubTime(checkIn.checkedInAt)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    LabeledContent("Attendance", value: "No check-ins")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.catalystBackground)
        .navigationTitle(event.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await APIClient(settings: store.settings).fetchClubEvent(id: event.id).event
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ClubMemberDetailView: View {
    @EnvironmentObject private var store: MonitorStore
    @Environment(\.dismiss) private var dismiss
    let member: ClubMember
    @ObservedObject var model: ClubCheckInModel
    var onDeleted: (() -> Void)? = nil
    @State private var confirmingDeletion = false

    var body: some View {
        Form {
            Section("Profile") {
                LabeledContent("Name", value: member.name)
                LabeledContent("Age", value: "\(member.age)")
                LabeledContent("Grade", value: gradeLabel(member.grade))
                LabeledContent(member.contactType == "phone" ? "Phone" : "Instagram", value: member.contact)
            }
            Section("Card") {
                LabeledContent("Fingerprint", value: member.cardHint)
                LabeledContent("Technology", value: member.tagTechnology.uppercased())
                LabeledContent("Consent", value: clubDate(member.consentedAt))
            }
            Section {
                Button(role: .destructive) {
                    confirmingDeletion = true
                } label: {
                    Label("Delete attendance profile", systemImage: "trash")
                }
                .disabled(model.isSaving)
            }
        }
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete this member and all attendance records?", isPresented: $confirmingDeletion) {
            Button("Delete profile", role: .destructive) {
                Task {
                    if await model.delete(member: member, settings: store.settings) {
                        onDeleted?()
                        dismiss()
                    }
                }
            }
        }
    }
}

private let clubGrades = [
    (value: "first_year", label: "First year"),
    (value: "sophomore", label: "Sophomore"),
    (value: "junior", label: "Junior"),
    (value: "senior", label: "Senior"),
    (value: "graduate", label: "Graduate"),
    (value: "alumni", label: "Alumni"),
    (value: "other", label: "Other"),
]

private func gradeLabel(_ value: String) -> String {
    clubGrades.first(where: { $0.value == value })?.label ?? value.capitalized
}

private func clubDate(_ value: String) -> String {
    guard let date = clubISODate(value) else { return value }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

private func clubTime(_ value: String) -> String {
    guard let date = clubISODate(value) else { return value }
    return date.formatted(.dateTime.hour().minute())
}

private func clubISODate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
