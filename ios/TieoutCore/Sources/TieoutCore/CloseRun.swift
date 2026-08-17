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
    public static let supportedVersion = 1
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
    public static func decode(from data: Data) throws -> CloseRun {
        let run = try JSONDecoder().decode(CloseRun.self, from: data)
        guard run.schemaVersion == TieoutSchema.supportedVersion else {
            throw CloseRunDecodingError.unsupportedSchemaVersion(
                found: run.schemaVersion,
                supported: TieoutSchema.supportedVersion
            )
        }
        return run
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
    public var accuracyFormatted: String {
        guard let accuracy = summary.accuracy else { return "—" }
        return String(format: "%.1f%%", accuracy * 100)
    }

    public var costFormatted: String {
        guard let usd = cost.costUsd, usd > 0 else { return dryRun ? "$0.00 (dry)" : "—" }
        return String(format: "$%.4f", usd)
    }

    public var wallClockFormatted: String {
        String(format: "%.1fs", Double(cost.wallClockMs) / 1000)
    }

    public var blockedProposals: [ProposalView] { proposals.filter(\.isBlocked) }
    public var needsReviewProposals: [ProposalView] {
        proposals.filter { !$0.isBlocked && $0.confidence != .high }
    }
}
