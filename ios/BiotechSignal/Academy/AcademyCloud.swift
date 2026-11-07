import SwiftUI
import AuthenticationServices
import CryptoKit

struct AcademyCloudState: Codable {
    var revision = 0
    var snapshot: AcademyBackup?
}
struct AcademyCloudResponse: Codable { var revision: Int; var snapshot: AcademyBackup?; var email: String?; var role: String? }
struct AcademyCloudLogin: Codable { var token: String; var email: String; var role: String; var expires: Double }
struct AcademyStaffCard: Codable, Identifiable { var id: String; var account: String; var createdAt: Double }

@MainActor final class AcademyCloud: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var origin = UserDefaults.standard.string(forKey: "academy-cloud-origin") ?? "https://catalyst-watch.onrender.com"
    @Published private(set) var email = ""
    @Published private(set) var role = ""
    @Published private(set) var status = "Shared workspace is not connected"
    @Published private(set) var busy = false
    @Published var error: String?
    @Published var conflict: AcademyCloudResponse?
    @Published private(set) var cards: [AcademyStaffCard] = []
    private var auth: ASWebAuthenticationSession?
    private var baseline = AcademyCloudState()
    private var token = ""
    private var configuredOrigin = ""
    var connected: Bool { !token.isEmpty }
    private var account: String { "academy-staff-" + SHA256.hash(data: Data(configuredOrigin.utf8)).map { String(format: "%02x", $0) }.joined() }
    private var stateURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FlightAcademy/cloud-\(SHA256.hash(data: Data(configuredOrigin.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()).json")
    }
    override init() { super.init(); configureSaved() }
    private func configureSaved() {
        configuredOrigin = origin
        token = KeychainStore.read(account: account)
        if !token.isEmpty {
            do { if FileManager.default.fileExists(atPath: stateURL.path) { baseline = try JSONDecoder().decode(AcademyCloudState.self, from: Data(contentsOf: stateURL)) }; status = "Ready to sync" }
            catch { self.error = "The sync history could not be read. Local records are unchanged."; token = "" }
        }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    private func endpoint(_ path: String) throws -> URL {
        guard let url = URL(string: configuredOrigin), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw CloudError("Enter the academy's HTTPS server address.") }
        return url.appendingPathComponent("api/academy/v1/\(path)")
    }
    func signIn() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            configuredOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
            let verifier = try KeychainStore.randomHex()
            let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            var url = URLComponents(url: try endpoint("auth/start"), resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
            let callback: URL = try await withCheckedThrowingContinuation { continuation in
                auth = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "flightacademy") { callback, error in
                    if let callback { continuation.resume(returning: callback) } else { continuation.resume(throwing: error ?? CloudError("Sign-in was cancelled.")) }
                }
                auth?.presentationContextProvider = self
                auth?.prefersEphemeralWebBrowserSession = true
                if auth?.start() != true { continuation.resume(throwing: CloudError("Could not open Google sign-in.")) }
            }
            guard callback.host == "auth", let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value else { throw CloudError("Invalid sign-in response.") }
            let response: AcademyCloudLogin = try await request("auth/complete", method: "POST", body: JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier]))
            try accept(response)
        } catch { self.error = error.localizedDescription }
    }
    private func accept(_ response: AcademyCloudLogin) throws {
        try KeychainStore.save(response.token, account: account)
        origin = configuredOrigin; UserDefaults.standard.set(origin, forKey: "academy-cloud-origin")
        baseline = AcademyCloudState(); configureSaved()
        email = response.email; role = response.role; status = "Signed in · sync to open the shared workspace"
    }
    func signIn(account: String, code: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            configuredOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
            let response: AcademyCloudLogin = try await request("auth/code", method: "POST", body: JSONSerialization.data(withJSONObject: ["account": account, "code": code]))
            try accept(response)
        } catch { self.error = error.localizedDescription }
    }
    func tapSignIn() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            configuredOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
            let credential = try await AcademyInstructorCardReader.shared.read()
            let response: AcademyCloudLogin = try await request("auth/card", method: "POST", body: JSONSerialization.data(withJSONObject: ["token": credential]))
            try accept(response)
        } catch ClubCardReaderError.cancelled {} catch { self.error = error.localizedDescription }
    }
    func loadCards() async {
        guard connected else { return }
        do { struct Response: Decodable { var cards: [AcademyStaffCard] }; let result: Response = try await request("auth/cards"); cards = result.cards }
        catch { self.error = error.localizedDescription }
    }
    func linkInstructorCard(store: AcademyStore) async {
        guard connected, !busy, !store.isDemo else { return }; busy = true; defer { busy = false }
        var pendingID: String?
        do {
            try await store.authorizeInstructor()
            struct Pending: Decodable { var id: String; var token: String }
            let pending: Pending = try await request("auth/cards", method: "POST")
            pendingID = pending.id
            try await AcademyInstructorCardReader.shared.write(pending.token)
            let _: [String: Bool] = try await request("auth/cards/\(pending.id)/activate", method: "POST")
            pendingID = nil; status = "Instructor card linked · previous card revoked"
            await loadCards()
        } catch ClubCardReaderError.cancelled {} catch { self.error = error.localizedDescription }
        if let pendingID { let _: [String: Bool]? = try? await request("auth/cards/\(pendingID)", method: "DELETE") }
    }
    func revokeCard(_ card: AcademyStaffCard) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { let _: [String: Bool] = try await request("auth/cards/\(card.id)", method: "DELETE"); cards.removeAll { $0.id == card.id }; status = "Instructor card revoked" }
        catch { self.error = error.localizedDescription }
    }
    func signOut() async {
        do {
            let _: [String: Bool] = try await request("auth/logout", method: "POST")
            try KeychainStore.save("", account: account)
            token = ""; email = ""; role = ""; cards = []; status = "Signed out · local records kept"
        } catch { self.error = error.localizedDescription }
    }
    struct CloudError: LocalizedError { var message: String; init(_ message: String) { self.message = message }; var errorDescription: String? { message } }
    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = []) async throws -> T {
        var components = URLComponents(url: try endpoint(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var req = URLRequest(url: components.url!); req.httpMethod = method; req.httpBody = body; req.timeoutInterval = 25
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw CloudError("The server did not respond.") }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401, path != "auth/code", path != "auth/card" {
                try? KeychainStore.save("", account: account); token = ""; email = ""; role = ""; cards = []
                status = "Sign-in expired · local changes are kept"
            }
            if http.statusCode == 409, path == "workspace" { throw CloudError("Another instructor just updated this workspace. Sync again to merge or review the changes.") }
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = object?["message"] as? String ?? object?["error"] as? String
            throw CloudError(message ?? "The shared service returned \(http.statusCode). Local records are unchanged.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private func snapshot(_ store: AcademyStore, _ teaching: AcademyTeachingStore) -> AcademyBackup {
        var result = AcademyBackup(workspace: store.workspace, teaching: teaching.state)
        result.workspace.instructor = "" // Staff identity is local/authenticated, never another device's setting.
        return result
    }
    func photo(_ id: UUID) async throws -> Data {
        guard connected else { throw CloudError("Sign in to download this photo.") }
        struct Photo: Decodable { var data: Data }
        let value: Photo = try await request("photos/\(id.uuidString)")
        return value.data
    }
    private func uploadPhotos(_ snapshot: AcademyBackup) async throws {
        struct Item: Encodable { var id: UUID; var studentID: UUID }
        struct Check: Encodable { var photos: [Item] }
        struct Present: Decodable { var present: [UUID] }
        var seen = Set<UUID>()
        let items = (snapshot.teaching.classLogs ?? []).flatMap { entry in entry.photoIDs.filter { seen.insert($0).inserted }.map { Item(id: $0, studentID: entry.studentID) } }
        guard !items.isEmpty else { return }
        let inventory: Present = try await request("photos/check", method: "POST", body: JSONEncoder().encode(Check(photos: items)))
        let present = Set(inventory.present)
        for item in items where !present.contains(item.id) {
            guard let data = AcademyPhotos.data(item.id, demo: false) else { throw CloudError("A photo has not reached the shared workspace. Sync the iPhone where it was taken first, or remove the missing photo from the update.") }
            struct Upload: Encodable { var id: UUID; var studentID: UUID; var data: Data }
            status = "Uploading class photos…"
            let _: [String: Bool] = try await request("photos", method: "POST", body: JSONEncoder().encode(Upload(id: item.id, studentID: item.studentID, data: data)))
        }
    }
    func familyLinkActive(_ id: UUID) async throws -> Bool {
        struct Status: Decodable { var active: Bool }
        let result: Status = try await request("students/\(id.uuidString)/family-link"); return result.active
    }
    func createFamilyLink(_ id: UUID) async throws -> URL {
        struct Link: Decodable { var url: URL }
        let result: Link = try await request("students/\(id.uuidString)/family-link", method: "POST"); return result.url
    }
    func revokeFamilyLink(_ id: UUID) async throws {
        let _: [String: Bool] = try await request("students/\(id.uuidString)/family-link", method: "DELETE")
    }
    func sync(store: AcademyStore, teaching: AcademyTeachingStore) async {
        guard connected, !store.isDemo, !busy, conflict == nil else { return }
        guard store.storageHealthy, teaching.healthy else { error = "Restore local storage before syncing."; return }
        busy = true; status = "Syncing…"; defer { busy = false }
        do {
            let remote: AcademyCloudResponse = try await request("workspace")
            email = remote.email ?? email; role = remote.role ?? role
            let local = snapshot(store, teaching)
            var merged = local
            if let shared = remote.snapshot {
                do {
                    if baseline.snapshot == nil, local.workspace.students.isEmpty, local.workspace.progress.isEmpty, local.workspace.log.isEmpty,
                       local.teaching == TeachingState(), local.workspace.curriculum == shared.workspace.curriculum {
                        merged = shared
                    } else {
                        let result = try AcademyMerge.combine(base: baseline.snapshot.map { try JSONEncoder().encode($0) }, local: JSONEncoder().encode(local), remote: JSONEncoder().encode(shared))
                        merged = try AcademyBackup.decode(result)
                    }
                } catch is AcademyMerge.Conflict { conflict = remote; status = "Review conflicting edits"; return }
            } else if role != "admin" { throw CloudError("An academy administrator must import the first roster.") }
            try merged.validate()
            if merged != local { try merged.apply(store: store, teaching: teaching, retainBindings: true) }
            // Freeze this upload. Edits made while the request runs remain local
            // differences against this exact baseline for the next sync.
            let uploaded = snapshot(store, teaching)
            try await uploadPhotos(uploaded)
            let nextRevision: Int
            if uploaded == remote.snapshot { nextRevision = remote.revision }
            else {
                struct Upload: Encodable { var revision: Int; var operation: UUID; var snapshot: AcademyBackup }
                struct Saved: Decodable { var revision: Int }
                let saved: Saved = try await request("workspace", method: "PUT", body: JSONEncoder().encode(Upload(revision: remote.revision, operation: UUID(), snapshot: uploaded)))
                nextRevision = saved.revision
            }
            baseline = AcademyCloudState(revision: nextRevision, snapshot: uploaded)
            try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(baseline).write(to: stateURL, options: [.atomic, .completeFileProtection])
            status = "Synced \(Date().formatted(date: .omitted, time: .shortened))"
            if !email.isEmpty, store.workspace.instructor != email { try store.update { $0.instructor = email } }
        } catch { status = "Saved on this iPhone · sync pending"; self.error = error.localizedDescription }
    }
    func useShared(store: AcademyStore, teaching: AcademyTeachingStore) throws {
        guard let remote = conflict, let shared = remote.snapshot else { return }
        try shared.apply(store: store, teaching: teaching, retainBindings: true)
        baseline = AcademyCloudState(revision: remote.revision, snapshot: shared)
        try JSONEncoder().encode(baseline).write(to: stateURL, options: [.atomic, .completeFileProtection])
        conflict = nil; status = "Shared version restored · prior local records saved in recovery backup"
    }
    func retryLocalAfterReview() { baseline = AcademyCloudState(revision: conflict?.revision ?? 0, snapshot: conflict?.snapshot); conflict = nil; status = "Local version selected · tap Sync to publish" }
    func link(_ scan: ClubCardScan, studentID: UUID) async throws {
        let _: [String: Bool] = try await request("passports/link", method: "POST", body: JSONSerialization.data(withJSONObject: ["technology": scan.technology, "identifier": scan.identifier, "studentID": studentID.uuidString]))
    }
    func identify(_ scan: ClubCardScan) async throws -> UUID {
        struct Found: Decodable { var studentID: UUID }
        let found: Found = try await request("passports/identify", method: "POST", body: JSONSerialization.data(withJSONObject: ["technology": scan.technology, "identifier": scan.identifier])); return found.studentID
    }
}

struct AcademyCloudView: View {
    @EnvironmentObject private var cloud: AcademyCloud
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @State private var confirmLocal = false
    @State private var confirmShared = false
    @State private var exporting = false
    @State private var document: AcademyDocument?
    @State private var instructorID = ""
    @State private var accessCode = ""
    @State private var revoke: AcademyStaffCard?
    @State private var confirmLink = false
    var body: some View {
        Form { accountSection; cardSection; conflictSection }
            .navigationTitle("Shared workspace").toolbar(.visible, for: .navigationBar)
            .task { await cloud.loadCards() }
            .confirmationDialog("Link a new instructor card?", isPresented: $confirmLink) {
                Button("Write blank NFC tag") { Task { await cloud.linkInstructorCard(store: store) } }
            } message: { Text("Use a blank, writable NDEF tag. A successful setup replaces your previous instructor card. Keep the card private; it grants access to academy records.") }
            .confirmationDialog("Revoke this instructor card?", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
                if let card = revoke { Button("Revoke \(card.account)'s card", role: .destructive) { Task { await cloud.revokeCard(card); revoke = nil } } }
            } message: { Text("This card and sessions opened with it will stop working. The instructor can still use their access code.") }
            .confirmationDialog("Replace local records with the shared version?", isPresented: $confirmShared) {
                Button("Use shared version") { do { try cloud.useShared(store: store, teaching: teaching) } catch { cloud.error = error.localizedDescription } }
            }
            .confirmationDialog("Replace shared records on the next sync?", isPresented: $confirmLocal) {
                Button("Keep this iPhone's version") { cloud.retryLocalAfterReview() }
            } message: { Text("Changes unique to the shared version will be replaced. Export both copies first if you need to reconcile them manually.") }
            .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "Academy-Conflict-Backup") { result in
                if case .failure(let error) = result { cloud.error = error.localizedDescription }
            }
            .alert("Shared workspace", isPresented: Binding(get: { cloud.error != nil }, set: { if !$0 { cloud.error = nil } })) { Button("OK") { cloud.error = nil } } message: { Text(cloud.error ?? "") }
    }
    private var accountSection: some View {
        Section {
            Label(cloud.status, systemImage: cloud.connected ? "icloud" : "icloud.slash")
            if !cloud.email.isEmpty { LabeledContent("Account", value: cloud.email); LabeledContent("Role", value: cloud.role.capitalized) }
            if cloud.connected {
                Button("Sync now") { Task { await cloud.sync(store: store, teaching: teaching) } }.disabled(cloud.busy || store.isDemo || cloud.conflict != nil)
                Button("Sign out") { Task { await cloud.signOut() } }.disabled(cloud.busy)
            } else {
                if store.isDemo {
                    Button("Open academy workspace") { do { try store.switchWorkspace() } catch { cloud.error = error.localizedDescription } }
                } else {
                    Label("Your academy, connected.", systemImage: "building.2.crop.circle").font(AcademyTheme.display(22))
                    TextField("Instructor ID", text: $instructorID).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Private access code", text: $accessCode).textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Sign in with access code") { Task { await cloud.signIn(account: instructorID, code: accessCode); if cloud.connected { accessCode = ""; await cloud.sync(store: store, teaching: teaching); await cloud.loadCards() } } }.disabled(cloud.busy || instructorID.isEmpty || accessCode.isEmpty)
                    Button { Task { await cloud.tapSignIn(); if cloud.connected { await cloud.sync(store: store, teaching: teaching); await cloud.loadCards() } } } label: { Label("Tap instructor card", systemImage: "wave.3.right.circle.fill") }.disabled(cloud.busy)
                    DisclosureGroup("Server settings") {
                        TextField("Academy server address", text: $cloud.origin).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Use configured Google sign-in") { Task { await cloud.signIn(); if cloud.connected { await cloud.sync(store: store, teaching: teaching) } } }.disabled(cloud.busy)
                    }
                }
            }
            if cloud.busy { ProgressView() }
        } header: { Text("Instructor workspace") } footer: {
            Text(store.isDemo ? "Switch to the academy workspace to sign in. Demo records are never uploaded." : "Only accounts approved by the academy can access shared student records. Offline changes stay on this iPhone until the next successful sync.")
        }
    }
    @ViewBuilder private var cardSection: some View {
        if cloud.connected, !store.isDemo {
            Section {
                Button { confirmLink = true } label: { Label("Link my instructor card", systemImage: "wave.3.right") }.disabled(cloud.busy)
                ForEach(cloud.cards) { card in
                    HStack { Label(card.account.capitalized, systemImage: "person.crop.rectangle"); Spacer(); Button("Revoke", role: .destructive) { revoke = card }.disabled(cloud.busy) }
                }
            } header: { Text("Instructor cards") } footer: { Text("Sign in with your access code before linking a card. Administrators can revoke lost cards for any instructor. Student passports do not grant instructor access.") }
        }
    }
    @ViewBuilder private var conflictSection: some View {
        if let conflict = cloud.conflict, let shared = conflict.snapshot {
            Section("Review conflicting changes") {
                Text("Both copies contain edits to the same record. Export each copy for comparison before choosing. The complete previous local copy is kept when you restore the shared version.")
                LabeledContent("This iPhone", value: "\(store.workspace.students.count) students · \(teaching.state.evidence.count) observations")
                LabeledContent("Shared", value: "\(shared.workspace.students.count) students · \(shared.teaching.evidence.count) observations")
                Button("Export this iPhone's copy") { export(AcademyBackup(workspace: store.workspace, teaching: teaching.state)) }
                Button("Export shared copy") { export(shared) }
                Button("Use shared version") { confirmShared = true }
                Button("Use this iPhone's version") { confirmLocal = true }
            }
        }
    }
    private func export(_ backup: AcademyBackup) { do { document = AcademyDocument(data: try JSONEncoder().encode(backup)); exporting = true } catch { cloud.error = error.localizedDescription } }
}
