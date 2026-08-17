import Foundation
import Testing
@testable import TieoutCore

/// Receipt parsing, tested against the shapes real receipts actually take.
/// Vision does the reading on the device; this is the part that turns its
/// output into something matchable, and the part that can be wrong quietly.
struct ReceiptParsingTests {

    static let reference = ISO8601DateFormatter().date(from: "2026-08-17T00:00:00Z")!

    @Test func parsesAnOrdinaryReceipt() {
        let fields = ReceiptParser.parse(lines: [
            "BLUE BOTTLE COFFEE", "1 Ferry Building", "San Francisco CA",
            "08/14/2026", "Latte 5.50", "Croissant 4.25",
            "Subtotal 9.75", "Tax 0.87", "Total 10.62",
        ], now: Self.reference)

        #expect(fields.merchant == "BLUE BOTTLE COFFEE")
        #expect(fields.totalCents == 1062)
        #expect(fields.isMatchable)
    }

    // The mistake that matters most: matching the subtotal produces a figure
    // that is always slightly wrong, and slightly wrong is worse than absent.
    @Test func prefersTheTotalOverTheSubtotal() {
        let fields = ReceiptParser.parse(lines: [
            "STAPLES", "Subtotal 100.00", "Tax 8.50", "Total 108.50",
        ], now: Self.reference)
        #expect(fields.totalCents == 10850)
    }

    @Test func ignoresTaxAndTipLines() {
        let fields = ReceiptParser.parse(lines: [
            "SWEETGREEN", "Total 18.00", "Tip 3.60",
        ], now: Self.reference)
        #expect(fields.totalCents == 1800)
    }

    @Test func handlesGrandTotal() {
        let fields = ReceiptParser.parse(lines: [
            "MARRIOTT", "Room 450.00", "Grand Total 512.75",
        ], now: Self.reference)
        #expect(fields.totalCents == 51275)
    }

    @Test func parsesThousandsSeparators() {
        #expect(ReceiptParser.currency(in: "Total 1,234.56") == 123456)
        #expect(ReceiptParser.currency(in: "TOTAL $2,999.00") == 299900)
    }

    // Money is integer cents on both sides of the wire. If this ever routes
    // through Double, 10.62 starts arriving as 1061.9999999999998.
    @Test(arguments: [
        ("Total 0.05", 5), ("Total 10.62", 1062), ("Total 100.00", 10000),
        ("Total 19.99", 1999), ("Total 0.10", 10), ("Total 12345.67", 1234567),
    ])
    func parsesAmountsExactly(_ line: String, _ expected: Int) {
        #expect(ReceiptParser.currency(in: line) == expected)
    }

    @Test func rejectsThingsThatAreNotAmounts() {
        #expect(ReceiptParser.currency(in: "Order 12345") == nil)
        #expect(ReceiptParser.currency(in: "no digits here") == nil)
        #expect(ReceiptParser.currency(in: "2026-08-17") == nil)
    }

    @Test(arguments: ["08/14/2026", "2026-08-14", "14 Aug 2026", "Aug 14, 2026"])
    func parsesCommonDateFormats(_ token: String) {
        let fields = ReceiptParser.parse(lines: ["VENDOR", token, "Total 10.00"], now: Self.reference)
        #expect(fields.date != nil, "failed to parse \(token)")
    }

    // A two digit year parsed wrongly lands in the future, and a receipt
    // from the future is a misparse rather than a receipt.
    @Test func rejectsFutureDates() {
        let fields = ReceiptParser.parse(
            lines: ["VENDOR", "01/01/2099", "Total 10.00"], now: Self.reference)
        #expect(fields.date == nil)
    }

    @Test func skipsAddressLinesWhenFindingTheMerchant() {
        let fields = ReceiptParser.parse(lines: [
            "1234 5TH AVE", "WEWORK", "Total 45.00",
        ], now: Self.reference)
        #expect(fields.merchant == "WEWORK")
    }

    @Test func reportsWhatItCouldNotRead() {
        let fields = ReceiptParser.parse(lines: [
            "VENDOR", "Total 10.00", "!!! garbled !!!",
        ], now: Self.reference)
        #expect(fields.unparsedLines.contains("!!! garbled !!!"))
    }

    @Test func anEmptyReceiptIsNotMatchable() {
        let fields = ReceiptParser.parse(lines: [], now: Self.reference)
        #expect(fields.isMatchable == false)
        #expect(fields.totalCents == nil)
    }
}

struct ReceiptMatchingTests {
    static func proposal(_ id: String, _ cents: Int) -> ProposalView {
        ProposalView(id: id, kind: "categorize", txnId: id, vendorDescriptor: "V",
                     amountCents: cents, glCode: "6030", glName: "Meals",
                     confidence: .high, rationale: "r", blockedBy: nil)
    }

    @Test func matchesOnExactAmount() {
        let receipt = ReceiptFields(merchant: "X", totalCents: 1062, date: Date())
        let matches = ReceiptMatcher.candidates(
            for: receipt, in: [Self.proposal("txn_0001", 1062), Self.proposal("txn_0002", 999)])
        #expect(matches.count == 1)
        #expect(matches.first?.txnId == "txn_0001")
    }

    // Off by a cent is not a match. The whole system exists because being
    // off by a cent means the books do not close.
    @Test func doesNotMatchOffByOneCent() {
        let receipt = ReceiptFields(merchant: "X", totalCents: 1062, date: Date())
        let matches = ReceiptMatcher.candidates(for: receipt, in: [Self.proposal("txn_0001", 1061)])
        #expect(matches.isEmpty)
    }

    @Test func aReceiptWithNoTotalMatchesNothing() {
        let receipt = ReceiptFields(merchant: "X", totalCents: nil, date: Date())
        #expect(ReceiptMatcher.candidates(for: receipt, in: [Self.proposal("txn_0001", 100)]).isEmpty)
    }

    @Test func confidenceIsHigherWhenBothDatesAgree() {
        let day = ISO8601DateFormatter().date(from: "2026-06-14T00:00:00Z")!
        let dated = ReceiptFields(merchant: "X", totalCents: 500, date: day)
        let undated = ReceiptFields(merchant: "X", totalCents: 500, date: nil)

        let corroborated = ReceiptMatcher.candidates(
            for: dated, in: [Self.proposal("t", 500)], transactionDate: { _ in day }).first
        let amountOnly = ReceiptMatcher.candidates(
            for: undated, in: [Self.proposal("t", 500)]).first

        #expect((corroborated?.confidence ?? 0) > (amountOnly?.confidence ?? 0))
    }

    // A date on both sides can rule a match OUT, not only confirm it. An
    // identical amount three weeks apart is a different purchase.
    @Test func rejectsAMatchWhoseDatesAreFarApart() {
        let receiptDay = ISO8601DateFormatter().date(from: "2026-06-01T00:00:00Z")!
        let txnDay = ISO8601DateFormatter().date(from: "2026-06-25T00:00:00Z")!
        let receipt = ReceiptFields(merchant: "X", totalCents: 500, date: receiptDay)
        let matches = ReceiptMatcher.candidates(
            for: receipt, in: [Self.proposal("t", 500)], transactionDate: { _ in txnDay })
        #expect(matches.isEmpty)
    }
}
