import SwiftUI

@main
struct BiotechSignalApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = MonitorStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task { await store.start() }
                .onOpenURL { url in
                    guard url.scheme == "biotechsignal", url.host == "signal" else { return }
                    store.openSignal(id: url.lastPathComponent)
                }
        }
    }
}
