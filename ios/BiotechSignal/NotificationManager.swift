import Foundation
import UIKit
import UserNotifications

struct NotificationAuthorizationSnapshot {
    let authorized: Bool
    let alertsAuthorized: Bool
    let soundAuthorized: Bool
    let timeSensitiveAuthorized: Bool
    let criticalAuthorized: Bool
}

enum CatalystAlertSound {
    case high
    case urgent

    var filename: String {
        switch self {
        case .high: "CatalystHigh.caf"
        case .urgent: "CatalystUrgent.caf"
        }
    }
}

final class NotificationManager {
    static let shared = NotificationManager()
    private let tokenKey = "apnsDeviceToken"
    private let errorKey = "apnsRegistrationError"

    var deviceToken: String? { UserDefaults.standard.string(forKey: tokenKey) }
    var registrationError: String? { UserDefaults.standard.string(forKey: errorKey) }
    var criticalFeatureEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "CriticalAlertsEnabled") as? Bool == true }
    var attentionSoundsSupported: Bool {
        [CatalystAlertSound.high, .urgent].allSatisfy { sound in
            let name = String(sound.filename.dropLast(4))
            return Bundle.main.url(forResource: name, withExtension: "caf") != nil
        }
    }

    private init() {}

    func requestAuthorization() async throws -> NotificationAuthorizationSnapshot {
        var options: UNAuthorizationOptions = [.alert, .badge, .sound]
        if criticalFeatureEnabled { options.insert(.criticalAlert) }
        _ = try await UNUserNotificationCenter.current().requestAuthorization(options: options)
        await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
        return await authorizationSnapshot()
    }

    func authorizationSnapshot() async -> NotificationAuthorizationSnapshot {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return NotificationAuthorizationSnapshot(
            authorized: [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus),
            alertsAuthorized: settings.alertSetting == .enabled,
            soundAuthorized: settings.soundSetting == .enabled,
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

    func scheduleLocalTest(_ sound: CatalystAlertSound) async throws {
        let snapshot = try await requestAuthorization()
        guard snapshot.authorized else { throw TestNotificationError.notAuthorized }
        guard snapshot.soundAuthorized else { throw TestNotificationError.soundDisabled }
        guard attentionSoundsSupported else { throw TestNotificationError.soundMissing }
        let content = UNMutableNotificationContent()
        content.title = sound == .urgent ? "URGENT · TEST" : "HIGH · TEST"
        content.subtitle = "Catalyst Watch alert sound"
        content.body = "Local test only. No market signal was generated."
        content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: sound.filename))
        content.interruptionLevel = snapshot.timeSensitiveAuthorized ? .timeSensitive : .active
        content.categoryIdentifier = "CATALYST_SIGNAL"
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
        )
        try await UNUserNotificationCenter.current().add(request)
    }

    @MainActor
    func openSystemNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    enum TestNotificationError: LocalizedError {
        case notAuthorized
        case soundDisabled
        case soundMissing

        var errorDescription: String? {
            switch self {
            case .notAuthorized: "Notifications are not authorized."
            case .soundDisabled: "Notification sounds are disabled in iPhone Settings."
            case .soundMissing: "The alert sound is missing from this build."
            }
        }
    }
}
