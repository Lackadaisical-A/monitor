import CoreNFC
import Foundation

/// Instructor credentials are random, revocable bearer tokens, never a tag's public UID.
enum AcademyInstructorCardPayload {
    static let mediaType = Data("application/vnd.flightacademy.staff".utf8)
    static func valid(_ token: String) -> Bool { token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil }
    static func message(_ token: String) throws -> NFCNDEFMessage {
        guard valid(token) else { throw CardError("The instructor card credential is invalid.") }
        return NFCNDEFMessage(records: [NFCNDEFPayload(format: .media, type: mediaType, identifier: Data(), payload: Data("FAA1:\(token)".utf8))])
    }
    static func token(_ message: NFCNDEFMessage) throws -> String {
        guard message.records.count == 1, let record = message.records.first,
              record.typeNameFormat == .media, record.type == mediaType,
              let text = String(data: record.payload, encoding: .utf8), text.hasPrefix("FAA1:"), valid(String(text.dropFirst(5))) else {
            throw CardError("This is not an instructor card. Use your instructor card or sign in with your access code.")
        }
        return String(text.dropFirst(5))
    }
    struct CardError: LocalizedError {
        var message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}

final class AcademyInstructorCardReader: NSObject, NFCTagReaderSessionDelegate {
    static let shared = AcademyInstructorCardReader()
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String, Error>?
    private var session: NFCTagReaderSession?
    private var writing: String?

    func read() async throws -> String { try await scan(writing: nil) }
    func write(_ token: String) async throws { _ = try await scan(writing: token) }
    private func scan(writing: String?) async throws -> String {
        guard NFCReaderSession.readingAvailable else { throw ClubCardReaderError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard self.continuation == nil else { lock.unlock(); continuation.resume(throwing: ClubCardReaderError.busy); return }
            self.continuation = continuation; self.writing = writing
            guard let session = NFCTagReaderSession(pollingOption: [.iso14443, .iso15693], delegate: self, queue: nil) else {
                lock.unlock(); finish(.failure(ClubCardReaderError.unavailable)); return
            }
            self.session = session; lock.unlock()
            session.alertMessage = writing == nil ? "Hold your instructor card near the top of this iPhone." : "Hold a blank, writable NFC tag near the top of this iPhone."
            session.begin()
        }
    }
    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}
    private func current(_ session: NFCTagReaderSession) -> Bool { lock.lock(); defer { lock.unlock() }; return self.session === session }
    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        guard current(session) else { return }
        if let error = error as? NFCReaderError, error.code == .readerSessionInvalidationErrorUserCanceled { finish(.failure(ClubCardReaderError.cancelled)); return }
        finish(.failure(ClubCardReaderError.connection(error.localizedDescription)))
    }
    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard current(session) else { return }
        guard tags.count == 1, let tag = tags.first else { session.alertMessage = "Move other cards away and try again."; session.restartPolling(); return }
        session.connect(to: tag) { [weak self] error in
            guard let self, self.current(session) else { return }
            if error != nil { session.alertMessage = "Keep the card still and try again."; session.restartPolling(); return }
            let ndef: NFCNDEFTag
            switch tag {
            case .miFare(let value): ndef = value
            case .iso7816(let value): ndef = value
            case .iso15693(let value): ndef = value
            case .feliCa(let value): ndef = value
            @unknown default: self.reject("Use an NDEF-compatible instructor card.", session); return
            }
            ndef.queryNDEFStatus { status, capacity, error in
                guard self.current(session) else { return }
                guard error == nil, status != .notSupported else { self.reject("Use an NDEF-compatible NFC tag.", session); return }
                if let token = self.writing {
                    guard status == .readWrite else { self.reject("This tag is read-only. Use a blank, writable tag.", session); return }
                    guard let message = try? AcademyInstructorCardPayload.message(token), message.length <= capacity else { self.reject("This NFC tag does not have enough space.", session); return }
                    ndef.readNDEF { existing, readError in
                        guard self.current(session) else { return }
                        // Empty NDEF records are allowed; existing data is never overwritten.
                        let emptyTag = (readError as? NFCReaderError)?.code == .ndefReaderSessionErrorZeroLengthMessage
                        guard emptyTag || (readError == nil && existing != nil) else { self.reject("The tag could not be checked. Use an NDEF-formatted blank tag.", session); return }
                        guard emptyTag || existing?.records.allSatisfy({ $0.typeNameFormat == .empty }) == true else { self.reject("This tag already contains data. Use a blank NFC tag.", session); return }
                        ndef.writeNDEF(message) { error in
                            guard self.current(session) else { return }
                            guard error == nil else { self.reject("Writing failed. Keep the tag still and try setup again.", session); return }
                            self.readBack(ndef, session: session, expected: token)
                        }
                    }
                } else { self.readBack(ndef, session: session, expected: nil) }
            }
        }
    }
    private func readBack(_ tag: NFCNDEFTag, session: NFCTagReaderSession, expected: String?) {
        tag.readNDEF { message, error in
            guard self.current(session) else { return }
            do {
                if let error { throw error }
                guard let message else { throw AcademyInstructorCardPayload.CardError("The instructor card is empty.") }
                let token = try AcademyInstructorCardPayload.token(message)
                if let expected, expected != token { throw AcademyInstructorCardPayload.CardError("The written card could not be verified. Try setup again.") }
                session.alertMessage = expected == nil ? "Instructor card read." : "Instructor card written and verified."
                self.finish(.success(token)); session.invalidate()
            } catch { self.reject(error.localizedDescription, session) }
        }
    }
    private func reject(_ message: String, _ session: NFCTagReaderSession) { finish(.failure(AcademyInstructorCardPayload.CardError(message))); session.invalidate(errorMessage: message) }
    private func finish(_ result: Result<String, Error>) {
        lock.lock(); let continuation = self.continuation; self.continuation = nil; session = nil; writing = nil; lock.unlock()
        continuation?.resume(with: result)
    }
}
