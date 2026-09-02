import CoreNFC
import Foundation

struct ClubCardScan: Identifiable, Sendable {
    var id: String { "\(technology):\(identifier)" }
    let technology: String
    let identifier: String
}

enum ClubCardReaderError: LocalizedError {
    case unavailable
    case unauthorizedBuild
    case busy
    case cancelled
    case unsupported
    case connection(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: "NFC card reading is unavailable on this iPhone."
        case .unauthorizedBuild: "NFC is not authorized for this app build. Install the latest Catalyst Watch build from TestFlight and try again."
        case .busy: "An NFC scan is already active."
        case .cancelled: nil
        case .unsupported: "This card does not expose a supported NFC identifier."
        case .connection(let message): "The card could not be read: \(message)"
        }
    }
}

final class ClubCardReader: NSObject, NFCTagReaderSessionDelegate {
    static let shared = ClubCardReader()

    private let lock = NSLock()
    private var continuation: CheckedContinuation<ClubCardScan, Error>?
    private var session: NFCTagReaderSession?

    func scan() async throws -> ClubCardScan {
        guard NFCReaderSession.readingAvailable else { throw ClubCardReaderError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard self.continuation == nil else {
                lock.unlock()
                continuation.resume(throwing: ClubCardReaderError.busy)
                return
            }
            self.continuation = continuation
            lock.unlock()

            // FeliCa polling requires an explicit system-code allowlist in Info.plist.
            guard let session = NFCTagReaderSession(
                pollingOption: [.iso14443, .iso15693],
                delegate: self,
                queue: nil
            ) else {
                finish(.failure(ClubCardReaderError.unavailable))
                return
            }
            lock.lock()
            self.session = session
            lock.unlock()
            session.alertMessage = "Hold the top of this iPhone near the member's card."
            session.begin()
        }
    }

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        if let readerError = error as? NFCReaderError {
            switch readerError.code {
            case .readerSessionInvalidationErrorUserCanceled:
                finish(.failure(ClubCardReaderError.cancelled))
                return
            case .readerErrorSecurityViolation:
                finish(.failure(ClubCardReaderError.unauthorizedBuild))
                return
            default:
                break
            }
        }
        finish(.failure(ClubCardReaderError.connection(error.localizedDescription)))
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard tags.count == 1, let tag = tags.first else {
            session.alertMessage = "Move other cards away and try again."
            session.restartPolling()
            return
        }
        session.connect(to: tag) { [weak self] error in
            guard let self else { return }
            if error != nil {
                session.alertMessage = "Keep the card still and try again."
                session.restartPolling()
                return
            }
            guard let scan = Self.scanResult(for: tag) else {
                session.invalidate(errorMessage: "This card type is not supported.")
                self.finish(.failure(ClubCardReaderError.unsupported))
                return
            }
            session.alertMessage = "Card read."
            self.finish(.success(scan))
            session.invalidate()
        }
    }

    private static func scanResult(for tag: NFCTag) -> ClubCardScan? {
        let technology: String
        let identifier: Data
        switch tag {
        case .miFare(let value):
            technology = "mifare"
            identifier = value.identifier
        case .iso7816(let value):
            technology = "iso7816"
            identifier = value.identifier
        case .iso15693(let value):
            technology = "iso15693"
            identifier = value.identifier
        case .feliCa(let value):
            technology = "felica"
            identifier = value.currentIDm
        @unknown default:
            return nil
        }
        guard identifier.count >= 2 else { return nil }
        return ClubCardScan(
            technology: technology,
            identifier: identifier.map { String(format: "%02x", $0) }.joined()
        )
    }

    private func finish(_ result: Result<ClubCardScan, Error>) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        session = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}
