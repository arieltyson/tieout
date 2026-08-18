import Foundation

/// The Live Activity's payload, shared by the app (which starts and updates
/// the activity) and the widget extension (which draws it).
///
/// Split the way ActivityKit wants it: `TieoutActivityAttributes` is fixed
/// for the life of the run, `ContentState` is everything that changes.
/// Keeping the dynamic half small matters — every update is pushed through
/// the system, and a fat state is a slow, throttled one.
///
/// Guarded on `os(iOS)` rather than `canImport(ActivityKit)`: the module
/// imports cleanly on macOS but its types are marked unavailable there, so
/// canImport compiles and then fails. This package builds for macOS too, so
/// its tests can run in CI without a simulator.
#if os(iOS)
import ActivityKit

public struct TieoutActivityAttributes: ActivityAttributes, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
        public var agentsComplete: Int
        public var agentsTotal: Int
        public var findings: Int
        public var pendingApprovals: Int
        public var state: RunState
        /// Short line for the Lock Screen, e.g. "categorizing 200/370".
        public var detail: String

        public init(
            agentsComplete: Int,
            agentsTotal: Int,
            findings: Int,
            pendingApprovals: Int,
            state: RunState,
            detail: String
        ) {
            self.agentsComplete = agentsComplete
            self.agentsTotal = agentsTotal
            self.findings = findings
            self.pendingApprovals = pendingApprovals
            self.state = state
            self.detail = detail
        }

        public var progress: Double {
            guard agentsTotal > 0 else { return 0 }
            return Double(agentsComplete) / Double(agentsTotal)
        }

        public var isFinished: Bool {
            state == .complete || state == .failed || state == .awaitingApproval
        }
    }

    public let period: String
    public let runId: String

    public init(period: String, runId: String) {
        self.period = period
        self.runId = runId
    }
}
#endif

/// Presentation strings shared by the widget and the app.
///
/// Deliberately outside the ActivityKit guard so they are unit-testable on
/// any platform. The Dynamic Island has almost no room, so what goes in it
/// is a decision worth testing rather than improvising inside a ViewBuilder.
public enum ActivityCopy {
    /// Dynamic Island compact trailing, e.g. "3/5".
    public static func compact(agentsComplete: Int, agentsTotal: Int) -> String {
        "\(agentsComplete)/\(agentsTotal)"
    }

    /// The headline line, kept under roughly 30 characters.
    public static func headline(state: RunState, pendingApprovals: Int) -> String {
        switch state {
        case .planning: "Planning"
        case .dispatched: "Running"
        case .verifying: "Verifying"
        case .awaitingApproval:
            pendingApprovals == 1 ? "1 needs you" : "\(pendingApprovals) need you"
        case .applying: "Applying"
        case .complete: "Complete"
        case .failed: "Failed"
        }
    }

    /// Lock Screen subtitle combining findings and approvals.
    public static func summary(findings: Int, pendingApprovals: Int) -> String {
        var parts: [String] = []
        if findings > 0 { parts.append("\(findings) finding\(findings == 1 ? "" : "s")") }
        if pendingApprovals > 0 { parts.append("\(pendingApprovals) to approve") }
        return parts.isEmpty ? "No findings yet" : parts.joined(separator: " · ")
    }
}


/// What a system reads aloud about a run.
///
/// Lives here rather than inside an intent's perform method because the
/// wording is a decision rather than an implementation detail, and a
/// sentence a device speaks to somebody should be testable.
public enum SpokenSummary {
    public static func text(for run: CloseRun) -> String {
        switch run.state {
        case .awaitingApproval:
            let n = run.summary.needsReview
            return n == 0
                ? "The \(run.period) close is ready. Nothing needs your attention."
                : "The \(run.period) close is waiting on you. \(n) item\(n == 1 ? "" : "s") to review."
        case .complete:
            return "The \(run.period) close is finished."
        case .failed:
            return "The \(run.period) close failed."
        case .planning, .dispatched, .verifying, .applying:
            return "The \(run.period) close is still running."
        }
    }
}
