import Foundation
import StoreKit
import SwiftUI

@MainActor
final class MonitorStore: ObservableObject {
    static let monthlyProductId = "com.yingcui.CatalystWatch.pro.monthly"
    static let yearlyProductId = "com.yingcui.CatalystWatch.pro.yearly"
    static let productIds = [monthlyProductId, yearlyProductId]

    @Published private(set) var entries: [FeedEntry] = []
    @Published private(set) var watchlist: [WatchCompany] = []
    @Published private(set) var preferences = InstallationPreferences.initial
    @Published private(set) var watchlistLimit = 10
    @Published private(set) var monitoredUniverse = 0
    @Published private(set) var status: StatusResponse?
    @Published private(set) var access = AccessInfo.free
    @Published private(set) var products: [Product] = []
    @Published private(set) var productsLoaded = false
    @Published private(set) var screenshotMode = false
    @Published private(set) var connection: ConnectionState = .notConfigured
    @Published private(set) var notificationStatus = "Not checked"
    @Published private(set) var scanInProgress = false
    @Published private(set) var purchaseInProgress = false
    @Published private(set) var preferenceUpdateInProgress = false
    @Published private(set) var lastScanSummary: ScanResponse?
    @Published var selectedSignal: FeedEntry?
    @Published var selectedTab = "signals"
    @Published var showingPaywall = false
    @Published var lastError: String?
    @Published var purchaseMessage: String?

    private let baseURLKey = "monitorBaseURL"
    private let installationIdKey = "installationId"
    private let clientTokenAccount = "installationClientToken"
    private var observers: [NSObjectProtocol] = []
    private var transactionListener: Task<Void, Never>?
    private var debugDeveloperCredential = ""
    private var cachedClientToken: String?

    var settings: ServerSettings {
        ServerSettings(
            baseURL: configuredBaseURL,
            installationId: installationId,
            clientToken: clientToken
        )
    }

    var installationId: String {
        if let existing = UserDefaults.standard.string(forKey: installationIdKey), UUID(uuidString: existing) != nil {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: installationIdKey)
        return created
    }

    var clientToken: String {
        if let cachedClientToken { return cachedClientToken }
        let existing = KeychainStore.read(account: clientTokenAccount)
        if existing.count == 64 {
            cachedClientToken = existing
            return existing
        }
        let created = (try? KeychainStore.randomHex())
            ?? (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        try? KeychainStore.save(created, account: clientTokenAccount)
        cachedClientToken = created
        return created
    }

    private var configuredBaseURL: String {
        if let saved = UserDefaults.standard.string(forKey: baseURLKey), !saved.isEmpty { return saved }
        return Bundle.main.object(forInfoDictionaryKey: "CatalystWatchServerURL") as? String ?? ""
    }

    init() {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let baseURL = environment["CATALYST_WATCH_SERVER_URL"], !baseURL.isEmpty {
            UserDefaults.standard.set(baseURL, forKey: baseURLKey)
        }
        debugDeveloperCredential = environment["CATALYST_WATCH_DEVELOPER_TOKEN"] ?? ""
        screenshotMode = environment["CATALYST_WATCH_SCREENSHOT_MODE"] == "1"
        showingPaywall = environment["CATALYST_WATCH_SHOW_PAYWALL"] == "1" || screenshotMode
        if let initialTab = environment["CATALYST_WATCH_INITIAL_TAB"],
           ["signals", "watchlist", "settings"].contains(initialTab) {
            selectedTab = initialTab
        }
        #endif

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
        transactionListener = Task { [weak self] in
            for await result in StoreKit.Transaction.updates {
                guard let self else { return }
                if case .verified(let transaction) = result,
                   Self.productIds.contains(transaction.productID) {
                    await self.syncStoreTransaction(
                        transaction,
                        signedTransaction: result.jwsRepresentation
                    )
                    await transaction.finish()
                }
            }
        }
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        transactionListener?.cancel()
    }

    func start() async {
        guard settings.isComplete else { connection = .notConfigured; return }
        do {
            try await bootstrapInstallation()
            if !debugDeveloperCredential.isEmpty {
                try await activateDeveloper(credential: debugDeveloperCredential)
            }
            await loadProducts()
            await syncCurrentEntitlements()
            await refresh()
            await updateNotificationStatus()
            await syncDeviceRegistration()
        } catch {
            connection = .failed(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    func refresh() async {
        guard settings.isComplete else { connection = .notConfigured; return }
        connection = .connecting
        do {
            try await bootstrapInstallation()
            let client = APIClient(settings: settings)
            async let feedResponse = client.fetchFeed()
            async let monitorStatus = client.fetchStatus()
            async let watchlistResponse = client.fetchWatchlist()
            async let preferencesResponse = client.fetchPreferences()
            let (feed, statusResponse, watchlistResult, preferenceResult) = try await (
                feedResponse, monitorStatus, watchlistResponse, preferencesResponse
            )
            applyEntries(feed.entries)
            status = statusResponse
            watchlist = watchlistResult.companies
            access = feed.access ?? statusResponse.access ?? access
            applyPreferences(preferenceResult)
            connection = .connected
            lastError = nil
            await updateNotificationStatus()
        } catch {
            connection = .failed(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    func runScan() async {
        guard access.pro else { showingPaywall = true; return }
        let current = settings
        guard current.isComplete, !scanInProgress else {
            connection = current.isComplete ? connection : .notConfigured
            return
        }
        scanInProgress = true
        defer { scanInProgress = false }
        do {
            lastScanSummary = try await APIClient(settings: current).runScan()
            await refresh()
        } catch {
            connection = .failed(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    func refreshMarketMovements() async {
        guard settings.isComplete, !scanInProgress else { return }
        await refreshFeed()
    }

    func setFeedMode(_ mode: String) async {
        let normalized = mode == "watchlist" ? "watchlist" : "all"
        guard normalized != preferences.feedMode else { return }
        var next = preferences
        next.feedMode = normalized
        if await persistPreferences(next) { await refreshFeed() }
    }

    func toggleFollow(_ ticker: String) async {
        guard !preferenceUpdateInProgress else { return }
        var followed = Set(preferences.watchedTickers)
        if followed.contains(ticker) {
            followed.remove(ticker)
        } else {
            guard followed.count < watchlistLimit else {
                if !access.pro { showingPaywall = true }
                return
            }
            followed.insert(ticker)
        }
        var next = preferences
        next.watchedTickers = watchlist
            .map(\.ticker)
            .filter(followed.contains)
        if next.watchedTickers.isEmpty && next.feedMode == "watchlist" { next.feedMode = "all" }
        let shouldRefreshFeed = next.feedMode == "watchlist" || next.feedMode != preferences.feedMode
        if await persistPreferences(next), shouldRefreshFeed { await refreshFeed() }
    }

    func setPushMode(_ mode: String) async {
        guard access.pro else { showingPaywall = true; return }
        let normalized = mode == "watchlist" ? "watchlist" : "all"
        guard normalized != preferences.pushMode else { return }
        var next = preferences
        next.pushMode = normalized
        _ = await persistPreferences(next)
    }

    func setMinimumAlertTier(_ tier: String) async {
        guard access.pro else { showingPaywall = true; return }
        let normalized = tier == "high" ? "high" : "urgent"
        guard normalized != preferences.minimumAlertTier else { return }
        var next = preferences
        next.minimumAlertTier = normalized
        _ = await persistPreferences(next)
    }

    func toggleEvent(_ event: CatalystEvent) async {
        guard access.pro else { showingPaywall = true; return }
        var selected = Set(preferences.eventTypes)
        if selected.contains(event.rawValue) {
            guard selected.count > 1 else { return }
            selected.remove(event.rawValue)
        } else {
            selected.insert(event.rawValue)
        }
        var next = preferences
        next.eventTypes = CatalystEvent.allCases.map(\.rawValue).filter(selected.contains)
        _ = await persistPreferences(next)
    }

    func saveSettings(baseURL: String) async throws {
        let normalizedURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: normalizedURL), ["http", "https"].contains(url.scheme?.lowercased()) else {
            throw APIError.invalidServerURL
        }
        UserDefaults.standard.set(normalizedURL, forKey: baseURLKey)
        try await bootstrapInstallation()
        await refresh()
        guard connection == .connected else { throw APIError.unauthorized }
        await syncDeviceRegistration()
    }

    func activateDeveloperAccess(credential: String) async throws {
        let normalizedCredential = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedCredential.count >= 32 else { throw DeveloperAccessError.invalidCredential }
        try await bootstrapInstallation()
        do {
            try await activateDeveloper(credential: normalizedCredential)
        } catch APIError.unauthorized {
            throw DeveloperAccessError.rejected
        }
        await refresh()
        await syncDeviceRegistration()
    }

    func enableNotifications() async {
        guard access.pro else { showingPaywall = true; return }
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

    func purchase(_ product: Product) async {
        guard !purchaseInProgress, let accountToken = UUID(uuidString: installationId) else { return }
        purchaseInProgress = true
        purchaseMessage = nil
        defer { purchaseInProgress = false }
        do {
            let result = try await product.purchase(options: [.appAccountToken(accountToken)])
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await syncStoreTransaction(
                        transaction,
                        signedTransaction: verification.jwsRepresentation
                    )
                    await transaction.finish()
                    purchaseMessage = access.pro ? "Catalyst Watch Pro is active." : "Purchase verified; access is syncing."
                case .unverified(_, let error):
                    throw error
                }
            case .pending:
                purchaseMessage = "Purchase approval is pending."
            case .userCancelled:
                break
            @unknown default:
                purchaseMessage = "The purchase result was not recognized."
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func restorePurchases() async {
        guard !purchaseInProgress else { return }
        purchaseInProgress = true
        purchaseMessage = nil
        defer { purchaseInProgress = false }
        do {
            try await AppStore.sync()
            await syncCurrentEntitlements()
            purchaseMessage = access.pro ? "Catalyst Watch Pro was restored." : "No active Pro subscription was found."
        } catch {
            lastError = error.localizedDescription
        }
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

    private func bootstrapInstallation() async throws {
        do {
            applyEntitlement(try await APIClient(settings: settings).bootstrapInstallation())
        } catch APIError.unauthorized {
            resetInstallationCredentials()
            applyEntitlement(try await APIClient(settings: settings).bootstrapInstallation())
        }
    }

    private func resetInstallationCredentials() {
        let newInstallationId = UUID().uuidString.lowercased()
        let newClientToken = (try? KeychainStore.randomHex())
            ?? (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        UserDefaults.standard.set(newInstallationId, forKey: installationIdKey)
        try? KeychainStore.save(newClientToken, account: clientTokenAccount)
        cachedClientToken = newClientToken
    }

    private func activateDeveloper(credential: String) async throws {
        let response = try await APIClient(settings: settings).activateDeveloper(credential: credential)
        applyEntitlement(response)
    }

    private func persistPreferences(_ next: InstallationPreferences) async -> Bool {
        guard settings.isComplete, !preferenceUpdateInProgress else { return false }
        preferenceUpdateInProgress = true
        defer { preferenceUpdateInProgress = false }
        do {
            let response = try await APIClient(settings: settings).updatePreferences(
                PreferencesUpdateRequest(
                    watchedTickers: next.watchedTickers,
                    feedMode: next.feedMode,
                    pushMode: next.pushMode,
                    minimumAlertTier: next.minimumAlertTier,
                    eventTypes: next.eventTypes
                )
            )
            applyPreferences(response)
            lastError = nil
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    private func refreshFeed() async {
        do {
            let response = try await APIClient(settings: settings).fetchFeed(scope: preferences.feedMode)
            applyEntries(response.entries)
            access = response.access ?? access
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func applyEntries(_ nextEntries: [FeedEntry]) {
        entries = nextEntries
        guard let selectedId = selectedSignal?.id,
              let updated = nextEntries.first(where: { $0.id == selectedId }) else { return }
        selectedSignal = updated
    }

    private func applyPreferences(_ response: PreferencesResponse) {
        access = response.access
        preferences = response.preferences
        watchlistLimit = response.limits.watchlist
        monitoredUniverse = response.limits.monitoredUniverse
    }

    private func loadProducts() async {
        defer { productsLoaded = true }
        do {
            products = try await Product.products(for: Self.productIds).sorted { $0.price < $1.price }
        } catch {
            lastError = "Subscription products are unavailable: \(error.localizedDescription)"
        }
    }

    private func syncCurrentEntitlements() async {
        var synced = false
        for await result in StoreKit.Transaction.currentEntitlements {
            if case .verified(let transaction) = result, Self.productIds.contains(transaction.productID) {
                await syncStoreTransaction(
                    transaction,
                    signedTransaction: result.jwsRepresentation
                )
                synced = true
            }
        }
        if !synced {
            do {
                applyEntitlement(try await APIClient(settings: settings).fetchEntitlement())
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func syncStoreTransaction(
        _ transaction: StoreKit.Transaction,
        signedTransaction: String
    ) async {
        do {
            let response = try await APIClient(settings: settings)
                .verifyStoreTransaction(signedTransaction)
            applyEntitlement(response)
            await refresh()
            await syncDeviceRegistration()
        } catch {
            lastError = "Subscription verification failed: \(error.localizedDescription)"
        }
    }

    private func applyEntitlement(_ response: EntitlementResponse) {
        access = response.access
    }

    private func updateNotificationStatus() async {
        guard access.pro else { notificationStatus = "Pro required"; return }
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
            _ = try await APIClient(settings: settings).registerDevice(DeviceRegistration(
                installationId: installationId,
                deviceToken: token,
                environment: environment,
                timeSensitiveAuthorized: snapshot.timeSensitiveAuthorized,
                criticalAuthorized: snapshot.criticalAuthorized
            ))
            lastError = nil
        } catch { lastError = "Device registration failed: \(error.localizedDescription)" }
    }
}

private enum DeveloperAccessError: LocalizedError {
    case invalidCredential
    case rejected

    var errorDescription: String? {
        switch self {
        case .invalidCredential: "Enter the complete developer key."
        case .rejected: "The developer key was not accepted."
        }
    }
}
