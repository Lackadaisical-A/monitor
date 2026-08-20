import Foundation

struct APIClient {
    let settings: ServerSettings

    func fetchFeed() async throws -> [FeedEntry] {
        let response: FeedResponse = try await request(path: "/api/feed?limit=150")
        return response.entries
    }

    func fetchStatus() async throws -> StatusResponse {
        try await request(path: "/api/status")
    }

    func registerDevice(_ registration: DeviceRegistration) async throws {
        let body = try JSONEncoder().encode(registration)
        let _: PairResponse = try await request(path: "/api/devices", method: "POST", body: body)
    }

    private func request<T: Decodable>(path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard let base = URL(string: settings.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
              let url = URL(string: path, relativeTo: base) else { throw APIError.invalidServerURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 20
        request.setValue(settings.pairingToken, forHTTPHeaderField: "X-Pairing-Token")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.server(http.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decoding(error.localizedDescription) }
    }

    private struct PairResponse: Decodable {
        let ok: Bool
        let criticalAccepted: Bool
    }
}

enum APIError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case unauthorized
    case server(Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Enter a valid server URL."
        case .invalidResponse: "The server returned an invalid response."
        case .unauthorized: "The pairing token was not accepted."
        case .server(let status): "Server request failed (HTTP \(status))."
        case .decoding(let message): "Could not read the server response: \(message)"
        }
    }
}
