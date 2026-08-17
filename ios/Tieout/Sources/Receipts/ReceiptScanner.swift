import Foundation
import TieoutCore
import Vision

/// Reads a receipt photo on the device.
///
/// The image never leaves the phone. That is the entire point of doing this
/// with Vision rather than posting the picture to a model: a receipt is a
/// record of where somebody was and what they bought, and it does not need
/// to go anywhere for a total to be extracted from it.
///
/// This type is intentionally thin. It runs the recognizer and hands the
/// lines to `ReceiptParser`, which is pure and carries all the logic worth
/// testing. Everything interesting about interpreting a receipt is
/// exercised without a camera, a device, or an image.
public struct ReceiptScanner: Sendable {

    public enum ScanError: Error, CustomStringConvertible {
        case unreadable
        case noTextFound

        public var description: String {
            switch self {
            case .unreadable: "The image could not be read."
            case .noTextFound: "No text was recognised in the image."
            }
        }
    }

    public init() {}

    /// Recognised text lines, top to bottom, as printed.
    public func recognizeLines(in image: CGImage) async throws -> [String] {
        let request = VNRecognizeTextRequest()
        // Accurate rather than fast: a receipt is small, read once, and a
        // misread total is worse than a slow one.
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        guard let observations = request.results, !observations.isEmpty else {
            throw ScanError.noTextFound
        }

        // Vision returns observations in no guaranteed reading order, and
        // the parser cares about order: it scans upward for the total and
        // takes the merchant from the top. Sort by vertical position.
        return observations
            .sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
            .compactMap { $0.topCandidates(1).first?.string }
    }

    public func scan(image: CGImage, now: Date = Date()) async throws -> ReceiptFields {
        let lines = try await recognizeLines(in: image)
        return ReceiptParser.parse(lines: lines, now: now)
    }
}

/// Cheap on device triage: is this photo even a receipt?
///
/// Worth doing before anything else runs. A camera roll is mostly not
/// receipts, and the expensive paths should never see a photo of a dog.
/// The signals are deliberately crude and local: receipts are text dense,
/// tall, and contain currency amounts.
public struct ReceiptTriage: Sendable {
    public init() {}

    public struct Verdict: Sendable {
        public let looksLikeReceipt: Bool
        public let reason: String
    }

    public func triage(lines: [String]) -> Verdict {
        guard lines.count >= 3 else {
            return Verdict(looksLikeReceipt: false, reason: "Too little text to be a receipt.")
        }
        let hasCurrency = lines.contains { ReceiptParser.currency(in: $0) != nil }
        guard hasCurrency else {
            return Verdict(looksLikeReceipt: false, reason: "No currency amounts found.")
        }
        let lowered = lines.map { $0.lowercased() }
        let hasTotal = lowered.contains { $0.contains("total") || $0.contains("amount due") }
        return Verdict(
            looksLikeReceipt: true,
            reason: hasTotal ? "Text, amounts, and a total line." : "Text and currency amounts."
        )
    }
}
