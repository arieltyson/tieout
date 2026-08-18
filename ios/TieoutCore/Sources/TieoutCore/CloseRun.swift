import Foundation

/// The Swift mirror of the harness's `CloseRun` contract.
///
/// The TypeScript Zod schema in `harness/src/domain/close-run.ts` is the
/// source of truth. These types are checked against a real emitted artifact
/// by `CloseRunDecodingTests`, so drift between the two sides fails a build
/// rather than surfacing as an empty screen on a device.
///
/// Every type is `Sendable` because a run crosses actor boundaries: decoded
/// off the main actor, rendered on it.

public enum TieoutSchema {
    /// Bump only alongside the TypeScript `SCHEMA_VERSION`.
    public static let supportedVersion = 2
}

public enum RunState: String, Codable, Sendable, CaseIterable {
    case planning
    case dispatched
    case verifying
    case awaitingApproval
    case applying
    case complete
    case failed
}

public enum AgentRunState: String, Codable, Sendable {
    case pending
    case running
    case complete
    case failed
}

public enum Confidence: String, Codable, Sendable, CaseIterable {
    case high
    case medium
    case low
}

public struct AgentStatus: Codable, Sendable, Identifiable, Hashable {
    public let agent: String
    public let state: AgentRunState
    public let detail: String

    public var id: String { agent }
}

public struct ProposalView: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let txnId: String?
    public let vendorDescriptor: String?
    public let amountCents: Int?
    public let glCode: String?
    public let glName: String?
    public let confidence: Confidence
    public let rationale: String
    /// Name of the verifier that rejected this proposal; `nil` when it passed.
    public let blockedBy: String?

    public var isBlocked: Bool { blockedBy != nil }
}

/// Where a finding came from, which decides how it is presented.
///
/// Arithmetic produced a fact. The model produced a judgement a human is
/// being asked to confirm. Drawing them identically would invite a reviewer
/// to trust both equally, and only one of them has earned it.
public enum FindingSource: String, Codable, Sendable, CaseIterable {
    case deterministic
    case model
}

public struct FindingView: Codable, Sendable, Identifiable, Hashable {
    public let kind: String
    /// Empty for bank-only rows, which name a bank row and no ledger row.
    public let txnIds: [String]
    public let summary: String
    public let materialityCents: Int?
    public let source: FindingSource

    /// Stable across the array without an identifier in the payload, since
    /// a finding is defined by what it names rather than by a row id.
    public var id: String { "\(kind):\(txnIds.joined(separator: ","))" }

    public var needsJudgement: Bool { source == .model }
}

public struct VerifierResultView: Codable, Sendable, Identifiable, Hashable {
    public let verifier: String
    public let passed: Bool
    public let isDeterministic: Bool
    public let detail: String?
    public let offendingCount: Int

    public var id: String { verifier }
}

public struct RunSummary: Codable, Sendable, Hashable {
    public let transactions: Int
    public let categorized: Int
    public let needsReview: Int
    public let blocked: Int
    public let hasBlockingFailure: Bool
    public let escapeHatchCount: Int
    /// `nil` unless the run was scored against a ground-truth manifest.
    public let accuracy: Double?
}

public struct RunCost: Codable, Sendable, Hashable {
    public let turns: Int
    public let batches: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cachedReadTokens: Int
    public let costUsd: Double?
    public let wallClockMs: Int
}

public struct CloseRun: Codable, Sendable, Identifiable, Hashable {
    public let schemaVersion: Int
    public let runId: String
    public let period: String
    public let state: RunState
    public let startedAt: String
    public let finishedAt: String
    public let model: String
    public let dryRun: Bool
    public let summary: RunSummary
    public let cost: RunCost
    public let agents: [AgentStatus]
    public let verifiers: [VerifierResultView]
    public let proposals: [ProposalView]
    public let findings: [FindingView]

    public var id: String { runId }
}

// MARK: - Decoding

public enum CloseRunDecodingError: Error, CustomStringConvertible, Sendable {
    case unsupportedSchemaVersion(found: Int, supported: Int)

    public var description: String {
        switch self {
        case let .unsupportedSchemaVersion(found, supported):
            return """
                CloseRun schemaVersion \(found) is not supported (this build understands \
                \(supported)). Regenerate the artifact with a matching harness.
                """
        }
    }
}

extension CloseRun {
    /// Decodes an artifact, rejecting a schema version this build does not
    /// understand. Failing loudly beats rendering a screen with silently
    /// missing fields.
    /// The version is read on its own first, before the full decode.
    ///
    /// It used to be checked afterwards, which meant an artifact from an
    /// older harness failed on whichever field happened to be added rather
    /// than on the version. Bumping to 2 produced "Key 'findings' not found"
    /// instead of "schemaVersion 1 is not supported", so the guard promised
    /// a loud failure and delivered a puzzle. Checking first is the only
    /// ordering that keeps the promise.
    private struct VersionProbe: Decodable {
        let schemaVersion: Int
    }

    public static func decode(from data: Data) throws -> CloseRun {
        let probe = try JSONDecoder().decode(VersionProbe.self, from: data)
        guard probe.schemaVersion == TieoutSchema.supportedVersion else {
            throw CloseRunDecodingError.unsupportedSchemaVersion(
                found: probe.schemaVersion,
                supported: TieoutSchema.supportedVersion
            )
        }
        return try JSONDecoder().decode(CloseRun.self, from: data)
    }
}

// MARK: - Display helpers

extension Int {
    /// Integer cents to a display string. Mirrors `toDisplay` in the harness:
    /// money is never a float on either side of the wire.
    public var centsFormatted: String {
        let negative = self < 0
        let absolute = abs(self)
        let whole = absolute / 100
        let fraction = absolute % 100
        let grouped = whole.grouped
        return "\(negative ? "-" : "")$\(grouped).\(String(format: "%02d", fraction))"
    }

    fileprivate var grouped: String {
        let digits = String(self)
        guard digits.count > 3 else { return digits }
        var out: [Character] = []
        for (offset, character) in digits.reversed().enumerated() {
            if offset > 0, offset % 3 == 0 { out.append(",") }
            out.append(character)
        }
        return String(out.reversed())
    }
}

extension CloseRun {
    /// Accuracy, or a dash when there is no measurement behind it.
    ///
    /// A dry run builds its proposals from the answer key, so it scores a
    /// perfect 1.0 by construction. Printing that as "100.0%" puts the most
    /// flattering number in the app in the largest text on the screen, with
    /// a footnote underneath doing all the work of saying it means nothing.
    /// Footnotes lose that argument. The number is withheld instead.
    public var accuracyFormatted: String {
        if dryRun { return "—" }
        guard let accuracy = summary.accuracy else { return "—" }
        return String(format: "%.1f%%", accuracy * 100)
    }

    /// Cost to the cent.
    ///
    /// Four decimal places was a development habit that survived onto the
    /// screen: "$1.2889" reads as a machine talking to itself. Nobody
    /// approving a close cares about hundredths of a cent.
    public var costFormatted: String {
        guard let usd = cost.costUsd, usd > 0 else { return dryRun ? "$0.00 (dry)" : "—" }
        return String(format: "$%.2f", usd)
    }

    public var wallClockFormatted: String {
        String(format: "%.1fs", Double(cost.wallClockMs) / 1000)
    }

    public var blockedProposals: [ProposalView] { proposals.filter(\.isBlocked) }
    public var needsReviewProposals: [ProposalView] {
        proposals.filter { !$0.isBlocked && $0.confidence != .high }
    }

    /// The findings a human is actually being asked to rule on.
    ///
    /// Deterministic findings are excluded on purpose. An FX conversion that
    /// is off by four cents is not a question, and putting it in an approval
    /// queue trains the reviewer to approve without reading.
    public var findingsNeedingJudgement: [FindingView] {
        findings.filter(\.needsJudgement)
    }
}
