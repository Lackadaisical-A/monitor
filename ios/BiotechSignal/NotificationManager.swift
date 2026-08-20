import Foundation
import UIKit
import UserNotifications

struct NotificationAuthorizationSnapshot {
    let authorized: Bool
    let timeSensitiveAuthorized: Bool
    let criticalAuthorized: Bool
}

final class NotificationManager {
    static let shared = NotificationManager()
    private let tokenKey = "apnsDeviceToken"
    private let errorKey = "apnsRegistrationError"

    var deviceToken: String? { UserDefaults.standard.string(forKey: tokenKey) }
    var registrationError: String? { UserDefaults.standard.string(forKey: errorKey) }
    var criticalFeatureEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "CriticalAlertsEnabled") as? Bool == true }

    private init() {}

    func requestAuthorization() async throws -> NotificationAuthorizationSnapshot {
        var options: UNAuthorizationOptions = [.alert, .badge, .sound, .timeSensitive]
        if criticalFeatureEnabled { options.insert(.criticalAlert) }
        _ = try await UNUserNotificationCenter.current().requestAuthorization(options: options)
        await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        return await authorizationSnapshot()
    }

    func authorizationSnapshot() async -> NotificationAuthorizationSnapshot {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return NotificationAuthorizationSnapshot(
            authorized: [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus),
            timeSensitiveAuthorized: settings.timeSensitiveSetting == .enabled,
            criticalAuthorized: settings.criticalAlertSetting == .enabled
        )
    }

    func receivedDeviceToken(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: tokenKey)
        UserDefaults.standard.removeObject(forKey: errorKey)
        NotificationCenter.default.post(name: .deviceTokenChanged, object: token)
    }

    func registrationFailed(_ error: Error) {
        UserDefaults.standard.set(error.localizedDescription, forKey: errorKey)
        NotificationCenter.default.post(name: .deviceTokenChanged, object: nil)
    }

    func scheduleLocalTest() async throws {
        let snapshot = try await requestAuthorization()
        guard snapshot.authorized else { throw TestNotificationError.notAuthorized }
        let content = UNMutableNotificationContent()
        content.title = "Catalyst Watch test"
        content.subtitle = "Time Sensitive delivery is ready"
        content.body = "This is a local test only. No market signal was generated."
        content.sound = .default
        content.interruptionLevel = snapshot.timeSensitiveAuthorized ? .timeSensitive : .active
        content.categoryIdentifier = "CATALYST_SIGNAL"
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
        )
        try await UNUserNotificationCenter.current().add(request)
    }

    enum TestNotificationError: LocalizedError {
        case notAuthorized
        var errorDescription: String? { "Notifications are not authorized." }
    }
}
