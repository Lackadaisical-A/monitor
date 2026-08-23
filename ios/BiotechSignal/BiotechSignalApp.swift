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
                    guard url.scheme == "catalystwatch" else { return }
                    if url.host == "upgrade" {
                        store.showingPaywall = true
                    } else if ["watchlist", "settings"].contains(url.host) {
                        store.selectedTab = url.host ?? "signals"
                    } else if url.host == "signal" {
                        store.openSignal(id: url.lastPathComponent)
                    }
                }
        }
    }
}
