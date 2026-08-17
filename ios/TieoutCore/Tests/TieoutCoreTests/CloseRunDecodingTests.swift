import Foundation
import Testing
@testable import TieoutCore

/// The contract test between the harness and the client.
///
/// The fixture is a byte-for-byte copy of what `npm run close` actually
/// emits, not a hand-written sample. If the TypeScript shape changes and
/// the Swift types are not updated, this fails — which is the whole point.
/// A hand-written fixture would only prove the Swift types agree with
/// themselves.
struct CloseRunDecodingTests {

    static func fixtureData() throws -> Data {
        let url = try #require(
            Bundle.module.url(forResource: "close-run", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "close-run", withExtension: "json"),
            "close-run.json missing from the test bundle"
        )
        return try Data(contentsOf: url)
    }

    @Test func decodesTheArtifactTheHarnessActuallyEmits() throws {
        let run = try CloseRun.decode(from: Self.fixtureData())
        #expect(run.schemaVersion == TieoutSchema.supportedVersion)
        #expect(run.period == "2026-06")
        #expect(run.runId.isEmpty == false)
    }

    @Test func decodesEveryProposalWithoutDroppingFields() throws {
        let run = try CloseRun.decode(from: Self.fixtureData())
        #expect(run.proposals.count == run.summary.categorized)
        #expect(run.proposals.isEmpty == false)

        let first = try #require(run.proposals.first)
        #expect(first.kind == "categorize")
        #expect(first.txnId != nil)
        #expect(first.glCode != nil)
        #expect(first.glName != nil)
        #expect(first.amountCents != nil)
    }

    @Test func decodesAgentsAndVerifiers() throws {
        let run = try CloseRun.decode(from: Self.fixtureData())
        #expect(run.agents.contains { $0.agent == "categorizer" })
        #expect(run.verifiers.contains { $0.verifier == "sums_tie" })
        let allDeterministic = run.verifiers.allSatisfy { $0.isDeterministic }
        #expect(allDeterministic)
    }

    @Test func summaryArithmeticIsInternallyConsistent() throws {
        let run = try CloseRun.decode(from: Self.fixtureData())
        #expect(run.summary.blocked == run.blockedProposals.count)
        #expect(run.summary.needsReview == run.needsReviewProposals.count)
        #expect(run.summary.escapeHatchCount == run.proposals.filter { $0.glCode == "6900" }.count)
    }

    @Test func rejectsAnUnsupportedSchemaVersion() throws {
        // Bumping the harness without bumping the client must fail loudly
        // rather than decode a partial run.
        let json = """
            {"schemaVersion":999,"runId":"r","period":"2026-06","state":"complete",
             "startedAt":"","finishedAt":"","model":"m","dryRun":true,
             "summary":{"transactions":0,"categorized":0,"needsReview":0,"blocked":0,
                        "hasBlockingFailure":false,"escapeHatchCount":0,"accuracy":null},
             "cost":{"turns":0,"batches":0,"inputTokens":0,"outputTokens":0,
                     "cachedReadTokens":0,"costUsd":null,"wallClockMs":0},
             "agents":[],"verifiers":[],"proposals":[]}
            """
        #expect(throws: CloseRunDecodingError.self) {
            _ = try CloseRun.decode(from: Data(json.utf8))
        }
    }

    @Test func decodesANullAccuracy() throws {
        // A real (unscored) run has no accuracy. Optional must survive.
        let json = """
            {"schemaVersion":1,"runId":"r","period":"2026-06","state":"complete",
             "startedAt":"","finishedAt":"","model":"m","dryRun":false,
             "summary":{"transactions":0,"categorized":0,"needsReview":0,"blocked":0,
                        "hasBlockingFailure":false,"escapeHatchCount":0,"accuracy":null},
             "cost":{"turns":0,"batches":0,"inputTokens":0,"outputTokens":0,
                     "cachedReadTokens":0,"costUsd":null,"wallClockMs":0},
             "agents":[],"verifiers":[],"proposals":[]}
            """
        let run = try CloseRun.decode(from: Data(json.utf8))
        #expect(run.summary.accuracy == nil)
        #expect(run.accuracyFormatted == "—")
    }
}

struct MoneyFormattingTests {
    @Test(arguments: [
        (1234, "$12.34"),
        (0, "$0.00"),
        (5, "$0.05"),
        (-1234, "-$12.34"),
        (100_000, "$1,000.00"),
        (169_037, "$1,690.37"),
        (1_234_567_89, "$1,234,567.89"),
    ])
    func formatsIntegerCents(_ input: Int, _ expected: String) {
        #expect(input.centsFormatted == expected)
    }

    @Test func matchesTheHarnessFormatterOnFixtureAmounts() throws {
        // Money is integer cents on both sides of the wire. If the client
        // ever parses these as Double, this is where it shows up.
        let run = try CloseRun.decode(from: CloseRunDecodingTests.fixtureData())
        for proposal in run.proposals.prefix(50) {
            let cents = try #require(proposal.amountCents)
            #expect(cents == Int(cents), "amount must be an exact integer")
            #expect(proposal.amountCents?.centsFormatted.contains(".") == true)
        }
    }
}

struct ActivityCopyTests {
    @Test func compactFitsTheDynamicIsland() {
        #expect(ActivityCopy.compact(agentsComplete: 3, agentsTotal: 5) == "3/5")
        // Measured, not guessed. On an iPhone 17 Pro even "4/4" lost its
        // leading digit at .caption2 — the sensor housing squeezes the
        // compact regions harder than the nominal widths imply. The widget
        // now renders at 12pt with minimumScaleFactor, and this bound keeps
        // the STRING short enough that scaling stays legible. Character
        // count is a proxy for rendered width, so the widget carries the
        // real defence and this is the cheap guard.
        #expect(ActivityCopy.compact(agentsComplete: 10, agentsTotal: 10).count <= 5)
    }

    @Test func headlineSingularizesTheApprovalCount() {
        #expect(ActivityCopy.headline(state: .awaitingApproval, pendingApprovals: 1) == "1 needs you")
        #expect(ActivityCopy.headline(state: .awaitingApproval, pendingApprovals: 4) == "4 need you")
    }

    @Test(arguments: RunState.allCases)
    func headlineStaysShortForEveryState(_ state: RunState) {
        let text = ActivityCopy.headline(state: state, pendingApprovals: 3)
        #expect(text.isEmpty == false)
        #expect(text.count <= 30)
    }

    @Test func summaryHandlesTheEmptyCase() {
        #expect(ActivityCopy.summary(findings: 0, pendingApprovals: 0) == "No findings yet")
        #expect(ActivityCopy.summary(findings: 1, pendingApprovals: 0) == "1 finding")
        #expect(ActivityCopy.summary(findings: 3, pendingApprovals: 2) == "3 findings · 2 to approve")
    }
}
