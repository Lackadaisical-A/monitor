import Foundation

struct FeedResponse: Decodable {
    let entries: [FeedEntry]
    let access: AccessInfo?
    let delayedByMinutes: Int?
    let scope: String?
}

struct InstallationPreferences: Codable, Equatable {
    let installationId: String
    var watchedTickers: [String]
    var feedMode: String
    var pushMode: String
    var eventTypes: [String]
    let updatedAt: String?

    static let initial = InstallationPreferences(
        installationId: "",
        watchedTickers: [],
        feedMode: "all",
        pushMode: "all",
        eventTypes: CatalystEvent.allCases.map(\.rawValue),
        updatedAt: nil
    )
}

struct PreferenceLimits: Decodable {
    let watchlist: Int
    let monitoredUniverse: Int
}

struct PreferencesResponse: Decodable {
    let access: AccessInfo
    let preferences: InstallationPreferences
    let limits: PreferenceLimits
    let eventTypes: [String]
}

struct PreferencesUpdateRequest: Encodable {
    let watchedTickers: [String]
    let feedMode: String
    let pushMode: String
    let eventTypes: [String]
}

struct WatchlistResponse: Decodable {
    let access: AccessInfo?
    let preferences: InstallationPreferences?
    let limit: Int
    let companies: [WatchCompany]
}

struct WatchCompany: Decodable, Identifiable {
    var id: String { ticker }
    let ticker: String
    let company: String
    let aliases: [String]
    let marketCapBand: String
    let programs: [String]
    let followed: Bool
    let coverage: CompanyCoverage
}

struct CompanyCoverage: Decodable {
    let sec: Bool
    let clinicalTrials: Bool
    let pressReleases: Bool
    let companyIr: Bool
    let programMetadata: Bool
    let level: String

    var labels: [String] {
        [companyIr ? "IR" : nil, pressReleases ? "Press" : nil, sec ? "SEC" : nil,
         clinicalTrials ? "Trials" : nil].compactMap { $0 }
    }
}

enum CatalystEvent: String, CaseIterable, Identifiable {
    case trialTopline = "trial_topline"
    case trialUpdate = "trial_update"
    case regulatoryDecision = "regulatory_decision"
    case regulatoryUpdate = "regulatory_update"
    case safetySignal = "safety_signal"
    case publication
    case financing
    case partnership
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .trialTopline: "Trial topline"
        case .trialUpdate: "Trial update"
        case .regulatoryDecision: "Regulatory decision"
        case .regulatoryUpdate: "Regulatory update"
        case .safetySignal: "Safety signal"
        case .publication: "Publication"
        case .financing: "Financing"
        case .partnership: "Partnership"
        case .other: "Other catalyst"
        }
    }

    var symbol: String {
        switch self {
        case .trialTopline: "chart.line.uptrend.xyaxis"
        case .trialUpdate: "cross.case"
        case .regulatoryDecision: "checkmark.seal"
        case .regulatoryUpdate: "building.columns"
        case .safetySignal: "exclamationmark.shield"
        case .publication: "doc.text.magnifyingglass"
        case .financing: "banknote"
        case .partnership: "link"
        case .other: "bolt"
        }
    }
}

struct AccessInfo: Decodable, Equatable {
    let installationId: String
    let level: String
    let pro: Bool
    let productId: String?
    let expiresAt: String?
    let source: String

    static let free = AccessInfo(
        installationId: "",
        level: "free",
        pro: false,
        productId: nil,
        expiresAt: nil,
        source: "free"
    )
}

struct EntitlementResponse: Decodable {
    let access: AccessInfo
    let products: [String]
    let freeFeedDelayMinutes: Int
}

struct FeedEntry: Decodable, Identifiable {
    var id: String { item.id }
    let item: SignalItem
    let analysis: AnalysisRecord?
    let corroborationCount: Int
    let alertedAt: String?
    let marketMovement: StockMovement?
}

struct StockMovement: Decodable {
    let ticker: String
    let sessionDate: String
    let status: String
    let announcementAt: String?
    let priceStartAt: String?
    let priceEndAt: String?
    let cutoffAt: String?
    let window: String?
    let refreshIntervalSeconds: Int?
    let previousClose: Double
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let change: Double
    let changePct: Double
    let fetchedAt: String
    let feed: String
    let provider: String
    let basis: String
}

struct SignalItem: Decodable, Identifiable {
    let id: String
    let externalId: String
    let source: SignalSource
    let headline: String
    let summary: String
    let url: String
    let author: String?
    let publishedAt: String
    let discoveredAt: String
    let companyHint: String?
    let tickerHint: String?
}

struct SignalSource: Decodable {
    let id: String
    let name: String
    let type: String
    let tier: String
}

struct AnalysisRecord: Decodable {
    let itemId: String
    let model: String
    let method: String
    let assessment: ImpactAssessment
    let policyScore: Int
    let alertTier: String
    let policyReasons: [String]
    let createdAt: String
}

struct ImpactAssessment: Decodable {
    let isBiotechCatalyst: Bool
    let companyName: String
    let ticker: String
    let eventType: String
    let trialPhase: String
    let trialName: String
    let indication: String
    let resultDirection: String
    let stockDirection: String
    let materiality: Int
    let confidence: Double
    let probabilityPositiveMove: Double
    let expectedMoveLowPct: Double
    let expectedMoveBasePct: Double
    let expectedMoveHighPct: Double
    let timeHorizon: String
    let primaryEndpointMet: String
    let statisticalStrength: String
    let safetyAssessment: String
    let noveltyVsPriorDisclosure: String
    let rationale: String
    let evidence: [String]
    let uncertainty: [String]
    let disconfirmingEvidence: [String]
    let requiresHumanReview: Bool
}

struct DeviceRegistration: Encodable {
    let installationId: String
    let deviceToken: String
    let environment: String
    let timeSensitiveAuthorized: Bool
    let criticalAuthorized: Bool
}

struct StatusResponse: Decodable {
    let stats: MonitorStats
    let configuration: MonitorConfiguration
    let access: AccessInfo?
}

struct ScanResponse: Decodable {
    let startedAt: String
    let finishedAt: String
    let sourceCount: Int
    let fetchedCount: Int
    let insertedCount: Int
    let analyzedCount: Int
    let skippedCount: Int
    let errorCount: Int
    let urgentCount: Int
    let alreadyRunning: Bool
}

struct MonitorStats: Decodable {
    let item_count: Int
    let analyzed_count: Int
    let pending_count: Int
    let alertCount: Int
    let deviceCount: Int
}

struct MonitorConfiguration: Decodable {
    let analysisMode: String
    let model: String
    let dryRun: Bool
    let apnsConfigured: Bool
    let criticalAlertsEnabled: Bool
    let freeFeedDelayMinutes: Int
}

struct ServerSettings: Equatable {
    var baseURL: String
    var installationId: String
    var clientToken: String

    var isComplete: Bool {
        guard let url = URL(string: baseURL), ["http", "https"].contains(url.scheme?.lowercased()) else { return false }
        return UUID(uuidString: installationId) != nil && clientToken.count == 64
    }
}

enum ConnectionState: Equatable {
    case notConfigured
    case connecting
    case connected
    case failed(String)
}
