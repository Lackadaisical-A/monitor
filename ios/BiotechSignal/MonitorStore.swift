import Foundation
import SwiftUI

@MainActor
final class MonitorStore: ObservableObject {
    @Published private(set) var entries: [FeedEntry] = []
    @Published private(set) var status: StatusResponse?
    @Published private(set) var connection: ConnectionState = .notConfigured
    @Published private(set) var notificationStatus = "Not checked"
    @Published var selectedSignal: FeedEntry?
    @Published var lastError: String?

    private let baseURLKey = "monitorBaseURL"
    private let installationIdKey = "installationId"
    private let tokenAccount = "serverPairingToken"
    private var observers: [NSObjectProtocol] = []

    var settings: ServerSettings {
        ServerSettings(
            baseURL: UserDefaults.standard.string(forKey: baseURLKey) ?? "",
            pairingToken: KeychainStore.read(account: tokenAccount)
        )
    }

    var installationId: String {
        if let existing = UserDefaults.standard.string(forKey: installationIdKey) { return existing }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: installationIdKey)
        return created
    }

    init() {
        observers.append(NotificationCenter.default.addObserver(
            forName: .openSignalFromNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let id = note.object as? String else { return }
            Task { @MainActor in self?.openSignal(id: id) }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .deviceTokenChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.syncDeviceRegistration() }
        })
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func start() async {
        await updateNotificationStatus()
        guard settings.isComplete else { connection = .notConfigured; return }
        await refresh()
        await syncDeviceRegistration()
    }

    func refresh() async {
        let current = settings
        guard current.isComplete else { connection = .notConfigured; return }
        connection = .connecting
        do {
            async let feed = APIClient(settings: current).fetchFeed()
            async let monitorStatus = APIClient(settings: current).fetchStatus()
            entries = try await feed
            status = try await monitorStatus
            connection = .connected
            lastError = nil
        } catch {
            connection = .failed(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    func saveSettings(baseURL: String, pairingToken: String) async throws {
        let normalizedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let candidate = ServerSettings(baseURL: normalizedURL, pairingToken: pairingToken.trimmingCharacters(in: .whitespacesAndNewlines))
        guard candidate.isComplete else { throw APIError.invalidServerURL }
        UserDefaults.standard.set(candidate.baseURL, forKey: baseURLKey)
        try KeychainStore.save(candidate.pairingToken, account: tokenAccount)
        await refresh()
        guard connection == .connected else { throw APIError.unauthorized }
        await syncDeviceRegistration()
    }

    func enableNotifications() async {
        do {
            _ = try await NotificationManager.shared.requestAuthorization()
            await updateNotificationStatus()
            await syncDeviceRegistration()
        } catch {
            lastError = error.localizedDescription
            await updateNotificationStatus()
        }
    }

    func sendLocalTest() async {
        do {
            try await NotificationManager.shared.scheduleLocalTest()
            lastError = nil
        } catch { lastError = error.localizedDescription }
    }

    func openSignal(id: String) {
        if let entry = entries.first(where: { $0.id == id }) {
            selectedSignal = entry
        } else {
            Task {
                await refresh()
                selectedSignal = entries.first(where: { $0.id == id })
            }
        }
    }

    private func updateNotificationStatus() async {
        let snapshot = await NotificationManager.shared.authorizationSnapshot()
        if snapshot.criticalAuthorized { notificationStatus = "Critical Alerts authorized" }
        else if snapshot.timeSensitiveAuthorized { notificationStatus = "Time Sensitive authorized" }
        else if snapshot.authorized { notificationStatus = "Standard alerts authorized" }
        else { notificationStatus = "Notifications not authorized" }
    }

    private func syncDeviceRegistration() async {
        guard settings.isComplete, let token = NotificationManager.shared.deviceToken else { return }
        let snapshot = await NotificationManager.shared.authorizationSnapshot()
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        do {
            try await APIClient(settings: settings).registerDevice(DeviceRegistration(
                installationId: installationId,
                deviceToken: token,
                environment: environment,
                timeSensitiveAuthorized: snapshot.timeSensitiveAuthorized,
                criticalAuthorized: snapshot.criticalAuthorized
            ))
            lastError = nil
        } catch { lastError = "Device pairing failed: \(error.localizedDescription)" }
    }
}
