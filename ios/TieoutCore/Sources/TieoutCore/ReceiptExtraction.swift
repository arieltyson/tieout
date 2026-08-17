import Foundation

/// Parsing a receipt into the three fields that matter for matching.
///
/// The text extraction itself is Vision's job and happens on the device.
/// This file is the part worth testing: turning a messy block of recognised
/// text into a merchant, a total, and a date, and knowing when it has
/// failed rather than guessing.
///
/// Kept free of any Vision import on purpose. Parsing is pure, so it runs in
/// tests on any machine, and the framework boundary stays at the edge where
/// it belongs.
public struct ReceiptFields: Sendable, Equatable {
    public let merchant: String?
    /// Integer cents, never a floating point amount. Same rule as the ledger.
    public let totalCents: Int?
    public let date: Date?
    /// Lines the parser could not interpret. Useful when a match goes wrong.
    public let unparsedLines: [String]

    public init(merchant: String?, totalCents: Int?, date: Date?, unparsedLines: [String] = []) {
        self.merchant = merchant
        self.totalCents = totalCents
        self.date = date
        self.unparsedLines = unparsedLines
    }

    /// A receipt is only useful for matching if it has a total. A merchant
    /// name without an amount cannot be tied to a transaction.
    public var isMatchable: Bool { totalCents != nil }
}

public enum ReceiptParser {

    /// Words that introduce the figure we want, in rough priority order.
    /// "Total" appears on almost every receipt; "amount due" and "balance"
    /// cover the rest. Subtotal is deliberately excluded: matching against
    /// it produces a figure that is always slightly wrong.
    private static let totalKeywords = ["grand total", "amount due", "balance due", "total"]
    private static let excludedKeywords = ["subtotal", "sub total", "tax", "tip", "change", "cash"]

    public static func parse(lines: [String], now: Date = Date()) -> ReceiptFields {
        let cleaned = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let total = extractTotal(from: cleaned)
        let date = extractDate(from: cleaned, now: now)
        let merchant = extractMerchant(from: cleaned)

        let interpreted = Set(
            [total?.line, date?.line, merchant].compactMap { $0 }
        )
        return ReceiptFields(
            merchant: merchant,
            totalCents: total?.cents,
            date: date?.date,
            unparsedLines: cleaned.filter { !interpreted.contains($0) }
        )
    }

    // MARK: - Total

    /// Finds the total.
    ///
    /// Scans from the bottom, because the figure a receipt ends on is the
    /// one that was actually charged. A receipt that lists a subtotal, tax,
    /// and total in that order would otherwise yield the subtotal.
    static func extractTotal(from lines: [String]) -> (cents: Int, line: String)? {
        for keyword in totalKeywords {
            for line in lines.reversed() {
                let lowered = line.lowercased()
                guard lowered.contains(keyword) else { continue }
                guard !excludedKeywords.contains(where: { lowered.contains($0) && !lowered.contains("grand") })
                else { continue }
                if let cents = currency(in: line) { return (cents, line) }
            }
        }
        // No keyword anywhere. Fall back to the largest amount on the
        // receipt, which is usually the total, and flag nothing: the caller
        // sees a total and cannot tell it was a guess. That is why this is
        // last rather than first.
        let amounts = lines.compactMap { line -> (Int, String)? in
            guard let c = currency(in: line) else { return nil }
            return (c, line)
        }
        return amounts.max(by: { $0.0 < $1.0 }).map { (cents: $0.0, line: $0.1) }
    }

    /// Pulls a currency amount out of a line, as integer cents.
    ///
    /// Parses the digits directly rather than going through Double. The
    /// harness makes floating point money structurally impossible and the
    /// client should not reintroduce it at the one point where a human is
    /// about to compare two figures.
    public static func currency(in line: String) -> Int? {
        let pattern = #"(?<!\d)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?!\d)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(line.startIndex..., in: line)
        let matches = regex.matches(in: line, range: range)
        guard let match = matches.last,
              let whole = Range(match.range(at: 1), in: line),
              let frac = Range(match.range(at: 2), in: line)
        else { return nil }

        let wholeDigits = line[whole].replacingOccurrences(of: ",", with: "")
        guard let dollars = Int(wholeDigits), let cents = Int(line[frac]) else { return nil }
        return dollars * 100 + cents
    }

    // MARK: - Date

    private static let dateFormats = [
        "MM/dd/yyyy", "M/d/yyyy", "MM/dd/yy", "M/d/yy",
        "yyyy-MM-dd", "dd MMM yyyy", "MMM dd, yyyy", "MMM d, yyyy",
    ]

    static func extractDate(from lines: [String], now: Date) -> (date: Date, line: String)? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")

        for line in lines {
            for token in line.split(whereSeparator: { $0 == " " || $0 == "\t" }) {
                for format in dateFormats {
                    formatter.dateFormat = format
                    if let parsed = formatter.date(from: String(token)) {
                        // A receipt dated in the future is a misparse, not a
                        // receipt. Two digit years are the usual culprit.
                        if parsed <= now.addingTimeInterval(60 * 60 * 24) { return (parsed, line) }
                    }
                }
            }
            for format in dateFormats where format.contains(" ") {
                formatter.dateFormat = format
                if let parsed = formatter.date(from: line), parsed <= now.addingTimeInterval(60 * 60 * 24) {
                    return (parsed, line)
                }
            }
        }
        return nil
    }

    // MARK: - Merchant

    /// The merchant is almost always the first substantial line, before any
    /// address or phone number. Lines that are mostly digits are skipped.
    static func extractMerchant(from lines: [String]) -> String? {
        for line in lines.prefix(5) {
            let letters = line.filter { $0.isLetter }.count
            let digits = line.filter { $0.isNumber }.count
            guard letters >= 3, letters > digits else { continue }
            let lowered = line.lowercased()
            guard !totalKeywords.contains(where: { lowered.contains($0) }),
                  !lowered.contains("receipt"), !lowered.contains("invoice")
            else { continue }
            return line
        }
        return nil
    }
}

// MARK: - Matching

public struct ReceiptMatch: Sendable, Equatable {
    public let txnId: String
    public let confidence: Double
    public let reason: String
}

public enum ReceiptMatcher {
    /// Candidate transactions for a parsed receipt, best first.
    ///
    /// Amount is the strong signal and date is the tiebreaker. Merchant text
    /// is deliberately NOT used for scoring: card descriptors and receipt
    /// headers rarely resemble each other, and a fuzzy name match here would
    /// produce confident wrong answers of exactly the kind the ledger side
    /// already refuses to make.
    public static func candidates(
        for receipt: ReceiptFields,
        in proposals: [ProposalView],
        transactionDate: (String) -> Date? = { _ in nil },
        maxResults: Int = 5
    ) -> [ReceiptMatch] {
        guard let total = receipt.totalCents else { return [] }

        return proposals.compactMap { proposal -> ReceiptMatch? in
            guard let amount = proposal.amountCents, amount == total else { return nil }
            let id = proposal.txnId ?? proposal.id

            // A date on both sides either corroborates the match or rules it
            // out. Absent one, the amount alone is suggestive rather than
            // conclusive, and the confidence says so.
            guard let receiptDate = receipt.date, let txnDate = transactionDate(id) else {
                return ReceiptMatch(
                    txnId: id, confidence: 0.6,
                    reason: "Amount matches exactly. No date to corroborate.")
            }
            let daysApart = abs(receiptDate.timeIntervalSince(txnDate)) / 86_400
            guard daysApart <= 3 else { return nil }
            return ReceiptMatch(
                txnId: id,
                confidence: daysApart < 1 ? 0.95 : 0.85,
                reason: daysApart < 1
                    ? "Amount and date both match."
                    : "Amount matches, dates \(Int(daysApart)) day(s) apart.")
        }
        .sorted { $0.confidence > $1.confidence }
        .prefix(maxResults)
        .map { $0 }
    }
}
