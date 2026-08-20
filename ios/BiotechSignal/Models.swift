import Foundation

struct FeedResponse: Decodable {
    let entries: [FeedEntry]
}

struct FeedEntry: Decodable, Identifiable {
    var id: String { item.id }
    let item: SignalItem
    let analysis: AnalysisRecord?
    let corroborationCount: Int
    let alertedAt: String?
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
}

struct ServerSettings: Equatable {
    var baseURL: String
    var pairingToken: String

    var isComplete: Bool {
        guard let url = URL(string: baseURL), ["http", "https"].contains(url.scheme?.lowercased()) else { return false }
        return !pairingToken.isEmpty
    }
}

enum ConnectionState: Equatable {
    case notConfigured
    case connecting
    case connected
    case failed(String)
}
