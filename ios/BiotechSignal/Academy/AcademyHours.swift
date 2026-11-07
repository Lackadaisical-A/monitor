import SwiftUI
import CoreLocation
import MapKit
import UniformTypeIdentifiers

struct AcademyHoursCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    var data: Data
    init(_ csv: String) { data = Data(csv.utf8) }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
@MainActor final class AcademyHoursLocation: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var pending: CheckedContinuation<AcademyHoursLocationProof, Error>?
    private var timeout: Task<Void, Never>?
    override init() { super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyBest }
    func capture() async throws -> AcademyHoursLocationProof {
        guard pending == nil else { throw AcademyCloud.CloudError("A location check is already running.") }
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(25)) } catch { return }
                self?.finish(.failure(AcademyCloud.CloudError("We could not get an accurate location. Move near the entrance or a window, enable Precise Location, and try again.")))
            }
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
            else { begin() }
        }
    }
    func cancel() { finish(.failure(CancellationError())) }
    private func begin() {
        guard pending != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            guard manager.accuracyAuthorization == .fullAccuracy else { finish(.failure(AcademyCloud.CloudError("Enable Precise Location for Flight Academy in iPhone Settings to clock in."))); return }
            manager.startUpdatingLocation()
        case .denied, .restricted: finish(.failure(AcademyCloud.CloudError("Allow location access while using Flight Academy in iPhone Settings to clock in.")))
        case .notDetermined: break
        @unknown default: finish(.failure(AcademyCloud.CloudError("Location is unavailable. Try again from the academy.")))
        }
    }
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { Task { @MainActor [weak self] in self?.begin() } }
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) { Task { @MainActor [weak self] in self?.accept(locations) } }
    private func accept(_ locations: [CLLocation]) {
        guard pending != nil else { return }
        if locations.last?.sourceInformation?.isSimulatedBySoftware == true { finish(.failure(AcademyCloud.CloudError("Clock-in requires your real iPhone location at the academy. Simulated locations are not accepted."))); return }
        guard let value = locations.last(where: { AcademyHoursLocationProof.isUsable($0) }) else { return }
        finish(.success(.init(latitude: value.coordinate.latitude, longitude: value.coordinate.longitude, accuracy: value.horizontalAccuracy, capturedAt: AcademyHoursTime.milliseconds(value.timestamp), simulated: false, precise: true)))
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return }
        Task { @MainActor [weak self] in self?.finish(.failure(AcademyCloud.CloudError("Location is unavailable. Check location permissions and try again near the academy entrance."))) }
    }
    private func finish(_ result: Result<AcademyHoursLocationProof, Error>) {
        manager.stopUpdatingLocation(); timeout?.cancel(); timeout = nil
        let continuation = pending; pending = nil; continuation?.resume(with: result)
    }
}

@MainActor final class AcademyHoursModel: ObservableObject {
    @Published var report: AcademyHoursReport?
    @Published var loading = false
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    private var generation = UUID()
    private var receivedUptime = ProcessInfo.processInfo.systemUptime
    var serverDate: Date { guard let report else { return Date() }; return Date(timeIntervalSince1970: report.serverNow / 1000).addingTimeInterval(ProcessInfo.processInfo.systemUptime - receivedUptime) }
    func clear() { generation = UUID(); report = nil; error = nil; notice = nil; loading = false }
    private func identity(_ cloud: AcademyCloud) -> String { "\(cloud.origin)|\(cloud.email)|\(cloud.connected)" }
    func load(_ cloud: AcademyCloud, range: DateInterval = AcademyHoursTime.week(), team: Bool = false) async {
        guard cloud.connected else { clear(); return }
        let requestID = UUID(), account = identity(cloud); generation = requestID; loading = true
        defer { if generation == requestID { loading = false } }
        do {
            let value: AcademyHoursReport = try await cloud.request("hours", query: [.init(name: "from", value: String(AcademyHoursTime.milliseconds(range.start))), .init(name: "to", value: String(AcademyHoursTime.milliseconds(range.end))), .init(name: "team", value: team ? "true" : "false")])
            guard generation == requestID, account == identity(cloud), cloud.connected else { return }
            report = value; receivedUptime = ProcessInfo.processInfo.systemUptime
        } catch { if generation == requestID, account == identity(cloud) { self.error = error.localizedDescription } }
    }
    func mutate<T: Encodable>(_ cloud: AcademyCloud, path: String, body: T, method: String = "POST") async throws {
        let account = identity(cloud)
        let saved: AcademyHoursSaved = try await cloud.request(path, method: method, body: JSONEncoder().encode(body))
        guard cloud.connected, account == identity(cloud) else { throw CancellationError() }
        if report != nil {
            report?.serverNow = saved.serverNow; receivedUptime = ProcessInfo.processInfo.systemUptime
            if saved.shift.account == report?.account { report?.activeShift = saved.shift.endedAt == nil ? saved.shift : nil }
            report?.shifts.removeAll { $0.id == saved.shift.id }
            if let report, saved.shift.startedAt < report.to && (saved.shift.endedAt ?? .infinity) > report.from { self.report?.shifts.insert(saved.shift, at: 0) }
        }
    }
}

struct AcademyHoursCard: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var cloud: AcademyCloud
    @EnvironmentObject private var hours: AcademyHoursModel
    var body: some View {
        NavigationLink { AcademyHoursView() } label: {
            AcademyPanel { HStack(spacing: 16) {
                Image(systemName: hours.report?.activeShift != nil && !store.isDemo ? "clock.badge.checkmark" : "clock").font(.system(size: 26, weight: .light)).frame(width: 46, height: 46).background(AcademyTheme.gold.opacity(0.22), in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 5) {
                    Text("My hours").font(AcademyTheme.display(21))
                    if let shift = hours.report?.activeShift, !store.isDemo, cloud.connected { Text("Clocked in since \(AcademyHoursTime.time(shift.start))").font(.subheadline).foregroundStyle(AcademyTheme.blue) }
                    else { Text("Clock in at the academy. Keep every hour.").font(.subheadline).foregroundStyle(AcademyTheme.muted) }
                }
                Spacer(minLength: 0); Image(systemName: "arrow.up.right").font(.subheadline)
            } }
        }.buttonStyle(.plain)
        .task(id: "\(store.isDemo)|\(cloud.connected)|\(cloud.email)") { if !store.isDemo && cloud.connected { await hours.load(cloud) } }
    }
}

struct AcademyHoursView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var cloud: AcademyCloud
    @EnvironmentObject private var hours: AcademyHoursModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var location = AcademyHoursLocation()
    @State private var weekOffset = 0
    @State private var team = false
    @State private var showSignIn = false
    @State private var showSite = false
    @State private var showManual = false
    @State private var editing: AcademyHoursShift?
    @State private var confirmOut = false
    @State private var pendingClockIn = UUID()
    @State private var exporting = false
    @State private var csvDocument: AcademyHoursCSVDocument?
    private var range: DateInterval { AcademyHoursTime.week(offset: weekOffset) }
    private var canUse: Bool { cloud.connected && !store.isDemo }
    private var taskID: String { "\(canUse)|\(cloud.email)|\(weekOffset)|\(team)" }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Your time at the academy"); Text("Show up. Make an impact.").font(AcademyTheme.display(29)); Text("A clear record of your teaching hours.").foregroundStyle(AcademyTheme.muted) }
                if !canUse {
                    AcademyPanel { VStack(alignment: .leading, spacing: 14) {
                        Label(store.isDemo ? "Hours are for your staff account" : "Sign in to log your hours", systemImage: "person.crop.circle.badge.checkmark").font(.headline)
                        Text(store.isDemo ? "Switch to the academy workspace, then use your instructor access code or NFC card. Demo mode never records work hours." : "Use your individual instructor access code or NFC card. Your shifts are saved in the shared academy service.").font(.subheadline).foregroundStyle(AcademyTheme.muted)
                        if !store.isDemo { Button("Open instructor sign-in") { showSignIn = true }.buttonStyle(AcademyPrimaryButton()) }
                    } }
                } else if let report = hours.report {
                    clockPanel(report)
                    history(report)
                    locationPanel(report)
                } else if hours.loading { ProgressView("Loading your hours…").frame(maxWidth: .infinity).padding(30) }
                else { Button("Load my hours") { Task { await refresh() } }.buttonStyle(AcademyPrimaryButton()) }
                if let notice = hours.notice, canUse { Label(notice, systemImage: "checkmark.circle.fill").font(.subheadline).foregroundStyle(AcademyTheme.blue) }
                if let error = hours.error, canUse {
                    AcademyPanel { VStack(alignment: .leading, spacing: 12) { Label("Could not complete that request", systemImage: "exclamationmark.circle").font(.headline); Text(error).font(.subheadline); Button("Refresh hours") { Task { await refresh() } }; Link("iPhone location settings", destination: URL(string: UIApplication.openSettingsURLString)!) }.foregroundStyle(AcademyTheme.navy) }
                }
            }.padding(22)
        }.background(AcademyTheme.paper).navigationTitle("Instructor hours").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
        .task(id: taskID) { await refresh() }
        .refreshable { await refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active && canUse { Task { await refresh() } } }
        .onDisappear { location.cancel() }
        .sheet(isPresented: $showSignIn) { NavigationStack { AcademyCloudView() } }
        .sheet(isPresented: $showSite) { if let site = hours.report?.site { AcademyHoursSiteEditor(site: site) { Task { await refresh() } } } }
        .sheet(item: $editing) { shift in AcademyHoursEditor(shift: shift, accounts: hours.report?.staff ?? []) { Task { await refresh() } } }
        .sheet(isPresented: $showManual) { AcademyHoursEditor(shift: nil, accounts: hours.report?.staff ?? []) { Task { await refresh() } } }
        .fileExporter(isPresented: $exporting, document: csvDocument, contentType: .commaSeparatedText, defaultFilename: "Academy-Hours-\(AcademyHoursTime.date(range.start))") { result in if case .failure(let error) = result { hours.error = error.localizedDescription } }
        .confirmationDialog("Clock out now?", isPresented: $confirmOut, titleVisibility: .visible) { Button("Clock out") { Task { await clockOut() } }; Button("Cancel", role: .cancel) {} } message: { Text("Your shift will end when the academy server receives this request. You can clock out from anywhere.") }
    }
    private func clockPanel(_ report: AcademyHoursReport) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Label(report.activeShift == nil ? "READY WHEN YOU ARE" : "ON THE CLOCK", systemImage: report.activeShift == nil ? "location.circle" : "checkmark.circle.fill").font(.caption.monospaced().weight(.semibold)); Spacer(); Text(report.account.capitalized).font(.caption) }
            if let shift = report.activeShift {
                TimelineView(.periodic(from: .now, by: 1)) { _ in Text(AcademyHoursTime.duration(hours.serverDate.timeIntervalSince(shift.start))).font(AcademyTheme.display(42)).monospacedDigit() }
                Text("Started \(AcademyHoursTime.date(shift.start)) at \(AcademyHoursTime.time(shift.start))").font(.subheadline)
                if hours.serverDate.timeIntervalSince(shift.start) > 16 * 3600 { Label("This shift has been open for over 16 hours. Clock out, then ask an administrator to correct the end time if needed.", systemImage: "exclamationmark.circle").font(.caption) }
                Button { confirmOut = true } label: { Label(hours.busy ? "Saving…" : "Clock out", systemImage: "stop.circle") }.buttonStyle(AcademyPrimaryButton(gold: true)).disabled(hours.busy || hours.loading)
            } else {
                Text("Make today count.").font(AcademyTheme.display(28))
                Text("Be within \(report.site.radiusFeet) feet of the academy entrance to start your shift.").font(.subheadline).foregroundStyle(.white.opacity(0.85))
                Button { Task { await clockIn() } } label: { Label(hours.busy ? "Checking location & saving…" : "Check in & start hours", systemImage: "location.fill") }.buttonStyle(AcademyPrimaryButton(gold: true)).disabled(hours.busy || hours.loading)
            }
            Text("Online confirmation required · Saved to the academy").font(.caption2).foregroundStyle(.white.opacity(0.75))
        }.padding(24).foregroundStyle(.white).background(AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 24))
    }
    private func history(_ report: AcademyHoursReport) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if report.role == "admin" { Picker("Hours scope", selection: $team) { Text("My hours").tag(false); Text("Team hours").tag(true) }.pickerStyle(.segmented).disabled(hours.busy) }
            HStack {
                Button { weekOffset -= 1 } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.accessibilityLabel("Previous week")
                Spacer(); VStack(spacing: 4) { Text(weekOffset == 0 ? "This week" : "Week of \(AcademyHoursTime.date(range.start))").font(AcademyTheme.display(18)); Text("Monday–Sunday · New York time").font(.caption2).foregroundStyle(AcademyTheme.muted) }; Spacer()
                Button { weekOffset += 1 } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.disabled(weekOffset >= 0).accessibilityLabel("Next week")
            }.disabled(hours.busy)
            if hours.loading { ProgressView("Updating hours…") }
            else if report.team == team, Int64(report.from) == AcademyHoursTime.milliseconds(range.start), Int64(report.to) == AcademyHoursTime.milliseconds(range.end) {
                AcademyPanel { VStack(alignment: .leading, spacing: 8) {
                    Text(AcademyHoursTime.duration(report.shifts.reduce(0) { $0 + $1.completedSeconds(in: range) })).font(AcademyTheme.display(32))
                    Text("Completed hours\(team ? " · entire team" : "")").font(.subheadline).foregroundStyle(AcademyTheme.muted)
                    Text("Open shifts are shown separately. Shifts crossing weeks count only the time in this week.").font(.caption).foregroundStyle(AcademyTheme.muted)
                } }
                if team { ForEach(report.staff, id: \.self) { account in HStack { Text(account.capitalized); Spacer(); Text(AcademyHoursTime.duration(report.shifts.filter { $0.account == account }.reduce(0) { $0 + $1.completedSeconds(in: range) })).monospacedDigit() }.font(.subheadline) } }
                if report.shifts.isEmpty { AcademyEmpty(symbol: "clock", title: "A fresh page for your time.", message: "Your shifts appear here after you clock in.") }
                ForEach(report.shifts) { shift in shiftRow(shift, admin: report.role == "admin") }
                if !report.shifts.isEmpty { Button { csvDocument = AcademyHoursCSVDocument(AcademyHoursTime.csv(report)); exporting = true } label: { Label("Export this week’s hours", systemImage: "square.and.arrow.up") }.font(.subheadline.weight(.semibold)) }
            }
            if report.role == "admin", team { Button { showManual = true } label: { Label("Add a missed shift", systemImage: "plus.circle") }.disabled(hours.busy || hours.loading || !report.team) }
        }
    }
    private func shiftRow(_ shift: AcademyHoursShift, admin: Bool) -> some View {
        AcademyPanel { VStack(alignment: .leading, spacing: 10) {
            HStack { Text(AcademyHoursTime.date(shift.start)).font(.headline); Spacer(); AcademyPill(text: shift.end == nil ? "Open" : AcademyHoursTime.duration(shift.completedSeconds(in: range))) }
            if team { Text(shift.account.capitalized).font(.subheadline.weight(.semibold)) }
            Text("\(AcademyHoursTime.time(shift.start)) → \(shift.end.map { AcademyHoursTime.date($0) + " · " + AcademyHoursTime.time($0) } ?? "Still clocked in")").font(.subheadline).foregroundStyle(AcademyTheme.muted)
            Label(shift.check == nil ? "Added by an administrator" : "Location checked at clock-in", systemImage: shift.check == nil ? "pencil.circle" : "location.circle").font(.caption).foregroundStyle(AcademyTheme.blue)
            if let reason = shift.manualReason { Text(reason).font(.caption) }
            if !shift.adjustments.isEmpty { DisclosureGroup("Change history (\(shift.adjustments.count))") { ForEach(Array(shift.adjustments.enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 4) { Text(item.reason); Text("\(item.actor.capitalized) · \(AcademyHoursTime.date(Date(timeIntervalSince1970: item.at / 1000)))").foregroundStyle(AcademyTheme.muted) }.font(.caption).padding(.vertical, 4) } }.font(.caption) }
            if admin { Button("Correct this shift") { editing = shift }.font(.caption.weight(.semibold)).disabled(hours.busy) }
        } }
    }
    private func locationPanel(_ report: AcademyHoursReport) -> some View {
        AcademyPanel { VStack(alignment: .leading, spacing: 14) {
            Label("The academy entrance", systemImage: "mappin.and.ellipse").font(.headline)
            AcademyHoursMap(site: report.site)
            Text(report.site.address).font(.subheadline)
            Text("\(report.site.radiusFeet)-foot clock-in radius. Location is checked only when you tap to clock in or verify the entrance pin. Your route and background location are never tracked.").font(.caption).foregroundStyle(AcademyTheme.muted)
            Text("A weak indoor GPS signal may need a retry near a window. Contact an administrator if a missed check-in needs to be recorded.").font(.caption).foregroundStyle(AcademyTheme.muted)
            if report.role == "admin" { Button("Verify entrance pin & radius") { showSite = true }.font(.subheadline.weight(.semibold)).disabled(hours.busy) }
        } }
    }
    private func refresh() async { guard canUse else { return }; hours.error = nil; await hours.load(cloud, range: range, team: team) }
    private func clockIn() async {
        guard canUse, !hours.busy else { return }; hours.busy = true; hours.error = nil; hours.notice = nil; defer { hours.busy = false }
        let accountAtStart = cloud.email
        do {
            let proof = try await location.capture(); guard canUse, cloud.email == accountAtStart else { return }
            struct Input: Encodable { var operation: UUID; var location: AcademyHoursLocationProof }
            try await hours.mutate(cloud, path: "hours/clock-in", body: Input(operation: pendingClockIn, location: proof)); pendingClockIn = UUID(); hours.notice = hours.report?.activeShift != nil ? "Clock-in saved. Your hours are running." : "Your previous check-in was already saved and that shift is now closed."; await refresh()
        } catch is CancellationError {} catch { hours.error = error.localizedDescription; await hours.load(cloud, range: range, team: team) }
    }
    private func clockOut() async {
        guard canUse, !hours.busy, let shift = hours.report?.activeShift else { return }; hours.busy = true; hours.error = nil; hours.notice = nil; defer { hours.busy = false }
        do { struct Input: Encodable { var operation = UUID(); var shiftID: String }; try await hours.mutate(cloud, path: "hours/clock-out", body: Input(shiftID: shift.id)); hours.notice = "Clock-out saved. Thank you for teaching today."; await refresh() }
        catch { hours.error = error.localizedDescription; await hours.load(cloud, range: range, team: team) }
    }
}

struct AcademyHoursMap: View {
    var site: AcademyHoursSite
    var body: some View {
        Map(initialPosition: .region(.init(center: site.coordinate, span: .init(latitudeDelta: 0.002, longitudeDelta: 0.002))), interactionModes: []) {
            MapCircle(center: site.coordinate, radius: Double(site.radiusFeet) * 0.3048).foregroundStyle(AcademyTheme.blue.opacity(0.2)).stroke(AcademyTheme.blue, lineWidth: 2)
            Marker("Academy entrance", coordinate: site.coordinate).tint(AcademyTheme.navy)
        }.frame(height: 190).clipShape(RoundedRectangle(cornerRadius: 14)).id(site.revision).accessibilityLabel("Academy entrance at 118 Ferry Street, with a \(site.radiusFeet)-foot check-in radius")
    }
}

struct AcademyHoursSiteEditor: View {
    @EnvironmentObject private var cloud: AcademyCloud
    @Environment(\.dismiss) private var dismiss
    @StateObject private var location = AcademyHoursLocation()
    let site: AcademyHoursSite
    var saved: () -> Void
    @State private var radius = 100
    @State private var busy = false
    @State private var confirm = false
    @State private var error: String?
    var body: some View {
        NavigationStack { Form {
            Section { AcademyHoursMap(site: site); Text(site.address); Text("Stand at the academy entrance, then save your current location as the pin. This updates the check-in area for every instructor.").font(.subheadline) }
            Section("Clock-in radius") { Picker("Distance", selection: $radius) { Text("100 feet").tag(100); Text("150 feet").tag(150); Text("200 feet").tag(200) }.pickerStyle(.segmented) }
            Section { Button(busy ? "Verifying entrance…" : "Use my location as the entrance") { confirm = true }.disabled(busy); Text("An accurate location within 200 feet of the street-address pin is required. Changes are recorded for administrator review.").font(.caption) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }.navigationTitle("Academy entrance").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) } }
        .onAppear { radius = site.radiusFeet }
        .confirmationDialog("Update the academy entrance for all instructors?", isPresented: $confirm, titleVisibility: .visible) { Button("Verify & save entrance") { Task { await save() } } }
        .interactiveDismissDisabled(busy).onDisappear { location.cancel() } }
    }
    private func save() async {
        busy = true; error = nil; defer { busy = false }
        do {
            struct Input: Encodable { var revision: Int; var radiusFeet: Int; var location: AcademyHoursLocationProof }
            struct Response: Decodable { var site: AcademyHoursSite }
            let proof = try await location.capture()
            let _: Response = try await cloud.request("hours/site", method: "PUT", body: JSONEncoder().encode(Input(revision: site.revision, radiusFeet: radius, location: proof)))
            saved(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct AcademyHoursEditor: View {
    @EnvironmentObject private var cloud: AcademyCloud
    @EnvironmentObject private var hours: AcademyHoursModel
    @Environment(\.dismiss) private var dismiss
    let shift: AcademyHoursShift?
    let accounts: [String]
    var saved: () -> Void
    @State private var account = ""
    @State private var start = Date().addingTimeInterval(-3600)
    @State private var end = Date()
    @State private var reason = ""
    @State private var busy = false
    @State private var error: String?
    @State private var operation = UUID()
    var body: some View {
        NavigationStack { Form {
            Section("Instructor") {
                if let shift { Text(shift.account.capitalized) }
                else { Picker("Instructor", selection: $account) { ForEach(accounts, id: \.self) { Text($0.capitalized).tag($0) } } }
            }
            Section("Shift · New York time") { DatePicker("Start", selection: $start, in: ...Date()); DatePicker("End", selection: $end, in: ...Date()) }
            Section("Reason required") { TextField("What needs to be recorded or corrected?", text: $reason, axis: .vertical).lineLimit(3...6); Text("Your name, reason, and the previous times remain in the record. Manual entries are clearly labeled and are not location-verified.").font(.caption) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }.environment(\.timeZone, AcademyHoursTime.calendar.timeZone).navigationTitle(shift == nil ? "Add missed shift" : "Correct shift").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }; ToolbarItem(placement: .confirmationAction) { Button(busy ? "Saving…" : "Save") { Task { await save() } }.disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || reason.count > 500 || start >= end || account.isEmpty) } }
        .onAppear { account = shift?.account ?? accounts.first ?? ""; if let shift { start = shift.start; end = shift.end ?? Date() } }
        .interactiveDismissDisabled(busy) }
    }
    private func save() async {
        busy = true; error = nil; defer { busy = false }
        do {
            struct Input: Encodable { var operation: UUID; var startedAt: Int64; var endedAt: Int64; var reason: String; var version: Int?; var account: String? }
            let input = Input(operation: operation, startedAt: AcademyHoursTime.milliseconds(start), endedAt: AcademyHoursTime.milliseconds(end), reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), version: shift?.version, account: shift == nil ? account : nil)
            try await hours.mutate(cloud, path: shift.map { "hours/shifts/\($0.id)/correct" } ?? "hours/manual", body: input)
            saved(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
