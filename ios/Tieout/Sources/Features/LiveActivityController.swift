// ActivityKit is not yet fully Sendable-audited for Swift 6: Activity is a
// non-Sendable class whose update/end are nonisolated async, so calling them
// from this @MainActor type reads as a cross-isolation send. @preconcurrency
// is the sanctioned escape for an SDK that has not been annotated yet, and it
// is scoped to this one import rather than disabling checking anywhere else.
@preconcurrency import ActivityKit
import Foundation
import TieoutCore

/// Starts, updates, and ends the close-run Live Activity.
///
/// Today it replays a run locally so the surface can be demonstrated and
/// screenshotted without the transport. In Phase 6 the harness pushes these
/// same `ContentState` values via a push token as each sub-agent completes —
/// the widget does not change, only who calls `update`.
@MainActor
@Observable
final class LiveActivityController {
    private(set) var isRunning = false
    private(set) var lastError: String?

    private var activity: Activity<TieoutActivityAttributes>?
    private var task: Task<Void, Never>?

    var areActivitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func start(from run: CloseRun) {
        guard !isRunning else { return }
        guard areActivitiesEnabled else {
            lastError = "Live Activities are disabled in Settings."
            return
        }

        let attributes = TieoutActivityAttributes(period: run.period, runId: run.runId)
        let initial = TieoutActivityAttributes.ContentState(
            agentsComplete: 0,
            agentsTotal: run.agents.count,
            findings: 0,
            pendingApprovals: 0,
            state: .planning,
            detail: "Planning the close"
        )

        do {
            activity = try Activity.request(
                attributes: attributes,
                content: .init(state: initial, staleDate: nil)
            )
            isRunning = true
            lastError = nil
            task = Task { await self.replay(run) }
        } catch {
            lastError = String(describing: error)
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        isRunning = false
        guard let finishing = activity else { return }
        activity = nil
        // Bound to a local before the Task: reading the mutable property
        // across the suspension point is what Swift 6 flags as a send.
        Task { await finishing.end(nil, dismissalPolicy: .immediate) }
    }

    /// Walks the run's real agent list, one step at a time, so the activity
    /// shows the same progression a live run would.
    private func replay(_ run: CloseRun) async {
        guard let activity else { return }
        let total = run.agents.count
        let steps: [(TieoutActivityAttributes.ContentState, UInt64)] = [
            (.init(agentsComplete: 0, agentsTotal: total, findings: 0, pendingApprovals: 0,
                   state: .dispatched, detail: "Dispatching \(total) agents"), 1_400),
            (.init(agentsComplete: 1, agentsTotal: total, findings: 0, pendingApprovals: 0,
                   state: .dispatched,
                   detail: "categorizing \(run.summary.categorized)/\(run.summary.transactions)"), 1_800),
            (.init(agentsComplete: 2, agentsTotal: total, findings: 3, pendingApprovals: 0,
                   state: .dispatched, detail: "reconciling bank feed"), 1_600),
            (.init(agentsComplete: 3, agentsTotal: total, findings: 6, pendingApprovals: 0,
                   state: .verifying, detail: "running the verifier bank"), 1_600),
            (.init(agentsComplete: total, agentsTotal: total,
                   findings: 7, pendingApprovals: max(run.summary.needsReview, 3),
                   state: .awaitingApproval, detail: "waiting on you"), 0),
        ]

        for (state, delayMs) in steps {
            if Task.isCancelled { return }
            await activity.update(.init(state: state, staleDate: nil))
            if delayMs > 0 {
                try? await Task.sleep(for: .milliseconds(delayMs))
            }
        }
        // Deliberately left running: the run is parked awaiting approval,
        // and the whole point is that it stays on the Lock Screen until a
        // human deals with it.
    }
}
