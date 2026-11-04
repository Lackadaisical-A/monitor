import SwiftUI
import PhotosUI
import AVFoundation
import ImageIO

struct AcademyClassLog: Codable, Identifiable, Equatable {
    var id = UUID()
    var studentID: UUID
    var sessionID: String
    var classDate: String
    var title = "Today's progress"
    var accomplishments = ""
    var nextSteps = ""
    var privateNotes = ""
    var instructor: String
    var photoIDs: [UUID] = []
    var published = false
    var createdAt = Date()
    var updatedAt = Date()

    static func dayKey(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    var dateLabel: String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: classDate)?.formatted(date: .abbreviated, time: .omitted) ?? classDate
    }
    func validate() throws {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let date = formatter.date(from: classDate), formatter.string(from: date) == classDate,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 150,
              accomplishments.count <= 4000, nextSteps.count <= 2000, privateNotes.count <= 4000,
              !instructor.isEmpty, instructor.count <= 150, photoIDs.count <= 6, Set(photoIDs).count == photoIDs.count,
              !published || !accomplishments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AcademyError.invalidBackup }
    }
}

enum AcademyPhotos {
    private static func directory(demo: Bool) throws -> URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FlightAcademy/Photos/\(demo ? "demo" : "live")", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static func data(_ id: UUID, demo: Bool) -> Data? {
        guard let url = try? directory(demo: demo).appendingPathComponent(id.uuidString + ".jpg") else { return nil }
        return try? Data(contentsOf: url)
    }
    static func save(_ data: Data, id: UUID, demo: Bool) throws {
        try data.write(to: directory(demo: demo).appendingPathComponent(id.uuidString + ".jpg"), options: [.atomic, .completeFileProtection])
    }
    static func remove(_ id: UUID, demo: Bool) {
        if let url = try? directory(demo: demo).appendingPathComponent(id.uuidString + ".jpg") { try? FileManager.default.removeItem(at: url) }
    }
    static func prepare(_ image: UIImage) throws -> Data {
        guard image.size.width > 0, image.size.height > 0 else { throw AcademyCloud.CloudError("This photo could not be opened.") }
        let scale = min(1, 1600 / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        for quality in [0.78, 0.6, 0.4, 0.25] {
            if let data = rendered.jpegData(compressionQuality: quality), data.count <= 950_000 { return data }
        }
        throw AcademyCloud.CloudError("This photo is too large. Try a closer crop.")
    }
    static func prepare(_ data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1600] as CFDictionary) else { throw AcademyCloud.CloudError("This photo could not be opened. Try another image.") }
        return try prepare(UIImage(cgImage: image))
    }
}

struct AcademyClassLogbookView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @EnvironmentObject private var cloud: AcademyCloud
    let session: TeachingSession
    @State var date: Date
    @State private var editing: AcademyClassLog?
    private var entries: [AcademyClassLog] { (teaching.state.classLogs ?? []).filter { $0.sessionID == session.id && $0.classDate == AcademyClassLog.dayKey(date) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 12) {
                    AcademyEyebrow(text: "Class logbook", color: AcademyTheme.gold)
                    Text(session.course).font(AcademyTheme.display(29))
                    Label(session.slot, systemImage: "clock").font(.subheadline)
                    Text("Small steps. A story worth sharing.").font(.subheadline).foregroundStyle(.white.opacity(0.8))
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24).foregroundStyle(.white).background(AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 24))
                DatePicker("Class date", selection: $date, displayedComponents: .date).font(.subheadline.weight(.semibold))
                Text("Record each student's accomplishments, add photos of their work, and choose what their family can see.").font(.subheadline).foregroundStyle(AcademyTheme.muted)
                ForEach(store.workspace.students.filter { session.studentIDs.contains($0.id) }) { student in
                    AcademyPanel {
                        VStack(alignment: .leading, spacing: 16) {
                            HStack(spacing: 12) { AcademyAvatar(student: student, size: 42); Text(student.name).font(AcademyTheme.display(20)); Spacer() }
                            ForEach(entries.filter { $0.studentID == student.id }.sorted { $0.createdAt > $1.createdAt }) { entry in
                                Button { editing = entry } label: { AcademyClassLogSummary(entry: entry) }.buttonStyle(.plain)
                            }
                            Button {
                                editing = AcademyClassLog(studentID: student.id, sessionID: session.id, classDate: AcademyClassLog.dayKey(date), instructor: cloud.email.isEmpty ? store.workspace.instructor : cloud.email)
                            } label: { Label("Add progress update", systemImage: "plus.circle.fill") }.font(.subheadline.weight(.semibold))
                            NavigationLink { AcademyFamilyLinkView(student: student) } label: { Label("Family access", systemImage: "person.2.badge.key") }.font(.caption)
                        }
                    }
                }
            }.padding(22)
        }.background(AcademyTheme.paper).navigationTitle("Class logbook").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
            .sheet(item: $editing) { AcademyClassLogEditor(entry: $0) }
    }
}

struct AcademyClassLogSummary: View {
    let entry: AcademyClassLog
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack { Text(entry.title).font(.headline); Spacer(); Image(systemName: "chevron.right").font(.caption) }
            Text(entry.accomplishments.isEmpty ? "Draft in progress" : entry.accomplishments).font(.subheadline).lineLimit(3)
            HStack { Text(entry.dateLabel); Spacer(); if !entry.photoIDs.isEmpty { Label("\(entry.photoIDs.count)", systemImage: "photo") }; Text(entry.published ? "Family update" : "Draft") }
                .font(.caption).foregroundStyle(AcademyTheme.muted)
        }.padding(14).background(AcademyTheme.paper, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct AcademyStudentClassEntry: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    let entry: AcademyClassLog
    @State private var editing = false
    private var current: AcademyClassLog { teaching.state.classLogs?.first { $0.id == entry.id } ?? entry }
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
            AcademyEyebrow(text: current.dateLabel)
            Text(current.title).font(AcademyTheme.display(28))
            Text(current.accomplishments)
            if !current.nextSteps.isEmpty { Text("Up next").font(.headline); Text(current.nextSteps) }
            ForEach(current.photoIDs, id: \.self) { id in AcademyJournalPhoto(id: id).frame(height: 300).clipShape(RoundedRectangle(cornerRadius: 18)) }
            if !current.privateNotes.isEmpty { AcademyPanel { VStack(alignment: .leading, spacing: 9) { Label("Private instructor notes", systemImage: "lock").font(.headline); Text(current.privateNotes) } } }
            Text(current.published ? "Shared with family after sync" : "Draft · instructors only").font(.caption).foregroundStyle(AcademyTheme.muted)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(22) }.background(AcademyTheme.paper).navigationTitle("Class update").toolbar(.visible, for: .navigationBar)
            .toolbar { Button("Edit") { editing = true } }.sheet(isPresented: $editing) { AcademyClassLogEditor(entry: current) }
    }
}

struct AcademyClassLogEditor: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var teaching: AcademyTeachingStore
    @EnvironmentObject private var cloud: AcademyCloud
    @Environment(\.dismiss) private var dismiss
    @State var entry: AcademyClassLog
    @State private var original: AcademyClassLog
    @State private var existedAtOpen: Bool?
    @State private var addedPhotos = Set<UUID>()
    @State private var picker: PhotosPickerItem?
    @State private var camera = false
    @State private var loading = false
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var confirmShare = false
    private var studentName: String { store.workspace.students.first { $0.id == entry.studentID }?.name ?? "Student" }
    private var isExisting: Bool { teaching.state.classLogs?.contains { $0.id == entry.id } == true }
    private var canSave: Bool { !entry.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !entry.instructor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !loading }
    init(entry: AcademyClassLog) { _entry = State(initialValue: entry); _original = State(initialValue: entry) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(studentName).font(AcademyTheme.display(25))
                    Text(entry.dateLabel).font(.subheadline).foregroundStyle(AcademyTheme.muted)
                    TextField("Update title", text: $entry.title)
                    if cloud.email.isEmpty { TextField("Instructor name", text: $entry.instructor) }
                }
                Section("What they accomplished") {
                    TextField("What did they build, practise, or discover?", text: $entry.accomplishments, axis: .vertical).lineLimit(4...10)
                }
                Section("Next steps") {
                    TextField("What will they try next?", text: $entry.nextSteps, axis: .vertical).lineLimit(2...5)
                }
                Section {
                    if !entry.photoIDs.isEmpty {
                        ScrollView(.horizontal) {
                            HStack(spacing: 12) { ForEach(entry.photoIDs, id: \.self) { id in
                                VStack { AcademyJournalPhoto(id: id).frame(width: 180, height: 160).clipShape(RoundedRectangle(cornerRadius: 14)); Button("Remove photo", role: .destructive) { entry.photoIDs.removeAll { $0 == id } }.font(.caption) }
                            } }
                        }
                    }
                    HStack {
                        Button { Task { await openCamera() } } label: { Label("Take photo", systemImage: "camera") }
                        Spacer()
                        PhotosPicker(selection: $picker, matching: .images) { Label("Choose photo", systemImage: "photo.on.rectangle") }
                    }.buttonStyle(.borderless).disabled(entry.photoIDs.count >= 6 || loading)
                    if loading { ProgressView("Preparing photo…") }
                } header: { Text("Photos · \(entry.photoIDs.count)/6") } footer: { Text("Show this student's work. Shared photos are visible to anyone with their family link. Location metadata is removed.") }
                Section {
                    TextField("For the teaching team only", text: $entry.privateNotes, axis: .vertical).lineLimit(3...6)
                } header: { Text("Private instructor notes") } footer: { Text("These notes never appear in the family view.") }
                Section {
                    Button(entry.published ? "Save changes" : "Save draft") { save() }.buttonStyle(AcademyPrimaryButton()).disabled(!canSave)
                    if entry.published {
                        Label("Included in the family view after sync", systemImage: "checkmark.circle.fill").foregroundStyle(AcademyTheme.green)
                        Button("Return to draft") { entry.published = false }
                    } else {
                        Label("Draft · visible to instructors only", systemImage: "lock")
                        Button("Share with family") { confirmShare = true }.disabled(!canSave || entry.accomplishments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } footer: { Text(store.isDemo ? "Demo updates stay in the demo. Family links are available in the academy workspace." : cloud.connected ? "Updates and photos sync while the app is open. Family access is managed separately for each student." : "Saved on this iPhone. Sign in to the shared workspace to upload updates and photos.") }
                if isExisting { Section { Button("Delete update", role: .destructive) { confirmDelete = true } } }
            }.navigationTitle(isExisting ? "Progress update" : "New update").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!canSave) } }
                .sheet(isPresented: $camera) { AcademyCamera { image in camera = false; if let image { addPhoto { try AcademyPhotos.prepare(image) } } }.ignoresSafeArea() }
                .onAppear { if existedAtOpen == nil { existedAtOpen = isExisting } }
                .onDisappear {
                    let retained = Set((teaching.state.classLogs ?? []).flatMap(\.photoIDs))
                    for id in addedPhotos.subtracting(retained) { AcademyPhotos.remove(id, demo: store.isDemo) }
                }
                .onChange(of: picker) { _, item in
                    guard let item else { return }; loading = true
                    Task { do { guard let data = try await item.loadTransferable(type: Data.self) else { throw AcademyCloud.CloudError("This photo could not be downloaded. Try again when connected.") }; addPhoto { try AcademyPhotos.prepare(data) } } catch { self.error = error.localizedDescription }; loading = false; picker = nil }
                }
                .confirmationDialog("Share this update with \(studentName)'s family?", isPresented: $confirmShare, titleVisibility: .visible) {
                    Button("Save and share") { entry.published = true; save() }
                } message: { Text("The accomplishment, next steps, and photos will appear on their private family link after sync. Private instructor notes stay hidden.") }
                .confirmationDialog("Delete this progress update?", isPresented: $confirmDelete, titleVisibility: .visible) { Button("Delete update", role: .destructive) { if teaching.change({ $0.classLogs?.removeAll { $0.id == entry.id } }) { Task { await cloud.sync(store: store, teaching: teaching) }; dismiss() } } } message: { Text("It will disappear from the family view after sync.") }
                .alert("Progress update", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        }.tint(AcademyTheme.navy)
    }
    private func addPhoto(_ prepare: () throws -> Data) {
        do { guard entry.photoIDs.count < 6 else { return }; let id = UUID(); try AcademyPhotos.save(prepare(), id: id, demo: store.isDemo); entry.photoIDs.append(id); addedPhotos.insert(id) }
        catch { self.error = error.localizedDescription }
    }
    private func save() {
        if existedAtOpen == true, teaching.state.classLogs?.first(where: { $0.id == original.id }) != original {
            error = "This update changed while you were editing. Copy any new notes, then reopen the update to review the latest version."; return
        }
        do {
            entry.title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cloud.email.isEmpty { entry.instructor = cloud.email }; entry.updatedAt = Date(); try entry.validate()
            if teaching.change({ state in
                if state.classLogs == nil { state.classLogs = [] }
                if let i = state.classLogs?.firstIndex(where: { $0.id == entry.id }) { state.classLogs?[i] = entry } else { state.classLogs?.append(entry) }
            }) { Task { await cloud.sync(store: store, teaching: teaching) }; dismiss() }
        } catch { self.error = "Check the title, instructor, and text lengths (4,000 characters per note; 2,000 for next steps)." }
    }
    private func openCamera() async {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { error = "Camera is unavailable on this device. Choose a photo instead."; return }
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        let allowed = status == .notDetermined ? await AVCaptureDevice.requestAccess(for: .video) : status == .authorized
        if allowed { camera = true }
        else { error = "Allow camera access for Flight Academy in iPhone Settings, or choose an existing photo." }
    }
}

struct AcademyJournalPhoto: View {
    @EnvironmentObject private var cloud: AcademyCloud
    @EnvironmentObject private var store: AcademyStore
    let id: UUID
    @State private var image: UIImage?
    @State private var error: String?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if error != nil { VStack { Image(systemName: "photo"); Text("Photo unavailable offline").font(.caption); Button("Retry") { Task { await load() } }.font(.caption) } }
            else { ProgressView() }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(AcademyTheme.paper)
            .task(id: id) { await load() }
    }
    private func load() async {
        error = nil
        if let data = AcademyPhotos.data(id, demo: store.isDemo), let local = UIImage(data: data) { image = local; return }
        do { let data = try await cloud.photo(id); try AcademyPhotos.save(data, id: id, demo: store.isDemo); image = UIImage(data: data) }
        catch { self.error = error.localizedDescription }
    }
}

struct AcademyCamera: UIViewControllerRepresentable {
    let completion: (UIImage?) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController { let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator; return picker }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let completion: (UIImage?) -> Void
        init(completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { completion(info[.originalImage] as? UIImage) }
    }
}

struct AcademyFamilyLinkView: View {
    @EnvironmentObject private var store: AcademyStore
    @EnvironmentObject private var cloud: AcademyCloud
    let student: AcademyStudent
    @State private var active = false
    @State private var loaded = false
    @State private var busy = false
    @State private var url: URL?
    @State private var error: String?
    @State private var confirmCreate = false
    @State private var confirmRevoke = false
    var body: some View {
        Form {
            Section { Text(student.name).font(AcademyTheme.display(26)); Text("A window into their progress.").foregroundStyle(AcademyTheme.muted) }
            Section {
                Label(active ? "Family link active" : "No active family link", systemImage: active ? "link.circle.fill" : "link")
                Text("Parents can read shared class updates and view photos for \(student.name). Drafts, private notes, and other students' records stay hidden.")
                if let url { ShareLink(item: url) { Label("Share private family link", systemImage: "square.and.arrow.up") } }
                Button(active ? "Create replacement link" : "Create family link") { confirmCreate = true }.disabled(!loaded || busy)
                if active { Button("Revoke family access", role: .destructive) { confirmRevoke = true }.disabled(busy) }
            } footer: { Text("Anyone with the link can view shared updates for this student. Give it only to their parent or guardian. Links expire after one year. Replacing or revoking a link stops future access through it.") }
            if busy { ProgressView() }
            if !store.isDemo && !cloud.connected { Section { NavigationLink("Sign in to shared workspace") { AcademyCloudView() } } }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Try again") { Task { await load() } } } }
        }.navigationTitle("Family access").navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
            .task { await load() }
            .confirmationDialog(active ? "Replace this student's family link?" : "Create a private family link?", isPresented: $confirmCreate, titleVisibility: .visible) {
                Button(active ? "Replace link" : "Create link") { Task { busy = true; defer { busy = false }; do { url = try await cloud.createFamilyLink(student.id); active = true; error = nil } catch { self.error = error.localizedDescription } } }
            } message: { Text(active ? "The previous link will stop working. Share the new link with this student's parent or guardian." : "The link grants read-only access to this student's shared class updates. It is not sent automatically.") }
            .confirmationDialog("Revoke this family's link?", isPresented: $confirmRevoke, titleVisibility: .visible) { Button("Revoke link", role: .destructive) { Task { busy = true; defer { busy = false }; do { try await cloud.revokeFamilyLink(student.id); active = false; url = nil; error = nil } catch { self.error = error.localizedDescription } } } }
    }
    private func load() async {
        guard !store.isDemo, cloud.connected else { error = store.isDemo ? "Family links are available in your signed-in academy workspace." : "Sign in to the shared workspace first."; return }
        busy = true; defer { busy = false }
        do { active = try await cloud.familyLinkActive(student.id); loaded = true; error = nil } catch { self.error = error.localizedDescription }
    }
}
