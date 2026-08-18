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

    /// The artifact the app actually ships, read from its real location.
    ///
    /// Deliberately not a copy in the test bundle. A copy is a second thing
    /// to keep in sync, and the moment it drifts this test starts proving
    /// something about a file nobody ships. Reading the shipped file means
    /// Swift's decoder is the shape check: every element of every array has
    /// to carry every non-optional field, which a jq key comparison cannot
    /// see because one finding missing a field leaves the key set unchanged.
    static func shippedArtifactData() throws -> Data {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // → ios/
        url.appendPathComponent("Tieout/Resources/close-run.json")
        return try Data(contentsOf: url)
    }

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
            {"schemaVersion":2,"runId":"r","period":"2026-06","state":"complete",
             "startedAt":"","finishedAt":"","model":"m","dryRun":false,
             "summary":{"transactions":0,"categorized":0,"needsReview":0,"blocked":0,
                        "hasBlockingFailure":false,"escapeHatchCount":0,"accuracy":null},
             "cost":{"turns":0,"batches":0,"inputTokens":0,"outputTokens":0,
                     "cachedReadTokens":0,"costUsd":null,"wallClockMs":0},
             "agents":[],"verifiers":[],"proposals":[],"findings":[]}
            """
        let run = try CloseRun.decode(from: Data(json.utf8))
        #expect(run.summary.accuracy == nil)
        #expect(run.accuracyFormatted == "—")
    }

    @Test func namesTheVersionRatherThanTheFieldWhenAnOldArtifactArrives() throws {
        // A v1 artifact is missing `findings`. Before the version was probed
        // first, this surfaced as "Key 'findings' not found", which tells a
        // reader nothing about what actually went wrong.
        let json = """
            {"schemaVersion":1,"runId":"r","period":"2026-06","state":"complete",
             "startedAt":"","finishedAt":"","model":"m","dryRun":false,
             "summary":{"transactions":0,"categorized":0,"needsReview":0,"blocked":0,
                        "hasBlockingFailure":false,"escapeHatchCount":0,"accuracy":null},
             "cost":{"turns":0,"batches":0,"inputTokens":0,"outputTokens":0,
                     "cachedReadTokens":0,"costUsd":null,"wallClockMs":0},
             "agents":[],"verifiers":[],"proposals":[]}
            """
        do {
            _ = try CloseRun.decode(from: Data(json.utf8))
            Issue.record("a v1 artifact must not decode")
        } catch let error as CloseRunDecodingError {
            #expect(String(describing: error).contains("schemaVersion 1"))
        }
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

struct SpokenSummaryTests {
    static func run(state: RunState, needsReview: Int) -> CloseRun {
        CloseRun(
            schemaVersion: TieoutSchema.supportedVersion, runId: "r", period: "2026-06", state: state,
            startedAt: "", finishedAt: "", model: "m", dryRun: true,
            summary: RunSummary(transactions: 370, categorized: 370, needsReview: needsReview,
                                blocked: 0, hasBlockingFailure: false, escapeHatchCount: 0, accuracy: nil),
            cost: RunCost(turns: 0, batches: 0, inputTokens: 0, outputTokens: 0,
                          cachedReadTokens: 0, costUsd: nil, wallClockMs: 0),
            agents: [], verifiers: [], proposals: [], findings: [])
    }

    @Test func singularizesASingleItem() {
        #expect(SpokenSummary.text(for: Self.run(state: .awaitingApproval, needsReview: 1))
            .contains("1 item to review"))
        #expect(SpokenSummary.text(for: Self.run(state: .awaitingApproval, needsReview: 4))
            .contains("4 items to review"))
    }

    @Test func saysNothingNeedsAttentionWhenNothingDoes() {
        let text = SpokenSummary.text(for: Self.run(state: .awaitingApproval, needsReview: 0))
        #expect(text.contains("Nothing needs your attention"))
    }

    // Spoken aloud with no screen in front of you, so every state has to
    // produce a sentence rather than a shrug.
    @Test(arguments: RunState.allCases)
    func everyStateSaysSomethingUseful(_ state: RunState) {
        let text = SpokenSummary.text(for: Self.run(state: state, needsReview: 2))
        #expect(text.isEmpty == false)
        #expect(text.contains("2026-06"))
    }
}

/// Guards on the two numbers the UI is most able to lie with.
struct RunPresentationTests {

    @Test func aDryRunWithholdsItsAccuracy() throws {
        // A dry run derives its proposals from the answer key, so it scores
        // 1.0 by construction. That is not a measurement and must not be
        // drawn as one.
        let run = try CloseRun.decode(from: CloseRunDecodingTests.fixtureData())
        if run.dryRun {
            #expect(run.summary.accuracy == 1.0, "fixture is a dry run scoring perfectly, as expected")
            #expect(run.accuracyFormatted == "—", "a dry run must not print an accuracy figure")
        } else {
            #expect(run.accuracyFormatted != "—")
            #expect(run.accuracyFormatted.hasSuffix("%"))
        }
    }

    @Test func onlyModelFindingsAreOfferedForJudgement() throws {
        // Deliberately the real fixture. The dry one has no model findings
        // at all, so this assertion would hold over an empty array and
        // prove nothing.
        let run = try CloseRun.decode(from: CloseRunDecodingTests.shippedArtifactData())
        #expect(run.dryRun == false)
        #expect(run.findingsNeedingJudgement.isEmpty == false, "the real run must carry judgement calls")
        #expect(run.findingsNeedingJudgement.allSatisfy { $0.source == .model })
        // Arithmetic is a fact, not a question. Anything deterministic that
        // reached the approval queue would be training the reviewer to nod.
        #expect(run.findingsNeedingJudgement.count < run.findings.count)
    }

    @Test func theRealRunReportsAMeasuredAccuracy() throws {
        let run = try CloseRun.decode(from: CloseRunDecodingTests.shippedArtifactData())
        #expect(run.accuracyFormatted.hasSuffix("%"))
        #expect(run.accuracyFormatted != "100.0%", "a real run scoring perfectly would mean the answer key leaked")
    }

    @Test func turnsAndCostDescribeTheSameRun() throws {
        // The app showed 17 turns beside a cost that bought 25, because
        // turns came from the categorizer and cost covered every agent.
        let run = try CloseRun.decode(from: CloseRunDecodingTests.shippedArtifactData())
        let categorizerTurnsOnly = 17
        #expect(run.cost.turns > categorizerTurnsOnly)
    }

    @Test func findingKindsReadAsProseRatherThanFieldNames() {
        #expect("bankAmountMismatch".humanizedKind == "Bank amount mismatch")
        #expect("duplicate".humanizedKind == "Duplicate")
        #expect("vendorAlias".humanizedKind == "Vendor alias")
    }
}
