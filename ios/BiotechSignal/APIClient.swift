import Foundation

struct APIClient {
    let settings: ServerSettings

    func bootstrapInstallation() async throws -> EntitlementResponse {
        let body = try JSONEncoder().encode(InstallationRegistration(
            installationId: settings.installationId,
            clientToken: settings.clientToken
        ))
        return try await request(path: "/api/installations", method: "POST", body: body)
    }

    func fetchFeed(scope: String? = nil) async throws -> FeedResponse {
        let scopeQuery = scope.map { "&scope=\($0)" } ?? ""
        return try await request(path: "/api/feed?limit=150\(scopeQuery)")
    }

    func fetchWatchlist() async throws -> WatchlistResponse {
        try await request(path: "/api/watchlist")
    }

    func fetchPreferences() async throws -> PreferencesResponse {
        try await request(path: "/api/preferences")
    }

    func updatePreferences(_ preferences: PreferencesUpdateRequest) async throws -> PreferencesResponse {
        let body = try JSONEncoder().encode(preferences)
        return try await request(path: "/api/preferences", method: "PUT", body: body)
    }

    func fetchStatus() async throws -> StatusResponse {
        try await request(path: "/api/status")
    }

    func fetchEntitlement() async throws -> EntitlementResponse {
        try await request(path: "/api/entitlements")
    }

    func verifyStoreTransaction(_ signedTransaction: String) async throws -> EntitlementResponse {
        let body = try JSONEncoder().encode(StoreTransactionRequest(signedTransaction: signedTransaction))
        return try await request(path: "/api/entitlements/storekit", method: "POST", body: body)
    }

    func activateDeveloper(credential: String) async throws -> EntitlementResponse {
        let body = try JSONEncoder().encode(DeveloperActivationRequest(credential: credential))
        return try await request(path: "/api/entitlements/developer", method: "POST", body: body)
    }

    func registerDevice(_ registration: DeviceRegistration) async throws -> PairResponse {
        let body = try JSONEncoder().encode(registration)
        return try await request(path: "/api/devices", method: "POST", body: body)
    }

    func runScan() async throws -> ScanResponse {
        try await request(path: "/api/scan", method: "POST")
    }

    private func request<T: Decodable>(path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard let base = URL(string: settings.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
              let url = URL(string: path, relativeTo: base) else { throw APIError.invalidServerURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 25
        request.setValue(settings.installationId, forHTTPHeaderField: "X-Installation-ID")
        request.setValue(settings.clientToken, forHTTPHeaderField: "X-Client-Token")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            if http.statusCode == 403 { throw APIError.proRequired }
            throw APIError.server(http.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decoding(error.localizedDescription) }
    }

    struct PairResponse: Decodable {
        let ok: Bool
        let pushEligible: Bool
        let criticalAccepted: Bool
    }
}

private struct InstallationRegistration: Encodable {
    let installationId: String
    let clientToken: String
}

private struct StoreTransactionRequest: Encodable {
    let signedTransaction: String
}

private struct DeveloperActivationRequest: Encodable {
    let credential: String
}

enum APIError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case unauthorized
    case proRequired
    case server(Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Enter a valid server URL."
        case .invalidResponse: "The server returned an invalid response."
        case .unauthorized: "This installation could not be authenticated."
        case .proRequired: "Catalyst Watch Pro is required."
        case .server(let status): "Server request failed (HTTP \(status))."
        case .decoding(let message): "Could not read the server response: \(message)"
        }
    }
}
