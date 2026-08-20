import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let viewAction = UNNotificationAction(
            identifier: "VIEW_SIGNAL",
            title: "View evidence",
            options: [.foreground]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "CATALYST_SIGNAL",
                actions: [viewAction],
                intentIdentifiers: [],
                options: []
            )
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationManager.shared.receivedDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationManager.shared.registrationFailed(error)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let signalId = response.notification.request.content.userInfo["signalId"] as? String {
            NotificationCenter.default.post(name: .openSignalFromNotification, object: signalId)
        }
        completionHandler()
    }
}

extension Notification.Name {
    static let openSignalFromNotification = Notification.Name("openSignalFromNotification")
    static let deviceTokenChanged = Notification.Name("deviceTokenChanged")
}
