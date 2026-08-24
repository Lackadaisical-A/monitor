import SwiftUI

@main
struct BiotechSignalApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = MonitorStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .task { await store.start() }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 300_000_000_000)
                        guard !Task.isCancelled else { return }
                        await store.refreshMarketMovements()
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    Task { await store.refreshMarketMovements() }
                }
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
