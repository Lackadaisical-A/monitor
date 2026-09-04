import SwiftUI

@MainActor
final class ClubCheckInModel: ObservableObject {
    @Published private(set) var dashboard: ClubDashboardResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var isScanning = false
    @Published private(set) var isSaving = false
    @Published var pendingCard: ClubCardScan?
    @Published var message: ClubOperatorMessage?

    func load(settings: ServerSettings, operatorMode: Bool) async {
        guard settings.isComplete, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            dashboard = try await APIClient(settings: settings).fetchClubDashboard(operatorMode: operatorMode)
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
            await reload(settings: settings, operatorMode: true)
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
            await reload(settings: settings, operatorMode: true)
        } catch {
            message = ClubOperatorMessage(title: "Could not close event", body: error.localizedDescription)
        }
    }

    func scan(settings: ServerSettings, operatorMode: Bool) async {
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
                ),
                operatorMode: operatorMode
            )
            await handle(result, settings: settings, operatorMode: operatorMode)
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
        settings: ServerSettings,
        operatorMode: Bool
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
                ),
                operatorMode: operatorMode
            )
            await handle(result, settings: settings, operatorMode: operatorMode)
        } catch {
            message = ClubOperatorMessage(title: "Could not register member", body: error.localizedDescription)
        }
    }

    func checkInWithoutCard(_ request: ClubManualCheckInRequest, settings: ServerSettings) async -> Bool {
        guard dashboard?.activeEvent?.id == request.eventId, !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            let result = try await APIClient(settings: settings).checkInClubMemberManually(request)
            return await handle(result, settings: settings, operatorMode: true)
        } catch {
            message = ClubOperatorMessage(title: "Could not check in member", body: error.localizedDescription)
            return false
        }
    }

    func delete(member: ClubMember, settings: ServerSettings) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await APIClient(settings: settings).deleteClubMember(id: member.id)
            await reload(settings: settings, operatorMode: true)
            return true
        } catch {
            message = ClubOperatorMessage(title: "Could not delete profile", body: error.localizedDescription)
            return false
        }
    }

    @discardableResult
    private func handle(_ result: ClubCheckInResponse, settings: ServerSettings, operatorMode: Bool) async -> Bool {
        switch result.status {
        case "registration_required":
            return false
        case "checked_in":
            pendingCard = nil
            message = ClubOperatorMessage(
                title: "Checked in",
                body: result.member?.name ?? "Your attendance was recorded."
            )
            await reload(settings: settings, operatorMode: operatorMode)
            return true
        case "already_checked_in":
            pendingCard = nil
            message = ClubOperatorMessage(
                title: "Already checked in",
                body: result.member?.name ?? "Your attendance was already recorded."
            )
            await reload(settings: settings, operatorMode: operatorMode)
            return true
        case "member_not_found":
            message = ClubOperatorMessage(
                title: "Member not found",
                body: "Refresh the member search and try again."
            )
            return false
        default:
            pendingCard = nil
            message = ClubOperatorMessage(title: "Event unavailable", body: "Start an active event and scan again.")
            await reload(settings: settings, operatorMode: operatorMode)
            return false
        }
    }

    private func reload(settings: ServerSettings, operatorMode: Bool) async {
        do {
            dashboard = try await APIClient(settings: settings).fetchClubDashboard(operatorMode: operatorMode)
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
    @State private var showingManualCheckIn = false
    @State private var showingCloseConfirmation = false

    var body: some View {
        Group {
            if !store.access.clubAccess {
                ContentUnavailableView("Club access required", systemImage: "lock.shield")
            } else {
                List {
                    if model.dashboard == nil && model.isLoading {
                        Section { HStack { Spacer(); ProgressView(); Spacer() } }
                    } else if let event = model.dashboard?.activeEvent {
                        activeEventSection(event)
                        if store.access.level == "developer" { checkInSection(event) }
                    } else if store.access.level == "developer" {
                        Section {
                            Button {
                                showingNewEvent = true
                            } label: {
                                Label("Start club event", systemImage: "calendar.badge.plus")
                            }
                        }
                    } else {
                        Section {
                            ContentUnavailableView(
                                "No active meeting",
                                systemImage: "calendar.badge.clock",
                                description: Text("Check back after a club organizer starts the meeting.")
                            )
                        }
                    }

                    if store.access.level == "developer",
                       let recent = model.dashboard?.recentEvents,
                       !recent.isEmpty {
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
                        Text(store.access.level == "developer"
                            ? "A card scan does not verify Rutgers affiliation or grant university access."
                            : "Scan only your own card. This records meeting attendance and does not verify Rutgers affiliation or grant university access.")
                    }
                }
                .refreshable {
                    await model.load(
                        settings: store.settings,
                        operatorMode: store.access.level == "developer"
                    )
                }
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
        .task {
            await model.load(
                settings: store.settings,
                operatorMode: store.access.level == "developer"
            )
        }
        .sheet(isPresented: $showingNewEvent) {
            NewClubEventView(model: model)
                .environmentObject(store)
        }
        .sheet(item: $model.pendingCard) { card in
            ClubMemberRegistrationView(card: card, model: model)
                .environmentObject(store)
        }
        .sheet(isPresented: $showingManualCheckIn) {
            if let event = model.dashboard?.activeEvent {
                ClubManualCheckInView(event: event, model: model)
                    .environmentObject(store)
            }
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
            if store.access.level == "developer" {
                LabeledContent("Attendance", value: "\(event.checkInCount)")
            }
            Button {
                Task {
                    await model.scan(
                        settings: store.settings,
                        operatorMode: store.access.level == "developer"
                    )
                }
            } label: {
                HStack {
                    Label("Scan member card", systemImage: "wave.3.right")
                    Spacer()
                    if model.isScanning { ProgressView().controlSize(.small) }
                }
            }
            .disabled(model.isScanning || model.isSaving)
            if store.access.level == "developer" {
                Button {
                    showingManualCheckIn = true
                } label: {
                    Label("Sign in without card", systemImage: "person.crop.circle.badge.checkmark")
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

private enum ClubManualCheckInMode: String, CaseIterable, Identifiable {
    case existing = "Existing"
    case newMember = "New"

    var id: Self { self }
}

private struct ClubManualCheckInView: View {
    @EnvironmentObject private var store: MonitorStore
    @Environment(\.dismiss) private var dismiss
    let event: ClubEventDetail
    @ObservedObject var model: ClubCheckInModel
    @State private var mode = ClubManualCheckInMode.existing
    @State private var searchText = ""
    @State private var members: [ClubMember] = []
    @State private var selectedMemberId: String?
    @State private var isSearching = false
    @State private var searchError: String?
    @State private var name = ""
    @State private var age = ""
    @State private var contactType = "phone"
    @State private var contact = ""
    @State private var grade = "first_year"
    @State private var consent = false

    private var checkedInMemberIds: Set<String> {
        Set(event.checkIns.map(\.memberId))
    }

    private var registration: ClubMemberRegistrationRequest? {
        clubRegistrationRequest(
            name: name,
            age: age,
            contactType: contactType,
            contact: contact,
            grade: grade,
            consent: consent
        )
    }

    private var canSubmit: Bool {
        switch mode {
        case .existing:
            guard let selectedMemberId else { return false }
            return !checkedInMemberIds.contains(selectedMemberId)
        case .newMember:
            return registration != nil
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Member type", selection: $mode) {
                        ForEach(ClubManualCheckInMode.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if mode == .existing {
                    existingMemberSections
                } else {
                    ClubMemberRegistrationFields(
                        name: $name,
                        age: $age,
                        contactType: $contactType,
                        contact: $contact,
                        grade: $grade,
                        consent: $consent,
                        footer: "Age and contact information are encrypted and are not copied to Google Sheets. No card identifier is collected for this profile."
                    )
                }
            }
            .navigationTitle("Sign In Without Card")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Check In") {
                        Task { await submit() }
                    }
                    .disabled(!canSubmit || model.isSaving)
                }
            }
            .task(id: mode == .existing ? searchText : nil) {
                guard mode == .existing else { return }
                await searchMembers()
            }
            .onChange(of: mode) { _, newMode in
                guard newMode == .newMember,
                      name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                name = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
    }

    @ViewBuilder
    private var existingMemberSections: some View {
        Section("Find existing member") {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Name, phone, or Instagram", text: $searchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
        }

        Section("Members") {
            if isSearching && members.isEmpty {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if let searchError {
                Label(searchError, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
            } else if members.isEmpty {
                ContentUnavailableView.search(text: searchText)
                if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        name = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                        mode = .newMember
                    } label: {
                        Label("Register new member", systemImage: "person.badge.plus")
                    }
                }
            } else {
                ForEach(members) { member in
                    memberRow(member)
                }
            }
        }
    }

    private func memberRow(_ member: ClubMember) -> some View {
        let isCheckedIn = checkedInMemberIds.contains(member.id)
        let isSelected = selectedMemberId == member.id
        return Button {
            selectedMemberId = member.id
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(member.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("\(gradeLabel(member.grade)) | Age \(member.age)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(member.contact)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if isCheckedIn {
                    Text("Checked in")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                } else if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Selected")
                } else {
                    Image(systemName: "circle")
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isCheckedIn)
    }

    private func searchMembers() async {
        if !searchText.isEmpty {
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch {
                return
            }
        }
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let response = try await APIClient(settings: store.settings).searchClubMembers(query: searchText)
            guard !Task.isCancelled else { return }
            members = response.members
            searchError = nil
            if let selectedMemberId, !members.contains(where: { $0.id == selectedMemberId }) {
                self.selectedMemberId = nil
            }
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            guard !Task.isCancelled else { return }
            members = []
            searchError = error.localizedDescription
        }
    }

    private func submit() async {
        let request: ClubManualCheckInRequest
        switch mode {
        case .existing:
            guard let selectedMemberId else { return }
            request = .existing(eventId: event.id, memberId: selectedMemberId)
        case .newMember:
            guard let registration else { return }
            request = .new(eventId: event.id, registration: registration)
        }
        if await model.checkInWithoutCard(request, settings: store.settings) {
            dismiss()
        }
    }
}

private struct ClubMemberRegistrationFields: View {
    @Binding var name: String
    @Binding var age: String
    @Binding var contactType: String
    @Binding var contact: String
    @Binding var grade: String
    @Binding var consent: Bool
    let footer: String

    var body: some View {
        Group {
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
                Text(footer)
            }
        }
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

    private var registration: ClubMemberRegistrationRequest? {
        clubRegistrationRequest(
            name: name,
            age: age,
            contactType: contactType,
            contact: contact,
            grade: grade,
            consent: consent
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                ClubMemberRegistrationFields(
                    name: $name,
                    age: $age,
                    contactType: $contactType,
                    contact: $contact,
                    grade: $grade,
                    consent: $consent,
                    footer: "Age, contact information, and card data are not copied to Google Sheets. The card identifier is converted to a one-way service fingerprint and is not stored in raw form."
                )
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
                        guard let registration else { return }
                        Task {
                            await model.register(
                                card: card,
                                registration: registration,
                                settings: store.settings,
                                operatorMode: store.access.level == "developer"
                            )
                        }
                    }
                    .disabled(registration == nil || model.isSaving)
                }
            }
        }
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
            Section(member.tagTechnology == "manual" ? "Sign-in" : "Card") {
                if member.tagTechnology == "manual" {
                    LabeledContent("Method", value: "No ID card")
                } else {
                    LabeledContent("Fingerprint", value: member.cardHint)
                    LabeledContent("Technology", value: member.tagTechnology.uppercased())
                }
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

private func clubRegistrationRequest(
    name: String,
    age: String,
    contactType: String,
    contact: String,
    grade: String,
    consent: Bool
) -> ClubMemberRegistrationRequest? {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedContact = contact.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let numericAge = Int(age),
          (13...120).contains(numericAge),
          !normalizedName.isEmpty,
          normalizedContact.count >= 3,
          consent else { return nil }
    return ClubMemberRegistrationRequest(
        name: normalizedName,
        age: numericAge,
        contactType: contactType,
        contact: normalizedContact,
        grade: grade,
        consent: true
    )
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
