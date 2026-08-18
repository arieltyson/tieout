import SwiftUI
import TieoutCore

struct RunView: View {
    @State var store: RunStore
    @State private var liveActivity = LiveActivityController()
    @State private var showingApprovals = false

    var body: some View {
        NavigationStack {
            Group {
                switch store.state {
                case .loading:
                    ProgressView("Loading run…")
                case let .failed(message):
                    ContentUnavailableView(
                        "Could not load run",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                case let .loaded(run):
                    RunDetail(run: run, liveActivity: liveActivity)
                }
            }
            .navigationTitle("Tieout")
            .navigationDestination(isPresented: $showingApprovals) {
                if case let .loaded(run) = store.state {
                    ApprovalListView(run: run)
                }
            }
        }
        .task {
            store.load()
            // Lets a screen recording or a screenshot script drive the Live
            // Activity without a tap:
            //   simctl launch --console <dev> <bundle> -TieoutAutostartActivity YES
            if UserDefaults.standard.bool(forKey: "TieoutAutostartActivity"),
               case let .loaded(run) = store.state {
                liveActivity.start(from: run)
            }
            // Same idea for the approval surface, so a screenshot script or
            // a screen recording can reach it without a tap.
            if UserDefaults.standard.bool(forKey: "TieoutShowApprovals") {
                showingApprovals = true
            }
        }
    }
}

private struct RunDetail: View {
    let run: CloseRun
    let liveActivity: LiveActivityController

    var body: some View {
        List {
            Section {
                HeadlineCard(run: run)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                Button {
                    liveActivity.isRunning ? liveActivity.stop() : liveActivity.start(from: run)
                } label: {
                    Label(
                        liveActivity.isRunning ? "End Live Activity" : "Start Live Activity",
                        systemImage: liveActivity.isRunning ? "stop.circle" : "play.circle"
                    )
                }
                if let error = liveActivity.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            } footer: {
                Text("Replays the run on the Lock Screen and Dynamic Island, the same updates the harness pushes as each sub-agent finishes.")
            }

            Section {
                NavigationLink {
                    ApprovalListView(run: run)
                } label: {
                    Label("Review approvals", systemImage: "checkmark.seal")
                }
            } footer: {
                Text("The same cards the Messages extension renders in-thread.")
            }

            Section("Verifier bank") {
                ForEach(run.verifiers) { verifier in
                    VerifierRow(verifier: verifier)
                }
            }

            Section("Sub-agents") {
                ForEach(run.agents) { agent in
                    AgentRow(agent: agent)
                }
            }

            Section {
                ForEach(run.proposals.prefix(100)) { proposal in
                    ProposalRow(proposal: proposal)
                }
            } header: {
                Text("Proposals")
            } footer: {
                if run.proposals.count > 100 {
                    Text("Showing 100 of \(run.proposals.count).")
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

private struct HeadlineCard: View {
    let run: CloseRun

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(run.period)
                    .font(.largeTitle.weight(.semibold))
                Spacer()
                StatePill(state: run.state)
            }

            HStack(spacing: 0) {
                Metric(label: "Categorized", value: "\(run.summary.categorized)")
                Divider()
                Metric(label: "Accuracy", value: run.accuracyFormatted)
                Divider()
                Metric(label: "Blocked", value: "\(run.summary.blocked)")
                Divider()
                Metric(label: "Cost", value: run.costFormatted)
            }
            .frame(maxWidth: .infinity)

            if run.dryRun {
                Label(
                    "Dry run — scripted model, no tokens spent. Not a measurement.",
                    systemImage: "info.circle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }

            Text("\(run.summary.transactions) transactions · \(run.cost.turns) turns · \(run.wallClockFormatted)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
        .padding(.vertical, 4)
    }
}

private struct Metric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.headline)
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct StatePill: View {
    let state: RunState

    var body: some View {
        Text(label)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }

    private var label: String {
        switch state {
        case .awaitingApproval: "Needs you"
        case .complete: "Complete"
        case .failed: "Failed"
        case .verifying: "Verifying"
        case .applying: "Applying"
        case .dispatched: "Running"
        case .planning: "Planning"
        }
    }

    private var tint: Color {
        switch state {
        case .failed: .red
        case .awaitingApproval, .verifying: .orange
        case .complete: .green
        default: .blue
        }
    }
}

private struct VerifierRow: View {
    let verifier: VerifierResultView

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: verifier.passed ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(verifier.passed ? .green : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text(verifier.verifier)
                    .font(.subheadline.monospaced())
                if let detail = verifier.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            Spacer()
            if verifier.offendingCount > 0 {
                Text("\(verifier.offendingCount)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct AgentRow: View {
    let agent: AgentStatus

    var body: some View {
        HStack {
            Image(systemName: symbol)
                .foregroundStyle(agent.state == .complete ? .green : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.agent)
                    .font(.subheadline)
                Text(agent.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var symbol: String {
        switch agent.state {
        case .complete: "checkmark.circle.fill"
        case .running: "circle.dotted"
        case .failed: "xmark.circle.fill"
        case .pending: "circle"
        }
    }
}

private struct ProposalRow: View {
    let proposal: ProposalView

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(proposal.vendorDescriptor ?? proposal.kind)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer()
                if let cents = proposal.amountCents {
                    Text(cents.centsFormatted)
                        .font(.subheadline.monospacedDigit())
                }
            }
            HStack(spacing: 6) {
                if let code = proposal.glCode, let name = proposal.glName {
                    Text("\(code) \(name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if proposal.confidence != .high {
                    Text(proposal.confidence.rawValue)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange.opacity(0.15), in: Capsule())
                        .foregroundStyle(.orange)
                }
                if let blockedBy = proposal.blockedBy {
                    Text(blockedBy)
                        .font(.caption2.monospaced())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.red.opacity(0.15), in: Capsule())
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
