import SwiftUI
import UIKit

@main
struct BiotechSignalApp: App {
    @StateObject private var academy = AcademyStore()

    var body: some Scene {
        WindowGroup {
            AcademyRootView()
                .environmentObject(academy)
                .preferredColorScheme(.light)
                .task {
                    // The academy app no longer receives stock-alert pushes.
                    UIApplication.shared.unregisterForRemoteNotifications()
                }
        }
    }
}
